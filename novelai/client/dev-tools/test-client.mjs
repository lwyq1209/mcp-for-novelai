#!/usr/bin/env node
// Isolated, windowed test client of THIS checkout.
//   node dev-tools/test-client.mjs start --data <dir> [--port <cdp>|auto] [--fake-novelai <url>] [--locale zh-CN|en-US]
//                                        [--size 1440x900] [--build] [--project <dir>] [--adopt] [--timeout <s>] [--quiet]
//                                        [--no-token] [--first-run] [--foreground] [--agent-start]
//   node dev-tools/test-client.mjs stop --data <dir> [--timeout <s>] [--force]
//   node dev-tools/test-client.mjs status [--data <dir>]
//   node dev-tools/test-client.mjs --help
// Prints one JSON object (--quiet: start prints only ok, pid, port, dataRoot and the ready times). See dev-tools/README.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, pick, pollUntil, printUsage, runCli, sleep } from './lib/cli.mjs';
import { checkDataRoot } from './lib/guard.mjs';
import { buildOutputs, clientDir, dataPaths, devToolsFolder, electronExecutable, missingBuildOutputs, worktreeRoot } from './lib/paths.mjs';
import { DATA_MARKER_SWITCH, alive, findDataRootProcesses, findTestClients, isOurClient, readPidFile, stopClients, writePidFile } from './lib/processes.mjs';
import { canPrewriteToken, writeTestSettings } from './lib/settings.mjs';
import { backgroundElectronExecutable } from './lib/background-app.mjs';
import { FRONT_WATCH_AFTER_READY_MS, frontDetectedError, startFrontWatch } from './lib/front-watch.mjs';

const START_OPTIONS = ['data', 'port', 'fake-novelai', 'locale', 'size', 'build', 'project', 'adopt', 'timeout', 'anlas', 'allow-occlusion', 'quiet', 'no-token', 'first-run', 'foreground', 'agent-start'];
/** --agent-start: the switch an agent's MCP server starts the app with (the window then waits hidden or minimized). */
export const AGENT_START_SWITCH = '--started-by-agent=dev-tools';
/** The client's switch for a window that appears without activating the app (electron/window-show.ts). */
export const BACKGROUND_WINDOW_ENV = 'NAI_DEV_TOOLS_BACKGROUND';

/**
 * The environment of a test client: its data root, none of the variables that would change what it is (dev server,
 * UI capture, …), and — unless --foreground — the background switch, so its window never comes to the front.
 */
export function clientEnv(base, { dataRoot, project, foreground = false }) {
  const env = { ...base, [dataPaths.DATA_DIR_ENV]: dataRoot };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'NAI_UI_CAPTURE_PATH', 'NOVELAI_INPAINT_DIAGNOSTICS', dataPaths.PROJECT_ROOT_ENV, BACKGROUND_WINDOW_ENV]) delete env[key];
  if (project !== undefined) env[dataPaths.PROJECT_ROOT_ENV] = path.resolve(String(project));
  if (!foreground) env[BACKGROUND_WINDOW_ENV] = '1';
  return env;
}

/** The short form of a start result (--quiet): who, where, and how long it took to be ready. */
export function quietStartResult(result) {
  // A size that was not applied says why (the OS clamps a window to the screen's work area; --size needs --port).
  return { ...pick(result, ['ok', 'pid', 'port', 'dataRoot', 'bridgeReadyMs', 'cdpReadyMs', 'frontWatch']), ...(result.window && !result.window.applied ? { windowSizeApplied: false, windowSizeReason: result.window.reason ?? windowSizeReason(result.window) } : {}) };
}
/** Why a requested window size differs from the applied one. */
function windowSizeReason(window) {
  const screen = window?.viewport?.screen;
  if (screen && window.requested && (window.requested.width > screen.width || window.requested.height > screen.height)) return `The screen is ${screen.width}×${screen.height}; the OS keeps a window inside the screen's work area.`;
  return 'The OS adjusted the window size (work area, scaling or a minimum size).';
}

