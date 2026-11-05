// win32: `start-client.mjs --detach`, the per-data-folder launcher lock, the running-host check and
// the start-client.cmd wrapper, end to end with real processes in a throwaway tree. The
// "Electron" binary is a copy of this Node, running a fake host that writes bridge.json; the
// build is a tiny npm script. Every launch runs on a throwaway data folder (NOVELAI_DATA_DIR), so
// no real client, data folder, profile or network is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOutsideJob, findRunningHost, hostEnvironment, launcherExit } from '../scripts/win32-launch.mjs';

const win32 = process.platform === 'win32';
const skip = !win32 && 'win32 only';
const scripts = new URL('../scripts/', import.meta.url);

const FAKE_HOST = `// Fake Electron host: publish bridge.json like the real bridge, then stay up.
const fs = require('node:fs'), path = require('node:path');
const runtime = path.join(process.env.NOVELAI_DATA_DIR, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
const file = path.join(runtime, 'bridge.json'), tmp = file + '.' + process.pid + '.tmp';
fs.writeFileSync(tmp, JSON.stringify({ fake: true, pid: process.pid }));
fs.renameSync(tmp, file);
console.log('fake host up', process.pid, 'CLAUDECODE=' + (process.env.CLAUDECODE ?? '<unset>'));
setTimeout(() => process.exit(0), Number(process.env.FAKE_HOST_MS || 60000));
`;
const FAKE_BUILD = `// Fake build: optional delay and exit code from the environment.
console.log('fake build');
setTimeout(() => process.exit(Number(process.env.FAKE_BUILD_EXIT || 0)), Number(process.env.FAKE_BUILD_MS || 0));
`;

