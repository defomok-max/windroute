/**
 * Preflight checks — block startup on hard environment errors and print
 * actionable hints. Keep this short: one check per concern, fail-fast.
 */
import net from 'net';
import { existsSync, accessSync, constants, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { config, log } from './config.js';

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    log.error(`Node.js 20+ required (current: ${process.versions.node}).`);
    log.error('Install from https://nodejs.org/ and try again.');
    process.exit(1);
  }
}

function checkDataDir() {
  // config.js already mkdir's the tree. This is a write probe to catch
  // read-only profiles, quota issues, or locked folders before requests arrive.
  const probe = join(config.dataDir, '.write-probe');
  try {
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (e) {
    log.error(`Data dir not writable: ${config.dataDir} (${e.code || e.message})`);
    log.error('Set WINDBU_DATA_DIR in .env to a writable path.');
    process.exit(1);
  }
}

function checkLsBinary() {
  if (!config.lsBinaryPath) {
    log.warn('LS_BINARY_PATH is empty — chat completions will not work until set.');
    return;
  }
  if (!existsSync(config.lsBinaryPath)) {
    log.warn(`Language Server binary not found: ${config.lsBinaryPath}`);
    log.warn('Dashboard and /auth/login will still work.');
    log.warn('Fix: run scripts\\detect-ls.ps1, or edit .env → LS_BINARY_PATH');
    return;
  }
  try {
    accessSync(config.lsBinaryPath, constants.R_OK);
  } catch {
    log.warn(`Language Server binary not readable: ${config.lsBinaryPath}`);
  }
}

function checkPort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${config.port} is already in use on ${config.host}.`);
        log.error(`Fix: change PORT in .env, or stop the process using it:`);
        log.error(`   powershell> Get-NetTCPConnection -LocalPort ${config.port} | Select OwningProcess`);
        process.exit(1);
      }
      resolve();
    });
    srv.once('listening', () => {
      srv.close(() => resolve());
    });
    srv.listen(config.port, config.host);
  });
}

export async function runPreflight() {
  checkNode();
  checkDataDir();
  checkLsBinary();
  await checkPort();
}
