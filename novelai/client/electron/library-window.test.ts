/**
 * oss/lib-1103: the library page's own host reads (library-window.ts) against the real asset library service, Recently
 * Deleted and the SQLite library, with real files in a throwaway data root: the host's mode / model / date / source /
 * archived filters give exactly the images the window's own test (src/library/model.ts matchesFilters) accepts, with
 * exact totals, pages and day counts; history items come compact; file sizes are read from disk without a write; the
 * archived list is complete; Recently deleted is sized in all. A bridge (MCP) call never reaches these actions.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS } from '../src/types';

/**
 * Cases that write hundreds of library entries (more than one 500-item request) run in about 1–3 s alone but can pass
 * 30 s when two full suites share the disk: they get an explicit longer limit; what they check is unchanged.
 */
const HEAVY_IO_TIMEOUT_MS = 120_000;

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'userData' ? path.join(fixture.root, 'user-data') : fixture.root, getVersion: () => '0.1.0', isPackaged: false },
  dialog: { showSaveDialog: async () => ({ canceled: true }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
}));

const closers: Array<() => unknown> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-window-')); vi.resetModules(); });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* closed */ } }
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

const DAY = 86_400_000;
async function harness() {
  const root = fixture.root, userData = path.join(root, 'user-data'), library = path.join(userData, 'library'), output = path.join(root, 'output');
  fs.mkdirSync(library, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const { openLibraryRepository } = await import('./library/repository');
  const repo = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory: library, userDataRoot: userData });
  closers.push(() => repo.close());
  const { activateLibrary, activateLibraryTrash, deactivateLibrary } = await import('./library-runtime');
  activateLibrary(repo, { userDataRoot: userData, libraryDirectory: library });
  closers.push(() => deactivateLibrary());
  const { createLibraryTrash } = await import('./library-trash');
  const trash = createLibraryTrash({ repository: repo, userDataRoot: userData, libraryDirectory: library, managedRoots: () => [output], toFileUrl: file => `fixture:${file}`, log: () => undefined, recipeReferences: async () => new Map() });
  activateLibraryTrash(trash);
  const { batchFactsOf } = await import('../src/library/image-facts');
  const batches = batchFactsOf([
    { batchId: 'b-claude', mode: 't2i', source: { kind: 'agent', client: { name: 'claude-code', version: '1' } } },
    { batchId: 'b-codex', mode: 'i2i', source: { kind: 'agent', client: { name: 'codex-mcp-client', version: null } } },
    { batchId: 'm-run', mode: 'enhance', source: { kind: 'manual', persistent: false } },
  ]);
  const { createAssetLibraryService } = await import('./asset-library-service');
  const service = createAssetLibraryService({ repository: repo, trash, toFileUrl: file => `fixture:${file}`, batchFacts: () => batches });
  /** The window's IPC (main.ts novelai:assets): deletedBy user, window. */
  const window = (args: Record<string, unknown>) => service.asset_library(args, { deletedBy: { kind: 'user' }, window: true });
  /** A bridge call (MCP): never the window. */
  const bridge = (args: Record<string, unknown>) => service.asset_library(args, { deletedBy: { kind: 'agent', client: { name: 'claude-code', version: '1' } } as never });
  const image = (id: string, extra: Record<string, unknown> = {}, created = new Date(), bytes = 1500) => {
    const file = path.join(output, `${id}.png`);
    fs.writeFileSync(file, Buffer.alloc(bytes, 3));
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-03', createdAt: created.toISOString(), params: { ...DEFAULT_PARAMS, positivePrompt: `teacup ${id}` }, actualSeed: 7, model: 'nai-diffusion-5-full', width: 832, height: 1216, ...extra });
  };
  return { repo, trash, service, window, bridge, image, batches, output };
}

