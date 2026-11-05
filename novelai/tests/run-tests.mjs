#!/usr/bin/env node
// `npm test`: runs `node --test` over the given files inside one throwaway folder of the system temp directory, then
// removes it. The run's data root (NOVELAI_DATA_DIR, always: a value set in the shell is replaced, with a warning, so
// no test ever writes into a real data folder) and temp folder (TMPDIR, TMP and TEMP, so
// os.tmpdir() in every test process and every child it starts with the inherited environment) live there, so even a
// test process that crashes before its cleanup hooks run leaves nothing behind. A test that does leave something in
// the temp folder fails the run and is named here: tests clean up after themselves.
//   node tests/run-tests.mjs [node --test arguments …]
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = realpathSync(mkdtempSync(join(tmpdir(), 'novelai-test-run-')));
let status = 1;
try {
  const temp = join(run, 'tmp');
  mkdirSync(temp);
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
  const preset = process.env.NOVELAI_DATA_DIR?.trim();
  if (preset) console.error(`[test isolation] NOVELAI_DATA_DIR=${preset} from the environment is replaced by this run's throwaway data root; no test reads or writes it.`);
  // NOVELAI_TEST_RUN_DATA_DIR tells tests/isolate-data-dir.mjs in every test process that this data root is the run's own.
  env.NOVELAI_DATA_DIR = env.NOVELAI_TEST_RUN_DATA_DIR = join(run, 'data'); mkdirSync(env.NOVELAI_DATA_DIR);
  const child = spawnSync(process.execPath, ['--test', '--import', './tests/isolate-data-dir.mjs', ...process.argv.slice(2)], { stdio: 'inherit', env });
  if (child.error) throw child.error;
  status = child.status ?? 1;
  // node-compile-cache is Node's own module compile cache (tools such as TypeScript turn it on), not test output.
  const left = readdirSync(temp).filter(name => name !== 'node-compile-cache').sort();
  if (left.length) {
    console.error(`\n[test hygiene] the tests left ${left.length} temporary entr${left.length === 1 ? 'y' : 'ies'} behind (removed now): ${left.join(', ')}`);
    if (status === 0) status = 1;
  }
} finally {
  rmSync(run, { recursive: true, force: true });
}
process.exit(status);
