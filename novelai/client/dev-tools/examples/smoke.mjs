#!/usr/bin/env node
// End-to-end smoke run with the dev-tools, in a real window, without any real generation:
//   fake NovelAI → small seeded library → test client (DevTools, fake endpoint) → library: open a detail, select two
//   images, open the delete confirmation and CANCEL it → canvas: one Generate click (fake service) → result on the
//   canvas → queue page shows the batch → MCP reads the same batch → screenshots → client and fake service stopped.
//   node dev-tools/examples/smoke.mjs [--out <folder under .tmp>] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli, sleep } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { connectMcp } from '../lib/mcp-client.mjs';
import { worktreeRoot } from '../lib/paths.mjs';
import { seedLibrary } from '../lib/seed.mjs';
import { startClient, stopClient } from '../test-client.mjs';
import { frontDetectedError, startFrontWatch } from '../lib/front-watch.mjs';

const MOD = process.platform === 'darwin' ? 4 : 2; // Meta on macOS, Control elsewhere (toggle selection)

async function main(argv) {
  const { options } = parseArgs(argv, { booleans: ['keep'] });
  allowOptions(options, ['out', 'keep']);
  const out = path.resolve(String(options.out ?? path.join(worktreeRoot, '.tmp', 'dev-tools-examples', `smoke-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const data = path.join(out, 'data'), shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const steps = [];
  const screenshots = [];
  const step = async (name, run) => {
    const started = Date.now();
    try { const value = await run(); steps.push({ step: name, ok: true, ms: Date.now() - started, ...(value && typeof value === 'object' && !Array.isArray(value) ? { result: value } : {}) }); return value; }
    catch (error) { steps.push({ step: name, ok: false, ms: Date.now() - started, error: error.message, ...(error.details ? { details: error.details } : {}) }); throw error; }
  };
  let fake, page, mcp, client, failure = null;
  // The whole run under the front-app watcher (macOS): a test client in front fails it (review rework 2).
  const front = await startFrontWatch({ dataRoot: data });
  const shot = async name => { if (!page) return; const file = path.join(shots, `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`); await page.screenshot(file); screenshots.push(file); };
  try {
    fake = await step('fake-novelai', async () => { const service = await startFakeNovelAI({ delayMs: 400, streamSteps: 3 }); return Object.assign(service, { toJSON: () => ({ url: service.url }) }); });
    const seeded = await step('seed-library', async () => { const value = await seedLibrary({ data, history: 40, tags: 12, combos: 3, notes: 3, imports: 4, favorites: 3, trash: 2 }); return { counts: value.counts, timingsMs: value.timingsMs }; });
    client = await step('test-client start', () => startClient({ data, port: 'auto', 'fake-novelai': fake.url, locale: 'zh-CN', size: '1440x900' }));
    page = await connectPage({ port: client.port });
    await page.captureConsole();

    // ── Library ──────────────────────────────────────────────────────────────────────────────────────────────
    await step('library page', async () => {
      await page.route('library');
      const tiles = await page.wait('[data-testid^="tile-"] button.lib-tile-open', { timeoutMs: 20_000 });
      await shot('library');
      return { tilesVisible: tiles.count, seededHistory: seeded.counts.history };
    });
    await step('open an image detail', async () => {
      const opened = await page.click('[data-testid^="tile-"] button.lib-tile-open', { nth: 0 });
      await page.wait('.lib-detail', { timeoutMs: 10_000 });
      await page.wait('.lib-detail .lib-dr-img img', { timeoutMs: 10_000 });
      await shot('library-detail');
      await page.key('Escape');
      const closed = await page.wait('.lib-detail', { state: 'hidden', timeoutMs: 3_000 }).then(() => 'Escape').catch(async () => { await page.click('text=关闭'); await page.wait('.lib-detail', { state: 'hidden' }); return 'close button'; });
      return { opened: opened.element.label, closedBy: closed };
    });
    const before = await step('select two images', async () => {
      await page.click('[data-testid^="tile-"] button.lib-tile-open', { nth: 0, modifiers: MOD });
      await page.click('[data-testid^="tile-"] button.lib-tile-open', { nth: 1, modifiers: MOD });
      const bar = await page.wait('[data-testid="selection-bar"]');
      const count = await page.evaluate(() => document.querySelector('.lib-selbar-count')?.textContent ?? '');
      if (!/2/.test(count)) throw new ToolError('selection', `The selection bar says "${count}", not 2 selected.`);
      await shot('library-two-selected');
      const total = await page.evaluate(() => document.querySelectorAll('[data-testid^="tile-"]').length);
      return { selectionBar: count, tilesInDom: total, barFound: bar.count };
    });
    await step('delete confirmation, then cancel', async () => {
      await page.click('[data-testid="selection-delete"]');
      const dialog = await page.wait('[role="dialog"][aria-modal="true"]', { timeoutMs: 10_000 });
      await page.wait('text^=删除 2 项', { timeoutMs: 10_000 });
      // The confirmation computes its impacts first; wait until it stops checking.
      await page.wait('text^=正在检查会影响什么', { state: 'hidden', timeoutMs: 15_000 }).catch(() => undefined);
      await shot('library-delete-confirm');
      await page.clickText('取消', { within: '[role="dialog"]', exact: true });
      await page.wait('[role="dialog"][aria-modal="true"]', { state: 'hidden', timeoutMs: 5_000 });
      return { dialog: dialog.element.label ?? dialog.element.text.slice(0, 40), cancelled: true };
    });
    await step('nothing was deleted', async () => {
      mcp = await connectMcp({ data, clientName: 'dev-tools-smoke' });
      const trash = await mcp.call('asset_library', { action: 'recently-deleted', limit: 20 });
      const entries = trash.structuredContent?.entries ?? [];
      if (entries.length !== seeded.counts.recentlyDeleted) throw new ToolError('deleted', `Recently Deleted has ${entries.length} entries, expected the seeded ${seeded.counts.recentlyDeleted}.`);
      return { recentlyDeleted: entries.length };
    });

    // ── Canvas: one Generate click through the fake service ─────────────────────────────────────────────────
    const generated = await step('canvas generate (fake service)', async () => {
      await page.route('canvas');
      await page.wait('[data-testid="cv-generate"]', { timeoutMs: 20_000 });
      await page.type('textarea[data-testid="cv-positive"]', '1girl, lighthouse, night sky, dev-tools smoke', { clear: true });
      // The stage head names the image the canvas shows (its file name without the extension).
      const currentName = () => page.evaluate(() => document.querySelector('[data-testid="cv-current-name"]')?.textContent ?? null);
      const before = await currentName();
      const sinceSeq = fake.requests().at(-1)?.seq ?? 0;
      await page.click('[data-testid="cv-generate"]');
      const request = await pollUntil(() => fake.requests({ class: 'generation', since: sinceSeq }).find(record => record.response), { timeoutMs: 30_000 });
      if (!request) throw new ToolError('no_request', 'The fake service saw no generation request after the click.');
      const shown = await pollUntil(async () => {
        const name = await currentName();
        return name && name !== before && !/ × /.test(name) ? name : null;
      }, { timeoutMs: 30_000 });
      if (!shown) throw new ToolError('no_result', 'The generated image did not come back to the canvas.');
      await sleep(500);
      await shot('canvas-result');
      return { endpoint: request.endpoint, auth: request.auth, status: request.response.status, size: request.response.images?.[0], canvasImage: shown };
    });

    // ── Queue page and MCP read of the same batch ───────────────────────────────────────────────────────────
    const queue = await step('queue page shows the batch', async () => {
      await page.route('queue');
      const article = await page.wait('[data-testid^="queue-batch-"]', { timeoutMs: 15_000 });
      const batches = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="queue-batch-"]')].map(el => ({ batchId: el.getAttribute('data-testid').slice('queue-batch-'.length), status: el.getAttribute('data-status') })));
      await shot('queue');
      return { batches, articles: article.count };
    });
    await step('MCP reads the same batch', async () => {
      const listed = await mcp.call('list_queue', {});
      const ids = (listed.structuredContent?.batches ?? []).map(batch => batch.batchId);
      const batchId = queue.batches[0].batchId;
      if (!ids.includes(batchId)) throw new ToolError('mcp_mismatch', `list_queue does not list the batch the queue page shows (${batchId}); it lists ${JSON.stringify(ids)}.`);
      const read = await mcp.call('read_queue', { batchId });
      const batch = read.structuredContent ?? {};
      const results = (batch.results ?? []).map(result => ({ historyId: result.historyId, fileName: result.fileName }));
      const sameImageAsCanvas = results.some(result => String(result.fileName ?? '').replace(/\.[^.]+$/, '') === generated.canvasImage);
      return { batchId, status: batch.status, results, sameImageAsCanvas };
    });
    const errors = page.consoleEntries({ errorsOnly: true });
    await step('page errors', async () => ({ count: errors.length, entries: errors.slice(0, 10) }));
  } catch (error) {
    failure = error;
    await shot('failure').catch(() => undefined);
  } finally {
    page?.close();
    await mcp?.close().catch(() => undefined);
    if (client) await step('test-client stop', () => stopClient({ data })).catch(() => undefined);
    if (fake) await step('fake-novelai stop', async () => { const requests = fake.requests(); await fake.close(); return { requests: requests.length, generation: requests.filter(record => record.classes.includes('generation')).length, endpoints: [...new Set(requests.map(record => record.endpoint))] }; }).catch(() => undefined);
    const seen = await front.stop();
    if (seen.hits.length && !failure) failure = frontDetectedError('the smoke run', seen);
    steps.push({ step: 'front-app watch', ok: !seen.hits.length, result: { supported: seen.supported, hits: seen.hits, samples: seen.samples, maxGapMs: seen.maxGapMs } });
    if (!options.keep && !failure) fs.rmSync(data, { recursive: true, force: true });
  }
  return { ok: !failure, out, screenshots, steps, ...(failure ? { error: failure.message } : {}), dataKept: Boolean(options.keep || failure) };
}

await runCli(main);
