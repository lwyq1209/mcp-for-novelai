// Issue #2 原反例 CE-I2-1（端到端，主反例）。实现前冻结；在 main d917b22 上应当失败于第 3 步。
// 设计：novelai/.tmp/issue2-20261101/design.md §3（公开形状、端到端流程）与 §9.1。
// 用户已拍板：外部图片走「导入图片」（study），配方源图写成 {kind:"study", studyId, studyRevision}，不带 assetId。
//
// 路径：真实 MCP（src/mcp.mjs createNovelAiMcpServer，studyInbox/studyExports 指向临时目录）
//   → 真实 HTTP bridge（startHttpBridge，含 asset_library 契约校验）
//   → 与 main.ts registerIpc 同样的宿主方法表（队列方法经 queueBridgeError，素材方法经 BridgeError）
//   → 真实 SQLite 仓库（带 libraryDirectory）、真实研读服务（parse = parseImageStudy）、真实素材库服务、
//     真实配方存储（readHistoryOriginal 接真实读取器 createHistoryImageReader）。
// 只走公开的 MCP 工具调用，断言只看公开回复字段。替身只有：Electron nativeImage（pngjs）、axios（禁网）、
// 账号存储（禁读）和批次后端（本反例不入队）。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

// ipc/nai.ts（配方构建器所在）在 import 时会碰 electron、axios 和账号存储；测试里一律替身，禁网、禁账号。
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); }, request: () => { throw new Error('No network'); }, create: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', async () => {
  const { PNG: Png } = await import('pngjs');
  const forbidden = () => { throw new Error('fixture: no native UI or account paths'); };
  // 小型 nativeImage：pngjs 解码，最近邻缩放，toPNG 重编码（同 tests/mcp-recipes-modes.test.mjs 的夹具）。
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
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError, startHttpBridge } from './bridge-server';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
/** 768×1216 RGBA：模拟 design 7.1 补边后的图——上 64 行、右 64 列全透明，其余不透明渐变。 */
function paddedPng() {
  const png = new PNG({ width: 768, height: 1216 });
  for (let y = 0; y < 1216; y++) for (let x = 0; x < 768; x++) {
    const i = (y * 768 + x) * 4, added = y < 64 || x >= 704;
    png.data[i] = (x * 3 + y) & 255; png.data[i + 1] = (y * 2) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = added ? 0 : 255;
  }
  return PNG.sync.write(png);
}
const GEN = { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: '1girl, ponytail, holding baton, simple background', negativePrompt: 'blurry', seed: 1234 };
/**
 * design 7.1 的两个矩形：上边 768×64、右边 64×1216（px）。宿主按 8×8 潜空间格选：
 * 上边 96×8 格 + 右边 8×152 格 − 重叠的右上角 8×8 格 = 768 + 1216 − 64 = 1920；总格 (768/8)×(1216/8) = 96×152 = 14592。
 * 与 design 7.2 的实验结果（1920/14592，bbox 96×152）一致。
 */
const MASK = { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 768, height: 64 } }, { op: 'add', shape: { type: 'rect', x: 704, y: 0, width: 64, height: 1216 } }] };
const EXPECTED_CELLS = { selected: 96 * 8 + 8 * 152 - 8 * 8, total: 96 * 152 };

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

