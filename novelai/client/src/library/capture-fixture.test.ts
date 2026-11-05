import { describe, expect, it } from 'vitest';
import { inspectImageMetadata, parseImageMeta } from '../png-meta';
import { captureArt, ART_THEMES } from './capture-art';
import { createCaptureFixture } from './capture-fixture';
import { summarizeDeleteReceipt, type DeleteReceipt, type TrashPage } from './impacts';

const NOW = new Date(2025, 10, 3, 18, 30, 0);
const MIB = 1024 * 1024;
const DAY = 86_400_000;
const ALL_KINDS = ['history', 'study', 'tag', 'combo', 'note', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset', 'artist_favorite'];

describe('capture fixture', () => {
  const { api, batches, importFile } = createCaptureFixture('zh', NOW);

  it('lists history with display totals and filters', async () => {
    const history = await api.assetLibrary({ action: 'list', kinds: ['history'], limit: 100 });
    expect(history.items).toHaveLength(40);
    expect(history.total).toBe(1284);
    expect(history.hasMore).toBe(false);
    const empty = await api.assetLibrary({ action: 'list', collectionId: 'user:c4', kinds: ['history', 'study'] });
    expect(empty.items).toHaveLength(0);
    const cafe = await api.assetLibrary({ action: 'list', collectionId: 'history:cafe', kinds: ['history'], limit: 100 });
    expect(cafe.items.length).toBeGreaterThan(0);
    expect(cafe.items.every((item: any) => item.payload.groupId === 'cafe')).toBe(true);
    expect(cafe.total).toBe(48);
    const query = await api.assetLibrary({ action: 'list', kinds: ['history'], query: 'NEON lights', limit: 100 });
    expect(query.items.length).toBeGreaterThan(0);
    expect(query.total).toBe(query.items.length);
    expect(query.items.every((item: any) => item.payload.params.positivePrompt.includes('neon lights'))).toBe(true);
    for (const kind of ALL_KINDS) {
      const list = await api.assetLibrary({ action: 'list', kinds: [kind] });
      expect(list.items.length, kind).toBeGreaterThan(0);
    }
    const sorted = history.items.map((item: any) => Date.parse(item.updatedAt));
    expect([...sorted].sort((a, b) => b - a)).toEqual(sorted);
    const page = await api.assetLibrary({ action: 'list', kinds: ['history'], offset: 10, limit: 5 });
    expect(page.items.map((item: any) => item.id)).toEqual(history.items.slice(10, 15).map((item: any) => item.id));
  });

  it('reads items, thumbnails and collections', async () => {
    const detail = await api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' });
    expect(detail.memberships.map((value: any) => value.collectionId).sort()).toEqual(['c1', 'c2']);
    expect(detail.assets[0].fileUrl.startsWith('data:image/svg+xml')).toBe(true);
    await expect(api.assetLibrary({ action: 'read', kind: 'history', id: 'h999' })).rejects.toThrow();
    const thumb = await api.assetLibrary({ action: 'thumbnail', kind: 'history', id: 'h1', revision: 1, assetId: 'a-h1' });
    expect(thumb.status).toBe('ready');
    expect(thumb.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
    const { collections } = await api.assetLibrary({ action: 'collections' });
    expect(collections.filter((value: any) => value.namespace === 'user')).toHaveLength(4);
    expect(collections.filter((value: any) => value.namespace === 'history')).toHaveLength(4);
    await expect(api.assetLibrary({ action: 'versions', kind: 'history', id: 'h1' })).rejects.toThrow('Not available in UI capture');
  });

  it('previews the delete of screen 06 and clearing the archive', async () => {
    const items = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map(id => ({ kind: 'history', id, expectedRevision: 1 }));
    const receipt: DeleteReceipt = await api.assetLibrary({ action: 'mutate', command: 'delete', items, preview: true });
    const summary = summarizeDeleteReceipt(receipt);
    expect(summary.filesMoved).toBe(5);
    expect(summary.filesKept).toBe(1);
    expect(summary.bytesMoved! / MIB).toBeGreaterThanOrEqual(15);
    expect(summary.bytesMoved! / MIB).toBeLessThanOrEqual(16.5);
    expect(summary.collections).toEqual(expect.arrayContaining(['夏日企划', '封面候选']));
    expect(summary.recipes).toBe(2);
    expect(summary.coversCleared).toContain('cafe interior');
    const committed: DeleteReceipt = await api.assetLibrary({ action: 'mutate', command: 'delete', items });
    expect(committed.deleted!.every(row => typeof row.trashId === 'string')).toBe(true);
    const archived = summarizeDeleteReceipt(await api.assetLibrary({ action: 'mutate', command: 'delete-archived', preview: true }));
    expect(archived.rows).toHaveLength(12);
    expect(archived.filesMoved).toBe(9);
    // As the host: in a preview, remaining counts every archived item (this round's included).
    expect(archived.remaining).toBe(12);
    expect(archived.rows.filter(row => row.impacts?.collections?.length)).toHaveLength(2);
    expect(await api.assetLibrary({ action: 'mutate', command: 'add-to-collection', items, collectionId: 'user:c1' })).toEqual({});
  });

  it('lists recently deleted entries with their days left', async () => {
    const page: TrashPage = await api.assetLibrary({ action: 'recently-deleted', offset: 0, limit: 100 });
    expect(page.entries).toHaveLength(8);
    expect(page.total).toBe(8);
    expect(page.entries.map(entry => Math.ceil((Date.parse(entry.expiresAt) - NOW.getTime()) / DAY))).toEqual([30, 30, 29, 28, 25, 17, 7, 2]);
    expect(page.entries.every(entry => Date.parse(entry.deletedAt) < NOW.getTime())).toBe(true);
    expect(page.entries.every(entry => Date.parse(entry.expiresAt) - Date.parse(entry.deletedAt) === 30 * DAY)).toBe(true);
    const kinds = new Set(page.entries.map(entry => entry.deletedBy?.kind));
    expect(kinds).toEqual(new Set(['user', 'agent']));
    const mb = page.entries.reduce((sum, entry) => sum + (entry.bytes?.moved ?? 0), 0) / MIB;
    expect(mb).toBeCloseTo(46.2, 0);
  });

  it('serves material entries and samples', async () => {
    const { entry } = await api.materialLibrary!({ action: 'read', id: 't1' });
    expect(entry.tag.text).toBe('smile');
    expect(entry.coverStatus).toBe('ready');
    const samples = await api.materialSamples!({ action: 'list', entryId: 't1', revision: 1, page: 1, limit: 6, minScore: 20, rating: 'g' });
    expect(samples.items).toHaveLength(6);
    const image = await api.materialSamples!({ action: 'image', entryId: 't1', postId: samples.items[0].postId });
    expect(atob(image.data).startsWith('<svg')).toBe(true);
  });

  it('builds queue batches', () => {
    expect(batches).toHaveLength(9);
    expect(batches[0].status).toBe('running');
    expect(batches[0].items.filter(item => item.status === 'succeeded')).toHaveLength(7);
    expect(batches[1].source).toEqual({ kind: 'manual', persistent: false });
    expect(batches[0].source).toEqual({ kind: 'agent', client: { name: 'claude-code', version: null } });
  });

  it('makes an import file with NovelAI metadata', async () => {
    const file = await importFile();
    expect(file.name).toBe('pixiv_reference_01.png');
    expect(file.type).toBe('image/png');
    const report = inspectImageMetadata(parseImageMeta(await file.arrayBuffer()));
    expect(report.kind).toBe('novelai');
    expect(report.imported.positivePrompt).toContain('cherry blossoms');
    expect(report.imported.steps).toBe(28);
    expect(report.imported.seed).toBe(3301227);
  });

  it('draws deterministic art', () => {
    const a = captureArt(1000, 832, 1216, 'cafe');
    expect(a.startsWith('data:image/svg+xml')).toBe(true);
    expect(captureArt(1000, 832, 1216, 'cafe')).toBe(a);
    expect(createCaptureFixture('en', NOW).batches.length).toBe(9);
    expect(ART_THEMES).toHaveLength(8);
    expect(typeof (globalThis as any).window).toBe('undefined');
  });
});
