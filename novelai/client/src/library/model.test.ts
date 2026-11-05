import { describe, expect, it } from 'vitest';
import type { AssetItem } from '../asset-library/types';
import type { BatchJob } from '../workspace/batch-types';
import {
  batchIndex, dateFloor, dateRange, dayGroups, filterArgs, imageAspect, imageMode, imageSource, listRequest, matchesFilters, membershipIndex,
  neighbour, NO_FILTERS, projectCollections, projectGroupId, rangeSelection, sameView, userCollections, viewKey,
} from './model';
import { purgeSize, summarizeDeleteReceipt, trashDaysLeft, trashDeletedBy, trashImpacts, type TrashEntry } from './impacts';

const history = (id: string, payload: Record<string, unknown> = {}, createdAt = '2026-11-03T09:00:00.000Z'): AssetItem => ({
  kind: 'history', id, revision: 1, name: id, archived: false, createdAt, updatedAt: createdAt, source: { namespace: 'history' },
  payload: { id, createdAt, width: 832, height: 1216, model: 'nai-diffusion-5-full', params: { positivePrompt: 'cup' }, ...payload },
} as unknown as AssetItem);
const batch = (batchId: string, source: BatchJob['source'], mode: BatchJob['mode'] = 't2i'): BatchJob => ({ batchId, source, mode, status: 'running', count: 2, items: [], createdAt: '', updatedAt: '' } as unknown as BatchJob);

