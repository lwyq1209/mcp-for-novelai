// Precise references end to end, through the public MCP tools only:
//   the real MCP server (src/mcp.mjs) → the real HTTP bridge (contract checks included) → the host methods as main.ts
//   wires them → the real SQLite library, the real study service and library image reader, the real recipe store.
// Doubles: Electron nativeImage (pngjs), axios (no network), the account store (never read) and the batch backend,
// which records what enqueue_recipes hands to the queue. The fixture follows issue2-study-source.ce.test.ts.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); }, request: () => { throw new Error('No network'); }, create: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('electron', async () => {
  const { PNG: Png } = await import('pngjs');
  const forbidden = () => { throw new Error('fixture: no native UI or account paths'); };
  const make = (png: any): any => ({
    isEmpty: () => !png, getSize: () => ({ width: png.width, height: png.height }),
    resize({ width, height }: { width: number; height: number }) { const out = new Png({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
    toPNG: () => Png.sync.write(png),
  });
  return { app: { getPath: forbidden, getVersion: forbidden }, dialog: {}, nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(Png.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } }, createFromPath: forbidden } };
});

import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { inflateReferenceImages } from './batch-service';
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError, startHttpBridge } from './bridge-server';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gradient = (width: number, height: number, shift = 0) => { const png = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; png.data[i] = (x * 3 + y + shift) & 255; png.data[i + 1] = (y * 2) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const GEN = { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', negativePrompt: 'blurry', seed: 1234, width: 832, height: 1216 };

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'precise-reference-ce-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  const studyInbox = path.join(root, 'study-inbox'), studyExports = path.join(root, 'study-exports');
  for (const dir of [runtimeDir, libraryDirectory, userData, studyInbox, studyExports]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.resolve(runtimeDir, '..', 'library', 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assetService = createAssetLibraryService({ repository, material: async () => { throw Object.assign(new Error('fixture: no material library'), { code: 'material_failed' }); }, study: args => studies.material_studies(args) });
  const jobs = new Map<string, any>(), enqueued: any[] = [];
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    enqueued.push({ snapshot: args.snapshot, snapshots: args.snapshots });
    const job = { batchId: randomUUID(), requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds, originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, activeJobId: null,
      items: args.seeds.map((seed: number, index: number) => ({ index, status: 'queued', jobId: null, seed, plannedSeed: seed, results: [] })) };
    jobs.set(args.requestKey, job); return structuredClone(job);
  }), lookup: vi.fn((args: any) => structuredClone(jobs.get(args.requestKey) ?? null)), list: vi.fn(() => ({ batches: [...jobs.values()].map(job => structuredClone(job)) })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const queue = createQueueRecipeService({ runtimeDir, batch: batch as any, historyById: id => repository.get('history', id)?.payload as any ?? null,
    validateImage: data => { const png = PNG.sync.read(data); return { width: png.width, height: png.height }; }, readHistoryOriginal: createHistoryImageReader(repository) });
  const hostMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: Record<string, unknown>) => {
    try { return await (queue as any)[method](args); } catch (error) { throw queueBridgeError(error); }
  }]));
  const materialMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = { material_studies: args => studies.material_studies(args), asset_library: args => assetService.asset_library(args) };
  Object.assign(hostMethods, Object.fromEntries(Object.entries(materialMethods).map(([method, call]) => [method, async (args: Record<string, unknown>) => {
    try { return await call(args); } catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : 'failed'); }
  }])));
  const host = await startHttpBridge({ runtimeDir, dispatch: async (method, args) => {
    if (Object.hasOwn(hostMethods, method)) return hostMethods[method](args);
    throw new BridgeError('workspace_unavailable', 'fixture: no renderer', 503);
  } });
  cleanups.push(() => host.close());
  const load = (name: string) => import(/* @vite-ignore */ new URL(name, import.meta.url).href);
  const { createNovelAiMcpServer, createBridgeClient } = await load('../../src/mcp.mjs');
  const { Client } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { InMemoryTransport } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  // The server an agent gets: compact readbacks.
  const server = createNovelAiMcpServer({ bridgeClient: createBridgeClient({ runtimeDir }), studyInbox, studyExports });
  const client = new Client({ name: 'precise-reference-ce', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  return { studyInbox, call, enqueued, runtimeDir };
}
const ok = (result: any, step: string) => { expect(result.isError, `${step}: ${JSON.stringify(result.structuredContent ?? result).slice(0, 3000)}`).not.toBe(true); return result.structuredContent; };

it('an agent imports a character sheet and an outfit, prepares a set of V5 recipes that reference them and enqueues the set: every image is queued with the prepared reference images', async () => {
  const f = await fixture();
  const sheet = gradient(1000, 1500), outfit = gradient(768, 768, 40);
  await fs.writeFile(path.join(f.studyInbox, 'sheet.png'), sheet); await fs.writeFile(path.join(f.studyInbox, 'outfit.png'), outfit);
  const imported = ok(await f.call('material_studies', { action: 'import', files: ['sheet.png', 'outfit.png'] }), 'import');
  expect(imported.counts).toMatchObject({ saved: 2, failed: 0 });
  const image = (file: string) => { const item = imported.items.find((entry: any) => entry.file === file); return { kind: 'study', studyId: item.id, studyRevision: item.revision }; };
  const references = [{ image: image('sheet.png'), type: 'character', sameOutfit: false, strength: 1.2 }, { image: image('outfit.png'), type: 'outfit' }];

  const recipes = [];
  for (const positivePrompt of ['1girl, garden, standing', '1girl, kitchen, cooking', '1girl, rooftop, night']) recipes.push(ok(await f.call('prepare_recipe', { mode: 't2i', ...GEN, positivePrompt, references }), `prepare ${positivePrompt}`));
  for (const recipe of recipes) {
    expect(recipe.ready).toBe(true);
    // Only what the call did not write: the outfit's default strength and each request image.
    expect(recipe.effective.references).toEqual([
      { index: 0, original: { width: 1000, height: 1500 }, request: { width: 832, height: 1216 }, fit: 'cropped', percent: 3 },
      { index: 1, strength: 1, original: { width: 768, height: 768 }, request: { width: 1024, height: 1024 }, fit: 'resized' },
    ]);
    expect(recipe.warnings.find((warning: any) => warning.code === 'precise_reference_paid')).toMatchObject({ references: 2, anlasPerImage: 10 });
  }
  expect(new Set(recipes.map(recipe => recipe.inputHash)).size).toBe(3);
  // The recipe files keep the library references, never the image bytes.
  const store = path.join(f.runtimeDir, 'queue-recipes');
  for (const name of (await fs.readdir(store)).filter(entry => entry.endsWith('.json'))) expect(await fs.readFile(path.join(store, name), 'utf8')).not.toContain(sheet.toString('base64').slice(0, 96));

  const receipt = ok(await f.call('enqueue_recipes', { requestKey: 'character-set', items: recipes.map(recipe => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash })) }), 'enqueue');
  expect(receipt).toMatchObject({ status: 'enqueued', count: 3 });
  expect(receipt.warnings.filter((warning: any) => warning.code === 'precise_reference_paid')).toHaveLength(3);
  expect(f.enqueued).toHaveLength(1);
  const snapshots = f.enqueued[0].snapshots;
  expect(snapshots).toHaveLength(3);
  // The batch holds each request image once; every image gets both back when it is submitted.
  const table = snapshots[0].referenceImages;
  expect(Object.keys(table)).toHaveLength(2);
  const sizes = Object.values(table).map(data => { const png = PNG.sync.read(Buffer.from(data as string, 'base64')); return `${png.width}×${png.height}`; }).sort();
  expect(sizes).toEqual(['1024×1024', '832×1216']);
  for (const [index] of snapshots.entries()) {
    const sent = inflateReferenceImages(snapshots, index).extras.preciseReferences!;
    expect(sent.map(reference => [reference.type, reference.strength, reference.fidelity, reference.prepared])).toEqual([['character', 1.2, 1, true], ['costume', 1, 1, true]]);
    for (const reference of sent) expect(sha256(Buffer.from(reference.base64, 'base64'))).toBe(reference.sha256);
  }
  // The same key and plan again is the same batch, not a second one.
  const again = ok(await f.call('enqueue_recipes', { requestKey: 'character-set', items: recipes.map(recipe => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash })) }), 'enqueue again');
  expect(again.status).toBe('already_enqueued'); expect(f.enqueued).toHaveLength(1);
  // What cannot be sent is refused with its reason.
  const refused = await f.call('prepare_recipe', { mode: 't2i', ...GEN, model: 'nai-diffusion-4-5-full', positivePrompt: '1girl', references: [{ image: image('outfit.png'), type: 'outfit' }] });
  expect(refused.isError).toBe(true); expect(refused.structuredContent.error).toMatchObject({ code: 'invalid_arguments', message: expect.stringContaining('Outfit references exist on NovelAI V5 only') });
}, 60_000);
