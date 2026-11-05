/**
 * Step 4b1 review rework: the library page's bulk delete paths against the real host services (asset library
 * service, Recently Deleted, SQLite library, real files in a throwaway data root), including what an agent does in
 * between through the same service (deletedBy agent). The scenarios of the independent review: 清空最近删除 with an
 * entry deleted after the confirmation opened, 清空已归档 with an item archived or renamed after its preview, more
 * than one round of archived items, Undo after a large delete, stale selections and more than 500 items.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { DEFAULT_PARAMS } from '../src/types';

/**
 * Cases that write hundreds of library entries (more than one 500-item request) run in about 1–3 s alone but can pass
 * 30 s when two full suites share the disk: they get an explicit longer limit; what they check is unchanged.
 */
const HEAVY_IO_TIMEOUT_MS = 120_000;

const fixture = vi.hoisted(() => ({ root: '', savePath: '' }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'userData' ? path.join(fixture.root, 'user-data') : key === 'pictures' ? path.join(fixture.root, 'pictures') : fixture.root, getVersion: () => '0.1.0', isPackaged: false },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: fixture.savePath }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
}));

const closers: Array<() => unknown> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-ui-delete-')); fixture.savePath = path.join(fixture.root, 'exports', 'project.zip'); vi.resetModules(); });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* closed */ } }
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

/** A PNG of NovelAI's kind: a real image with Software and Comment text chunks. */
async function novelAiPng(prompt: string) {
  const png = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#d0a0c0' } }).png().toBuffer();
  const chunk = (key: string, value: string) => {
    const data = Buffer.concat([Buffer.from(`${key}\0`, 'latin1'), Buffer.from(value, 'latin1')]);
    const type = Buffer.from('tEXt', 'latin1'), length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    let crc = -1; for (const byte of Buffer.concat([type, data])) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([length, type, data, sum]);
  };
  const comment = JSON.stringify({ prompt, uc: 'lowres, bad hands', steps: 23, scale: 5.5, seed: 4242, sampler: 'k_euler_ancestral', width: 832, height: 1216, noise_schedule: 'karras', cfg_rescale: 0 });
  return Buffer.concat([png.subarray(0, 33), chunk('Software', 'NovelAI'), chunk('Source', 'NovelAI Diffusion V4.5 4BDE2A90'), chunk('Comment', comment), png.subarray(33)]);
}

async function harness() {
  const root = fixture.root, userData = path.join(root, 'user-data'), library = path.join(userData, 'library'), output = path.join(root, 'output');
  fs.mkdirSync(library, { recursive: true }); fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.dirname(fixture.savePath), { recursive: true });
  const { openLibraryRepository } = await import('./library/repository');
  const repo = openLibraryRepository({ filePath: path.join(userData, 'library.sqlite'), libraryDirectory: library, userDataRoot: userData });
  closers.push(() => repo.close());
  const { activateLibrary, activateLibraryTrash, deactivateLibrary } = await import('./library-runtime');
  activateLibrary(repo, { userDataRoot: userData, libraryDirectory: library });
  closers.push(() => deactivateLibrary());
  const { createLibraryTrash } = await import('./library-trash');
  const trash = createLibraryTrash({ repository: repo, userDataRoot: userData, libraryDirectory: library, managedRoots: () => [output], toFileUrl: file => `fixture:${file}`, log: () => undefined,
    recipeReferences: async targets => new Map(targets.filter(target => target.id === 'h2').map(target => [`${target.kind}:${target.id}`, [{ recipeId: randomUUID(), recipeRevision: 1, sourceRevision: 1 }]])) });
  activateLibraryTrash(trash);
  const { createAssetLibraryService } = await import('./asset-library-service');
  const service = createAssetLibraryService({ repository: repo, trash, toFileUrl: file => `fixture:${file}` });
  const { createImageStudyService } = await import('./image-studies');
  const { parseImageStudy } = await import('./image-study-parser');
  const studies = createImageStudyService({ directory: path.join(library, 'studies'), repository: repo, parse: parseImageStudy });
  closers.push(() => studies.dispose());
  const storage = await import('./ipc/storage');
  const { selectionOf: _selection, ...actions } = await import('../src/library/api');
  const api = {
    // The window's IPC (main.ts novelai:assets): deletedBy user, and the window's own actions (oss/lib-1103).
    assetLibrary: (args: Record<string, unknown>) => service.asset_library(args, { deletedBy: { kind: 'user' }, window: true }),
    materialStudies: (args: Record<string, unknown>) => studies.material_studies(args as never),
    renameHistoryGroup: async (id: string, name: string) => storage.renameGroup(id, name),
    deleteHistoryGroup: async (id: string) => storage.removeGroup(id),
    exportHistoryGroup: (id: string) => storage.exportGroup(id),
  };
  const image = (id: string, extra: Record<string, unknown> = {}, bytes = 1500) => {
    const file = path.join(output, '2026-11-03', `${id}.png`);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(bytes, 3));
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-03', createdAt: new Date().toISOString(), params: { ...DEFAULT_PARAMS, positivePrompt: `teacup ${id}` }, actualSeed: 7, model: DEFAULT_PARAMS.model, width: 832, height: 1216, ...extra });
  };
  const tag = (name: string) => { const id = randomUUID(), now = new Date().toISOString(); return repo.put('tag', id, { schemaVersion: 1, id, revision: 1, kind: 'tag', name, group: '', notes: '', archived: false, createdAt: now, updatedAt: now, tag: { text: name, source: 'english', target: 'base', category: null } }); };
  /** The same service as an agent bridge call (deletedBy agent). */
  const agent = (args: Record<string, unknown>) => service.asset_library(args, { deletedBy: { kind: 'agent', client: { name: 'claude-code', version: '1' } } as never });
  const read = async (kind: string, id: string) => (await api.assetLibrary({ action: 'read', kind, id })).item;
  return { repo, service, trash, studies, storage, api, agent, read, actions, image, tag, output };
}


