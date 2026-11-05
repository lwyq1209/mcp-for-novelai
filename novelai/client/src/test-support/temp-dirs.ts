// Cleanup helpers for tests that create temporary directories in os.tmpdir(). Every cleanup in a list runs, even
// when an earlier one throws (a busy file on Windows, a repository or server that fails to close), so one failure
// never leaves the remaining directories behind; the first failure is rethrown afterwards so it stays visible.

export type Cleanup = () => unknown;

/** Runs every cleanup in the given order (awaiting each), then rethrows the first failure, if any. */
export async function runCleanups(cleanups: Iterable<Cleanup>): Promise<void> {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}

/** Synchronous variant for synchronous hooks: runs every cleanup, then rethrows the first failure, if any. */
export function runCleanupsSync(cleanups: Iterable<() => void>): void {
  const failures: unknown[] = [];
  for (const cleanup of cleanups) {
    try { cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw failures[0];
}
