// Shared helpers of the dev-tools tests (node:test). Every folder they create is under os.tmpdir(), carries the
// TEMP_PREFIX and is registered: removed by its test's t.after, and — should a test end without its after hooks
// (a crash, a timeout) — once more when the test process exits. tests/temp-cleanup.test.mjs runs the whole suite
// with an empty temp folder and checks that nothing is left in it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const devToolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMP_PREFIX = 'nai-devtools-test-';

const registered = new Set();
process.once('exit', () => { for (const dir of registered) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ } } });

/** A new registered folder under os.tmpdir(); remove it with removeTempDir (or it goes at process exit). */
export function makeTempDir(prefix = TEMP_PREFIX) {
  if (!prefix.startsWith(TEMP_PREFIX)) throw new Error(`Test temp folders start with ${TEMP_PREFIX} (got ${prefix}).`);
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  registered.add(dir);
  return dir;
}

export function removeTempDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  registered.delete(dir);
}

/** A registered temp folder removed after test `t`. */
export function tempDir(t, prefix = TEMP_PREFIX) {
  const dir = makeTempDir(prefix);
  t.after(() => removeTempDir(dir));
  return dir;
}

/** Runs one dev-tools CLI and parses its JSON output. */
export function runCli(script, args, options = {}) {
  const result = spawnSync(process.execPath, [path.join(devToolsDir, script), ...args], { encoding: 'utf8', timeout: options.timeout ?? 60_000, env: { ...process.env, ...(options.env ?? {}) } });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { json = null; }
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

/** runCli without blocking this process (needed while this process serves something the CLI talks to). */
export async function runCliAsync(script, args, options = {}) {
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(devToolsDir, script), ...args], { env: { ...process.env, ...(options.env ?? {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 60_000);
    child.once('close', status => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ status, json, stdout, stderr });
    });
  });
}
