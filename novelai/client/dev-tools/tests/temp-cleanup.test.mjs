// Runs every other dev-tools test file once more in a child `node --test` whose temp folder (TMPDIR/TMP/TEMP) is a
// new empty folder, and checks that the folder is empty afterwards: no test or tool leaves anything in the OS temp
// folder. (npm itself, not a test, creates <temp>/node-compile-cache when the suite is started with `npm run`; see
// the README. This check starts node directly, so nothing is excused.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMP_PREFIX, tempDir } from './helpers.mjs';

const SELF = path.basename(fileURLToPath(import.meta.url));
const NESTED = 'NAI_DEVTOOLS_TEMP_CHECK';

test('the whole suite leaves nothing in an empty temp folder', { skip: process.env[NESTED] === '1' ? 'nested run' : false, timeout: 240_000 }, async t => {
  const root = path.join(tempDir(t), 'tmpdir');
  fs.mkdirSync(root);
  const testsDir = path.dirname(fileURLToPath(import.meta.url));
  const files = fs.readdirSync(testsDir).filter(name => name.endsWith('.test.mjs') && name !== SELF).sort().map(name => path.join(testsDir, name));
  assert.ok(files.length >= 6, `the other test files are found (${files.length})`);
  const env = { ...process.env, TMPDIR: root, TMP: root, TEMP: root, [NESTED]: '1' };
  // The child is a test run of its own, not a subtest of this one.
  delete env.NODE_TEST_CONTEXT;
  const run = await new Promise(resolve => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=dot', ...files], { cwd: path.resolve(testsDir, '..', '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 220_000);
    child.once('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
  assert.equal(run.status, 0, `the nested suite passes:\n${run.output.slice(-4000)}`);
  const left = fs.readdirSync(root);
  assert.deepEqual(left.filter(name => name.startsWith(TEMP_PREFIX)), [], 'no test folder is left behind');
  assert.deepEqual(left, [], 'nothing else is left in the temp folder either');
});
