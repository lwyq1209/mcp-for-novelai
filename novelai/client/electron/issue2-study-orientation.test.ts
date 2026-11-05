// Issue #2 (design §3.5): a study original with EXIF orientation other than 1 is refused as a recipe source before
// anything is saved. End to end: real MCP → real HTTP bridge (asset_library contract) → real study service, asset
// library service and reader (sharp reports the orientation) and real recipe store. Same wiring as CE-I2-1.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); }, request: () => { throw new Error('No network'); }, create: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => { const forbidden = () => { throw new Error('fixture: no native UI or account paths'); }; return { app: { getPath: forbidden, getVersion: forbidden }, dialog: {}, nativeImage: { createFromBuffer: forbidden, createFromPath: forbidden } }; });

import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError, startHttpBridge } from './bridge-server';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-orientation-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  const studyInbox = path.join(root, 'study-inbox'), studyExports = path.join(root, 'study-exports');
  for (const dir of [runtimeDir, libraryDirectory, userData, studyInbox, studyExports]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.join(libraryDirectory, 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assets = createAssetLibraryService({ repository, study: args => studies.material_studies(args) });
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async () => { throw new Error('never enqueued'); }), lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const queue = createQueueRecipeService({ runtimeDir, batch: batch as any, readHistoryOriginal: createHistoryImageReader(repository) });
  const hostMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: Record<string, unknown>) => {
    try { return await (queue as any)[method](args); } catch (error) { throw queueBridgeError(error); }
  }]));
  for (const [method, run] of Object.entries({ material_studies: (args: Record<string, unknown>) => studies.material_studies(args), asset_library: (args: Record<string, unknown>) => assets.asset_library(args) }))
    hostMethods[method] = async args => { try { return await run(args); } catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : 'failed'); } };
  const host = await startHttpBridge({ runtimeDir, dispatch: async (method, args) => { if (Object.hasOwn(hostMethods, method)) return hostMethods[method](args); throw new BridgeError('workspace_unavailable', 'fixture: no renderer', 503); } });
  cleanups.push(() => host.close());
  const load = (name: string) => import(/* @vite-ignore */ new URL(name, import.meta.url).href);
  const { createNovelAiMcpServer, createBridgeClient } = await load('../../src/mcp.mjs');
  const { Client } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { InMemoryTransport } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const server = createNovelAiMcpServer({ bridgeClient: createBridgeClient({ runtimeDir }), studyInbox, studyExports });
  const client = new Client({ name: 'issue2-orientation', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  const store = path.join(runtimeDir, 'queue-recipes');
  return { studyInbox, call, recipes: async () => (await fs.readdir(store).catch(() => [])).filter(name => /^[a-f0-9-]{36}\.\d+\.json$/.test(name)) };
}
const GEN = { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl', negativePrompt: '', seed: 1 };

it('a rotated JPEG or PNG study is refused as a source before any put (source_orientation_unsupported); nothing is saved', async () => {
  const f = await fixture();
  const base = () => sharp({ create: { width: 768, height: 1152, channels: 3, background: '#406080' } });
  const files = { 'rotated.jpg': await base().jpeg().withMetadata({ orientation: 6 }).toBuffer(), 'mirrored.png': await base().png().withMetadata({ orientation: 2 }).toBuffer() };
  for (const [name, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(f.studyInbox, name), bytes);
    const imported = (await f.call('material_studies', { action: 'import', files: [name] })).structuredContent.items[0];
    expect(imported.status).toBe('saved');
    const image = (await f.call('asset_library', { action: 'image', kind: 'study', id: imported.id, revision: imported.revision })).structuredContent;
    expect(image.sourceOrientation).toBe(name === 'rotated.jpg' ? 6 : 2);
    const result = await f.call('prepare_recipe', { mode: 'i2i', source: { kind: 'study', studyId: imported.id, studyRevision: imported.revision }, ...GEN, width: 768, height: 1152, strength: 0.5 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error).toMatchObject({ code: 'invalid_arguments', details: { reason: 'source_orientation_unsupported', path: 'source', source: { orientation: name === 'rotated.jpg' ? 6 : 2 } } });
  }
  expect(await f.recipes()).toEqual([]);
});
