#!/usr/bin/env node
// Library browsing measurements (measures only, no writes): start a test client on a seeded data root, wheel-scroll
// the history grid to about the middle of the library, open the image in the middle of the window, press → N times
// in the detail drawer, close it with Esc (where the focus and the scroll position end up), then time the filters.
//   node dev-tools/examples/library-browse.mjs --data <seeded data root> [--arrows 50] [--shots <folder>]
//        [--fake-novelai <url>] [--delta 1200] [--filters mode,date,source,archived]
// Seed first, e.g.: node dev-tools/seed-library.mjs --data .tmp/perf-10k --history 10000
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli, sleep } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { checkDataRoot } from '../lib/guard.mjs';
import { startClient, stopClient } from '../test-client.mjs';

// In the window: the library's scroll container, the tiles in the viewport (with their place in the list: data-index
// when the grid gives it, else the document order of the rendered tiles), the drawer and the focused tile.
function probe() {
  const scroller = document.querySelector('[data-testid="library-page"] .lib-scroll');
  const rect = scroller?.getBoundingClientRect();
  const tiles = [...document.querySelectorAll('[data-testid^="tile-"]')];
  const visible = [];
  tiles.forEach((tile, order) => {
    const box = tile.getBoundingClientRect();
    if (rect && box.bottom > rect.top && box.top < rect.bottom && box.width > 0) visible.push({ id: tile.dataset.testid.slice(5), index: tile.dataset.index !== undefined ? Number(tile.dataset.index) : order, top: Math.round(box.top - rect.top), x: box.left + box.width / 2, y: box.top + box.height / 2 });
  });
  const drawer = document.querySelector('.lib-drawer');
  const active = document.activeElement;
  const focusedTile = active?.closest?.('[data-testid^="tile-"]');
  const header = /历史成图\s*([\d,]+)\s*张|History\s*([\d,]+)\s*images?/.exec(document.querySelector('.lib-head')?.innerText ?? '');
  return {
    top: scroller ? Math.round(scroller.scrollTop) : null, height: scroller?.scrollHeight ?? null, client: scroller?.clientHeight ?? null,
    tiles: tiles.length, visible, drawer: !!drawer, drawerTitle: drawer?.querySelector('.ui-drawer__title')?.textContent ?? null,
    drawerImage: !!drawer?.querySelector('.lib-dr-img img'), activeTile: document.querySelector('.lib-tile.is-active')?.dataset.testid?.slice(5) ?? null,
    focusedTile: focusedTile?.dataset.testid?.slice(5) ?? null, focusTag: active ? `${active.tagName.toLowerCase()}.${String(active.className).slice(0, 40)}` : null,
    count: document.querySelector('.lib-head .ui-muted')?.textContent ?? null, total: header ? Number((header[1] ?? header[2]).replace(/,/g, '')) : null,
  };
}

