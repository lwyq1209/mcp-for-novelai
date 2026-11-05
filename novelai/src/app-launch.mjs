/**
 * Which app this MCP server belongs to, and how to start it in the background (src/app-autostart.mjs decides when).
 *
 * The server starts only the app it belongs to, and only when that is certain:
 * - packaged: it runs with the app's own executable as Node (ELECTRON_RUN_AS_NODE=1) from that app's
 *   resources/mcp/novelai-mcp.mjs (macOS: <App>.app/Contents/Resources/mcp/, with the executable in Contents/MacOS/);
 * - from source: it runs with a development Electron (node_modules/electron) from <client>/dist-mcp/novelai-mcp.mjs
 *   of a built client (dist-electron/electron/bootstrap.js), which is then started as `electron <client>`.
 * Anything else (system Node running novelai/src/mcp.mjs, a bundle copied elsewhere) is not guessed: no start.
 *
 * Every start carries STARTED_BY_AGENT_ARG, so the app shows its first window without taking the focus
 * (electron/window-show.ts) and never comes to the front for a second launch. How it starts:
 * - macOS: LaunchServices, in the background and as a new instance of exactly that bundle:
 *   `open -n -g -a <App.app> [--env NOVELAI_DATA_DIR=…] --args … --started-by-agent`. The app gets the user session's
 *   environment plus NOVELAI_DATA_DIR (when the server has it), like an app opened from the Finder, and is not a
 *   child of this server. An `open` without --env is refused when a data folder must be passed.
 * - Windows: Win32_Process.Create (src/win32-process.mjs), outside the agent's process tree and job objects, with the
 *   startup show state SW_SHOWNOACTIVATE (the same as the app's own first show: it then minimizes its window into the
 *   taskbar without activating it, electron/window-show.ts); when WMI fails definitely, a detached spawn instead
 *   (logged: closing the agent's terminal may then close the app too).
 * - Linux: a detached spawn (own session, no stdio, unref'd).
 * On Windows and Linux the app gets this server's environment without ELECTRON_RUN_AS_NODE, the development and test
 * switches and the calling agent's session markers; NOVELAI_DATA_DIR names the server's own data folder (resolved like
 * data-paths.cjs does, so a relative value means the same folder), or stays absent.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR_ENV } from './data-paths.mjs';
import { SW_SHOWNOACTIVATE, createOutsideJobAsync, powershellPath, windowsCommandLine } from './win32-process.mjs';

/** The switch that tells the app an agent started it (electron/window-show.ts reads it). `=<client>` names the agent. */
export const STARTED_BY_AGENT_ARG = '--started-by-agent';

/** The switch with the calling client's name (URI-encoded, so the argument has no spaces or quotes), or the bare switch. */
export function startedByAgentArgument(client) {
  const name = typeof client?.name === 'string' && client.name.trim() && client.name.length <= 100 && !/[\x00-\x1f\x7f-\x9f]/.test(client.name) ? client.name.trim() : null;
  return name ? `${STARTED_BY_AGENT_ARG}=${encodeURIComponent(name)}` : STARTED_BY_AGENT_ARG;
}

const pathFor = platform => platform === 'win32' ? path.win32 : path.posix;

/**
 * The app this server belongs to: {ok: true, kind: 'packaged'|'source', platform, executable, args, macApp?} or
 * {ok: false, reason} ('not_electron': not run with an app's executable; 'unknown_location': the server file is not
 * where an app ships it or a built client keeps it). Pure: `exists` and the facts are injectable.
 */
