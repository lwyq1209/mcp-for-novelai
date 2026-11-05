// Preloaded into every test process (node --test --import ./tests/isolate-data-dir.mjs): unless the run already gave
// it one, the test process gets a throwaway data root, and every child it starts with the inherited environment
// uses it. So no test reads or writes the real <appData>/mcp-for-novelai (bridge.json, tag cache, default inbox
// folders). `npm test` (tests/run-tests.mjs) already sets one data root and temp folder for the whole run; this is for
// a single file run directly. Tests that start children with a hand-built environment set their own NOVELAI_DATA_DIR.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The test run's own data root (set by tests/run-tests.mjs, or by this file in a parent test process) is kept; any
// other value, such as one set in the shell, is replaced with a warning, so no test uses a real data folder.
const inherited = process.env.NOVELAI_DATA_DIR?.trim();
if (!inherited || inherited !== process.env.NOVELAI_TEST_RUN_DATA_DIR) {
  if (inherited) console.error(`[test isolation] NOVELAI_DATA_DIR=${inherited} from the environment is replaced by a throwaway data root; no test reads or writes it.`);
  const directory = mkdtempSync(join(tmpdir(), 'novelai-test-data-'));
  process.env.NOVELAI_DATA_DIR = process.env.NOVELAI_TEST_RUN_DATA_DIR = directory;
  const owner = String(process.pid);
  process.env.NOVELAI_TEST_DATA_DIR_OWNER = owner;
  process.once('exit', () => { if (process.env.NOVELAI_TEST_DATA_DIR_OWNER === owner) rmSync(directory, { recursive: true, force: true }); });
}

// A test file whose process is still alive well after its last test (an open handle: a child process, a server, a
// timer) would keep `node --test` waiting forever without naming it. Once every test of this file has finished, an
// unref'd timer gives the process EXIT_GRACE_MS to end on its own; otherwise it names the open resource types and
// fails the file, so the leak is a located failure instead of a hung run.
const EXIT_GRACE_MS = 60_000;
if (process.env.NODE_TEST_CONTEXT) {
  const { after } = await import('node:test');
  after(() => {
    setTimeout(() => {
      console.error(`[test hygiene] this test file is still running ${EXIT_GRACE_MS / 1000} s after its last test; open resources: ${process.getActiveResourcesInfo().join(', ') || 'none reported'}. Close them in the test (t.after).`);
      process.exit(1);
    }, EXIT_GRACE_MS).unref();
  });
}
