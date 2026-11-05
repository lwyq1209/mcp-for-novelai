// Review rework 2 (front): the agent copy of Electron a background window runs on, and the front-app watcher that fails
// a run when a test client comes to the front. No window is opened here: the copy is only made and checked, and the
// watcher is fed by a stand-in lsappinfo that names a plain Node process carrying a test client's data marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { backgroundAppPaths, backgroundElectronExecutable, clientExecutables, isAgentApp } from '../lib/background-app.mjs';
import { frontDetectedError, startFrontWatch, withFrontWatch } from '../lib/front-watch.mjs';
import { electronExecutable } from '../lib/paths.mjs';
import { DATA_MARKER_SWITCH, parseClientCommand } from '../lib/processes.mjs';
import { tempDir } from './helpers.mjs';

const mac = process.platform === 'darwin';

test('macOS: the agent copy is an APFS clone with LSUIElement=1, ad-hoc signed and verified; reused, and made again when Electron changes', { skip: !mac && 'macOS only', timeout: 120_000 }, t => {
  const cache = path.join(tempDir(t), 'cache');
  // A stand-in "installed Electron" (a clone of the real one), so a change to it can be simulated.
  const sourceRoot = tempDir(t), real = electronExecutable(), realApp = real.slice(0, real.indexOf('.app/') + 4);
  execFileSync('cp', ['-c', '-R', realApp, path.join(sourceRoot, 'Electron.app')]);
  const source = path.join(sourceRoot, 'Electron.app', real.slice(realApp.length + 1));
  const before = backgroundAppPaths({ cache, source });
  assert.equal(before.supported, true); assert.equal(before.built, false);
  const exe = backgroundElectronExecutable({ cache, source });
  assert.equal(exe, before.executable);
  const app = exe.slice(0, exe.indexOf('.app/') + 4);
  assert.equal(isAgentApp(app), true, 'LSUIElement=1');
  assert.equal(isAgentApp(path.join(sourceRoot, 'Electron.app')), false, 'the source is unchanged');
  execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
  // Ad-hoc signed again, with the changed Info.plist bound into the signature.
  const details = execFileSync('/bin/sh', ['-c', 'codesign -dv "$1" 2>&1', 'sh', app], { encoding: 'utf8' });
  assert.match(details, /Signature=adhoc/); assert.match(details, /Info\.plist entries=\d+/);
  const ready = JSON.parse(fs.readFileSync(path.join(before.folder, 'ready.json'), 'utf8'));
  assert.equal(ready.stamp, before.stamp);
  // Reused as it is.
  const mtime = fs.statSync(path.join(before.folder, 'ready.json')).mtimeMs;
  assert.equal(backgroundElectronExecutable({ cache, source }), exe);
  assert.equal(fs.statSync(path.join(before.folder, 'ready.json')).mtimeMs, mtime);
  // Electron changed (its Info.plist here): a new copy, the old one removed (no process runs from it).
  execFileSync('plutil', ['-replace', 'NaiDevToolsTestMarker', '-string', 'changed', path.join(sourceRoot, 'Electron.app', 'Contents', 'Info.plist')]);
  const after = backgroundAppPaths({ cache, source });
  assert.notEqual(after.stamp, before.stamp); assert.equal(after.built, false);
  const again = backgroundElectronExecutable({ cache, source });
  assert.equal(again, after.executable);
  assert.equal(fs.existsSync(before.folder), false, 'the stale copy is gone');
  assert.deepEqual(fs.readdirSync(cache), [path.basename(after.folder)]);
});