export function resolveOwnApp({ moduleFile = fileURLToPath(import.meta.url), execPath = process.execPath, versions = process.versions, platform = process.platform, exists = existsSync } = {}) {
  if (!versions?.electron) return { ok: false, reason: 'not_electron' };
  const p = pathFor(platform);
  const file = p.resolve(moduleFile), dir = p.dirname(file), exe = p.resolve(execPath);
  // Packaged: <resources>/mcp/novelai-mcp.mjs next to the executable that runs it.
  if (p.basename(dir) === 'mcp') {
    const resources = p.dirname(dir);
    if (platform === 'darwin' && p.basename(resources) === 'Resources' && p.basename(p.dirname(resources)) === 'Contents') {
      const macApp = p.dirname(p.dirname(resources));
      if (macApp.endsWith('.app') && p.dirname(exe) === p.join(macApp, 'Contents', 'MacOS') && exists(exe)) return { ok: true, kind: 'packaged', platform, executable: exe, args: [], macApp };
    }
    if (platform !== 'darwin' && p.basename(resources) === 'resources' && p.dirname(exe) === p.dirname(resources) && exists(exe)) return { ok: true, kind: 'packaged', platform, executable: exe, args: [] };
    return { ok: false, reason: 'unknown_location' };
  }
  // From source: <client>/dist-mcp/novelai-mcp.mjs of a built client, run by a development Electron.
  if (p.basename(dir) === 'dist-mcp') {
    const client = p.dirname(dir);
    const built = exists(p.join(client, 'package.json')) && exists(p.join(client, 'dist-electron', 'electron', 'bootstrap.js'));
    const electronName = platform === 'win32' ? 'electron.exe' : platform === 'darwin' ? 'Electron' : 'electron';
    const devElectron = p.basename(exe).toLowerCase() === electronName.toLowerCase() && exists(exe);
    if (!built || !devElectron) return { ok: false, reason: 'unknown_location' };
    if (platform === 'darwin') {
      const at = exe.lastIndexOf('.app/Contents/MacOS/');
      if (at < 0) return { ok: false, reason: 'unknown_location' };
      return { ok: true, kind: 'source', platform, executable: exe, args: [client], macApp: exe.slice(0, at + 4) };
    }
    return { ok: true, kind: 'source', platform, executable: exe, args: [client] };
  }
  return { ok: false, reason: 'unknown_location' };
}

/** Variables that would make the started app something else than a normal start (development, UI capture, test
 * windows, Node mode) or that belong to the calling agent's session. */
const DROPPED = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|VITE_DEV_SERVER_URL|NAI_UI_CAPTURE_PATH|NAI_DEV_TOOLS_BACKGROUND|NOVELAI_INPAINT_DIAGNOSTICS|NOVELAI_MCP_AUTOSTART|NODE_OPTIONS|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|MSYSTEM)$/i;

/** The environment of the started app (Windows and Linux): this server's, without DROPPED, one entry per name (Windows
 * names are case-insensitive). NOVELAI_DATA_DIR is kept exactly as it is, or stays absent. */
export function appEnvironment(env = process.env, platform = process.platform) {
  const kept = {}, seen = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || DROPPED.test(key)) continue;
    const id = platform === 'win32' ? key.toUpperCase() : key;
    if (seen.has(id)) continue;
    seen.add(id); kept[key] = value;
  }
  return kept;
}

let openEnvSupport = null;
/** Whether this macOS `open` takes --env (its usage text lists it). Asked once per process (an injected `run`, in
 * tests, is asked every time). */
export function openSupportsEnv({ run = spawnSync } = {}) {
  if (run === spawnSync && openEnvSupport !== null) return openEnvSupport;
  const usage = run('/usr/bin/open', [], { encoding: 'utf8', timeout: 5000 });
  const supported = /--env\b/.test(`${usage.stdout ?? ''}${usage.stderr ?? ''}`);
  if (run === spawnSync) openEnvSupport = supported;
  return supported;
}

/** The `open` arguments for a macOS app (exported for tests). */
export function macOpenArguments(app, { dataDir, agentArgument }) {
  return ['-n', '-g', '-a', app.macApp, ...(dataDir ? ['--env', `${DATA_DIR_ENV}=${dataDir}`] : []), '--args', ...app.args, agentArgument];
}