const zh = async () => {
  const { uiText } = await import('../src/ui/i18n');
  return ((key: string, params?: Record<string, unknown>) => uiText('zh', key as never, params as never)) as never;
};

describe('review rework: bulk deletes delete exactly what the confirmation showed', () => {
  it('清空最近删除 purges the entries listed when it opened; one an agent deletes afterwards stays in Recently deleted', async () => {
    const h = await harness();
    const a = h.image('h1'), b = h.image('h2');
    await h.actions.commitDelete(h.api, [a]);
    // The confirmation opens: every entry listed now.
    const listed = await h.actions.listAllTrash(h.api);
    expect(listed.map(entry => entry.id)).toEqual(['h1']);
    // Meanwhile an agent deletes another image.
    await h.agent({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h2', expectedRevision: b.revision }] });
    const result = await h.actions.purgeListed(h.api, listed.map(entry => entry.trashId));
    expect(result).toEqual({ purged: 1, gone: 0, retryLater: 0 });
    const left = await h.actions.listAllTrash(h.api);
    expect(left.map(entry => [entry.id, entry.deletedBy?.kind])).toEqual([['h2', 'agent']]);
    // The agent's deletion is still restorable, file and all.
    await h.actions.restoreListed(h.api, left.map(entry => entry.trashId));
    expect(fs.existsSync(b.payload.filePath)).toBe(true);
    expect((await h.read('history', 'h2')).id).toBe('h2');
    expect(fs.existsSync(a.payload.filePath)).toBe(false);
  });

  it('清空最近删除: an entry restored after it opened is skipped (and counted), the rest are purged; more than 500 go in several requests', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const tags = Array.from({ length: 503 }, (_, index) => h.tag(`t${index}`));
    await h.actions.commitDelete(h.api, tags.slice(0, 500));
    await h.actions.commitDelete(h.api, tags.slice(500));
    const listed = await h.actions.listAllTrash(h.api);
    expect(listed).toHaveLength(503);
    const restored = listed[0];
    await h.actions.restoreListed(h.api, [restored.trashId]);
    const calls: unknown[] = [];
    const counting = { ...h.api, assetLibrary: (args: Record<string, unknown>) => { if (args.action === 'purge') calls.push((args.trashIds as unknown[]).length); return h.api.assetLibrary(args); } };
    const result = await h.actions.purgeListed(counting as never, listed.map(entry => entry.trashId));
    expect(result).toMatchObject({ purged: 502, gone: 1 });
    expect(calls.every(n => Number(n) <= 500)).toBe(true);
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
    expect((await h.read('tag', restored.id!)).id).toBe(restored.id);
  });

  it('清空已归档: the preview showed 2; an item an agent archives afterwards is not deleted', async () => {
    const h = await harness();
    const { summarizeDeleteReceipt } = await import('../src/library/impacts');
    const a = h.image('h1'), t = h.tag('old'), c = h.image('h3');
    await h.actions.setArchived(h.api, [a, t], true);
    const round = await h.actions.listArchived(h.api);
    expect(round.total).toBe(2);
    const shown = summarizeDeleteReceipt(await h.actions.previewDeleteAll(h.api, round.items));
    expect(shown.count).toBe(2);
    await h.agent({ action: 'mutate', command: 'archive', items: [{ kind: 'history', id: 'h3', expectedRevision: c.revision }], patch: { archived: true } });
    const committed = summarizeDeleteReceipt(await h.actions.commitDeleteAll(h.api, round.items));
    expect(committed.count).toBe(2);
    expect((await h.actions.listAllTrash(h.api)).map(entry => `${entry.kind}:${entry.id}`).sort()).toEqual([`history:h1`, `tag:${t.id}`].sort());
    const h3 = await h.read('history', 'h3');
    expect(h3.archived).toBe(true);
    expect(fs.existsSync(c.payload.filePath)).toBe(true);
    // The next time it is listed.
    expect(await h.actions.listArchived(h.api)).toMatchObject({ total: 1, items: [expect.objectContaining({ id: 'h3' })] });
  });

  it('清空已归档: an archived item renamed after the preview makes the host refuse the commit; nothing is deleted; checking again deletes the renamed one', async () => {
    const h = await harness();
    const { libraryErrorText, isStale } = await import('../src/library/errors');
    const t = h.tag('old'), a = h.image('h1');
    await h.actions.setArchived(h.api, [t, a], true);
    const round = await h.actions.listArchived(h.api);
    await h.actions.previewDeleteAll(h.api, round.items);
    const current = await h.read('tag', t.id);
    await h.agent({ action: 'mutate', command: 'update', items: [{ kind: 'tag', id: t.id, expectedRevision: current.revision }], patch: { name: 'renamed after preview' } });
    let failure: unknown = null;
    try { await h.actions.commitDeleteAll(h.api, round.items); } catch (error) { failure = error; }
    expect(isStale(failure)).toBe(true);
    const names = new Map(round.items.map(item => [`${item.kind}:${item.id}`, item.name]));
    const text = libraryErrorText(failure, await zh(), 'zh', names);
    expect(text).toBe('「old」刚被改动过（例如被 Agent 改名或移动）。');
    expect(text).not.toMatch(/tag:|history:|revision|版本/);
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
    expect(fs.existsSync(a.payload.filePath)).toBe(true);
    // 重新检查: a new round with the current revisions.
    const again = await h.actions.listArchived(h.api);
    expect(again.items.find(item => item.id === t.id)?.name).toBe('renamed after preview');
    await h.actions.previewDeleteAll(h.api, again.items);
    await h.actions.commitDeleteAll(h.api, again.items);
    expect((await h.actions.listTrash(h.api)).total).toBe(2);
  });

  it('清空已归档 of more than 500 items in one confirmation (oss/lib-1103): the complete list, previewed and deleted 500 at a time, nothing else', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const { summarizeDeleteReceipt, receiptTrashIds } = await import('../src/library/impacts');
    const images = Array.from({ length: 12 }, (_, index) => h.image(`a${index}`, {}, 100 + index));
    const tags = Array.from({ length: 508 }, (_, index) => h.tag(`old ${index}`));
    const keep = h.image('keep');
    await h.actions.setArchived(h.api, [...images, ...tags], true);
    const calls: Array<{ preview: boolean; n: number }> = [];
    const counting = { ...h.api, assetLibrary: (args: Record<string, unknown>) => { if (args.command === 'delete') calls.push({ preview: args.preview === true, n: (args.items as unknown[]).length }); return h.api.assetLibrary(args); } };
    const list = await h.actions.listArchived(counting as never);
    expect(list.total).toBe(520);
    expect(list.items).toHaveLength(520);
    const preview = summarizeDeleteReceipt(await h.actions.previewDeleteAll(counting as never, list.items));
    expect(preview.count).toBe(520);
    expect(preview.filesMoved).toBe(12);
    // An agent archives one more after the preview: it is not taken.
    await h.agent({ action: 'mutate', command: 'archive', items: [{ kind: 'history', id: 'keep', expectedRevision: keep.revision }], patch: { archived: true } });
    const receipt = await h.actions.commitDeleteAll(counting as never, list.items);
    expect(calls).toEqual([{ preview: true, n: 500 }, { preview: true, n: 20 }, { preview: false, n: 500 }, { preview: false, n: 20 }]);
    expect(summarizeDeleteReceipt(receipt).count).toBe(520);
    expect(receiptTrashIds(receipt)).toHaveLength(520);
    expect((await h.actions.listTrash(h.api)).total).toBe(520);
    expect((await h.read('history', 'keep')).archived).toBe(true);
    expect(fs.existsSync(keep.payload.filePath)).toBe(true);
  });

  it('清空已归档 refused part way: the requests before the refusal stay deleted (Undo names them all); the refused one and the rest are untouched', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const { PartialDeleteError } = await import('../src/library/api');
    const { receiptTrashIds, summarizeDeleteReceipt } = await import('../src/library/impacts');
    const tags = Array.from({ length: 520 }, (_, index) => h.tag(`old ${String(index).padStart(3, '0')}`));
    await h.actions.setArchived(h.api, tags, true);
    const list = await h.actions.listArchived(h.api);
    await h.actions.previewDeleteAll(h.api, list.items);
    // After the preview an agent renames an item of the second request.
    const changed = list.items[510], current = await h.read('tag', changed.id);
    await h.agent({ action: 'mutate', command: 'update', items: [{ kind: 'tag', id: changed.id, expectedRevision: current.revision }], patch: { name: 'renamed' } });
    let failure: unknown = null;
    try { await h.actions.commitDeleteAll(h.api, list.items); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PartialDeleteError);
    const partial = failure as InstanceType<typeof PartialDeleteError>;
    expect(summarizeDeleteReceipt(partial.receipt).count).toBe(500);
    expect(partial.left.map(item => item.id)).toEqual(list.items.slice(500).map(item => item.id));
    expect((await h.actions.listTrash(h.api)).total).toBe(500);
    expect((await h.actions.listArchived(h.api)).total).toBe(20);
    // Undo restores every one of the 500.
    const ids = receiptTrashIds(partial.receipt);
    expect(ids).toHaveLength(500);
    expect(await h.actions.restoreListed(h.api, ids)).toEqual({ restored: 500, gone: 0 });
    expect((await h.actions.listArchived(h.api)).total).toBe(520);
  });

  it('Undo after a 300-item delete restores all 300 (the listed rows and omitted.trashIds)', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const { receiptTrashIds, receiptUnnamed, summarizeDeleteReceipt } = await import('../src/library/impacts');
    const items = Array.from({ length: 300 }, (_, index) => h.image(`m${index}`, {}, 100));
    const receipt = await h.actions.commitDelete(h.api, items);
    expect(summarizeDeleteReceipt(receipt).omitted).toBeGreaterThan(0);
    const ids = receiptTrashIds(receipt);
    expect(ids).toHaveLength(300);
    expect(receiptUnnamed(receipt)).toBe(0);
    expect(await h.actions.restoreListed(h.api, ids)).toEqual({ restored: 300, gone: 0 });
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
    expect((await h.api.assetLibrary({ action: 'list', kinds: ['history'], limit: 1 })).total).toBe(300);
  });

  it('a selection keeps current revisions: after 移到项目 the refreshed selection previews; a stale one is refused in plain words and 重新检查 reads the current state', async () => {
    const h = await harness();
    const model = await import('../src/library/model');
    const { libraryErrorText, isStale } = await import('../src/library/errors');
    const groups = h.storage.createGroup('cafe'), group = groups.find(value => value.name === 'cafe')!;
    const a = h.image('h1'), b = h.image('h2');
    const selected = new Map([a, b].map(item => [model.itemKey(item), item]));
    await h.actions.moveToProject(h.api, [a, b], `history:${group.id}`);
    // The page's list re-reads; the selection follows it.
    const listed = (await h.api.assetLibrary({ action: 'list', kinds: ['history'], limit: 10 })).items;
    const synced = model.refreshSelection(selected, listed);
    expect([...synced.values()].map(item => item.revision)).toEqual([2, 2]);
    expect((await h.actions.previewDelete(h.api, [...synced.values()])).preview).toBe(true);
    // An old snapshot (a dialog opened before the move): refused, no internal id in the text.
    let failure: unknown = null;
    try { await h.actions.previewDelete(h.api, [a, b]); } catch (error) { failure = error; }
    expect(isStale(failure)).toBe(true);
    const text = libraryErrorText(failure, await zh(), 'zh', new Map([['history:h1', 'h1.png'], ['history:h2', 'h2.png']]));
    expect(text).toMatch(/^「h[12]\.png」刚被改动过/);
    expect(text).not.toMatch(/history:|版本/);
    const fresh = await h.actions.refreshItems(h.api, [a, b]);
    expect(fresh.items.map(item => item.revision)).toEqual([2, 2]);
    expect(fresh.gone).toEqual([]);
    expect((await h.actions.previewDelete(h.api, fresh.items)).preview).toBe(true);
    // An item deleted elsewhere since is left out by 重新检查.
    await h.agent({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'h2', expectedRevision: 2 }] });
    const after = await h.actions.refreshItems(h.api, fresh.items);
    expect(after.items.map(item => item.id)).toEqual(['h1']);
    expect(after.gone.map(item => item.id)).toEqual(['h2']);
  });

  it('more than 500 items: selection actions go 500 per request; a 501-item delete request is refused without the raw validation text', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const { libraryErrorText } = await import('../src/library/errors');
    const items = Array.from({ length: 501 }, (_, index) => h.tag(`t${index}`));
    expect(await h.actions.setArchived(h.api, items, true)).toBe(501);
    expect((await h.actions.listArchived(h.api)).total).toBe(501);
    let failure: unknown = null;
    try { await h.actions.previewDelete(h.api, items); } catch (error) { failure = error; }
    expect(failure).toBeTruthy();
    const text = libraryErrorText(failure, await zh(), 'zh');
    expect(text).toBe('素材库没法处理这次请求（一次最多 500 项）。');
    expect(text).not.toMatch(/data must|additional properties/);
  });

  it('deleting a project: the dialog counts the images from the host; they stay, and the project does not go to Recently deleted', async () => {
    const h = await harness();
    const groups = h.storage.createGroup('cafe'), group = groups.find(value => value.name === 'cafe')!;
    h.image('h1', { groupId: group.id }); h.image('h2', { groupId: group.id }); h.image('h3');
    const counted = await h.api.assetLibrary({ action: 'list', collectionId: `history:${group.id}`, kinds: ['history'], includeArchived: true, limit: 1 });
    expect(counted.total).toBe(2);
    await h.api.deleteHistoryGroup(group.id);
    expect((await h.read('history', 'h1')).payload.groupId).toBeUndefined();
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
  });
});

