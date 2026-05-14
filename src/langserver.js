/**
 * Language server pool manager.
 * Spawns multiple LS instances — one per unique outbound proxy (plus a default
 * no-proxy instance). Accounts are routed to the LS instance matching their
 * configured proxy so that each upstream Codeium request goes out through the
 * right egress IP. Also avoids the LS state-pollution bug where switching
 * accounts within a single LS session causes workspace setup streams to be
 * canceled.
 */

import { spawn } from 'child_process';
import http2 from 'http2';
import net from 'net';
import { resolve as pathResolve, join } from 'path';
import { mkdirSync } from 'fs';
import { log, config } from './config.js';
import { closeSessionForPort } from './grpc.js';

// Default picked up from config.js (which auto-detects by platform/arch).
const DEFAULT_BINARY = config.lsBinaryPath;
// Put per-proxy LS data dirs under <windbu data>/ls-<key> to co-locate with
// everything else. LS_DATA_DIR env still wins for power users who want elsewhere.
const DEFAULT_DATA_ROOT = pathResolve(process.env.LS_DATA_DIR || join(config.dataDir, 'ls-data'));
const DEFAULT_PORT = 42100;
const DEFAULT_CSRF = 'windbu-api-csrf-fixed-token';
const DEFAULT_API_URL = 'https://server.self-serve.windsurf.com';

// Pool: key -> { process, port, csrfToken, proxy, startedAt, ready }
const _pool = new Map();
// In-flight ensureLs promises keyed on proxyKey so concurrent callers share
// a single spawn instead of racing to allocate the same port.
const _pending = new Map();
let _nextPort = DEFAULT_PORT + 1;
let _binaryPath = DEFAULT_BINARY;
let _apiServerUrl = DEFAULT_API_URL;

function proxyKey(proxy) {
  if (!proxy || !proxy.host) return 'default';
  return `px_${proxy.host.replace(/\./g, '_')}_${proxy.port}`;
}

function proxyUrl(proxy) {
  if (!proxy || !proxy.host) return null;
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || '')}@`
    : '';
  return `http://${auth}${proxy.host}:${proxy.port || 8080}`;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host: '127.0.0.1' }, () => {
      sock.destroy(); resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(1000, () => { sock.destroy(); resolve(false); });
  });
}

// Allocate a port that's not currently in the _pool and not currently
// listening on localhost. Serial scan; concurrency is serialised by the
// caller holding the _pending entry for its proxy key.
async function allocatePort() {
  const inUseInPool = new Set(Array.from(_pool.values()).map(e => e.port));
  // Try up to ~100 ports starting from _nextPort so a cluster of proxies
  // doesn't collide on the first free port after a crash.
  for (let i = 0; i < 100; i++) {
    const candidate = _nextPort++;
    if (inUseInPool.has(candidate)) continue;
    if (await isPortInUse(candidate)) continue;
    return candidate;
  }
  throw new Error('allocatePort: no free port found in 100 attempts');
}

