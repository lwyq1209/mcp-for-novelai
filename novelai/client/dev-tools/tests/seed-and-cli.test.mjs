import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dataRootRefusal } from '../lib/guard.mjs';
import { buildOutputs, clientRequire, dataPaths } from '../lib/paths.mjs';
import { imageSize } from '../lib/images.mjs';
import { parseSizeList, seedLibrary } from '../lib/seed.mjs';
import { AGENT_START_SWITCH, BACKGROUND_WINDOW_ENV, clientArgs, clientEnv, quietStartResult } from '../test-client.mjs';
import { runCli, tempDir } from './helpers.mjs';

const built = fs.existsSync(buildOutputs.repository);

test('seed-library builds a consistent library through the client repository', async t => {
  if (!built) return t.skip('client not built');
  const data = path.join(tempDir(t), 'data');
  const result = await seedLibrary({ data, history: 60, tags: 10, combos: 3, notes: 2, imports: 3, favorites: 3, collections: 2, trash: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.history.strictValidationRefusals, 0, 'every history record passes the generated-history schema');
  const { openLibraryRepository } = clientRequire(buildOutputs.repository);
  const repo = openLibraryRepository({ filePath: path.join(data, 'library.sqlite'), readOnly: true });
  try {
    assert.equal(repo.integrityCheck(), 'ok');
    const history = repo.all('history');
    assert.equal(history.length, 60 - 4, 'four history images went to Recently Deleted');
    for (const item of history) assert.ok(fs.existsSync(item.payload.filePath), 'every history file exists where its record says');
    // Projects carry their names (putCollection before the items joined them), not their ids.
    const projects = repo.collections('history');
    assert.equal(projects.length, 6);
    assert.ok(projects.every(group => group.name !== group.id));
    assert.equal(repo.collections('user').length, 2);
    assert.equal(repo.all('study').length, 3);
    assert.equal(repo.all('tag').length, 10 - 1);
  } finally { repo.close(); }
  // Revisions are continuous: every item at revision n has versions 1…n.
  const db = new DatabaseSync(path.join(data, 'library.sqlite'), { readOnly: true });
  try {
    const gaps = db.prepare('SELECT i.kind, i.id, i.revision, (SELECT count(*) FROM versions v WHERE v.kind=i.kind AND v.id=i.id) AS versions FROM items i WHERE versions != i.revision').all();
    assert.deepEqual(gaps, []);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM trash_entries").get().n), 5);
  } finally { db.close(); }
  assert.ok(fs.readdirSync(path.join(data, 'trash')).length >= 1, 'deleted files moved into the trash folder');
});

test('seed-library --sizes, --preset-images and --marks: history and preset images of the given sizes', async t => {
  if (!built) return t.skip('client not built');
  const data = path.join(tempDir(t), 'sized');
  const minimal = { tags: 0, combos: 0, notes: 0, imports: 0, favorites: 0, collections: 0, stylePresets: 2, positivePresets: 1, chunks: 0, referencePresets: 0 };
  const result = await seedLibrary({ data, history: 3, sizes: '832x1216,64x64', presetImages: [[1216, 832], [24, 24]], marks: true, imageScale: 8, ...minimal });
  assert.equal(result.counts.presetImages, 4);
  const { openLibraryRepository } = clientRequire(buildOutputs.repository);
  const repo = openLibraryRepository({ filePath: path.join(data, 'library.sqlite'), readOnly: true });
  try {
    // Newest first, the sizes in order and repeated; the files are 1/--image-scale of them (at least 8 px).
    const history = repo.all('history').map(item => item.payload).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    assert.deepEqual(history.map(item => [item.width, item.height]), [[832, 1216], [64, 64], [832, 1216]]);
    assert.deepEqual(history.map(item => imageSize(fs.readFileSync(item.filePath))).map(size => [size.width, size.height]), [[104, 152], [8, 8], [104, 152]]);
    // The first Style preset and the first prompt preset, in the folders the host's image entry point uses.
    const style = repo.get('style_preset', 'sp-01').payload.previewImages, positive = repo.get('positive_preset', 'pp-01').payload.previewImages;
    assert.deepEqual(style.map(image => path.relative(data, path.dirname(image.filePath))), ['style-prompt-previews/sp-01', 'style-prompt-previews/sp-01'].map(value => value.split('/').join(path.sep)));
    assert.deepEqual(positive.map(image => path.relative(data, path.dirname(image.filePath))), ['style-prompt-previews/positive-prompt-pp-01', 'style-prompt-previews/positive-prompt-pp-01'].map(value => value.split('/').join(path.sep)));
    assert.deepEqual(style.map(image => imageSize(fs.readFileSync(image.filePath))).map(size => [size.width, size.height]), [[152, 104], [8, 8]]);
    assert.equal(repo.get('style_preset', 'sp-02').payload.previewImages, undefined, 'only the first preset gets images');
    assert.equal(repo.integrityCheck(), 'ok');
  } finally { repo.close(); }
});

test('size lists: parsed, or refused with a usage error', t => {
  assert.equal(parseSizeList(undefined), null);
  assert.deepEqual(parseSizeList('832x1216, 64X64,1024×1024'), [[832, 1216], [64, 64], [1024, 1024]]);
  assert.deepEqual(parseSizeList([[1, 2]]), [[1, 2]]);
  for (const bad of ['832', '0x10', '10x', '9000x10', '']) assert.throws(() => parseSizeList(bad, 'sizes'), error => error.code === 'usage' && /--sizes/.test(error.message), bad);
  const data = path.join(tempDir(t), 'never');
  const cli = runCli('seed-library.mjs', ['--data', data, '--preset-images', '1x1,2x2,3x3,4x4']);
  assert.equal(cli.status, 2);
  assert.match(cli.json.error.message, /at most 3/);
  assert.equal(fs.existsSync(data), false, 'refused before the data root is made');
});

test('seed-library refuses a data root that is not empty', async t => {
  if (!built) return t.skip('client not built');
  const data = tempDir(t);
  fs.writeFileSync(path.join(data, 'library.sqlite'), '');
  const run = runCli('seed-library.mjs', ['--data', data, '--history', '1', '--adopt']);
  assert.equal(run.status, 2, 'unknown option --adopt is refused');
  const refused = runCli('seed-library.mjs', ['--data', data, '--history', '1']);
  assert.equal(refused.status, 3);
  assert.equal(refused.json.error.code, 'refused_unmarked');
});

test('CLIs refuse a missing --data and real locations before doing anything', t => {
  // This platform's real data root (<appData>/mcp-for-novelai) and a folder inside its default output folder.
  const real = path.join(dataPaths.appDataDirectory(), 'mcp-for-novelai');
  const pictures = path.join(dataPaths.defaultOutputDirectory(path.join(os.homedir(), 'Pictures'), { env: {} }), 'dev-tools-never');
  // Checked here first: a CLI is never started on a real location the guard would let through.
  for (const location of [real, pictures]) assert.ok(dataRootRefusal(location), `the guard refuses ${location}`);
  const cases = [
    ['test-client.mjs', ['start'], 'refused_no_data'],
    ['test-client.mjs', ['start', '--data', real], 'refused_location'],
    ['test-client.mjs', ['start', '--data', pictures], 'refused_location'],
    ['test-client.mjs', ['start', '--data', '/Users/Alice/Projects/mcp-for-novelai/novelai/.runtime'], 'refused_location'],
    ['test-client.mjs', ['stop'], 'refused_no_data'],
    ['test-client.mjs', ['stop', '--data', real], 'refused_location'],
    ['mcp.mjs', ['call', 'list_queue', '{}'], 'refused_no_data'],
    ['mcp.mjs', ['call', 'list_queue', '{}', '--data', real], 'refused_location'],
    ['seed-library.mjs', [], 'refused_no_data'],
    ['seed-library.mjs', ['--data', pictures], 'refused_location'],
  ];
  for (const [script, args, code] of cases) {
    const run = runCli(script, args);
    assert.equal(run.json?.error?.code, code, `${script} ${args.join(' ')} → ${run.stdout}`);
    assert.equal(run.status, 3);
  }
  assert.equal(fs.existsSync(pictures), false, 'nothing was created in Pictures');
  assert.equal(runCli('test-client.mjs', ['start', '--data', path.join(tempDir(t), 'x'), '--no-such-option', '1']).status, 2);
});

test('test-client status lists only clients of this checkout', () => {
  const run = runCli('test-client.mjs', ['status']);
  assert.equal(run.status, 0);
  assert.equal(run.json.ok, true);
  for (const client of run.json.clients) assert.ok(client.dataRoot, 'every listed client has the dev-tools data marker');
});

test('--quiet: seed-library prints only the counts and the time', async t => {
  if (!built) return t.skip('client not built');
  const data = path.join(tempDir(t), 'quiet');
  const run = runCli('seed-library.mjs', ['--data', data, '--history', '6', '--tags', '2', '--combos', '1', '--notes', '1', '--imports', '1', '--favorites', '1', '--collections', '1', '--quiet']);
  assert.equal(run.status, 0, run.stdout);
  assert.deepEqual(Object.keys(run.json), ['ok', 'dataRoot', 'counts', 'totalMs']);
  assert.equal(run.json.counts.history, 6);
  assert.ok(run.json.totalMs >= 0);
  assert.ok(run.stdout.length < 1000, `short output (${run.stdout.length} bytes)`);
});

test('--quiet: test-client start keeps pid, port, data root and ready times; fake-novelai start keeps url and pid', async t => {
  const full = { ok: true, pid: 42, dataRoot: '/tmp/x', port: 9333, cdp: 'http://127.0.0.1:9333', fakeNovelai: 'http://127.0.0.1:1', bridgeReadyMs: 1200, logFile: '/tmp/x/.dev-tools/client.log', settings: { endpoint: 'x', fakeTokenWritten: true }, window: { applied: true, viewport: {} }, cdpReadyMs: 2100 };
  assert.deepEqual(quietStartResult(full), { ok: true, pid: 42, port: 9333, dataRoot: '/tmp/x', bridgeReadyMs: 1200, cdpReadyMs: 2100 });
  assert.deepEqual(quietStartResult({ ...full, port: null, cdpReadyMs: undefined, window: { applied: false, reason: '--size needs --port (the window is resized through DevTools).' } }), { ok: true, pid: 42, dataRoot: '/tmp/x', bridgeReadyMs: 1200, windowSizeApplied: false, windowSizeReason: '--size needs --port (the window is resized through DevTools).' });
  // A size the OS clamped says so (the screen's work area).
  const clamped = quietStartResult({ ...full, window: { applied: false, requested: { width: 1440, height: 900 }, viewport: { width: 1440, height: 893, screen: { width: 1512, height: 893 } } } });
  assert.equal(clamped.windowSizeApplied, false);
  assert.match(clamped.windowSizeReason, /1512×893/);
  assert.equal(runCli('test-client.mjs', ['start', '--quiet']).json.error.code, 'refused_no_data', '--quiet is a known start option');

  const dir = path.join(tempDir(t), 'fake');
  const started = runCli('fake-novelai.mjs', ['start', '--dir', dir, '--quiet', '--fault', 'generation:1:500']);
  t.after(() => runCli('fake-novelai.mjs', ['stop', '--dir', dir]));
  assert.equal(started.status, 0, started.stdout);
  assert.deepEqual(Object.keys(started.json), ['ok', 'url', 'port', 'pid', 'faults']);
  assert.equal(started.json.faults, 1);
  const stopped = runCli('fake-novelai.mjs', ['stop', '--dir', dir]);
  assert.equal(stopped.json.stopped, true);
});

test('--help prints the usage text of every CLI (plain text, exit 0)', () => {
  for (const script of ['test-client.mjs', 'ui.mjs', 'fake-novelai.mjs', 'seed-library.mjs', 'mcp.mjs']) {
    for (const flag of ['--help', '-h']) {
      const run = runCli(script, [flag]);
      assert.equal(run.status, 0, `${script} ${flag}`);
      assert.equal(run.json, null, 'not JSON');
      assert.match(run.stdout, new RegExp(`node dev-tools/${script.replace('.', '\\.')}`));
    }
  }
  const ui = runCli('ui.mjs', ['--help']).stdout;
  assert.match(ui, /--nth n is a 0-BASED index among the VISIBLE matches: --nth 0 \(the default\) is the first visible match/);
  for (const command of ['dialog-text', 'toasts', '--replace']) assert.ok(ui.includes(command), command);
  const fake = runCli('fake-novelai.mjs', ['--help']).stdout;
  for (const option of ['respond', '--body', '--json', '--body-file', '--content-type', '--header']) assert.ok(fake.includes(option), option);
});

test('test-client --agent-start adds the switch an agent\'s MCP server starts the app with, before the data marker', () => {
  const plain = clientArgs({ dataRoot: '/tmp/root', port: 9333 });
  assert.equal(plain.at(-1), '--nai-dev-tools-data=/tmp/root'); assert.ok(!plain.some(arg => arg.startsWith('--started-by-agent')));
  const agent = clientArgs({ dataRoot: '/tmp/root', port: 9333, agentStart: true, allowOcclusion: true });
  assert.deepEqual(agent.slice(-2), [AGENT_START_SWITCH, '--nai-dev-tools-data=/tmp/root']);
  assert.ok(!agent.includes('--disable-renderer-backgrounding'), '--allow-occlusion drops the visibility switches');
  // The switch is the one the client reads (electron/window-show.ts) and the MCP server sends (novelai/src/app-launch.mjs).
  const windowShow = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../electron/window-show.ts'), 'utf8');
  assert.match(windowShow, /STARTED_BY_AGENT_ARG = '--started-by-agent';/);
  assert.ok(AGENT_START_SWITCH.startsWith('--started-by-agent='));
});

test('test-client start runs the window in the background unless --foreground (step 4c1)', () => {
  const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1', NAI_UI_CAPTURE_PATH: '/x.png', [BACKGROUND_WINDOW_ENV]: '1' };
  const background = clientEnv(base, { dataRoot: '/tmp/root' });
  assert.equal(background[BACKGROUND_WINDOW_ENV], '1');
  assert.equal(background.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(background.NAI_UI_CAPTURE_PATH, undefined);
  const foreground = clientEnv(base, { dataRoot: '/tmp/root', foreground: true });
  assert.equal(foreground[BACKGROUND_WINDOW_ENV], undefined, 'an inherited switch is dropped too');
  assert.equal(background.PATH, '/usr/bin');
  // The name is the one the client reads (electron/window-show.ts).
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../electron/window-show.ts'), 'utf8');
  assert.match(source, new RegExp(`BACKGROUND_WINDOW_ENV = '${BACKGROUND_WINDOW_ENV}'`));
});
