import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../../src/test-support/temp-dirs';
import { dialog } from 'electron';
import { openLibraryRepository, type LibraryRepository } from '../library/repository';
import { beginLibraryFileOperation, recoverLibraryFileOperations } from '../library-file-operations';
import { REFERENCE_PRESET_FORMAT, ReferenceImportService } from './reference-preset-import';
import { normalizePreset, exportReferencePresets, prepareReferenceImport, importReferencePresets } from './reference-presets';
import { activateLibrary, deactivateLibrary } from '../library-runtime';
import type { ReferenceImportPreview, ReferenceImportDecision } from '../../src/types';

const roots: string[] = [], repos: LibraryRepository[] = [];
vi.mock('electron', () => ({ app: { getPath: () => 'unused' }, dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() } }));
const stamp = '2026-09-12T00:00:00.000Z';
const sourcePreset = { id: 'package-fern', name: 'Fern watercolor', kind: 'precise', group: 'Package group', createdAt: stamp, infoExtracted: 0.7, strength: 0.8, preciseType: 'style', fidelity: 0.9, informationExtracted: 0.6, width: 8, height: 8, sourceId: 'sfw-fern', sourceNames: { 'en-US': 'Fern', 'zh-CN': '蕨叶' }, sourceGameId: 'botanical', sourceCategory: 'watercolor' };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-reference-import-')); roots.push(root);
  const databasePath = path.join(root, 'library.sqlite'), directory = path.join(root, 'reference-presets');
  const repo = openLibraryRepository({ filePath: databasePath }); repos.push(repo);
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#9bba89' } }).png().toBuffer();
  const service = new ReferenceImportService(repo, directory, normalizePreset);
  const archive = async (rows: Array<Record<string, unknown>>, filename = 'botanical.nairp', format = REFERENCE_PRESET_FORMAT) => {
    const zip = new JSZip();
    rows.forEach((row, index) => { zip.file(`images/${index}.png`, bytes); });
    zip.file('manifest.json', JSON.stringify({ format, version: 1, groups: ['Unused package group'], presets: rows.map((row, index) => ({ asset: `images/${index}.png`, ...row })) }));
    const file = path.join(root, filename); await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' })); return file;
  };
  const local = async (changes: Record<string, unknown> = {}, legacyId?: string) => {
    const id = String(changes.id ?? 'old-random-local-id'), filePath = path.join(root, `${id}.png`);
    await fs.writeFile(filePath, bytes);
    const payload = normalizePreset({ ...sourcePreset, id, group: 'My local folder', ...changes }, filePath)!;
    const item = repo.put('reference_preset', id, payload, { expectedRevision: 0, ...(legacyId ? { source: { namespace: 'reference-archive', legacyId } } : {}) });
    return { item, filePath };
  };
  return { root, databasePath, directory, repo, bytes, service, archive, local };
}
function decision(preview: ReferenceImportPreview, overrides: Record<string, ReferenceImportDecision> = {}) {
  return { importId: preview.importId!, libraryRevision: preview.libraryRevision!, decisions: preview.entries!.map(entry => ({ entryId: entry.entryId, action: overrides[entry.entryId] ?? entry.defaultAction })) };
}
afterEach(() => runCleanups([() => vi.restoreAllMocks(), () => deactivateLibrary(), ...repos.splice(0).map(repo => () => repo.close()), ...roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true }))]));

