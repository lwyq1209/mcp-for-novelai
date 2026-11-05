import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { electronBinary, npmBuildCommand, resolveNpmCli } from '../scripts/win32-launch.mjs';

const win32 = process.platform === 'win32';
const scripts = new URL('../scripts/', import.meta.url);
// start-client.mjs resolves its data root with the shared module; the throwaway tree needs both files.
// The modules the launcher imports besides its own folder: the data root and the shared WMI process start.
const DATA_PATH_FILES = [['src/data-paths.mjs', new URL('../src/data-paths.mjs', import.meta.url)], ['client/shared/runtime/data-paths.cjs', new URL('../client/shared/runtime/data-paths.cjs', import.meta.url)], ['src/win32-process.mjs', new URL('../src/win32-process.mjs', import.meta.url)]];

test('resolveNpmCli prefers an npm-cli.js npm_execpath, else the npm next to node, else explains', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe', bundled = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const own = 'D:\\npm\\bin\\npm-cli.js';
  assert.equal(resolveNpmCli({ env: { npm_execpath: own }, execPath, exists: file => file === own || file === bundled }), own);
  assert.equal(resolveNpmCli({ env: { npm_execpath: 'D:\\pnpm\\bin\\pnpm.cjs' }, execPath, exists: file => file === bundled }), bundled);
  assert.equal(resolveNpmCli({ env: { npm_execpath: own }, execPath, exists: file => file === bundled }), bundled);
  assert.throws(() => resolveNpmCli({ env: {}, execPath, exists: () => false }), /npm-cli\.js.*--no-build/s);
  assert.deepEqual(npmBuildCommand({ env: {}, execPath, exists: file => file === bundled }), { command: execPath, parameters: [bundled, 'run', 'build'] });
});

test('electronBinary explains a missing path.txt or dist binary instead of downloading', () => {
  const client = 'C:\\repo\\novelai\\client', exe = 'C:\\repo\\novelai\\client\\node_modules\\electron\\dist\\electron.exe';
  const missing = () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.throws(() => electronBinary(client, { read: missing, exists: () => true }), /path\.txt is missing.*install\.js/s);
  assert.throws(() => electronBinary(client, { read: () => 'electron.exe\n', exists: () => false }), /Electron binary is missing.*install\.js/s);
  assert.throws(() => electronBinary(client, { read: () => '  \n', exists: () => true }), /Electron binary is missing/);
  assert.equal(electronBinary(client, { read: () => 'electron.exe\n', exists: file => file === exe }), exe);
});

// Copy the real launcher into a throwaway tree and replace child_process.spawn
// through a preload, so no npm build and no Electron process ever starts.
async function launcherTree(t, { pathTxt = 'electron.exe', binary = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'start-client-')); t.after(() => rm(base, { recursive: true, force: true }));
  const tree = join(base, 'Tree'), novelai = join(tree, 'novelai'), electron = join(novelai, 'client', 'node_modules', 'electron');
  await mkdir(join(novelai, 'scripts'), { recursive: true }); await mkdir(join(electron, 'dist'), { recursive: true });
  for (const name of ['start-client.mjs', 'win32-launch.mjs']) await copyFile(new URL(name, scripts), join(novelai, 'scripts', name));
  for (const [relative, source] of DATA_PATH_FILES) { await mkdir(join(novelai, relative, '..'), { recursive: true }); await copyFile(source, join(novelai, relative)); }
  // Every launch names a throwaway data folder, so no lock, bridge.json or client data of the real one is touched.
  const dataDir = join(base, 'Data');
  if (pathTxt !== null) await writeFile(join(electron, 'path.txt'), pathTxt);
  if (binary) await writeFile(join(electron, 'dist', 'electron.exe'), '');
  const log = join(base, 'spawn.jsonl'), preload = join(base, 'fake-spawn.mjs');
  await writeFile(preload, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
const cp = createRequire(import.meta.url)('node:child_process');
cp.spawn = (command, parameters, options) => {
  appendFileSync(process.env.FAKE_SPAWN_LOG, JSON.stringify({ command, parameters, cwd: options.cwd, shell: options.shell ?? null, dataDir: options.env.NOVELAI_DATA_DIR }) + '\\n');
  const child = new EventEmitter(); setImmediate(() => child.emit('exit', Number(process.env.FAKE_SPAWN_EXIT || 0), null)); return child;
};
syncBuiltinESMExports();
`);
  const real = realpathSync.native(tree), wrong = real.toUpperCase();
  assert.notEqual(wrong, real);
  const run = (args = [], exit = 0) => {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, join(wrong, 'novelai', 'scripts', 'start-client.mjs'), '--data-dir', dataDir, ...args],
      { cwd: wrong, env: { ...process.env, FAKE_SPAWN_LOG: log, FAKE_SPAWN_EXIT: String(exit) }, encoding: 'utf8' });
    return { status: result.status, stderr: result.stderr };
  };
  const spawns = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  return { real, wrong, run, spawns, dataDir };
}

test('win32: launched through a wrong-case path, Electron gets the real-case client and the --data-dir data root', { skip: !win32 && 'win32 only' }, async t => {
  const f = await launcherTree(t);
  const result = f.run(['--no-build']); assert.equal(result.status, 0, result.stderr);
  const client = join(f.real, 'novelai', 'client');
  assert.deepEqual(await f.spawns(), [{ command: join(client, 'node_modules', 'electron', 'dist', 'electron.exe'), parameters: ['.'], cwd: client, shell: null, dataDir: f.dataDir }]);
});

test('win32: the build runs npm-cli.js with this Node and no shell, then starts Electron', { skip: !win32 && 'win32 only' }, async t => {
  const f = await launcherTree(t);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const [build, electron, ...rest] = await f.spawns(), client = join(f.real, 'novelai', 'client');
  assert.equal(build.command, process.execPath); assert.match(build.parameters[0], /[\\/]npm-cli\.js$/); assert.deepEqual(build.parameters.slice(1), ['run', 'build']);
  assert.equal(build.cwd, client); assert.equal(build.shell, null); assert.equal(build.dataDir, f.dataDir);
  assert.equal(electron.command, join(client, 'node_modules', 'electron', 'dist', 'electron.exe')); assert.deepEqual(rest, []);
});

test('win32: a failed build never starts Electron', { skip: !win32 && 'win32 only' }, async t => {
  const f = await launcherTree(t);
  const result = f.run([], 1); assert.notEqual(result.status, 0); assert.match(result.stderr, /Client exited 1/);
  const spawns = await f.spawns(); assert.equal(spawns.length, 1); assert.equal(spawns[0].command, process.execPath);
});

test('win32: missing path.txt or dist binary exits non-zero with install guidance and starts nothing', { skip: !win32 && 'win32 only' }, async t => {
  const noPath = await launcherTree(t, { pathTxt: null });
  let result = noPath.run(['--no-build']); assert.notEqual(result.status, 0); assert.match(result.stderr, /path\.txt is missing.*install\.js/s);
  assert.deepEqual(await noPath.spawns(), []);
  const noBinary = await launcherTree(t, { binary: false });
  result = noBinary.run(['--no-build']); assert.notEqual(result.status, 0); assert.match(result.stderr, /Electron binary is missing.*install\.js/s);
  assert.deepEqual(await noBinary.spawns(), []);
});
