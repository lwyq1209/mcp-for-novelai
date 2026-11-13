/**
 * Issue #1 (2026-10-14): queued images of several agent sessions could not be kept apart. Every enqueue landed in
 * outputDir/<date>/ and was told apart only by a day-wide duplicate counter (-N), so the numbers of two projects
 * interleaved and an agent that copied "its" number range took the other project's images and missed its own.
 *
 * End to end and offline: two MCP sessions (two `novelai` server instances, as two agent processes would have)
 * share ONE host built from the real services main.ts wires together — queue recipes, the durable batch queue,
 * the generation service and the real nai.ts save path — with only the NovelAI HTTP reply, the native image codec
 * and the settings/history store replaced by fixtures. The sessions alternate their enqueues the way the
 * incident did (A, B, A, B) and the queue generates FIFO.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

const fixture = vi.hoisted(() => ({
  outputDir: '',
  groups: [] as Array<{ id: string; name: string; createdAt: string }>,
  history: [] as any[],
  post: vi.fn(),
}));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const wrap = (buffer: Buffer): any => {
    let png: PNG; try { png = PNG.sync.read(buffer); } catch { return { isEmpty: () => true }; }
    return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png) };
  };
  return { app: { getPath: () => fixture.outputDir }, dialog: {}, nativeImage: { createFromBuffer: wrap } };
});
vi.mock('axios', () => ({ default: { post: fixture.post, isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', () => ({
  getToken: () => 'synthetic-test-token',
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false, outputDir: fixture.outputDir, generationGroupId: '', keepImageMetadata: true, imageNameTemplate: '' }),
  getHistoryGroups: () => fixture.groups,
  // Same contract as the real ensureHistoryGroup: reuse a case-insensitive name match, otherwise create.
  ensureHistoryGroup: (name: string) => {
    const normalized = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '未命名分组';
    const existing = fixture.groups.find(group => group.name.toLowerCase() === normalized.toLowerCase());
    if (existing) return existing;
    const created = { id: `group-${fixture.groups.length + 1}`, name: normalized, createdAt: new Date().toISOString() };
    fixture.groups.push(created); return created;
  },
  getAccountSummary: () => ({ hasToken: true }), addHistory: (items: any[]) => { fixture.history.push(...structuredClone(items)); return []; },
  setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { generateImage, generateI2I, inpaintImage, upscaleImg, augmentImg } from './ipc/nai';
import { cancelAllJobs, hasActiveGenerationJobs } from './ipc/job-registry';
import { createGenerationService } from './generation-service';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { queueBridgeError } from './queue-bridge-error';
import { ensureHistoryGroup, getHistoryGroups } from './ipc/store';
// v3: main.ts wires resolveQueueHistoryGroup from ./queue-output. Loaded optionally so this file still runs on 55133ca,
// where the module does not exist and the queue service ignores the option anyway.
const queueOutput: any = await import('./queue-output').catch(() => null);
// The MCP side is the real `novelai` server (novelai/src); its SDK client lives in novelai/node_modules.
import { createNovelAiMcpServer, BridgeError } from '../../src/mcp.mjs';
import { mcpHostRequestKey } from '../../src/recipe-queue.mjs';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { waitUntil } from '../src/test-support/wait-until';

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
const sizeOf = (bytes: Buffer) => { const png = PNG.sync.read(bytes); return { width: png.width, height: png.height }; };
async function reply() {
  const png = new PNG({ width: 64, height: 64 }); png.data.fill(200);
  const zip = new JSZip(); zip.file('image_0.png', PNG.sync.write(png));
  return { data: await zip.generateAsync({ type: 'nodebuffer' }) };
}

let base = '';
const closers: Array<() => Promise<unknown> | unknown> = [];
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-queue-isolation-'));
  fixture.outputDir = path.join(base, 'novelai', '.runtime', 'output');
  await fs.mkdir(fixture.outputDir, { recursive: true });
  fixture.groups = []; fixture.history = [];
  fixture.post.mockReset(); fixture.post.mockImplementation(reply);
});
afterEach(() => runCleanups([...closers.splice(0).reverse(), () => cancelAllJobs(), () => fs.rm(base, { recursive: true, force: true })]));

/** One host, wired like main.ts registerIpc (generation → batch → queue recipes), plus the bridge's error mapping. */
async function startHost() {
  const runtimeDir = path.join(base, 'runtime'); await fs.mkdir(runtimeDir, { recursive: true });
  const generation = createGenerationService({
    isBusy: hasActiveGenerationJobs,
    validateImage: bytes => sizeOf(bytes),
    async execute(mode, snapshot, execution) {
      if (mode === 't2i') return generateImage(snapshot.params, snapshot.extras, undefined, execution);
      if (mode === 'i2i' || mode === 'enhance') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      if (mode === 'upscale') { const result = await upscaleImg(snapshot.upscale!.scale, snapshot.params.model, execution); return { ...result, items: result.ok && result.item ? [result.item] : [] }; }
      if (mode === 'director') return augmentImg(snapshot.director!.tool, snapshot.director!.options, execution);
      const inpaint = snapshot.inpaint!; return inpaintImage(snapshot.params, inpaint.model, inpaint.maskBase64, inpaint.strength, 0, execution);
    },
  });
  const batch = createBatchService({ generation, isBusy: hasActiveGenerationJobs, runtimeDir });
  closers.push(() => batch.dispose());
  const queue: any = createQueueRecipeService({ runtimeDir, batch, generation,
    historyById: id => fixture.history.find(item => item.id === id) ?? null,
    // As main.ts wires it (v2: harness wiring only; v3: main.ts now checks folder collisions first).
    resolveHistoryGroup: (name: string) => queueOutput ? queueOutput.resolveQueueHistoryGroup(name, getHistoryGroups(), ensureHistoryGroup) : ensureHistoryGroup(name),
    validateImage: data => sizeOf(data),
  });
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  const bridgeClient = { async call(method: string, args: unknown) {
    if (!(QUEUE_METHODS as readonly string[]).includes(method)) throw new BridgeError('unsupported_method', 'No such host method.');
    try { return json(await queue[method](json(args))); }
    catch (error) { const bridged: any = queueBridgeError(error); throw new BridgeError(bridged.code, bridged.message, bridged.details); }
  } };
  return { queue, bridgeClient };
}

