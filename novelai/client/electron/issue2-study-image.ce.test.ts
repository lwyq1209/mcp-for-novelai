// Issue #2 原反例 CE-I2-3（读取器）。实现前冻结；在 main d917b22 上应当失败：asset_library 的 image 分支
// 只认 kind:"history" 且 assetId 必填，study 读取被契约拒绝（宿主 bridge 和 MCP 两边都按生成的契约校验）。
// 设计：novelai/.tmp/issue2-20261101/design.md §3.3 第 1–3 条、§9.1。
// 新契约分支 {action:"image", kind:"study", id:<UUID>, revision, variant?}（不收 assetId）：读取器按研读版本登记的
// 唯一一张 original 资产读图，核对强度与 history 相同。返回缩略图时 contentBinding 是 recorded-sha256，
// assetId 是那张原图的（不是素材库列表里 preview.webp 的 assetId）。
//
// 接线：真实 SQLite 仓库（带 libraryDirectory）、真实研读服务（parse = parseImageStudy）、真实素材库服务，
// 经真实 HTTP bridge（含契约校验）和真实 MCP（src/mcp.mjs）。宿主方法表同 main.ts:892-898。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { BridgeError, startHttpBridge } from './bridge-server';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** 768×1216 RGBA，上 64 行、右 64 列透明。 */
function paddedPng() {
  const png = new PNG({ width: 768, height: 1216 });
  for (let y = 0; y < 1216; y++) for (let x = 0; x < 768; x++) {
    const i = (y * 768 + x) * 4, added = y < 64 || x >= 704;
    png.data[i] = (x * 3 + y) & 255; png.data[i + 1] = (y * 2) & 255; png.data[i + 2] = (x ^ y) & 255; png.data[i + 3] = added ? 0 : 255;
  }
  return PNG.sync.write(png);
}

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'issue2-ce-i2-3-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, '.runtime'), libraryDirectory = path.resolve(runtimeDir, '..', 'library'), userData = path.join(root, 'user-data');
  const studyInbox = path.join(root, 'study-inbox'), studyExports = path.join(root, 'study-exports');
  for (const dir of [runtimeDir, libraryDirectory, userData, studyInbox, studyExports]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
  cleanups.push(() => repository.close());
  const studies = createImageStudyService({ directory: path.resolve(runtimeDir, '..', 'library', 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const assetService = createAssetLibraryService({ repository, study: args => studies.material_studies(args) });
  const materialMethods: Record<string, (args: Record<string, unknown>) => Promise<any>> = { material_studies: args => studies.material_studies(args), asset_library: args => assetService.asset_library(args) };
  const hostMethods = Object.fromEntries(Object.entries(materialMethods).map(([method, call]) => [method, async (args: Record<string, unknown>) => {
    try { return await call(args); }
    catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : '素材操作未完成。'); }
  }]));
  const host = await startHttpBridge({ runtimeDir, dispatch: async (method, args) => {
    if (Object.hasOwn(hostMethods, method)) return hostMethods[method](args);
    throw new BridgeError('workspace_unavailable', 'fixture: no renderer', 503);
  } });
  cleanups.push(() => host.close());
  const load = (name: string) => import(/* @vite-ignore */ new URL(name, import.meta.url).href);
  const { createNovelAiMcpServer, createBridgeClient } = await load('../../src/mcp.mjs');
  const { Client } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { InMemoryTransport } = await load('../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
  const bridge = createBridgeClient({ runtimeDir });
  const server = createNovelAiMcpServer({ bridgeClient: bridge, studyInbox, studyExports });
  const client = new Client({ name: 'issue2-ce-i2-3', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  cleanups.push(async () => { await client.close(); await server.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<any>;
  const bytes = paddedPng();
  await fs.writeFile(path.join(studyInbox, 'issue2-padded.png'), bytes);
  const imported = await call('material_studies', { action: 'import', files: ['issue2-padded.png'] });
  expect(imported.isError, JSON.stringify(imported.structuredContent)).not.toBe(true);
  const { id, revision } = imported.structuredContent.items[0];
  // 期望的 assetId：这一版研读登记的唯一 original 资产（读取器的授权来源，repository.ts imagesForItem/versionAssets）。
  const originals = repository.versionAssets(repository.get('study', id, revision)!).filter(asset => asset.role === 'original');
  expect(originals).toHaveLength(1);
  return { bytes, id: id as string, revision: revision as number, originalAssetId: originals[0].id, bridge, call };
}

/** 宿主拒绝时把错误码一起写进失败信息（BridgeError 的 code 不在默认输出里）。 */
const hostRead = (f: { bridge: any }, args: Record<string, unknown>) => f.bridge.call('asset_library', args).catch((error: any) => { throw new Error(`asset_library ${JSON.stringify(args)} rejected by the host: ${error?.code}: ${error?.message}`); });

it('CE-I2-3 宿主：经真实 HTTP bridge，asset_library {action:"image", kind:"study", id, revision} 返回原图的缩略图与原图本身', async () => {
  const f = await fixture();
  const facts = { kind: 'study', id: f.id, revision: f.revision, assetId: f.originalAssetId, role: 'original', sourceMimeType: 'image/png', sourceWidth: 768, sourceHeight: 1216, sourceByteLength: f.bytes.length, sourceSha256: sha256(f.bytes), contentBinding: 'recorded-sha256' };
  const thumbnail = await hostRead(f, { action: 'image', kind: 'study', id: f.id, revision: f.revision });
  expect(thumbnail).toMatchObject({ ...facts, variant: 'thumbnail', mimeType: 'image/webp' });
  const decoded = await sharp(Buffer.from(thumbnail.data, 'base64')).metadata();
  expect(decoded.format).toBe('webp');
  expect(Math.max(decoded.width!, decoded.height!)).toBeLessThanOrEqual(384);
  expect([thumbnail.width, thumbnail.height]).toEqual([decoded.width, decoded.height]);
  const original = await hostRead(f, { action: 'image', kind: 'study', id: f.id, revision: f.revision, variant: 'original' });
  expect(original).toMatchObject({ ...facts, variant: 'original', mimeType: 'image/png', width: 768, height: 1216 });
  expect(Buffer.from(original.data, 'base64')).toEqual(f.bytes);
});

it('CE-I2-3 MCP：公开的 asset_library image 读 study，返回原生缩略图；assetId 是原图的，不是列表里 preview 的', async () => {
  const f = await fixture();
  const result = await f.call('asset_library', { action: 'image', kind: 'study', id: f.id, revision: f.revision });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  expect(result.content.map((item: any) => item.type)).toEqual(['text', 'image']);
  expect(result.content[1].mimeType).toBe('image/webp');
  expect(result.structuredContent).toMatchObject({ kind: 'study', id: f.id, revision: f.revision, assetId: f.originalAssetId, variant: 'thumbnail', role: 'original', contentBinding: 'recorded-sha256', sourceWidth: 768, sourceHeight: 1216, sourceSha256: sha256(f.bytes) });
  expect(result.structuredContent.data).toBeUndefined();
  const listed = await f.call('asset_library', { action: 'list', kinds: ['study'] });
  expect(listed.isError, JSON.stringify(listed.structuredContent)).not.toBe(true);
  const row = listed.structuredContent.items.find((entry: any) => entry.id === f.id);
  expect(row?.image?.preview?.assetId).toEqual(expect.any(String));
  expect(result.structuredContent.assetId).not.toBe(row.image.preview.assetId);
});