/**
 * The window gets host errors through IPC (main.ts novelai:assets: hostErrorFields) and the preload (an Error with
 * code/reason/params, wrapped by bridgeSafeApi), then contextBridge, which keeps an Error's message only. The same
 * flows with errors shaped exactly so (review rework, round 2).
 */
async function bridged(h: Awaited<ReturnType<typeof harness>>) {
  const { hostErrorFields } = await import('./host-error');
  const { bridgeSafeApi } = await import('../src/host-errors/bridge');
  const exposed = bridgeSafeApi({
    assetLibrary: async (args: Record<string, unknown>) => {
      let response: { ok: boolean; result?: unknown; error?: ReturnType<typeof hostErrorFields> };
      try { response = { ok: true, result: await h.service.asset_library(args, { deletedBy: { kind: 'user' }, window: true }) }; }
      catch (error) { response = { ok: false, error: hostErrorFields(error, 'library_failed', 'The library operation did not complete.') }; }
      const copy = JSON.parse(JSON.stringify(response));
      if (!copy.ok) throw Object.assign(new Error(copy.error.message), { code: copy.error.code, ...(copy.error.reason ? { reason: copy.error.reason } : {}), ...(copy.error.params ? { params: copy.error.params } : {}) });
      return copy.result;
    },
  });
  // contextBridge: an Error arrives as a new Error with the same message and nothing else.
  return { assetLibrary: (args: Record<string, unknown>) => exposed.assetLibrary(args).catch((error: unknown) => { throw error instanceof Error ? new Error(error.message) : error; }) };
}

