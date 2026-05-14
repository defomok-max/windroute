/**
 * Dashboard API route handlers.
 * All routes are under /dashboard/api/*.
 */

import { config, log } from '../config.js';
import { timingSafeEqual } from 'crypto';
import {
  getAccountList, getAccountCount, addAccountByKey, addAccountByToken,
  addAccountByRefreshToken, addAccountByEmail,
  removeAccount, setAccountStatus, resetAccountErrors, updateAccountLabel,
  isAuthenticated, probeAccount, ensureLsForAccount,
  refreshCredits, refreshAllCredits,
  setAccountBlockedModels, fetchAndMergeModelCatalog,
  setAccountTokens, getInternalAccountView,
} from '../auth.js';
import { restartLsForProxy } from '../langserver.js';
import { getLsStatus, stopLanguageServer, startLanguageServer, isLanguageServerRunning } from '../langserver.js';
import { getStats, resetStats, recordRequest, getUsageSnapshot, exportUsage, importUsage, pruneDetails, pruneDays } from './stats.js';
import { cacheStats, cacheClear } from '../cache.js';
import { getExperimental, setExperimental, getIdentityPrompts, setIdentityPrompts, resetIdentityPrompt } from '../runtime-config.js';
import { poolStats as convPoolStats, poolClear as convPoolClear } from '../conversation-pool.js';
import { getLogs, subscribeToLogs, unsubscribeFromLogs } from './logger.js';
import { getProxyConfig, setGlobalProxy, setAccountProxy, removeProxy, getEffectiveProxy } from './proxy-config.js';
import { MODELS, MODEL_TIER_ACCESS as _TIER_TABLE, getTierModels as _getTierModels } from '../models.js';
import { windsurfLogin, refreshFirebaseToken, reRegisterWithCodeium } from './windsurf-login.js';
import { getModelAccessConfig, setModelAccessMode, setModelAccessList, addModelToList, removeModelFromList } from './model-access.js';
import { checkMessageRateLimit } from '../windsurf-api.js';

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Dashboard-Password',
  });
  res.end(data);
}

/**
 * Constant-time string comparison for the dashboard secret. Using `===`
 * leaks length and first-diverging-byte position via response timing, which
 * is exploitable by a sibling on the same host (WSL, VM, container). Pad to
 * equal length first since timingSafeEqual throws on length mismatch.
 */
function constantTimeEquals(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  // Length mismatch is still observable in principle, but pad-then-compare
  // at least denies an attacker a direct byte-by-byte oracle.
  const len = Math.max(aBuf.length, bBuf.length, 1);
  const aPad = Buffer.alloc(len); aBuf.copy(aPad);
  const bPad = Buffer.alloc(len); bBuf.copy(bPad);
  const equal = timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}

function checkAuth(req) {
  // Primary channel: X-Dashboard-Password header. SSE clients (EventSource)
  // can't set custom headers, so we also accept ?_pw=... as a fallback for
  // the /dashboard/api/logs/stream endpoint. The query-string value is
  // treated with the same timing-safe compare — no weakening of auth.
  let pw = req.headers['x-dashboard-password'] || '';
  if (!pw && req.url) {
    try {
      const u = new URL(req.url, 'http://localhost');
      pw = u.searchParams.get('_pw') || '';
    } catch {}
  }
  // If dashboard password is set, use it
  if (config.dashboardPassword) return constantTimeEquals(pw, config.dashboardPassword);
  // Otherwise fall back to API key (if set)
  if (config.apiKey) return constantTimeEquals(pw, config.apiKey);
  // No password and no API key = open access
  return true;
}

// ── Brute-force guard for /dashboard/api/auth ────────────────
// Simple in-memory throttle: after 5 failed /auth checks from the same IP
// within a minute we start returning 429 with escalating lockouts. Not
// bulletproof against a distributed attacker on a LAN, but denies the common
// "point a script at http://127.0.0.1:20129 and iterate passwords" case.
const _authAttempts = new Map(); // ip -> { count, firstAt, lockedUntil }
const AUTH_WINDOW_MS = 60_000;
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_BASE_LOCKOUT_MS = 30_000;