/** A free loopback TCP port (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}
function portFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function tail(file, bytes = 4000) {
  try { const text = fs.readFileSync(file, 'utf8'); return text.slice(-bytes); } catch { return ''; }
}

async function cdpVersion(port) {
  try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); return response.ok ? await response.json() : null; } catch { return null; }
}

function parseSize(value) {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(String(value));
  if (!match) throw new ToolError('usage', '--size must look like 1440x900.');
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** Starts one test client and waits until its bridge file exists (existence only: the file is never read). */
export async function startClient(options) {
  allowOptions(options, START_OPTIONS);
  if (options.data === undefined || options.data === true) throw new ToolError('refused_no_data', 'start needs an explicit --data <folder> (a test data root); the real data root is never used.');
  const { dataRoot } = checkDataRoot(String(options.data), { adopt: options.adopt === true, create: true });
  const size = options.size !== undefined ? parseSize(options.size) : null;
  const timeoutMs = Math.max(10, Number(options.timeout ?? 120)) * 1000;

  const running = findTestClients({ dataRoot });
  if (running.length) throw new ToolError('already_running', `A test client already runs on this data root (PID ${running.map(row => row.pid).join(', ')}).`, { pids: running.map(row => row.pid) });
  // Any other process of this data root (a main process still exiting, or its helpers after a kill) would make the new
  // client a second instance of the same profile: refused, so a test never starts one by mistake (review rework 2026-11).
  const lingering = findDataRootProcesses(dataRoot);
  if (lingering.length) throw new ToolError('data_root_busy', `Processes of this data root are still running (${lingering.map(row => `PID ${row.pid} ${row.kind} via ${row.via}`).join('; ')}). Wait until they have exited (a stopped or killed client's helpers exit shortly after it), then start again.`, { processes: lingering });

  if (options.build) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build'], { cwd: clientDir, encoding: 'utf8', shell: process.platform === 'win32' });
    if (build.status !== 0) throw new ToolError('build_failed', 'npm run build failed.', { tail: `${build.stdout ?? ''}${build.stderr ?? ''}`.slice(-4000) });
  }
  const missing = missingBuildOutputs(['renderer', 'main']);
  if (missing.length) throw new ToolError('not_built', `The client is not built (${missing.join(', ')} missing). Run: npm --prefix novelai/client run build, or pass --build.`);

  let port = null;
  if (options.port !== undefined) {
    port = options.port === 'auto' || options.port === '0' ? await freePort() : Number(options.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ToolError('usage', '--port must be 1024–65535 or auto.');
    if (!await portFree(port)) throw new ToolError('port_busy', `Port ${port} on 127.0.0.1 is already in use.`);
  }

  const fake = options['fake-novelai'];
  // A dev-tools fake service answers /__fake/health; anything else is still allowed (another local stand-in).
  const fakeHealth = fake === undefined ? null : await fetch(`${String(fake).replace(/\/+$/, '')}/__fake/health`, { signal: AbortSignal.timeout(3000) }).then(response => response.ok ? 'dev-tools fake-novelai' : `HTTP ${response.status}`).catch(() => 'unreachable');
  // --no-token: no token and no cached account (a user who has not connected yet); --first-run: the first-run guide opens.
  const noToken = options['no-token'] === true, firstRun = options['first-run'] === true;
  const settings = writeTestSettings(dataRoot, {
    ...(fake !== undefined ? { fakeNovelaiUrl: String(fake) } : {}),
    ...(options.locale !== undefined ? { locale: String(options.locale) } : {}),
    ...(options.anlas !== undefined ? { anlas: Number(options.anlas) } : {}),
    noToken, firstRun,
  });

  // Background by default (step 4c1): the window is shown without activating the app or taking the focus; DevTools
  // clicks and screenshots work on it as before. --foreground shows it the ordinary way.
  const foreground = options.foreground === true;
  // A background window runs on the agent copy of Electron (macOS: LSUIElement=1, so its launch never activates it).
  const exe = foreground ? electronExecutable() : backgroundElectronExecutable();
  const folder = devToolsFolder(dataRoot);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const logFile = path.join(folder, 'client.log');
  const log = fs.openSync(logFile, 'a');
  fs.writeSync(log, `\n--- dev-tools start ${new Date().toISOString()} ---\n`);
  const env = clientEnv(process.env, { dataRoot, project: options.project, foreground });
  // --use-mock-keychain: Chromium's OSCrypt uses an in-process fake keychain, so neither the token nor the cookie
  // store of a test client ever touches the login keychain (see lib/settings.mjs).
  // --disable-backgrounding-occluded-windows / --disable-renderer-backgrounding (Chromium test switches): a test window
  // covered by other windows stays "visible", so DevTools input (wheel scrolling in particular) does not stall and
  // timers keep running. --allow-occlusion keeps Chromium's normal behaviour. The data marker goes last.
  const visibility = options['allow-occlusion'] ? [] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'];
  // --agent-start: started as an agent's MCP server starts it (electron/window-show.ts: its window is not shown on macOS).
  const args = [clientDir, '--use-mock-keychain', ...visibility, ...(port ? [`--remote-debugging-port=${port}`] : []), ...(options['agent-start'] === true ? [AGENT_START_SWITCH] : []), `${DATA_MARKER_SWITCH}=${dataRoot}`];
  // The front-app watcher (its own process, 50 ms) runs from before the launch until 5 s after the client is ready.
  const watch = foreground ? null : await startFrontWatch({ dataRoot });
  const watched = async work => {
    let value, failure = null;
    try { value = await work(); } catch (error) { failure = error; }
    const seen = watch ? await watch.stop() : null;
    if (seen?.hits.length) {
      const stopped = await stopClients(dataRoot, { timeoutMs: 20_000, force: true }).catch(error => ({ error: error.message }));
      throw frontDetectedError('test-client start', seen, { pid, stopped, ...(failure ? { alsoFailed: failure.message } : {}) });
    }
    if (failure) throw failure;
    if (seen) value.frontWatch = { supported: seen.supported, hits: 0, samples: seen.samples, maxGapMs: seen.maxGapMs, from: seen.startedAt, to: seen.stoppedAt };
    return value;
  };
  let child;
  try { child = spawn(exe, args, { cwd: clientDir, env, detached: true, stdio: ['ignore', log, log], windowsHide: false }); }
  catch (error) { await watch?.stop(); throw error; }
  fs.closeSync(log);
  const pid = child.pid;
  watch?.addPid(pid);
  const full = await watched(async () => {
    let exitInfo = null;
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; });
    child.unref();
    const started = Date.now();
    writePidFile(dataRoot, { pid, dataRoot, executable: exe, clientDir, worktree: worktreeRoot, port, fakeNovelai: fake ?? null, startedAt: new Date(started).toISOString(), logFile });

    const bridgeFile = dataPaths.dataPathsFor(dataRoot).bridgeFile;
    const ready = await pollUntil(() => exitInfo || !alive(pid) ? 'exited' : fs.existsSync(bridgeFile) ? 'ready' : null, { timeoutMs, intervalMs: 200 });
    if (ready !== 'ready') {
      const detail = { pid, logTail: tail(logFile), ...(exitInfo ? { exit: exitInfo } : {}) };
      if (ready === 'exited') throw new ToolError('client_exited', 'The test client exited before its bridge was ready.', detail);
      throw new ToolError('bridge_timeout', `The bridge did not appear within ${timeoutMs / 1000}s; the client is left running (stop it with: test-client stop --data ${dataRoot}).`, detail);
    }
    const bridgeMs = Date.now() - started;
    const result = { ok: true, pid, dataRoot, port, cdp: port ? `http://127.0.0.1:${port}` : null, background: !foreground, agentStart: options['agent-start'] === true, fakeNovelai: fake ?? null, bridgeReadyMs: bridgeMs, logFile, settings: { endpoint: settings.endpoint, fakeTokenWritten: settings.tokenWritten, noToken: settings.noToken, firstRun: settings.firstRun, ...(fakeHealth ? { fakeNovelaiHealth: fakeHealth } : {}) } };
    if (port) {
      const version = await pollUntil(() => cdpVersion(port), { timeoutMs: 20_000, intervalMs: 200 });
      if (!version) throw new ToolError('cdp_unavailable', `The DevTools endpoint on 127.0.0.1:${port} did not answer.`, { pid });
      const { connectPage } = await import('./lib/cdp.mjs');
      const page = await connectPage({ port, timeoutMs: 20_000 });
      try {
        await page.waitForLoad({ timeoutMs: 30_000 });
        if (size) result.window = await page.setWindowSize(size.width, size.height);
        // Without a pre-written token (no mock keychain outside macOS) the app itself saves the fake token: it verifies
        // it against the fake service and encrypts it with its own safeStorage.
        if (fake !== undefined && !noToken && !canPrewriteToken()) result.settings.fakeTokenVerify = await page.evaluate(`window.naiDesktop.verifyToken(${JSON.stringify(settings.fakeToken)}).then(r => ({ valid: r.valid }))`);
      } finally { page.close(); }
      result.cdpReadyMs = Date.now() - started;
    } else if (size) result.window = { applied: false, reason: '--size needs --port (the window is resized through DevTools).' };
    if (fake !== undefined && !noToken && !canPrewriteToken() && !port) result.settings.note = 'No mock keychain on this platform: pass --port so the fake token can be saved through the app.';

    if (watch) { const until = started + (result.cdpReadyMs ?? result.bridgeReadyMs) + FRONT_WATCH_AFTER_READY_MS; while (Date.now() < until) await sleep(Math.min(200, until - Date.now())); }
    return result;
  });
  return options.quiet === true ? quietStartResult(full) : full;
}

