#!/usr/bin/env node
// Fault injection on the paid path, without real generation: no failure stops the shared queue (2026-12).
// The fake NovelAI service answers the 2nd generation request with HTTP 400 (an image of batch A fails) and the 4th
// with HTTP 429 (the first image of batch B is rate limited once). An agent (MCP client "claude-code") enqueues A (3
// images) and B (2 images):
//   - A goes on after its failed image and ends "partial"; B runs right after it, its 429 image is sent again with the
//     same seed and B ends "succeeded";
//   - read_queue wait {until:"next"} returns on A's first saved image, wait {until:"done"} on A's and B's ends;
//   - get_queue_result without itemIndex returns A's two saved images as thumbnails;
//   - batch C (3 images) is interrupted: the test client is stopped while C's second image is held at the fake
//     service, and started again; C continues by itself, the held image is unknown and never resent.
//   node dev-tools/examples/fault-injection.mjs [--out <folder under .tmp>] [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { connectMcp } from '../lib/mcp-client.mjs';
import { worktreeRoot } from '../lib/paths.mjs';
import { startClient, stopClient } from '../test-client.mjs';

const FAULTS = ['generation:2:400', 'generation:4:429'];

async function main(argv) {
  const { options } = parseArgs(argv, { booleans: ['keep'] });
  allowOptions(options, ['out', 'keep']);
  const out = path.resolve(String(options.out ?? path.join(worktreeRoot, '.tmp', 'dev-tools-examples', `fault-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const data = path.join(out, 'data'), shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const steps = [], screenshots = [];
  const step = async (name, run) => {
    const started = Date.now();
    try { const value = await run(); steps.push({ step: name, ok: true, ms: Date.now() - started, ...(value && typeof value === 'object' ? { result: value } : {}) }); return value; }
    catch (error) { steps.push({ step: name, ok: false, ms: Date.now() - started, error: error.message, ...(error.details ? { details: error.details } : {}) }); throw error; }
  };
  const check = (condition, code, message, details) => { if (!condition) throw Object.assign(new ToolError(code, message), { details }); };
  let fake, client, page, mcp, failure = null;
  const shot = async name => { if (!page) return; const file = path.join(shots, `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`); await page.screenshot(file); screenshots.push(file); };
  const call = async (tool, args) => { const result = await mcp.call(tool, args); if (result.isError) throw new ToolError(`${tool}_failed`, result.text.slice(0, 800)); return result; };
  const read = async (batchId, wait) => (await call('read_queue', { batchId, ...(wait ? { wait } : {}) })).structuredContent;
  const seedsSent = () => fake.requests({ class: 'generation' }).map(record => record.body?.parameters?.seed ?? null);
  const startTestClient = async () => {
    client = await startClient({ data, port: 'auto', 'fake-novelai': fake.url, locale: 'zh-CN' });
    page = await connectPage({ port: client.port });
    await page.captureConsole();
    mcp = await connectMcp({ data, clientName: 'claude-code', clientVersion: '9.9.9-dev-tools' });
    return { pid: client.pid, port: client.port, bridgeReadyMs: client.bridgeReadyMs };
  };
  const stopTestClient = async () => { page?.close(); page = null; await mcp?.close().catch(() => undefined); mcp = null; await stopClient({ data }); client = null; };
  try {
    fake = await startFakeNovelAI({ delayMs: 300, faults: FAULTS });
    await step('fake-novelai with faults', async () => ({ url: fake.url, faults: FAULTS }));
    await step('test-client start', startTestClient);

    const recipe = await step('prepare_recipe (t2i)', async () => {
      const { structuredContent: value } = await call('prepare_recipe', { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 512, height: 768, steps: 23, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl, lighthouse, fault injection demo', negativePrompt: '', seed: 12345 });
      return { recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash };
    });
    const runKey = Date.now().toString(36);
    const enqueue = async (name, seeds) => {
      const { structuredContent: value } = await call('enqueue_recipes', { requestKey: `fault-demo-${name}-${runKey}`, items: [{ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, count: seeds.length, seeds }], historyGroup: 'dev-tools-fault-demo', fileNamePrefix: `fault-${name}` });
      return { batchId: value.batch.batchId, status: value.batch.status };
    };
    const a = await step('enqueue batch A (3 images)', () => enqueue('a', [101, 102, 103]));
    const b = await step('enqueue batch B (2 images)', () => enqueue('b', [201, 202]));

    await step('read_queue wait next on A returns on a result saved after the call started', async () => {
      const before = (await read(a.batchId)).results.length, started = Date.now();
      const value = await read(a.batchId, { until: 'next', seconds: 60 });
      check(value.wait?.ended === 'next' && value.results?.length > before, 'wait_next', `wait next ended ${value.wait?.ended} with ${value.results?.length} results (${before} before)`, value);
      return { wait: value.wait, tookMs: Date.now() - started, resultsBefore: before, results: value.results.map(result => result.itemIndex) };
    });
    await step('read_queue on B: two batches share the FIFO (ahead, etaSeconds)', async () => {
      const value = await read(b.batchId);
      return { status: value.status, ahead: value.ahead, etaSeconds: value.etaSeconds, imageSeconds: value.imageSeconds };
    });
    const endedA = await step('A goes on after its failed image and ends partial (wait done)', async () => {
      const value = await read(a.batchId, { until: 'done', seconds: 120 });
      check(value.wait?.ended === 'done' && value.status === 'partial', 'a_not_partial', `A ended ${value.wait?.ended} as ${value.status}`, value);
      check(JSON.stringify(value.items.map(item => item.status)) === JSON.stringify(['succeeded', 'failed', 'succeeded']), 'a_items', `A items ${value.items.map(item => item.status)}`, value);
      return { status: value.status, stopReason: value.stopReason, itemCounts: value.itemCounts, items: value.items.map(item => [item.status, item.error]), wait: value.wait };
    });
    await step('B ran after A without anyone resuming it; its 429 image was sent again and succeeded', async () => {
      const value = await read(b.batchId, { until: 'done', seconds: 120 });
      check(value.wait?.ended === 'done' && value.status === 'succeeded', 'b_not_succeeded', `B ended ${value.wait?.ended} as ${value.status}`, value);
      check(value.items[0].rateLimitRetries === 1, 'b_no_resend', 'B item 0 does not show one 429 resend.', value);
      const seeds = seedsSent();
      // 101 ok, 102 → 400, 103 ok, 201 → 429, 201 again ok, 202 ok.
      check(JSON.stringify(seeds) === JSON.stringify([101, 102, 103, 201, 201, 202]), 'requests', `The fake service saw seeds ${JSON.stringify(seeds)}`, { seeds });
      return { status: value.status, items: value.items.map(item => [item.status, item.rateLimitRetries ?? 0]), seedsSent: seeds, statuses: fake.requests({ class: 'generation' }).map(record => record.response?.status) };
    });
    await step('get_queue_result without itemIndex: A as thumbnails', async () => {
      const result = await call('get_queue_result', { batchId: a.batchId });
      const value = result.structuredContent, images = result.images ?? [];
      check(value.total === 2 && value.results.every(entry => entry.imageAttached && entry.width <= 384 && entry.height <= 384), 'thumbnails', 'Expected two thumbnails of at most 384 px.', value);
      return { total: value.total, results: value.results.map(entry => ({ itemIndex: entry.itemIndex, actualSeed: entry.actualSeed, width: entry.width, height: entry.height, fileName: entry.fileName })), images: images.length, imageTypes: [...new Set(images.map(entry => entry.mimeType))] };
    });
    await step('queue page shows A as partial', async () => {
      await page.route('queue');
      await page.wait(`[data-testid="queue-batch-${a.batchId}"][data-status="partial"]`, { timeoutMs: 15_000 });
      await page.click(`[data-testid="queue-batch-${a.batchId}"]`);
      await page.wait(`[data-testid="queue-failed-${a.batchId}"]`, { timeoutMs: 15_000 });
      await shot('queue-partial');
      return { statuses: await page.evaluate(() => [...document.querySelectorAll('[data-testid^="queue-batch-"]')].map(el => ({ batchId: el.getAttribute('data-testid').slice(12), status: el.getAttribute('data-status') }))) };
    });

    // The app stops while an image of C runs and starts again: C continues by itself.
    fake.addFault({ match: 'generation', nth: 2, kind: 'hang' });
    const c = await step('enqueue batch C (3 images); its second request hangs at the fake service', () => enqueue('c', [301, 302, 303]));
    await step('stop the test client while C\'s second image runs', async () => {
      const held = await pollUntil(async () => { const value = await read(c.batchId); return value.items?.[1]?.status === 'running' ? value : null; }, { timeoutMs: 30_000, intervalMs: 250 });
      check(held, 'not_running', 'C\'s second image never ran.');
      await stopTestClient();
      fake.release();
      return { items: held.items.map(item => item.status), seedsSent: seedsSent().slice(6) };
    });
    await step('start the test client again: C continues by itself, the interrupted image is unknown and not resent', async () => {
      const started = await startTestClient();
      const value = await read(c.batchId, { until: 'done', seconds: 120 });
      const seeds = seedsSent().slice(6);
      check(value.wait?.ended === 'done' && value.status === 'partial', 'c_not_partial', `C ended ${value.wait?.ended} as ${value.status}`, value);
      check(JSON.stringify(value.items.map(item => [item.status, item.error])) === JSON.stringify([['succeeded', null], ['unknown', 'restart_unconfirmed'], ['succeeded', null]]), 'c_items', 'C items differ.', value);
      check(JSON.stringify(seeds) === JSON.stringify([301, 302, 303]), 'c_requests', `After the restart the fake service saw seeds ${JSON.stringify(seeds)}`, { seeds });
      await page.route('queue');
      await page.wait(`[data-testid="queue-batch-${c.batchId}"][data-status="partial"]`, { timeoutMs: 15_000 }).catch(() => undefined);
      await shot('queue-after-restart');
      return { client: started, status: value.status, items: value.items.map(item => [item.status, item.error]), itemReasons: value.itemReasons, seedsSent: seeds, wait: value.wait };
    });
    await step('page errors', async () => { const errors = page.consoleEntries({ errorsOnly: true }); return { count: errors.length, entries: errors.slice(0, 10) }; });
    void endedA;
  } catch (error) {
    failure = error;
    await shot('failure').catch(() => undefined);
  } finally {
    page?.close();
    await mcp?.close().catch(() => undefined);
    if (client) await step('test-client stop', () => stopClient({ data })).catch(() => undefined);
    if (fake) { const requests = fake.requests(); await fake.close(); steps.push({ step: 'fake-novelai stop', ok: true, result: { requests: requests.length, endpoints: [...new Set(requests.map(record => record.endpoint))] } }); }
    if (!options.keep && !failure) fs.rmSync(data, { recursive: true, force: true });
  }
  return { ok: !failure, out, faults: FAULTS, screenshots, steps, ...(failure ? { error: failure.message } : {}), dataKept: Boolean(options.keep || failure) };
}

await runCli(main);