function makeTree(t, name = 'Launcher Tree') {
  const base = mkdtempSync(join(tmpdir(), 'nai detach ')); // a space on purpose
  // Registered before anything below can throw; stops the tree's processes (once known) before removing it.
  let real = null;
  t.after(() => { if (real) stopAll(real); rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  const tree = join(base, name), novelai = join(tree, 'novelai'), client = join(novelai, 'client'), electron = join(client, 'node_modules', 'electron');
  mkdirSync(join(novelai, 'scripts'), { recursive: true }); mkdirSync(join(electron, 'dist'), { recursive: true });
  for (const file of ['start-client.mjs', 'win32-launch.mjs', 'start-client.cmd']) copyFileSync(new URL(file, scripts), join(novelai, 'scripts', file));
  // start-client.mjs resolves its data root with the shared module.
  mkdirSync(join(novelai, 'src'), { recursive: true }); mkdirSync(join(client, 'shared', 'runtime'), { recursive: true });
  copyFileSync(new URL('../src/data-paths.mjs', import.meta.url), join(novelai, 'src', 'data-paths.mjs'));
  // win32-launch.mjs starts the launcher with the shared WMI helper.
  copyFileSync(new URL('../src/win32-process.mjs', import.meta.url), join(novelai, 'src', 'win32-process.mjs'));
  copyFileSync(new URL('../client/shared/runtime/data-paths.cjs', import.meta.url), join(client, 'shared', 'runtime', 'data-paths.cjs'));
  const dataDir = join(base, 'Data');
  writeFileSync(join(electron, 'path.txt'), 'electron.exe');
  copyFileSync(process.execPath, join(electron, 'dist', 'electron.exe'));
  writeFileSync(join(client, 'package.json'), JSON.stringify({ name: 'fake-client', private: true, scripts: { build: 'node build.js' } }));
  writeFileSync(join(client, 'build.js'), FAKE_BUILD);
  writeFileSync(join(client, 'index.js'), FAKE_HOST);
  real = realpathSync.native(novelai);
  return { base, tree, novelai: real, dataDir, script: join(real, 'scripts', 'start-client.mjs'), cmd: join(real, 'scripts', 'start-client.cmd') };
}

// Stop every process whose command line mentions this tree (fake hosts first, then launchers).
function stopAll(novelai) {
  const ps = `$root = $env:TREE_ROOT; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | Sort-Object { if ($_.Name -eq 'electron.exe') { 0 } else { 1 } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, TREE_ROOT: novelai }, windowsHide: true });
}

function runSync(f, args, env = {}, timeout = 120_000) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [f.script, ...args], { env: { ...process.env, NOVELAI_DATA_DIR: f.dataDir, ...env }, encoding: 'utf8', timeout, windowsHide: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, ms: Date.now() - started, error: result.error };
}

function runAsync(f, args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [f.script, ...args], { env: { ...process.env, NOVELAI_DATA_DIR: f.dataDir, ...env }, windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}

const statusLines = novelai => readFileSync(join(novelai, '.tmp', 'client-launch', 'launcher-status.log'), 'utf8').trim().split('\n');

test('win32 --detach: returns ready while the host keeps running, without holding the caller\'s pipes', { skip, timeout: 120_000 }, t => {
  const f = makeTree(t);
  const result = runSync(f, ['--detach', '--no-build'], { FAKE_HOST_MS: '60000', CLAUDECODE: '1', CLAUDE_CODE_TEST_MARKER: 'x' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stdout, /ready \(bridge is up\)/);
  assert.ok(result.ms < 30_000, `returned after ${result.ms} ms`);
  const hosts = findRunningHost(f.dataDir);
  assert.equal(hosts.length, 1, 'the fake host outlives the --detach call');
  const logs = readdirSync(join(f.novelai, '.tmp', 'client-launch')).filter(name => name.endsWith('.log') && name !== 'launcher-status.log');
  assert.equal(logs.length, 1); assert.match(logs[0], /^\d{8}-\d{6}-[\w.-]+\.log$/);
  // The fake host prints right after publishing bridge.json; give that line a moment to land.
  const logFile = join(f.novelai, '.tmp', 'client-launch', logs[0]);
  let text = '';
  for (let i = 0; i < 50 && !/fake host up/.test(text); i++) { text = readFileSync(logFile, 'utf8'); if (!/fake host up/.test(text)) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']); }
  assert.match(text, /fake host up .*CLAUDECODE=<unset>/);
  const lines = statusLines(f.novelai);
  assert.match(lines[0], / started launcherPid=\d+ via=wmi log=/); assert.match(lines[1], / ready launcherPid=\d+/);
});

test('win32: a second launch is refused while the host runs, both detached and direct', { skip, timeout: 120_000 }, t => {
  const f = makeTree(t, 'Tree [2]'); // brackets are not wildcards for the host check
  assert.equal(runSync(f, ['--detach', '--no-build']).status, 0);
  const again = runSync(f, ['--detach', '--no-build']);
  assert.equal(again.status, 3, again.stderr); assert.match(again.stderr, /already running/);
  const direct = runSync(f, ['--no-build']);
  assert.equal(direct.status, 3, direct.stderr); assert.match(direct.stderr, /already running/);
  assert.equal(findRunningHost(f.dataDir).length, 1);
  assert.match(statusLines(f.novelai).at(-1), / refused reason=(launcher-lock|host)/);
});

test('win32: two near-simultaneous --detach launches start exactly one launcher and one host', { skip, timeout: 120_000 }, async t => {
  const f = makeTree(t);
  const env = { FAKE_BUILD_MS: '3000' }; // a slow build widens the old check-then-start window
  const [a, b] = await Promise.all([runAsync(f, ['--detach'], env), runAsync(f, ['--detach'], env)]);
  assert.deepEqual([a.status, b.status].sort(), [0, 3], `a=${a.status} ${a.stderr} | b=${b.status} ${b.stderr}`);
  assert.equal(findRunningHost(f.dataDir).length, 1);
});

test('win32 --detach: a failed build reports the log tail and starts no host', { skip, timeout: 120_000 }, t => {
  const f = makeTree(t);
  const result = runSync(f, ['--detach'], { FAKE_BUILD_EXIT: '1' });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.match(result.stderr, /exited \(1\) before the host was ready/); assert.match(result.stderr, /Client exited 1/);
  assert.deepEqual(findRunningHost(f.dataDir), []);
  assert.match(statusLines(f.novelai).at(-1), / failed launcherPid=\d+ exit=1/);
});

test('findRunningHost reads the data folder\'s bridge.json and fails closed when it cannot', () => {
  const dataRoot = String.raw`C:\Users\u\AppData\Roaming\mcp-for-novelai`;
  const missing = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.deepEqual(findRunningHost(dataRoot, { read: missing, alive: () => true }), [], 'no bridge.json: no client on this data folder');
  let seen;
  assert.deepEqual(findRunningHost(dataRoot, { read: file => { seen = file; return JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:1', pid: 42 }); }, alive: pid => pid === 42 }), [42]);
  assert.equal(seen, String.raw`C:\Users\u\AppData\Roaming\mcp-for-novelai\runtime\bridge.json`);
  assert.deepEqual(findRunningHost(dataRoot, { read: () => JSON.stringify({ pid: 42 }), alive: () => false }), [], 'a bridge.json left by a client that is gone');
  assert.throws(() => findRunningHost(dataRoot, { read: () => { throw Object.assign(new Error('EACCES: access denied'), { code: 'EACCES' }); } }), /Cannot check whether MCP for NovelAI is already running.*EACCES/s);
  assert.throws(() => findRunningHost(dataRoot, { read: () => 'garbage', alive: () => true }), /not a valid client connection file/);
  assert.throws(() => findRunningHost(dataRoot, { read: () => '{"pid":"7"}', alive: () => true }), /not a valid client connection file/);
});

test('win32 --detach with the spawn fallback still launches and warns that the terminal may take it down', { skip, timeout: 120_000 }, t => {
  const f = makeTree(t);
  const result = runSync(f, ['--detach', '--no-build'], { NOVELAI_DETACH_VIA: 'spawn' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.match(result.stderr, /could not start the launcher outside this terminal/);
  assert.equal(findRunningHost(f.dataDir).length, 1);
  assert.match(statusLines(f.novelai)[0], / via=spawn /);
});

test('win32: the background launcher only logs into client-launch', { skip, timeout: 60_000 }, t => {
  const f = makeTree(t);
  const outside = join(f.base, 'elsewhere.log');
  const result = runSync(f, ['--no-build'], { NOVELAI_LAUNCH_DETACHED: '1', NOVELAI_LAUNCH_LOG: outside });
  assert.equal(result.status, 2); assert.match(result.stderr, /NOVELAI_LAUNCH_LOG must be a \.log file in/);
  assert.equal(existsSync(outside), false); assert.deepEqual(findRunningHost(f.dataDir), []);
});

test('hostEnvironment drops the calling agent session variables and keeps the rest', () => {
  const kept = hostEnvironment({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't', claude_code_entrypoint: 'x', NOVELAI_X: 'n', CLAUDE_HOME: 'h' });
  assert.deepEqual(kept, { PATH: 'p', NOVELAI_X: 'n', CLAUDE_HOME: 'h' });
});

test('hostEnvironment demotes only an MSYS shell\'s own directories and keeps the user\'s PATH order', () => {
  const git = String.raw`C:\Program Files\Git`;
  const exists = file => file.toLowerCase() === String.raw`c:\program files\git\usr\bin\msys-2.0.dll`;
  const path = [String.raw`C:\Users\u\bin`, String.raw`${git}\mingw64\bin`, String.raw`${git}\usr\local\bin`, String.raw`${git}\usr\bin`, String.raw`${git}\bin`,
    String.raw`C:\Program Files\OpenSSH`, String.raw`C:\WINDOWS\system32`, String.raw`C:\Tools\bin`, String.raw`"${git}\usr\bin\"`].join(';');
  const env = { Path: path, SystemRoot: String.raw`C:\WINDOWS`, MSYSTEM: 'MINGW64', CLAUDE_PID: '1', CLAUDE_EFFORT: 'max', TEMP: 't' };
  const kept = hostEnvironment(env, { exists });
  assert.deepEqual(Object.keys(kept).sort(), ['Path', 'SystemRoot', 'TEMP']);
  // The user's own entries keep their order (OpenSSH stays ahead of System32); only the MSYS
  // install's directories move to the end, in their original order; C:\Tools\bin is not MSYS.
  assert.equal(kept.Path, [String.raw`C:\Users\u\bin`, String.raw`C:\Program Files\OpenSSH`, String.raw`C:\WINDOWS\system32`, String.raw`C:\Tools\bin`,
    String.raw`${git}\mingw64\bin`, String.raw`${git}\usr\local\bin`, String.raw`${git}\usr\bin`, String.raw`${git}\bin`, String.raw`"${git}\usr\bin\"`].join(';'));
  // Without an MSYS caller (double-click, PowerShell) PATH is passed through untouched.
  assert.equal(hostEnvironment({ Path: path, SystemRoot: String.raw`C:\WINDOWS` }, { exists }).Path, path);
});

test('hostEnvironment keeps one entry per case-insensitive name', () => {
  const kept = hostEnvironment({ Path: 'first', PATH: 'second', temp: 'a', TEMP: 'b' }, { exists: () => false });
  assert.deepEqual(kept, { Path: 'first', temp: 'a' });
});

test('launcherExit reads the last marker even when output follows it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nai-exit-marker-')), file = join(dir, 'x.log');
  try {
    writeFileSync(file, 'build\n[launcher-exit 3]\nlate host line\n'); assert.equal(launcherExit(file), 3);
    writeFileSync(file, '[launcher-exit 0]\n[launcher-exit 1]\ntrailing'); assert.equal(launcherExit(file), 1);
    writeFileSync(file, 'no marker yet'); assert.equal(launcherExit(file), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('createOutsideJob separates ambiguous WMI outcomes from definite failures', () => {
  const env = { A: '1' }, call = result => createOutsideJob({ commandLine: 'x', cwd: 'C:\\', env }, { run: () => result });
  assert.deepEqual(call({ status: 0, stdout: 'wmi:0:4242' }), { pid: 4242 });
  assert.equal(call({ error: Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) }).ambiguous, true);
  assert.equal(call({ status: 0, stdout: 'garbled' }).ambiguous, true);
  assert.equal(call({ status: 0, stdout: 'wmi:9:0' }).ambiguous, false);
  assert.equal(call({ error: Object.assign(new Error('spawnSync powershell.exe ENOENT'), { code: 'ENOENT' }) }).ambiguous, false);
  assert.equal(call({ status: 1, stdout: '', stderr: 'Invoke-CimMethod : Access denied' }).ambiguous, false);
});

test('win32: findRunningHost sees a live process named by bridge.json, with the real read and liveness check', { skip }, t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'nai-host-check-')); t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  mkdirSync(join(dataRoot, 'runtime'));
  writeFileSync(join(dataRoot, 'runtime', 'bridge.json'), JSON.stringify({ schemaVersion: 1, pid: process.pid }));
  assert.deepEqual(findRunningHost(dataRoot), [process.pid]);
});