function clientIp(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

function authThrottle(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const entry = _authAttempts.get(ip);
  if (!entry) return { allowed: true };
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - now };
  }
  if (now - entry.firstAt > AUTH_WINDOW_MS) {
    _authAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function authRecordFailure(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let entry = _authAttempts.get(ip);
  if (!entry || now - entry.firstAt > AUTH_WINDOW_MS) {
    entry = { count: 0, firstAt: now, lockedUntil: 0 };
  }
  entry.count++;
  if (entry.count >= AUTH_MAX_ATTEMPTS) {
    // Exponential lockout: 30s, 60s, 120s, …, capped at 30 min
    const mult = Math.min(2 ** (entry.count - AUTH_MAX_ATTEMPTS), 60);
    entry.lockedUntil = now + Math.min(AUTH_BASE_LOCKOUT_MS * mult, 30 * 60_000);
    log.warn(`Dashboard auth: ${entry.count} failures from ${ip}, locked ${Math.round((entry.lockedUntil - now) / 1000)}s`);
  }
  _authAttempts.set(ip, entry);
}

function authRecordSuccess(req) {
  _authAttempts.delete(clientIp(req));
}

// Periodic cleanup of stale auth-throttle entries to prevent unbounded growth.
// Runs every 5 minutes; entries older than AUTH_WINDOW_MS are evicted.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _authAttempts) {
    const expired = (now - entry.firstAt > AUTH_WINDOW_MS) && (!entry.lockedUntil || entry.lockedUntil <= now);
    if (expired) _authAttempts.delete(ip);
  }
}, 5 * 60_000).unref?.();

/**
 * Add an account from any supported credential payload. Used by both the
 * single-account POST and the batch importer so the same precedence and
 * error handling apply everywhere.
 *
 * Precedence (first non-empty wins): api_key > id_token > refresh_token > token > email+password.
 */
async function addAccountFromCreds(creds) {
  if (!creds || typeof creds !== 'object') throw new Error('Empty credentials payload');
  const label = typeof creds.label === 'string' ? creds.label.trim() || undefined : undefined;

  if (typeof creds.api_key === 'string' && creds.api_key.trim()) {
    return addAccountByKey(creds.api_key.trim(), label);
  }
  if (typeof creds.id_token === 'string' && creds.id_token.trim()) {
    // OAuth flow: Firebase idToken → Codeium register → API key. The caller
    // is responsible for obtaining the idToken (e.g. Google sign-in popup),
    // we just register it as a windbu account.
    const proxy = creds.proxy?.host ? creds.proxy : (getProxyConfig().global || null);
    const { apiKey, name } = await reRegisterWithCodeium(creds.id_token.trim(), proxy);
    const account = addAccountByKey(apiKey, label || name || creds.email || 'OAuth');
    if (creds.refresh_token) {
      setAccountTokens(account.id, { refreshToken: creds.refresh_token, idToken: creds.id_token });
    }
    return account;
  }
  if (typeof creds.refresh_token === 'string' && creds.refresh_token.trim()) {
    return addAccountByRefreshToken(creds.refresh_token.trim(), label);
  }
  if (typeof creds.token === 'string' && creds.token.trim()) {
    return addAccountByToken(creds.token.trim(), label);
  }
  if (typeof creds.email === 'string' && typeof creds.password === 'string' && creds.email && creds.password) {
    const proxy = creds.proxy?.host ? creds.proxy : null;
    return addAccountByEmail(creds.email.trim(), creds.password, proxy);
  }
  throw new Error('Provide one of: api_key, token, refresh_token, id_token, or email+password');
}

/**
 * Best-effort human-readable hint for failed batch entries — never includes
 * the raw secret material, only the type and an opaque identifier (email or
 * a short prefix) so the operator can spot which row failed.
 */
