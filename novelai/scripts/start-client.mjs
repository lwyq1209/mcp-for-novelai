import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { EXIT_REFUSED, acquireLauncherLock, attachDetachedLog, electronBinary, findRunningHost, launchDetached, npmBuildCommand } from './win32-launch.mjs';
import { DATA_DIR_ENV, resolveDataRoot } from '../src/data-paths.mjs';

const win32 = process.platform === 'win32';
// win32: import.meta.url keeps the caller's spelling (C:\users\ALICE\...). Pin the
// real case so the client and log paths match the checkout on disk.
const root = win32 ? realpathSync.native(fileURLToPath(new URL('..', import.meta.url))) : fileURLToPath(new URL('..', import.meta.url));
// win32 background launcher (started by --detach): no console, so everything goes to its log file.
const detachedLog = win32 && process.env.NOVELAI_LAUNCH_DETACHED === '1' ? attachDetachedLog(root) : null;
const client = path.join(root, 'client');
const usage = win32
  ? 'Usage: node scripts/start-client.mjs [--data-dir <folder>] [--detach] [--no-build] [--inpaint-diagnostics]'
  : 'Usage: node scripts/start-client.mjs [--data-dir <folder>] [--no-build] [--inpaint-diagnostics]';
// --data-dir <folder> (or --data-dir=<folder>) runs the client on its own data root (NOVELAI_DATA_DIR):
// development and isolated worktree tests. Without it the client uses NOVELAI_DATA_DIR from the
// environment when set, else the default data root <appData>/mcp-for-novelai.
const args = [];
let dataDir;
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
    const value = arg === '--data-dir' ? process.argv[++index] : arg.slice('--data-dir='.length);
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || dataDir !== undefined) throw new Error(usage);
    dataDir = path.resolve(value.trim());
  } else args.push(arg);
}
// win32 adds --detach (background launch, see win32-launch.mjs); POSIX keeps the original set.
const allowed = win32 ? ['--no-build', '--inpaint-diagnostics', '--detach'] : ['--no-build', '--inpaint-diagnostics'];
if (args.some(arg => !allowed.includes(arg))) throw new Error(usage);
const env = { ...process.env };
if (dataDir !== undefined) env[DATA_DIR_ENV] = dataDir;
// The data root this client will use (shared/runtime/data-paths.cjs, same as the client and the MCP server).
const dataRoot = resolveDataRoot({ env });
// Explicit per-launch diagnostics; a stale inherited environment cannot enable it.
delete env.NOVELAI_INPAINT_DIAGNOSTICS;
if (args.includes('--inpaint-diagnostics')) env.NOVELAI_INPAINT_DIAGNOSTICS = '1';
// This entry runs the bundled UI, independent of capture/dev sessions.
delete env.VITE_DEV_SERVER_URL;
delete env.NAI_UI_CAPTURE_PATH;
delete env.ELECTRON_RUN_AS_NODE;
if (win32) { delete env.NOVELAI_LAUNCH_DETACHED; delete env.NOVELAI_LAUNCH_LOG; }
if (win32 && args.includes('--detach')) {
  // The background launcher gets the same --data-dir, so it resolves the same data root.
  const forwarded = [...args.filter(arg => arg !== '--detach'), ...(dataDir !== undefined ? ['--data-dir', dataDir] : [])];
  process.exitCode = await launchDetached({ novelaiRoot: root, dataRoot, script: path.join(root, 'scripts', 'start-client.mjs'), forwarded, env: process.env });
} else {
  console.log(`NovelAI client data folder: ${dataRoot}`);
  // hideConsole only for console tools (the build) of a background launcher; never for
  // Electron, whose first window would otherwise start hidden (STARTUPINFO SW_HIDE).
  function run(command, parameters, { hideConsole = false } = {}) {
    return new Promise((resolve, reject) => {
      const stdio = detachedLog === null ? 'inherit' : ['ignore', detachedLog, detachedLog];
      const child = spawn(command, parameters, { cwd: client, env, stdio, ...(hideConsole ? { windowsHide: true } : {}) });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Client exited ${code ?? signal}`)));
    });
  }
  if (win32) {
    // One launcher per data folder for the whole build + host lifetime; Electron's own
    // single-instance lock only stops the second host, not a second build.
    if (!await acquireLauncherLock(dataRoot)) {
      console.error('Another MCP for NovelAI launcher for this data folder is already running (build or host); not starting a second copy.');
      process.exit(EXIT_REFUSED);
    }
    let hosts;
    try { hosts = findRunningHost(dataRoot); }
    catch (error) { console.error(error.message); process.exit(1); }
    if (hosts.length) {
      console.error(`MCP for NovelAI is already running for this data folder (PID ${hosts.join(', ')}); not starting a second copy.`);
      process.exit(EXIT_REFUSED);
    }
  }
  if (!args.includes('--no-build')) {
    if (win32) { const npm = npmBuildCommand(); await run(npm.command, npm.parameters, { hideConsole: detachedLog !== null }); }
    else await run('npm', ['run', 'build']);
  }
  if (win32) await run(electronBinary(client), ['.']);
  else {
    const binary = (await readFile(path.join(client, 'node_modules/electron/path.txt'), 'utf8')).trim();
    await run(path.join(client, 'node_modules/electron/dist', binary), ['.']);
  }
}