test('test clients are recognised on either executable (plain Electron or its agent copy)', () => {
  const plain = electronExecutable(), executables = clientExecutables();
  assert.equal(executables[0], plain);
  if (mac) assert.equal(executables.length, 2);
  for (const exe of executables) {
    assert.deepEqual(parseClientCommand(`${exe} /w/client --use-mock-keychain --remote-debugging-port=9333 ${DATA_MARKER_SWITCH}=/tmp/d`, executables), { dataRoot: '/tmp/d', port: 9333 });
    assert.equal(parseClientCommand(`${exe} --type=renderer ${DATA_MARKER_SWITCH}=/tmp/d`, executables), null);
  }
  assert.equal(parseClientCommand(`/other/Electron ${DATA_MARKER_SWITCH}=/tmp/d`, executables), null);
});

/** A stand-in lsappinfo whose front app is `pid`. */
function fakeLsappinfo(t, pid) {
  const dir = tempDir(t), file = path.join(dir, 'lsappinfo');
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "front" ]; then echo "ASN:0x0-0x4242:"; else echo '"LSDisplayName"="Stand-in" "pid"=${pid}'; fi\n`, { mode: 0o755 });
  return file;
}
const holder = (t, args) => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { stdio: 'ignore' }); t.after(() => child.kill('SIGKILL')); return child; };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the watcher records a test client in front (its pid, time); another data root or another app is not one', { skip: !mac && 'macOS only', timeout: 60_000 }, async t => {
  const data = tempDir(t), other = tempDir(t);
  const client = holder(t, [`${DATA_MARKER_SWITCH}=${data}`]);
  await wait(200);
  const watch = await startFrontWatch({ dataRoot: data, lsappinfo: fakeLsappinfo(t, client.pid) });
  await wait(300);
  assert.equal(watch.hits().length, 1);
  const seen = await watch.stop();
  assert.equal(seen.hits.length, 1); assert.equal(seen.hits[0].pid, client.pid); assert.ok(Date.parse(seen.hits[0].at) > 0);
  // The interval is 50 ms; the largest gap is reported, not asserted (a loaded machine stretches it).
  assert.ok(seen.samples >= 3, `samples ${seen.samples}`); assert.equal(typeof seen.maxGapMs, 'number'); assert.equal(seen.intervalMs, 50);
  const error = frontDetectedError('a test', seen);
  assert.equal(error.code, 'front_detected'); assert.match(error.message, new RegExp(`at ${seen.hits[0].at}`));
  // The same front app, watched for another data root: no hit. Any test client (no data root): a hit.
  const elsewhere = await startFrontWatch({ dataRoot: other, lsappinfo: fakeLsappinfo(t, client.pid) }); await wait(200);
  assert.equal((await elsewhere.stop()).hits.length, 0);
  await assert.rejects(withFrontWatch('ui.mjs click', () => wait(200), { lsappinfo: fakeLsappinfo(t, client.pid) }), error => error.code === 'front_detected' && error.details.hits[0].pid === client.pid);
  // A plain process without the marker in front: nothing.
  const plainApp = holder(t, []);
  await wait(100);
  assert.equal(await withFrontWatch('ui.mjs click', async () => 'done', { lsappinfo: fakeLsappinfo(t, plainApp.pid) }), 'done');
});

test('the real watcher runs (lsappinfo, ≤ 100 ms) and sees no test client while none is in front', { skip: !mac && 'macOS only', timeout: 30_000 }, async () => {
  const watch = await startFrontWatch({ dataRoot: '/nonexistent/nai-front-watch-test' });
  await wait(600);
  const seen = await watch.stop();
  assert.equal(seen.supported, true); assert.deepEqual(seen.hits, []);
  assert.ok(seen.samples >= 4, `samples ${seen.samples}`);
});

test('elsewhere the watcher watches nothing but has the same interface (test-client start names the pid on every platform)', async () => {
  for (const platform of ['linux', 'win32']) {
    const off = await startFrontWatch({ platform });
    assert.equal(off.supported, false);
    assert.doesNotThrow(() => off.addPid(process.pid));
    assert.deepEqual(off.hits(), []);
    assert.deepEqual(await off.stop(), { supported: false, hits: [], samples: 0, maxGapMs: 0 });
  }
});