describe('reference archive preview and confirmed import', () => {
  it('previews real images without writing the database, directories or package groups', async () => {
    const f = await setup(), file = await f.archive([sourcePreset]), before = f.repo.exportSnapshot(), revision = f.repo.getRevision();
    const preview = await f.service.prepare(file);
    expect(preview).toMatchObject({ ok: true, libraryRevision: revision, entries: [{ status: 'new', defaultAction: 'import', name: sourcePreset.name }] });
    expect(preview.entries![0].previewUrl).toMatch(/^data:image\/webp;base64,/);
    expect(f.repo.exportSnapshot()).toEqual(before); expect(f.repo.getRevision()).toBe(revision);
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads only its own package format and refuses any other format name without writing', async () => {
    const f = await setup(), before = f.repo.exportSnapshot(), revision = f.repo.getRevision();
    expect(REFERENCE_PRESET_FORMAT).toBe('mcp-for-novelai-reference-presets');
    expect(await f.service.prepare(await f.archive([sourcePreset]))).toMatchObject({ ok: true, entries: [{ status: 'new', defaultAction: 'import', name: sourcePreset.name }] });
    expect(await f.service.prepare(await f.archive([sourcePreset], 'other.nairp', 'some-other-presets'))).toMatchObject({ ok: false, code: 'reference_import_invalid_package', reason: 'reference_import.format_unsupported', message: expect.stringContaining('format or version is not supported') });
    expect(f.repo.exportSnapshot()).toEqual(before); expect(f.repo.getRevision()).toBe(revision);
    await expect(fs.stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels file selection without writes and retires the old unconfirmed import route', async () => {
    const f = await setup(); activateLibrary(f.repo, { userDataRoot: f.root, libraryDirectory: f.root });
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await prepareReferenceImport(f.root)).toMatchObject({ ok: false, canceled: true });
    expect(await importReferencePresets(f.root)).toMatchObject({ ok: false, code: 'reference_preset_import_preview_required', message: expect.stringContaining('preview') });
    expect(f.repo.getRevision()).toBe(0); expect(f.repo.pendingFileOps()).toEqual([]);
  });

  it('matches legacy randomized imports by full image and semantic content, ignoring IDs, times, paths and grouping', async () => {
    const f = await setup(); await f.local({ createdAt: '2024-01-01T00:00:00.000Z' });
    const file = await f.archive([{ ...sourcePreset, id: 'unrelated-new-archive-id', sourceNames: { 'zh-CN': '蕨叶', 'en-US': 'Fern' } }]);
    const preview = await f.service.prepare(file), revision = f.repo.getRevision();
    expect(preview.entries![0].status).toBe('identical');
    const result = await f.service.commit(decision(preview));
    expect(result).toMatchObject({ ok: true, imported: 0, skipped: 1, failed: 0 });
    expect(f.repo.getRevision()).toBe(revision); expect(f.repo.all('reference_preset')).toHaveLength(1);
    expect(f.repo.all('reference_preset')[0].payload.group).toBe('My local folder');
    expect(f.repo.collections('reference').some(group => group.name === 'Unused package group')).toBe(false);
  });

  it.each(['strength', 'informationExtracted', 'fidelity', 'infoExtracted', 'preciseType', 'sourceCategory', 'width', 'name'] as const)('does not collapse a different %s into a legacy duplicate', async field => {
    const f = await setup(); await f.local();
    const changed = { ...sourcePreset, [field]: field === 'preciseType' ? 'character' : field === 'sourceCategory' ? 'pencil' : field === 'name' ? 'Pencil fern' : field === 'width' ? 16 : 0.2 };
    const preview = await f.service.prepare(await f.archive([changed]));
    expect(preview.entries![0].status).toBe('new');
  });

  it('keeps a conflicting source by default and requires an explicit copy that stays idempotent', async () => {
    const f = await setup(), local = await f.local({}, sourcePreset.id), file = await f.archive([{ ...sourcePreset, strength: 0.2 }]);
    let preview = await f.service.prepare(file);
    expect(preview.entries![0]).toMatchObject({ status: 'conflict', defaultAction: 'skip', localParameters: [{ parameters: { strength: 0.8 } }] });
    expect((await f.service.commit(decision(preview, { '0': 'import' }))).ok).toBe(false);
    expect(await f.service.commit(decision(preview))).toMatchObject({ imported: 0, skipped: 1 });
    preview = await f.service.prepare(file);
    const request = decision(preview, { '0': 'copy' }), [first, repeated] = await Promise.all([f.service.commit(request), f.service.commit(request)]);
    expect(first).toMatchObject({ ok: true, imported: 1, failed: 0 }); expect(repeated).toEqual(first);
    const imported = f.repo.get('reference_preset', first.entries[0].localId!)!;
    expect(imported.id).toMatch(/^[\da-f]{8}-[\da-f-]{27}$/); expect(imported.id).not.toBe(sourcePreset.id);
    expect(imported.source).toEqual({ namespace: 'reference-archive', legacyId: sourcePreset.id });
    expect(imported.payload).toMatchObject({ strength: 0.2, informationExtracted: 0.6, sourceCategory: 'watercolor' });
    expect(f.repo.get('reference_preset', local.item.id)).toEqual(local.item);
    expect((await f.service.prepare(file)).entries![0].status).toBe('identical');
    expect(f.repo.all('reference_preset')).toHaveLength(2);
  });

  it('skips duplicates inside one package and preserves archived identical content without resurrection', async () => {
    const f = await setup(), file = await f.archive([sourcePreset, { ...sourcePreset, id: 'second-random', group: 'Other group' }]);
    const preview = await f.service.prepare(file);
    expect(preview.entries!.map(entry => entry.status)).toEqual(['new', 'identical']);
    expect((await f.service.commit(decision(preview, { '1': 'copy' }))).ok).toBe(false);
    const result = await f.service.commit(decision(preview)); expect(result).toMatchObject({ imported: 1, skipped: 1 });
    const item = f.repo.all('reference_preset')[0]; f.repo.put(item.kind, item.id, item.payload, { expectedRevision: item.revision, archived: true });
    const next = await f.service.prepare(file); expect(next.entries![0]).toMatchObject({ code: 'reference_import_entry', reason: 'reference_import.identical_local_archived', message: expect.stringContaining('archived') });
    expect(await f.service.commit(decision(next))).toMatchObject({ imported: 0, skipped: 2 });
    expect(f.repo.all('reference_preset')[0].archived).toBe(true);
  });

  it.each(['package', 'library', 'local-image'] as const)('requires a fresh preview when the %s changed', async change => {
    const f = await setup(), local = await f.local(), file = await f.archive([{ ...sourcePreset, name: 'New fern' }]);
    const preview = await f.service.prepare(file);
    if (change === 'package') await f.archive([{ ...sourcePreset, name: 'Changed fern' }]);
    else if (change === 'library') f.repo.putCollection({ namespace: 'user', id: 'new-group', name: 'New group', payload: {} });
    else await fs.writeFile(local.filePath, 'changed outside the library');
    const result = await f.service.commit(decision(preview));
    expect(result).toMatchObject({ ok: false, requiresReview: true, imported: 0 });
    expect(f.repo.all('reference_preset')).toHaveLength(1); expect(f.repo.pendingFileOps()).toEqual([]);
  });

  it('reports completed entries on partial failure and retry never duplicates completed copies', async () => {
    const f = await setup(), file = await f.archive([sourcePreset, { ...sourcePreset, id: 'second', name: 'Pencil fern' }, { ...sourcePreset, id: 'third', name: 'Sunlit fern' }]);
    const preview = await f.service.prepare(file), original = fs.open.bind(fs); let calls = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => { if (++calls === 2) throw new Error('Fixture disk full'); return original(...args); });
    const result = await f.service.commit(decision(preview));
    expect(result).toMatchObject({ ok: false, imported: 1, skipped: 0, failed: 2, requiresReview: true });
    expect(result.entries.map(entry => entry.status)).toEqual(['imported', 'failed', 'failed']);
    expect(result).toMatchObject({ code: 'reference_imported', reason: 'reference_import.partial', params: { imported: 1, skipped: 0, failed: 2 }, message: expect.stringContaining('Completed entries are kept') }); expect(f.repo.pendingFileOps()).toEqual([]);
    expect(await f.service.commit(decision(preview))).toEqual(result); expect(calls).toBe(2);
    vi.restoreAllMocks();
    const next = await f.service.prepare(file); expect(next.entries!.map(entry => entry.status)).toEqual(['identical', 'new', 'new']);
    expect(await f.service.commit(decision(next))).toMatchObject({ ok: true, imported: 2, skipped: 1 });
    expect(f.repo.all('reference_preset')).toHaveLength(3);
  });

  it('stops if another writer changes the library during file creation and does not recover an uncommitted decision', async () => {
    const f = await setup(), file = await f.archive([sourcePreset]), preview = await f.service.prepare(file), original = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args), write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => { await write(...writeArgs); f.repo.putCollection({ namespace: 'user', id: 'manual-change', name: 'Manual change', payload: {} }); });
      return handle;
    });
    expect(await f.service.commit(decision(preview))).toMatchObject({ ok: false, imported: 0, failed: 1, requiresReview: true });
    expect(f.repo.all('reference_preset')).toEqual([]); expect(f.repo.pendingFileOps()).toEqual([]);
    expect(await fs.readdir(f.directory)).toEqual([]);
    await recoverLibraryFileOperations(f.repo); expect(f.repo.all('reference_preset')).toEqual([]);
  });

  it.each([false, true])('cleans an owned partial write or retains a failed recovery record if cleanup fails (%s)', async cleanupFails => {
    const f = await setup(), local = await f.local(), before = await fs.readFile(local.filePath);
    const file = await f.archive([{ ...sourcePreset, name: 'New fern' }]), preview = await f.service.prepare(file), open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => { await handle.write(f.bytes.subarray(0, 5)); throw Object.assign(new Error('Fixture disk full after partial write'), { code: 'ENOSPC' }); });
      return handle;
    });
    if (cleanupFails) vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('Fixture cleanup unavailable'));
    expect(await f.service.commit(decision(preview))).toMatchObject({ ok: false, imported: 0, failed: 1 });
    expect(f.repo.all('reference_preset')).toEqual([local.item]);
    expect(await fs.readFile(local.filePath)).toEqual(before);
    expect(await fs.readdir(f.directory)).toHaveLength(cleanupFails ? 1 : 0);
    expect(f.repo.pendingFileOps()).toHaveLength(cleanupFails ? 1 : 0);
    if (cleanupFails) expect(f.repo.pendingFileOps()[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('cleanup') });
    vi.restoreAllMocks();
    await recoverLibraryFileOperations(f.repo);
    expect(f.repo.all('reference_preset')).toEqual([local.item]);
  });

  it.each(['read', 'mark', 'complete'] as const)('still cleans partial files and reports completed items when journal %s fails', async failure => {
    const f = await setup(), file = await f.archive([sourcePreset, { ...sourcePreset, id: 'second', name: 'New fern' }]);
    const preview = await f.service.prepare(file), open = fs.open.bind(fs), put = f.repo.putFileOperation.bind(f.repo), complete = f.repo.completeFileOperation.bind(f.repo), pending = f.repo.pendingFileOps.bind(f.repo);
    let calls = 0, partial = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (++calls === 2) vi.spyOn(handle, 'writeFile').mockImplementation(async () => { partial = true; await handle.write(f.bytes.subarray(0, 5)); throw new Error('Fixture partial write'); });
      return handle;
    });
    vi.spyOn(f.repo, 'pendingFileOps').mockImplementation(() => { if (partial && failure === 'read') throw new Error('Fixture journal unavailable'); return pending(); });
    vi.spyOn(f.repo, 'putFileOperation').mockImplementation(value => { if (partial && failure === 'mark' && value.state === 'failed') throw new Error('Fixture journal full'); return put(value); });
    vi.spyOn(f.repo, 'completeFileOperation').mockImplementation(id => { if (partial && failure === 'complete') throw new Error('Fixture journal full'); return complete(id); });
    expect(await f.service.commit(decision(preview))).toMatchObject({ ok: false, imported: 1, failed: 1, message: expect.stringContaining('not confirmed') });
    expect(f.repo.all('reference_preset')).toHaveLength(1); expect(await fs.readdir(f.directory)).toHaveLength(1);
    vi.restoreAllMocks(); await recoverLibraryFileOperations(f.repo);
    expect(f.repo.all('reference_preset')).toHaveLength(1);
  });

  it('does not remove a pre-existing file when exclusive creation is rejected', async () => {
    const f = await setup(), file = await f.archive([sourcePreset]), preview = await f.service.prepare(file), open = fs.open.bind(fs);
    let existing = '';
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      existing = String(args[0]); await fs.writeFile(existing, 'existing unrelated image');
      return open(...args);
    });
    expect(await f.service.commit(decision(preview))).toMatchObject({ ok: false, imported: 0, failed: 1 });
    expect(await fs.readFile(existing, 'utf8')).toBe('existing unrelated image');
    expect(f.repo.all('reference_preset')).toEqual([]); expect(f.repo.pendingFileOps()).toEqual([]);
  });

  it('shows invalid entries individually and refuses malformed confirmation decisions', async () => {
    const f = await setup(), file = await f.archive([{ ...sourcePreset, asset: '../fern.png' }, { ...sourcePreset, asset: 'images/missing.png' }, { ...sourcePreset, strength: '0.2' }, { ...sourcePreset, fidelity: 4 }]);
    const preview = await f.service.prepare(file); expect(preview.entries!.every(entry => entry.status === 'invalid')).toBe(true);
    const request = decision(preview);
    expect((await f.service.commit({ ...request, decisions: [request.decisions[0], request.decisions[0]] })).ok).toBe(false);
    expect((await f.service.commit({ ...request, surprise: true } as any)).ok).toBe(false);
    expect(await f.service.commit(request)).toMatchObject({ ok: true, imported: 0, skipped: 4 });
    expect(f.repo.all('reference_preset')).toEqual([]);
  });

  it('retains package provenance after a crash between image creation and publication, then deduplicates on reimport', async () => {
    const f = await setup(), id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target = path.join(f.root, `${id}.png`), source = { namespace: 'reference-archive', legacyId: sourcePreset.id };
    const item = normalizePreset({ ...sourcePreset, id }, target)!;
    beginLibraryFileOperation(f.repo, 'create', { kind: 'reference_preset', id, item, source, target, byteLength: f.bytes.length, sha256: sha(f.bytes) });
    await fs.writeFile(target, f.bytes); f.repo.close();
    const restarted = openLibraryRepository({ filePath: f.databasePath }); repos.push(restarted);
    await recoverLibraryFileOperations(restarted);
    expect(restarted.get('reference_preset', id)?.source).toEqual(source);
    const service = new ReferenceImportService(restarted, f.directory, normalizePreset), file = await f.archive([sourcePreset]);
    expect((await service.prepare(file)).entries![0].status).toBe('identical');
    beginLibraryFileOperation(restarted, 'create', { kind: 'reference_preset', id, item, source, target, byteLength: f.bytes.length, sha256: sha(f.bytes) });
    await recoverLibraryFileOperations(restarted); expect(restarted.get('reference_preset', id)?.revision).toBe(1);
  });

  it('exports the original package identity and round-trips without losing precise reference parameters', async () => {
    const f = await setup(), original = await f.archive([sourcePreset]), preview = await f.service.prepare(original);
    const imported = await f.service.commit(decision(preview)); expect(imported.imported).toBe(1);
    activateLibrary(f.repo, { userDataRoot: f.root, libraryDirectory: f.root });
    const exportedPath = path.join(f.root, 'exported.nairp');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: exportedPath });
    expect(await exportReferencePresets({}, f.root)).toMatchObject({ ok: true, count: 1 });
    const zip = await JSZip.loadAsync(await fs.readFile(exportedPath)), manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(manifest.presets[0]).toMatchObject({ ...sourcePreset, createdAt: expect.any(String) });
    expect(manifest.presets[0].id).not.toBe(imported.entries[0].localId);
    expect((await f.service.prepare(exportedPath)).entries![0].status).toBe('identical');
  });
});