const nonBlank = value => typeof value === 'string' && value.trim() ? value : null;

/**
 * Starts `app` (from resolveOwnApp) once. Resolves {ok: true, via, pid?} when the start was handed over (the app may
 * still fail later; the caller waits for its bridge), or {ok: false, reason} when it certainly did not start.
 */
export async function launchApp(app, { client = null, env = process.env, spawnImpl = spawn, runSync = spawnSync, outsideJob = createOutsideJobAsync, log = () => {}, exists = existsSync } = {}) {
  const agentArgument = startedByAgentArgument(client);
  // The data folder this server uses (as data-paths.cjs resolves it), so a relative value names the same folder for
  // the app, which starts in another working directory.
  const dataDir = nonBlank(env[DATA_DIR_ENV]) ? pathFor(app.platform).resolve(env[DATA_DIR_ENV].trim()) : null;
  if (app.platform === 'darwin') {
    if (dataDir && !openSupportsEnv({ run: runSync })) return { ok: false, reason: 'This macOS `open` cannot pass the data folder (no --env option); the app was not started.' };
    const args = macOpenArguments(app, { dataDir, agentArgument });
    // `open` itself gets no Node-mode switch; the app gets the session environment plus --env.
    const openEnv = appEnvironment(env, 'darwin');
    return await new Promise(resolve => {
      let stderr = '', done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      let child;
      try { child = spawnImpl('/usr/bin/open', args, { env: openEnv, stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (error) { finish({ ok: false, reason: `open could not run (${error?.message ?? error})` }); return; }
      // LaunchServices answers quickly; past this the start may still be under way, so it counts as handed over.
      const timer = setTimeout(() => finish({ ok: true, via: 'open', unconfirmed: true }), 15_000);
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2000); });
      child.once('error', error => finish({ ok: false, reason: `open could not run (${error?.message ?? error})` }));
      child.once('close', code => finish(code === 0 ? { ok: true, via: 'open' } : { ok: false, reason: `open exited ${code}${stderr.trim() ? `: ${stderr.trim().split('\n')[0]}` : ''}` }));
    });
  }
  const childEnv = appEnvironment(env, app.platform);
  if (dataDir) for (const key of Object.keys(childEnv)) if (key === DATA_DIR_ENV || (app.platform === 'win32' && key.toUpperCase() === DATA_DIR_ENV)) childEnv[key] = dataDir;
  const cwd = pathFor(app.platform).dirname(app.executable);
  const args = [...app.args, agentArgument];
  if (app.platform === 'win32') {
    const created = await outsideJob({ commandLine: windowsCommandLine(app.executable, args), cwd, env: childEnv, showWindow: SW_SHOWNOACTIVATE }, { powershell: powershellPath(env, exists) });
    if (created.pid) return { ok: true, via: 'wmi', pid: created.pid };
    // The WMI answer was lost but the app may be starting: never start a second one blindly.
    if (created.ambiguous) return { ok: true, via: 'wmi', unconfirmed: true };
    log(`[novelai-mcp] could not start the app outside the agent's process tree (${created.reason}); starting it as a detached child instead. Closing the agent's terminal may close the app too.`);
  }
  return await new Promise(resolve => {
    let child;
    try { child = spawnImpl(app.executable, args, { cwd, env: childEnv, detached: true, stdio: 'ignore', windowsHide: false }); }
    catch (error) { resolve({ ok: false, reason: `the app could not be started (${error?.message ?? error})` }); return; }
    child.once('error', error => resolve({ ok: false, reason: `the app could not be started (${error?.message ?? error})` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, via: 'spawn', pid: child.pid }); });
  });
}

/** The real launcher: {resolve(), launch(app, {client})}. */
export function createAppLauncher(options = {}) {
  return {
    resolve: () => resolveOwnApp(options),
    launch: (app, { client } = {}) => launchApp(app, { ...options, client }),
  };
}