/**
 * main.ts registerIpc 的同款接线（只换掉 Electron、窗口和生成后端）：
 * - 目录：libraryDirectory = <bridge runtime>/../library（main.ts:1615），研读目录 = …/library/studies（main.ts:885）；
 * - 仓库：openLibraryRepository({filePath, userDataRoot, libraryDirectory})（library-startup.ts:91）；
 * - 素材库服务：createAssetLibraryService({repository, material, study})（main.ts:748-752；toFileUrl 是 Electron 协议，省略）；
 * - 配方存储：createQueueRecipeService({runtimeDir, batch, historyById, validateImage, readHistoryOriginal: createHistoryImageReader(repository)})（main.ts:814-822）；
 * - 宿主方法表：QUEUE_METHODS 经 queueBridgeError（main.ts:823-827），material_studies/asset_library 经 BridgeError（main.ts:892-898）；
 * - dispatch：hostMethods 里有的方法直接调用（bridge-host.ts:43-45）。
 */
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-ce-i2-1-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime');
  const libraryDirectory = path.resolve(runtimeDir, '..', 'library');
  const userData = path.join(root, 'user-data');
  const studyInbox = path.join(root, 'study-inbox'), studyExports = path.join(root, 'study-exports');
  for (const dir of [runtimeDir, libraryDirectory, userData, studyInbox, studyExports]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.resolve(runtimeDir, '..', 'library', 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assetService = createAssetLibraryService({ repository, material: async () => { throw Object.assign(new Error('fixture: no material library'), { code: 'material_failed' }); }, study: args => studies.material_studies(args) });
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async () => { throw new Error('fixture: CE-I2-1 never enqueues'); }), lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const queue = createQueueRecipeService({ runtimeDir, batch: batch as any,
    historyById: id => repository.get('history', id)?.payload as any ?? null,
    validateImage: data => { const png = PNG.sync.read(data); return { width: png.width, height: png.height }; },
    readHistoryOriginal: createHistoryImageReader(repository) });
  const hostMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: Record<string, unknown>) => {
    try { return await (queue as any)[method](args); }
    catch (error) { throw queueBridgeError(error); }
  }]));
  const materialMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = { material_studies: args => studies.material_studies(args), asset_library: args => assetService.asset_library(args) };
  Object.assign(hostMethods, Object.fromEntries(Object.entries(materialMethods).map(([method, call]) => [method, async (args: Record<string, unknown>) => {
    try { return await call(args); }
    catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : '素材操作未完成。'); }
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
  const server = createNovelAiMcpServer({ wholeResults: true, bridgeClient: createBridgeClient({ runtimeDir }), studyInbox, studyExports });
  const client = new Client({ name: 'issue2-ce-i2-1', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  // 上面的 wholeResults 是服务端的测试选项：这里的断言读完整回读（source 的 sha256 等）；agent 拿到的精简回读在 novelai/tests 里测。
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  // read_recipe 工具已删除：存储回读走配方模块的 read()，经同一条真实 HTTP bridge，回复包装与核心工具相同。
  const { createRecipeQueue } = await load('../../src/recipe-queue.mjs');
  const { success } = await load('../../src/mcp-registry.mjs');
  const recipes = createRecipeQueue({ bridge: createBridgeClient({ runtimeDir }) });
  const readRecipe = async (args: Record<string, unknown>) => success(await recipes.read(args)) as any;
  return { studyInbox, call, readRecipe };
}
/** 成功的工具回复；失败时把公开的错误回复原样写进断言信息（基点日志里能看到拒绝原因）。 */
const ok = (result: any, step: string) => { expect(result.isError, `${step}: ${JSON.stringify(result.structuredContent ?? result).slice(0, 3000)}`).not.toBe(true); return result.structuredContent; };
const readbackOf = (prepared: Record<string, unknown>) => Object.fromEntries(Object.entries(prepared).filter(([key]) => !['saved', 'generationSubmitted', 'next'].includes(key)));

it('CE-I2-1 外部图片经 material_studies import 成为 study 源：i2i、inpaint（preview 再保存）、重复导入走公开 MCP，存储回读走配方模块', async () => {
  const f = await fixture();
  // 1. 一张 768×1216 的 RGBA PNG 放进临时 study-inbox
  const bytes = paddedPng(), fileSha = sha256(bytes);
  await fs.writeFile(path.join(f.studyInbox, 'issue2-padded.png'), bytes);

  // 2. material_studies import → saved
  const imported = ok(await f.call('material_studies', { action: 'import', files: ['issue2-padded.png'] }), 'step 2 import');
  expect(imported.counts).toMatchObject({ saved: 1, duplicate: 0, failed: 0, unknown: 0 });
  expect(imported.items[0]).toMatchObject({ file: 'issue2-padded.png', status: 'saved', revision: 1, sha256: fileSha });
  expect(imported.items[0].id).toMatch(UUID);
  const studyId: string = imported.items[0].id, studyRevision: number = imported.items[0].revision;
  const source = { kind: 'study', studyId, studyRevision };

  // 3. prepare_recipe i2i，source 是 study 身份（不带 assetId）→ 保存成功，回读的 source 是 study，sha256 等于文件的
  const i2i = ok(await f.call('prepare_recipe', { mode: 'i2i', source, ...GEN, width: 768, height: 1216, strength: 0.5 }), 'step 3 prepare_recipe i2i with study source');
  expect(i2i).toMatchObject({ saved: true, generationSubmitted: false, mode: 'i2i', ready: true });
  expect(i2i.recipeId).toMatch(UUID);
  expect(i2i.source).toMatchObject({ kind: 'study', studyId, studyRevision, sha256: fileSha, mimeType: 'image/png', width: 768, height: 1216, byteLength: bytes.length });
  expect(i2i.source).not.toHaveProperty('historyId');

  // 4. prepare_recipe inpaint，两个矩形蒙版：先 preview:true（不保存），再保存
  const inpaintArgs = { mode: 'inpaint', source, ...GEN, strength: 1, mask: MASK };
  const preview = await f.call('prepare_recipe', { ...inpaintArgs, preview: true });
  const previewed = ok(preview, 'step 4 prepare_recipe inpaint preview with study source');
  expect(previewed).toMatchObject({ preview: true, saved: false, recipeId: null, recipeRevision: null, mode: 'inpaint' });
  expect(previewed.source).toMatchObject({ kind: 'study', studyId, studyRevision, sha256: fileSha, width: 768, height: 1216 });
  expect(previewed.mask).toMatchObject({ selectedCells: EXPECTED_CELLS.selected, totalCells: EXPECTED_CELLS.total });
  expect(previewed.previewImage).toMatchObject({ mimeType: 'image/webp', imageAttached: true, cells: EXPECTED_CELLS });
  expect(preview.content.map((item: any) => item.type)).toEqual(['text', 'image']);
  const inpaint = ok(await f.call('prepare_recipe', inpaintArgs), 'step 4 prepare_recipe inpaint save with study source');
  expect(inpaint).toMatchObject({ saved: true, generationSubmitted: false, mode: 'inpaint', ready: true });
  expect(inpaint.source).toMatchObject({ kind: 'study', studyId, studyRevision, sha256: fileSha, mimeType: 'image/png', width: 768, height: 1216, byteLength: bytes.length });
  expect(inpaint.mask).toMatchObject({ selectedCells: EXPECTED_CELLS.selected, totalCells: EXPECTED_CELLS.total, bboxCells: { x: 0, y: 0, width: 96, height: 152 }, spec: MASK });

  // 5. 再导入同一个文件 → duplicate，同一个 id；这个身份照样能当源（design §6、§9.3 第 6 步）
  const again = ok(await f.call('material_studies', { action: 'import', files: ['issue2-padded.png'] }), 'step 5 re-import');
  expect(again.counts).toMatchObject({ saved: 0, duplicate: 1, failed: 0, unknown: 0 });
  expect(again.items[0]).toMatchObject({ status: 'duplicate', id: studyId, sha256: fileSha });
  const duplicateSource = { kind: 'study', studyId: again.items[0].id, studyRevision: again.items[0].revision };
  const fromDuplicate = ok(await f.call('prepare_recipe', { mode: 'i2i', source: duplicateSource, ...GEN, width: 768, height: 1216, strength: 0.5 }), 'step 5 prepare_recipe i2i from the duplicate identity');
  expect(fromDuplicate).toMatchObject({ saved: true, mode: 'i2i' });
  expect(fromDuplicate.source).toMatchObject({ kind: 'study', studyId, sha256: fileSha });
  // 引用身份不进 inputHash（design F9）：同一张图、同一组参数，inputHash 与第 3 步相同。
  expect(fromDuplicate.inputHash).toBe(i2i.inputHash);

  // 6. 存储回读（配方模块 read()；read_recipe 工具已删除）与 prepare 的回读一致
  for (const [label, prepared] of [['i2i', i2i], ['inpaint', inpaint]] as const) {
    const read = ok(await f.readRecipe({ recipeId: prepared.recipeId, recipeRevision: prepared.recipeRevision, inputHash: prepared.inputHash }), `step 6 stored readback ${label}`);
    expect(read).toEqual(readbackOf(prepared));
    expect(read.source).toMatchObject({ kind: 'study', studyId, studyRevision, sha256: fileSha });
  }
});
