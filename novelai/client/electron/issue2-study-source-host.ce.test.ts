// Issue #2 原反例 CE-I2-2（宿主配方存储）。实现前冻结；在 main d917b22 上应当失败：旧代码在 put 时拒绝 study 引用
// （invalid_argument「A referenced source needs … ref {kind:"history", id, revision, assetId} …」）。
// 设计：novelai/.tmp/issue2-20261101/design.md §3.3 第 4 条、§9.1。
// 宿主配方存储接受 ref:{kind:"study", id, revision}（键集合精确，不带 assetId），并在 put、read、enqueue 时
// 各按引用重读一次研读原图、按登记的 sha256 核对。这里不窥探读取器的调用参数，只看可观测的行为：
// 原图被替换后，enqueue、read、put 各自报 recipe_source_changed；换回原字节后各自恢复。
//
// 接线与 main.ts 相同：真实 SQLite 仓库（带 libraryDirectory）、真实研读服务（parse = parseImageStudy）、
// 真实配方存储，readHistoryOriginal 接 createHistoryImageReader(repository)（main.ts:821）。
// 替身只有：Electron nativeImage（pngjs）、axios（禁网）、账号存储（禁读）和记录型批次后端。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); }, request: () => { throw new Error('No network'); }, create: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
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
import { createQueueRecipeService } from './queue-recipe-service';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const gradientPng = (width = 64, height = 64, shift = 0) => { const png = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const i = (y * width + x) * 4; png.data[i] = (x * 4 + shift) & 255; png.data[i + 1] = (y * 4) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = x < 8 ? 0 : 255; } return PNG.sync.write(png); };
const params = { positivePrompt: 'teacup, table', negativePrompt: 'text, watermark', seed: 42, seedMode: 'fixed', width: 64, height: 64, promptAssemblyVersion: 1 };
const i2iPreparation = (source: Record<string, unknown>) => ({ mode: 'i2i', authored: { params, i2iParams: { strength: 0.6, noise: 0, extraNoiseSeed: 5 } }, assets: [source] });
const studyRef = (id: string, revision: number, bytes: Buffer, change: Record<string, unknown> = {}) => ({ role: 'source', mimeType: 'image/png', ref: { kind: 'study', id, revision }, sha256: sha256(bytes), byteLength: bytes.length, ...change });
/** 应当成功的宿主调用；失败时把错误码写进失败信息（基点日志里能看到旧代码的拒绝码）。 */
const expectOk = <T>(promise: Promise<T>, step: string) => promise.catch((error: any) => { throw new Error(`${step} rejected: ${error?.code}: ${error?.message}`); });
const item = (recipe: any, seed: number) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash, seed });

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

/** main.ts 的同款构造：libraryDirectory = <runtime>/../library（main.ts:1615）、研读目录 …/library/studies（main.ts:885）、配方存储 main.ts:814-822。 */
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-ce-i2-2-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  for (const dir of [runtimeDir, libraryDirectory, userData]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.resolve(runtimeDir, '..', 'library', 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assets = createAssetLibraryService({ repository, study: args => studies.material_studies(args) });
  const jobs = new Map<string, any>();
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; delete job.snapshot; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const service = createQueueRecipeService({ runtimeDir, batch: batch as any,
    historyById: id => repository.get('history', id)?.payload as any ?? null,
    validateImage: data => { const png = PNG.sync.read(data); return { width: png.width, height: png.height }; },
    readHistoryOriginal: createHistoryImageReader(repository) });
  const store = path.join(runtimeDir, 'queue-recipes');
  const files = async () => { try { return Object.fromEntries(await Promise.all((await fs.readdir(store)).sort().map(async name => [name, sha256(await fs.readFile(path.join(store, name)))]))); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; } };
  /** 经真实研读服务导入（宿主方法 material_studies import），返回研读身份与原件在研读目录里的位置。 */
  const importStudy = async (bytes: Buffer, name = 'source.png') => {
    const result = await studies.material_studies({ action: 'import', name, data: bytes.toString('base64') }) as any;
    expect(result.duplicate).toBe(false);
    // 研读原件由宿主固定写成 <libraryDirectory>/studies/<id>/original.<ext>（repository.ts:405-409、image-studies.ts importImage）。
    return { id: result.study.id as string, revision: result.study.revision as number, original: path.join(libraryDirectory, 'studies', result.study.id, 'original.png') };
  };
  return { service, batch, assets, store, files, importStudy };
}

it('CE-I2-2 put/read/enqueue 都按 study 引用重读并核对原图：原图被替换时各自报 recipe_source_changed，换回后恢复', async () => {
  const h = await setup(), bytes = gradientPng(), study = await h.importStudy(bytes);
  const reference = studyRef(study.id, study.revision, bytes);

  // put：保存成功；回读带 study 引用；源图就是研读原件的字节
  const saved = await expectOk(h.service.put_queue_recipe({ preparation: i2iPreparation(reference) }), 'put_queue_recipe with ref {kind:"study"}');
  expect(saved.assetRefs).toEqual([{ role: 'source', mimeType: 'image/png', ref: { kind: 'study', id: study.id, revision: study.revision }, sha256: sha256(bytes), byteLength: bytes.length }]);
  expect(saved.snapshot.reviewInput.readiness.status).toBe('ready');
  expect(saved.snapshot.reviewInput.assets.find((asset: any) => asset.role === 'source')).toMatchObject({ sha256: sha256(bytes), data: bytes.toString('base64') });
  // 配方存储只存引用，不复制字节（与 history 引用相同）：此刻存储目录里只有这一份配方，任何文件都不含原图的 base64
  const stored = await Promise.all((await fs.readdir(h.store)).map(name => fs.readFile(path.join(h.store, name), 'utf8')));
  expect(stored.length).toBeGreaterThan(0);
  for (const text of stored) expect(text).not.toContain(bytes.toString('base64').slice(0, 64));
  // 引用身份不进 inputHash（design F9）：同一张图内嵌成字节时 inputHash 相同
  const embedded = await h.service.put_queue_recipe({ preparation: i2iPreparation({ role: 'source', mimeType: 'image/png', data: bytes.toString('base64') }) });
  expect(saved.inputHash).toBe(embedded.inputHash);

  // read：按引用回读，结果与 put 一致
  expect(await h.service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1 })).toEqual(saved);

  // 原图被替换（同尺寸、不同字节）：enqueue、read、put 各自重读，都报 recipe_source_changed；不写回执、不派发
  await fs.writeFile(study.original, gradientPng(64, 64, 9));
  const before = await h.files();
  const enqueueFailure: any = await h.service.enqueue_queue_recipes({ requestKey: 'study-source-replaced', items: [item(saved, 1)] }).catch(error => error);
  expect(enqueueFailure).toMatchObject({ code: 'recipe_source_changed', details: { recipeId: saved.recipeId, recipeRevision: 1, ref: { kind: 'study', id: study.id, revision: study.revision } } });
  expect(h.batch.enqueue).not.toHaveBeenCalled();
  expect(await h.service.lookup_queue_request({ requestKey: 'study-source-replaced' })).toEqual({ batch: null });
  const readFailure: any = await h.service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1 }).catch(error => error);
  expect(readFailure).toMatchObject({ code: 'recipe_source_changed', details: { recipeId: saved.recipeId, recipeRevision: 1, ref: { kind: 'study', id: study.id, revision: study.revision } } });
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(reference) })).rejects.toMatchObject({ code: 'recipe_source_changed' });
  expect(await h.files()).toEqual(before);

  // 换回原字节：read 和 enqueue 都恢复；冻结批次带着重读到的原图字节
  await fs.writeFile(study.original, bytes);
  expect((await h.service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1 })).inputHash).toBe(saved.inputHash);
  const job = await h.service.enqueue_queue_recipes({ requestKey: 'study-source-restored', items: [item(saved, 1), item(saved, 2)] });
  expect(job.batchId).toEqual(expect.any(String));
  expect(h.batch.enqueue).toHaveBeenCalledTimes(1);
  expect(h.batch.enqueue.mock.calls[0][0]).toMatchObject({ mode: 'i2i', seeds: [1, 2], snapshot: { sourceImage: { data: bytes.toString('base64') } } });
});

