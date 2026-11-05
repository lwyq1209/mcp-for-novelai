// Vitest globalSetup: the whole run works inside one throwaway folder of the system temp directory, removed again
// when the run ends.
//  - Every test worker (and every child it starts with the inherited environment) uses a data root there, so no test
//    reads or writes the real <appData>/mcp-for-novelai (bridge.json, the tag query cache, default inbox folders). A
//    NOVELAI_DATA_DIR set in the shell is replaced for the run, with a warning, and restored afterwards.
//  - TMPDIR, TMP and TEMP point at a temp folder there, so os.tmpdir() of every worker does too: a worker that dies
//    before its cleanup hooks leaves nothing in the system temp directory. A test that does leave something behind
//    fails the run here and is named: tests clean up after themselves.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export default function isolateTestRun() {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'novelai-client-test-run-')));
  const temp = join(run, 'tmp');
  mkdirSync(temp);
  const previous = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP, NOVELAI_DATA_DIR: process.env.NOVELAI_DATA_DIR };
  const preset = process.env.NOVELAI_DATA_DIR?.trim();
  if (preset) console.warn(`[test isolation] NOVELAI_DATA_DIR=${preset} from the environment is replaced by this run's throwaway data root; no test reads or writes it.`);
  process.env.NOVELAI_DATA_DIR = join(run, 'data'); mkdirSync(process.env.NOVELAI_DATA_DIR);
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = temp;
  return () => {
    let left = [];
    // node-compile-cache is Node's own module compile cache (tools such as TypeScript turn it on), not test output.
    try { left = readdirSync(temp).filter(name => name !== 'node-compile-cache').sort(); }
    finally {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(run, { recursive: true, force: true });
    }
    if (left.length) {
      // Vitest reports an error thrown here but still exits 0, so the exit code is set as well.
      process.exitCode = 1;
      throw new Error(`[test hygiene] the tests left ${left.length} temporary entr${left.length === 1 ? 'y' : 'ies'} behind (removed now): ${left.join(', ')}`);
    }
  };
}