async function main(argv) {
  const { options } = parseArgs(argv);
  allowOptions(options, ['data', 'fake-novelai', 'shots', 'delta', 'arrows', 'filters', 'timeout']);
  const { dataRoot } = checkDataRoot(String(options.data ?? ''));
  const deltaY = Number(options.delta ?? 1200), arrows = Number(options.arrows ?? 50), timeoutMs = Number(options.timeout ?? 600) * 1000;
  const filters = String(options.filters ?? 'mode,date,source,archived').split(',').filter(Boolean);
  const shots = options.shots ? path.resolve(String(options.shots)) : null;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  let fake = null, page = null, started = null;
  const report = { dataRoot };
  try {
    if (!options['fake-novelai']) fake = await startFakeNovelAI();
    started = await startClient({ data: dataRoot, port: 'auto', 'fake-novelai': options['fake-novelai'] ?? fake.url, locale: 'zh-CN' });
    page = await connectPage({ port: started.port });
    await page.captureConsole();
    await page.route('library');
    await page.wait('[data-testid^="tile-"]', { timeoutMs: 120_000 });
    const state = () => page.evaluate(probe);
    const total = await pollUntil(async () => (await state()).total, { timeoutMs: 10_000 });
    report.libraryTotal = total;
    await sleep(1000);

    // 1. Wheel-scroll until the first tile in view is about the middle of the library.
    const first = await page.resolve({ css: '[data-testid^="tile-"]', mark: true });
    const { x, y } = first.point;
    const scrollStarted = Date.now();
    let now = await state(), steps = 0, slowest = 0;
    while (Date.now() - scrollStarted < timeoutMs && !(now.visible.length && now.visible[0].index >= total / 2)) {
      const stepStarted = Date.now();
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0 });
      await sleep(50);
      now = await state(); steps++; slowest = Math.max(slowest, Date.now() - stepStarted);
    }
    await sleep(800);
    now = await state();
    report.middle = { steps, ms: Date.now() - scrollStarted, slowestStepMs: slowest, top: now.top, firstIndex: now.visible[0]?.index ?? null, tilesInDom: now.tiles, metrics: await page.metrics() };
    delete report.middle.metrics.raw;
    if (shots) await page.screenshot(path.join(shots, 'browse-middle.png'));

    // 1b. Element identity while scrolling (review rework): a tile that stays rendered keeps its DOM element, and the
    // tile elements removed and added follow the tiles that really leave and enter the rendered set.
    const wheelBy = async (delta) => { await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: delta, modifiers: 0 }); await sleep(120); };
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="library-grid"]');
      window.__churn = { removed: 0, added: 0 };
      window.__churnObserver?.disconnect();
      window.__churnObserver = new MutationObserver(records => { for (const record of records) { for (const node of record.removedNodes) if (node.dataset?.key) window.__churn.removed++; for (const node of record.addedNodes) if (node.dataset?.key) window.__churn.added++; } });
      window.__churnObserver.observe(grid, { childList: true });
      // Mark every rendered tile element; a mark survives only on the same element.
      for (const node of document.querySelectorAll('[data-testid^="tile-"]')) node.__browseMark = node.dataset.key;
    });
    const renderedKeys = () => page.evaluate(() => [...document.querySelectorAll('[data-testid^="tile-"]')].map(node => node.dataset.key));
    // A few small scrolls first: every tile still rendered must be the same element it was (its mark is still on it).
    const markedBefore = (await renderedKeys()).length;
    for (let step = 0; step < 3; step++) await wheelBy(150);
    const kept = await page.evaluate(() => { const tiles = [...document.querySelectorAll('[data-testid^="tile-"]')], marked = tiles.filter(node => node.__browseMark !== undefined);
      return { rendered: tiles.length, sameElement: marked.length, newElements: tiles.length - marked.length }; });
    // The churn count starts here (the small scrolls above removed the tiles that left then).
    await page.evaluate(() => { window.__churn = { removed: 0, added: 0 }; });
    let previousKeys = new Set(await renderedKeys()), left = 0, entered = 0;
    for (let step = 0; step < 20; step++) {
      await wheelBy(300);
      const now = new Set(await renderedKeys());
      for (const key of previousKeys) if (!now.has(key)) left++;
      for (const key of now) if (!previousKeys.has(key)) entered++;
      previousKeys = now;
    }
    const churn = await page.evaluate(() => {
      window.__churnObserver.disconnect();
      const tiles = [...document.querySelectorAll('[data-testid^="tile-"]')];
      const marked = tiles.filter(node => node.__browseMark !== undefined);
      return { ...window.__churn, stillMarked: marked.length, markMatches: marked.every(node => node.__browseMark === node.dataset.key) };
    });
    report.identity = { wheelSteps: 20, deltaY: 300, tilesLeft: left, tilesEntered: entered, tileElementsRemoved: churn.removed, tileElementsAdded: churn.added,
      // Elements made again without leaving the rendered set (0 when React keeps them).
      needlessRemounts: Math.max(0, churn.removed - left), marksMatchTheirTile: churn.markMatches,
      // After 3 × 150 px: tiles rendered before and still rendered kept their element (newElements = tiles that came in).
      smallScroll: { renderedBefore: markedBefore, ...kept } };
    await sleep(500);
    now = await state();

    // 2. Open the tile nearest the middle of the window (a real click on its open button).
    const pick = now.visible.slice().sort((a, b) => Math.abs(a.y - now.visible[0].y - 200) - Math.abs(b.y - now.visible[0].y - 200))[0];
    const scrollBeforeOpen = now.top;
    const openStarted = Date.now();
    await page.click(`[data-testid="tile-${pick.id}"] .lib-tile-open`);
    const opened = await pollUntil(async () => { const value = await state(); return value.drawer && value.drawerImage ? value : null; }, { timeoutMs: 15_000, intervalMs: 25 });
    report.open = { id: pick.id, index: pick.index, ms: Date.now() - openStarted, title: opened?.drawerTitle ?? null, scrollBefore: scrollBeforeOpen, scrollAfterOpen: opened?.top ?? null };
    if (shots) await page.screenshot(path.join(shots, 'browse-open.png'));

    // 3. → in the drawer, N times; each step waits for the drawer to show another image.
    const latencies = [];
    let title = opened?.drawerTitle ?? null, stuck = 0;
    for (let index = 0; index < arrows; index++) {
      const keyStarted = Date.now();
      await page.key('ArrowRight');
      const moved = await pollUntil(async () => { const value = await state(); return value.drawerTitle && value.drawerTitle !== title && value.drawerImage ? value : null; }, { timeoutMs: 5_000, intervalMs: 10 });
      if (!moved) { stuck++; break; }
      latencies.push(Date.now() - keyStarted); title = moved.drawerTitle;
    }
    const sorted = latencies.slice().sort((a, b) => a - b);
    const afterArrows = await state();
    report.arrows = { pressed: arrows, moved: latencies.length, stuck, avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null, p95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? null, maxMs: sorted.at(-1) ?? null,
      activeTile: afterArrows.activeTile, activeTileVisible: afterArrows.visible.some(tile => tile.id === afterArrows.activeTile), scroll: afterArrows.top };
    if (shots) await page.screenshot(path.join(shots, 'browse-arrows.png'));

    // 4. Esc closes the drawer: the focus goes to the tile of the image it showed last.
    const shown = afterArrows.activeTile;
    await page.key('Escape');
    const closed = await pollUntil(async () => { const value = await state(); return !value.drawer ? value : null; }, { timeoutMs: 5_000, intervalMs: 25 });
    await sleep(400);
    const after = await state();
    report.close = { drawerClosed: !!closed, shownLast: shown, focusedTile: after.focusedTile, focusOnShown: after.focusedTile === shown, focusTag: after.focusTag, shownVisible: after.visible.some(tile => tile.id === shown), scroll: after.top };
    report.afterBrowse = { metrics: await page.metrics() };
    delete report.afterBrowse.metrics.raw;
    if (shots) await page.screenshot(path.join(shots, 'browse-closed.png'));

    // 5. Filters: click a chip, then an option; time until the count text and the tiles stop changing.
    const settle = async (started) => {
      let last = await state(), lastChange = Date.now();
      while (Date.now() - lastChange < 1200 && Date.now() - started < 60_000) {
        await sleep(25);
        const value = await state();
        const key = v => `${v.count}|${v.tiles}|${v.visible.map(tile => tile.id).slice(0, 6).join(',')}`;
        if (key(value) !== key(last)) { last = value; lastChange = Date.now(); }
      }
      return { ms: lastChange - started, count: last.count, tiles: last.tiles, visible: last.visible.length };
    };
    const menuPick = async (chip, option) => {
      const started = Date.now();
      await page.click(`text^=${chip}`, { spec: { text: chip, exact: false, nth: 0, within: '.lib-toolbar' } });
      await page.wait('[role="menu"]', { timeoutMs: 5_000 });
      await page.click(`text=${option}`, { spec: { text: option, exact: true, nth: 0, within: '[role="menu"]' } });
      return settle(started);
    };
    const clearAll = async () => {
      // Closes any menu, then clears the filters with the toolbar's own control when there is one.
      await page.key('Escape').catch(() => undefined);
      await sleep(200);
    };
    report.filters = {};
    const scrollTop = async () => page.evaluate(() => { const el = document.querySelector('[data-testid="library-page"] .lib-scroll'); if (el) el.scrollTop = 0; return true; });
    await scrollTop(); await sleep(500);
    for (const filter of filters) {
      try {
        // Each filter alone: it is set, timed, then set back to 全部 (also timed).
        if (filter === 'mode') { report.filters.mode = await menuPick('模式', '文生图'); report.filters.modeReset = await menuPick('模式', '全部'); }
        else if (filter === 'date') { report.filters.date = await menuPick('日期', '最近 7 天'); report.filters.dateReset = await menuPick('日期', '全部'); }
        else if (filter === 'source') { report.filters.source = await menuPick('来源', '全部 Agent'); report.filters.sourceReset = await menuPick('来源', '全部'); }
        else if (filter === 'combined') { report.filters.combinedMode = await menuPick('模式', '文生图'); report.filters.combinedSource = await menuPick('来源', '全部 Agent'); report.filters.combinedDate = await menuPick('日期', '最近 30 天'); }
        else if (filter === 'archived') {
          const started = Date.now();
          const has = await page.evaluate(() => [...document.querySelectorAll('.lib-toolbar *')].some(node => /只看已归档|归档/.test(node.textContent ?? '')));
          // The new toolbar has an 归档 menu (不含 / 含已归档 / 只看已归档); 4b1 has a 含已归档 toggle chip.
          const menu = await page.evaluate(() => [...document.querySelectorAll('.lib-toolbar button')].some(button => /^归档/.test((button.textContent ?? '').trim())));
          if (menu) { report.filters.archivedOnly = await menuPick('归档', '只看已归档'); report.filters.archivedReset = await menuPick('归档', '不含已归档'); }
          else if (has) {
            await page.click('text^=含已归档', { spec: { text: '含已归档', exact: false, nth: 0, within: '.lib-toolbar' } }); report.filters.includeArchived = await settle(started);
            const again = Date.now(); await page.click('text^=含已归档', { spec: { text: '含已归档', exact: false, nth: 0, within: '.lib-toolbar' } }); report.filters.includeArchivedReset = await settle(again);
          }
        }
        if (shots) await page.screenshot(path.join(shots, `browse-filter-${filter}.png`));
      } catch (error) { report.filters[filter] = { error: error.message }; }
      await clearAll();
    }
    report.final = { metrics: await page.metrics() };
    delete report.final.metrics.raw;
    const errors = page.consoleEntries({ errorsOnly: true });
    report.pageErrors = { count: errors.length, entries: errors.slice(0, 20) };
  } finally {
    page?.close();
    if (started) report.stop = await stopClient({ data: dataRoot }).then(value => ({ ok: value.ok, stopped: value.stopped })).catch(error => ({ ok: false, error: error.message }));
    await fake?.close();
  }
  if (!report.open) throw new ToolError('failed', 'The browse run did not get to the drawer.', report);
  return { ok: true, ...report };
}

await runCli(main);