describe('library view model', () => {
  it('builds the window list request of each view; the image filters go to the host only in image views', () => {
    const options = { query: ' cup ', archived: 'include' as const, presetFilter: 'all' as const };
    expect(listRequest({ type: 'category', category: 'history' }, options)).toEqual({ action: 'ui-list', query: 'cup', archived: 'include', kinds: ['history'], sortBy: 'createdAt', sortDirection: 'desc' });
    const filters = { mode: 't2i' as const, createdFrom: 5 };
    expect(listRequest({ type: 'category', category: 'history' }, { ...options, filters })).toMatchObject({ mode: 't2i', createdFrom: 5 });
    expect(listRequest({ type: 'project', id: 'history:g1' }, { ...options, filters })).toMatchObject({ mode: 't2i' });
    expect(listRequest({ type: 'category', category: 'tags' }, { ...options, archived: 'only', filters })).toEqual({ action: 'ui-list', query: 'cup', archived: 'only', kinds: ['tag'], sortBy: 'updatedAt', sortDirection: 'desc' });
    expect(listRequest({ type: 'category', category: 'presets' }, { ...options, presetFilter: 'prompt_chunk' })).toMatchObject({ kinds: ['prompt_chunk'], sortBy: 'updatedAt' });
    expect(listRequest({ type: 'category', category: 'presets' }, options)).toMatchObject({ kinds: ['style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'] });
    expect(listRequest({ type: 'project', id: 'history:g1' }, options)).toMatchObject({ collectionId: 'history:g1', kinds: ['history'] });
    expect(listRequest({ type: 'collection', id: 'user:c1' }, options)).not.toHaveProperty('kinds');
    expect(() => listRequest({ type: 'trash' }, options)).toThrow();
    expect(viewKey({ type: 'project', id: 'history:g1' })).toBe('project:history:g1');
    expect(sameView({ type: 'category', category: 'tags' }, { type: 'category', category: 'tags' })).toBe(true);
    expect(projectGroupId('history:abc')).toBe('abc');
    const collections = [{ id: 'user:a', name: 'A', namespace: 'user' }, { id: 'history:g', name: 'G', namespace: 'history' }, { id: 'style:x', name: 'X' }];
    expect(userCollections(collections).map(value => value.id)).toEqual(['user:a']);
    expect(projectCollections(collections).map(value => value.id)).toEqual(['history:g']);
  });

  it('tells agent images from manual ones and names the agent through its batch', () => {
    const index = batchIndex([batch('b1', { kind: 'agent', client: { name: 'claude-code', version: null } }, 'i2i'), batch('m1', { kind: 'manual', persistent: false }, 'inpaint')]);
    const agent = history('a', { generationOrigin: { jobId: 'j', mode: 'i2i' }, queueOrigin: { batchId: 'b1', requestKey: 'k', itemIndex: 0 } });
    const unknownAgent = history('u', { generationOrigin: { jobId: 'j', mode: 't2i' }, queueOrigin: { batchId: 'gone', requestKey: 'k', itemIndex: 0 } });
    const manual = history('m', { queueOrigin: { batchId: 'm1', requestKey: 'k', itemIndex: 0 } });
    expect(imageSource(agent, index)).toEqual({ kind: 'agent', label: 'Claude Code', batchId: 'b1' });
    expect(imageSource(unknownAgent, index)).toMatchObject({ kind: 'agent', label: 'Agent' });
    expect(imageSource(manual, index)).toEqual({ kind: 'manual' });
    expect(imageSource({ kind: 'study', payload: {} } as never)).toEqual({ kind: 'imported' });
    expect(imageMode(agent, index)).toBe('i2i');
    expect(imageMode(manual, index)).toBe('inpaint');
    expect(imageMode(history('d', { model: 'director-lineart' }))).toBe('director');
    expect(imageMode(history('t'))).toBeNull();
    // Step 4b3c: a manual image names its click's mode in feature (no generationOrigin); it stays a manual image.
    const manualI2I = history('mi', { feature: 'i2i' });
    expect(imageMode(manualI2I)).toBe('i2i');
    expect(imageSource(manualI2I)).toEqual({ kind: 'manual' });
    expect(imageMode(history('legacy', { feature: 'generate' }))).toBeNull();
  });

  it('filters by mode, model, date and source (the test the host list applies), and turns them into host arguments', () => {
    const now = new Date(2026, 10, 3, 18, 0);
    const today = history('today', { generationOrigin: { mode: 't2i' } }, new Date(2026, 10, 3, 9).toISOString());
    const old = history('old', { model: 'nai-diffusion-4-5-full' }, new Date(2026, 9, 1).toISOString());
    expect(matchesFilters(today, NO_FILTERS)).toBe(true);
    expect(matchesFilters(today, { ...NO_FILTERS, mode: 't2i' })).toBe(true);
    expect(matchesFilters(old, { ...NO_FILTERS, mode: 't2i' })).toBe(false);
    expect(matchesFilters(old, { ...NO_FILTERS, model: 'nai-diffusion-4-5-full' })).toBe(true);
    expect(matchesFilters(old, { ...NO_FILTERS, date: '30d' }, new Map(), now)).toBe(false);
    expect(matchesFilters(today, { ...NO_FILTERS, date: 'today' }, new Map(), now)).toBe(true);
    expect(matchesFilters(old, { ...NO_FILTERS, source: 'manual' })).toBe(true);
    expect(matchesFilters(today, { ...NO_FILTERS, source: 'manual' })).toBe(false);
    expect(dateFloor('7d', now)).toBe(new Date(2026, 9, 28).getTime());
    // A month: its first local midnight up to the next month's.
    expect(dateRange('month:2026-10', now)).toEqual({ from: new Date(2026, 9, 1).getTime(), before: new Date(2026, 10, 1).getTime() });
    expect(matchesFilters(old, { ...NO_FILTERS, date: 'month:2026-10' }, new Map(), now)).toBe(true);
    expect(matchesFilters(today, { ...NO_FILTERS, date: 'month:2026-10' }, new Map(), now)).toBe(false);
    expect(filterArgs({ mode: 't2i', model: '', date: '7d', source: 'agent:Codex' }, now)).toEqual({ mode: 't2i', source: 'agent:Codex', createdFrom: new Date(2026, 9, 28).getTime() });
    expect(filterArgs(NO_FILTERS, now)).toEqual({});
    expect(matchesFilters({ kind: 'study', id: 's', payload: {}, createdAt: today.createdAt } as never, { ...NO_FILTERS, source: 'imported' })).toBe(true);
    expect(matchesFilters(today, { ...NO_FILTERS, source: 'imported' })).toBe(false);
  });

  it('groups by local day newest first, keeps aspect ratios bounded, indexes memberships and selects ranges', () => {
    const now = new Date(2026, 10, 3, 18, 0);
    const items = [history('a', {}, new Date(2026, 10, 3, 17).toISOString()), history('b', {}, new Date(2026, 10, 3, 9).toISOString()), history('c', {}, new Date(2026, 10, 2, 9).toISOString()), history('d', {}, new Date(2026, 9, 1).toISOString())];
    expect(dayGroups(items, 'zh', now).map(group => [group.label, group.items.length])).toEqual([['今天', 2], ['昨天', 1], ['10 月 1 日', 1]]);
    expect(dayGroups(items, 'en', now).map(group => group.label)).toEqual(['Today', 'Yesterday', 'Oct 1']);
    // created_at is the field (the list's sort column): a payload time that says otherwise does not move the image.
    expect(dayGroups([history('p', { createdAt: new Date(2026, 9, 1).toISOString() }, new Date(2026, 10, 3, 9).toISOString())], 'zh', now)[0].label).toBe('今天');
    // A day met again later (texts of mixed time zones sort apart): its own key, never two groups with one key.
    const split = dayGroups([items[0], items[2], items[1]], 'zh', now);
    expect(split.map(group => group.key)).toEqual(['2026-11-03', '2026-11-02', '2026-11-03#2']);
    expect(split.map(group => !!group.split)).toEqual([true, false, true]);
    expect(new Set(split.map(group => group.key)).size).toBe(split.length);
    expect(imageAspect(items[0])).toBeCloseTo(832 / 1216);
    expect(imageAspect(history('w', { width: 9000, height: 10 }))).toBe(4);
    expect(imageAspect(history('z', { width: 0, height: 0 }))).toBe(1);
    const index = membershipIndex([{ collectionId: 'user:a', items: [items[0], items[1]] }, { collectionId: 'user:b', items: [items[0]] }]);
    expect(index.get('history:a')).toEqual(['user:a', 'user:b']);
    expect(index.get('history:c')).toBeUndefined();
    const order = ['x', 'y', 'z', 'w'];
    expect(rangeSelection(order, 'y', 'w')).toEqual(['y', 'z', 'w']);
    expect(rangeSelection(order, 'w', 'x')).toEqual(['x', 'y', 'z', 'w']);
    expect(rangeSelection(order, null, 'z')).toEqual(['z']);
    expect(neighbour(order, 'y', 1)).toBe('z');
    expect(neighbour(order, 'x', -1)).toBeNull();
  });
});

