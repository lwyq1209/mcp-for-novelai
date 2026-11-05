/**
 * Step 4b1: the new library page's reads and actions (src/library/api.ts, data model, receipts) against the real host
 * services — the asset library service, Recently Deleted, the image study service, the history-group store functions
 * and the SQLite library — with real files in a throwaway data root. The window calls these through the same IPC
 * (main.ts novelai:assets passes deletedBy: user); here the IPC hop is the only thing left out.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { DEFAULT_PARAMS } from '../src/types';

const fixture = vi.hoisted(() => ({ root: '', savePath: '' }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'userData' ? path.join(fixture.root, 'user-data') : key === 'pictures' ? path.join(fixture.root, 'pictures') : fixture.root, getVersion: () => '0.1.0', isPackaged: false },
  dialog: { showSaveDialog: async () => ({ canceled: false, filePath: fixture.savePath }) },
  shell: { openPath: async () => '', showItemInFolder: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }) },
}));

const closers: Array<() => unknown> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-library-ui-')); fixture.savePath = path.join(fixture.root, 'exports', 'project.zip'); vi.resetModules(); });
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
  return { repo, service, trash, studies, storage, api, actions, image, tag, output };
}

describe('the library page against the real host services', () => {
  it('lists each section, searches, filters by source, reads a detail with its collections', async () => {
    const h = await harness();
    const model = await import('../src/library/model');
    h.image('h1'); h.image('h2', { generationOrigin: { jobId: 'j', mode: 'i2i', originWorkspaceId: 'w', submittedRevision: 1, actualSeed: 7 }, queueOrigin: { batchId: 'b1', requestKey: 'claude-x', itemIndex: 0 } });
    h.tag('smile'); h.tag('rain');
    const list = async (view: Parameters<typeof model.listRequest>[0], query = '', filters: Record<string, unknown> = {}) => (await h.api.assetLibrary({ ...model.listRequest(view, { query, archived: 'exclude', presetFilter: 'all', filters }), offset: 0, limit: model.UI_LIST_PAGE }));
    const history = await list({ type: 'category', category: 'history' });
    expect(history.items.map((item: any) => item.id).sort()).toEqual(['h1', 'h2']);
    expect((await list({ type: 'category', category: 'tags' })).total).toBe(2);
    expect((await list({ type: 'category', category: 'tags' }, 'smi')).items.map((item: any) => item.name)).toEqual(['smile']);
    expect((await list({ type: 'category', category: 'history' }, 'h2')).items.map((item: any) => item.id)).toEqual(['h2']);
    // The host filters (oss/lib-1103); without the queue listing b1 an agent image is "Agent".
    expect((await list({ type: 'category', category: 'history' }, '', { source: 'agent' })).items.map((item: any) => item.id)).toEqual(['h2']);
    expect((await list({ type: 'category', category: 'history' }, '', { source: 'manual' })).items.map((item: any) => item.id)).toEqual(['h1']);
    expect((await list({ type: 'category', category: 'history' }, '', { source: 'agent', mode: 'i2i' })).items.map((item: any) => item.id)).toEqual(['h2']);
    expect((await list({ type: 'category', category: 'history' }, '', { source: 'agent:Claude Code' })).total).toBe(0);
    const { collection } = await h.actions.createCollection(h.api, 'Picks');
    await h.actions.addToCollection(h.api, history.items.filter((item: any) => item.id === 'h1'), collection.id);
    const detail = await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' });
    expect(detail.memberships).toEqual(expect.arrayContaining([expect.objectContaining({ namespace: 'user', collectionId: collection.id.slice('user:'.length) })]));
    const members = await list({ type: 'collection', id: collection.id });
    expect(members.items.map((item: any) => item.id)).toEqual(['h1']);
    const index = model.membershipIndex([{ collectionId: collection.id, items: members.items }]);
    expect(index.get('history:h1')).toEqual([collection.id]);
    const current = (await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' })).item;
    await h.actions.removeFromCollection(h.api, [current], collection.id);
    expect((await list({ type: 'collection', id: collection.id })).total).toBe(0);
    await h.actions.setCustomTags(h.api, (await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' })).item, ['cafe', 'v2']);
    expect((await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' })).item.payload.annotation.customTags).toEqual(['cafe', 'v2']);
  });

  it('deletes one and several items only after the preview, restores, deletes forever and empties Recently deleted', async () => {
    const h = await harness();
    const { summarizeDeleteReceipt, receiptTrashIds, trashDaysLeft, trashDeletedBy, trashImpacts, purgeSize } = await import('../src/library/impacts');
    const a = h.image('h1', {}, 1200), b = h.image('h2', {}, 3400), c = h.image('h3', {}, 500);
    const { collection } = await h.actions.createCollection(h.api, 'Summer');
    await h.actions.addToCollection(h.api, [a], collection.id);
    const items = [(await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' })).item, b, c];
    const preview = summarizeDeleteReceipt(await h.actions.previewDelete(h.api, items));
    expect(preview).toMatchObject({ count: 3, filesMoved: 3, bytesMoved: 5100, unknownSize: 0, collections: ['Summer'], recipes: 1 });
    // The preview changed nothing.
    expect((await h.api.assetLibrary({ action: 'list', kinds: ['history'] })).total).toBe(3);
    expect(fs.existsSync(a.payload.filePath)).toBe(true);
    const receipt = await h.actions.commitDelete(h.api, items);
    const trashIds = receiptTrashIds(receipt);
    expect(trashIds).toHaveLength(3);
    expect((await h.api.assetLibrary({ action: 'list', kinds: ['history'] })).total).toBe(0);
    expect(fs.existsSync(a.payload.filePath)).toBe(false);
    const page = await h.actions.listTrash(h.api);
    expect(page.total).toBe(3);
    for (const entry of page.entries) { expect(trashDaysLeft(entry)).toBe(30); expect(trashDeletedBy(entry)).toEqual({ kind: 'user' }); }
    const h1 = page.entries.find(entry => entry.id === 'h1')!;
    expect(trashImpacts(h1)).toEqual([{ key: 'colls', n: 1 }]);
    expect(trashImpacts(page.entries.find(entry => entry.id === 'h2')!)).toEqual([{ key: 'recipes', n: 1 }]);
    expect(purgeSize(page.entries)).toMatchObject({ files: 3, bytes: 5100 });
    // Undo (restore) brings the record, the file and the collection back.
    await h.actions.restoreTrash(h.api, [h1.trashId]);
    expect(fs.existsSync(a.payload.filePath)).toBe(true);
    expect((await h.api.assetLibrary({ action: 'list', collectionId: collection.id })).items.map((item: any) => item.id)).toEqual(['h1']);
    // Delete forever removes the entry and its file.
    const h2 = page.entries.find(entry => entry.id === 'h2')!;
    await h.actions.purgeTrash(h.api, [h2.trashId]);
    expect((await h.actions.listTrash(h.api)).entries.map(entry => entry.id)).toEqual(['h3']);
    expect(fs.existsSync(b.payload.filePath)).toBe(false);
    // Empty all: the entries listed when the confirmation opened.
    const listed = await h.actions.listAllTrash(h.api);
    expect(await h.actions.purgeListed(h.api, listed.map(entry => entry.trashId))).toMatchObject({ purged: 1, gone: 0 });
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
  });

  it('empties archived items after its preview, and deletes a collection into Recently deleted', async () => {
    const h = await harness();
    const { summarizeDeleteReceipt } = await import('../src/library/impacts');
    const a = h.image('h1'), b = h.image('h2'), t = h.tag('old');
    await h.actions.setArchived(h.api, [a, t], true);
    expect((await h.api.assetLibrary({ action: 'list', kinds: ['history'] })).total).toBe(1);
    const round = await h.actions.listArchived(h.api);
    expect(round.total).toBe(2);
    const preview = summarizeDeleteReceipt(await h.actions.previewDeleteAll(h.api, round.items));
    expect(preview.count).toBe(2);
    expect(preview.byKind.sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([{ kind: 'history', count: 1 }, { kind: 'tag', count: 1 }]);
    expect(preview.filesMoved).toBe(1);
    expect((await h.actions.listTrash(h.api)).total).toBe(0);
    summarizeDeleteReceipt(await h.actions.commitDeleteAll(h.api, round.items));
    expect((await h.actions.listTrash(h.api)).total).toBe(2);
    expect((await h.api.assetLibrary({ action: 'list', kinds: ['history'], includeArchived: true })).items.map((item: any) => item.id)).toEqual(['h2']);
    const { collection } = await h.actions.createCollection(h.api, 'Old sketches');
    await h.actions.addToCollection(h.api, [b], collection.id);
    expect(await h.actions.previewDeleteCollection(h.api, collection.id)).toMatchObject({ collections: [{ name: 'Old sketches', members: 1 }] });
    await h.actions.commitDeleteCollection(h.api, collection.id);
    const { collections } = await h.api.assetLibrary({ action: 'collections' });
    expect(collections.some((value: any) => value.id === collection.id)).toBe(false);
    expect((await h.actions.listTrash(h.api)).entries.find(entry => entry.kind === 'collection')).toMatchObject({ name: 'Old sketches', members: 1 });
    // The collection's item is kept.
    expect((await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h2' })).item.id).toBe('h2');
  });

  it('renames, exports and deletes a project (history group); images can move into and out of it', async () => {
    const h = await harness();
    const model = await import('../src/library/model');
    const groups = h.storage.createGroup('cafe-scene'), group = groups.find(value => value.name === 'cafe-scene')!;
    const a = h.image('h1', { groupId: group.id }), b = h.image('h2');
    const projects = model.projectCollections((await h.api.assetLibrary({ action: 'collections' })).collections);
    expect(projects.map(value => [value.id, value.name])).toEqual([[`history:${group.id}`, 'cafe-scene']]);
    await h.actions.moveToProject(h.api, [b], projects[0].id);
    const members = await h.api.assetLibrary({ ...model.listRequest({ type: 'project', id: projects[0].id }, { query: '', includeArchived: false, presetFilter: 'all' }), limit: 50 });
    expect(members.items.map((item: any) => item.id).sort()).toEqual(['h1', 'h2']);
    await h.actions.removeFromProjects(h.api, [(await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h2' })).item]);
    expect((await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h2' })).item.payload.groupId).toBeUndefined();
    await h.api.renameHistoryGroup(model.projectGroupId(projects[0].id), 'cafe-final');
    expect(model.projectCollections((await h.api.assetLibrary({ action: 'collections' })).collections)[0].name).toBe('cafe-final');
    const exported = await h.api.exportHistoryGroup(group.id) as { ok: boolean; code?: string; params?: Record<string, unknown> };
    expect(exported).toMatchObject({ ok: true, count: 1 });
    const { hostMessageText } = await import('../src/host-errors/compose');
    expect(hostMessageText(exported, 'en-US')).toMatch(/1/);
    expect(fs.statSync(fixture.savePath).size).toBeGreaterThan(0);
    await h.api.deleteHistoryGroup(group.id);
    expect(model.projectCollections((await h.api.assetLibrary({ action: 'collections' })).collections)).toEqual([]);
    const kept = (await h.api.assetLibrary({ action: 'read', kind: 'history', id: 'h1' })).item;
    expect(kept.payload.groupId).toBeUndefined();
    expect(fs.existsSync(a.payload.filePath)).toBe(true);
  });

  it('imports an image after reading its settings first; the settings can be put on the canvas', async () => {
    const h = await harness();
    const { readReport, reportHasSettings, applyReportToCanvas, fileBase64, checkImportFile } = await import('../src/library/image-meta');
    const bytes = await novelAiPng('1girl, solo, cherry blossoms, smile');
    const file = new File([bytes], 'pixiv_reference_01.png', { type: 'image/png' });
    expect(checkImportFile(file)).toEqual({ ok: true });
    expect(checkImportFile(new File(['x'], 'notes.txt', { type: 'text/plain' }))).toEqual({ ok: false, reason: 'type' });
    const report = readReport(await file.arrayBuffer());
    expect(report.kind).toBe('novelai');
    expect(reportHasSettings(report)).toBe(true);
    expect(report.imported).toMatchObject({ positivePrompt: '1girl, solo, cherry blossoms, smile', steps: 23, seed: 4242 });
    const result = await h.api.materialStudies({ action: 'import', name: file.name, data: await fileBase64(file) }) as { study: { id: string; metadataStatus: string }; duplicate: boolean };
    expect(result.duplicate).toBe(false);
    const model = await import('../src/library/model');
    const imports = await h.api.assetLibrary({ ...model.listRequest({ type: 'category', category: 'imports' }, { query: '', includeArchived: false, presetFilter: 'all' }), limit: 10 });
    expect(imports.items.map((item: any) => [item.id, item.payload.study.metadataStatus])).toEqual([[result.study.id, 'generation']]);
    const again = await h.api.materialStudies({ action: 'import', name: file.name, data: await fileBase64(file) }) as { duplicate: boolean };
    expect(again.duplicate).toBe(true);
    // The canvas store saves the recipe through the window API; record those calls instead.
    const setSetting = vi.fn(async () => undefined);
    vi.stubGlobal('window', { naiDesktop: { setSetting } });
    closers.push(() => vi.unstubAllGlobals());
    const { useAppStore } = await import('../src/store');
    useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language: 'en-US' } as never });
    applyReportToCanvas(report);
    expect(useAppStore.getState().params).toMatchObject({ positivePrompt: '1girl, solo, cherry blossoms, smile', steps: 23, seed: 4242 });
    expect(useAppStore.getState().activeTab).toBe('generate');
    expect(setSetting).toHaveBeenCalled();
  });
});
