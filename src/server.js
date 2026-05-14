/**
 * OpenAI-compatible HTTP server with multi-account management.
 *
 *   POST /v1/chat/completions       — chat completions
 *   POST /v1/responses              — OpenAI Responses API
 *   GET  /v1/models                 — list models
 *   POST /auth/login                — add account (email+password / token / api_key)
 *   GET  /auth/accounts             — list all accounts
 *   DELETE /auth/accounts/:id       — remove account
 *   GET  /auth/status               — pool status summary
 *   GET  /health                    — health check
 */

import http from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  validateApiKey, isAuthenticated, getAccountList, getAccountCount,
  addAccountByEmail, addAccountByToken, addAccountByKey, addAccountByRefreshToken, removeAccount,
} from './auth.js';
import { timingSafeEqual } from 'crypto';
import { handleChatCompletions } from './handlers/chat.js';
import { handleModels } from './handlers/models.js';
import { handleMessages } from './handlers/messages.js';
import { handleResponses } from './handlers/responses.js';
import { handleDashboardApi } from './dashboard/api.js';
import { config, log } from './config.js';
import { callerKeyFromRequest } from './caller-key.js';
import { BRAND, VERSION } from './version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function readBody(req) {
  const MAX_BODY = 25 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, ...args) => { if (settled) return; settled = true; fn(...args); };
    req.on('data', c => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) {
        done(reject, new Error(`Request body exceeds ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => done(resolve, Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => done(reject, err));
  });
}

function extractToken(req) {
  // Support both OpenAI-style `Authorization: Bearer <key>` and Anthropic-style
  // `x-api-key: <key>` header. Claude Code sends the latter when ANTHROPIC_BASE_URL
  // is set, so /v1/messages MUST accept it for the drop-in UX to work.
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey && typeof xApiKey === 'string') return xApiKey;
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : h;
}

/**
 * Constant-time string equality for admin credentials.
 * `timingSafeEqual` throws on length mismatch, so we pad first and then
 * compare lengths separately so a wrong length doesn't return faster
 * than a wrong-byte mismatch.
 */
function constantTimeEquals(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(len); aBuf.copy(aPad);
  const bPad = Buffer.alloc(len); bBuf.copy(bPad);
  const equal = timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}

/**
 * Authorise an admin-scope request (pool management, account list).
 *
 * Accepts either:
 *   - `X-Dashboard-Password: <password>`  (explicit dashboard credential)
 *   - `Authorization: Bearer <api-key>`  (the gateway API key)
 *   - `x-api-key: <api-key>`              (Anthropic-style)
 *
 * When neither DASHBOARD_PASSWORD nor API_KEY is configured, the server is
 * running in open-access mode (local dev, no secrets set) and we fall
 * through so first-run UX still works. That is noisy but explicit —
 * `ensureConfigured` in bin/windbu.mjs always generates both on boot, so in
 * practice this open path only fires for hand-edited .env files.
 */
function isAdminAuthorised(req) {
  const pw = req.headers['x-dashboard-password'];
  if (config.dashboardPassword) {
    if (pw && constantTimeEquals(pw, config.dashboardPassword)) return true;
  }
  const bearer = extractToken(req);
  if (config.apiKey) {
    if (bearer && constantTimeEquals(bearer, config.apiKey)) return true;
  }
  // No secrets configured at all — open access for local dev.
  if (!config.dashboardPassword && !config.apiKey) return true;
  return false;
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-dashboard-password, x-dashboard-session, x-session-id',
  });
  res.end(data);
}

async function route(req, res) {
  const { method } = req;
  // Defensive URL parse. `req.url` is typed as a string, but a malformed
  // request could conceivably set it to something unparseable; handle that
  // without crashing the whole server.
  let path;
  try {
    path = (req.url || '/').split('?')[0];
  } catch {
    return json(res, 400, { error: { message: 'Malformed request URL', type: 'invalid_request' } });
  }

  // Per-request abort controller. Fires when the response connection is
  // torn down before we finished writing to it (i.e. the client gave up).
  // Only listen on res.close — req.close can fire as soon as the request
  // body is fully read, even if the response is still in-flight, which
  // would cause spurious aborts in the middle of the handler.
  const abortController = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.on('close', onClientClose);

  if (method === 'OPTIONS') {
    // HTTP spec: 204 No Content must have no body. Send CORS headers only.
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-dashboard-password, x-dashboard-session, x-session-id',
    });
    return res.end();
  }
  if (path === '/health') {
    const counts = getAccountCount();
    return json(res, 200, {
      status: 'ok',
      provider: BRAND,
      version: VERSION,
      uptime: Math.round(process.uptime()),
      accounts: counts,
    });
  }

  // ─── Dashboard ─────────────────────────────────────
  // Silent 204 for favicon — browsers request it from every page; otherwise
  // the later Bearer-token check produces noise in the dashboard console.
  if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (path === '/dashboard' || path === '/dashboard/') {
    try {
      const html = readFileSync(join(__dirname, 'dashboard', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch {
      return json(res, 500, { error: 'Dashboard not found' });
    }
  }

  if (path.startsWith('/dashboard/api/')) {
    let body = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      try { body = JSON.parse(await readBody(req)); } catch {}
    }
    const subpath = path.slice('/dashboard/api'.length);
    return handleDashboardApi(method, subpath, body, req, res);
  }

  // ─── Auth management (admin-scope: requires X-Dashboard-Password or API key) ───

  // /auth/status — public counters (no secrets disclosed)
  if (path === '/auth/status') {
    return json(res, 200, { authenticated: isAuthenticated(), ...getAccountCount() });
  }

  // Everything else under /auth/* is admin-only. Exposing this to any local
  // TCP peer would let them dump the Windsurf token pool or add their own
  // keys to siphon free quota — see audit notes C1/C2.
  const authPathsAdmin = path === '/auth/accounts'
    || path.startsWith('/auth/accounts/')
    || path === '/auth/login';
  if (authPathsAdmin && !isAdminAuthorised(req)) {
    return json(res, 401, {
      error: {
        message: 'Admin auth required: send X-Dashboard-Password header or Authorization: Bearer <API_KEY>.',
        type: 'auth_error',
      },
    });
  }

  if (path === '/auth/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // DELETE /auth/accounts/:id
  if (path.startsWith('/auth/accounts/') && method === 'DELETE') {
    const id = path.split('/')[3];
    const ok = removeAccount(id);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  if (path === '/auth/login' && method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }

    try {
      // Support batch: { accounts: [{email,password}, ...] }
      if (Array.isArray(body.accounts)) {
        const results = [];
        for (const acct of body.accounts) {
          try {
            let result;
            if (acct.api_key) {
              result = addAccountByKey(acct.api_key, acct.label);
            } else if (acct.token) {
              result = await addAccountByToken(acct.token, acct.label);
            } else if (acct.refresh_token) {
              result = await addAccountByRefreshToken(acct.refresh_token, acct.label);
            } else if (acct.email && acct.password) {
              result = await addAccountByEmail(acct.email, acct.password);
            } else {
              results.push({ error: 'Missing credentials' });
              continue;
            }
            results.push({ id: result.id, email: result.email, status: result.status });
          } catch (err) {
            results.push({ email: acct.email, error: err.message });
          }
        }
        return json(res, 200, { results, ...getAccountCount() });
      }

      // Single account
      let account;
      if (body.api_key) {
        account = addAccountByKey(body.api_key, body.label);
      } else if (body.token) {
        account = await addAccountByToken(body.token, body.label);
      } else if (body.refresh_token) {
        account = await addAccountByRefreshToken(body.refresh_token, body.label);
      } else if (body.email && body.password) {
        account = await addAccountByEmail(body.email, body.password);
      } else {
        return json(res, 400, { error: 'Provide api_key, token, refresh_token, or email+password' });
      }

      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      log.error('Login failed:', err.message);
      return json(res, 401, { error: err.message });
    }
  }

  // ─── API endpoints (require API key) ────────────────────

  const callerToken = extractToken(req);
  const callerKey = callerKeyFromRequest(req, callerToken);
  if (!validateApiKey(callerToken)) {
    return json(res, 401, { error: { message: 'Invalid API key', type: 'auth_error' } });
  }

  if (path === '/v1/models' && method === 'GET') {
    return json(res, 200, handleModels());
  }

  if (path === '/v1/chat/completions' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    if (!Array.isArray(body.messages)) {
      return json(res, 400, { error: { message: 'messages must be an array', type: 'invalid_request' } });
    }
    if (body.messages.length === 0) {
      return json(res, 400, { error: { message: 'messages must contain at least 1 item', type: 'invalid_request' } });
    }

    body._source = 'POST /v1/chat/completions';
    const result = await handleChatCompletions(body, { callerKey, signal: abortController.signal });
    if (result.stream) {
      // Streaming tuning: keep the socket hot and unblock the first byte.
      //   setNoDelay — disable Nagle so small SSE deltas aren't coalesced (40ms win)
      //   setKeepAlive + setTimeout(0) — survive long thinking pauses w/o RST
      //   flushHeaders — push HTTP response line + headers to the client NOW,
      //     so SSE clients (esp. CC) exit their "connecting" state immediately
      req.socket?.setKeepAlive(true);
      req.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      res.flushHeaders?.();
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  if (path === '/v1/responses' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, {
        error: { message: 'No active accounts. POST /auth/login to add accounts.', type: 'auth_error' },
      });
    }

    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { error: { message: 'Invalid JSON', type: 'invalid_request' } });
    }
    const result = await handleResponses(body, { context: { callerKey, signal: abortController.signal } });
    if (result.stream) {
      req.socket?.setKeepAlive(true);
      req.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      res.flushHeaders?.();
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  // Anthropic Messages API — /v1/messages. Lets Claude Code and any Anthropic
  // SDK point ANTHROPIC_BASE_URL at us directly, no protocol translator required.
  if (path === '/v1/messages' && method === 'POST') {
    if (!isAuthenticated()) {
      return json(res, 503, { type: 'error', error: { type: 'authentication_error', message: 'No active accounts. POST /auth/login to add accounts.' } });
    }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages must be a non-empty array' } });
    }
    const result = await handleMessages(body, { callerKey, signal: abortController.signal });
    if (result.stream) {
      // Same streaming tuning as /v1/chat/completions — see comment above.
      req.socket?.setKeepAlive(true);
      req.setTimeout(0);
      res.socket?.setNoDelay(true);
      res.writeHead(result.status, { 'Access-Control-Allow-Origin': '*', ...result.headers });
      res.flushHeaders?.();
      await result.handler(res);
    } else {
      json(res, result.status, result.body);
    }
    return;
  }

  json(res, 404, { error: { message: `${method} ${path} not found`, type: 'not_found' } });
}

export function startServer() {
  const activeRequests = new Set();

  const server = http.createServer(async (req, res) => {
    activeRequests.add(res);
    // SSE stream handlers attach additional 'close' listeners (heartbeat
    // cleanup, abort propagation, path-sanitizer teardown). Raise the cap so
    // Node doesn't emit MaxListenersExceededWarning on long chat streams.
    res.setMaxListeners(20);
    res.on('close', () => activeRequests.delete(res));
    try {
      await route(req, res);
    } catch (err) {
      log.error('Handler error:', err);
      if (!res.headersSent) json(res, 500, { error: { message: 'Internal error', type: 'server_error' } });
    }
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let retryCount = 0;
  const maxRetries = 10;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      retryCount++;
      if (retryCount > maxRetries) {
        log.error(`Port ${config.port} still in use after ${maxRetries} retries. Exiting.`);
        process.exit(1);
      }
      log.warn(`Port ${config.port} in use, retry ${retryCount}/${maxRetries} in 3s...`);
      setTimeout(() => server.listen(config.port, config.host), 3000);
    } else {
      log.error('Server error:', err);
    }
  });

  server.getActiveRequests = () => activeRequests.size;

  server.listen({ port: config.port, host: config.host }, () => {
    log.info(`Server on http://${config.host}:${config.port}`);
    log.info(`  Dashboard: http://${config.host}:${config.port}/dashboard`);
    log.info('  POST /v1/chat/completions  (OpenAI format)');
    log.info('  POST /v1/responses         (OpenAI Responses format)');
    log.info('  POST /v1/messages          (Anthropic format — Claude Code native)');
    log.info('  GET  /v1/models');
    log.info('  POST /auth/login           (add account)');
    log.info('  GET  /auth/accounts        (list accounts)');
    log.info('  DELETE /auth/accounts/:id  (remove account)');
  });
  return server;
}