/** One agent session: its own MCP server process (own recipe-queue state), the shared host behind it. */
async function session(bridgeClient: unknown) {
  const server = createNovelAiMcpServer({ wholeResults: true,  bridgeClient, projectRoot: base });
  const client = new Client({ name: 'queue-isolation-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result: any = await client.callTool({ name, arguments: args });
    return { ok: !result.isError, value: result.structuredContent };
  };
  const ok = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    expect(result.ok, `${name} failed: ${JSON.stringify(result.value)}`).toBe(true);
    return result.value;
  };
  return { call, ok };
}

const t2i = (positivePrompt: string) => ({ mode: 't2i', model: 'nai-diffusion-5-full', width: 64, height: 64, steps: 1, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras',
  ucPreset: 3, qualityPreset: 'none', stylePrompt: '', positivePrompt, negativePrompt: '', seed: 1 });
const ref = (recipe: any) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });

/** Until every batch ends (the test timeout bounds it). */
function settled(s: Awaited<ReturnType<typeof session>>, batchIds: string[]) {
  return waitUntil(async () => {
    const reads = await Promise.all(batchIds.map(batchId => s.ok('read_queue', { batchId })));
    expect(reads.every(read => ['succeeded', 'blocked', 'cancelled'].includes(read.status)), `queue did not settle: ${JSON.stringify(reads.map(read => read.status))}`).toBe(true);
    return reads;
  }, { interval: 50 });
}
async function filesUnder(directory: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else found.push(path.relative(fixture.outputDir, full).split(path.sep).join('/')); } };
  await walk(directory); return found.sort();
}

