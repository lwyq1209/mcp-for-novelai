// Watches, in a process of its own (front-watch-worker.mjs), whether a dev-tools test client comes to the front (review
// rework 2, 2026-11). macOS only (lsappinfo, every 50 ms); elsewhere it reports `supported: false`. test-client start
// runs it from before the launch until 5 s after the client is ready, and ui.mjs / mcp.mjs during every command; a test
// client in front fails that run with `front_detected` (the times are in the error).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError } from './cli.mjs';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'front-watch-worker.mjs');
export const FRONT_WATCH_INTERVAL_MS = 50;
/** How long test-client start keeps watching after the client is ready. */
export const FRONT_WATCH_AFTER_READY_MS = 5000;

/**
 * Starts watching. `dataRoot`: only that data root's client counts (default: any test client of any data root).
 * Returns {supported, stop()}; stop() resolves to {supported, hits: [{at, pid, name}], samples, maxGapMs, startedAt, stoppedAt}.
 */
export async function startFrontWatch({ dataRoot = null, intervalMs = FRONT_WATCH_INTERVAL_MS, lsappinfo, platform = process.platform } = {}) {
  // The same shape as the real watcher (callers use addPid and hits on any platform), watching nothing.
  if (platform !== 'darwin') return { supported: false, hits: () => [], addPid() {}, stop: async () => ({ supported: false, hits: [], samples: 0, maxGapMs: 0 }) };
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nai-front-watch-')), 'front.jsonl');
  const args = [WORKER, '--out', out, '--interval', String(intervalMs), ...(dataRoot ? ['--data', path.resolve(dataRoot)] : []), ...(lsappinfo ? ['--lsappinfo', lsappinfo] : [])];
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'ignore'], detached: false });
  let exited = false; const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  // The first sample is taken before anything is started.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolError('front_watch_failed', 'The front-app watcher did not start.')), 10_000);
    child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    child.once('exit', code => { clearTimeout(timer); reject(new ToolError('front_watch_failed', `The front-app watcher exited (${code}).`)); });
  });
  child.stdout.resume();
  const read = () => { try { return fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
  let result = null;
  return {
    supported: true,
    /** Hits so far, without stopping. */
    hits: () => read().filter(line => line.type === 'hit'),
    /** Names a test client's pid (known at once, without reading its command line). */
    addPid(pid) { if (!exited && Number.isSafeInteger(pid) && pid > 0) child.stdin.write(`pid ${pid}\n`); },
    async stop() {
      if (result) return result;
      if (!exited) { child.kill('SIGTERM'); await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 5000))]); }
      if (!exited) child.kill('SIGKILL');
      const lines = read(), summary = lines.find(line => line.type === 'summary') ?? {};
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
      result = { supported: true, hits: lines.filter(line => line.type === 'hit').map(({ type, ...hit }) => hit), samples: summary.samples ?? 0, maxGapMs: summary.maxGapMs ?? null, intervalMs: summary.intervalMs ?? intervalMs, startedAt: summary.startedAt ?? null, stoppedAt: summary.stoppedAt ?? null };
      return result;
    },
  };
}

/** The error of a run during which a test client was in front. */
export function frontDetectedError(what, watch, details = {}) {
  const first = watch.hits[0];
  return new ToolError('front_detected', `A dev-tools test client came to the front during ${what} at ${first.at} (pid ${first.pid}${first.name ? `, ${first.name}` : ''}; ${watch.hits.length} time${watch.hits.length === 1 ? '' : 's'}). The run failed.`, { hits: watch.hits, samples: watch.samples, maxGapMs: watch.maxGapMs, ...details });
}

/** Runs `work` while watching (any test client); a test client in front fails it with front_detected. */
export async function withFrontWatch(what, work, options = {}) {
  const watch = await startFrontWatch(options);
  let value, failure = null;
  try { value = await work(); } catch (error) { failure = error; }
  const seen = await watch.stop();
  if (seen.hits.length) throw frontDetectedError(what, seen, failure ? { alsoFailed: failure.message } : {});
  if (failure) throw failure;
  return value;
}
