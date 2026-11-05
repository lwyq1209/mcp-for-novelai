// Which app the MCP server belongs to and how it starts it (src/app-launch.mjs, src/win32-process.mjs), with injected
// facts, spawns and WMI: nothing here starts an app. The Windows-only test at the end starts a harmless Node script
// through the same launcher from inside a kill-on-close job object and checks it outlives that job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STARTED_BY_AGENT_ARG, appEnvironment, launchApp, macOpenArguments, resolveOwnApp, startedByAgentArgument } from '../src/app-launch.mjs';
import { SW_SHOWNOACTIVATE, outsideJobOutcome, outsideJobRequest, windowsArgument, windowsCommandLine } from '../src/win32-process.mjs';

const electron = { node: '24.0.0', electron: '42.11.0' };
const files = list => file => list.includes(file);

test('resolveOwnApp: a packaged app is the one whose executable runs the bundle it ships', () => {
  const macExe = '/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI';
  const mac = resolveOwnApp({ platform: 'darwin', versions: electron, execPath: macExe, moduleFile: '/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs', exists: files([macExe]) });
  assert.deepEqual(mac, { ok: true, kind: 'packaged', platform: 'darwin', executable: macExe, args: [], macApp: '/Applications/MCP for NovelAI.app' });
  const winExe = 'C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe';
  assert.deepEqual(resolveOwnApp({ platform: 'win32', versions: electron, execPath: winExe, moduleFile: 'C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs', exists: files([winExe]) }),
    { ok: true, kind: 'packaged', platform: 'win32', executable: winExe, args: [] });
  const linuxExe = '/opt/MCP-for-NovelAI-0.1.1-linux-x64/mcp-for-novelai';
  assert.deepEqual(resolveOwnApp({ platform: 'linux', versions: electron, execPath: linuxExe, moduleFile: '/opt/MCP-for-NovelAI-0.1.1-linux-x64/resources/mcp/novelai-mcp.mjs', exists: files([linuxExe]) }),
    { ok: true, kind: 'packaged', platform: 'linux', executable: linuxExe, args: [] });
  // Another app's executable running this bundle, or a bundle copied out of an app: not guessed.
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: '/Applications/Other.app/Contents/MacOS/Other', moduleFile: '/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs', exists: () => true }), { ok: false, reason: 'unknown_location' });
  assert.deepEqual(resolveOwnApp({ platform: 'win32', versions: electron, execPath: 'C:\\Other\\Other.exe', moduleFile: 'C:\\App\\resources\\mcp\\novelai-mcp.mjs', exists: () => true }), { ok: false, reason: 'unknown_location' });
  assert.deepEqual(resolveOwnApp({ platform: 'linux', versions: electron, execPath: '/home/u/x/mcp', moduleFile: '/home/u/mcp/novelai-mcp.mjs', exists: () => true }), { ok: false, reason: 'unknown_location' });
});