describe('queued output of two agent sessions sharing one host (issue #1)', () => {
  it('without the new arguments keeps exactly the old destination, file names and history (the interleaved day-wide counter)', async () => {
    const host = await startHost();
    const a = await session(host.bridgeClient), b = await session(host.bridgeClient);
    const recipeA = await a.ok('prepare_recipe', t2i('project a, teacup'));
    const recipeB = await b.ok('prepare_recipe', t2i('project b, clockwork'));
    const batches: string[] = [];
    for (const [s, recipe, key, seeds] of [[a, recipeA, 'a-1', [11, 12]], [b, recipeB, 'b-1', [21, 22]], [a, recipeA, 'a-2', [13, 14]], [b, recipeB, 'b-2', [23, 24]]] as const) {
      const enqueued = await s.ok('enqueue_recipes', { requestKey: key, items: [{ ...ref(recipe), count: 2, seeds: [...seeds] }] });
      batches.push(enqueued.batch.batchId);
    }
    const reads = await settled(a, batches);
    expect(reads.map(read => read.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const date = today(), stem = `${date}_01_nai-diffusion-5-full`;
    // The original behavior, kept bit for bit: all eight in the date root, told apart only by the global counter,
    // FIFO across sessions (a-1, b-1, a-2, b-2).
    const names = [`${stem}.png`, ...[1, 2, 3, 4, 5, 6, 7].map(n => `${stem}-${n}.png`)];
    expect(await filesUnder(fixture.outputDir)).toEqual(names.map(name => `${date}/${name}`).sort());
    const bySeed = new Map(fixture.history.map(item => [item.actualSeed, item]));
    expect([11, 12, 21, 22, 13, 14, 23, 24].map(seed => path.basename(bySeed.get(seed).filePath))).toEqual(names);
    for (const item of fixture.history) { expect(item.groupId).toBeUndefined(); expect(item.params.fileNamePrefix).toBe(''); }
    // v3 (review P2-1): generationOrigin keeps exactly its original keys, which older renderers check strictly.
    for (const item of fixture.history) expect(Object.keys(item.generationOrigin).sort()).toEqual(['actualSeed', 'jobId', 'mode', 'originWorkspaceId', 'submittedRevision']);
    expect(fixture.groups).toEqual([]);
  });

  it('keeps each session in its own history group folder with its own file prefix, and names every saved file in read_queue', async () => {
    const host = await startHost();
    const a = await session(host.bridgeClient), b = await session(host.bridgeClient);
    const recipeA = await a.ok('prepare_recipe', t2i('project a, teacup'));
    const recipeB = await b.ok('prepare_recipe', t2i('project b, clockwork'));
    const outputA = { historyGroup: 'sketchbook6', fileNamePrefix: 'sketchbook6' }, outputB = { historyGroup: 'ClockworkDetective', fileNamePrefix: 'steampunk' };
    const plan = [[a, recipeA, 'sketchbook6-1', [11, 12], outputA], [b, recipeB, 'steampunk-1', [21, 22], outputB], [a, recipeA, 'sketchbook6-2', [13, 14], outputA], [b, recipeB, 'steampunk-2', [23, 24], outputB]] as const;
    const enqueued: any[] = [];
    for (const [s, recipe, key, seeds, output] of plan) enqueued.push(await s.ok('enqueue_recipes', { requestKey: key, items: [{ ...ref(recipe), count: 2, seeds: [...seeds] }], ...output }));
    // One group per name, reused by the second enqueue; the accepted batch reports where it will save.
    expect(fixture.groups.map(group => group.name)).toEqual(['sketchbook6', 'ClockworkDetective']);
    const [groupA, groupB] = fixture.groups;
    expect(enqueued[0].batch.output).toEqual({ historyGroup: 'sketchbook6', historyGroupId: groupA.id, historyGroupName: 'sketchbook6', fileNamePrefix: 'sketchbook6' });
    expect(enqueued[3].batch.output).toEqual({ historyGroup: 'ClockworkDetective', historyGroupId: groupB.id, historyGroupName: 'ClockworkDetective', fileNamePrefix: 'steampunk' });

    const reads = await settled(a, enqueued.map(value => value.batch.batchId));
    expect(reads.map(read => read.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    const date = today();
    const own = (folder: string, prefix: string) => [`${prefix}_${date}_01_nai-diffusion-5-full.png`, ...[1, 2, 3].map(n => `${prefix}_${date}_01_nai-diffusion-5-full-${n}.png`)].map(name => `${date}/${folder}/${name}`);
    // Nothing in the shared date root; each project numbers only its own images.
    expect(await filesUnder(fixture.outputDir)).toEqual([...own('sketchbook6', 'sketchbook6'), ...own('ClockworkDetective', 'steampunk')].sort());

    for (const [index, read] of reads.entries()) {
      const [, , key, seeds, output] = plan[index];
      const group = output === outputA ? groupA : groupB;
      expect(read.output).toMatchObject({ historyGroup: output.historyGroup, historyGroupId: group.id, fileNamePrefix: output.fileNamePrefix });
      expect(read.results).toHaveLength(2);
      read.results.forEach((result: any, itemIndex: number) => {
        const history = fixture.history.find(item => item.id === result.historyId);
        // read_queue names the exact saved file of each historyId: no second lookup, no number ranges.
        expect(result).toMatchObject({ itemIndex, index: 0, fileName: path.basename(history.filePath) });
        expect(result.file).toBe(path.relative(base, history.filePath).split(path.sep).join('/'));
        expect(result.file.startsWith(`novelai/.runtime/output/${date}/${output.historyGroup}/${output.fileNamePrefix}_`)).toBe(true);
        expect(history.actualSeed).toBe(seeds[itemIndex]);
        expect(history.groupId).toBe(group.id);
        // v3 (review P2-1, P3-10): the history params keep the recipe's own (empty) prefix; the file name carries the queue's.
        expect(history.params.fileNamePrefix).toBe('');
        // The history record names the batch and the namespaced request key that produced it — beside generationOrigin (v3).
        expect(history.queueOrigin).toEqual({ batchId: read.batchId, requestKey: mcpHostRequestKey(key), itemIndex });
        expect(history.generationOrigin).toEqual({ jobId: expect.any(String), mode: 't2i', originWorkspaceId: 'recipe-queue', submittedRevision: 0, actualSeed: seeds[itemIndex] });
      });
      const image = await a.ok('get_queue_result', { batchId: read.batchId, itemIndex: 1 });
      expect(image).toMatchObject({ historyId: read.results[1].historyId, fileName: read.results[1].fileName, file: read.results[1].file });
    }

    // The output belongs to the plan: the same key and output is the same batch; another output is a conflict.
    const again = await a.ok('enqueue_recipes', { requestKey: 'sketchbook6-1', items: [{ ...ref(recipeA), count: 2, seeds: [11, 12] }], ...outputA });
    expect(again).toMatchObject({ status: 'already_enqueued', enqueueSent: false, batch: { batchId: enqueued[0].batch.batchId } });
    const moved = await a.call('enqueue_recipes', { requestKey: 'sketchbook6-1', items: [{ ...ref(recipeA), count: 2, seeds: [11, 12] }], historyGroup: 'elsewhere', fileNamePrefix: 'sketchbook6' });
    expect(moved.ok).toBe(false);
    expect(moved.value.error).toMatchObject({ code: 'request_conflict' });
    expect(fixture.groups.map(group => group.name)).toEqual(['sketchbook6', 'ClockworkDetective']);
    expect(fixture.post).toHaveBeenCalledTimes(8);
  });
});
