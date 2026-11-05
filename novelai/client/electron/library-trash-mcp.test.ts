/**
 * Recently Deleted through the public MCP surface: the production MCP server (novelai/src) talks over the real HTTP
 * bridge to the real host asset service, Recently Deleted service and SQLite library, with real files in a throwaway
 * data root. Only the bridge dispatch is supplied here (main.ts routes asset_library the same way).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHttpBridge } from './bridge-server';
import { createAssetLibraryService } from './asset-library-service';
import { openLibraryRepository } from './library/repository';
import { createLibraryTrash } from './library-trash';

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(closers.splice(0).reverse()));

async function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-mcp-')), library = path.join(root, 'library'), output = path.join(root, 'output');
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(library); fs.mkdirSync(output);
  const repo = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root });
  closers.push(() => repo.close());
  const recipeId = randomUUID();
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined,
    recipeReferences: async targets => new Map(targets.filter(target => target.id === 'garden').map(target => [`${target.kind}:${target.id}`, [{ recipeId, recipeRevision: 2, sourceRevision: 1 }]])) });
  const service = createAssetLibraryService({ repository: repo, trash, toFileUrl: file => `fixture:${file}` });
  const dispatch = vi.fn(async (method: string, args: Record<string, unknown>) => { expect(method).toBe('asset_library'); return service.asset_library(args); });
  const host = await startHttpBridge({ runtimeDir: path.join(root, 'runtime'), dispatch });
  closers.push(() => host.close());
  const { createBridgeClient, createNovelAiMcpServer } = await import(/* @vite-ignore */ new URL('../../src/mcp.mjs', import.meta.url).href);
  const bridge = createBridgeClient({ runtimeDir: path.join(root, 'runtime') });
  const server = createNovelAiMcpServer({ bridgeClient: bridge });
  const client = new Client({ name: 'trash-mcp-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (args: Record<string, unknown>): Promise<any> => {
    const result: any = await client.callTool({ name: 'asset_library', arguments: args });
    if (result.isError) throw Object.assign(new Error(result.structuredContent.error.message), result.structuredContent.error);
    return result.structuredContent;
  };
  const image = (id: string) => {
    const file = path.join(output, `${id}.png`); fs.writeFileSync(file, `SFW garden image ${id}`);
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-02', createdAt: '2026-11-02T00:00:00Z', params: { positivePrompt: 'sunlit garden', seed: 3 }, actualSeed: 3, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  };
  return { root, repo, call, dispatch, image, recipeId, client, service, bridge };
}

it('MCP asset_library deletes with CAS, lists every effect, restores and purges; invalid requests never reach the host', async () => {
  const h = await harness();
  const garden = h.image('garden');
  const tagId = randomUUID();
  h.repo.put('tag', tagId, { schemaVersion: 1, id: tagId, kind: 'tag', name: 'garden', group: '', notes: '', tag: { text: 'garden', source: 'english', target: 'base', category: null } });
  fs.mkdirSync(path.join(h.root, 'library', 'covers'), { recursive: true }); fs.writeFileSync(path.join(h.root, 'library', 'covers', `${'c'.repeat(64)}.webp`), 'cover bytes');
  h.repo.setCover('tag', tagId, { sha256: 'c'.repeat(64), mimeType: 'image/webp', width: 8, height: 8, byteLength: 11, postId: null, sourceUrl: null, tagText: 'garden', tagCategory: null, rating: null, savedAt: '2026-11-02T00:00:00Z', verification: 'local', checkedAt: null, source: 'local', fileName: 'history-garden-r1.png', sourceSha256: 'c'.repeat(64), tagSource: 'english' });
  const collection = await h.call({ action: 'create-collection', name: 'Garden picks' });
  await h.call({ action: 'mutate', command: 'add-to-collection', collectionId: collection.collection.id, items: [{ kind: 'history', id: 'garden', expectedRevision: 1 }] });

  // CAS: a stale expectedRevision changes nothing.
  await expect(h.call({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden', expectedRevision: 2 }] })).rejects.toMatchObject({ code: 'library_conflict' });
  expect(h.repo.get('history', 'garden')).not.toBeNull();

  const preview = await h.call({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden', expectedRevision: 1 }], preview: true });
  expect(preview).toMatchObject({ preview: true, deleted: [{ category: 'history', kind: 'history', id: 'garden', impacts: { coversCleared: [{ kind: 'tag', id: tagId, name: 'garden' }], recipes: [{ recipeId: h.recipeId, recipeRevision: 2, sourceRevision: 1 }], collections: [{ collectionId: collection.collection.id, name: 'Garden picks' }] } }] });
  expect(h.repo.get('history', 'garden')).not.toBeNull();

  const receipt = await h.call({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden', expectedRevision: 1 }] });
  const deleted = receipt.deleted[0];
  expect(deleted).toMatchObject({ category: 'history', kind: 'history', id: 'garden', revision: 1, files: { moved: 1, kept: 0, missing: 0 }, impacts: { coversCleared: [{ id: tagId, coverRevision: 2 }], recipes: [{ recipeId: h.recipeId }] } });
  expect(deleted.trashId).toMatch(/^[a-f0-9-]{36}$/);
  expect(receipt.note).toMatch(/Recently Deleted for 30 days/);
  expect(JSON.stringify(receipt)).not.toContain(h.root);
  expect(fs.existsSync(garden.payload.filePath)).toBe(false);
  expect(h.repo.getCover('tag', tagId).cover).toBeNull();
  await expect(h.call({ action: 'read', kind: 'history', id: 'garden' })).rejects.toMatchObject({ code: 'library_not_found', message: expect.stringContaining(deleted.trashId) });
  expect((await h.call({ action: 'list', category: 'history' })).total).toBe(0);

  const listed = await h.call({ action: 'recently-deleted' });
  expect(listed).toMatchObject({ total: 1, limit: 10, retentionDays: 30, entries: [{ trashId: deleted.trashId, category: 'history', kind: 'history', id: 'garden', impacts: { coversCleared: 1, recipes: 1, collections: 1 } }] });
  expect((await h.call({ action: 'recently-deleted', query: 'nothing matches' })).total).toBe(0);

  const restored = await h.call({ action: 'restore', trashIds: [deleted.trashId] });
  expect(restored.restored).toMatchObject([{ kind: 'history', id: 'garden', revision: 1, files: { restored: 1 }, covers: { restored: [tagId] }, collections: { restored: [collection.collection.id] } }]);
  expect(fs.readFileSync(garden.payload.filePath, 'utf8')).toBe('SFW garden image garden');
  expect((await h.call({ action: 'list', collectionId: collection.collection.id })).total).toBe(1);
  await expect(h.call({ action: 'restore', trashIds: [deleted.trashId] })).rejects.toMatchObject({ code: 'library_not_found' });

  // A user collection: deleted (not its items), restored, deleted again and purged for good.
  const gone = await h.call({ action: 'mutate', command: 'delete', collectionId: collection.collection.id });
  expect(gone.collections).toMatchObject([{ collectionId: collection.collection.id, name: 'Garden picks', members: 1 }]);
  expect(h.repo.get('history', 'garden')).not.toBeNull();
  expect((await h.call({ action: 'collections' })).collections.filter((value: any) => value.namespace === 'user')).toEqual([]);
  await h.call({ action: 'restore', trashIds: [gone.collections[0].trashId] });
  expect((await h.call({ action: 'list', collectionId: collection.collection.id })).total).toBe(1);

  // Archived items in one call; a purge names its trashIds and is irreversible. Emptying everything is not offered to agents.
  await h.call({ action: 'mutate', command: 'archive', items: [{ kind: 'history', id: 'garden', expectedRevision: 1 }] });
  const archived = await h.call({ action: 'mutate', command: 'delete-archived', kinds: ['history'] });
  expect(archived).toMatchObject({ remaining: 0, deleted: [{ id: 'garden', archived: true }] });
  await expect(h.call({ action: 'purge', all: true })).rejects.toMatchObject({ code: 'invalid_arguments' });
  expect((await h.call({ action: 'recently-deleted' })).total).toBe(1);
  const purged = await h.call({ action: 'purge', trashIds: [archived.deleted[0].trashId] });
  expect(purged).toMatchObject({ purged: [{ kind: 'history', id: 'garden', files: { deleted: 1, kept: 0 } }] });
  expect(fs.existsSync(garden.payload.filePath)).toBe(false);
  expect(fs.readdirSync(path.join(h.root, 'trash'))).toEqual([]);
  // The host bridge refuses purge {all:true} even when sent around the MCP schema; the desktop's own call keeps it.
  await expect(h.bridge.call('asset_library', { action: 'purge', all: true })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(await h.service.asset_library({ action: 'purge', all: true })).toMatchObject({ purged: [], remaining: 0 });
  expect((await h.call({ action: 'recently-deleted' })).total).toBe(0);

  const before = h.dispatch.mock.calls.length;
  for (const args of [
    { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden' }] },
    { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden', expectedRevision: 1 }], collectionId: collection.collection.id },
    { action: 'restore', trashIds: ['not-a-trash-id'] },
    { action: 'purge' },
    { action: 'purge', all: false },
    { action: 'recently-deleted', limit: 50 },
  ]) await expect(h.call(args)).rejects.toMatchObject({ code: 'invalid_arguments' });
  expect(h.dispatch).toHaveBeenCalledTimes(before);
  const tool = (await h.client.listTools()).tools.find(value => value.name === 'asset_library')!;
  expect(tool.description).toMatch(/Recently Deleted.*30 days.*restore \{trashIds\}.*cannot be undone/);
});
