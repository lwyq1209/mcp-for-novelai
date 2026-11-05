import { validateLibraryRequest } from './library/validation';
import type { LibraryRepository } from './library/repository';
import { beginLibraryFileOperation } from './library-file-operations';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ImageStudyError, STUDY_PARSE_LIMITS, type ParsedImageStudy } from './image-study-parser';
import type { HostErrorParams } from './host-error';
import type { StudyDetail, StudyField, StudyImage, StudyList, StudyRequest, StudySection, StudySummary } from '../src/workspace/image-study-types';

export const IMAGE_STUDY_LIMITS = { bytes: STUDY_PARSE_LIMITS.bytes, totalBytes: 512 * 1024 * 1024, entries: 2000, workers: 2, pending: 20, timeoutMs: 25_000, recordBytes: 64 * 1024, sectionBytes: 12 * 1024 * 1024 };
export interface StoredStudy { schemaVersion: 1; parserVersion: 1; study: StudySummary; notes: string; originalName?: string; previewSha256: string; previewByteLength: number; sections?: { prompts: StudyField[]; parameters: StudyField[]; raw: Record<string, Record<string, string>> } }
/** The study records (with their prompt, parameter and raw sections) are library items; `directory`/<id> holds each
 * study's original and preview files. */
type Options = { directory: string; repository: LibraryRepository; parse?: (bytes: Buffer) => Promise<ParsedImageStudy>; workerPath?: string };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw new ImageStudyError(code, message, reason, params); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : fail('invalid_argument', 'An object argument is required.', 'library.object_required');
const keys = (value: unknown, allowed: string[]) => { const unknown = Object.keys(obj(value)).filter(key => !allowed.includes(key)); if (unknown.length) fail('invalid_argument', `Unsupported fields: ${unknown.join(', ')}.`, 'library.unsupported_fields', { fields: unknown.join(', ') }); };
const text = (value: unknown, max: number, optional = false) => { if (value === undefined && optional) return ''; if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || (!optional && !value.trim())) return fail('invalid_argument', 'Text is empty, too long or contains control characters.', 'library.invalid_text'); return value.trim(); };
const integer = (value: unknown, fallback: number, max: number, min = 0) => { const n = value === undefined ? fallback : value; if (!Number.isSafeInteger(n) || Number(n) < min || Number(n) > max) return fail('invalid_argument', 'A number argument is out of range.', 'library.number_range'); return Number(n); };
const idOf = (value: unknown) => typeof value === 'string' && UUID.test(value) ? value : fail('invalid_argument', 'Invalid study ID.', 'study.invalid_id');
const bool = (value: unknown, fallback = false) => value === undefined ? fallback : typeof value === 'boolean' ? value : fail('invalid_argument', 'Invalid boolean field.', 'study.invalid_boolean');
const sourceUrl = (value: unknown) => {
  const source = text(value, 2000, true); if (!source) return '';
  try { const url = new URL(source); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
  catch { return fail('invalid_argument', 'The source link must be an HTTP(S) link without credentials; it is only recorded, never visited.', 'study.invalid_source_url'); }
  return source;
};
const decode = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(IMAGE_STUDY_LIMITS.bytes / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return fail('invalid_image', 'The image encoding is invalid or exceeds 20 MiB.', 'study.invalid_encoding');
  const bytes = Buffer.from(value, 'base64'); if (bytes.length > IMAGE_STUDY_LIMITS.bytes || bytes.toString('base64') !== value) return fail('invalid_image', 'The image encoding is invalid or exceeds 20 MiB.', 'study.invalid_encoding'); return bytes;
};
const extension = (mime: string) => mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : fail('study_corrupt', 'Invalid image format record.', 'study.invalid_format_record');

/** Long-lived host ownership, independent of generation reservations. Parsers
 * run outside this service's short persistence lane and never receive paths. */
export function createImageStudyService(options: Options) {
  const directory = path.resolve(options.directory), workers = new Set<Worker>();
  let persistence: Promise<unknown> = Promise.resolve(), active = 0, closed = false;
  const waiting: { start: () => void; reject: (error: Error) => void }[] = [];
  const serial = <T>(call: () => Promise<T>): Promise<T> => { const result = persistence.then(call, call); persistence = result.catch(() => undefined); return result; };
  const checkDirectory = async (create = false) => {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== path.join(await fs.realpath(path.dirname(directory)), path.basename(directory))) return fail('study_storage_failed', 'The study folder is not a separate local folder.', 'study.folder_invalid'); return true; }
    catch (error: any) { if (!create && error.code === 'ENOENT') return false; throw error; }
  };
  const entryDirectory = (id: string) => path.join(directory, idOf(id));
  const checkedEntry = async (id: string) => {
    const file = entryDirectory(id); if (!await checkDirectory()) return fail('study_not_found', 'This study does not exist.', 'study.not_found');
    try { const stat = await fs.lstat(file); if (!stat.isDirectory() || stat.isSymbolicLink()) return fail('study_corrupt', 'Invalid study folder.', 'study.entry_folder_invalid'); return file; }
    catch (error: any) { if (error.code === 'ENOENT') return fail('study_not_found', 'This study does not exist.', 'study.not_found'); throw error; }
  };
  const readFile = async (file: string, max: number) => {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) return fail('study_corrupt', 'A study file is invalid or exceeds its size limit.', 'study.file_invalid');
      const bytes = Buffer.alloc(stat.size + 1); let position = 0;
      while (position < bytes.length) { const next = await handle.read(bytes, position, bytes.length - position, position); if (!next.bytesRead) return bytes.subarray(0, position); position += next.bytesRead; }
      return fail('study_corrupt', 'A study file changed while it was read.', 'study.file_changed');
    }
    finally { await handle.close(); }
  };
  const repository = options.repository;
  const record = async (id: string): Promise<StoredStudy> => {
    const item = repository.get('study', id);
    return item ? item.payload as unknown as StoredStudy : fail('study_not_found', 'This study does not exist.', 'study.not_found');
  };
  const records = async () => {
    const items = repository.all('study').map(item => item.payload as unknown as StoredStudy);
    return { items, count: items.length };
  };
  const workerParse = (bytes: Buffer) => new Promise<ParsedImageStudy>((resolve, reject) => {
    const data = Uint8Array.from(bytes).buffer;
    const worker = new Worker(options.workerPath ?? path.join(__dirname, 'image-study-worker.js'), { workerData: { bytes: data }, transferList: [data], resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
    workers.add(worker); let finished = false;
    const finish = (error?: Error, result?: ParsedImageStudy) => {
      if (finished) return; finished = true; clearTimeout(timer);
      // A timed-out native decode must exit before another worker can claim
      // this slot; settling earlier would exceed the two-worker bound.
      void worker.terminate().catch(() => undefined).then(() => { workers.delete(worker); if (error) reject(error); else resolve(result!); });
    };
    const timer = setTimeout(() => finish(new ImageStudyError('study_parse_timeout', 'Image parsing timed out; no entry was published.', 'study.parse_timeout')), IMAGE_STUDY_LIMITS.timeoutMs); timer.unref();
    // The worker's refusal keeps its code, English message and window reason/params (image-study-worker.ts).
    const refusal = (error: any) => typeof error?.message === 'string'
      ? new ImageStudyError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'study_parse_failed', error.message, typeof error.reason === 'string' ? error.reason : undefined, error.params && typeof error.params === 'object' ? error.params : undefined)
      : new ImageStudyError('study_parse_failed', 'Image parsing failed.', 'study.parse_failed');
    worker.once('message', message => message?.ok && message.result ? finish(undefined, message.result) : finish(refusal(message?.error)));
    worker.once('error', () => finish(new ImageStudyError('study_parse_failed', 'The separate image parser failed; the generation queue is not affected.', 'study.parser_crashed')));
    worker.once('exit', () => finish(new ImageStudyError('study_parse_failed', 'The separate image parser exited.', 'study.parser_exited')));
  });
  const parse = (bytes: Buffer): Promise<ParsedImageStudy> => new Promise((resolve, reject) => {
    if (closed) { reject(new ImageStudyError('study_unavailable', 'The study service is closed.', 'study.closed')); return; }
    if (active + waiting.length >= IMAGE_STUDY_LIMITS.pending) { reject(new ImageStudyError('study_busy', 'Too many study files are pending; wait for the current imports to finish.', 'study.busy')); return; }
    const start = () => {
      active++;
      void Promise.resolve().then(() => options.parse ? options.parse(bytes) : workerParse(bytes)).then(resolve, reject).finally(() => { active--; waiting.shift()?.start(); });
    };
    if (active < IMAGE_STUDY_LIMITS.workers) start(); else waiting.push({ start, reject });
  });
  const write = async (file: string, bytes: Uint8Array) => { const handle = await fs.open(file, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } };
  const syncDirectory = async (folder: string) => { try { const handle = await fs.open(folder, 'r'); try { await handle.sync(); } finally { await handle.close(); } } catch { /* publication already committed */ } };
  const usedBytes = async () => {
    let size = 0;
    for (const name of await fs.readdir(directory)) {
      const folder = path.join(directory, name), stat = await fs.lstat(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return fail('study_storage_failed', 'The study folder contains unsupported files.', 'study.folder_unsupported');
      for (const item of await fs.readdir(folder)) { const child = await fs.lstat(path.join(folder, item)); if (child.isSymbolicLink() || !child.isFile()) return fail('study_storage_failed', 'The study folder contains unsupported files.', 'study.folder_unsupported'); size += child.size; }
    }
    return size;
  };
  const importImage = async (args: Record<string, any>) => {
    keys(args, ['action', 'name', 'data', 'sourceUrl', 'sourceAuthor']);
    const name = text(args.name, 200), url = sourceUrl(args.sourceUrl), author = text(args.sourceAuthor, 200, true), bytes = decode(args.data), sha256 = digest(bytes);
    const existing = (await records()).items.find(item => item.study.sha256 === sha256);
    if (existing) return { study: existing.study, duplicate: true };
    const parsed = await parse(bytes);
    return serial(async () => {
      await checkDirectory(true);
      const all = await records(), duplicate = all.items.find(item => item.study.sha256 === sha256);
      if (duplicate) return { study: duplicate.study, duplicate: true };
      if (all.count >= IMAGE_STUDY_LIMITS.entries) return fail('study_storage_full', 'The study collection has reached 2000 entries.', 'study.too_many');
      const id = randomUUID(), now = new Date().toISOString();
      const study: StudySummary = { id, revision: 1, name, sha256, mimeType: parsed.mimeType, width: parsed.width, height: parsed.height, byteLength: bytes.length, sourceUrl: url, sourceAuthor: author, createdAt: now, updatedAt: now, archived: false, metadataStatus: parsed.metadataStatus, metadataKind: parsed.metadataKind, sources: parsed.sources, warnings: parsed.warnings.slice(0, 12).map(message => message.slice(0, 240)), promptFieldCount: parsed.prompts.length, parameterFieldCount: parsed.parameters.length };
      const fileName = path.basename(name), suffix = `.${extension(parsed.mimeType)}`;
      const originalName = fileName.toLowerCase().endsWith(suffix) || (parsed.mimeType === 'image/jpeg' && /\.jpeg$/i.test(fileName)) ? fileName : `${fileName}${suffix}`;
      const stored: StoredStudy = { schemaVersion: 1, parserVersion: 1, study, notes: '', originalName, previewSha256: parsed.previewSha256, previewByteLength: parsed.preview.length };
      // The original and its preview are files; the record and its sections are stored in the library, within the
      // same size bounds (the whole collection's bound counts their encoded size too).
      const files: [string, Uint8Array][] = [[`original.${extension(parsed.mimeType)}`, bytes], ['preview.webp', parsed.preview]];
      const encoded: [string, Uint8Array][] = [['record', Buffer.from(JSON.stringify(stored))], ['prompts', Buffer.from(JSON.stringify(parsed.prompts))], ['parameters', Buffer.from(JSON.stringify(parsed.parameters))], ['raw', Buffer.from(JSON.stringify(parsed.raw))]];
      if (encoded.some(([field, data]) => data.length > (field === 'record' ? IMAGE_STUDY_LIMITS.recordBytes : IMAGE_STUDY_LIMITS.sectionBytes))) return fail('study_storage_full', 'Study fields exceed the storage limit; no entry was published.', 'study.fields_too_large');
      if (await usedBytes() + [...files, ...encoded].reduce((sum, [, data]) => sum + data.length, 0) > IMAGE_STUDY_LIMITS.totalBytes) return fail('study_storage_full', 'The study collection has reached 512 MiB.', 'study.storage_full');
      stored.sections = { prompts: parsed.prompts, parameters: parsed.parameters, raw: parsed.raw };
      const temporary = path.join(directory, `.${id}.pending`); await fs.mkdir(temporary, { mode: 0o700 });
      const operation = beginLibraryFileOperation(repository, 'create', { kind: 'study', id, item: stored, files: files.map(([file, data]) => ({ target: path.join(entryDirectory(id), file), byteLength: data.length, sha256: digest(data) })) });
      try { for (const [file, data] of files) await write(path.join(temporary, file), data); await syncDirectory(temporary); await fs.rename(temporary, entryDirectory(id)); await syncDirectory(directory); }
      catch (error) { await fs.rm(temporary, { recursive: true, force: true }).catch(() => undefined); throw error; }
      try { repository.transaction(() => { repository.put('study', id, stored, { expectedRevision: 0, revision: 1 }); repository.completeFileOperation(operation); }); }
      catch (error) { await fs.rm(entryDirectory(id), { recursive: true, force: true }); throw error; }
      return { study, duplicate: false };
    });
  };
  const material_studies = async (request: StudyRequest | Record<string, unknown>): Promise<any> => {
    validateLibraryRequest('material_studies', request);
    const args = obj(request);
    if (args.action === 'import') return importImage(args);
    if (args.action === 'list') {
      keys(args, ['action', 'query', 'offset', 'limit', 'includeArchived']);
      const query = text(args.query, 200, true).toLowerCase(), offset = integer(args.offset, 0, 100_000), limit = integer(args.limit, 20, 50, 1), archived = bool(args.includeArchived);
      const result = repository.list({ kinds: ['study'], query, offset, limit, includeArchived: archived });
      return { ...result, items: result.items.map(item => (item.payload as unknown as StoredStudy).study) } satisfies StudyList;
    }
    if (args.action === 'read') {
      keys(args, ['action', 'id', 'section']); const id = idOf(args.id), section = (args.section ?? 'summary') as StudySection;
      if (!['summary', 'prompts', 'parameters', 'raw', 'notes'].includes(section)) return fail('invalid_argument', 'Unknown study section.', 'study.unknown_section');
      const saved = await record(id), result: StudyDetail = { study: saved.study, section };
      if (section === 'notes') result.notes = saved.notes;
      if (section === 'prompts' || section === 'parameters' || section === 'raw') {
        try {
          const value: unknown = saved.sections?.[section];
          if (section === 'raw') {
            const sources = obj(value); if (Object.entries(sources).some(([source, values]) => !saved.study.sources.includes(source) || Object.values(obj(values)).some(item => typeof item !== 'string'))) return fail('study_corrupt', 'Invalid raw fields.', 'study.raw_invalid');
            result.raw = sources as Record<string, Record<string, string>>;
          } else {
            if (!Array.isArray(value) || value.length > STUDY_PARSE_LIMITS.fields || value.some(row => !row || typeof row.key !== 'string' || typeof row.label !== 'string' || typeof row.value !== 'string')) return fail('study_corrupt', 'Invalid study fields.', 'study.fields_invalid');
            result.fields = value as StudyField[];
          }
        } catch { return fail('study_corrupt', 'Study fields cannot be read; the original is unchanged.', 'study.fields_unreadable'); }
      }
      return result;
    }
    if (args.action === 'image' || args.action === 'original') {
      keys(args, ['action', 'id']); const id = idOf(args.id), saved = await record(id), original = args.action === 'original';
      const bytes = await readFile(path.join(await checkedEntry(id), original ? `original.${extension(saved.study.mimeType)}` : 'preview.webp'), original ? IMAGE_STUDY_LIMITS.bytes : STUDY_PARSE_LIMITS.previewBytes);
      if (bytes.length !== (original ? saved.study.byteLength : saved.previewByteLength) || digest(bytes) !== (original ? saved.study.sha256 : saved.previewSha256)) return fail('study_corrupt', 'The digest of the original or preview does not match.', 'study.digest_mismatch');
      return { id, sha256: saved.study.sha256, name: original ? saved.originalName ?? `${saved.study.name}.${extension(saved.study.mimeType)}` : `${saved.study.name}.preview.webp`, mimeType: original ? saved.study.mimeType : 'image/webp', data: bytes.toString('base64') } satisfies StudyImage;
    }
    if (args.action === 'update') {
      keys(args, ['action', 'id', 'expectedRevision', 'patch']); const id = idOf(args.id), expected = integer(args.expectedRevision, 0, Number.MAX_SAFE_INTEGER, 1), patch = obj(args.patch);
      keys(patch, ['name', 'sourceUrl', 'sourceAuthor', 'notes', 'archived']); if (!Object.keys(patch).length) return fail('invalid_argument', 'The patch cannot be empty.', 'study.empty_patch');
      const updates: Partial<StudySummary> = {};
      if (Object.hasOwn(patch, 'name')) updates.name = text(patch.name, 200);
      if (Object.hasOwn(patch, 'sourceUrl')) updates.sourceUrl = sourceUrl(patch.sourceUrl);
      if (Object.hasOwn(patch, 'sourceAuthor')) updates.sourceAuthor = text(patch.sourceAuthor, 200, true);
      if (Object.hasOwn(patch, 'archived')) updates.archived = bool(patch.archived);
      const notes = Object.hasOwn(patch, 'notes') ? text(patch.notes, 16000, true) : undefined;
      return serial(async () => {
        const saved = await record(id); if (saved.study.revision !== expected) return fail('conflict', 'The study changed; read it again before saving.', 'study.changed');
        const next = { ...saved, study: { ...saved.study, ...updates, revision: expected + 1, updatedAt: new Date().toISOString() }, notes: notes ?? saved.notes }, payload = Buffer.from(JSON.stringify({ ...next, sections: undefined }));
        if (payload.length > IMAGE_STUDY_LIMITS.recordBytes) return fail('study_storage_full', 'The study record is too long.', 'study.record_too_large');
        repository.put('study', id, next, { expectedRevision: expected, revision: expected + 1 });
        return { study: next.study };
      });
    }
    return fail('invalid_argument', 'Unknown study action.', 'study.unknown_action');
  };
  const dispose = () => { closed = true; for (const job of waiting.splice(0)) job.reject(new ImageStudyError('study_unavailable', 'The study service is closed.', 'study.closed')); for (const worker of workers) void worker.terminate(); };
  return { material_studies, dispose };
}