test('resolveOwnApp: from source, a development Electron running a built client\'s dist-mcp bundle starts that client', () => {
  const client = '/repo/novelai/client', exe = `${client}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
  const built = files([exe, `${client}/package.json`, `${client}/dist-electron/electron/bootstrap.js`]);
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: exe, moduleFile: `${client}/dist-mcp/novelai-mcp.mjs`, exists: built }),
    { ok: true, kind: 'source', platform: 'darwin', executable: exe, args: [client], macApp: `${client}/node_modules/electron/dist/Electron.app` });
  const winClient = 'C:\\repo dir\\novelai\\client', winExe = `${winClient}\\node_modules\\electron\\dist\\electron.exe`;
  assert.deepEqual(resolveOwnApp({ platform: 'win32', versions: electron, execPath: winExe, moduleFile: `${winClient}\\dist-mcp\\novelai-mcp.mjs`, exists: files([winExe, `${winClient}\\package.json`, `${winClient}\\dist-electron\\electron\\bootstrap.js`]) }),
    { ok: true, kind: 'source', platform: 'win32', executable: winExe, args: [winClient] });
  const linuxExe = `${client}/node_modules/electron/dist/electron`;
  assert.equal(resolveOwnApp({ platform: 'linux', versions: electron, execPath: linuxExe, moduleFile: `${client}/dist-mcp/novelai-mcp.mjs`, exists: files([linuxExe, `${client}/package.json`, `${client}/dist-electron/electron/bootstrap.js`]) }).ok, true);
  // Not built, or not a development Electron: no start.
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: exe, moduleFile: `${client}/dist-mcp/novelai-mcp.mjs`, exists: files([exe, `${client}/package.json`]) }), { ok: false, reason: 'unknown_location' });
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: '/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI', moduleFile: `${client}/dist-mcp/novelai-mcp.mjs`, exists: () => true }), { ok: false, reason: 'unknown_location' });
});

test('resolveOwnApp: system Node (novelai/src/mcp.mjs, or any bundle run with node) never starts an app', () => {
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: { node: '24.0.0' }, execPath: '/usr/local/bin/node', moduleFile: '/repo/novelai/src/app-launch.mjs', exists: () => true }), { ok: false, reason: 'not_electron' });
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: { node: '24.0.0' }, execPath: '/usr/local/bin/node', moduleFile: '/repo/novelai/client/dist-mcp/novelai-mcp.mjs', exists: () => true }), { ok: false, reason: 'not_electron' });
  // Electron as Node running the source entry itself: not where an app ships the server either.
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: '/x/Electron.app/Contents/MacOS/Electron', moduleFile: '/repo/novelai/src/app-launch.mjs', exists: () => true }), { ok: false, reason: 'unknown_location' });
  // This test process: system Node.
  assert.equal(resolveOwnApp().ok, false);
});

test('the start argument names the calling client, URI-encoded so it is one plain word', () => {
  assert.equal(startedByAgentArgument({ name: 'claude-code', version: '2' }), '--started-by-agent=claude-code');
  assert.equal(startedByAgentArgument({ name: 'Visual Studio Code "x" 编辑器' }), '--started-by-agent=Visual%20Studio%20Code%20%22x%22%20%E7%BC%96%E8%BE%91%E5%99%A8');
  for (const client of [null, {}, { name: '' }, { name: 'a\nb' }, { name: 'x'.repeat(101) }]) assert.equal(startedByAgentArgument(client), STARTED_BY_AGENT_ARG);
});

test('the started app\'s environment: no Node mode, no development or test switches, no agent session markers; the data folder as it is', () => {
  const env = { PATH: '/bin', HOME: '/h', ELECTRON_RUN_AS_NODE: '1', NOVELAI_DATA_DIR: '/tmp/数据 dir', NOVELAI_PROJECT_ROOT: '/p', VITE_DEV_SERVER_URL: 'http://x', NAI_UI_CAPTURE_PATH: '/c.png', NAI_DEV_TOOLS_BACKGROUND: '1', NOVELAI_MCP_AUTOSTART: '1', NODE_OPTIONS: '--inspect', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', LANG: 'zh_CN.UTF-8' };
  assert.deepEqual(appEnvironment(env, 'linux'), { PATH: '/bin', HOME: '/h', NOVELAI_DATA_DIR: '/tmp/数据 dir', NOVELAI_PROJECT_ROOT: '/p', LANG: 'zh_CN.UTF-8' });
  assert.equal(Object.hasOwn(appEnvironment({ PATH: '/bin' }, 'linux'), 'NOVELAI_DATA_DIR'), false, 'no data folder set: none is added');
  assert.deepEqual(appEnvironment({ Path: 'a', PATH: 'b', electron_run_as_node: '1' }, 'win32'), { Path: 'a' });
});

test('macOS: open -n -g -a <exactly this app> with the data folder through --env and the start argument last', () => {
  const app = { platform: 'darwin', macApp: '/Applications/MCP for NovelAI.app', args: [] };
  assert.deepEqual(macOpenArguments(app, { dataDir: '/Users/u/数据 dir', agentArgument: '--started-by-agent=pi' }), ['-n', '-g', '-a', '/Applications/MCP for NovelAI.app', '--env', 'NOVELAI_DATA_DIR=/Users/u/数据 dir', '--args', '--started-by-agent=pi']);
  assert.deepEqual(macOpenArguments({ ...app, args: ['/repo/novelai/client'] }, { dataDir: null, agentArgument: '--started-by-agent' }), ['-n', '-g', '-a', '/Applications/MCP for NovelAI.app', '--args', '/repo/novelai/client', '--started-by-agent']);
});

function fakeChild({ exit = 0, stderr = '', spawnError = null, spawned = true } = {}) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
  child.pid = 4321; child.unref = () => { child.unrefed = true; };
  setImmediate(() => {
    if (spawnError) { child.emit('error', spawnError); return; }
    if (spawned) child.emit('spawn');
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', exit);
  });
  return child;
}

test('macOS launch: hands the start to LaunchServices; refuses when the data folder cannot be passed', async () => {
  const app = { ok: true, platform: 'darwin', kind: 'packaged', executable: '/A.app/Contents/MacOS/A', macApp: '/A.app', args: [] };
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push({ command, args, options }); return fakeChild(); };
  const runSync = () => ({ stdout: '', stderr: 'Usage: open [-e] ... --env VAR Add an enviroment variable' });
  const started = await launchApp(app, { client: { name: 'claude-code' }, env: { NOVELAI_DATA_DIR: '/d', ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }, spawnImpl, runSync });
  assert.deepEqual(started, { ok: true, via: 'open' });
  assert.equal(calls[0].command, '/usr/bin/open');
  assert.deepEqual(calls[0].args, ['-n', '-g', '-a', '/A.app', '--env', 'NOVELAI_DATA_DIR=/d', '--args', '--started-by-agent=claude-code']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  const failed = await launchApp(app, { env: {}, spawnImpl: () => fakeChild({ exit: 1, stderr: 'Unable to find application\n' }), runSync });
  assert.deepEqual(failed, { ok: false, reason: 'open exited 1: Unable to find application' });
  // An `open` without --env could only start the app on the default data folder: refused when another one is set.
  const oldOpen = () => ({ stdout: '', stderr: 'Usage: open [-e] [-t] [-f] [-W] [-R] [-n] [-g] [-h]' });
  const refused = await launchApp(app, { env: { NOVELAI_DATA_DIR: '/d' }, spawnImpl: () => { throw new Error('nothing may be started'); }, runSync: oldOpen });
  assert.equal(refused.ok, false); assert.match(refused.reason, /cannot pass the data folder/);
  assert.equal((await launchApp(app, { env: {}, spawnImpl: () => fakeChild(), runSync: oldOpen })).ok, true, 'no data folder to pass: the old open is enough');
});

test('Windows launch: WMI with SW_SHOWNOACTIVATE, a quoted command line and the complete environment; a definite WMI failure falls back to a detached spawn', async () => {
  const app = { ok: true, platform: 'win32', kind: 'packaged', executable: 'C:\\Program Files\\MCP for NovelAI\\MCP for NovelAI.exe', args: [] };
  const requests = [];
  const env = { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', NOVELAI_DATA_DIR: 'D:\\数据 dir\\nai', CLAUDECODE: '1' };
  const viaWmi = await launchApp(app, { client: { name: 'codex-mcp-client' }, env, exists: () => false, outsideJob: async (request, options) => { requests.push({ request, options }); return { pid: 77 }; } });
  assert.deepEqual(viaWmi, { ok: true, via: 'wmi', pid: 77 });
  assert.deepEqual(requests[0].request, { commandLine: '"C:\\Program Files\\MCP for NovelAI\\MCP for NovelAI.exe" --started-by-agent=codex-mcp-client', cwd: 'C:\\Program Files\\MCP for NovelAI', env: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', NOVELAI_DATA_DIR: 'D:\\数据 dir\\nai' }, showWindow: SW_SHOWNOACTIVATE });
  assert.equal(requests[0].options.powershell, 'powershell.exe');
  // The WMI answer was lost: the app may be starting, so no second start.
  assert.deepEqual(await launchApp(app, { env, outsideJob: async () => ({ pid: null, ambiguous: true, reason: 'timeout' }), spawnImpl: () => { throw new Error('no spawn expected'); } }), { ok: true, via: 'wmi', unconfirmed: true });
  // A definite failure: a detached spawn, logged.
  const logs = [], spawns = [];
  const fallback = await launchApp(app, { env, log: message => logs.push(message), outsideJob: async () => ({ pid: null, ambiguous: false, reason: 'Access denied' }), spawnImpl: (command, args, options) => { spawns.push({ command, args, options }); return fakeChild(); } });
  assert.equal(fallback.ok, true); assert.equal(fallback.via, 'spawn');
  assert.deepEqual(spawns[0].args, ['--started-by-agent']);
  assert.equal(spawns[0].options.detached, true); assert.equal(spawns[0].options.stdio, 'ignore'); assert.equal(spawns[0].options.windowsHide, false);
  assert.equal(spawns[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.match(logs[0], /Access denied.*detached child.*may close the app too/);
});

test('Linux launch: a detached spawn without stdio, unref\'d; a spawn error is a definite failure', async () => {
  const app = { ok: true, platform: 'linux', kind: 'source', executable: '/repo/novelai/client/node_modules/electron/dist/electron', args: ['/repo/novelai/client'] };
  const spawns = [];
  let child;
  const started = await launchApp(app, { env: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' }, spawnImpl: (command, args, options) => { spawns.push({ command, args, options }); return (child = fakeChild()); } });
  assert.deepEqual(started, { ok: true, via: 'spawn', pid: 4321 });
  assert.deepEqual(spawns[0].args, ['/repo/novelai/client', '--started-by-agent']);
  assert.equal(spawns[0].options.detached, true); assert.equal(spawns[0].options.stdio, 'ignore'); assert.equal(child.unrefed, true);
  assert.deepEqual(spawns[0].options.env, { PATH: '/bin' });
  assert.deepEqual(await launchApp(app, { env: {}, spawnImpl: () => fakeChild({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }) }), { ok: false, reason: 'the app could not be started (spawn ENOENT)' });
});

test('Windows command lines read back exactly as given (CommandLineToArgvW rules)', () => {
  assert.equal(windowsArgument('plain'), 'plain');
  assert.equal(windowsArgument(''), '""');
  assert.equal(windowsArgument('C:\\a b\\c'), '"C:\\a b\\c"');
  assert.equal(windowsArgument('C:\\a b\\'), '"C:\\a b\\\\"', 'a trailing backslash is doubled before the closing quote');
  assert.equal(windowsArgument('say "hi"'), '"say \\"hi\\""');
  assert.equal(windowsArgument('a\\"b'), '"a\\\\\\"b"', 'backslashes before a quote are doubled, the quote escaped');
  assert.equal(windowsArgument('数据 目录'), '"数据 目录"');
  assert.equal(windowsCommandLine('C:\\Program Files\\App\\App.exe', ['--x', 'y z']), '"C:\\Program Files\\App\\App.exe" --x "y z"');
  assert.throws(() => windowsCommandLine('C:\\a"b.exe'), TypeError);
});

test('the WMI request carries the whole environment and the window state; its outcome separates ambiguous from definite failures', () => {
  const request = outsideJobRequest({ commandLine: '"C:\\a.exe"', cwd: 'C:\\', env: { A: '1', B: undefined, 数据: '值' }, showWindow: SW_SHOWNOACTIVATE });
  assert.deepEqual(JSON.parse(Buffer.from(request.input, 'base64').toString('utf8')), { commandLine: '"C:\\a.exe"', cwd: 'C:\\', showWindow: 4, env: ['A=1', '数据=值'] });
  assert.ok(request.args.at(-1).includes('ShowWindow = [uint16]$j.showWindow'));
  assert.throws(() => outsideJobRequest({ commandLine: 'x', cwd: 'C:\\', env: {}, showWindow: 12 }), TypeError);
  assert.deepEqual(outsideJobOutcome({ status: 0, stdout: 'wmi:0:4242' }), { pid: 4242 });
  assert.equal(outsideJobOutcome({ error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }).ambiguous, true);
  assert.equal(outsideJobOutcome({ status: 0, stdout: 'garbled' }).ambiguous, true);
  assert.equal(outsideJobOutcome({ status: 0, stdout: 'wmi:9:0' }).ambiguous, false);
  assert.equal(outsideJobOutcome({ status: 1, stderr: 'Invoke-CimMethod : Access denied' }).ambiguous, false);
});

// --- Windows only: the real launcher from inside a kill-on-close job ---------------------------------------------

const win32 = process.platform === 'win32';
const JOB = String.raw`
using System; using System.Runtime.InteropServices;
public static class NaiJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic BasicLimit; public Io IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref Extended info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static IntPtr KillOnClose() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    Extended info = new Extended(); info.BasicLimit.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    return job;
  }
}`;
// PowerShell joins a new kill-on-close job, runs the runner inside it (it inherits the job) and exits: the job closes.
const IN_JOB = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition $env:NAI_JOB_CS; $job = [NaiJob]::KillOnClose();
$psi = New-Object System.Diagnostics.ProcessStartInfo; $psi.FileName = $env:NAI_NODE; $psi.Arguments = $env:NAI_RUNNER_ARGS; $psi.UseShellExecute = $false;
$p = [System.Diagnostics.Process]::Start($psi); $p.WaitForExit(); exit $p.ExitCode`;
const CHILD = `// Records what it was started with, then stays up (at most 90 s).
const fs = require('node:fs');
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, argv: process.argv.slice(3), env: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null, NOVELAI_DATA_DIR: process.env.NOVELAI_DATA_DIR ?? null, CLAUDECODE: process.env.CLAUDECODE ?? null, SystemRoot: Boolean(process.env.SystemRoot), Path: Boolean(process.env.Path || process.env.PATH) } }));
setTimeout(() => process.exit(0), 90000);
`;
const RUNNER = launcher => `// Inside the job: starts the child once through the MCP server's launcher and once as a plain detached child.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const { launchApp } = await import(${JSON.stringify(launcher)});
const [child, wmiFile, plainFile] = process.argv.slice(2);
process.env.ELECTRON_RUN_AS_NODE = '1'; process.env.CLAUDECODE = '1'; process.env.NOVELAI_DATA_DIR = process.env.NAI_TEST_DATA_DIR;
const started = await launchApp({ ok: true, platform: 'win32', kind: 'packaged', executable: process.execPath, args: [child, wmiFile, 'say "hi"', 'C:\\\\trailing dir\\\\', '数据 参数'] }, { client: { name: 'claude-code' }, env: process.env });
const plain = spawn(process.execPath, [child, plainFile], { detached: true, stdio: 'ignore' }); plain.unref();
for (let i = 0; i < 300 && !(existsSync(wmiFile) && existsSync(plainFile)); i++) await new Promise(resolve => setTimeout(resolve, 100));
process.stdout.write(JSON.stringify({ started, plainPid: plain.pid }));
`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

