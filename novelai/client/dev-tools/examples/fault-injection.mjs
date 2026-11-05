#!/usr/bin/env node
// Fault injection on the paid path, without real generation: the fake NovelAI service answers the FIRST generation
// request with HTTP 500; an agent (MCP client "claude-code") enqueues two batches; the first batch stops on the
// failure and the second one is paused by the queue's stop protection (queue_halted) without sending anything.
// Then the agent resumes the second batch, which runs once against the fake service.
//   node dev-tools/examples/fault-injection.mjs [--out <folder under .tmp>] [--keep] [--fault <match>:<nth>:<kind>]
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { connectMcp } from '../lib/mcp-client.mjs';
import { worktreeRoot } from '../lib/paths.mjs';
import { startClient, stopClient } from '../test-client.mjs';

const TERMINAL = ['succeeded', 'failed', 'blocked', 'cancelled', 'unknown', 'stopped'];

async function main(argv) {
  const { options } = parseArgs(argv, { booleans: ['keep'] });
  allowOptions(options, ['out', 'keep', 'fault']);
  const out = path.resolve(String(options.out ?? path.join(worktreeRoot, '.tmp', 'dev-tools-examples', `fault-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const data = path.join(out, 'data'), shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const fault = String(options.fault ?? 'generation:1:500');
  const steps = [], screenshots = [];
  const step = async (name, run) => {
    const started = Date.now();
    try { const value = await run(); steps.push({ step: name, ok: true, ms: Date.now() - started, ...(value && typeof value === 'object' ? { result: value } : {}) }); return value; }
    catch (error) { steps.push({ step: name, ok: false, ms: Date.now() - started, error: error.message }); throw error; }
  };
  let fake, client, page, mcp, failure = null;
  const shot = async name => { if (!page) return; const file = path.join(shots, `${String(screenshots.length + 1).padStart(2, '0')}-${name}.png`); await page.screenshot(file); screenshots.push(file); };
  const readBatch = async batchId => (await mcp.call('read_queue', { batchId })).structuredContent;
  try {
    fake = await startFakeNovelAI({ delayMs: 300, faults: [fault] });
    await step('fake-novelai with fault', async () => ({ url: fake.url, faults: fake.faults().map(rule => `${rule.match}:${rule.nth}:${rule.kind}${rule.status ? `=${rule.status}` : ''}`) }));
    client = await step('test-client start', async () => { const value = await startClient({ data, port: 'auto', 'fake-novelai': fake.url, locale: 'zh-CN' }); return { pid: value.pid, port: value.port, bridgeReadyMs: value.bridgeReadyMs }; });
    page = await connectPage({ port: client.port });
    await page.captureConsole();
    mcp = await connectMcp({ data, clientName: 'claude-code', clientVersion: '9.9.9-dev-tools' });

    const recipe = await step('prepare_recipe (t2i)', async () => {
      const result = await mcp.call('prepare_recipe', { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 512, height: 768, steps: 23, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl, lighthouse, fault injection demo', negativePrompt: '', seed: 12345 });
      if (result.isError) throw new ToolError('prepare_failed', result.text.slice(0, 500));
      const { recipeId, recipeRevision, inputHash } = result.structuredContent;
      return { recipeId, recipeRevision, inputHash };
    });
    const enqueue = async key => {
      const result = await mcp.call('enqueue_recipes', { requestKey: key, items: [{ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, count: 1 }], historyGroup: 'dev-tools-fault-demo', fileNamePrefix: 'fault' });
      if (result.isError) throw new ToolError('enqueue_failed', result.text.slice(0, 500));
      const batch = result.structuredContent?.batch ?? result.structuredContent;
      return { requestKey: key, batchId: batch.batchId, status: batch.status };
    };
    const runKey = Date.now().toString(36);
    const first = await step('enqueue batch A', () => enqueue(`fault-demo-a-${runKey}`));
    const second = await step('enqueue batch B', () => enqueue(`fault-demo-b-${runKey}`));

    const settled = await step('A stops on the injected failure, B is paused', async () => {
      const a = await pollUntil(async () => { const batch = await readBatch(first.batchId); return TERMINAL.includes(batch?.status) ? batch : null; }, { timeoutMs: 30_000, intervalMs: 250 });
      if (!a) throw new ToolError('timeout', 'Batch A did not end.');
      const b = await pollUntil(async () => { const batch = await readBatch(second.batchId); return batch?.status === 'paused' || TERMINAL.includes(batch?.status) ? batch : null; }, { timeoutMs: 15_000, intervalMs: 250 });
      const generation = fake.requests({ class: 'generation' });
      const listed = (await mcp.call('list_queue', {})).structuredContent?.batches?.find(batch => batch.batchId === second.batchId) ?? null;
      // read_queue and list_queue name why a batch is paused or blocked (stopReason {code, message}) and, per item, its error code.
      const result = { listQueueEntryOfB: listed, a: { status: a.status, stopReason: a.stopReason ?? null, item: a.items?.[0] ? { status: a.items[0].status, error: a.items[0].error ?? null } : null }, b: { status: b?.status, stopReason: b?.stopReason ?? null }, generationRequests: generation.map(record => ({ seq: record.seq, endpoint: record.endpoint, status: record.response?.status, kind: record.response?.kind })) };
      if (b?.status !== 'paused' || b.items?.some(item => item.status !== 'pending')) throw Object.assign(new ToolError('not_halted', `Batch B is ${b?.status}, not paused with its image pending. Raw: ${JSON.stringify(b).slice(0, 1500)}`), { details: result });
      if (b.stopReason?.code !== 'queue_halted' || listed?.stopReason?.code !== 'queue_halted') throw Object.assign(new ToolError('reason_missing', 'read_queue or list_queue does not say batch B was paused by queue_halted.'), { details: result });
      if (generation.length !== 1) throw Object.assign(new ToolError('requests', `The fake service saw ${generation.length} generation requests; expected exactly 1 (batch B must send nothing).`), { details: result });
      return result;
    });
    await step('queue page shows the halt', async () => {
      await page.route('queue');
      // The halted notice is in the detail of the batch paused by queue_halted (step 4b2 queue page): select it first.
      await page.wait(`[data-testid="queue-batch-${second.batchId}"]`, { timeoutMs: 15_000 });
      await page.click(`[data-testid="queue-batch-${second.batchId}"]`);
      const notice = await page.wait(`[data-testid="queue-halted-${second.batchId}"]`, { timeoutMs: 15_000 });
      const statuses = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="queue-batch-"]')].map(el => ({ batchId: el.getAttribute('data-testid').slice(12), status: el.getAttribute('data-status') })));
      await shot('queue-halted');
      return { statuses, haltedNotice: notice.element.text };
    });
    await step('agent resumes B (original frozen recipe)', async () => {
      const resumed = await mcp.call('control_queue', { batchId: second.batchId, action: 'resume' });
      if (resumed.isError) throw new ToolError('resume_failed', resumed.text.slice(0, 500));
      const b = await pollUntil(async () => { const batch = await readBatch(second.batchId); return TERMINAL.includes(batch?.status) ? batch : null; }, { timeoutMs: 30_000, intervalMs: 250 });
      const generation = fake.requests({ class: 'generation' });
      await page.wait(`[data-testid="queue-batch-${second.batchId}"][data-status="${b?.status}"]`, { timeoutMs: 10_000 }).catch(() => undefined);
      await shot('queue-after-resume');
      return { b: { status: b?.status, results: (b?.results ?? []).map(value => value.historyId) }, generationRequests: generation.length, lastStatus: generation.at(-1)?.response?.status };
    });
    await step('page errors', async () => { const errors = page.consoleEntries({ errorsOnly: true }); return { count: errors.length, entries: errors.slice(0, 10) }; });
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
  return { ok: !failure, out, fault, screenshots, steps, ...(failure ? { error: failure.message } : {}), dataKept: Boolean(options.keep || failure) };
}

await runCli(main);