test('win32: the background launcher captures direct stdout/stderr writes in its log', { skip, timeout: 60_000 }, t => {
  const f = makeTree(t), logDir = join(f.novelai, '.tmp', 'client-launch'), log = join(logDir, 'direct.log');
  mkdirSync(logDir, { recursive: true });
  const code = `import(${JSON.stringify(pathToFileURL(join(f.novelai, 'scripts', 'win32-launch.mjs')).href)}).then(m => { m.attachDetachedLog(${JSON.stringify(f.novelai)}); process.stdout.write('direct-out\\n'); process.stderr.write(Buffer.from('direct-err\\n')); process.emitWarning('warned'); setTimeout(() => process.exit(4), 50); })`;
  const result = spawnSync(process.execPath, ['-e', code], { env: { ...process.env, NOVELAI_LAUNCH_LOG: log }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 4); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  const text = readFileSync(log, 'utf8');
  for (const expected of ['direct-out', 'direct-err', 'warned', '[launcher-exit 4]']) assert.ok(text.includes(expected), `${expected} in ${text}`);
});

test('win32 --detach: a launcher killed during the build is reported promptly', { skip, timeout: 120_000 }, async t => {
  const f = makeTree(t);
  const pending = runAsync(f, ['--detach'], { FAKE_BUILD_MS: '60000' });
  let launcherPid;
  for (let i = 0; i < 100 && !launcherPid; i++) {
    try { launcherPid = Number(/ started launcherPid=(\d+)/.exec(readFileSync(join(f.novelai, '.tmp', 'client-launch', 'launcher-status.log'), 'utf8'))?.[1]) || undefined; } catch {}
    if (!launcherPid) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(launcherPid, 'launcher started');
  await new Promise(resolve => setTimeout(resolve, 3000)); // let it take the lock and start building
  const started = Date.now();
  // Kill the launcher with its build tree (a lone kill would orphan npm's grandchildren on Windows).
  spawnSync('taskkill', ['/T', '/F', '/PID', String(launcherPid)], { windowsHide: true });
  const result = await pending;
  assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /disappeared before the host was ready/);
  assert.ok(Date.now() - started < 15_000, `reported after ${Date.now() - started} ms`);
});

test('win32: arguments are matched exactly (no case folding, no wildcards)', { skip, timeout: 60_000 }, t => {
  const f = makeTree(t);
  for (const bad of ['--NO-BUILD', '--no-build*', '--no-buil?', '--launcher-child']) {
    const result = runSync(f, ['--detach', bad]);
    assert.notEqual(result.status, 0, bad); assert.match(result.stderr, /Usage: node scripts\/start-client\.mjs/, bad);
  }
  assert.equal(existsSync(join(f.novelai, '.tmp', 'client-launch')), false, 'nothing was launched or logged');
});

test('win32 start-client.cmd: forwards flags, returns once ready even when output is captured, and reports refusals', { skip, timeout: 120_000 }, t => {
  const f = makeTree(t, 'Cmd & Tree (1)'); // & and parentheses in the root
  const cmd = args => {
    const started = Date.now();
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${f.cmd}" ${args}"`],
      { encoding: 'utf8', input: '', env: { ...process.env, NOVELAI_DATA_DIR: f.dataDir }, windowsVerbatimArguments: true, windowsHide: true, timeout: 90_000 });
    return { status: result.status, out: `${result.stdout}${result.stderr}`, ms: Date.now() - started };
  };
  const first = cmd('--no-build');
  assert.equal(first.status, 0, first.out); assert.match(first.out, /ready/); assert.ok(first.ms < 45_000, `${first.ms} ms`);
  assert.equal(findRunningHost(f.dataDir).length, 1);
  const second = cmd('--no-build');
  assert.equal(second.status, 3, second.out); assert.match(second.out, /already running/);
  const bad = cmd('--bogus');
  assert.notEqual(bad.status, 0); assert.match(bad.out, /Usage/);
});