test('win32: the app launcher starts a process outside a kill-on-close job; it survives the job, with the right environment and arguments', { skip: !win32 && 'win32 only', timeout: 120_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'nai 启动 job '));
  const pids = [];
  t.after(() => { for (const pid of pids) { try { process.kill(pid); } catch { /* gone */ } } rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  const child = join(base, 'child script.cjs'), runner = join(base, 'runner.mjs'), wmiFile = join(base, 'wmi.json'), plainFile = join(base, 'plain.json'), data = join(base, '数据 dir');
  mkdirSync(data);
  writeFileSync(child, CHILD); writeFileSync(runner, RUNNER(pathToFileURL(join(import.meta.dirname, '..', 'src', 'app-launch.mjs')).href));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', IN_JOB], {
    encoding: 'utf8', timeout: 90_000, windowsHide: true,
    env: { ...process.env, NAI_JOB_CS: JOB, NAI_NODE: process.execPath, NAI_RUNNER_ARGS: [runner, child, wmiFile, plainFile].map(windowsArgument).join(' '), NAI_TEST_DATA_DIR: data },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(report.started.ok, true); assert.equal(report.started.via, 'wmi', JSON.stringify(report));
  const wmi = JSON.parse(readFileSync(wmiFile, 'utf8')), plain = JSON.parse(readFileSync(plainFile, 'utf8'));
  pids.push(wmi.pid, plain.pid);
  assert.equal(wmi.pid, report.started.pid);
  // The job closed with PowerShell: the plain detached child went with it, the one the launcher started did not.
  for (let i = 0; i < 50 && alive(plain.pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(plain.pid), false, 'the kill-on-close job took the plain detached child down (the test job works)');
  assert.equal(alive(wmi.pid), true, 'the launched process outlives the job of the agent that started it');
  assert.deepEqual(wmi.argv, ['say "hi"', 'C:\\trailing dir\\', '数据 参数', '--started-by-agent=claude-code']);
  assert.deepEqual(wmi.env, { ELECTRON_RUN_AS_NODE: null, NOVELAI_DATA_DIR: data, CLAUDECODE: null, SystemRoot: true, Path: true });
  process.kill(wmi.pid);
  assert.ok(existsSync(base));
});