async function waitPortReady(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const client = http2.connect(`http://localhost:${port}`);
        const timer = setTimeout(() => { try { client.close(); } catch {} reject(new Error('timeout')); }, 2000);
        client.on('connect', () => { clearTimeout(timer); client.close(); resolve(); });
        client.on('error', (e) => { clearTimeout(timer); try { client.close(); } catch {} reject(e); });
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  throw new Error(`LS port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Spawn an LS instance for the given proxy (or no-proxy default).
 * Idempotent — returns the existing entry if one is already running. Concurrent
 * calls for the same proxy share the in-flight spawn via _pending.
 */
export async function ensureLs(proxy = null) {
  const key = proxyKey(proxy);
  const existing = _pool.get(key);
  if (existing && existing.ready) return existing;
  const inflight = _pending.get(key);
  if (inflight) return inflight;

  const promise = _ensureLsInternal(proxy, key).finally(() => {
    _pending.delete(key);
  });
  _pending.set(key, promise);
  return promise;
}

async function _ensureLsInternal(proxy, key) {
  const isDefault = key === 'default';
  let port;

  if (isDefault) {
    port = DEFAULT_PORT;
    // If something is already listening on the default port (e.g. leftover
    // from a previous crashed run), adopt it rather than fight for the port.
    // Verify it actually speaks gRPC/HTTP-2 first — a stale TCP listener that
    // never upgrades would otherwise get marked ready:true and every chat
    // request would hang on the first gRPC call.
    if (await isPortInUse(port)) {
      try {
        await waitPortReady(port, 5000);
        log.info(`LS default port ${port} already in use and speaks HTTP/2 — adopting existing instance`);
        const entry = {
          process: null, port, csrfToken: DEFAULT_CSRF,
          proxy: null, startedAt: Date.now(), ready: true,
          workspaceInit: null, sessionId: null,
        };
        _pool.set(key, entry);
        return entry;
      } catch (e) {
        log.warn(`LS default port ${port} is taken but not HTTP/2-ready: ${e.message} — allocating a fresh port`);
        port = await allocatePort();
      }
    }
  } else {
    port = await allocatePort();
  }

  const dataDir = pathResolve(DEFAULT_DATA_ROOT, key);
  try { mkdirSync(`${dataDir}/db`, { recursive: true }); } catch {}

  const args = [
    `--api_server_url=${_apiServerUrl}`,
    `--server_port=${port}`,
    `--csrf_token=${DEFAULT_CSRF}`,
    `--register_user_url=https://api.codeium.com/register_user/`,
    `--codeium_dir=${dataDir}`,
    `--database_dir=${dataDir}/db`,
    '--enable_local_search=false',
    '--enable_index_service=false',
    '--enable_lsp=false',
    '--detect_proxy=false',
  ];

  // HOME is used by LS to resolve credential/cache dirs. On Windows there's no
  // $HOME, so point it at the user profile (LS accepts either separator).
  const homeFallback = process.platform === 'win32'
    ? (process.env.USERPROFILE || process.env.HOMEPATH || config.dataDir)
    : '/root';
  const env = { ...process.env, HOME: process.env.HOME || homeFallback };
  const pUrl = proxyUrl(proxy);
  if (pUrl) {
    env.HTTPS_PROXY = pUrl;
    env.HTTP_PROXY = pUrl;
    env.https_proxy = pUrl;
    env.http_proxy = pUrl;
  }

  log.info(`Starting LS instance key=${key} port=${port} proxy=${pUrl || 'none'}`);

  const proc = spawn(_binaryPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    // Keep the LS console window hidden on Windows (otherwise a flashing
    // cmd.exe pops up for every spawned instance).
    windowsHide: true,
    // Never let PowerShell / cmd interpret the args — the binary takes raw argv.
    shell: false,
  });

  proc.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      if (/ERROR|error/.test(line)) log.error(`[LS:${key}] ${line}`);
      else log.debug(`[LS:${key}] ${line}`);
    }
  });
  proc.stderr.on('data', (data) => {
    const line = data.toString().trim();
    if (line) log.debug(`[LS:${key}:err] ${line}`);
  });
  proc.on('exit', (code, signal) => {
    log.warn(`LS instance ${key} exited: code=${code} signal=${signal}`);
    const gone = _pool.get(key);
    _pool.delete(key);
    if (gone?.port) {
      import('./conversation-pool.js').then(m => m.invalidateFor({ lsPort: gone.port })).catch(() => {});
    }
  });
  proc.on('error', (err) => {
    log.error(`LS instance ${key} spawn error: ${err.message}`);
    _pool.delete(key);
  });

  const entry = {
    process: proc, port, csrfToken: DEFAULT_CSRF,
    proxy, startedAt: Date.now(), ready: false,
    // One-shot Cascade workspace init promise. cascadeChat() awaits this so
    // the heavy InitializePanelState / AddTrackedWorkspace / UpdateWorkspaceTrust
    // trio only runs once per LS lifetime instead of once per request.
    workspaceInit: null,
    sessionId: null,
  };
  _pool.set(key, entry);

  try {
    await waitPortReady(port, 25000);
    entry.ready = true;
    log.info(`LS instance ${key} ready on port ${port}`);
  } catch (err) {
    log.error(`LS instance ${key} failed to become ready: ${err.message}`);
    killLsProcess(proc);
    _pool.delete(key);
    throw err;
  }
  return entry;
}

