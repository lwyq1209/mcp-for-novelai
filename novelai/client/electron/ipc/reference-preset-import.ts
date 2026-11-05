import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import JSZip from 'jszip';
import sharp from 'sharp';
import type { ReferencePreset, ReferenceImportEntry, ReferenceImportPreview, ReferenceImportCommitRequest, ReferenceImportCommitResult } from '../../src/types';
import type { LibraryRepository } from '../library/repository';
import type { LibrarySource } from '../library/types';
import { validateLibraryPayload, validateLibraryRequest } from '../library/validation';
import { beginLibraryFileOperation } from '../library-file-operations';
import { hostError, type HostErrorParams } from '../host-error';
import { hostDetail, hostMessage, type HostDetail, type HostMessage } from '../host-message';

/**
 * Results the window renders in its language (step 4a): the preview, each entry and the commit carry a code, an
 * English message and, where the code has several cases, a reason with params (electron/host-message.ts).
 */
export type ReferenceImportEntryText = ReferenceImportEntry & Partial<HostDetail>;
export type ReferenceImportPreviewText = Omit<ReferenceImportPreview, 'entries'> & Partial<HostMessage> & { entries?: ReferenceImportEntryText[] };
type CommitEntry = ReferenceImportCommitResult['entries'][number] & Partial<HostDetail>;
export type ReferenceImportCommitResultText = Omit<ReferenceImportCommitResult, 'entries'> & Partial<HostMessage> & { entries: CommitEntry[] };
/** A package this version refuses: code reference_import_invalid_package with the case as its reason. */
const invalidPackage = (reason: string, message: string, params?: HostErrorParams) => hostError('reference_import_invalid_package', message, `reference_import.${reason}`, params);
/** An entry that cannot be imported: code reference_import_entry_invalid with the case as its reason. */
const invalidEntry = (reason: string, message: string, params?: HostErrorParams) => hostError('reference_import_entry_invalid', message, `reference_import.${reason}`, params);
const changed = (reason: string, message: string) => hostError('reference_import_changed', message, `reference_import.${reason}`);
const entryText = (reason: string, message: string, params?: HostErrorParams): HostDetail => hostMessage('reference_import_entry', message, `reference_import.${reason}`, params);

/** Manifest format of a reference preset package (.nairp). */
export const REFERENCE_PRESET_FORMAT = 'mcp-for-novelai-reference-presets';

const MAX_IMAGE = 50 * 1024 * 1024, MAX_ARCHIVE = 128 * 1024 * 1024, MAX_PRESETS = 5000;
const semanticKeys = ['name', 'kind', 'infoExtracted', 'strength', 'preciseType', 'fidelity', 'informationExtracted', 'width', 'height', 'sourceId', 'sourceNames', 'sourceGameNames', 'sourceGameId', 'sourceCategory'] as const;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const errorFields = (error: unknown): HostDetail => hostDetail(error, 'reference_import_failed', 'The import did not complete.');
function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
/** Classification, file locations, timestamps and random local identity never define content. */
export function referenceFingerprint(preset: ReferencePreset, imageSha256: string) {
  return hash(JSON.stringify(stable({ imageSha256, ...Object.fromEntries(semanticKeys.map(key => [key, preset[key]])) })));
}

async function boundedZipBytes(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [], stream = entry.nodeStream('nodebuffer') as Readable;
    stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limit) stream.destroy(invalidEntry('asset_too_large', 'An uncompressed resource exceeds the size limit.')); else chunks.push(chunk); });
    stream.on('error', reject).on('end', () => resolve(Buffer.concat(chunks)));
  });
}
type Normalize = (raw: Record<string, unknown>, filePath: string) => ReferencePreset | null;
interface ArchiveEntry { entryId: string; preset?: ReferencePreset; source?: LibrarySource; bytes?: Buffer; fingerprint?: string; imageSha256?: string; extension?: string; previewUrl?: string; error?: HostDetail; name: string }
interface Archive { sha256: string; entries: ArchiveEntry[] }
interface SnapshotEntry { id: string; name: string; revision: number; source: LibrarySource; fingerprint?: string; archived: boolean; parameters: Record<string, unknown> }
interface Snapshot { revision: number; signature: string; entries: SnapshotEntry[] }
interface Session { path: string; archiveSha256: string; snapshot: Snapshot; preview: ReferenceImportPreviewText; localIds: Map<string, string>; result?: ReferenceImportCommitResultText; running?: Promise<ReferenceImportCommitResultText>; createdAt: number }

