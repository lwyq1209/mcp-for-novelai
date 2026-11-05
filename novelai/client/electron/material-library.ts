import { validateLibraryRequest } from './library/validation';
import type { LibraryRepository } from './library/repository';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DANBOORU_RATINGS, type DanbooruImage, type DanbooruPost, type DanbooruRating, type DanbooruService } from '../src/workspace/danbooru-types';
import type { MaterialEntry, MaterialEntryInput, MaterialSummary, MaterialTag, MaterialTagEvidence, MaterialComponent, MaterialLink, MaterialBackup, MaterialSampleSort } from '../src/workspace/material-library-types';
import { createMaterialCoverStore, localFileName, normalizeMaterialCover } from './material-covers';
import { withReason, type HostErrorParams } from './host-error';
import { MANUAL_BATCH_MAX_ITEMS } from '../src/workspace/batch-types';

/** reason/params: the window's catalog message (src/host-errors/library.ts); the message is English. */
export class MaterialLibraryError extends Error {
  declare reason?: string; declare params?: HostErrorParams;
  constructor(public code: string, message: string, reason?: string, params?: HostErrorParams) { super(message); if (reason) withReason(this, reason, params); }
}
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw new MaterialLibraryError(code, message, reason, params); };
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_TOTAL = 64 * 1024 * 1024, MAX_ENTRIES = 1000;
const obj = (value: any): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : fail('invalid_argument', 'An object argument is required.', 'library.object_required');
/** `where`: the object's place in the request (for example entry.links[0]), named with the unsupported fields. */
const keys = (value: any, allowed: string[], where?: string) => { obj(value); const unknown = Object.keys(value).filter(key => !allowed.includes(key)); if (unknown.length) { const fields = unknown.join(', '); if (where) fail('invalid_argument', `${where} has unsupported fields: ${fields}.`, 'material.unsupported_fields_at', { where, fields }); fail('invalid_argument', `Unsupported fields: ${fields}.`, 'library.unsupported_fields', { fields }); } };
const str = (value: any, max: number, optional = false) => {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value) || (!optional && !value.trim())) fail('invalid_argument', 'Text is empty, too long or contains control characters.', 'library.invalid_text');
  return value.trim();
};
const english = (value: any) => { const text = str(value, 400); if (/[^\x20-\x7e]/.test(text)) fail('invalid_argument', 'Prompt materials must be English; put Chinese explanations in notes.', 'material.english_only'); return text; };
const idOf = (value: any) => typeof value === 'string' && UUID.test(value) ? value : fail('invalid_argument', 'Invalid entry ID.', 'material.invalid_id');
const int = (value: any, fallback: number, min: number, max: number) => { const n = value === undefined ? fallback : value; if (!Number.isSafeInteger(n) || n < min || n > max) fail('invalid_argument', 'A number argument is out of range.', 'library.number_range'); return n as number; };
const revisionOf = (value: any) => int(value, 0, 1, Number.MAX_SAFE_INTEGER);
const choice = <T extends string>(value: any, allowed: readonly T[]): T => allowed.includes(value) ? value : fail('invalid_argument', 'Invalid category or target field.', 'material.invalid_choice');
const categoryOf = (value: any): string | null => value == null ? null : str(value, 60);
const SOURCE = ['danbooru', 'nai', 'english'] as const, TARGET = ['style', 'base', 'character'] as const;
const SAMPLE_SORTS = ['score', 'newest', 'oldest'] as const;
const ratingOf = (value: any): DanbooruRating => value === undefined ? 'g' : choice(value, DANBOORU_RATINGS);
const sampleOrder = (sort: MaterialSampleSort) => sort === 'score' ? 'score' : sort === 'newest' ? 'id_desc' : 'id_asc';
const compareSamples = (sort: MaterialSampleSort) => (left: DanbooruPost, right: DanbooruPost) => sort === 'score'
  ? right.score - left.score || right.postId - left.postId
  : sort === 'newest' ? right.postId - left.postId : left.postId - right.postId;