it('CE-I2-2 study 引用的身份不符时给出明确的码，什么都不保存', async () => {
  const h = await setup(), bytes = gradientPng(), study = await h.importStudy(bytes);
  // 研读不存在、版本不存在：recipe_source_unavailable（读取器 library_not_found）
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(randomUUID(), 1, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_unavailable', details: { readerCode: 'library_not_found' } });
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, 99, bytes)) })).rejects.toMatchObject({ code: 'recipe_source_unavailable', details: { readerCode: 'library_not_found' } });
  // 登记的 sha256 或字节数与原图不符：recipe_source_changed
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, study.revision, bytes, { sha256: '0'.repeat(64) })) })).rejects.toMatchObject({ code: 'recipe_source_changed' });
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, study.revision, bytes, { byteLength: bytes.length + 1 })) })).rejects.toMatchObject({ code: 'recipe_source_changed' });
  // study 引用的键集合精确、id 是研读 UUID（design §3.3 第 4 条）：带 assetId、id 不是 UUID，都是 invalid_argument
  for (const ref of [{ kind: 'study', id: study.id, revision: study.revision, assetId: 'anything' }, { kind: 'study', id: 'not-a-uuid', revision: 1 }])
    await expect(h.service.put_queue_recipe({ preparation: i2iPreparation({ ...studyRef(study.id, study.revision, bytes), ref }) })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(await h.files()).toEqual({});
  // 同一个引用身份正确时保存成功（证明上面的拒绝来自身份不符，而不是 study 引用本身）
  await expect(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, study.revision, bytes)) })).resolves.toMatchObject({ assetRefs: [{ ref: { kind: 'study', id: study.id, revision: study.revision } }] });
});

it('CE-I2-2 研读的任何已存在版本都能当源；归档不等于删除（design §3.1、F7）', async () => {
  const h = await setup(), bytes = gradientPng(), study = await h.importStudy(bytes);
  const first = await expectOk(h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, 1, bytes)) }), 'put_queue_recipe with ref {kind:"study", revision:1}');
  // 经素材库归档研读 → 版本 2；原图文件不变
  const archived = await h.assets.asset_library({ action: 'mutate', command: 'archive', items: [{ kind: 'study', id: study.id, expectedRevision: 1 }], patch: { archived: true } });
  expect(JSON.stringify(archived)).toContain(study.id);
  // 旧版本 1 的配方照样能读；新版本 2 也能当源，两者 inputHash 相同（同一张原图）
  expect((await h.service.read_queue_recipe({ recipeId: first.recipeId, recipeRevision: 1 })).inputHash).toBe(first.inputHash);
  const second = await h.service.put_queue_recipe({ preparation: i2iPreparation(studyRef(study.id, 2, bytes)) });
  expect(second.assetRefs[0].ref).toEqual({ kind: 'study', id: study.id, revision: 2 });
  expect(second.inputHash).toBe(first.inputHash);
});