export class ReferenceImportService {
  private sessions = new Map<string, Session>();
  constructor(private repo: LibraryRepository, private directory: string, private normalize: Normalize) {}

  private async archive(filePath: string, previews: boolean): Promise<Archive> {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_ARCHIVE) throw invalidPackage('package_size_invalid', 'The preset package is larger than 128 MB or not a file.', { limitMb: 128 });
    const file = await fs.readFile(filePath);
    if (file.length > MAX_ARCHIVE) throw invalidPackage('package_too_large', 'The preset package is larger than 128 MB.', { limitMb: 128 });
    const zip = await JSZip.loadAsync(file), manifestFile = zip.file('manifest.json');
    if (!manifestFile) throw invalidPackage('manifest_missing', 'The preset package is missing manifest.json.');
    const manifest = JSON.parse((await boundedZipBytes(manifestFile, 4 * 1024 * 1024)).toString('utf8'));
    if (manifest?.format !== REFERENCE_PRESET_FORMAT || manifest.version !== 1) throw invalidPackage('format_unsupported', 'The preset package format or version is not supported.');
    if (!Array.isArray(manifest.presets) || manifest.presets.length > MAX_PRESETS) throw invalidPackage('entries_invalid', 'The preset package format or number of entries is invalid.');
    const entries: ArchiveEntry[] = []; let total = 0;
    for (const [index, raw] of manifest.presets.entries()) {
      const entry: ArchiveEntry = { entryId: String(index), name: typeof raw?.name === 'string' ? raw.name : `Entry ${index + 1}` };
      try {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidEntry('entry_format_invalid', 'The preset entry format is invalid.');
        const asset = raw.asset;
        if (typeof asset !== 'string' || !/^images\/[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$/i.test(asset) || asset.includes('..')) throw invalidEntry('image_path_invalid', 'The image path is invalid.');
        const image = zip.file(asset); if (!image) throw invalidEntry('image_missing', 'The package is missing the reference image.');
        const bytes = await boundedZipBytes(image, Math.min(MAX_IMAGE, MAX_ARCHIVE - total)); total += bytes.length;
        if (!bytes.length) throw invalidEntry('image_empty', 'The reference image is empty.');
        const metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
        if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw invalidEntry('image_format_invalid', 'The reference image format is invalid.');
        const preset = this.normalize(raw, ''); if (!preset) throw invalidEntry('name_empty', 'The preset name is empty.');
        // Defaults are only for fields absent in older archives. Supplied values
        // must survive unchanged and pass the shared schema rather than coercion.
        for (const key of [...semanticKeys, 'group'] as const) if (Object.hasOwn(raw, key)) (preset as any)[key] = raw[key];
        validateLibraryPayload('reference_preset', preset);
        if (!preset.name.trim() || preset.name.length > 4000 || preset.group.length > 500 || /[\x00-\x1f]/.test(preset.group)) throw invalidEntry('name_or_group_invalid', 'The name or group is invalid.');
        for (const key of ['infoExtracted', 'strength', 'fidelity', 'informationExtracted'] as const) if (preset[key] < 0 || preset[key] > 1) throw invalidEntry('value_out_of_range', `${key} must be between 0 and 1.`, { key });
        for (const key of ['width', 'height'] as const) if (!Number.isSafeInteger(preset[key]) || preset[key] < 0 || preset[key] > 32768) throw invalidEntry('dimension_invalid', `The ${key} dimension is invalid.`, { key });
        entry.preset = preset; entry.bytes = bytes; entry.imageSha256 = hash(bytes);
        entry.fingerprint = referenceFingerprint(preset, entry.imageSha256);
        const legacyId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `sha256:${entry.fingerprint}`;
        if (legacyId.length > 500 || /[\x00-\x1f]/.test(legacyId)) throw invalidEntry('source_id_invalid', 'The source ID in the package is invalid.');
        entry.source = { namespace: 'reference-archive', legacyId };
        entry.extension = path.extname(asset).toLowerCase();
        if (previews) entry.previewUrl = `data:image/webp;base64,${(await sharp(bytes).resize(96, 96, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 65 }).toBuffer()).toString('base64')}`;
      } catch (error) { entry.error = errorFields(error); entry.bytes = undefined; }
      entries.push(entry);
    }
    return { sha256: hash(file), entries };
  }

