// win32-only launcher helpers for start-client.mjs. POSIX never calls these.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { format } from 'node:util';

export const EXIT_REFUSED = 3;
export const EXIT_PENDING = 5;

const INSTALL_HINT = 'Install Electron once: in novelai\\client run `node node_modules/electron/install.js` with electron_config_cache=<repo>\\novelai\\.runtime\\electron-cache (see docs/building.md). The launcher never downloads on start.';

/**
 * npm on Windows is npm.cmd: spawn('npm') is ENOENT and spawn('npm.cmd') is
 * EINVAL without a shell. Run npm-cli.js with this Node instead (no shell).
 */
export function resolveNpmCli({ env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [];
  if (typeof env.npm_execpath === 'string' && /(^|[\\/])npm-cli\.js$/i.test(env.npm_execpath)) candidates.push(env.npm_execpath);
  candidates.push(path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const found = candidates.find(candidate => exists(candidate));
  if (!found) throw new Error(`Cannot find npm-cli.js for this Node (${execPath}); checked npm_execpath and <node dir>\\node_modules\\npm\\bin\\npm-cli.js. Reinstall Node.js with npm, or build manually with \`npm --prefix novelai/client run build\` and start with --no-build.`);
  return found;
}

export function npmBuildCommand(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  return { command: execPath, parameters: [resolveNpmCli({ ...options, execPath }), 'run', 'build'] };
}

/** Electron's lazy installer writes path.txt and dist/<binary>; fail clearly when either is missing. */
export function electronBinary(client, { read = file => readFileSync(file, 'utf8'), exists = existsSync } = {}) {
  const pathFile = path.win32.join(client, 'node_modules', 'electron', 'path.txt');
  let name;
  try { name = read(pathFile).trim(); }
  catch (error) { if (error?.code === 'ENOENT') throw new Error(`Electron is not installed: ${pathFile} is missing. ${INSTALL_HINT}`); throw error; }
  const binary = path.win32.join(client, 'node_modules', 'electron', 'dist', name);
  if (!name || !exists(binary)) throw new Error(`Electron binary is missing: ${binary}. ${INSTALL_HINT}`);
  return binary;
}

/** One named pipe per data folder (the client's data root, case-insensitive) serves as the launcher lock. */
export function launcherPipeName(dataRoot) {
  const id = createHash('sha256').update(path.win32.resolve(dataRoot).toLowerCase()).digest('hex').slice(0, 32);
  return `\\\\.\\pipe\\mcp-for-novelai-launcher-${id}`;
}

/**
 * Hold the data folder's launcher lock for the rest of this process (build and host).
 * Resolves the listening server, or null when another launcher already holds it.
 * The OS releases the pipe when the process exits, including on a crash or hard kill.
 */
export function acquireLauncherLock(dataRoot) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', error => (error?.code === 'EADDRINUSE' ? resolve(null) : reject(error)));
    server.listen(launcherPipeName(dataRoot), () => {
      // Once held, a later pipe error must not crash the launcher (which would hard-kill the host).
      server.on('error', error => console.error(`[launcher] lock pipe error ignored: ${error?.message ?? error}`));
      server.unref(); resolve(server);
    });
  });
}

