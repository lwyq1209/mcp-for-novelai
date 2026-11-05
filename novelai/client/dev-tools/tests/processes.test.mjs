import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pollUntil } from '../lib/cli.mjs';
import { electronExecutable } from '../lib/paths.mjs';
import { DATA_MARKER_SWITCH, alive, commandOf, findDataRootProcesses, findTestClients, isOurClient, listProcesses, parseClientCommand, stopClients, writePidFile } from '../lib/processes.mjs';
import { tempDir } from './helpers.mjs';

const EXE = '/w/tools/novelai/client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

test('parseClientCommand recognises only the main process of this executable with its data marker', () => {
  assert.deepEqual(parseClientCommand(`${EXE} /w/tools/novelai/client --use-mock-keychain --remote-debugging-port=9333 ${DATA_MARKER_SWITCH}=/tmp/a b/data`, EXE), { dataRoot: '/tmp/a b/data', port: 9333 });
  assert.deepEqual(parseClientCommand(`${EXE} /w/tools/novelai/client ${DATA_MARKER_SWITCH}=/tmp/x`, EXE), { dataRoot: '/tmp/x', port: null });
  // No marker: an Electron of this checkout started some other way (e.g. start-client.mjs) is not a dev-tools client.
  assert.deepEqual(parseClientCommand(`${EXE} .`, EXE), { dataRoot: null, port: null });
  // Helpers, other checkouts (same name with a different prefix) and look-alike executables never match.
  assert.equal(parseClientCommand(`${EXE.replace('Contents/MacOS/Electron', 'Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)')} --type=renderer --user-data-dir=/tmp/x`, EXE), null);
  assert.equal(parseClientCommand(`${EXE} --type=gpu-process ${DATA_MARKER_SWITCH}=/tmp/x`, EXE), null);
  assert.equal(parseClientCommand(`/w/main/novelai/client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . ${DATA_MARKER_SWITCH}=/tmp/x`, EXE), null);
  assert.equal(parseClientCommand(`${EXE}-evil /w ${DATA_MARKER_SWITCH}=/tmp/x`, EXE), null);
  assert.equal(parseClientCommand(`/usr/bin/node ${EXE} ${DATA_MARKER_SWITCH}=/tmp/x`, EXE), null);
});

test('parseClientCommand reads the quoted Windows form', () => {
  if (process.platform !== 'win32') {
    // On POSIX the quoted form is still parsed by the same rule (the executable is compared as written).
    const exe = '/w/electron';
    assert.deepEqual(parseClientCommand(`"${exe}" /w/client "${DATA_MARKER_SWITCH}=/tmp/a b" --remote-debugging-port=9`, exe), { dataRoot: '/tmp/a b', port: 9 });
  }
});

test('listProcesses and commandOf see this process', () => {
  const rows = listProcesses();
  assert.ok(rows.some(row => row.pid === process.pid));
  assert.match(commandOf(process.pid), /node/i);
  assert.equal(commandOf(2 ** 31 - 2), null);
});

/** A stand-in "test client": this checkout's Electron run as Node, with the data marker on its command line. */
function fakeClient(dataRoot) {
  const child = spawn(electronExecutable(), ['-e', 'setInterval(() => {}, 1000)', '--', `${DATA_MARKER_SWITCH}=${dataRoot}`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  return child;
}

test('stop signals only the verified process of that data root; another data root and a foreign PID stay running', async t => {
  const dir = tempDir(t);
  const one = path.join(dir, 'one'), two = path.join(dir, 'two'), three = path.join(dir, 'three');
  const first = fakeClient(one), second = fakeClient(two);
  // A foreign process (not this checkout's Electron) recorded in a pid file must never be signalled.
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => { for (const child of [first, second, foreign]) { try { child.kill('SIGKILL'); } catch { /* gone */ } } });
  assert.ok(await pollUntil(() => findTestClients({ dataRoot: one }).length === 1 && findTestClients({ dataRoot: two }).length === 1, { timeoutMs: 10_000 }), 'both stand-ins are found');
  assert.equal(isOurClient(first.pid, one), true);
  assert.equal(isOurClient(first.pid, two), false, 'a PID is ours only for its own data root');
  writePidFile(three, { pid: foreign.pid });
  const refused = await stopClients(three, { timeoutMs: 1000 });
  assert.deepEqual(refused.stopped, []);
  assert.equal(refused.skipped[0].pid, foreign.pid);
  assert.equal(alive(foreign.pid), true, 'the foreign PID was not signalled');

  const result = await stopClients(one, { timeoutMs: 10_000 });
  assert.deepEqual(result.stopped.map(row => row.pid), [first.pid]);
  assert.equal(alive(first.pid), false);
  assert.equal(alive(second.pid), true, 'the other data root\'s client is still running');
  assert.deepEqual(findTestClients({ dataRoot: two }).map(row => row.pid), [second.pid]);
});

test('findDataRootProcesses: the main process, its helpers and an app run with NOVELAI_DATA_DIR count; MCP servers (run as Node) and other data roots do not (review rework)', () => {
  // A data root is compared resolved (on Windows /tmp/oqr/data is <drive>:\tmp\oqr\data).
  const root = path.resolve('/tmp/oqr/data');
  const helper = EXE.replace('Contents/MacOS/Electron', 'Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)');
  const rows = [
    { pid: 11, command: `${EXE} /w/client --use-mock-keychain ${DATA_MARKER_SWITCH}=${root} NOVELAI_DATA_DIR=${root} HOME=/u` },
    { pid: 12, command: `${helper} --type=gpu-process --user-data-dir=${root} --shared-files` },
    { pid: 13, command: `${EXE} /w/client NOVELAI_DATA_DIR=${root} PATH=/bin` },
    { pid: 14, command: `${EXE} /w/client/dist-mcp/novelai-mcp.mjs ELECTRON_RUN_AS_NODE=1 NOVELAI_DATA_DIR=${root}` },
    { pid: 15, command: `${helper} --type=renderer --user-data-dir=${root}2 --x` },
    { pid: 16, command: `${EXE} /w/client ${DATA_MARKER_SWITCH}=${root}-other` },
    { pid: 17, command: `/usr/bin/vim NOVELAI_DATA_DIR=${root}` },
    { pid: process.pid, command: `${EXE} ${DATA_MARKER_SWITCH}=${root}` },
  ];
  assert.deepEqual(findDataRootProcesses(root, rows, EXE).map(row => [row.pid, row.kind, row.via]), [[11, 'main', 'marker'], [12, 'helper', 'profile'], [13, 'main', 'environment']]);
  assert.deepEqual(findDataRootProcesses(path.resolve('/tmp/oqr/elsewhere'), rows, EXE), []);
});

test('start refuses while any process of the data root runs (a stand-in helper with its profile there)', async t => {
  const dir = tempDir(t), data = path.join(dir, 'data');
  const { checkDataRoot } = await import('../lib/guard.mjs');
  checkDataRoot(data, { create: true });
  const helper = spawn(electronExecutable(), ['-e', 'setInterval(() => {}, 1000)', '--', '--type=gpu-process', `--user-data-dir=${data}`], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  t.after(() => { try { helper.kill('SIGKILL'); } catch { /* gone */ } });
  assert.ok(await pollUntil(() => findDataRootProcesses(data).some(row => row.pid === helper.pid), { timeoutMs: 10_000 }), 'the stand-in helper is found');
  const { startClient } = await import('../test-client.mjs');
  await assert.rejects(startClient({ data }), error => error.code === 'data_root_busy' && error.details.processes.some(row => row.pid === helper.pid));
});