describe('review rework 2: the same flows with host errors as the window receives them (message only)', () => {
  it('清空最近删除: an entry restored by an agent after the dialog listed it is skipped and counted; the rest are purged', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const h = await harness();
    const api = await bridged(h);
    const tags = Array.from({ length: 1100 }, (_, index) => h.tag(`t${index}`));
    for (const part of h.actions.chunks(tags)) await h.actions.commitDelete(api as never, part);
    const listed = await h.actions.listAllTrash(api as never);
    expect(listed).toHaveLength(1100);
    await h.agent({ action: 'restore', trashIds: [listed[700].trashId] });
    const result = await h.actions.purgeListed(api as never, listed.map(entry => entry.trashId));
    expect(result).toEqual({ purged: 1099, gone: 1, retryLater: 0 });
    expect((await h.actions.listTrash(api as never, 0, 1)).total).toBe(0);
    expect((await h.read('tag', listed[700].id!)).id).toBe(listed[700].id);
  });

  it('重新检查: an item deleted since is left out (not an endless read failure); a conflict reads in Chinese without ids', async () => {
    const h = await harness();
    const api = await bridged(h);
    const { libraryErrorText, isStale } = await import('../src/library/errors');
    const { uiText } = await import('../src/ui/i18n');
    const zhText = ((key: string, params?: Record<string, unknown>) => uiText('zh', key as never, params as never)) as never;
    const keep = h.tag('keep'), gone = h.tag('gone'), renamed = h.tag('renamed');
    const items = [keep, gone, renamed];
    await h.actions.previewDelete(api as never, items);
    await h.agent({ action: 'mutate', command: 'delete', items: [{ kind: 'tag', id: gone.id, expectedRevision: 1 }] });
    await h.agent({ action: 'mutate', command: 'update', items: [{ kind: 'tag', id: renamed.id, expectedRevision: 1 }], patch: { name: 'renamed by agent' } });
    let failure: unknown = null;
    try { await h.actions.commitDelete(api as never, items); } catch (error) { failure = error; }
    expect(Object.keys(failure as object)).toEqual([]);
    expect(isStale(failure)).toBe(true);
    const names = new Map(items.map(item => [`${item.kind}:${item.id}`, item.name]));
    const text = libraryErrorText(failure, zhText, 'zh', names);
    expect(text).toMatch(/^「(gone|renamed)」(已经在「最近删除」里了|刚被改动过)/);
    expect(text).not.toMatch(/tag:|[0-9a-f]{8}-|revision|版本|Recently Deleted/);
    const fresh = await h.actions.refreshItems(api as never, items);
    expect(fresh.items.map(item => item.name).sort()).toEqual(['keep', 'renamed by agent']);
    expect(fresh.gone.map(item => item.id)).toEqual([gone.id]);
    await h.actions.previewDelete(api as never, fresh.items);
    expect((await h.actions.commitDelete(api as never, fresh.items)).totals?.entries ?? 2).toBe(2);
  });

  it('the host catalog reads thrown errors in the window language', async () => {
    const h = await harness();
    const api = await bridged(h);
    const { hostErrorText } = await import('../src/host-errors');
    let failure: unknown = null;
    try { await api.assetLibrary({ action: 'purge', trashIds: ['00000000-0000-4000-8000-000000000000'] }); } catch (error) { failure = error; }
    expect(hostErrorText(failure, 'zh-CN')).toBe('「最近删除」中没有条目 00000000-0000-4000-8000-000000000000。');
    expect(hostErrorText(failure, 'en-US')).toBe('Recently Deleted has no entry 00000000-0000-4000-8000-000000000000.');
  });
});