describe('the plain read carries the current revision\'s preview, which MCP\'s read projects (4c1 review rework, approved)', () => {
  it('current revision (also named) yes, an older revision no; MCP summary image.preview, full item.preview, within the budget', async () => {
    const h = await harness();
    const first = h.image('h1'), second = h.image('h1', { groupId: 'g2' });
    expect(second.revision).toBe(first.revision + 1);
    const [listed] = (await h.bridge({ action: 'list', kinds: ['history'], limit: 10 })).items;
    const current = await h.bridge({ action: 'read', kind: 'history', id: 'h1' });
    expect(current.item.preview).toEqual(listed.preview);
    // Identity and size only: no path, URL or bytes.
    expect(Object.keys(current.item.preview).every(key => ['assetId', 'cacheKey', 'role', 'mimeType', 'width', 'height'].includes(key))).toBe(true);
    expect((await h.bridge({ action: 'read', kind: 'history', id: 'h1', revision: second.revision })).item.preview).toEqual(listed.preview);
    const older = await h.bridge({ action: 'read', kind: 'history', id: 'h1', revision: first.revision });
    expect(older.item).not.toHaveProperty('preview');
    // What the model reads (novelai/src/asset-library-response.mjs): the summary's image.preview, the full record's item.preview.
    const { assetLibraryResponse, ASSET_SUMMARY_BYTES } = await import('../../src/asset-library-response.mjs');
    const summary = assetLibraryResponse({ action: 'read', kind: 'history', id: 'h1' }, current);
    expect(summary.item.image).toEqual({ descriptionPresent: true, inspected: false, preview: { assetId: listed.preview.assetId, role: 'original', cacheKey: listed.preview.cacheKey } });
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(ASSET_SUMMARY_BYTES);
    const full = assetLibraryResponse({ action: 'read', kind: 'history', id: 'h1', detail: 'full' }, current);
    expect(full.item.preview).toEqual(listed.preview);
    const olderSummary = assetLibraryResponse({ action: 'read', kind: 'history', id: 'h1', revision: first.revision }, older);
    expect(olderSummary.item.image).not.toHaveProperty('preview');
    expect(assetLibraryResponse({ action: 'read', kind: 'history', id: 'h1', revision: first.revision, detail: 'full' }, older).item).not.toHaveProperty('preview');
    // It is the registered original the image action names.
    expect(summary.item.image.preview.assetId).toBe(current.assets.find((asset: { role: string }) => asset.role === 'original').id);
  });
});

