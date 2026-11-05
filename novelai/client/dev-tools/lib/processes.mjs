// Finds the test clients THIS checkout started, by exact executable path plus the data-root marker argument, and
// stops only those. Never uses pkill/killall or name patterns; a PID is signalled only after its command line is
// read again and still matches.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cli.mjs';
import { devToolsFolder } from './paths.mjs';
import { clientExecutables } from './background-app.mjs';

/** The argument that ties an Electron main process to its test data root (Chromium ignores unknown switches). */
export const DATA_MARKER_SWITCH = '--nai-dev-tools-data';
export const PID_FILE = 'client.json';

/** [{pid, command}] of every process the current user can see. */
export function listProcesses() {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).filter(row => row && row.CommandLine).map(row => ({ pid: Number(row.ProcessId), command: String(row.CommandLine) }));
  }
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(match => ({ pid: Number(match[1]), command: match[2] }));
}

/** The command line of one PID, or null when it is gone. */
export function commandOf(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') return listProcesses().find(row => row.pid === pid)?.command ?? null;
  try { return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

const normalize = value => process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;

/**
 * Whether a command line is the Electron MAIN process of this checkout (not a helper), and the test data root its
 * marker names (null without a marker). `exe` is injectable for tests.
 */
export function parseClientCommand(command, exe = clientExecutables()) {
  const text = normalize(command);
  let rest;
  // Any of the executables (the plain Electron, or its macOS agent copy that background windows run on).
  for (const candidate of Array.isArray(exe) ? exe : [exe]) {
    const executable = normalize(candidate), quoted = `"${executable}"`;
    if (text.startsWith(`${executable} `)) { rest = command.slice(executable.length + 1); break; }
    if (text.startsWith(`${quoted} `)) { rest = command.slice(quoted.length + 1); break; }
  }
  if (rest === undefined) return null;
  if (/(^|\s)--type=/.test(rest)) return null; // Chromium helper processes
  // Windows quotes the whole argument ("--x=C:\a b"); POSIX ps shows it bare (the marker is the last argument).
  const marker = new RegExp(`"${DATA_MARKER_SWITCH}=([^"]*)"`).exec(rest) ?? new RegExp(`(?:^|\\s)${DATA_MARKER_SWITCH}=(.*?)(?=\\s--|$)`).exec(rest);
  const port = /--remote-debugging-port=(\d+)/.exec(rest);
  return { dataRoot: marker ? marker[1] : null, port: port ? Number(port[1]) : null };
}

const sameData = (left, right) => left && right && normalize(path.resolve(left)) === normalize(path.resolve(right));

/** Test clients of this checkout: [{pid, dataRoot, port, command}] (only main processes started with the marker). */
export function findTestClients({ dataRoot } = {}) {
  const exe = clientExecutables();
  return listProcesses().flatMap(row => {
    const parsed = parseClientCommand(row.command, exe);
    if (!parsed || !parsed.dataRoot) return [];
    if (dataRoot && !sameData(parsed.dataRoot, dataRoot)) return [];
    return [{ pid: row.pid, dataRoot: parsed.dataRoot, port: parsed.port, command: row.command }];
  });
}

/** [{pid, command}] with each process's environment after its command line where the platform shows it (macOS ps -E;
 * elsewhere the plain list). */
export function listProcessesWithEnvironment() {
  if (process.platform !== 'darwin') return listProcesses();
  const out = execFileSync('ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return out.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(match => ({ pid: Number(match[1]), command: match[2] }));
}

/** `text` holds `token` followed by the end or a space (so /x/data never matches /x/data2). */
const holdsToken = (text, token) => { let at = text.indexOf(token); while (at >= 0) { const next = text[at + token.length]; if (next === undefined || next === ' ' || next === '"') return true; at = text.indexOf(token, at + 1); } return false; };

/**
 * Every app process that uses one data root (review rework, 2026-11): a main process with this data root's marker, any
 * Chromium helper or Electron whose profile is it (--user-data-dir=<root>, which the app sets to its data root), and an
 * app process of this checkout's Electron started with NOVELAI_DATA_DIR=<root> (seen in its environment on macOS).
 * Processes run as Node (ELECTRON_RUN_AS_NODE=1, such as the MCP server of that data root) hold no window or profile and
 * are not counted. `rows` is injectable for tests.
 */
export function findDataRootProcesses(dataRoot, rows = listProcessesWithEnvironment(), exe = clientExecutables()) {
  const root = path.resolve(dataRoot), apps = (Array.isArray(exe) ? exe : [exe]).map(value => value.includes('.app/') ? value.slice(0, value.indexOf('.app/') + 5) : path.dirname(value));
  return rows.flatMap(row => {
    if (row.pid === process.pid) return [];
    const text = row.command;
    const marker = holdsToken(text, `${DATA_MARKER_SWITCH}=${root}`), profile = holdsToken(text, `--user-data-dir=${root}`);
    const environment = holdsToken(text, `NOVELAI_DATA_DIR=${root}`) && apps.some(app => text.startsWith(app)) && !holdsToken(text, 'ELECTRON_RUN_AS_NODE=1');
    if (!marker && !profile && !environment) return [];
    return [{ pid: row.pid, kind: /(^|\s)--type=/.test(text) ? 'helper' : 'main', via: marker ? 'marker' : profile ? 'profile' : 'environment', command: text.slice(0, 240) }];
  });
}

/** Whether `pid` is still the test client of `dataRoot` (its command line is read again right now). */
export function isOurClient(pid, dataRoot) {
  const command = commandOf(pid);
  const parsed = command ? parseClientCommand(command) : null;
  return Boolean(parsed && sameData(parsed.dataRoot, dataRoot));
}

export const pidFilePath = dataRoot => path.join(devToolsFolder(dataRoot), PID_FILE);
export function readPidFile(dataRoot) {
  try { return JSON.parse(fs.readFileSync(pidFilePath(dataRoot), 'utf8')); } catch { return null; }
}
export function writePidFile(dataRoot, value) {
  fs.mkdirSync(devToolsFolder(dataRoot), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFilePath(dataRoot), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}

/** Sends the polite stop request to one verified PID: SIGTERM, or taskkill without /F on Windows. */
function requestStop(pid) {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  else process.kill(pid, 'SIGTERM');
}

/**
 * Stops the test client(s) of one data root: each PID is re-verified (exact executable + marker of this data root)
 * right before it is signalled; then waits for it to exit. `force` sends SIGKILL to a verified PID that did not exit.
 */
export async function stopClients(dataRoot, { timeoutMs = 20_000, force = false } = {}) {
  const candidates = new Set(findTestClients({ dataRoot }).map(row => row.pid));
  const recorded = readPidFile(dataRoot);
  if (recorded?.pid) candidates.add(recorded.pid);
  const result = { stopped: [], skipped: [], stillRunning: [], forced: [] };
  for (const pid of candidates) {
    if (!isOurClient(pid, dataRoot)) { result.skipped.push({ pid, reason: alive(pid) ? 'not this data root\'s test client (left alone)' : 'not running' }); continue; }
    requestStop(pid);
    const started = Date.now();
    while (alive(pid) && Date.now() - started < timeoutMs) await sleep(150);
    if (!alive(pid)) { result.stopped.push({ pid, ms: Date.now() - started }); continue; }
    if (force && isOurClient(pid, dataRoot)) {
      process.kill(pid, 'SIGKILL');
      await sleep(500);
      (alive(pid) ? result.stillRunning : result.forced).push({ pid });
    } else result.stillRunning.push({ pid });
  }
  return result;
}
