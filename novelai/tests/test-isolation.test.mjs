// Review rework 2 (test isolation): a test file run on its own — `node --test tests/x.test.mjs` or `node x.test.mjs`,
// outside tests/run-tests.mjs — can never read or write the real data root. data-paths refuses the default root in a
// test process that has no NOVELAI_DATA_DIR. Every child here gets a throwaway HOME, so even a regression could only
// write into that folder, which is checked to stay empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataPaths = join(root, 'client/shared/runtime/data-paths.cjs');
/** The environment of a fresh shell: no data root, no test context, a throwaway HOME. */
function shellEnv(home) {
  // Its own temp folder too: a file that stops at import (refused) may leave its temp folders behind.
  const temp = mkdtempSync(join(tmpdir(), 'isolation-tmp-')); process.once('exit', () => rmSync(temp, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: join(home, 'AppData'), TMPDIR: temp, TMP: temp, TEMP: temp };
  for (const key of ['NOVELAI_DATA_DIR', 'NOVELAI_TEST_RUN_DATA_DIR', 'NOVELAI_TEST_DATA_DIR_OWNER', 'NOVELAI_PROJECT_ROOT', 'NODE_TEST_CONTEXT', 'VITEST']) delete env[key];
  return env;
}
const listed = dir => existsSync(dir) ? readdirSync(dir, { recursive: true }) : [];

test('a test process without NOVELAI_DATA_DIR is refused the default data root and project root (node --test, node x.test.mjs, Vitest)', t => {
  const home = mkdtempSync(join(tmpdir(), 'isolation-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const probe = join(home, 'probe.test.mjs');
  writeFileSync(probe, `import { createRequire } from 'node:module';
const paths = createRequire(import.meta.url)(${JSON.stringify(dataPaths)});
const outcome = what => { try { return what(); } catch (error) { return { refused: error.code }; } };
console.log('RESULT ' + JSON.stringify({ root: outcome(() => paths.resolveDataRoot()), project: outcome(() => paths.resolveProjectRoot()), output: outcome(() => paths.defaultOutputDirectory('/x/Pictures')),
  explicit: paths.resolveDataRoot({ platform: 'darwin', env: {}, homedir: '/Users/u' }), withRoot: paths.resolveDataRoot({ env: { NOVELAI_DATA_DIR: '/tmp/d' } }) }));
`);
  const read = result => JSON.parse(/RESULT (.*)/.exec(`${result.stdout}`)?.[1] ?? 'null');
  const refused = { refused: 'test_isolation_required' };
  for (const [label, args, extra] of [['node --test', ['--test', probe], {}], ['node x.test.mjs', [probe], {}], ['Vitest worker', ['-e', `import(${JSON.stringify(pathToFileURL(probe).href)})`], { VITEST: 'true' }]]) {
    const result = spawnSync(process.execPath, args, { env: { ...shellEnv(home), ...extra }, encoding: 'utf8' });
    const value = read(result);
    assert.ok(value, `${label}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(value.root, refused, label); assert.deepEqual(value.project, refused, label);
    // The output folder is only a path under the Pictures folder the caller passes (Electron's, mocked in tests),
    // joined with this platform's separator.
    assert.equal(value.output, join('/x/Pictures', 'MCP for NovelAI'), label);
    // Explicit options only compute paths; NOVELAI_DATA_DIR is used as always (resolved on this platform: D:\tmp\d on Windows).
    assert.equal(value.explicit, '/Users/u/Library/Application Support/mcp-for-novelai', label); assert.equal(value.withRoot, resolve('/tmp/d'), label);
  }
  // Outside a test process nothing changes: the default root is computed.
  const plain = join(home, 'probe.mjs'); writeFileSync(plain, `import { createRequire } from 'node:module'; console.log('RESULT ' + JSON.stringify({ root: createRequire(import.meta.url)(${JSON.stringify(dataPaths)}).resolveDataRoot() }));`);
  const normal = read(spawnSync(process.execPath, [plain], { env: shellEnv(home), encoding: 'utf8' }));
  assert.ok(typeof normal.root === 'string' && normal.root.startsWith(home), JSON.stringify(normal));
  assert.deepEqual(listed(home).filter(name => !/^probe/.test(name)), [], 'nothing was written under HOME');
});

test('mcp-merge.test.mjs run directly with node --test cannot reach the real data root; with the isolation preload it passes', { timeout: 120_000 }, t => {
  const home = mkdtempSync(join(tmpdir(), 'isolation-home-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const args = ['--test', '--test-name-pattern', 'N10 host methods', 'tests/mcp-merge.test.mjs'];
  const direct = spawnSync(process.execPath, args, { cwd: root, env: shellEnv(home), encoding: 'utf8' });
  assert.notEqual(direct.status, 0, 'refused, not run against the default root');
  assert.match(`${direct.stdout}${direct.stderr}`, /test isolation/);
  const isolated = spawnSync(process.execPath, ['--import', './tests/isolate-data-dir.mjs', ...args], { cwd: root, env: shellEnv(home), encoding: 'utf8' });
  assert.equal(isolated.status, 0, `${isolated.stdout}${isolated.stderr}`.slice(-3000));
  assert.deepEqual(listed(home), [], 'nothing was written under HOME (no Library/Application Support/mcp-for-novelai)');
});
