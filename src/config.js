/**
 * windbu — конфигурация.
 *
 * Все runtime-пути идут через config.dataDir (по умолчанию %USERPROFILE%\.windbu).
 * Это исключает хардкод /tmp/, /opt/, ./accounts.json и т.п. из upstream.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Loads .env from project root (zero-deps, supports quoted values + comments).
function loadEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadEnv();

/**
 * Default Language Server binary path per OS/arch.
 * On Windows windbu ships as Windows-only — the fallback chain prefers
 * the user-scoped Windsurf install and falls back to machine-scoped.
 */
function defaultLsBinaryPath() {
  const { platform, arch } = process;

  if (platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Windsurf', 'resources', 'app', 'extensions', 'windsurf', 'bin', 'language_server_windows_x64.exe'),
      process.env.APPDATA && join(process.env.APPDATA, 'Windsurf', 'bin', 'language_server_windows_x64.exe'),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Windsurf', 'bin', 'language_server_windows_x64.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Windsurf', 'resources', 'app', 'extensions', 'windsurf', 'bin', 'language_server_windows_x64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // no detection — return the most likely path so error messages are useful
    return candidates[0] || 'C:\\Windsurf\\language_server_windows_x64.exe';
  }
  // Non-Windows kept for dev/reference; windbu officially supports Windows only.
  if (platform === 'darwin') {
    return `/opt/windsurf/language_server_macos_${arch === 'arm64' ? 'arm' : 'x64'}`;
  }
  return `/opt/windsurf/language_server_linux_${arch === 'arm64' ? 'arm' : 'x64'}`;
}

/**
 * Resolve the data root. Prefers WINDBU_DATA_DIR, then legacy LS_DATA_DIR,
 * then %USERPROFILE%\.windbu on Windows, else ~/.windbu.
 */
function resolveDataDir() {
  const explicit = process.env.WINDBU_DATA_DIR || process.env.LS_DATA_DIR;
  if (explicit) return resolve(explicit);
  const home = homedir() || (process.env.USERPROFILE || process.env.HOME);
  return resolve(home || '.', '.windbu');
}

const DATA_DIR = resolveDataDir();
// Ensure data dir tree exists up-front so every module can just write into it.
for (const sub of ['', 'db', 'logs', 'workspace']) {
  try { mkdirSync(join(DATA_DIR, sub), { recursive: true }); } catch {}
}

function resolveWorkspaceDir() {
  // Prefer a windbu-owned folder under DATA_DIR so cleanup is co-located with
  // everything else. Fall back to OS tmp on any surprising platform.
  const ws = process.env.WINDBU_WORKSPACE_DIR
    ? resolve(process.env.WINDBU_WORKSPACE_DIR)
    : join(DATA_DIR, 'workspace');
  try { mkdirSync(ws, { recursive: true }); } catch {}
  return ws;
}

export const config = {
  port: parseInt(process.env.PORT || '20129', 10),
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.API_KEY || '',

  codeiumAuthToken: process.env.CODEIUM_AUTH_TOKEN || '',
  codeiumApiKey: process.env.CODEIUM_API_KEY || '',
  codeiumEmail: process.env.CODEIUM_EMAIL || '',
  codeiumPassword: process.env.CODEIUM_PASSWORD || '',

  codeiumApiUrl: process.env.CODEIUM_API_URL || 'https://server.self-serve.windsurf.com',
  defaultModel: process.env.DEFAULT_MODEL || 'claude-sonnet-4.6',
  maxTokens: parseInt(process.env.MAX_TOKENS || '8192', 10),
  logLevel: process.env.LOG_LEVEL || 'info',

  lsBinaryPath: process.env.LS_BINARY_PATH || defaultLsBinaryPath(),
  lsPort: parseInt(process.env.LS_PORT || '42100', 10),

  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // ── centralized paths (used across modules instead of hardcoded ./foo.json) ──
  dataDir: DATA_DIR,
  workspaceDir: resolveWorkspaceDir(),
  accountsFile: join(DATA_DIR, 'accounts.json'),
  proxyFile: join(DATA_DIR, 'proxy.json'),
  statsFile: join(DATA_DIR, 'stats.json'),
  modelAccessFile: join(DATA_DIR, 'model-access.json'),
  runtimeConfigFile: join(DATA_DIR, 'runtime-config.json'),
  logsDir: join(DATA_DIR, 'logs'),
};

const levels = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = levels[config.logLevel] ?? 1;

export const log = {
  debug: (...args) => currentLevel <= 0 && console.log('[DEBUG]', ...args),
  info: (...args) => currentLevel <= 1 && console.log('[INFO]', ...args),
  warn: (...args) => currentLevel <= 2 && console.warn('[WARN]', ...args),
  error: (...args) => currentLevel <= 3 && console.error('[ERROR]', ...args),
};