/** True while some launcher holds the data folder's lock (a connect probe; it never takes the lock). */
export function probeLauncherLock(dataRoot) {
  return new Promise(resolve => {
    const socket = net.connect(launcherPipeName(dataRoot));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

/**
 * PID of the client host running on this data folder, from the bridge.json it publishes in
 * <data root>\runtime (and removes when it quits): [pid] while that process is alive, [] when
 * there is no bridge.json or its process is gone. Any client using this data folder counts,
 * whichever checkout or installation started it. Fails closed: an unreadable or invalid
 * bridge.json throws.
 */
export function findRunningHost(dataRoot, { read = file => readFileSync(file, 'utf8'), alive = processAlive } = {}) {
  const file = path.win32.join(dataRoot, 'runtime', 'bridge.json');
  let text;
  try { text = read(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error(`Cannot check whether MCP for NovelAI is already running (${error?.message ?? error}); not starting.`);
  }
  let pid;
  try { pid = JSON.parse(text)?.pid; } catch { pid = undefined; }
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error(`Cannot check whether MCP for NovelAI is already running: ${file} is not a valid client connection file; not starting. If no client is running on this data folder, delete that file.`);
  return alive(pid) ? [pid] : [];
}

function localStamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function sourceRevision(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'describe', '--always', '--dirty', '--abbrev=7'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  const rev = String(result.stdout ?? '').trim();
  return result.status === 0 && /^[\w.-]+$/.test(rev) ? rev : 'nogit';
}

/**
 * In the background launcher (NOVELAI_LAUNCH_DETACHED=1) there is no usable console: route
 * console output, uncaught errors and the final exit code into NOVELAI_LAUNCH_LOG, which must
 * be a .log file directly inside <novelai>\.tmp\client-launch. Returns the log fd.
 */
export function attachDetachedLog(novelaiRoot, env = process.env) {
  const dir = path.win32.join(novelaiRoot, '.tmp', 'client-launch');
  const log = path.win32.resolve(String(env.NOVELAI_LAUNCH_LOG ?? ''));
  if (path.win32.dirname(log).toLowerCase() !== dir.toLowerCase() || !/\.log$/i.test(log) || /launcher-status\.log$/i.test(log)) {
    process.stderr.write(`NOVELAI_LAUNCH_LOG must be a .log file in ${dir}\n`);
    process.exit(2);
  }
  const fd = openSync(log, 'a');
  const write = (...parts) => { try { writeSync(fd, `${format(...parts)}\n`); } catch {} };
  console.log = console.info = console.warn = console.error = write;
  // Direct stream writes (Node warnings, libraries) would otherwise land in the hidden console.
  for (const stream of [process.stdout, process.stderr]) stream.write = (chunk, encoding, callback) => {
    try { writeSync(fd, typeof chunk === 'string' ? chunk : Buffer.from(chunk)); } catch {}
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') queueMicrotask(() => done());
    return true;
  };
  process.on('uncaughtException', error => { write(error?.stack ?? String(error)); process.exit(1); });
  process.on('unhandledRejection', error => { write(error?.stack ?? String(error)); process.exit(1); });
  process.on('exit', code => write(`[launcher-exit ${code}]`));
  return fd;
}

// Win32_Process.Create starts the launcher from the WMI host, outside the caller's process
// tree and job objects (some terminals and agent hosts kill their whole job when a tab closes).
const WMI_CREATE = [
  "$ErrorActionPreference = 'Stop'",
  '$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
  '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$j.env }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$j.commandLine; CurrentDirectory = [string]$j.cwd; ProcessStartupInformation = $startup }',
  "[Console]::Out.Write('wmi:' + $r.ReturnValue + ':' + $r.ProcessId)",
].join('; ');

export function createOutsideJob({ commandLine, cwd, env }, { run = spawnSync } = {}) {
  const payload = Buffer.from(JSON.stringify({ commandLine, cwd, env: Object.entries(env).map(([k, v]) => `${k}=${v}`) }), 'utf8').toString('base64');
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WMI_CREATE],
    { input: payload, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const match = /wmi:(\d+):(\d+)$/.exec(String(result.stdout ?? '').trim());
  if (!result.error && result.status === 0 && match && match[1] === '0' && match[2] !== '0') return { pid: Number(match[2]) };
  // Ambiguous: the query timed out, or PowerShell succeeded without a readable answer; the
  // launcher may have been created anyway. A definite failure never created a process.
  const ambiguous = result.error?.code === 'ETIMEDOUT' || (!result.error && result.status === 0 && !match);
  const reason = result.error?.message ?? (match ? `Win32_Process.Create returned ${match[1]}` : `PowerShell exit ${result.status}${result.stderr ? `: ${String(result.stderr).trim().split(/\r?\n/)[0]}` : ''}`);
  return { pid: null, reason, ambiguous };
}

const quoteArg = value => `"${String(value).replace(/"/g, '\\"')}"`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };
/** The last [launcher-exit N] marker anywhere in the log (output may follow it). */
export function launcherExit(file) {
  try { const all = [...readFileSync(file, 'utf8').matchAll(/\[launcher-exit (\d+)\]/g)]; return all.length ? Number(all.at(-1)[1]) : null; }
  catch { return null; }
}

// Directories an MSYS2 / Git for Windows shell puts in front of PATH, recognised by the
// msys-2.0.dll of their install root (so an unrelated ...\bin is never touched).
const MSYS_SUFFIXES = ['\\usr\\local\\bin', '\\usr\\bin', '\\mingw64\\bin', '\\mingw32\\bin', '\\ucrt64\\bin', '\\clang64\\bin', '\\clangarm64\\bin', '\\bin'];
function msysDirectory(entry, exists) {
  const dir = path.win32.normalize(String(entry).trim().replace(/^"(.*)"$/, '$1')).replace(/\\+$/, '');
  const suffix = MSYS_SUFFIXES.find(value => dir.toLowerCase().endsWith(value));
  return Boolean(suffix) && exists(path.win32.join(dir.slice(0, -suffix.length), 'usr', 'bin', 'msys-2.0.dll'));
}

/**
 * Environment for the long-lived host: one entry per variable name (Windows names are
 * case-insensitive), without the calling agent's or MSYS shell's session markers. When the
 * caller is an MSYS shell (Git Bash: MSYSTEM is set), the directories that shell injected are
 * moved to the end of PATH, so the host resolves system tools (whoami, find, timeout ...) like a
 * double-clicked one; everything else keeps the user's own order.
 */
export function hostEnvironment(env, { exists = existsSync } = {}) {
  const fromMsys = Object.keys(env).some(key => key.toUpperCase() === 'MSYSTEM');
  const kept = {}, seen = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|MSYSTEM)$/i.test(key)) continue;
    if (seen.has(key.toUpperCase())) continue;
    seen.add(key.toUpperCase()); kept[key] = value;
  }
  if (fromMsys) for (const key of Object.keys(kept)) if (key.toUpperCase() === 'PATH') {
    const entries = String(kept[key]).split(';');
    kept[key] = [...entries.filter(entry => !msysDirectory(entry, exists)), ...entries.filter(entry => msysDirectory(entry, exists))].join(';');
  }
  return kept;
}