  private async snapshot(): Promise<Snapshot> {
    const revision = this.repo.getRevision(), entries: SnapshotEntry[] = [];
    for (const item of this.repo.all('reference_preset')) {
      const preset = item.payload as ReferencePreset; let fingerprint: string | undefined;
      try { const stat = await fs.stat(preset.filePath); if (stat.isFile() && stat.size <= MAX_IMAGE) fingerprint = referenceFingerprint(preset, hash(await fs.readFile(preset.filePath))); } catch { /* An unavailable local image is not proof of equal content. */ }
      entries.push({ id: item.id, name: item.name, revision: item.revision, source: item.source, fingerprint, archived: item.archived, parameters: Object.fromEntries(semanticKeys.map(key => [key, preset[key]])) });
    }
    if (revision !== this.repo.getRevision()) throw changed('library_changed', 'The material library changed; preview again.');
    return { revision, entries, signature: hash(JSON.stringify(stable(entries))) };
  }

  async prepare(filePath: string): Promise<ReferenceImportPreviewText> {
    try {
      const archive = await this.archive(filePath, true), snapshot = await this.snapshot();
      const seen: ArchiveEntry[] = [];
      const entries = archive.entries.map((entry): ReferenceImportEntryText => {
        const base = { entryId: entry.entryId, name: entry.name, kind: entry.preset?.kind, group: entry.preset?.group, previewUrl: entry.previewUrl, parameters: entry.preset ? Object.fromEntries(semanticKeys.map(key => [key, entry.preset![key]])) : undefined };
        if (entry.error) return { ...base, status: 'invalid', defaultAction: 'skip', ...entry.error };
        const identical = snapshot.entries.filter(item => item.fingerprint === entry.fingerprint);
        const duplicate = seen.some(item => item.fingerprint === entry.fingerprint);
        const sourceMatches = snapshot.entries.filter(item => item.id === entry.source!.legacyId || item.source.legacyId === entry.source!.legacyId);
        const packageConflict = seen.some(item => item.source!.legacyId === entry.source!.legacyId);
        seen.push(entry);
        if (identical.length || duplicate) return { ...base, status: 'identical', defaultAction: 'skip', localNames: identical.map(item => item.name), ...(duplicate ? entryText('identical_in_package', 'The package already has the same image and reference parameters; the duplicate is skipped.') : identical.some(item => item.archived) ? entryText('identical_local_archived', 'This device already has the same content (including archived entries); the local group is kept.') : entryText('identical_local', 'This device already has the same content; the local group is kept.')) };
        if (sourceMatches.length || packageConflict) return { ...base, status: 'conflict', defaultAction: 'skip', localNames: sourceMatches.map(item => item.name), localParameters: sourceMatches.map(item => ({ name: item.name, parameters: item.parameters })), ...entryText('source_conflict', 'Content from the same source differs. The local entry is kept by default; an imported copy does not overwrite it.') };
        return { ...base, status: 'new', defaultAction: 'import', ...entryText('new', 'This device has no such content; a new reference preset will be added.') };
      });
      for (const [id, session] of this.sessions) if (!session.running && Date.now() - session.createdAt > 30 * 60_000) this.sessions.delete(id);
      if (this.sessions.size >= 20) { const disposable = [...this.sessions].find(([, session]) => !session.running); if (disposable) this.sessions.delete(disposable[0]); }
      const importId = randomUUID(), preview: ReferenceImportPreviewText = { ok: true, importId, libraryRevision: snapshot.revision, packageName: path.basename(filePath), entries };
      this.sessions.set(importId, { path: filePath, archiveSha256: archive.sha256, snapshot, preview, localIds: new Map(entries.map(entry => [entry.entryId, randomUUID()])), createdAt: Date.now() });
      return preview;
    } catch (error) { return { ok: false, ...errorFields(error) }; }
  }