describe('Recently deleted receipts and entries', () => {
  it('summarizes a preview: files and bytes, shared and missing files, user collections, recipes, covers', () => {
    const summary = summarizeDeleteReceipt({ preview: true, deleted: [
      { kind: 'history', id: 'a', revision: 1, name: 'a', files: { moved: 1, kept: 0, missing: 0 }, bytes: { moved: 1000, unknownSize: 0 }, impacts: { collections: [{ collectionId: 'user:1', name: 'Summer' }, { collectionId: 'history:g', name: 'cafe' }], recipes: [{ recipeId: 'r1' }], coversCleared: [{ kind: 'tag', id: 't', name: 'cafe interior' }] } },
      { kind: 'history', id: 'b', revision: 1, name: 'b', files: { moved: 0, kept: 1, missing: 0 }, bytes: { moved: 0, unknownSize: 0 }, impacts: { collections: [{ collectionId: 'user:1', name: 'Summer' }], recipes: [{ recipeId: 'r1' }, { recipeId: 'r2' }] } },
      { kind: 'tag', id: 'c', revision: 1, name: 'c', files: { moved: 1, kept: 0, missing: 1 }, bytes: { moved: 500, unknownSize: 1 }, impacts: { recipesUnknown: true } },
    ] });
    expect(summary).toMatchObject({ count: 3, omitted: 0, filesMoved: 2, bytesMoved: 1500, unknownSize: 1, filesKept: 1, filesMissing: 1, collections: ['Summer'], recipes: 2, recipesUnknown: true, coversCleared: ['cafe interior'] });
    expect(summary.byKind).toEqual([{ kind: 'history', count: 2 }, { kind: 'tag', count: 1 }]);
  });
  it('uses the host totals when the receipt does not list every row, and has no size for receipts without bytes', () => {
    expect(summarizeDeleteReceipt({ deleted: [{ kind: 'history', id: 'a', revision: 1, name: 'a', files: { moved: 1 } }], omitted: { count: 499 }, totals: { entries: 500, files: { moved: 500, kept: 0, missing: 0 }, bytes: { moved: 5000, unknownSize: 0 } } }))
      .toMatchObject({ count: 500, omitted: 499, filesMoved: 500, bytesMoved: 5000 });
    expect(summarizeDeleteReceipt({ deleted: [{ kind: 'history', id: 'a', revision: 1, name: 'a', files: { moved: 1 } }] }).bytesMoved).toBeNull();
    expect(summarizeDeleteReceipt(null)).toMatchObject({ count: 0, filesMoved: 0 });
  });
  it('reads entries: days left rounded up, who deleted, impacts and what a purge removes', () => {
    const now = Date.UTC(2026, 10, 3, 12);
    const entry = (patch: Partial<TrashEntry>): TrashEntry => ({ trashId: 't', kind: 'history', id: 'a', name: 'a', deletedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 86_400_000 - 60_000).toISOString(), ...patch });
    expect(trashDaysLeft(entry({}), now)).toBe(30);
    expect(trashDaysLeft(entry({ expiresAt: new Date(now + 3600_000).toISOString() }), now)).toBe(1);
    expect(trashDaysLeft(entry({ expiresAt: new Date(now - 1).toISOString() }), now)).toBe(0);
    expect(trashDeletedBy(entry({ deletedBy: { kind: 'user' } }))).toEqual({ kind: 'user' });
    expect(trashDeletedBy(entry({ deletedBy: { kind: 'agent', client: { name: 'codex-mcp-client', version: null } } }))).toEqual({ kind: 'agent', label: 'Codex' });
    expect(trashDeletedBy(entry({ deletedBy: { kind: 'agent', client: null } }))).toEqual({ kind: 'agent', label: 'Agent' });
    expect(trashDeletedBy(entry({}))).toBeNull();
    expect(trashImpacts(entry({ impacts: { collections: 2, recipes: 1, coversCleared: 0 }, files: { kept: 1 } }))).toEqual([{ key: 'colls', n: 2 }, { key: 'recipes', n: 1 }, { key: 'shared', n: 1 }]);
    expect(trashImpacts(entry({ kind: 'collection', members: 17 }))).toEqual([{ key: 'members', n: 17 }]);
    expect(purgeSize([entry({ files: { moved: 1 }, bytes: { moved: 100 } }), entry({ files: { moved: 2 }, bytes: { moved: 50 } })])).toEqual({ files: 3, bytes: 150, shared: 0 });
    expect(purgeSize([entry({ files: { moved: 1 } })]).bytes).toBeNull();
  });
});