export async function stopClient(options) {
  allowOptions(options, ['data', 'timeout', 'force']);
  if (options.data === undefined || options.data === true) throw new ToolError('refused_no_data', 'stop needs --data <folder>; it stops only the test client of that data root.');
  const { dataRoot } = checkDataRoot(String(options.data));
  const started = Date.now();
  const result = await stopClients(dataRoot, { timeoutMs: Math.max(1, Number(options.timeout ?? 20)) * 1000, force: options.force === true });
  const bridgeFile = dataPaths.dataPathsFor(dataRoot).bridgeFile;
  return { ok: result.stillRunning.length === 0, dataRoot, ...result, bridgeFileLeft: fs.existsSync(bridgeFile), elapsedMs: Date.now() - started };
}

export function clientStatus(options) {
  allowOptions(options, ['data']);
  const dataRoot = options.data !== undefined ? checkDataRoot(String(options.data)).dataRoot : undefined;
  const clients = findTestClients(dataRoot ? { dataRoot } : {}).map(row => ({
    pid: row.pid, dataRoot: row.dataRoot, port: row.port,
    bridgeFile: fs.existsSync(dataPaths.dataPathsFor(row.dataRoot).bridgeFile),
    pidFile: readPidFile(row.dataRoot)?.pid === row.pid,
  }));
  const recorded = dataRoot ? readPidFile(dataRoot) : null;
  return { ok: true, executable: electronExecutable(), clients, ...(dataRoot ? { dataRoot, running: clients.length > 0, pidFile: recorded ? { pid: recorded.pid, alive: alive(recorded.pid), ours: isOurClient(recorded.pid, dataRoot) } : null } : {}) };
}

async function main(argv) {
  if (helpRequested(argv)) return printUsage(import.meta.url);
  const { positional, options } = parseArgs(argv, { booleans: ['build', 'adopt', 'force', 'allow-occlusion', 'quiet', 'no-token', 'first-run', 'foreground', 'agent-start'] });
  const [command] = positional;
  if (command === 'start') return startClient(options);
  if (command === 'stop') return stopClient(options);
  if (command === 'status') return clientStatus(options);
  throw new ToolError('usage', 'Usage: test-client.mjs start --data <dir> [--port <n>|auto] [--fake-novelai <url>] [--locale zh-CN|en-US] [--size WxH] [--build] [--quiet] [--no-token] [--first-run] [--foreground] [--agent-start] | stop --data <dir> [--force] | status [--data <dir>] (test-client.mjs --help)');
}

if (isMain(import.meta.url)) await runCli(main);
export { buildOutputs, sleep };