  async commit(request: ReferenceImportCommitRequest): Promise<ReferenceImportCommitResultText> {
    const rejected = (text: HostDetail, requiresReview = false): ReferenceImportCommitResultText => ({ ok: false, ...text, requiresReview, imported: 0, skipped: 0, failed: 0, entries: [] });
    try { validateLibraryRequest('reference_import_commit', request); } catch (error) { return rejected(errorFields(error)); }
    const session = this.sessions.get(request.importId);
    if (!session) return rejected(hostMessage('reference_import_expired', 'The import preview has expired; choose the preset package again.'), true);
    if (session.result) return session.result;
    if (session.running) return session.running;
    if (request.libraryRevision !== session.snapshot.revision) return rejected(hostMessage('reference_import_revision_mismatch', 'The confirmed version does not match the preview; preview again.'), true);
    const decisions = new Map(request.decisions.map(item => [item.entryId, item.action]));
    const previews = session.preview.entries!;
    if (decisions.size !== request.decisions.length || decisions.size !== previews.length || previews.some(entry => !decisions.has(entry.entryId) || !(['skip', ...(entry.status === 'new' ? ['import'] : entry.status === 'conflict' ? ['copy'] : [])].includes(decisions.get(entry.entryId)!)))) return rejected(hostMessage('reference_import_decisions_invalid', 'Every entry needs one decision that matches its preview status.'));
    session.running = this.execute(session, decisions).then(result => { session.result = result; return result; }).finally(() => { session.running = undefined; });
    return session.running;
  }

