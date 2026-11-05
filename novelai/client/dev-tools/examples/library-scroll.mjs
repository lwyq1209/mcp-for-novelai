#!/usr/bin/env node
// Library performance baseline (measures only): start a test client on a seeded data root, open the library, wheel-
// scroll the history grid to the very end, and report the times, the renderer's memory and the page errors.
// A virtual grid (oss/lib-1103) unmounts the tiles it scrolls past: the scroll container is then found again from a
// tile that is shown, and the grid's data-total (the items loaded) tells how far the list has loaded. After the plain
// measurement (as the baseline took it) the renderer's garbage is collected and it is measured once more.
//   node dev-tools/examples/library-scroll.mjs --data <seeded data root> [--fake-novelai <url>] [--shots <folder>]
//        [--delta 1200] [--timeout 600]
// Seed first, e.g.: node dev-tools/seed-library.mjs --data .tmp/perf-10k --history 10000
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli, sleep } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { checkDataRoot } from '../lib/guard.mjs';
import { listProcesses, readPidFile } from '../lib/processes.mjs';
import { startClient, stopClient } from '../test-client.mjs';

/** Resident memory (MiB) of the client's processes: main (pid file) and the Chromium helpers of its data root. */
function processMemory(dataRoot, mainPid) {
  const rows = listProcesses().filter(row => row.pid === mainPid || row.command.includes(`--user-data-dir=${dataRoot}`));
  if (process.platform === 'win32' || !rows.length) return null;
  const rss = execFileSync('ps', ['-o', 'pid=,rss=', '-p', rows.map(row => row.pid).join(',')], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const byPid = new Map(rss.map(([pid, kib]) => [pid, +(kib / 1024).toFixed(1)]));
  const kind = row => row.pid === mainPid ? 'main' : (/--type=(\S+)/.exec(row.command)?.[1] ?? 'other');
  const result = {};
  for (const row of rows) { const key = kind(row); result[key] = +((result[key] ?? 0) + (byPid.get(row.pid) ?? 0)).toFixed(1); }
  return result;
}

async function main(argv) {
  const { options } = parseArgs(argv);
  allowOptions(options, ['data', 'fake-novelai', 'shots', 'delta', 'timeout', 'settle']);
  const { dataRoot } = checkDataRoot(String(options.data ?? ''));
  const deltaY = Number(options.delta ?? 1200), timeoutMs = Number(options.timeout ?? 600) * 1000, settleMs = Number(options.settle ?? 50);
  const shots = options.shots ? path.resolve(String(options.shots)) : null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  let fake = null, page = null, started = null;
  const report = { dataRoot };
  try {
    // No real endpoint is ever contacted: without --fake-novelai a local fake answers the account calls.
    if (!options['fake-novelai']) fake = await startFakeNovelAI();
    const t0 = Date.now();
    started = await startClient({ data: dataRoot, port: 'auto', 'fake-novelai': options['fake-novelai'] ?? fake.url, locale: 'zh-CN' });
    report.start = { bridgeReadyMs: started.bridgeReadyMs, cdpReadyMs: started.cdpReadyMs };
    page = await connectPage({ port: started.port });
    await page.captureConsole();
    await page.route('library');
    await page.wait('[data-testid^="tile-"]', { timeoutMs: 120_000 });
    report.start.firstTileMs = Date.now() - t0;
    // The header of the history view says "历史成图 N 张" (the sidebar count has no 张).
    const header = () => page.evaluate(() => { const match = /历史成图\s*(\d[\d,]*)\s*张/.exec(document.querySelector('[data-testid="library-page"]')?.innerText ?? ''); return match ? Number(match[1].replace(/,/g, '')) : null; });
    const total = await pollUntil(header, { timeoutMs: 10_000 });
    report.libraryTotal = total;
    await sleep(1500);
    report.before = { metrics: await page.metrics(), memoryMiB: processMemory(dataRoot, started.pid) };
    delete report.before.metrics.raw;
    if (shots) await page.screenshot(path.join(shots, 'scroll-top.png'));

    // Wheel-scroll over the grid until the scroll container no longer moves and no tiles are added for a while.
    const tile = await page.resolve({ css: '[data-testid^="tile-"]', mark: true });
    const { x, y } = tile.point;
    const state = () => page.evaluate(() => {
      let el = window.__devToolsTarget;
      if (!el?.isConnected) el = document.querySelector('[data-testid^="tile-"]');
      while (el && el !== document.documentElement && !(el.scrollHeight > el.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))) el = el.parentElement;
      el ??= document.scrollingElement;
      const tiles = document.querySelectorAll('[data-testid^="tile-"]').length, grid = document.querySelector('[data-testid="library-grid"]');
      return { top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight, tiles, loaded: grid?.dataset.total !== undefined ? Number(grid.dataset.total) : tiles };
    });
    const scrollStarted = Date.now();
    let steps = 0, last = await state(), still = 0, slowest = 0, lastChangeMs = 0;
    const samples = [];
    while (Date.now() - scrollStarted < timeoutMs) {
      const stepStarted = Date.now();
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0 });
      await sleep(settleMs);
      const now = await state();
      slowest = Math.max(slowest, Date.now() - stepStarted);
      steps++;
      // Every 50 steps: where it is, and the renderer's DOM nodes, JS heap and resident memory there.
      if (steps % 50 === 0) { const metrics = await page.metrics(); samples.push({ steps, ms: Date.now() - scrollStarted, ...now, nodes: metrics.nodes, jsHeapUsedMiB: metrics.jsHeapUsedMiB, rendererMiB: processMemory(dataRoot, started.pid)?.renderer ?? null }); }
      const moved = now.top !== last.top || now.height !== last.height || now.tiles !== last.tiles || now.loaded !== last.loaded;
      still = moved ? 0 : still + 1;
      if (moved) lastChangeMs = Date.now() - scrollStarted;
      last = now;
      // At the end: bottom reached and nothing changed for ~3 s (pages still loading would grow the height/tiles).
      if (still * settleMs >= 3000 && now.top + now.client >= now.height - 2) break;
    }
    report.scroll = { steps, deltaY, toEndMs: lastChangeMs, elapsedMs: Date.now() - scrollStarted, idleConfirmMs: 3000, slowestStepMs: slowest, end: last, reachedEnd: last.top + last.client >= last.height - 2, tilesAtEnd: last.tiles, loadedAtEnd: last.loaded, samples };
    report.after = { metrics: await page.metrics(), memoryMiB: processMemory(dataRoot, started.pid) };
    delete report.after.metrics.raw;
    // The same after a full garbage collection of the renderer (nodes and heap that are only waiting to be freed).
    await page.cdp.send('HeapProfiler.collectGarbage').catch(() => undefined);
    await sleep(1500);
    report.afterGc = { metrics: await page.metrics(), memoryMiB: processMemory(dataRoot, started.pid), liveElements: await page.evaluate(() => document.getElementsByTagName('*').length) };
    delete report.afterGc.metrics.raw;
    if (shots) await page.screenshot(path.join(shots, 'scroll-end.png'));
    const errors = page.consoleEntries({ errorsOnly: true });
    report.pageErrors = { count: errors.length, entries: errors.slice(0, 20) };
    report.consoleWarnings = page.consoleEntries().filter(entry => entry.level === 'warning').length;
  } finally {
    page?.close();
    if (started) report.stop = await stopClient({ data: dataRoot }).then(value => ({ ok: value.ok, stopped: value.stopped })).catch(error => ({ ok: false, error: error.message }));
    await fake?.close();
  }
  if (!report.scroll) throw new ToolError('failed', 'The scroll did not run.', report);
  return { ok: true, ...report, pidFile: readPidFile(dataRoot)?.pid ?? null };
}

await runCli(main);