/**
 * Kill an LS process cleanly cross-platform.
 * On Windows SIGTERM is silently ignored by most native binaries, so we fall
 * back to `taskkill /T /F /PID <pid>` to also nuke child processes.
 */
function killLsProcess(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      // /T — tree kill (any children LS spawned), /F — force.
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      proc.kill('SIGTERM');
    }
  } catch {
    try { proc.kill('SIGKILL'); } catch {}
  }
}

/**
 * Stop and remove the LS instance associated with a given proxy.
 * Used when a proxy is reassigned so the old egress no longer exists.
 */
export async function restartLsForProxy(proxy) {
  const key = proxyKey(proxy);
  const entry = _pool.get(key);
  if (entry?.process) {
    closeSessionForPort(entry.port);
    killLsProcess(entry.process);
  }
  _pool.delete(key);
  return ensureLs(proxy);
}

/**
 * Get the LS entry matching a proxy (or default when proxy is null).
 * Returns the default instance as a fallback if the proxy-specific one hasn't
 * been spawned yet.
 */
export function getLsFor(proxy) {
  const key = proxyKey(proxy);
  return _pool.get(key) || _pool.get('default') || null;
}

/**
 * Look up an LS pool entry by its gRPC port. Used by WindsurfClient so it
 * can attach per-LS state (one-shot cascade workspace init, persistent
 * sessionId) without plumbing the entry through every call site.
 */
export function getLsEntryByPort(port) {
  for (const entry of _pool.values()) {
    if (entry.port === port) return entry;
  }
  return null;
}

// ─── Backward-compat API ───────────────────────────────────

export function getLsPort() {
  return _pool.get('default')?.port || DEFAULT_PORT;
}
export function getCsrfToken() {
  return _pool.get('default')?.csrfToken || DEFAULT_CSRF;
}

/**
 * Legacy entry point used by index.js — starts the default (no-proxy) LS.
 */
export async function startLanguageServer(opts = {}) {
  _binaryPath = opts.binaryPath || process.env.LS_BINARY_PATH || _binaryPath;
  _apiServerUrl = opts.apiServerUrl || process.env.CODEIUM_API_URL || _apiServerUrl;
  const def = await ensureLs(null);
  return { port: def.port, csrfToken: def.csrfToken };
}

export function stopLanguageServer() {
  for (const [key, entry] of _pool) {
    closeSessionForPort(entry.port);
    killLsProcess(entry.process);
    log.info(`LS instance ${key} stopped`);
  }
  _pool.clear();
}

export function isLanguageServerRunning() {
  return _pool.size > 0;
}

export async function waitForReady(timeoutMs = 20000) {
  const def = _pool.get('default');
  if (!def) throw new Error('default LS not initialized');
  if (def.ready) return true;
  await waitPortReady(def.port, timeoutMs);
  def.ready = true;
  return true;
}

export function getLsStatus() {
  const def = _pool.get('default');
  return {
    running: _pool.size > 0,
    pid: def?.process?.pid || null,
    port: def?.port || DEFAULT_PORT,
    startedAt: def?.startedAt || null,
    restartCount: 0,
    instances: Array.from(_pool.entries()).map(([key, e]) => ({
      key, port: e.port,
      pid: e.process?.pid || null,
      proxy: e.proxy ? `${e.proxy.host}:${e.proxy.port}` : null,
      startedAt: e.startedAt,
      ready: e.ready,
    })),
  };
}
