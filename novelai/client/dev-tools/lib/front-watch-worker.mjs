#!/usr/bin/env node
// The front-app watcher process of lib/front-watch.mjs (its own process, so a busy test run never delays a sample).
// macOS only: every --interval ms (≤ 100) `lsappinfo front`; when the front app changes, its pid and command line are
// read once. Each time the front app is a dev-tools test client (its command line carries the data marker, of --data
// when given), one line {type:"hit", at, pid, name} is appended to --out at once. On SIGTERM (or when stdin closes) one
// line {type:"summary", samples, maxGapMs, startedAt, stoppedAt} is appended and the process exits. The first line on
// stdout ("ready") says the first sample was taken. "pid <n>" lines on stdin name a test client's pid directly.
//   node front-watch-worker.mjs --out <file> [--data <dataRoot>] [--interval 50] [--lsappinfo <path>]
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';

const arg = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? fallback : process.argv[index + 1]; };
const out = arg('out'), dataRoot = arg('data', null), interval = Math.min(100, Math.max(10, Number(arg('interval', 50)) || 50)), lsappinfo = arg('lsappinfo', 'lsappinfo');
if (!out) { console.error('--out is required'); process.exit(2); }
const marker = dataRoot ? `--nai-dev-tools-data=${dataRoot}` : '--nai-dev-tools-data=';
const startedAt = new Date().toISOString();
let samples = 0, maxGapMs = 0, previous = Date.now(), lastAsn = null, stopped = false;
// pid → true/false once known, or a pending ps read. Pids the parent names on stdin ("pid <n>") are ours at once.
const ours = new Map(), pending = new Set();
const write = value => fs.appendFileSync(out, `${JSON.stringify(value)}\n`);
const hit = (at, pid, name) => write({ type: 'hit', at: new Date(at).toISOString(), pid, name });
/** A front app's pid: ours right away when known; otherwise its command line is read in the background (sampling goes on)
 * and a hit is written with the time it was seen in front. */
const check = (at, pid, name) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (ours.get(pid) === true) return hit(at, pid, name);
  if (ours.has(pid)) return;
  if (pending.has(pid)) { pending.add(pid); return; }
  pending.add(pid);
  execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }, (error, stdout) => {
    pending.delete(pid);
    const command = error ? '' : String(stdout);
    // The marker of this data root exactly (followed by the end of the command line or another argument).
    const index = command.indexOf(marker), next = index < 0 ? undefined : command[index + marker.length];
    const value = index >= 0 && (!dataRoot || next === undefined || next === ' ' || next === '\n');
    ours.set(pid, value);
    if (value) hit(at, pid, name);
  });
};
function sample() {
  const now = Date.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; samples++;
  let asn = null;
  try { asn = execFileSync(lsappinfo, ['front'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { asn = null; }
  if (!asn || asn === lastAsn) return;
  lastAsn = asn;
  let name = null, pid = null;
  try {
    const info = execFileSync(lsappinfo, ['info', '-only', 'name', '-only', 'pid', asn], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    name = /"LSDisplayName"="([^"]*)"/.exec(info)?.[1] ?? null; pid = Number(/"pid"=(\d+)/.exec(info)?.[1] ?? NaN);
  } catch { /* the app quit meanwhile */ }
  check(now, pid, name);
}
const stop = () => {
  if (stopped) return; stopped = true;
  // A command line still being read decides before the summary (at most 2 s).
  const finish = () => { write({ type: 'summary', samples, maxGapMs, startedAt, stoppedAt: new Date().toISOString(), intervalMs: interval }); process.exit(0); };
  const until = Date.now() + 2000; const wait = () => (!pending.size || Date.now() > until ? finish() : setTimeout(wait, 20)); wait();
};
process.on('SIGTERM', stop); process.on('SIGINT', stop);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; let at; while ((at = input.indexOf('\n')) >= 0) { const line = input.slice(0, at); input = input.slice(at + 1); const match = /^pid (\d+)$/.exec(line.trim()); if (match) ours.set(Number(match[1]), true); } });
process.stdin.on('end', stop); process.stdin.on('error', stop);
sample();
process.stdout.write('ready\n');
const tick = () => { if (stopped) return; sample(); setTimeout(tick, Math.max(0, interval - (Date.now() - previous))); };
setTimeout(tick, interval);