function tagInput(raw: unknown): MaterialTag {
  const value = obj(raw); keys(value, ['text', 'source', 'category', 'target', 'evidence']);
  // Evidence always comes from this service or the unchanged stored tag, never a caller.
  return { text: english(value.text), source: choice(value.source, SOURCE), category: categoryOf(value.category), target: choice(value.target, TARGET) };
}
function componentInput(raw: unknown): MaterialComponent {
  const value = obj(raw); keys(value, ['text', 'source', 'category', 'weight', 'target', 'entryId', 'entryRevision']);
  if (typeof value.weight !== 'number' || !Number.isFinite(value.weight) || value.weight < 0 || value.weight > 10) fail('invalid_argument', 'Weight must be between 0 and 10.', 'material.weight_range');
  if ((value.entryId === undefined) !== (value.entryRevision === undefined)) fail('invalid_argument', 'A referenced entry needs both its ID and revision.', 'material.reference_identity');
  return { text: english(value.text), source: choice(value.source, SOURCE), category: categoryOf(value.category), weight: value.weight, target: choice(value.target, TARGET),
    ...(value.entryId === undefined ? {} : { entryId: idOf(value.entryId), entryRevision: revisionOf(value.entryRevision) }) };
}
function entryInput(raw: unknown): MaterialEntryInput {
  const value = obj(raw); keys(value, ['kind', 'name', 'group', 'notes', 'tag', 'components', 'links'], 'entry');
  const kind = choice(value.kind, ['tag', 'combo', 'note'] as const);
  const entry: MaterialEntryInput = { kind, name: str(value.name, 200), group: str(value.group, 100, true), notes: str(value.notes, 16000, true) };
  if (kind === 'tag') { if (value.components !== undefined) fail('invalid_argument', 'A tag cannot have combo components.', 'material.tag_components'); entry.tag = tagInput(value.tag); }
  else if (value.tag !== undefined) fail('invalid_argument', 'This entry kind does not take a tag.', 'material.kind_no_tag');
  if (kind === 'combo') {
    if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 40) fail('invalid_argument', 'A combo needs 1–40 ordered components.', 'material.combo_size');
    entry.components = value.components.map(componentInput);
  } else if (value.components !== undefined) fail('invalid_argument', 'This entry kind does not take components.', 'material.kind_no_components');
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > 100) fail('invalid_argument', 'At most 100 links.', 'material.links_size');
    entry.links = value.links.map((raw: unknown, index: number): MaterialLink => {
      const link = obj(raw); keys(link, ['batchId', 'itemIndex', 'feedback', 'studyId', 'sourceSha256', 'field', 'excerpt'], `links[${index}]`);
      const output: MaterialLink = {};
      for (const key of ['batchId', 'feedback'] as const) if (link[key] !== undefined) output[key] = str(link[key], key === 'feedback' ? 4000 : 200);
      if (link.itemIndex !== undefined) { if (!link.batchId) fail('invalid_argument', 'An image index needs a batch ID.', 'material.link_item_index'); output.itemIndex = int(link.itemIndex, 0, 0, MANUAL_BATCH_MAX_ITEMS - 1); }
      if (['studyId', 'sourceSha256', 'field', 'excerpt'].some(key => link[key] !== undefined)) {
        output.studyId = str(link.studyId, 200);
        if (typeof link.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(link.sourceSha256)) fail('invalid_argument', 'A study excerpt needs the SHA-256 of its original image.', 'material.link_sha');
        output.sourceSha256 = link.sourceSha256;
        output.field = str(link.field, 1000);
        // Preserve the quoted text exactly, including its original whitespace.
        str(link.excerpt, 16000); output.excerpt = link.excerpt;
      }
      if (!Object.keys(output).length) fail('invalid_argument', 'A link cannot be empty.', 'material.link_empty');
      return output;
    });
  }
  return entry;
}
function summary(entry: MaterialEntry): MaterialSummary {
  const tag = entry.tag;
  return { id: entry.id, revision: entry.revision, kind: entry.kind, name: entry.name, group: entry.group, notesPreview: entry.notes.slice(0, 160), archived: entry.archived, updatedAt: entry.updatedAt,
    ...(tag ? { tag: { text: tag.text, source: tag.source, category: tag.category, target: tag.target, postCount: tag.evidence?.postCount ?? null, resolution: tag.evidence?.resolution ?? 'not_applicable', checkedAt: tag.evidence?.checkedAt ?? null } } : {}),
    ...(entry.components ? { componentCount: entry.components.length } : {}),
    ...(entry.coverRevision !== undefined ? { coverRevision: entry.coverRevision, cover: entry.cover ?? null, coverStatus: entry.coverStatus ?? 'none' } : {}) };
}
const unknownEvidence = (message: string): MaterialTagEvidence => ({ checkedAt: null, canonicalName: null, resolution: 'unknown', tagStatus: 'unknown', category: null, postCount: null, deprecated: null, aliasStatus: 'unknown', wiki: { status: 'not_checked' }, sources: [], errors: [{ stage: 'lookup', code: 'lookup_unavailable', message }] });

