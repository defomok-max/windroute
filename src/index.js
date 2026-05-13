/**
 * windbu — entrypoint.
 *
 * Startup order:
 *   1) logger (patches config.log with ring buffer + disk JSONL)
 *   2) preflight checks (Node ver, LS binary, port free, data dir writable)
 *   3) Language Server boot
 *   4) account pool hydration
 *   5) HTTP server listen
 *
 * All paths come from config.js — no /tmp, /opt, or cwd-relative writes.
 */
import './dashboard/logger.js';
import { initAuth, isAuthenticated } from './auth.js';
import { startLanguageServer, waitForReady, stopLanguageServer } from './langserver.js';
import { startServer } from './server.js';
import { config, log } from './config.js';
import { runPreflight } from './preflight.js';
import { flushStatsSync } from './dashboard/stats.js';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { BRAND, VERSION } from './version.js';

// ── Global error handlers ─────────────────────────────────
// Catch stray promise rejections and uncaught exceptions so the process
// doesn't die silently (Node 15+ default). We log the error with full stack
// and keep running — these shouldn't happen in practice, but when they do
// the user deserves a trail in %USERPROFILE%\.windbu\logs\error-*.jsonl
// rather than an abruptly dead server window.
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  log.error('Unhandled promise rejection:', msg);
});
process.on('uncaughtException', (err, origin) => {
  const msg = err instanceof Error ? (err.stack || err.message) : String(err);
  log.error(`Uncaught exception (${origin}):`, msg);
  // Uncaught exceptions typically mean a broken invariant — exit after
  // logging so the watchdog (start.ps1) can restart us cleanly instead of
  // leaving the process in a half-dead state.
  try { flushStatsSync(); } catch {}
  try { stopLanguageServer(); } catch {}
  process.exit(1);
});

async function main() {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const line1 = pad(`${BRAND}  v${VERSION}`, 42);
  const banner = `
  +------------------------------------------+
  |  ${line1}|
  |  local gateway for Windsurf AI           |
  |  OpenAI + Anthropic compatible           |
  +------------------------------------------+
`;
  console.log(banner);

  // Fail-fast environment audit. Blocks startup on hard errors (bad LS path,
  // port busy, unwritable data dir) and prints fix hints for each failure.
  await runPreflight();

  // Start Language Server (only if the binary exists — otherwise preflight
  // already warned, we still want the dashboard + /auth/login to work).
  const binaryPath = config.lsBinaryPath;
  if (existsSync(binaryPath)) {
    try {
      // Wipe workspace on every boot — Cascade leaves artifacts from previous
      // chats that bleed into the next session's system prompt otherwise.
      try { mkdirSync(config.workspaceDir, { recursive: true }); } catch {}
      for (const entry of readdirSync(config.workspaceDir)) {
        try { rmSync(join(config.workspaceDir, entry), { recursive: true, force: true }); } catch {}
      }
    } catch {}

    await startLanguageServer({
      binaryPath,
      port: config.lsPort,
      apiServerUrl: config.codeiumApiUrl,
    });

    try {
      await waitForReady(15000);
    } catch (err) {
      log.error(`Language server failed to start: ${err.message}`);
      log.error('Chat completions will not work without the language server.');
    }
  } else {
    log.warn(`Language server binary not found: ${binaryPath}`);
    log.warn('Run scripts\\detect-ls.ps1 or set LS_BINARY_PATH in .env');
  }

  await initAuth();

  if (!isAuthenticated()) {
    log.warn('No accounts configured. Add via:');
    log.warn('  Dashboard → Accounts → Add');
    log.warn('  POST /auth/login {"token":"..."}');
    log.warn('Get a Windsurf token: https://windsurf.com/editor/show-auth-token');
  }

  const server = startServer();

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const inflight = server.getActiveRequests?.() ?? '?';
    log.info(`${signal} received — draining ${inflight} in-flight requests (up to 30s)...`);
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    server.close(() => {
      log.info('HTTP server closed, stopping language server');
      try { flushStatsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    });
    setTimeout(() => {
      log.warn('Drain timeout, forcing exit');
      try { flushStatsSync(); } catch {}
      try { stopLanguageServer(); } catch {}
      process.exit(0);
    }, 30_000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // On Windows SIGINT is only delivered if we opt into readline-based signal
  // handling. Without this Ctrl-C in the spawned cmd window is a no-op.
  if (process.platform === 'win32') {
    try {
      const rl = await import('readline');
      const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
      iface.on('SIGINT', () => process.emit('SIGINT'));
    } catch {}
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