describe('the window list filters in the host exactly as a tile reads an image', () => {
  it('mode, model, created range, source and archived: same images, same order, exact totals and pages', async () => {
    const h = await harness();
    // Noon today, so the hours before it are today whenever the test runs (the host takes the range it is given).
    const now = new Date(); now.setHours(12, 0, 0, 0);
    const hours = (n: number) => new Date(now.getTime() - n * 3_600_000);
    const origin = (mode: string) => ({ generationOrigin: { jobId: 'j', mode, originWorkspaceId: 'recipe-queue', submittedRevision: 1, actualSeed: 1 } });
    const queue = (batchId: string) => ({ queueOrigin: { batchId, requestKey: `k-${batchId}`, itemIndex: 0 } });
    h.image('a1', { ...origin('t2i'), ...queue('b-claude') }, hours(1));
    h.image('a2', { ...origin('i2i'), ...queue('b-codex') }, hours(2));
    h.image('a3', { ...origin('upscale'), ...queue('b-gone') }, hours(3)); // its batch is no longer listed: "Agent"
    h.image('m1', { ...queue('m-run') }, hours(4)); // a manual batch of this run: its mode
    h.image('m2', { model: 'director-lineart' }, hours(30));
    h.image('m3', { model: 'nai-diffusion-4-5-full-inpainting' }, hours(31));
    h.image('m4', { model: 'some-upscaler', params: { ...DEFAULT_PARAMS, positivePrompt: 'upscale' } }, hours(32));
    h.image('m5', { model: null, params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-curated', positivePrompt: 'cup' } }, hours(24 * 40));
    h.image('m6', { model: 'nai-diffusion-3' }, new Date(now.getFullYear(), now.getMonth() - 2, 15, 12));
    const archived = h.image('x1', { ...origin('t2i'), ...queue('b-claude') }, hours(5));
    h.repo.put('history', 'x1', archived.payload, { expectedRevision: archived.revision, archived: true });

    // The window reads a whole record (its payload) through the same functions a tile uses; the host reads the facts with SQL.
    const { factsMatch, imageFacts } = await import('../src/library/image-facts');
    const everything = (await h.window({ action: 'list', kinds: ['history'], includeArchived: true, sortBy: 'createdAt', sortDirection: 'desc', limit: 100 })).items;
    const midnight = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
    const month = { from: new Date(now.getFullYear(), now.getMonth() - 2, 1).getTime(), before: new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime() };
    type Args = { mode?: 't2i' | 'i2i' | 'inpaint' | 'enhance' | 'upscale' | 'director'; model?: string; source?: string; createdFrom?: number; createdBefore?: number };
    const cases: Array<[Args, 'exclude' | 'include' | 'only']> = [
      [{}, 'exclude'], [{}, 'include'], [{}, 'only'],
      [{ mode: 't2i' }, 'exclude'], [{ mode: 'i2i' }, 'exclude'], [{ mode: 'enhance' }, 'exclude'], [{ mode: 'director' }, 'exclude'], [{ mode: 'inpaint' }, 'exclude'], [{ mode: 'upscale' }, 'exclude'],
      [{ model: 'nai-diffusion-4-curated' }, 'exclude'], [{ model: 'nai-diffusion-5-full' }, 'include'],
      [{ source: 'agent' }, 'exclude'], [{ source: 'agent:Claude Code' }, 'include'], [{ source: 'agent:Codex' }, 'exclude'], [{ source: 'manual' }, 'exclude'],
      [{ createdFrom: midnight(0) }, 'exclude'], [{ createdFrom: midnight(6) }, 'include'], [{ createdFrom: midnight(29) }, 'exclude'],
      [{ createdFrom: month.from, createdBefore: month.before }, 'exclude'],
      [{ source: 'agent', mode: 't2i', createdFrom: midnight(6) }, 'include'],
    ];
    const sizes: number[] = [];
    for (const [args, archive] of cases) {
      const expected = everything.filter((item: any) => (archive === 'only' ? item.archived : archive === 'include' || !item.archived) && factsMatch(imageFacts(item), args, h.batches)).map((item: any) => item.id);
      const page = await h.window({ action: 'ui-list', kinds: ['history'], archived: archive, sortBy: 'createdAt', sortDirection: 'desc', limit: 500, ...args });
      expect(page.items.map((item: any) => item.id), JSON.stringify([args, archive])).toEqual(expected);
      expect(page.total).toBe(expected.length);
      sizes.push(expected.length);
    }
    // Every case selects something (the comparison is not vacuous); the time-independent ones, exactly.
    expect(sizes.every(size => size > 0 && size <= 10)).toBe(true);
    expect(sizes.slice(0, 9)).toEqual([9, 10, 1, 1, 1, 1, 1, 1, 2]);
    // Pages of a filtered list: exact total, offsets and hasMore.
    const agents = await h.window({ action: 'ui-list', kinds: ['history'], archived: 'include', source: 'agent', sortBy: 'createdAt', sortDirection: 'desc', limit: 2 });
    expect([agents.total, agents.items.map((item: any) => item.id), agents.hasMore]).toEqual([4, ['a1', 'a2'], true]);
    const next = await h.window({ action: 'ui-list', kinds: ['history'], archived: 'include', source: 'agent', sortBy: 'createdAt', sortDirection: 'desc', offset: 2, limit: 2 });
    expect([next.items.map((item: any) => item.id), next.hasMore]).toEqual([['a3', 'x1'], false]);
  });

  it('the summary counts the days of the result and lists the view’s models, agents and months', async () => {
    const h = await harness();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12), yesterday = new Date(today.getTime() - DAY);
    for (let index = 0; index < 7; index++) h.image(`t${index}`, index < 3 ? { generationOrigin: { jobId: 'j', mode: 't2i' }, queueOrigin: { batchId: 'b-claude', requestKey: 'k', itemIndex: index } } : {}, new Date(today.getTime() - index * 60_000));
    for (let index = 0; index < 4; index++) h.image(`y${index}`, { model: 'nai-diffusion-4-5-full' }, new Date(yesterday.getTime() - index * 60_000));
    const { localDayKey } = await import('../src/library/image-facts');
    const page = await h.window({ action: 'ui-list', kinds: ['history'], archived: 'exclude', sortBy: 'createdAt', sortDirection: 'desc', limit: 5, summary: true });
    // Only 5 items on the page, but the day counts are of the whole result.
    expect(page.items).toHaveLength(5);
    expect(page.summary.days).toEqual([{ day: localDayKey(today.toISOString()), count: 7 }, { day: localDayKey(yesterday.toISOString()), count: 4 }]);
    expect(page.summary.models).toEqual([{ model: 'nai-diffusion-5-full', count: 7 }, { model: 'nai-diffusion-4-5-full', count: 4 }]);
    expect(page.summary.agents).toEqual([{ label: 'Claude Code', count: 3 }]);
    expect(page.summary.months.map((value: any) => value.month)).toContain(localDayKey(today.toISOString()).slice(0, 7));
    // With a filter the days follow the result; the choices stay those of the view.
    const filtered = await h.window({ action: 'ui-list', kinds: ['history'], archived: 'exclude', source: 'agent', sortBy: 'createdAt', sortDirection: 'desc', limit: 5, summary: true });
    expect(filtered.summary.days).toEqual([{ day: localDayKey(today.toISOString()), count: 3 }]);
    expect(filtered.summary.models).toEqual(page.summary.models);
  });

  it('history items come compact (the grid’s fields); the drawer’s read has the whole record; a new revision is seen at once', async () => {
    const h = await harness();
    const saved = h.image('h1', { groupId: 'g1', characterPrompts: ['long character prompt'] });
    const [item] = (await h.window({ action: 'ui-list', kinds: ['history'], limit: 10 })).items;
    expect(Object.keys(item.payload).sort()).toEqual(['createdAt', 'date', 'filePath', 'groupId', 'height', 'id', 'model', 'params', 'width']);
    expect(item.payload.params).toEqual({ model: DEFAULT_PARAMS.model });
    expect(item.revision).toBe(saved.revision);
    expect(item.preview).toMatchObject({ role: 'original' });
    const detail = await h.window({ action: 'ui-read', kind: 'history', id: 'h1' });
    expect(detail.item.payload.params.positivePrompt).toBe('teacup h1');
    // Step 4c1: the read carries the same preview as the list (the queue page's thumbnails read by id alone); since the
    // review rework the shared plain read does too (MCP's asset_library read summary projects it), for the current
    // revision only (also when named); an older revision has none.
    expect(detail.item.preview).toEqual(item.preview);
    expect(detail.item.preview.assetId).toBe(detail.assets.find((asset: any) => asset.role === 'original').id);
    expect((await h.window({ action: 'read', kind: 'history', id: 'h1' })).item.preview).toEqual(item.preview);
    expect((await h.window({ action: 'read', kind: 'history', id: 'h1', revision: saved.revision })).item.preview).toEqual(item.preview);
    const thumbnail = await h.window({ action: 'thumbnail', kind: 'history', id: 'h1', revision: detail.item.revision, assetId: detail.item.preview.assetId });
    expect(thumbnail.cacheKey).toBe(detail.item.preview.cacheKey);
    expect(detail.item.payload.characterPrompts).toEqual(['long character prompt']);
    // The cached order of the view is per library revision: a change is seen by the next read.
    h.image('h2');
    expect((await h.window({ action: 'ui-list', kinds: ['history'], limit: 10 })).total).toBe(2);
  });
});

describe('prompt tag search of history images (step 4c1)', () => {
  it('ui-list keeps the images with all (or any) of the given prompt tags, with exact totals; a name search still finds tags by part', async () => {
    const h = await harness();
    const prompt = (text: string) => ({ params: { ...DEFAULT_PARAMS, positivePrompt: text } });
    h.image('p1', prompt('1girl, cat ears, night sky'), new Date(Date.now() - 1000));
    h.image('p2', prompt('1girl, cat ears, beach'), new Date(Date.now() - 2000));
    h.image('p3', prompt('landscape, night sky'), new Date(Date.now() - 3000));
    h.repo.put('tag', 't-cat', { schemaVersion: 1, id: 't-cat', revision: 1, kind: 'tag', name: 'cat ears', group: '', notes: '', archived: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tag: { text: 'cat ears', source: 'english', target: 'base', category: null } });
    const ids = async (extra: Record<string, unknown>) => { const page = await h.window({ action: 'ui-list', kinds: ['history'], sortBy: 'createdAt', sortDirection: 'desc', limit: 50, ...extra }); return [page.total, page.items.map((item: any) => item.id)]; };
    expect(await ids({ historyTags: ['cat ears'] })).toEqual([2, ['p1', 'p2']]);
    expect(await ids({ historyTags: ['cat ears', 'night sky'] })).toEqual([1, ['p1']]);
    expect(await ids({ historyTags: ['cat ears', 'night sky'], historyTagMatch: 'any' })).toEqual([3, ['p1', 'p2', 'p3']]);
    expect(await ids({ historyTags: ['cat ears'], query: 'beach' })).toEqual([1, ['p2']]);
    // Without kinds (a collection view) the tag filter keeps history images only.
    expect((await h.window({ action: 'ui-list', historyTags: ['cat ears'], limit: 50 })).items.every((item: any) => item.kind === 'history')).toBe(true);
    // The suggestions the search box offers come from the same index.
    const suggestions = await h.window({ action: 'tag-suggestions', query: 'cat', limit: 8 });
    expect(suggestions.tags[0]).toMatchObject({ tag: 'cat ears', count: 2 });
    await expect(h.window({ action: 'ui-list', historyTags: [] })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(h.window({ action: 'ui-list', historyTags: ['x'], historyTagMatch: 'some' })).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});

describe('the queue page’s thumbnails (step 4c1)', () => {
  it('the read a queue tile sends by history id carries the preview its Thumb needs, and the thumbnail is ready', async () => {
    const h = await harness();
    const saved = h.image('q1');
    // A real PNG in place of the placeholder bytes, so the host's thumbnail decodes it.
    const { default: sharp } = await import('sharp');
    await sharp({ create: { width: 16, height: 24, channels: 3, background: '#8b5cf6' } }).png().toFile(saved.payload.filePath + '.tmp.png');
    fs.renameSync(saved.payload.filePath + '.tmp.png', saved.payload.filePath);
    const { readHistoryThumb } = await import('../src/queue/HistoryThumb');
    const calls: Array<Record<string, unknown>> = [];
    const api = { assetLibrary: (args: Record<string, unknown>) => { calls.push(args); return h.window(args); } };
    const { item } = await readHistoryThumb(api as never, 'q1');
    expect(calls).toEqual([{ action: 'ui-read', kind: 'history', id: 'q1' }]);
    expect(item?.preview).toMatchObject({ assetId: expect.any(String), cacheKey: expect.stringMatching(/^[0-9a-f]{64}$/), role: 'original' });
    // What Thumb then asks for with it: a ready thumbnail of that image.
    const thumbnail = await h.window({ action: 'thumbnail', kind: 'history', id: 'q1', revision: item!.revision, assetId: item!.preview!.assetId });
    expect(thumbnail).toMatchObject({ status: 'ready', cacheKey: item!.preview!.cacheKey, dataUrl: expect.stringMatching(/^data:image\/webp;base64,/) });
  });
});

describe('version history from the window (step 4c1: the requests VersionHistory sends)', () => {
  it('lists versions newest first, reads an old one, restores it as a new version and refuses a stale restore', async () => {
    const h = await harness();
    const now = () => new Date().toISOString();
    const first = h.repo.put('style_preset', 'p1', { id: 'p1', name: 'Ink', prompt: 'ink wash', group: '', createdAt: now() });
    const second = h.repo.put('style_preset', 'p1', { id: 'p1', name: 'Ink v2', prompt: 'ink wash, gold leaf', group: 'g', createdAt: first.payload.createdAt }, { expectedRevision: first.revision });
    const versions = await h.window({ action: 'versions', kind: 'style_preset', id: 'p1' });
    expect(versions.versions.map((value: any) => value.revision)).toEqual([second.revision, first.revision]);
    expect(versions).toMatchObject({ currentRevision: second.revision, canRestore: true });
    const old = await h.window({ action: 'read', kind: 'style_preset', id: 'p1', revision: first.revision });
    expect(old.item).toMatchObject({ revision: first.revision, name: 'Ink', payload: { prompt: 'ink wash' } });
    // A restore sent against an older current revision is refused; nothing changes.
    await expect(h.window({ action: 'restore-content', kind: 'style_preset', id: 'p1', revision: first.revision, expectedRevision: first.revision })).rejects.toMatchObject({ code: 'library_conflict', reason: 'library.item_changed' });
    expect(h.repo.get('style_preset', 'p1')!.revision).toBe(second.revision);
    const receipt = await h.window({ action: 'restore-content', kind: 'style_preset', id: 'p1', revision: first.revision, expectedRevision: second.revision });
    expect(receipt.item).toMatchObject({ revision: second.revision + 1, name: 'Ink', payload: { prompt: 'ink wash' } });
    expect((await h.window({ action: 'versions', kind: 'style_preset', id: 'p1' })).versions).toHaveLength(3);
    // History images keep their versions to look at; their content is not restored.
    const image = h.image('v1');
    const moved = h.repo.put('history', 'v1', { ...image.payload, groupId: 'g2' }, { expectedRevision: image.revision });
    expect(await h.window({ action: 'versions', kind: 'history', id: 'v1' })).toMatchObject({ canRestore: false, currentRevision: moved.revision });
    await expect(h.window({ action: 'restore-content', kind: 'history', id: 'v1', revision: image.revision, expectedRevision: moved.revision })).rejects.toMatchObject({ reason: 'library.restore_unsupported' });
  });
});

describe('the window’s other reads', () => {
  it('ui-read adds the file size of an image whose record has none, read from disk; nothing is written', async () => {
    const h = await harness();
    const saved = h.image('h1', {}, new Date(), 4321);
    const revision = h.repo.getRevision();
    const plain = await h.window({ action: 'read', kind: 'history', id: 'h1' });
    expect(plain.assets.find((asset: any) => asset.role === 'original').byteLength).toBeUndefined();
    const detail = await h.window({ action: 'ui-read', kind: 'history', id: 'h1' });
    expect(detail.assets.find((asset: any) => asset.role === 'original')).toMatchObject({ byteLength: 4321, byteLengthFrom: 'file' });
    expect(h.repo.getRevision()).toBe(revision);
    expect(h.repo.get('history', 'h1')).toEqual(saved);
    expect(h.repo.itemAssets('history', 'h1').every(asset => asset.payload.byteLength === undefined)).toBe(true);
    // A missing file has no size (and nothing fails).
    fs.rmSync(saved.payload.filePath);
    expect((await h.window({ action: 'ui-read', kind: 'history', id: 'h1' })).assets.find((asset: any) => asset.role === 'original').byteLength).toBeUndefined();
  });

  it('ui-archived lists every archived item (more than 500), with names; ui-trash-totals sizes all of Recently deleted', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    for (let index = 0; index < 620; index++) {
      const id = `t${String(index).padStart(3, '0')}`, now = new Date().toISOString();
      h.repo.put('tag', id, { schemaVersion: 1, id, revision: 1, kind: 'tag', name: `tag ${index}`, group: '', notes: '', archived: index < 610, createdAt: now, updatedAt: now, tag: { text: `tag ${index}`, source: 'english', target: 'base', category: null } });
    }
    const archived = await h.window({ action: 'ui-archived' });
    expect(archived.total).toBe(610);
    expect(archived.items).toHaveLength(610);
    expect(archived.items[0]).toEqual({ kind: 'tag', id: expect.any(String), revision: 1, name: expect.stringMatching(/^tag /) });
    // Recently deleted: two images (their file sizes), one more of unknown size after the fact.
    const a = h.image('a', {}, new Date(), 1000), b = h.image('b', {}, new Date(), 2500);
    await h.window({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'a', expectedRevision: a.revision }, { kind: 'history', id: 'b', expectedRevision: b.revision }] });
    const totals = await h.window({ action: 'ui-trash-totals' });
    expect(totals).toMatchObject({ entries: 2, collections: 0, files: { moved: 2 }, bytes: { moved: 3500, unknownSize: 0 } });
  });

  it('a bridge call (MCP) never reaches the window actions; the window’s list contract is checked', async () => {
    const h = await harness();
    h.image('h1');
    for (const action of ['ui-list', 'ui-read', 'ui-archived', 'ui-trash-totals']) await expect(h.bridge({ action, kind: 'history', id: 'h1' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(h.window({ action: 'ui-list', limit: 501 })).rejects.toMatchObject({ code: 'invalid_argument', reason: 'library.invalid_request' });
    await expect(h.window({ action: 'ui-list', source: 'robots' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(h.window({ action: 'ui-list', archived: 'maybe' })).rejects.toMatchObject({ code: 'invalid_argument' });
    // The ordinary actions answer the window exactly as before.
    expect((await h.window({ action: 'list', kinds: ['history'] })).items[0].payload.params.positivePrompt).toBe('teacup h1');
  });
});