/** Separate resource lanes: material requests never reserve, pause or inspect generation. */
function lane(concurrency: number, maxPending = 32) {
  let active = 0; const pending: Array<() => void> = [];
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      if (pending.length >= maxPending) fail('material_busy', 'Material reads are full; try again later. The generation queue is not affected.', 'material.busy');
      await new Promise<void>(resolve => pending.push(resolve));
    } else active++;
    try { return await run(); } finally { const next = pending.shift(); if (next) next(); else active--; }
  };
}
const bounded = async <T>(run: () => Promise<T>, milliseconds = 16000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([run(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new MaterialLibraryError('upstream_timeout', 'The material read timed out; the generation queue is not affected and nothing was retried.', 'material.timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};

/** The tag, combo and note entries are library items (every revision is a library version); the covers' image files
 * are under `directory`/covers (material-covers.ts). */
export function createMaterialLibraryService(options: {
  directory: string;
  repository: LibraryRepository;
  tags: { search(args: { query: string; limit?: number; category?: 'artist' }): Promise<any>; details(args: { name?: string; names?: string[]; detail: 'compact' }): Promise<any> };
  gallery: Pick<DanbooruService, 'search' | 'detail' | 'image'>;
}) {
  const directory = path.resolve(options.directory), metadataLane = lane(4), sampleLane = lane(2), localDecodeLane = lane(2, 2);
  const repo = options.repository;
  const covers = createMaterialCoverStore(directory, repo);
  const stored = (id: string) => (['tag', 'combo', 'note'] as const).map(kind => repo.get(kind, id)).find(Boolean);
  let serial: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>) => { const next = serial.then(run); serial = next.catch(() => undefined); return next; };
  const readVersions = async (id: string): Promise<MaterialEntry[] | null> => {
    const item = stored(id);
    return item ? repo.readVersions(item.kind, id).map(row => row.payload as unknown as MaterialEntry) : null;
  };
  const readEntry = async (id: string, version?: number): Promise<MaterialEntry> => {
    const versions = await readVersions(id); const entry = version === undefined ? versions?.at(-1) : versions?.[revisionOf(version) - 1];
    if (!entry) return fail('material_not_found', 'This entry or revision does not exist.', 'material.entry_or_revision_not_found');
    return structuredClone(entry);
  };
  const decorated = async (entry: MaterialEntry): Promise<MaterialEntry> => {
    const { coverRevision, cover, coverStatus } = await covers.state(entry);
    return { ...entry, coverRevision, cover, coverStatus };
  };
  const entryCount = () => (['tag', 'combo', 'note'] as const).reduce((count, kind) => count + repo.all(kind).length, 0);
  /** Saves the newest of `versions` as the next library revision of the entry. */
  const writeVersions = async (id: string, versions: MaterialEntry[]) => {
    const value = versions.at(-1)!;
    repo.put(value.kind, id, value, { expectedRevision: value.revision - 1, revision: value.revision });
  };
  const resolveTag = async (tag: MaterialTag, old?: MaterialTag): Promise<MaterialTag> => {
    if (tag.source !== 'danbooru') return tag;
    if (old?.source === tag.source && old.text === tag.text && old.evidence) return { ...tag, text: old.text, category: old.category, evidence: structuredClone(old.evidence) };
    let evidence: MaterialTagEvidence;
    try {
      const result = await metadataLane(() => bounded(() => options.tags.details({ name: tag.text, detail: 'compact' })));
      const item = result?.items?.[0];
      if (!item || result.items.length !== 1 || item.name !== tag.text.trim().toLowerCase().replaceAll(' ', '_')) fail('invalid_response', 'The tag details do not match the request.', 'material.tag_details_mismatch');
      evidence = { checkedAt: result.checkedAt ?? null, canonicalName: item.canonicalName ?? null, resolution: item.resolution ?? 'unknown', tagStatus: item.tagStatus ?? 'unknown', category: item.category ?? null,
        postCount: Number.isSafeInteger(item.postCount) && item.postCount >= 0 ? item.postCount : null, deprecated: typeof item.deprecated === 'boolean' ? item.deprecated : null, aliasStatus: item.aliasStatus ?? 'unknown',
        wiki: item.wiki ?? { status: 'not_checked' }, sources: Array.isArray(item.sources) ? item.sources : [], ...(item.aliases ? { aliases: item.aliases } : {}), ...(item.errors ? { errors: item.errors } : {}) };
      if (!['canonical', 'alias'].includes(evidence.resolution) || evidence.tagStatus !== 'found' || !evidence.canonicalName) evidence.canonicalName = null;
    } catch (error) { evidence = unknownEvidence(error instanceof Error ? error.message : 'The tag lookup did not complete.'); }
    return { ...tag, text: evidence.canonicalName ?? tag.text, category: evidence.category, evidence };
  };
  const validateReferences = async (entry: MaterialEntryInput) => {
    for (const item of entry.components ?? []) if (item.entryId) {
      const source = await readEntry(item.entryId, item.entryRevision);
      const candidates = source.tag ? [source.tag] : source.components ?? [];
      if (!candidates.some(candidate => candidate.text === item.text && candidate.source === item.source)) fail('material_reference_mismatch', 'A combo component differs from the named revision of its referenced entry.', 'material.reference_mismatch');
    }
  };
  const save = async (args: any) => {
    keys(args, ['action', 'entry', 'id', 'expectedRevision', 'refreshEvidence']);
    if (args.refreshEvidence !== undefined && typeof args.refreshEvidence !== 'boolean') fail('invalid_argument', 'Invalid refreshEvidence option.', 'material.invalid_refresh');
    if ((args.id === undefined) !== (args.expectedRevision === undefined)) fail('invalid_argument', 'Editing an entry needs both its ID and expectedRevision.', 'material.edit_identity');
    const input = entryInput(args.entry), id = args.id === undefined ? randomUUID() : idOf(args.id);
    const old = args.id === undefined ? undefined : await readEntry(id);
    if (old && old.revision !== revisionOf(args.expectedRevision)) fail('material_conflict', 'The entry changed; read it again before saving.', 'library.item_changed');
    if (input.tag) input.tag = await resolveTag(input.tag, args.refreshEvidence ? undefined : old?.tag);
    await validateReferences(input);
    // No network or sample work is awaited while the persistence lane is held.
    return exclusive(async () => {
      const versions = await readVersions(id) ?? [];
      if (versions.length !== (old?.revision ?? 0)) fail('material_conflict', 'Another author changed the entry; read it again.', 'material.changed_by_other');
      const now = new Date().toISOString();
      const entry: MaterialEntry = { ...input, schemaVersion: 1, id, revision: versions.length + 1, group: input.group ?? '', notes: input.notes ?? '', archived: old?.archived ?? false, createdAt: old?.createdAt ?? now, updatedAt: now };
      await writeVersions(id, [...versions, entry]);
      return { entry: await decorated(entry) };
    });
  };
  const listEntries = async () => (['tag', 'combo', 'note'] as const).flatMap(kind => repo.all(kind).map(item => item.payload as unknown as MaterialEntry)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const library = async (raw: unknown): Promise<any> => {
    const args = obj(raw);
    // Caller evidence is never authoritative, including a partial forged object.
    validateLibraryRequest('material_library', args.action === 'save' && args.entry?.tag ? { ...args, entry: { ...args.entry, tag: { ...args.entry.tag, evidence: undefined } } } : args);
    if (args.action === 'save') return save(args);
    if (args.action === 'read') { keys(args, ['action', 'id', 'revision']); return { entry: await decorated(await readEntry(idOf(args.id), args.revision)) }; }
    if (args.action === 'list') {
      keys(args, ['action', 'query', 'kind', 'group', 'includeArchived', 'offset', 'limit']);
      const query = str(args.query, 200, true).toLowerCase(), kind = args.kind === undefined ? undefined : choice(args.kind, ['tag', 'combo', 'note'] as const);
      if (args.includeArchived !== undefined && typeof args.includeArchived !== 'boolean') fail('invalid_argument', 'Invalid archive filter.', 'material.invalid_archive_filter');
      const group = args.group === undefined ? undefined : str(args.group, 100, true);
      const offset = int(args.offset, 0, 0, MAX_ENTRIES), limit = int(args.limit, 20, 1, 50);
      const result = repo.list({ kinds: kind ? [kind] : ['tag', 'combo', 'note'], query, group, includeArchived: args.includeArchived, offset, limit });
      return { ...result, items: await Promise.all(result.items.map(async item => summary(await decorated(item.payload as unknown as MaterialEntry)))) };
    }
    if (args.action === 'archive') {
      keys(args, ['action', 'id', 'expectedRevision', 'archived']);
      const id = idOf(args.id), version = revisionOf(args.expectedRevision), archived = args.archived ?? true;
      if (typeof archived !== 'boolean') fail('invalid_argument', 'Invalid archive state.', 'material.invalid_archive_state');
      return exclusive(async () => {
        const versions = await readVersions(id); const old = versions?.at(-1);
        if (!old) return fail('material_not_found', 'This entry does not exist.', 'material.entry_not_found');
        if (old.revision !== version) fail('material_conflict', 'The entry changed; read it again.', 'material.entry_changed');
        if (old.archived === archived) return { entry: await decorated(old) };
        const entry = { ...old, revision: old.revision + 1, archived, updatedAt: new Date().toISOString() };
        await writeVersions(id, [...versions!, entry]); return { entry: await decorated(entry) };
      });
    }
    if (args.action === 'export') {
      keys(args, ['action', 'ids']);
      if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.length > MAX_ENTRIES)) fail('invalid_argument', 'Invalid export ID list.', 'material.invalid_export_ids');
      const entries = args.ids === undefined ? await listEntries() : await Promise.all([...new Set<string>(args.ids.map(idOf))].map(id => readEntry(id)));
      const exportedCovers: NonNullable<MaterialBackup['covers']> = [];
      const warnings: Array<{ entryId: string; code: string }> = [];
      for (const entry of entries) {
        const state = await covers.state(entry);
        if (state.coverStatus === 'ready') {
          try { const saved = await covers.image(entry); exportedCovers.push({ entryId: entry.id, cover: saved.cover!, data: saved.data }); }
          catch (error: any) { warnings.push({ entryId: entry.id, code: error.code ?? 'cover_corrupt' }); }
        } else if (state.coverStatus === 'unavailable') warnings.push({ entryId: entry.id, code: 'cover_unavailable' });
      }
      const data: MaterialBackup = { schemaVersion: 1, entries, ...(exportedCovers.length ? { covers: exportedCovers } : {}) };
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_TOTAL) fail('material_storage_full', 'The backup with covers exceeds 64 MiB; export the entries in smaller batches.', 'material.backup_too_large');
      return { data, ...(warnings.length ? { warnings } : {}) };
    }
    if (args.action === 'import') {
      keys(args, ['action', 'data']); keys(args.data, ['schemaVersion', 'entries', 'covers']);
      if (args.data.schemaVersion !== 1 || !Array.isArray(args.data.entries) || args.data.entries.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(args.data)) > MAX_TOTAL) fail('invalid_argument', 'Invalid backup format or size.', 'material.invalid_backup');
      // Imports create new identities, preserving existing originals. Imported
      // lookup evidence is not trusted as a new official verification.
      const inputs = args.data.entries.map((rawEntry: unknown) => {
        const entry = obj(rawEntry);
        return entryInput({ kind: entry.kind, name: entry.name, group: entry.group, notes: entry.notes, ...(entry.tag ? { tag: entry.tag } : {}), ...(entry.components ? { components: entry.components.map((component: any) => { const { entryId: _id, entryRevision: _revision, ...value } = obj(component); return value; }) } : {}), ...(entry.links ? { links: entry.links } : {}) });
      });
      if (args.data.covers !== undefined && (!Array.isArray(args.data.covers) || args.data.covers.length > args.data.entries.length)) fail('invalid_argument', 'Invalid number of backup covers.', 'material.backup_cover_count');
      const importedCovers = new Map<string, NonNullable<MaterialBackup['covers']>[number]>();
      // Decode and check all optional cover assets before creating any copies.
      for (const rawCover of args.data.covers ?? []) {
        const cover = await covers.validateBackup(rawCover);
        if (importedCovers.has(cover.entryId)) fail('invalid_argument', 'A backup cover is repeated.', 'material.backup_cover_duplicate');
        const source = args.data.entries.find((entry: any) => entry.id === cover.entryId);
        if (!source || !covers.matches(source, cover.cover)) fail('cover_invalid_image', 'A backup cover does not match its tag.', 'material.backup_cover_mismatch');
        importedCovers.set(cover.entryId, cover);
      }
      if (entryCount() + inputs.length > MAX_ENTRIES) fail('material_storage_full', 'The import would exceed 1000 entries; the library is unchanged.', 'material.import_too_many');
      const items: MaterialSummary[] = [];
      const coverWarnings: Array<{ entryId: string; code: string; message: string }> = [];
      for (const [index, input] of inputs.entries()) {
        try {
          const { entry } = await save({ action: 'save', entry: input });
          const backup = importedCovers.get(args.data.entries[index].id);
          if (backup) {
            try {
              const cover = { ...backup.cover, verification: 'imported' as const, importedAt: new Date().toISOString() };
              // A failed online tag refresh during import remains unknown; the
              // explicit backup is provenance, never a fresh online verification.
              const current = await readEntry(entry.id);
              await exclusive(() => covers.set(current, 0, cover, Buffer.from(backup.data, 'base64')));
            } catch (error: any) { coverWarnings.push({ entryId: entry.id, code: error.code ?? 'cover_storage_failed', message: error.message }); }
          }
          items.push(summary(await decorated(await readEntry(entry.id))));
        }
        catch (error: any) { return { count: items.length, items, ...(coverWarnings.length ? { coverWarnings } : {}), error: { code: error.code ?? 'material_storage_failed', message: error.message, messageDetail: 'Imported entries are kept; do not import the whole backup again.' } }; }
      }
      return { count: items.length, items, ...(coverWarnings.length ? { coverWarnings } : {}) };
    }
    return fail('invalid_argument', 'Unknown material library action.', 'material.unknown_action');
  };
  const tags = async (raw: unknown): Promise<any> => {
    validateLibraryRequest('material_tags', raw);
    const args = obj(raw);
    if (args.action === 'details') {
      keys(args, ['action', 'name', 'names']);
      if ((args.name === undefined) === (args.names === undefined)) fail('invalid_argument', 'Give either name or names.', 'material.name_or_names');
      if (args.names !== undefined && (!Array.isArray(args.names) || args.names.length < 1 || args.names.length > 20)) fail('invalid_argument', 'A batch lookup needs 1–20 words.', 'material.names_size');
      const input = args.name === undefined ? { names: args.names.map(english) } : { name: english(args.name) };
      return metadataLane(() => bounded(() => options.tags.details({ ...input, detail: 'compact' })));
    }
    if (args.action === 'search') {
      keys(args, ['action', 'query', 'limit', 'category']);
      const query = str(args.query, 120), limit = int(args.limit, 8, 1, 20), category = args.category === undefined ? undefined : choice(args.category, ['artist'] as const);
      const result = await metadataLane(() => bounded(() => options.tags.search({ query, limit, ...(category ? { category } : {}) })));
      if (!Array.isArray(result?.items)) fail('invalid_response', 'Invalid tag candidate response.', 'material.invalid_tag_search');
      return { ...result, items: result.items.filter((item: any) => !category || item.category === 1).slice(0, limit) };
    }
    return fail('invalid_argument', 'Unknown tag action.', 'material.unknown_tag_action');
  };
  const sampleTag = async (args: any) => {
    const entry = await readEntry(idOf(args.entryId), args.revision);
    if (entry.kind !== 'tag' || entry.tag?.source !== 'danbooru' || !entry.tag.evidence?.canonicalName || !['canonical', 'alias'].includes(entry.tag.evidence.resolution)) return fail('material_unverified', 'Verify the Danbooru tag first to read its samples.', 'material.unverified');
    return { entry, tag: entry.tag };
  };
  const belongs = (item: DanbooruPost, tag: MaterialTag, minScore: number, rating: DanbooruRating) => item.rating === rating && Number.isSafeInteger(item.score) && item.score >= minScore &&
    (tag.category === 'artist' ? item.tags.artists : tag.category === 'character' ? item.tags.characters : tag.category === 'copyright' ? item.tags.copyrights : tag.category === 'meta' ? item.tags.meta : item.tags.general).includes(tag.text);
  const matchesSearchScope = (result: any, query: string, rating: DanbooruRating) => {
    if (result?.query !== query || result.rating !== rating || typeof result.effectiveQuery !== 'string') return false;
    const effective: string[] = result.effectiveQuery.split(/\s+/).filter(Boolean), requested = query.split(/\s+/).filter(Boolean);
    const ratingTokens = effective.filter(token => /^-?rating:/i.test(token));
    return ratingTokens.length === 1 && ratingTokens[0] === `rating:${rating}`
      && effective.filter(token => !/^-?rating:/i.test(token)).join(' ') === requested.filter(token => !/^-?rating:/i.test(token)).join(' ');
  };
  const samples = async (raw: unknown): Promise<any> => {
    validateLibraryRequest('material_samples', raw);
    const args = obj(raw);
    if (args.action === 'cover') { keys(args, ['action', 'entryId']); return covers.image(await readEntry(idOf(args.entryId))); }
    if (args.action === 'clear_cover') {
      keys(args, ['action', 'entryId', 'expectedCoverRevision']);
      const entryId = idOf(args.entryId), expected = int(args.expectedCoverRevision, -1, 0, Number.MAX_SAFE_INTEGER);
      return exclusive(async () => covers.set(await readEntry(entryId), expected, null));
    }
    if (args.action === 'set_local_cover') {
      keys(args, ['action', 'entryId', 'revision', 'expectedCoverRevision', 'fileName', 'data']);
      const entryId = idOf(args.entryId), entryRevision = revisionOf(args.revision), expected = int(args.expectedCoverRevision, -1, 0, Number.MAX_SAFE_INTEGER), fileName = localFileName(args.fileName);
      const entry = await readEntry(entryId);
      if (entry.revision !== entryRevision) fail('material_conflict', 'The tag changed; read it again before uploading a cover.', 'cover.tag_changed_upload');
      if (entry.kind !== 'tag' || !entry.tag || !SOURCE.includes(entry.tag.source)) fail('invalid_argument', 'Only a saved tag entry can take a local cover.', 'cover.tag_only');
      const tag = entry.tag!;
      if (await covers.coverRevision(entryId) !== expected) fail('cover_conflict', 'The cover changed; read it again before uploading.', 'cover.changed_upload');
      // Decoding is local CPU work outside both the persistence lane and all
      // network/sample lanes. It is attempted once and never touches generation.
      const normalized = await localDecodeLane(async () => {
        // A request can become obsolete while waiting behind another local
        // decode. Recheck inside the acquired slot before spending Sharp CPU.
        if ((await readEntry(entryId)).revision !== entryRevision) fail('material_conflict', 'The tag changed while waiting; the old cover is kept.', 'cover.tag_changed_waiting');
        if (await covers.coverRevision(entryId) !== expected) fail('cover_conflict', 'The cover changed while waiting; read it again.', 'cover.changed_waiting');
        return normalizeMaterialCover(args.data);
      });
      const { bytes, ...imageMetadata } = normalized;
      const prepared = { bytes, cover: { ...imageMetadata, source: 'local' as const, fileName, postId: null, sourceUrl: null, tagSource: tag.source, tagText: tag.text, tagCategory: tag.category, rating: null, savedAt: new Date().toISOString(), verification: 'local' as const, checkedAt: null } };
      return exclusive(async () => {
        const latest = await readEntry(entryId);
        if (latest.revision !== entryRevision || !covers.matches(latest, prepared.cover)) fail('material_conflict', 'The tag changed during decoding; the old cover is kept.', 'cover.tag_changed_decoding');
        if (await covers.coverRevision(entryId) !== expected) fail('cover_conflict', 'The cover changed during decoding; read it again.', 'cover.changed_decoding');
        return covers.set(latest, expected, prepared.cover, prepared.bytes);
      });
    }
    if (args.action === 'set_cover') {
      keys(args, ['action', 'entryId', 'revision', 'postId', 'expectedCoverRevision', 'minScore', 'rating']);
      const entryId = idOf(args.entryId), expected = int(args.expectedCoverRevision, -1, 0, Number.MAX_SAFE_INTEGER), entryRevision = revisionOf(args.revision);
      const { entry, tag } = await sampleTag({ entryId, revision: entryRevision });
      if ((await readEntry(entryId)).revision !== entryRevision) fail('material_conflict', 'The tag changed; read it again before saving a cover.', 'cover.tag_changed_save');
      if ((await covers.state(entry)).coverRevision !== expected) fail('cover_conflict', 'The cover changed; read it again before saving.', 'cover.changed_save');
      const postId = int(args.postId, 0, 1, Number.MAX_SAFE_INTEGER), minScore = int(args.minScore, 20, 0, Number.MAX_SAFE_INTEGER), rating = ratingOf(args.rating);
      const prepared = await sampleLane(() => bounded(async () => {
        const before = await options.gallery.detail({ postId, rating });
        if (!belongs(before, tag, minScore, rating)) fail('sample_filtered', 'The sample does not match the current rating, score or tag.', 'cover.sample_filtered');
        const image = await options.gallery.image({ postId, rating, variant: 'sample' });
        const after = await options.gallery.detail({ postId, rating });
        if (!belongs(after, tag, minScore, rating) || image.postId !== postId || image.variant !== 'sample' || image.sourceUrl !== after.sourceUrl || image.imageUrl !== after.sampleUrl || before.sampleUrl !== after.sampleUrl || before.rating !== after.rating) fail('sample_changed', 'The sample source or tag changed during the download; the old cover is kept.', 'cover.sample_changed');
        const normalized = await normalizeMaterialCover(image.data);
        const { bytes, sourceSha256: _sourceSha256, ...imageMetadata } = normalized;
        return { bytes, cover: { ...imageMetadata, source: 'danbooru' as const, postId, sourceUrl: after.sourceUrl, tagText: tag.text, tagCategory: tag.category, rating, savedAt: new Date().toISOString(), verification: 'online' as const, checkedAt: new Date().toISOString() } };
      }, 60000));
      return exclusive(async () => {
        const latest = await readEntry(entryId);
        if (latest.revision !== entryRevision || !covers.matches(latest, prepared.cover)) fail('material_conflict', 'The tag changed during the download; the old cover is kept.', 'cover.tag_changed_download');
        return covers.set(latest, expected, prepared.cover, prepared.bytes);
      });
    }
    if (args.action === 'list') {
      keys(args, ['action', 'entryId', 'revision', 'page', 'limit', 'minScore', 'rating']);
      const { entry, tag } = await sampleTag(args), page = int(args.page, 1, 1, 1000), limit = int(args.limit, 3, 1, 12), minScore = int(args.minScore, 20, 0, Number.MAX_SAFE_INTEGER), rating = ratingOf(args.rating);
      const query = `${tag.text} rating:${rating} score:>=${minScore} order:score`;
      const result = await sampleLane(() => bounded(() => options.gallery.search({ query, rating, page, limit })));
      if (!matchesSearchScope(result, query, rating)) fail('invalid_response', 'The sample search response does not match the rating or query.', 'material.sample_search_mismatch');
      const valid = result.items.filter(item => belongs(item, tag, minScore, rating));
      return { entryId: entry.id, entryRevision: entry.revision, page, limit, minScore, rating, hasMore: result.hasMore, filteredCount: result.filteredCount + result.items.length - valid.length,
        items: valid.map(({ tags: _tags, ...item }) => item) };
    }
    if (args.action === 'list_all') {
      keys(args, ['action', 'entryId', 'revision', 'page', 'limit', 'minScore', 'sort']);
      const { entry, tag } = await sampleTag(args), page = int(args.page, 1, 1, 30), limit = int(args.limit, 12, 1, 12), minScore = int(args.minScore, 20, 0, Number.MAX_SAFE_INTEGER), sort = choice(args.sort ?? 'score', SAMPLE_SORTS);
      const order = sampleOrder(sort);
      const results = await sampleLane(() => bounded(() => Promise.all(DANBOORU_RATINGS.map(async (rating) => {
        const query = `${tag.text} rating:${rating} score:>=${minScore} order:${order}`;
        const result = await options.gallery.search({ query, rating, page: 1, limit: 30 });
        if (!matchesSearchScope(result, query, rating)) fail('invalid_response', 'The sample search response does not match the rating or query.', 'material.sample_search_mismatch');
        const valid = result.items.filter(item => belongs(item, tag, minScore, rating));
        return { valid, filteredCount: result.filteredCount + result.items.length - valid.length };
      })), 32000));
      const unique = new Map<number, DanbooruPost>();
      for (const result of results) for (const item of result.valid) if (!unique.has(item.postId)) unique.set(item.postId, item);
      const merged = [...unique.values()].sort(compareSamples(sort)), start = (page - 1) * limit;
      return { entryId: entry.id, entryRevision: entry.revision, page, limit, minScore, rating: 'all', sort, hasMore: start + limit < merged.length,
        filteredCount: results.reduce((total, result) => total + result.filteredCount, 0), items: merged.slice(start, start + limit).map(({ tags: _tags, ...item }) => item) };
    }
    if (args.action === 'image') {
      keys(args, ['action', 'entryId', 'revision', 'postId', 'variant', 'minScore', 'rating']);
      const { tag } = await sampleTag(args), postId = int(args.postId, 0, 1, Number.MAX_SAFE_INTEGER), minScore = int(args.minScore, 20, 0, Number.MAX_SAFE_INTEGER), variant = choice(args.variant ?? 'preview', ['preview', 'sample'] as const), rating = ratingOf(args.rating);
      return sampleLane(() => bounded(async (): Promise<DanbooruImage & { rating: DanbooruRating }> => {
        const before = await options.gallery.detail({ postId, rating });
        if (!belongs(before, tag, minScore, rating)) fail('sample_filtered', 'The sample rating, score or tag changed; the image was not read.', 'material.sample_filtered');
        const image = await options.gallery.image({ postId, rating, variant });
        const after = await options.gallery.detail({ postId, rating });
        if (!belongs(after, tag, minScore, rating) || before.rating !== after.rating || image.postId !== postId || image.sourceUrl !== after.sourceUrl || image.imageUrl !== (variant === 'preview' ? after.previewUrl : after.sampleUrl) || (variant === 'preview' ? before.previewUrl !== after.previewUrl : before.sampleUrl !== after.sampleUrl)) fail('sample_changed', 'The sample source, rating or tag changed during the download; no image was returned.', 'material.sample_changed');
        return { ...image, rating };
      }, 32000));
    }
    return fail('invalid_argument', 'Unknown sample action.', 'material.unknown_sample_action');
  };
  return { library, tags, samples, readEntry, methods: { material_library: library, material_tags: tags, material_samples: samples } };
}
