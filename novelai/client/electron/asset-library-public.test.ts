import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startHttpBridge } from './bridge-server';
import { createAssetLibraryService } from './asset-library-service';
import { openLibraryRepository } from './library/repository';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';

// Registered as soon as each resource exists: the directory goes even if opening the bridge or the test fails.
const cleanups: Cleanup[] = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));

it('public contract → MCP asset_library → real HTTP → SQLite creates and reads a versioned mixed collection', async () => {
  // Imported production .mjs modules consume the generated public contract;
  // the HTTP bridge below is real, with only its host dispatch supplied here.
  const bridgeModule = new URL('../../src/mcp.mjs', import.meta.url).href;
  const { createBridgeClient, createNovelAiMcpServer } = await import(/* @vite-ignore */ bridgeModule);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nai-public-collection-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repo = openLibraryRepository({ filePath: path.join(directory, 'library.sqlite') });
  cleanups.push(() => repo.close());
  const service = createAssetLibraryService({ repository: repo });
  const dispatch = vi.fn(async (method: string, args: Record<string, unknown>) => {
    expect(method).toBe('asset_library');
    return service.asset_library(args);
  });
  const host = await startHttpBridge({ runtimeDir: path.join(directory, 'bridge'), dispatch });
  try {
    const now = '2026-09-12T12:00:00Z';
    const history = { id: 'garden-image', filePath: '/fixture/garden.png', date: '2026-09-12', createdAt: now, params: { positivePrompt: 'adult gardener, sunlit garden', seed: 0 }, actualSeed: 0, model: 'nai-diffusion-5-full', width: 8, height: 8 };
    const note = { schemaVersion: 1, id: 'garden-note', kind: 'note', name: '雨窗书店心得', group: '', notes: 'Agent 观察（待验证）：窗光更清楚。', archived: false, revision: 1, createdAt: now, updatedAt: now };
    repo.put('history', history.id, history); repo.put('note', note.id, note);
    const bridge = createBridgeClient({ runtimeDir: path.join(directory, 'bridge') });
    const server = createNovelAiMcpServer({ bridgeClient: bridge });
    const client = new Client({ name: 'asset-public-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    // Same thrown-error shape as before: MCP errors carry the host or validation code.
    const call = async (args: Record<string, unknown>): Promise<any> => {
      const result: any = await client.callTool({ name: 'asset_library', arguments: args });
      if (result.isError) throw Object.assign(new Error(result.structuredContent.error.message), result.structuredContent.error);
      return result.structuredContent;
    };
    try {
    const created = await call({ action: 'create-collection', name: ' 雨窗书店·体验 ' });
    expect(created.collection).toMatchObject({ namespace: 'user', name: '雨窗书店·体验' });
    expect(created.collection.id).toMatch(/^user:/);
    const revisionAfterCreate = repo.getRevision();
    const duplicate = await call({ action: 'create-collection', name: '雨窗书店·体验' });
    expect(duplicate.collection.id).toBe(created.collection.id);
    expect(repo.getRevision()).toBe(revisionAfterCreate);
    expect(repo.collections('user')).toHaveLength(1);
    const items = [{ kind: 'history', id: history.id, expectedRevision: 1 }, { kind: 'note', id: note.id, expectedRevision: 1 }];
    await call({ action: 'mutate', command: 'add-to-collection', collectionId: created.collection.id, items });
    const listed = await call({ action: 'list', collectionId: created.collection.id });
    expect(listed.total).toBe(2);
    expect(listed.items.map((item: any) => item.kind).sort()).toEqual(['history', 'note']);
    for (const selected of items) {
      const result = await call({ action: 'read', kind: selected.kind, id: selected.id, detail: 'full' });
      expect(result.memberships).toContainEqual(expect.objectContaining({ namespace: 'user', collectionId: created.collection.id.slice('user:'.length) }));
    }
    expect(repo.get('history', history.id)?.payload).toEqual(history);
    expect(repo.get('note', note.id)?.payload).toEqual(note);

    for (const patch of [{ group: '雨窗书店·体验' }, { name: '雨窗书店·体验' }]) {
      await expect(call({ action: 'mutate', command: 'update', items: [items[0]], patch })).rejects.toMatchObject({ code: 'invalid_argument', message: expect.stringMatching(/history.*groupId.*add-to-collection/) });
    }
    const touched = await call({ action: 'mutate', command: 'update', items: [items[1]], patch: { notes: '用户反馈：保留清晨版。\nPi 观察（待验证）：窗光更清楚。' } });
    expect(touched.items[0].revision).toBe(2);
    const another = await call({ action: 'create-collection', name: '下一版' });
    await expect(call({ action: 'mutate', command: 'add-to-collection', collectionId: another.collection.id, items })).rejects.toMatchObject({ code: 'library_conflict' });
    expect((await call({ action: 'list', collectionId: another.collection.id })).total).toBe(0);
    await call({ action: 'mutate', command: 'add-to-collection', collectionId: another.collection.id, items: [items[0], { ...items[1], expectedRevision: 2 }] });
    expect((await call({ action: 'list', collectionId: another.collection.id })).total).toBe(2);

    const beforeRejectedInputs = dispatch.mock.calls.length;
    for (const args of [
      { action: 'create-collection', name: 'SFW', namespace: 'style' },
      { action: 'delete-collection', collectionId: created.collection.id },
      { action: 'mutate', command: 'update', items: [{ ...items[1], expectedRevision: 2 }], patch: { observations: 'invented field' } },
    ]) await expect(call(args)).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(dispatch).toHaveBeenCalledTimes(beforeRejectedInputs);
    expect((await call({ action: 'collections' })).collections.filter((value: any) => value.namespace === 'user')).toHaveLength(2);
    } finally { await client.close(); await server.close(); }
  } finally {
    await host.close(); repo.close(); await rm(directory, { recursive: true, force: true });
  }
});