  private async execute(session: Session, decisions: Map<string, string>): Promise<ReferenceImportCommitResultText> {
    const result: ReferenceImportCommitResultText = { ok: true, message: '', imported: 0, skipped: 0, failed: 0, entries: [] };
    let archive: Archive;
    try {
      archive = await this.archive(session.path, false);
      const snapshot = await this.snapshot();
      if (archive.sha256 !== session.archiveSha256 || snapshot.revision !== session.snapshot.revision || snapshot.signature !== session.snapshot.signature) throw changed('package_or_library_changed', 'The preset package or the material library changed; preview again before confirming.');
    } catch (error) { return { ...result, ok: false, requiresReview: true, ...errorFields(error) }; }
    let expectedRevision = this.repo.getRevision(), stopped: HostDetail | null = null;
    const libraryChanged = () => changed('library_changed_remaining', 'The material library changed; preview the remaining entries again.');
    for (const entry of archive.entries) {
      if (decisions.get(entry.entryId) === 'skip') { const previewed = session.preview.entries!.find(value => value.entryId === entry.entryId)!; result.skipped++; result.entries.push({ entryId: entry.entryId, name: entry.name, status: 'skipped', ...hostDetail(previewed, 'reference_import_entry', previewed.message) }); continue; }
      // After a failure the remaining entries are not tried; they report the same failure.
      if (stopped) { result.failed++; result.entries.push({ entryId: entry.entryId, name: entry.name, status: 'failed', ...stopped }); continue; }
      let operation: string | undefined, target: string | undefined, created = false;
      try {
        if (this.repo.getRevision() !== expectedRevision) throw libraryChanged();
        if (entry.error || !entry.preset || !entry.bytes || !entry.source) throw entry.error ? Object.assign(new Error(entry.error.message), entry.error) : invalidEntry('image_unavailable', 'The image is unavailable.');
        if (this.repo.all('reference_preset').filter(item => !item.archived).length >= MAX_PRESETS) throw hostError('reference_preset_limit_reached', 'The number of reference presets has reached its limit.', undefined, { limit: MAX_PRESETS });
        const id = session.localIds.get(entry.entryId)!;
        target = path.join(this.directory, `${id}${entry.extension}`);
        const preset = this.normalize({ ...entry.preset, id, createdAt: new Date().toISOString() }, target)!;
        // Preserve every validated semantic value; normalization supplies only local identity/URL.
        for (const key of [...semanticKeys, 'group'] as const) (preset as any)[key] = entry.preset[key];
        validateLibraryPayload('reference_preset', preset);
        await fs.mkdir(this.directory, { recursive: true });
        if (this.repo.getRevision() !== expectedRevision) throw libraryChanged();
        operation = beginLibraryFileOperation(this.repo, 'create', { kind: 'reference_preset', id, item: preset, source: entry.source, target, byteLength: entry.bytes.length, sha256: entry.imageSha256 });
        expectedRevision = this.repo.getRevision();
        const file = await fs.open(target, 'wx'); created = true;
        try { await file.writeFile(entry.bytes); } finally { await file.close(); }
        this.repo.transaction(() => {
          if (this.repo.getRevision() !== expectedRevision) throw libraryChanged();
          this.repo.put('reference_preset', id, preset, { expectedRevision: 0, source: entry.source });
          if (preset.group && !this.repo.collections('reference').some(group => group.id === preset.group)) this.repo.putCollection({ namespace: 'reference', id: preset.group, name: preset.group, payload: {} });
          this.repo.completeFileOperation(operation!);
        });
        expectedRevision = this.repo.getRevision();
        result.imported++; result.entries.push({ entryId: entry.entryId, name: entry.name, status: 'imported', localId: id });
      } catch (error) {
        const base = errorFields(error), notes: HostDetail[] = [];
        const english = () => [base.message, ...notes.map(note => note.message)].join(' ');
        result.ok = false; result.requiresReview = true;
        // A handled failure is not an interrupted, approved create to replay at startup.
        let pending;
        try {
          pending = operation ? this.repo.pendingFileOps().find(value => value.id === operation) : undefined;
          if (pending) this.repo.putFileOperation({ ...pending, state: 'failed', error: english() });
        } catch (journalError) { notes.push(entryText('failure_record_unconfirmed', `The failure record is not confirmed: ${errorFields(journalError).message}`, { detail: errorFields(journalError).message })); }
        let cleaned = true;
        if (created && target) {
          try { await fs.rm(target, { force: true }); }
          catch (cleanupError) { cleaned = false; notes.push(entryText('cleanup_incomplete', `File cleanup did not complete: ${errorFields(cleanupError).message}`, { detail: errorFields(cleanupError).message })); }
        }
        try {
          if (operation && cleaned) this.repo.completeFileOperation(operation);
          else if (pending) this.repo.putFileOperation({ ...pending, state: 'failed', error: english() });
        } catch (journalError) { notes.push(entryText('file_operation_unconfirmed', `The file operation record is not confirmed: ${errorFields(journalError).message}`, { detail: errorFields(journalError).message })); }
        // With notes the entry text is the failure followed by them; as a nested detail it falls back to its English params.
        stopped = notes.length
          ? hostMessage('reference_import_entry_failed', english(), 'reference_import.entry_failed_notes', { detail: base.message, notes: notes.map(note => note.message).join(' ') }, { detail: base, notes })
          : base;
        result.failed++; result.entries.push({ entryId: entry.entryId, name: entry.name, status: 'failed', ...stopped });
      }
    }
    Object.assign(result, stopped
      ? hostMessage('reference_imported', `Imported ${result.imported}, skipped ${result.skipped}, ${result.failed} not completed. ${stopped.message} Completed entries are kept; previewing again skips the same content.`, 'reference_import.partial', { imported: result.imported, skipped: result.skipped, failed: result.failed, detail: stopped.message }, { detail: stopped })
      : hostMessage('reference_imported', `Imported ${result.imported}, skipped ${result.skipped}. Content already on this device is unchanged.`, 'reference_import.done', { imported: result.imported, skipped: result.skipped }));
    return result;
  }
}