function logTail(file, lines = 25) {
  try { return readFileSync(file, 'utf8').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd().split(/\r?\n/).slice(-lines).join('\n'); }
  catch { return '(log unreadable)'; }
}

/**
 * `start-client.mjs --detach`: start the ordinary launcher (this same script, without
 * --detach) as a background process without a console window, give it only a log file
 * (never the caller's pipes, so callers that capture output are not held open), then
 * wait until the host is ready (a fresh bridge.json) or the launcher exits.
 * Returns the process exit code: 0 ready, 3 refused, 5 still starting, other = failed.
 */
export async function launchDetached({ novelaiRoot, dataRoot, script, forwarded, env, out = console.log, err = console.error,
  waitMs = Number(process.env.NOVELAI_DETACH_WAIT_MS || 300_000), pollMs = 500 }) {
  const repoRoot = path.win32.dirname(novelaiRoot);
  const runtime = path.win32.join(dataRoot, 'runtime');
  const logDir = path.win32.join(novelaiRoot, '.tmp', 'client-launch');
  mkdirSync(logDir, { recursive: true });
  const status = (result, extra = '') => {
    try { appendFileSync(path.win32.join(logDir, 'launcher-status.log'), `${new Date().toISOString()} ${result}${extra}\n`); } catch {}
  };

  // Early, friendly refusal; the background launcher re-checks under the real lock.
  if (await probeLauncherLock(dataRoot)) {
    err('Another MCP for NovelAI launcher for this data folder is already running (build or host); not starting a second copy.');
    status('refused', ' reason=launcher-lock');
    return EXIT_REFUSED;
  }
  let hosts;
  try { hosts = findRunningHost(dataRoot); }
  catch (error) {
    err(error.message);
    status('failed', ' reason=host-check');
    return 1;
  }
  if (hosts.length) {
    err(`MCP for NovelAI is already running for this data folder (PID ${hosts.join(', ')}); not starting a second copy.`);
    status('refused', ` reason=host pid=${hosts.join(',')}`);
    return EXIT_REFUSED;
  }

  // Launches in the same second get -2, -3 ... instead of failing on an existing name.
  const stem = `${localStamp()}-${sourceRevision(repoRoot)}`;
  let log, fd;
  for (let n = 1; fd === undefined; n++) {
    log = path.win32.join(logDir, n === 1 ? `${stem}.log` : `${stem}-${n}.log`);
    try { fd = openSync(log, 'wx'); } catch (error) { if (error?.code !== 'EEXIST' || n >= 50) throw error; }
  }
  closeSync(fd); // the background launcher appends to it itself (attachDetachedLog)
  const startedAt = Date.now();
  const inherited = Object.entries(env).filter(([key, value]) => key && !key.startsWith('=') && value !== undefined && !/^NOVELAI_LAUNCH_/i.test(key));
  const launchEnv = hostEnvironment(Object.fromEntries([...inherited, ['NOVELAI_LAUNCH_DETACHED', '1'], ['NOVELAI_LAUNCH_LOG', log]]));
  // Prefer WMI so the launcher and host survive the calling terminal/agent tab; plain
  // detached spawn is the fallback (NOVELAI_DETACH_VIA=spawn forces it for diagnosis).
  let pid = null, via = 'wmi', reason = 'NOVELAI_DETACH_VIA=spawn', unknownStart = false;
  if (process.env.NOVELAI_DETACH_VIA !== 'spawn') {
    let ambiguous;
    ({ pid, reason, ambiguous } = createOutsideJob({ commandLine: [process.execPath, script, ...forwarded].map(quoteArg).join(' '), cwd: repoRoot, env: launchEnv }));
    // The WMI answer was lost but a launcher may be starting: never start a second one blindly.
    if (!pid && ambiguous) for (let waited = 0; waited < 15_000 && !unknownStart; waited += pollMs) {
      if (launcherExit(log) !== null || await probeLauncherLock(dataRoot)) unknownStart = true;
      else await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }
  if (!pid && !unknownStart) {
    via = 'spawn';
    err(`Warning: could not start the launcher outside this terminal (${reason}); closing this terminal or agent tab may stop the client.`);
    const child = spawn(process.execPath, [script, ...forwarded], { cwd: repoRoot, env: launchEnv, detached: true, windowsHide: true, stdio: 'ignore' });
    child.once('error', error => { try { appendFileSync(log, `spawn error: ${error.message}\n[launcher-exit 1]\n`); } catch {} });
    child.unref(); pid = child.pid;
  }
  out(`Starting MCP for NovelAI in the background (launcher PID ${pid ?? 'unknown'}).`);
  out(`Log: ${log}`);
  status('started', ` launcherPid=${pid ?? 'unknown'} via=${unknownStart ? 'wmi-unconfirmed' : via} log=${path.win32.basename(log)}`);

  const bridge = path.win32.join(runtime, 'bridge.json');
  const fresh = () => { try { return statSync(bridge).mtimeMs >= startedAt - 1000; } catch { return false; } };
  // Liveness: the exit marker is authoritative; otherwise the launcher lock (held for the whole
  // build + host lifetime) once it has been seen, which also survives PID reuse after a hard
  // kill; before that, the PID (or, with an unknown PID, a short grace period).
  let seenLock = false;
  for (let waited = 0; waited <= waitMs; waited += pollMs) {
    const code = launcherExit(log);
    const locked = code === null ? await probeLauncherLock(dataRoot) : false;
    if (locked) seenLock = true;
    const gone = code !== null || (seenLock ? !locked : pid ? !alive(pid) : waited >= 15_000);
    if (gone) {
      const refused = code === EXIT_REFUSED;
      err(refused ? 'The launcher refused to start (already running). Log:'
        : code === 0 ? 'The launcher finished normally before the host became ready (the client window was probably closed right away). Last log lines:'
          : code === null ? 'The launcher disappeared before the host was ready (no exit code recorded: killed, or it failed before logging started - run `node novelai/scripts/start-client.mjs` in a terminal to see such errors). Last log lines:'
            : `The launcher exited (${code}) before the host was ready. Last log lines:`);
      err(logTail(log));
      status(refused ? 'refused' : 'failed', ` launcherPid=${pid ?? 'unknown'} exit=${code ?? 'unknown'}`);
      return refused ? EXIT_REFUSED : (code ? code : 1);
    }
    if (fresh()) {
      out('MCP for NovelAI is ready (bridge is up). Stop it by closing the client window.');
      status('ready', ` launcherPid=${pid ?? 'unknown'} afterMs=${Date.now() - startedAt}`);
      return 0;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  out(`Still starting after ${Math.round(waitMs / 1000)} s; the launcher (PID ${pid ?? 'unknown'}) keeps running. Check the log before trying again.`);
  status('pending', ` launcherPid=${pid ?? 'unknown'}`);
  return EXIT_PENDING;
}