function describeCreds(creds) {
  if (!creds || typeof creds !== 'object') return 'invalid';
  if (creds.api_key) return `api_key:${String(creds.api_key).slice(0, 6)}…`;
  if (creds.id_token) return `id_token (${creds.email || 'oauth'})`;
  if (creds.refresh_token) return `refresh_token:${String(creds.refresh_token).slice(0, 6)}…`;
  if (creds.token) return `token:${String(creds.token).slice(0, 6)}…`;
  if (creds.email) return `email:${creds.email}`;
  return 'unknown';
}

/**
 * Handle all /dashboard/api/* requests.
 */
export async function handleDashboardApi(method, subpath, body, req, res) {
  if (method === 'OPTIONS') return json(res, 204, '');

  // Auth check (except for auth verification endpoint)
  if (subpath !== '/auth' && !checkAuth(req)) {
    return json(res, 401, { error: 'Unauthorized. Set X-Dashboard-Password header.' });
  }

  // ─── Auth ─────────────────────────────────────────────
  if (subpath === '/auth') {
    const needsAuth = !!(config.dashboardPassword || config.apiKey);
    if (!needsAuth) return json(res, 200, { required: false });
    const throttle = authThrottle(req);
    if (!throttle.allowed) {
      res.setHeader?.('Retry-After', Math.ceil(throttle.retryAfterMs / 1000));
      return json(res, 429, {
        required: true, valid: false,
        error: 'Too many failed auth attempts. Try again later.',
        retry_after_ms: throttle.retryAfterMs,
      });
    }
    const valid = checkAuth(req);
    if (valid) authRecordSuccess(req);
    else authRecordFailure(req);
    return json(res, 200, { required: true, valid });
  }

  // ─── Overview ─────────────────────────────────────────
  if (subpath === '/overview' && method === 'GET') {
    const stats = getStats();
    return json(res, 200, {
      uptime: process.uptime(),
      startedAt: stats.startedAt,
      accounts: getAccountCount(),
      authenticated: isAuthenticated(),
      langServer: getLsStatus(),
      totalRequests: stats.totalRequests,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      successRate: stats.totalRequests > 0
        ? ((stats.successCount / stats.totalRequests) * 100).toFixed(1)
        : '0.0',
      cache: cacheStats(),
    });
  }

  // ─── Experimental features ────────────────────────────
  if (subpath === '/experimental' && method === 'GET') {
    return json(res, 200, { flags: getExperimental(), conversationPool: convPoolStats() });
  }
  if (subpath === '/experimental' && method === 'PUT') {
    const flags = setExperimental(body || {});
    // Dropping the toggle should also drop any live entries so nothing
    // resumes against a disabled feature on the next request.
    if (!flags.cascadeConversationReuse) convPoolClear();
    return json(res, 200, { success: true, flags });
  }
  if (subpath === '/experimental/conversation-pool' && method === 'DELETE') {
    const n = convPoolClear();
    return json(res, 200, { success: true, cleared: n });
  }

  // ─── Identity prompts ──────────────────────────────
  if (subpath === '/identity-prompts' && method === 'GET') {
    return json(res, 200, getIdentityPrompts());
  }
  if (subpath === '/identity-prompts' && method === 'PUT') {
    const prompts = setIdentityPrompts(body || {});
    return json(res, 200, { success: true, prompts });
  }
  if (subpath === '/identity-prompts' && method === 'DELETE') {
    const provider = body?.provider || null;
    const prompts = resetIdentityPrompt(provider);
    return json(res, 200, { success: true, prompts });
  }

  // ─── Cache ────────────────────────────────────────────
  if (subpath === '/cache' && method === 'GET') {
    return json(res, 200, cacheStats());
  }
  if (subpath === '/cache' && method === 'DELETE') {
    cacheClear();
    return json(res, 200, { success: true });
  }

  // ─── Accounts ─────────────────────────────────────────
  if (subpath === '/accounts' && method === 'GET') {
    return json(res, 200, { accounts: getAccountList() });
  }

  // POST /accounts — add one account (any supported credential type)
  //
  // Body shape: pick exactly one of:
  //   { api_key: "...", label? }                         — direct Codeium API key
  //   { token: "ott$...", label? }                       — Windsurf one-time token / JWT
  //   { refresh_token: "...", label? }                   — Firebase refresh token
  //   { email, password, label?, proxy? }                — direct Windsurf login
  //   { id_token: "...", label?, email? }                — OAuth idToken (Google/GitHub via Firebase)
  //
  // Or a batch payload: { accounts: [<any-of-above>, ...] }
  if (subpath === '/accounts' && method === 'POST') {
    // Batch path (used by Add Account → Bulk import).
    if (Array.isArray(body?.accounts)) {
      const results = [];
      for (const acct of body.accounts) {
        try {
          const account = await addAccountFromCreds(acct);
          probeAccount(account.id).catch(e => log.warn(`Auto-probe failed: ${e.message}`));
          results.push({ ok: true, id: account.id, email: account.email, method: account.method, status: account.status });
        } catch (err) {
          results.push({ ok: false, error: err.message, hint: describeCreds(acct) });
        }
      }
      return json(res, 200, { success: true, results, ...getAccountCount() });
    }

    try {
      const account = await addAccountFromCreds(body || {});
      // Fire-and-forget probe so the UI gets tier info shortly after add
      probeAccount(account.id).catch(e => log.warn(`Auto-probe failed: ${e.message}`));
      return json(res, 200, {
        success: true,
        account: { id: account.id, email: account.email, method: account.method, status: account.status },
        ...getAccountCount(),
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /accounts/probe-all — probe every active account
  if (subpath === '/accounts/probe-all' && method === 'POST') {
    const list = getAccountList().filter(a => a.status === 'active');
    const results = [];
    for (const a of list) {
      try {
        const r = await probeAccount(a.id);
        results.push({ id: a.id, email: a.email, tier: r?.tier || 'unknown' });
      } catch (err) {
        results.push({ id: a.id, email: a.email, error: err.message });
      }
    }
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/probe — manually trigger capability probe
  const accountProbe = subpath.match(/^\/accounts\/([^/]+)\/probe$/);
  if (accountProbe && method === 'POST') {
    try {
      const result = await probeAccount(accountProbe[1]);
      if (!result) return json(res, 404, { error: 'Account not found' });
      return json(res, 200, { success: true, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // POST /accounts/refresh-credits — refresh every active account's balance
  if (subpath === '/accounts/refresh-credits' && method === 'POST') {
    const results = await refreshAllCredits();
    return json(res, 200, { success: true, results });
  }

  // POST /accounts/:id/refresh-credits — single-account refresh
  const creditRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-credits$/);
  if (creditRefresh && method === 'POST') {
    const r = await refreshCredits(creditRefresh[1]);
    return json(res, r.ok ? 200 : 400, r);
  }

  // POST /accounts/batch-status — batch enable/disable
  if (subpath === '/accounts/batch-status' && method === 'POST') {
    const { ids, status } = body;
    if (!Array.isArray(ids) || !['active', 'disabled'].includes(status)) {
      return json(res, 400, { error: 'Provide ids[] and status (active|disabled)' });
    }
    const results = ids.map(id => {
      const ok = setAccountStatus(id, status);
      return { id, ok };
    });
    return json(res, 200, { success: true, results });
  }

  // PATCH /accounts/:id
  const accountPatch = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountPatch && method === 'PATCH') {
    const id = accountPatch[1];
    const errors = [];
    if (body.status) {
      if (!setAccountStatus(id, body.status)) errors.push(`invalid status: ${body.status}`);
    }
    if (body.label != null) {
      if (typeof body.label !== 'string' || body.label.length > 200) errors.push('label must be a non-empty string ≤200 chars');
      else updateAccountLabel(id, body.label);
    }
    if (body.resetErrors) resetAccountErrors(id);
    if (Array.isArray(body.blockedModels)) setAccountBlockedModels(id, body.blockedModels);
    if (errors.length) return json(res, 400, { error: errors.join('; ') });
    return json(res, 200, { success: true });
  }

  // GET /tier-access — hardcoded FREE/PRO model entitlement tables.
  // The dashboard uses this to render the full per-account model grid
  // (every row in the tier's list is shown, blocked models are dimmed).
  if (subpath === '/tier-access' && method === 'GET') {
    return json(res, 200, {
      free: _TIER_TABLE.free,
      pro: _TIER_TABLE.pro,
      unknown: _TIER_TABLE.unknown,
      expired: _TIER_TABLE.expired,
      allModels: Object.keys(MODELS),
    });
  }

  // DELETE /accounts/:id
  const accountDel = subpath.match(/^\/accounts\/([^/]+)$/);
  if (accountDel && method === 'DELETE') {
    const ok = removeAccount(accountDel[1]);
    return json(res, ok ? 200 : 404, { success: ok });
  }

  // ─── Stats ────────────────────────────────────────────
  if (subpath === '/stats' && method === 'GET') {
    return json(res, 200, getStats());
  }

  if (subpath === '/stats' && method === 'DELETE') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // ─── Usage (CLIProxyAPI-compatible schema) ───────────
  // GET /usage — aggregated snapshot
  if (subpath === '/usage' && method === 'GET') {
    const snap = getUsageSnapshot();
    return json(res, 200, { usage: snap, failed_requests: snap.failure_count });
  }

  // GET /usage/export — downloadable backup blob (version + exported_at + usage)
  if (subpath === '/usage/export' && method === 'GET') {
    const payload = exportUsage();
    const filename = `windsurfapi-usage-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // POST /usage/import — merge a snapshot with dedup; body is the full
  // { version, exported_at, usage } envelope OR a bare snapshot object.
  if (subpath === '/usage/import' && method === 'POST') {
    const result = importUsage(body);
    log.info(`Usage import: added=${result.added} skipped=${result.skipped} total=${result.total_requests}`);
    return json(res, 200, result);
  }

  // POST /usage/reset — alias of DELETE /stats for parity with CLIProxyAPI
  if (subpath === '/usage/reset' && method === 'POST') {
    resetStats();
    return json(res, 200, { success: true });
  }

  // DELETE /usage/details?days=30 — drop per-request details older than N days
  if (subpath === '/usage/details' && method === 'DELETE') {
    const url = new URL(req.url, 'http://localhost');
    const days = Math.max(1, parseInt(url.searchParams.get('days') || '30', 10));
    const r = pruneDetails(days * 24 * 3600 * 1000);
    return json(res, 200, { success: true, removed: r.removed, olderThanDays: days });
  }

  // DELETE /usage/days?days=90 — drop day aggregate buckets older than N days
  if (subpath === '/usage/days' && method === 'DELETE') {
    const url = new URL(req.url, 'http://localhost');
    const days = Math.max(1, parseInt(url.searchParams.get('days') || '90', 10));
    const r = pruneDays(days * 24 * 3600 * 1000);
    return json(res, 200, { success: true, removed: r.removed, olderThanDays: days });
  }

  // ─── Logs ─────────────────────────────────────────────
  if (subpath === '/logs' && method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const level = url.searchParams.get('level') || null;
    return json(res, 200, { logs: getLogs(since, level) });
  }

  if (subpath === '/logs/stream' && method === 'GET') {
    req.socket.setKeepAlive(true);
    req.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // Send existing logs first
    const existing = getLogs();
    for (const entry of existing.slice(-50)) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
    }, 15000);

    const cb = (entry) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    subscribeToLogs(cb);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribeFromLogs(cb);
    });
    return;
  }

  // ─── Proxy ────────────────────────────────────────────
  if (subpath === '/proxy' && method === 'GET') {
    return json(res, 200, getProxyConfig());
  }

  if (subpath === '/proxy/global' && method === 'PUT') {
    setGlobalProxy(body);
    return json(res, 200, { success: true, config: getProxyConfig() });
  }

  if (subpath === '/proxy/global' && method === 'DELETE') {
    removeProxy('global');
    return json(res, 200, { success: true });
  }

  const proxyAccount = subpath.match(/^\/proxy\/accounts\/([^/]+)$/);
  if (proxyAccount && method === 'PUT') {
    setAccountProxy(proxyAccount[1], body);
    // Spawn (or adopt) the LS instance for this proxy so chat routes immediately
    ensureLsForAccount(proxyAccount[1]).catch(e => log.warn(`LS ensure failed: ${e.message}`));
    return json(res, 200, { success: true });
  }
  if (proxyAccount && method === 'DELETE') {
    removeProxy('account', proxyAccount[1]);
    return json(res, 200, { success: true });
  }

  // ─── Config ───────────────────────────────────────────
  if (subpath === '/config' && method === 'GET') {
    return json(res, 200, {
      port: config.port,
      defaultModel: config.defaultModel,
      maxTokens: config.maxTokens,
      logLevel: config.logLevel,
      lsBinaryPath: config.lsBinaryPath,
      lsPort: config.lsPort,
      codeiumApiUrl: config.codeiumApiUrl,
      hasApiKey: !!config.apiKey,
      hasDashboardPassword: !!config.dashboardPassword,
    });
  }

  // ─── Language Server ──────────────────────────────────
  if (subpath === '/langserver/restart' && method === 'POST') {
    if (!body.confirm) {
      return json(res, 400, { error: 'Send { confirm: true } to restart language server' });
    }
    stopLanguageServer();
    setTimeout(async () => {
      await startLanguageServer({
        binaryPath: config.lsBinaryPath,
        port: config.lsPort,
        apiServerUrl: config.codeiumApiUrl,
      });
    }, 2000);
    return json(res, 200, { success: true, message: 'Restarting language server...' });
  }

  // ─── Models list ──────────────────────────────────────
  if (subpath === '/models' && method === 'GET') {
    const models = Object.entries(MODELS).map(([id, info]) => ({
      id, name: info.name, provider: info.provider,
    }));
    return json(res, 200, { models });
  }

  // ─── Manual cloud model-catalog refresh ───────────────
  // Re-fetches GetCascadeModelConfigs via the first active account and merges
  // any new modelUids into the local catalog. Idempotent; safe to spam.
  if (subpath === '/models/refresh-catalog' && method === 'POST') {
    try {
      const sizeBefore = Object.keys(MODELS).length;
      await fetchAndMergeModelCatalog();
      const sizeAfter = Object.keys(MODELS).length;
      return json(res, 200, { success: true, before: sizeBefore, after: sizeAfter, added: sizeAfter - sizeBefore });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ─── Model Access Control ──────────────────────────────
  if (subpath === '/model-access' && method === 'GET') {
    return json(res, 200, getModelAccessConfig());
  }

  if (subpath === '/model-access' && method === 'PUT') {
    if (body.mode) setModelAccessMode(body.mode);
    if (body.list) setModelAccessList(body.list);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/add' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    addModelToList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  if (subpath === '/model-access/remove' && method === 'POST') {
    if (!body.model) return json(res, 400, { error: 'model is required' });
    removeModelFromList(body.model);
    return json(res, 200, { success: true, config: getModelAccessConfig() });
  }

  // ─── Windsurf Login ────────────────────────────────────
  if (subpath === '/windsurf-login' && method === 'POST') {
    try {
      const { email, password, proxy: loginProxy, autoAdd } = body;
      if (!email || !password) return json(res, 400, { error: 'email and password are required' });

      // Use provided proxy, or global proxy
      const proxy = loginProxy?.host ? loginProxy : getProxyConfig().global;

      const result = await windsurfLogin(email, password, proxy);

      // Auto-add to account pool if requested
      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(result.apiKey, result.name || email);
        // Persist refresh token via the setter so it survives restart and
        // the background Firebase-renewal loop can find it.
        if (result.refreshToken) {
          setAccountTokens(account.id, { refreshToken: result.refreshToken, idToken: result.idToken });
        }
        // Persist the per-account proxy we used for login so chat requests
        // also egress through the same IP, then warm up a matching LS.
        if (loginProxy?.host) setAccountProxy(account.id, loginProxy);
        ensureLsForAccount(account.id)
          .then(() => probeAccount(account.id))
          .catch(e => log.warn(`Auto-probe failed: ${e.message}`));
      }

      return json(res, 200, {
        success: true,
        // Never echo the raw Windsurf apiKey back to the caller — the
        // account is already stored in the pool; the dashboard only needs
        // the stable id to render the row.
        name: result.name,
        email: result.email,
        apiServerUrl: result.apiServerUrl,
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── OAuth login (Google / GitHub via Firebase) ────────
  // POST /oauth-login — accepts Firebase idToken from client-side OAuth
  if (subpath === '/oauth-login' && method === 'POST') {
    try {
      const { idToken, refreshToken, email, provider, autoAdd } = body;
      if (!idToken) return json(res, 400, { error: 'idToken is required' });

      const proxy = getProxyConfig().global;
      const { apiKey, name } = await reRegisterWithCodeium(idToken, proxy);

      let account = null;
      if (autoAdd !== false) {
        account = addAccountByKey(apiKey, name || email || provider || 'OAuth');
        if (refreshToken) {
          setAccountTokens(account.id, { refreshToken, idToken });
        }
        ensureLsForAccount(account.id)
          .then(() => probeAccount(account.id))
          .catch(e => log.warn(`OAuth auto-probe failed: ${e.message}`));
      }

      return json(res, 200, {
        success: true,
        name,
        email: email || '',
        account: account ? { id: account.id, email: account.email, status: account.status } : null,
      });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // ─── Rate Limit Check ──────────────────────────────────
  // POST /accounts/:id/rate-limit — check capacity for a single account
  const rateLimitCheck = subpath.match(/^\/accounts\/([^/]+)\/rate-limit$/);
  if (rateLimitCheck && method === 'POST') {
    // Public view from getAccountList() strips apiKey; use the internal
    // view to get the actual key so checkMessageRateLimit can call upstream.
    const list = getInternalAccountView();
    const acct = list.find(a => a.id === rateLimitCheck[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const result = await checkMessageRateLimit(acct.apiKey, proxy);
      return json(res, 200, { success: true, account: acct.email, ...result });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // ─── Firebase Token Refresh ───────────────────────────────
  // POST /accounts/:id/refresh-token — manually refresh Firebase token
  const tokenRefresh = subpath.match(/^\/accounts\/([^/]+)\/refresh-token$/);
  if (tokenRefresh && method === 'POST') {
    // Internal view carries apiKey + refreshToken so we can actually rotate.
    const list = getInternalAccountView();
    const acct = list.find(a => a.id === tokenRefresh[1]);
    if (!acct) return json(res, 404, { error: 'Account not found' });
    if (!acct.refreshToken) return json(res, 400, { error: 'Account has no refresh token' });
    try {
      const proxy = getEffectiveProxy(acct.id) || null;
      const { idToken, refreshToken: newRefresh } = await refreshFirebaseToken(acct.refreshToken, proxy);
      const { apiKey } = await reRegisterWithCodeium(idToken, proxy);
      const keyChanged = apiKey && apiKey !== acct.apiKey;
      // Persist the fresh credentials back onto the account. Without this, the
      // in-memory apiKey stays on the now-stale value until the next server
      // restart — every subsequent request from this account will fail auth.
      setAccountTokens(acct.id, { apiKey: apiKey || acct.apiKey, refreshToken: newRefresh || acct.refreshToken, idToken });
      return json(res, 200, { success: true, keyChanged, email: acct.email });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  json(res, 404, { error: `Dashboard API: ${method} ${subpath} not found` });
}
