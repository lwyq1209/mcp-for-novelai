import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHttpBridge } from './bridge-server';
import { createAssetLibraryService } from './asset-library-service';
import { openLibraryRepository, type LibraryKind } from './library/repository';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';

// Each resource is registered as soon as it exists and released in reverse order after the test, also when
// setup or the test fails, times out or is retried; one failing close does not skip the others.
const cleanups: Cleanup[] = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

const categories: Record<string, LibraryKind[]> = {
  history: ['history'], imports: ['study'], tags: ['tag', 'artist_favorite'],
  presets: ['combo', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'], notes: ['note'],
};
const now = '2026-09-24T12:00:00Z';
const material = { schemaVersion: 1, id: 'shared-id', revision: 1, name: 'fixture shared', group: 'mixed', notes: '  original\nfixture ', archived: false, createdAt: now, updatedAt: now };

async function setup() {
  const mcpModule = new URL('../../src/mcp.mjs', import.meta.url).href;
  const { createBridgeClient, createNovelAiMcpServer } = await import(/* @vite-ignore */ mcpModule);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nai-category-http-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repo = openLibraryRepository({ filePath: path.join(directory, 'library.sqlite'), libraryDirectory: path.join(directory, 'fixture-library') });
  cleanups.push(() => repo.close());
  const history = { id: 'history-1', filePath: path.join(directory, 'fixture-history.png'), date: '2026-09-24', createdAt: now, params: { positivePrompt: 'blue_sky, fixture', negativePrompt: 'hidden-negative', seed: 0 }, actualSeed: 0, model: 'nai-diffusion-5-full', width: 8, height: 8 };
  repo.put('history', history.id, history);
  repo.put('tag', material.id, { ...material, kind: 'tag', tag: { text: 'fixture', source: 'english', target: 'style' } });
  repo.put('combo', material.id, { ...material, kind: 'combo', components: [{ text: 'fixture', source: 'english', target: 'style', weight: 1 }] });
  repo.put('note', material.id, { ...material, kind: 'note' });
  repo.put('artist_favorite', 'random:favorite-1', { collection: 'random', id: 'favorite-1', name: 'fixture favorite', artists: [], auxiliary: [], mutations: [], franchiseStyles: [], basePrompt: 'fixture', prompt: 'fixture', pairId: 'pair', variant: 'plain', sequence: 1, status: 'done', image: history });
  repo.put('study', 'study-1', { schemaVersion: 1, parserVersion: 1, study: { id: 'study-1', revision: 1, name: 'fixture imported', sha256: 'a'.repeat(64), mimeType: 'image/png', width: 8, height: 8, byteLength: 10, createdAt: now, updatedAt: now, archived: false, metadataStatus: 'none', sources: [], warnings: [], promptFieldCount: 0, parameterFieldCount: 0 }, notes: 'fixture', originalName: 'fixture.png', sections: { prompts: [], parameters: [], raw: {} } });
  repo.put('style_preset', 'style-1', { id: 'style-1', name: 'fixture style', group: 'styles', prompt: '  fixture\nstyle ', createdAt: now });
  repo.put('positive_preset', 'positive-1', { id: 'positive-1', name: 'fixture positive', prompt: 'fixture positive', createdAt: now });
  repo.put('prompt_chunk', 'chunk-1', { id: 'chunk-1', name: 'fixture chunk', content: 'fixture chunk', createdAt: now, updatedAt: now });
  repo.put('reference_preset', 'reference-1', { id: 'reference-1', name: 'fixture reference', group: '', kind: 'precise', filePath: path.join(directory, 'fixture-reference.png'), fileUrl: 'file:///fixture-reference.png', strength: 0.5, infoExtracted: 1, createdAt: now });
  // Synthetic metadata only: no image files are read or created by these list tests.
  repo.setCover('tag', material.id, { sha256: 'b'.repeat(64), mimeType: 'image/webp', width: 8, height: 8 });
  const service = createAssetLibraryService({ repository: repo });
  const dispatch = vi.fn(async (method: string, args: Record<string, unknown>) => {
    expect(method).toBe('asset_library');
    expect(args).not.toHaveProperty('category');
    expect(args).not.toHaveProperty('detail');
    return service.asset_library(args);
  });
  const host = await startHttpBridge({ runtimeDir: path.join(directory, 'fixture-bridge'), dispatch });
  cleanups.push(() => host.close());
  const bridge = createBridgeClient({ runtimeDir: path.join(directory, 'fixture-bridge') });
  const server = createNovelAiMcpServer({ bridgeClient: bridge });
  const client = new Client({ name: 'category-sqlite-fixture', version: '1' });
  cleanups.push(() => server.close(), () => client.close()); // reversed: the client closes first
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  const mcpRaw = (args: Record<string, unknown>) => client.callTool({ name: 'asset_library', arguments: args });
  const mcp = async (args: Record<string, unknown>) => {
    const result = await mcpRaw(args);
    expect(result.isError, JSON.stringify(result.structuredContent)).toBeUndefined();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toEqual(result.structuredContent);
    expect(result.content).toHaveLength(1);
    return result.structuredContent as any;
  };
  // close() releases everything now; afterEach does the same (idempotently) if the test never got here.
  return { repo, mcp, mcpRaw, dispatch, close: () => runCleanups(cleanups.splice(0).reverse()) };
}

it('MCP → HTTP → real SQLite returns five categories, combo in presets, and no image reclassification', async () => {
  const f = await setup();
  try {
    for (const call of [f.mcp]) {
      for (const [category, kinds] of Object.entries(categories)) {
        const before = f.dispatch.mock.calls.length;
        const result = await call({ action: 'list', category, query: 'fixture', limit: 20 });
        expect(result.items.map((item: any) => item.kind).sort()).toEqual([...kinds].sort());
        expect(result.items.every((item: any) => item.category === category)).toBe(true);
        expect(result.total).toBe(kinds.length);
        expect(f.dispatch).toHaveBeenCalledTimes(before + 1);
      }
      const all = await call({ action: 'list', query: 'fixture', limit: 20 });
      expect(all.items).toHaveLength(10);
      const tag = all.items.find((item: any) => item.kind === 'tag');
      expect(tag).toMatchObject({ category: 'tags', id: 'shared-id', revision: 1, image: { inspected: false, preview: { role: 'cover' } } });
      expect(all.items.find((item: any) => item.kind === 'artist_favorite')).toMatchObject({ category: 'tags', image: { inspected: false, preview: { role: 'favorite-image' } } });
      expect(all.items.find((item: any) => item.kind === 'study')).toMatchObject({ category: 'imports' });
      const imported = await call({ action: 'read', kind: 'study', id: 'study-1', revision: 1 });
      expect(imported.item.payload.sections).toEqual({ prompts: [], parameters: [], raw: {} });
      expect(imported.responseInfo).toMatchObject({ category: 'imports', detail: 'full', truncated: false });
    }
    expect(f.repo.get('tag', 'shared-id')?.revision).toBe(1);
    expect(f.repo.get('combo', 'shared-id')?.revision).toBe(1);
  } finally { await f.close(); }
});

it('category/kinds/collection/query are real intersections; legacy filters and stable paging stay intact', async () => {
  const f = await setup();
  try {
    for (const call of [f.mcp]) {
      const selected = await call({ action: 'list', category: 'presets', kinds: ['tag', 'combo', 'note'], collectionId: 'material:mixed', query: 'fixture' });
      expect(selected.items.map((item: any) => [item.kind, item.id])).toEqual([['combo', 'shared-id']]);
      expect((await call({ action: 'list', category: 'history', collectionId: 'material:mixed' })).total).toBe(0);
      expect((await call({ action: 'list', category: 'presets', collectionId: 'style:styles' })).items.map((item: any) => item.kind)).toEqual(['style_preset']);
      expect((await call({ action: 'list', category: 'tags', collectionId: 'material:mixed' })).items.map((item: any) => item.kind)).toEqual(['tag']);
      expect((await call({ action: 'list', category: 'presets', query: 'absent-word' })).total).toBe(0);
      expect((await call({ action: 'list', category: 'history', historyTags: ['blue sky'], historyTagSources: ['positive'], historyTagMatch: 'all' })).total).toBe(1);
      expect((await call({ action: 'list', category: 'history', historyTags: ['blue sky'], historyTagSources: ['character'] })).total).toBe(0);
      expect((await call({ action: 'list', category: 'history', query: 'hidden-negative' })).total).toBe(0);
      expect((await call({ action: 'list', historyTags: ['blue sky'] })).items.map((item: any) => item.kind)).toEqual(['history']);
      expect((await call({ action: 'list', kinds: [] })).total).toBe(10);
      const seen: string[] = [];
      let offset: number | null = 0;
      do {
        const page: any = await call({ action: 'list', category: 'presets', limit: 2, offset, sortBy: 'name', sortDirection: 'asc' });
        seen.push(...page.items.map((item: any) => item.kind));
        expect(page.total).toBe(5);
        offset = page.nextOffset;
      } while (offset !== null);
      expect(seen.sort()).toEqual([...categories.presets].sort());
    }
    const before = f.dispatch.mock.calls.length;
    expect((await f.mcpRaw({ action: 'list', category: 'presets', kinds: [] })).structuredContent).toMatchObject({ error: { code: 'invalid_arguments' } });
    expect((await f.mcpRaw({ action: 'list', category: 'tags', historyTags: ['blue sky'] })).structuredContent).toMatchObject({ error: { code: 'invalid_arguments' } });
    expect(f.dispatch).toHaveBeenCalledTimes(before);
    expect((await f.mcpRaw({ action: 'list', category: 'presets', collectionId: 'user:missing' })).structuredContent).toMatchObject({ error: { code: 'library_not_found' } });
  } finally { await f.close(); }
});

it('category-selected combo keeps kind/id/revision for exact reads, CAS edits, archive and mixed collections', async () => {
  const f = await setup();
  try {
    const selected = (await f.mcp({ action: 'list', category: 'presets', kinds: ['combo'] })).items[0];
    expect(selected).toMatchObject({ kind: 'combo', id: 'shared-id', revision: 1, category: 'presets' });
    const target = { kind: selected.kind, id: selected.id, revision: selected.revision };
    const full = await f.mcp({ action: 'read', ...target });
    expect(full.item).toEqual(f.repo.get('combo', 'shared-id', 1));
    expect(full.responseInfo).toMatchObject({ category: 'presets', detail: 'full', truncated: false });
    const edit = { action: 'mutate', command: 'update', items: [{ kind: selected.kind, id: selected.id, expectedRevision: selected.revision }], patch: { notes: '用户观察\n  keep exact ' } };
    const updated = await f.mcp(edit);
    expect(updated.items[0]).toMatchObject({ kind: 'combo', id: 'shared-id', revision: 2, payload: { notes: edit.patch.notes, components: full.item.payload.components } });
    expect(f.repo.get('tag', 'shared-id')?.payload.notes).toBe(material.notes);
    expect(f.repo.get('note', 'shared-id')?.payload.notes).toBe(material.notes);
    expect((await f.mcp({ action: 'read', ...target, detail: 'full' })).item).toEqual(full.item);
    expect((await f.mcpRaw(edit)).structuredContent).toMatchObject({ error: { code: 'library_conflict' } });
    expect(f.repo.readVersions('combo', 'shared-id')).toHaveLength(2);
    const collection = (await f.mcp({ action: 'create-collection', name: 'fixture mixed' })).collection;
    await f.mcp({ action: 'mutate', command: 'add-to-collection', collectionId: collection.id, items: [{ kind: 'combo', id: 'shared-id', expectedRevision: 2 }, { kind: 'history', id: 'history-1', expectedRevision: 1 }] });
    expect((await f.mcp({ action: 'list', collectionId: collection.id })).total).toBe(2);
    expect((await f.mcp({ action: 'list', category: 'presets', collectionId: collection.id })).items).toMatchObject([{ kind: 'combo', revision: 2, category: 'presets' }]);
    await f.mcp({ action: 'mutate', command: 'archive', items: [{ kind: 'combo', id: 'shared-id', expectedRevision: 2 }], patch: { archived: true } });
    expect((await f.mcp({ action: 'list', category: 'presets', collectionId: collection.id })).total).toBe(0);
    expect((await f.mcp({ action: 'list', category: 'presets', collectionId: collection.id, includeArchived: true })).items).toMatchObject([{ kind: 'combo', revision: 3, category: 'presets', archived: true }]);
    expect(f.dispatch.mock.calls.every(([method, args]) => method === 'asset_library' && ['list', 'read', 'mutate', 'create-collection'].includes(String(args.action)))).toBe(true);
  } finally { await f.close(); }
});
