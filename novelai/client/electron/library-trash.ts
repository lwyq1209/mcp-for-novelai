/**
 * Recently Deleted (step 3c, 2026-11-02): deleting library items and user collections into an app-managed trash,
 * restoring them, purging them, and purging them automatically after the retention period.
 *
 * Storage. The rows live in library.sqlite (repository.ts: trash_entries, trash_versions, trash_files); the files an
 * entry moved live in <data root>/trash/<trashId>/. Nothing here goes to the system trash.
 *
 * Deleting is allowed even when something references the item: the references are listed, never a reason to refuse.
 * A deletion commits first (rows out of the live tables, the entry in, the journal of planned moves) and then moves
 * files; a crash in between is finished by recover(). A file is moved only when no other live item and no other entry
 * uses it, and only from the managed folders (the data root and the output folder); otherwise it stays in place and
 * the entry names it. A restore moves its files back first and commits afterwards (a crash in between moves them back
 * into the trash); a purge commits first and then deletes what nothing else uses (a crash in between is finished).
 * Every file step is journaled through the library's file_operations, so a restart neither orphans nor wrongly deletes.
 *
 * Retention. An entry expires retentionMs after max(wall clock at deletion, highest clock Recently Deleted has seen):
 * a clock set back only delays a purge. A clock set forward cannot be told apart from elapsed time locally.
 */
import fs from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { libraryPathKey, type LibraryRepository } from './library/repository';
import type { LibraryItem, LibraryKind, LibraryPayload, PendingFileOperation, TrashEntry, TrashFile, TrashFileState } from './library/types';
import { hostError, type HostErrorParams } from './host-error';

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TRASH_RETENTION_DAYS = 30;
/** While a deletion moves many files, who uses them is checked again after this long. */
const OWNER_RECHECK_MS = 2000;
/** How often a running client looks for expired entries (besides once at startup). */
export const TRASH_PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const TRASH_BATCH_LIMIT = 500;
/** Each impact list of a receipt names at most this many; `truncated` names the lists that had more. */
export const TRASH_IMPACT_LIST_LIMIT = 20;
/** A delete, restore or purge receipt lists entries (those with effects first) up to about this many bytes of JSON; the rest are counted. */
export const TRASH_RECEIPT_BYTES = 24 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

/**
 * Who deleted an entry (step 4a): the user in this window, or an agent through the bridge (client: its MCP initialize
 * clientInfo name and version, null when it sent none). Kept in the entry summary as deletedBy; an entry deleted
 * before this field (or by a caller that does not say) has none.
 */
export type TrashActor = { kind: 'user' } | { kind: 'agent'; client: { name: string; version: string | null } | null };
const actorSummary = (actor: TrashActor | undefined) => actor ? { deletedBy: actor.kind === 'user' ? { kind: 'user' as const } : { kind: 'agent' as const, client: actor.client ? { name: actor.client.name, version: actor.client.version } : null } } : {};
export interface RecipeSourceReference { recipeId: string; recipeRevision: number; sourceRevision: number }
/** Recipes whose library-reference source names one of these items (any revision), keyed `${kind}:${id}`. */
export type RecipeReferenceScan = (targets: Array<{ kind: 'history' | 'study'; id: string }>) => Promise<Map<string, RecipeSourceReference[]>>;

export interface LibraryTrashOptions {
  repository: LibraryRepository;
  /** The data root: the trash folder is <userDataRoot>/trash, and files under the data root are managed. */
  userDataRoot: string;
  libraryDirectory: string;
  /** Further folders whose files a deletion may move and a purge may delete: the current output folder. */
  managedRoots?: () => Array<string | null | undefined>;
  /** Restored files that had to move to a free name get this URL in their item. */
  toFileUrl?: (file: string) => string;
  recipeReferences?: RecipeReferenceScan;
  now?: () => number;
  retentionMs?: number;
  /** Tests only: the rename used for moves (an EXDEV failure takes the copy path). */
  rename?: (from: string, to: string) => Promise<void>;
  /** Tests only: called between a commit and its file work (delete-files, purge-files) or between moved files and the commit (restore-commit); a throw or a never-settling promise stands for a crash there. */
  interrupt?: (phase: 'delete-files' | 'purge-files' | 'restore-commit') => void | Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

/** reason/params: the window's catalog message (src/host-errors/library.ts); the message is English. */
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw hostError(code, message, reason, params); };
const iso = (ms: number) => new Date(ms).toISOString();
const PAYLOAD_PATH_ROLE = /^(?:original|favorite-image|image:\d+|preview:\d+)$/;
const KEPT: readonly TrashFileState[] = ['kept-shared', 'kept-outside', 'kept-unsafe', 'kept-failed'];
const IN_PLACE_PURGEABLE: readonly TrashFileState[] = ['kept-shared', 'kept-failed', 'retained'];

type Selection = { kind: LibraryKind; id: string; expectedRevision: number };
type Candidate = { path: string; role: string; current: boolean };
type Fact = { exists: boolean; regular: boolean; managed: boolean; size: number | null; realDirectory: string | null };
type Impacts = {
  collections: Array<{ collectionId: string; name: string }>;
  coversCleared: Array<{ kind: 'tag'; id: string; name: string; coverRevision?: number }>;
  recipes: Array<RecipeSourceReference>;
  referencedBy: Array<{ kind: LibraryKind; id: string; name: string; role: string }>;
  sharedFiles: Array<{ role: string; usedBy: string[] }>;
  recipesUnknown?: boolean;
};

async function lstatOrNull(file: string) { try { return await fs.lstat(file); } catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; } }
async function digestFile(file: string) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const hash = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer); return hash.digest('hex'); }
  finally { await handle.close(); }
}
async function sameFile(a: string, b: string) {
  const [left, right] = [await lstatOrNull(a), await lstatOrNull(b)];
  return !!left && !!right && left.isFile() && right.isFile() && left.size === right.size && await digestFile(a) === await digestFile(b);
}
async function syncFile(file: string) { const handle = await fs.open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }

/** The cover file name set_cover_from_history gives a tag cover made from one history original (novelai/src/history-cover.mjs). */
export function historyCoverNamePattern(historyId: string) {
  const name = /^[A-Za-z0-9._-]{1,120}$/.test(historyId) && !/^\.+$/.test(historyId) ? historyId : `h-${createHash('sha256').update(historyId).digest('hex').slice(0, 24)}`;
  return new RegExp(`^history-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-r\\d+\\.(?:png|jpg|webp|gif)$`);
}

export function createLibraryTrash(options: LibraryTrashOptions) {
  const repo = options.repository;
  const dataRoot = path.resolve(options.userDataRoot), libraryDirectory = path.resolve(options.libraryDirectory);
  const trashRoot = path.join(dataRoot, 'trash');
  const now = () => options.now?.() ?? Date.now();
  const retention = options.retentionMs ?? TRASH_RETENTION_MS;
  const rename = options.rename ?? ((from: string, to: string) => fs.rename(from, to));
  const log = options.log ?? ((message: string, error?: unknown) => console.warn(`[trash] ${message}`, error ?? ''));
  let lane: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => { const next = lane.then(run, run); lane = next.catch(() => undefined); return next; };
  let timer: ReturnType<typeof setInterval> | undefined;

  // ---------------------------------------------------------------- folders
  const managedRootKeys = async () => {
    const keys: string[] = [];
    for (const root of [dataRoot, ...(options.managedRoots?.() ?? [])]) {
      if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root)) continue;
      try { keys.push(libraryPathKey(await fs.realpath(root))); } catch { /* a missing folder manages nothing */ }
    }
    return [...new Set(keys)];
  };
  const within = (key: string, root: string) => key.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  /** The resolved key of the trash folder; never creates it, so a preview leaves no trace. */
  const trashRootKey = async () => libraryPathKey(await realFolderOf(path.join(trashRoot, 'entry')) ?? trashRoot);
  async function ensureTrashRoot() {
    await fs.mkdir(trashRoot, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(trashRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('library_storage_failed', 'The Recently Deleted folder is not a plain folder.', 'trash.folder_invalid');
  }
  const entryFolder = (trashId: string) => { if (!UUID.test(trashId)) fail('invalid_argument', 'Invalid Recently Deleted id.', 'trash.invalid_id'); return path.join(trashRoot, trashId); };
  const trashFileName = (ordinal: number, file: string) => `${ordinal}-${path.basename(file).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'}`;
  async function fact(file: string, roots: string[], trashKey: string): Promise<Fact> {
    const stat = await lstatOrNull(file);
    if (!stat) return { exists: false, regular: false, managed: false, size: null, realDirectory: null };
    if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, regular: false, managed: false, size: null, realDirectory: null };
    let real: string; try { real = await fs.realpath(file); } catch { return { exists: true, regular: false, managed: false, size: null, realDirectory: null }; }
    const key = libraryPathKey(real), managed = !(key === trashKey || within(key, trashKey)) && roots.some(root => within(key, root));
    return { exists: true, regular: true, managed, size: stat.size, realDirectory: path.dirname(real) };
  }
  /**
   * The resolved folder a path's folder is (or would be, once its missing folders are made again): the nearest existing
   * ancestor resolved, plus the rest. Null when that ancestor is not a plain folder.
   */
  async function realFolderOf(file: string) {
    let folder = path.dirname(path.resolve(file)), rest = '';
    for (;;) {
      const stat = await lstatOrNull(folder);
      if (stat) return stat.isDirectory() && !stat.isSymbolicLink() ? path.join(await fs.realpath(folder), rest) : null;
      const parent = path.dirname(folder); if (parent === folder) return null;
      rest = path.join(path.basename(folder), rest); folder = parent;
    }
  }
  /** A file stays the one a deletion judged managed while its folder is still the same resolved folder (also after the output folder setting changed). */
  const sameFolder = (now: string | null, recorded: string | null) => !!now && !!recorded && libraryPathKey(now) === libraryPathKey(recorded);

  // ---------------------------------------------------------------- file moves
  /** Moves one file (rename, or on another volume copy, verify and remove the original). */
  async function moveFile(from: string, to: string, partialSuffix: string): Promise<'moved' | 'missing'> {
    await fs.mkdir(path.dirname(to), { recursive: true, ...(within(libraryPathKey(to), libraryPathKey(dataRoot)) ? { mode: 0o700 } : {}) });
    if (await lstatOrNull(to)) fail('library_conflict', 'The destination of a file move is taken.', 'trash.move_destination_taken');
    try { await rename(from, to); return 'moved'; }
    catch (error: any) { if (error.code === 'ENOENT') return 'missing'; if (error.code !== 'EXDEV') throw error; }
    const partial = `${to}${partialSuffix}`;
    await fs.rm(partial, { force: true });
    try {
      await fs.copyFile(from, partial, constants.COPYFILE_EXCL); await syncFile(partial);
      if (!await sameFile(from, partial)) fail('library_storage_failed', 'A copied file does not match its original.', 'trash.copy_mismatch');
      await fs.rename(partial, to);
    } catch (error) { await fs.rm(partial, { force: true }).catch(() => undefined); throw error; }
    await fs.unlink(from);
    return 'moved';
  }
  /** Resolves one journaled move after an interruption: finishes it, or reports the file stayed or is gone. */
  async function settleMove(from: string, to: string, partialSuffix: string): Promise<'moved' | 'kept' | 'missing'> {
    await fs.rm(`${to}${partialSuffix}`, { force: true });
    const [source, target] = [await lstatOrNull(from), await lstatOrNull(to)];
    if (target && source) {
      if (await sameFile(from, to)) { await fs.unlink(from); return 'moved'; }
      await fs.rm(to, { force: true }); return 'kept';
    }
    if (target) return 'moved';
    if (!source) return 'missing';
    try { return await moveFile(from, to, partialSuffix) === 'moved' ? 'moved' : 'missing'; }
    catch (error) { log('a file move could not be finished; the file stays in place', error); return 'kept'; }
  }
  /** Undoes one planned move because something uses the file again: it ends (or stays) at its original path. */
  async function keepInPlace(from: string, to: string, partialSuffix: string): Promise<'kept' | 'moved' | 'missing'> {
    await fs.rm(`${to}${partialSuffix}`, { force: true });
    const [source, target] = [await lstatOrNull(from), await lstatOrNull(to)];
    if (source && target) { await fs.rm(to, { force: true }); return 'kept'; }
    if (source) return 'kept';
    if (!target) return 'missing';
    try { await moveFile(to, from, partialSuffix); return 'kept'; }
    catch (error) { log('a file something uses again could not go back to its place; it stays in Recently Deleted', error); return 'moved'; }
  }
  /** A study's folder or a preset's preview folder, which an item owns and which goes once it is empty. */
  const ownFolder = (folder: string) => [path.join(libraryDirectory, 'studies'), path.join(dataRoot, 'style-prompt-previews')].some(parent => libraryPathKey(path.dirname(folder)) === libraryPathKey(parent));
  async function removeEmptyFolder(folder: string) { try { await fs.rmdir(folder); } catch { /* not empty or already gone */ } }
  async function removeEntryFolder(trashId: string) {
    const folder = entryFolder(trashId), stat = await lstatOrNull(folder);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) { log(`unexpected entry at ${folder}; left in place`); return; }
    if (stat) await fs.rm(folder, { recursive: true, force: true });
  }
  function journal(action: PendingFileOperation['action'], payload: LibraryPayload) {
    const id = randomUUID();
    repo.putFileOperation({ id, action, state: 'pending', payload: { scope: 'trash', ...payload }, createdAt: new Date().toISOString() });
    return id;
  }

  // ---------------------------------------------------------------- what an item owns and what uses it
  async function candidatesFor(item: LibraryItem): Promise<Candidate[]> {
    const found = new Map<string, Candidate>();
    const add = (file: unknown, role: string, current: boolean) => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) return;
      const key = libraryPathKey(file), old = found.get(key);
      if (!old) found.set(key, { path: file, role, current }); else if (current && !old.current) found.set(key, { path: file, role, current });
    };
    // Earlier versions count for kinds whose files live in their own folders (presets keep earlier previews); a history
    // image or favorite names the output-folder file of its current version only (an old name may hold another file now).
    const earlier = !['history', 'artist_favorite'].includes(item.kind);
    for (const version of repo.readVersions(item.kind, item.id)) if (earlier || version.revision === item.revision) for (const asset of repo.versionAssets(version)) add(asset.payload.filePath, asset.role, version.revision === item.revision);
    for (const asset of repo.itemAssets(item.kind, item.id)) add(asset.payload.filePath, asset.role, true);
    const folderFiles = async (folder: string, prefix: string) => {
      const stat = await lstatOrNull(folder); if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) if (entry.isFile()) add(path.join(folder, entry.name), `${prefix}:${entry.name}`, true);
    };
    if (item.kind === 'study' && UUID.test(item.id)) await folderFiles(path.join(libraryDirectory, 'studies', item.id), 'study-folder');
    if (item.kind === 'style_preset' || item.kind === 'positive_preset') {
      const previews = libraryPathKey(path.join(dataRoot, 'style-prompt-previews'));
      const folders = new Set([...found.values()].filter(value => value.role.startsWith('preview:')).map(value => path.dirname(path.resolve(value.path))).filter(folder => libraryPathKey(path.dirname(folder)) === previews));
      for (const folder of folders) await folderFiles(folder, 'preview-folder');
    }
    return [...found.values()];
  }
  const liveName = (kind: LibraryKind, id: string) => repo.get(kind, id)?.name ?? id;
  const collectionName = (namespace: string, id: string) => repo.collections(namespace).find(value => value.id === id)?.name ?? id;
  const ownerLabel = (owner: string) => owner.startsWith('trash:') ? `recently-deleted:${owner.slice(6)}` : owner.slice(5);
  function impactsFor(item: LibraryItem, batch: Set<string>, recipes: Map<string, RecipeSourceReference[]> | null, covers: ReturnType<LibraryRepository['allCovers']>): Impacts {
    const own = `${item.kind}:${item.id}`;
    const collections = repo.memberships(item.kind, item.id).map(value => ({ collectionId: `${value.namespace}:${value.collectionId}`, name: collectionName(value.namespace, value.collectionId) }));
    const referencedBy = new Map<string, Impacts['referencedBy'][number]>();
    for (const relation of repo.relations({ targetKind: item.kind, targetId: item.id })) {
      const key = `${relation.kind}:${relation.id}`, source = repo.get(relation.kind, relation.id);
      if (key === own || batch.has(key) || !source || source.revision !== relation.revision || referencedBy.has(key)) continue;
      referencedBy.set(key, { kind: relation.kind, id: relation.id, name: source.name, role: String(relation.payload.role ?? (relation.payload.studyId ? 'link' : 'reference')) });
    }
    const coversCleared: Impacts['coversCleared'] = [];
    if (item.kind === 'history') {
      const pattern = historyCoverNamePattern(item.id);
      for (const cover of covers) if (cover.kind === 'tag' && !batch.has(`tag:${cover.id}`) && typeof cover.cover?.fileName === 'string' && pattern.test(cover.cover.fileName)) coversCleared.push({ kind: 'tag', id: cover.id, name: liveName('tag', cover.id) });
    }
    return { collections, coversCleared, recipes: recipes?.get(own) ?? [], referencedBy: [...referencedBy.values()], sharedFiles: [], ...(recipes || !['history', 'study'].includes(item.kind) ? {} : { recipesUnknown: true }) };
  }
  function capped(impacts: Impacts) {
    const truncated: string[] = [], out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(impacts)) {
      if (!Array.isArray(value)) { out[key] = value; continue; }
      if (value.length > TRASH_IMPACT_LIST_LIMIT) truncated.push(key);
      out[key] = value.slice(0, TRASH_IMPACT_LIST_LIMIT);
    }
    return { ...out, ...(truncated.length ? { truncated, counts: Object.fromEntries(truncated.map(key => [key, (impacts as any)[key].length])) } : {}) };
  }
  const impactCounts = (impacts: Impacts) => ({ collections: impacts.collections.length, coversCleared: impacts.coversCleared.length, recipes: impacts.recipes.length, referencedBy: impacts.referencedBy.length, sharedFiles: impacts.sharedFiles.length, ...(impacts.recipesUnknown ? { recipesUnknown: true } : {}) });
  const fileCounts = (files: Array<{ state: TrashFileState }>) => ({ moved: files.filter(file => file.state === 'moved' || file.state === 'planned').length, kept: files.filter(file => KEPT.includes(file.state)).length, missing: files.filter(file => file.state === 'missing').length });
  /**
   * Sizes of the files that move into Recently Deleted (step 4b1, for the window's "moves N files (X MB)"): moved is the
   * sum of the known byte lengths of the moved or planned files; unknownSize counts those of them whose size is not known
   * (they are not in moved). Files left in place are not counted. Entries deleted before this field have no bytes.
   */
  const byteCounts = (files: Array<{ state: TrashFileState; byteLength: number | null }>) => {
    const moving = files.filter(file => file.state === 'moved' || file.state === 'planned');
    const known = moving.filter(file => Number.isSafeInteger(file.byteLength) && (file.byteLength as number) >= 0);
    return { moved: known.reduce((total, file) => total + (file.byteLength as number), 0), unknownSize: moving.length - known.length };
  };

  async function scanRecipes(items: LibraryItem[]) {
    const targets = items.filter(item => item.kind === 'history' || item.kind === 'study').map(item => ({ kind: item.kind as 'history' | 'study', id: item.id }));
    if (!targets.length) return new Map<string, RecipeSourceReference[]>();
    if (!options.recipeReferences) return null;
    try { return await options.recipeReferences(targets); } catch (error) { log('recipe sources could not be scanned', error); return null; }
  }

  // ---------------------------------------------------------------- delete
  type Plan = { item: LibraryItem; selection: Selection; trashId: string; files: TrashFile[]; impacts: Impacts };
  async function plan(selections: Selection[]) {
    if (!Array.isArray(selections) || !selections.length || selections.length > TRASH_BATCH_LIMIT) fail('invalid_argument', `Select 1–${TRASH_BATCH_LIMIT} items.`, 'trash.selection_size', { max: TRASH_BATCH_LIMIT });
    const seen = new Set<string>(), items: LibraryItem[] = [];
    for (const selection of selections) {
      const key = `${selection.kind}:${selection.id}`;
      if (seen.has(key)) fail('invalid_argument', 'The selection names an item twice.', 'trash.selection_duplicate'); seen.add(key);
      const item = repo.get(selection.kind, selection.id);
      if (!item) (repo.trashEntryFor(selection.kind, selection.id) ? fail('library_not_found', `${key} is already in Recently Deleted.`, 'trash.item_already_deleted', { item: key }) : fail('library_not_found', `${key} does not exist.`, 'trash.item_not_found', { item: key }));
      if (item!.revision !== selection.expectedRevision) fail('library_conflict', `${key} changed (current revision ${item!.revision}); read it again.`, 'trash.item_changed', { item: key, revision: item!.revision });
      items.push(item!);
    }
    const [roots, trashKey, recipes] = [await managedRootKeys(), await trashRootKey(), await scanRecipes(items)];
    const candidates = new Map<string, Array<Candidate & Fact>>();
    for (const item of items) {
      const list: Array<Candidate & Fact> = [];
      for (const candidate of await candidatesFor(item)) {
        const facts = await fact(candidate.path, roots, trashKey);
        // An earlier version's file that is gone is no file of this item.
        if (!facts.exists && !candidate.current) continue;
        list.push({ ...candidate, ...facts });
      }
      candidates.set(`${item.kind}:${item.id}`, list);
    }
    return { items, roots, recipes, candidates };
  }
  /** Classifies files and impacts against the library as it is now (call inside the transaction that acts on it). */
  function classify(prepared: Awaited<ReturnType<typeof plan>>, selections: Selection[]): Plan[] {
    const batch = new Set(prepared.items.map(item => `${item.kind}:${item.id}`));
    const all = [...prepared.candidates.values()].flat().filter(value => value.exists && value.regular).map(value => value.path);
    const owners = repo.fileOwners([...new Set(all)]);
    const covers = prepared.items.some(item => item.kind === 'history') ? repo.allCovers() : [];
    return prepared.items.map((item, index) => {
      const trashId = randomUUID(), own = `item:${item.kind}:${item.id}`, impacts = impactsFor(item, batch, prepared.recipes, covers);
      const files: TrashFile[] = prepared.candidates.get(`${item.kind}:${item.id}`)!.map((candidate, ordinal) => {
        const base = { trashId, ordinal, role: candidate.role, path: candidate.path, trashPath: null as string | null, byteLength: candidate.size, realDirectory: candidate.managed ? candidate.realDirectory : null, sha256: null };
        if (!candidate.exists) return { ...base, state: 'missing' as const };
        if (!candidate.regular) return { ...base, state: 'kept-unsafe' as const };
        if (!candidate.managed) return { ...base, state: 'kept-outside' as const };
        const others = [...owners.get(candidate.path) ?? []].filter(owner => owner !== own);
        if (others.length) { impacts.sharedFiles.push({ role: candidate.role, usedBy: others.slice(0, 5).map(ownerLabel) }); return { ...base, state: 'kept-shared' as const }; }
        return { ...base, state: 'planned' as const, trashPath: path.join(entryFolder(trashId), trashFileName(ordinal, candidate.path)) };
      });
      return { item, selection: selections[index], trashId, files, impacts };
    });
  }
  function itemReceipt(plan: Plan, extra: Record<string, unknown> = {}) {
    return { kind: plan.item.kind, id: plan.item.id, revision: plan.item.revision, name: plan.item.name, archived: plan.item.archived, ...extra, files: fileCounts(plan.files), bytes: byteCounts(plan.files), impacts: capped(plan.impacts) };
  }
  /**
   * A receipt lists rows within TRASH_RECEIPT_BYTES of JSON, rows with effects (impacts, kept or changed files,
   * relocations) first, in their order otherwise; the rest are only counted (and named by trashId where they have one,
   * within the same budget), and recently-deleted lists every entry.
   */
  function bounded<K extends string>(key: K, rows: Array<Record<string, any>>): Record<K, Array<Record<string, any>>> & Record<string, unknown> {
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    if (size(rows) <= TRASH_RECEIPT_BYTES) return { [key]: rows } as any;
    const notable = (row: Record<string, any>) => {
      const impacts = row.impacts ?? {}, files = row.files ?? {};
      // recipesUnknown (the recipe store could not be read) holds for every row alike and does not single one out.
      return Object.values(impacts).some(value => Array.isArray(value) && value.length > 0) || files.kept > 0 || files.changed > 0 || files.relocated > 0 || files.missing > 0 || row.state === 'moving' || !!row.covers?.notRestored?.length;
    };
    const ordered = [...rows.filter(notable), ...rows.filter(row => !notable(row))];
    const listed: Array<Record<string, any>> = [];
    let used = 2;
    for (const row of ordered) { const bytes = size(row) + 1; if (used + bytes > TRASH_RECEIPT_BYTES) break; listed.push(row); used += bytes; }
    const rest = ordered.slice(listed.length), trashIds: string[] = [];
    for (const row of rest) { if (typeof row.trashId !== 'string') continue; if (used + 40 > TRASH_RECEIPT_BYTES + 20 * 1024) break; trashIds.push(row.trashId); used += 40; }
    const sum = (pick: (row: Record<string, any>) => Record<string, any> | undefined) => {
      const total: Record<string, number> = {};
      for (const row of rows) for (const [name, value] of Object.entries(pick(row) ?? {})) total[name] = (total[name] ?? 0) + (Array.isArray(value) ? value.length : typeof value === 'number' ? value : 0);
      return total;
    };
    return { [key]: listed, omitted: { count: rest.length, ...(trashIds.length ? { trashIds } : {}), note: `${rest.length} more entries are not listed here (entries with effects come first); read them with recently-deleted.` },
      totals: { entries: rows.length, files: sum(row => row.files), ...(rows.some(row => row.bytes) ? { bytes: sum(row => row.bytes) } : {}), ...(rows.some(row => row.impacts) ? { impacts: sum(row => row.impacts && Object.fromEntries(Object.entries(row.impacts).filter(([name]) => !['truncated', 'counts', 'recipesUnknown'].includes(name)))) } : {}) } } as any;
  }
  const RECEIPT_NOTE = `Deleted items are in Recently Deleted for ${TRASH_RETENTION_DAYS} days, then purged automatically; restore them with their trashId. Recipes whose source was deleted fail at enqueue until it is restored; batches already queued keep their own copy.`;
  async function deleteNow(selections: Selection[], preview: boolean, actor?: TrashActor) {
    const prepared = await plan(selections);
    if (preview) {
      const plans = repo.readTransaction(() => classify(prepared, selections));
      return { preview: true, ...bounded('deleted', plans.map(value => itemReceipt(value))), revision: repo.getRevision(), note: 'Nothing was changed. delete without preview moves these items to Recently Deleted with these effects.' };
    }
    await ensureTrashRoot();
    const deletedMs = now();
    const { plans, moveJournal } = repo.transaction(() => {
      const plans = classify(prepared, selections);
      const expiresMs = Math.max(deletedMs, repo.trashClock()) + retention;
      repo.advanceTrashClock(deletedMs);
      for (const value of plans) {
        // A tag cover made from a deleted history image is cleared; the entry keeps it (and its file) for a restore.
        for (const cleared of value.impacts.coversCleared) {
          const before = repo.getCover('tag', cleared.id);
          if (!before.cover) continue;
          const after = repo.setCover('tag', cleared.id, null, { expectedRevision: before.coverRevision });
          cleared.coverRevision = after.coverRevision;
          (value as any).clearedCovers = [...((value as any).clearedCovers ?? []), { id: cleared.id, previousCoverRevision: before.coverRevision, clearedCoverRevision: after.coverRevision, cover: before.cover }];
          if (typeof before.cover.sha256 === 'string' && /^[a-f0-9]{64}$/.test(before.cover.sha256)) value.files.push({ trashId: value.trashId, ordinal: value.files.length, role: `cleared-cover:${cleared.id}`, path: path.join(libraryDirectory, 'covers', `${before.cover.sha256}.webp`), trashPath: null, state: 'retained', byteLength: null, realDirectory: null, sha256: before.cover.sha256 });
        }
        const moving = value.files.some(file => file.state === 'planned');
        repo.trashItem(value.item.kind, value.item.id, value.selection.expectedRevision, {
          trashId: value.trashId, name: value.item.name, deletedMs, expiresMs, state: moving ? 'moving' : 'trashed',
          summary: { archived: value.item.archived, files: fileCounts(value.files), bytes: byteCounts(value.files), impacts: impactCounts(value.impacts), ...actorSummary(actor) },
          data: { impacts: value.impacts, clearedCovers: (value as any).clearedCovers ?? [] },
        }, value.files);
      }
      const moving = plans.filter(value => value.files.some(file => file.state === 'planned')).map(value => value.trashId);
      return { plans, moveJournal: moving.length ? journal('trash-move', { trashIds: moving }) : null };
    });
    // The deletion has committed: what follows never makes it look undone. An entry whose files could not be settled
    // stays "moving" and is finished at the next start, or by a restore or purge of it.
    try {
      if (moveJournal) { await options.interrupt?.('delete-files'); await finishMoves(moveJournal); }
      await recordDigests(plans.filter(value => !value.files.some(file => file.state === 'planned')).map(value => value.trashId));
    } catch (error) { log('the files of a committed deletion are not settled yet; they are finished later', error); }
    const receipts = plans.map(value => {
      const entry = repo.trashEntry(value.trashId);
      const files = repo.trashFiles(value.trashId);
      return itemReceipt({ ...value, files }, { trashId: value.trashId, deletedAt: iso(entry?.deletedMs ?? deletedMs), expiresAt: iso(entry?.expiresMs ?? deletedMs + retention), ...(entry?.state === 'moving' ? { state: 'moving' } : {}) });
    });
    return { preview: false, ...bounded('deleted', receipts), revision: repo.getRevision(), note: RECEIPT_NOTE };
  }
  /**
   * Moves the planned files of the entries one trash-move journal names, then settles them (also used by recovery and
   * by a restore or purge of an entry still moving). Who uses each file is checked again right before it moves: a file
   * something started using since the deletion stays (or goes back) in place.
   */
  async function finishMoves(operationId: string, recovering = false) {
    const operation = repo.pendingFileOps().find(value => value.id === operationId);
    if (!operation) return;
    const ids: string[] = Array.isArray(operation.payload.trashIds) ? operation.payload.trashIds : [];
    const planned = ids.flatMap(trashId => repo.trashEntry(trashId) ? repo.trashFiles(trashId).filter(file => file.state === 'planned' && file.trashPath) : []);
    // Checked once up front and again whenever a long batch (another volume, many files) has run for a while.
    let owners = repo.fileOwners([...new Set(planned.map(file => file.path))]), checkedAt = Date.now(), done = 0;
    const ownersNow = () => {
      if (Date.now() - checkedAt > OWNER_RECHECK_MS) { owners = repo.fileOwners([...new Set(planned.slice(done).map(file => file.path))]); checkedAt = Date.now(); }
      return owners;
    };
    const entries: TrashEntry[] = [], updates: Array<{ trashId: string; ordinal: number; state: TrashFileState; clear: boolean }> = [];
    for (const trashId of ids) {
      const entry = repo.trashEntry(trashId); if (!entry) continue;
      entries.push(entry);
      const folders = new Set<string>();
      for (const file of planned.filter(value => value.trashId === trashId)) {
        const usedElsewhere = [...ownersNow().get(file.path) ?? []].some(owner => owner !== `trash:${trashId}`);
        done++;
        let outcome: 'moved' | 'kept' | 'missing';
        if (usedElsewhere) outcome = await keepInPlace(file.path, file.trashPath!, '.partial');
        else if (recovering) outcome = await settleMove(file.path, file.trashPath!, '.partial');
        else {
          try { outcome = await moveFile(file.path, file.trashPath!, '.partial'); }
          catch (error) { log('a file could not be moved to Recently Deleted; it stays in place', error); outcome = 'kept'; }
        }
        updates.push({ trashId, ordinal: file.ordinal, state: outcome === 'moved' ? 'moved' : outcome === 'missing' ? 'missing' : usedElsewhere ? 'kept-shared' : 'kept-failed', clear: outcome !== 'moved' });
        if (outcome === 'moved' && ownFolder(path.dirname(file.path))) folders.add(path.dirname(file.path));
      }
      for (const folder of folders) await removeEmptyFolder(folder);
    }
    // One commit settles every file of the journal; a crash before it is settled again from the file system.
    repo.transaction(() => {
      for (const update of updates) repo.setTrashFile(update.trashId, update.ordinal, update.clear ? { state: update.state, trashPath: null } : { state: update.state });
      for (const entry of entries) repo.updateTrashEntry(entry.trashId, { state: 'trashed', summary: { ...entry.summary, files: fileCounts(repo.trashFiles(entry.trashId)), bytes: byteCounts(repo.trashFiles(entry.trashId)) } });
      repo.completeFileOperation(operationId);
    });
    await recordDigests(entries.map(entry => entry.trashId));
  }
  /**
   * Records the size and digest of every file an entry left in place, so a purge can tell whether it is still that
   * file. Best effort after the commit: a file without a digest is purged only while its recorded size matches.
   */
  async function recordDigests(trashIds: string[]) {
    const found: Array<{ trashId: string; ordinal: number; byteLength: number; sha256: string }> = [];
    for (const trashId of trashIds) for (const file of repo.trashFiles(trashId)) {
      if (!['kept-shared', 'kept-failed'].includes(file.state) || file.sha256) continue;
      try {
        const stat = await lstatOrNull(file.path);
        if (!stat?.isFile() || stat.isSymbolicLink()) continue;
        found.push({ trashId, ordinal: file.ordinal, byteLength: stat.size, sha256: await digestFile(file.path) });
      } catch (error) { log('a file left in place could not be read for its digest', error); }
    }
    if (found.length) repo.transaction(() => { for (const value of found) repo.setTrashFile(value.trashId, value.ordinal, { byteLength: value.byteLength, sha256: value.sha256 }); });
  }
  /**
   * Whether an in-place file is still the one some of these Recently Deleted rows describe: its digest matches one
   * recorded for it, or (where no digest was recorded) its size does. A file that cannot be told apart is kept.
   */
  async function stillRecorded(file: string, records: Array<{ byteLength: number | null; sha256: string | null }>) {
    const stat = await lstatOrNull(file);
    if (!stat?.isFile() || stat.isSymbolicLink()) return false;
    let digest: string | undefined;
    for (const record of records) {
      if (record.sha256) { digest ??= await digestFile(file); if (digest === record.sha256) return true; }
      else if (record.byteLength !== null && record.byteLength === stat.size) return true;
    }
    return false;
  }
  async function deleteCollectionNow(collectionId: string, preview: boolean, actor?: TrashActor) {
    const separator = typeof collectionId === 'string' ? collectionId.indexOf(':') : -1;
    const namespace = separator > 0 ? collectionId.slice(0, separator) : '', id = separator > 0 ? collectionId.slice(separator + 1) : '';
    if (namespace !== 'user' || !id) fail('invalid_argument', 'Only user collections (collectionId "user:…" from collections) can be deleted here; groups follow their items.', 'trash.user_collections_only');
    const collection = repo.collections('user').find(value => value.id === id);
    if (!collection) (repo.trashEntryFor('collection', collectionId) ? fail('library_not_found', 'This collection is already in Recently Deleted.', 'trash.collection_already_deleted') : fail('library_not_found', 'This collection does not exist.', 'trash.collection_not_found'));
    const members = repo.memberships().filter(value => value.namespace === 'user' && value.collectionId === id).length;
    if (preview) return { preview: true, deleted: [], collections: [{ collectionId, name: collection!.name, members }], revision: repo.getRevision(), note: 'Nothing was changed. The collection would go to Recently Deleted; its items stay.' };
    const deletedMs = now(), trashId = randomUUID();
    const expiresMs = repo.transaction(() => {
      const expiresMs = Math.max(deletedMs, repo.trashClock()) + retention;
      repo.advanceTrashClock(deletedMs);
      repo.trashCollection('user', id, { trashId, deletedMs, expiresMs, state: 'trashed', summary: { members, ...actorSummary(actor) }, data: {} });
      return expiresMs;
    });
    return { preview: false, deleted: [], collections: [{ trashId, collectionId, name: collection!.name, members, deletedAt: iso(deletedMs), expiresAt: iso(expiresMs) }], revision: repo.getRevision(), note: `The collection is in Recently Deleted for ${TRASH_RETENTION_DAYS} days; its items were not deleted.` };
  }
  async function deleteArchivedNow(kinds: LibraryKind[] | undefined, preview: boolean, actor?: TrashActor) {
    const archived = repo.archivedItems(kinds ?? [], TRASH_BATCH_LIMIT);
    if (!archived.items.length) return { preview, deleted: [], remaining: 0, revision: repo.getRevision(), note: 'There are no archived items to delete.' };
    const result = await deleteNow(archived.items.map(value => ({ kind: value.kind, id: value.id, expectedRevision: value.revision })), preview, actor);
    return { ...result, remaining: archived.total - (preview ? 0 : archived.items.length), ...(archived.total > archived.items.length ? { more: `${TRASH_BATCH_LIMIT} items are handled per call; call again for the rest.` } : {}) };
  }

  // ---------------------------------------------------------------- list
  function listNow(args: { query?: string; offset?: number; limit?: number }) {
    const page = repo.listTrash({ query: args.query, offset: args.offset ?? 0, limit: args.limit ?? 20 });
    return {
      entries: page.entries.map(entry => ({ trashId: entry.trashId, kind: entry.kind, ...(entry.kind === 'collection' ? { collectionId: entry.itemId } : { id: entry.itemId, revision: entry.revision }), name: entry.name,
        deletedAt: iso(entry.deletedMs), expiresAt: iso(entry.expiresMs), ...(entry.state === 'moving' ? { state: 'moving' } : {}), ...entry.summary })),
      total: page.total, offset: page.offset, limit: page.limit, hasMore: page.hasMore, nextOffset: page.hasMore ? page.offset + page.entries.length : null,
      retentionDays: TRASH_RETENTION_DAYS, revision: repo.getRevision(),
    };
  }
  function checkedIds(raw: unknown): string[] {
    if (!Array.isArray(raw) || !raw.length || raw.length > TRASH_BATCH_LIMIT || raw.some(value => typeof value !== 'string' || !UUID.test(value))) return fail('invalid_argument', `Name 1–${TRASH_BATCH_LIMIT} trashIds from recently-deleted.`, 'trash.trash_ids_size', { max: TRASH_BATCH_LIMIT });
    const trashIds = raw as string[];
    if (new Set(trashIds).size !== trashIds.length) fail('invalid_argument', 'A trashId is named twice.', 'trash.trash_id_duplicate');
    return trashIds;
  }
  /** Entries still moving (an interrupted deletion that recovery could not finish yet) are settled before they are restored or purged. */
  async function settleMoving(entries: TrashEntry[]) {
    if (!entries.some(entry => entry.state === 'moving')) return;
    for (const operation of repo.pendingFileOps().filter(value => value.action === 'trash-move' && value.state === 'pending')) await finishMoves(operation.id, true);
    for (const entry of entries) if (repo.trashEntry(entry.trashId)?.state === 'moving') {
      const id = journal('trash-move', { trashIds: [entry.trashId] }); await finishMoves(id, true);
    }
  }

  // ---------------------------------------------------------------- restore
  function relocate(payload: LibraryPayload, from: string, to: string): LibraryPayload {
    const next = structuredClone(payload), url = options.toFileUrl;
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const image = value as Record<string, unknown>;
      if (image.filePath === from) { image.filePath = to; if (url && typeof image.fileUrl === 'string') image.fileUrl = url(to); }
    };
    visit(next); visit(next.image);
    for (const key of ['images', 'previewImages']) if (Array.isArray(next[key])) next[key].forEach(visit);
    return next;
  }
  /** A free sibling name for a restored file: neither on disk nor taken by another file of the same restore. */
  async function freeSibling(file: string, taken: Set<string>) {
    const parsed = path.parse(file);
    for (let index = 1; index < 1000; index++) {
      const candidate = path.join(parsed.dir, `${parsed.name}-restored${index === 1 ? '' : `-${index}`}${parsed.ext}`);
      if (!taken.has(libraryPathKey(candidate)) && !await lstatOrNull(candidate)) return candidate;
    }
    return fail('library_conflict', 'No free file name for a restored file.', 'trash.no_free_name');
  }
  /** A restored file goes back only into the resolved folder it came from, or else into a managed folder (never through a link to elsewhere). */
  async function destinationAllowed(file: string, recorded: string | null, roots: string[], trashKey: string) {
    const real = await realFolderOf(file);
    if (!real) return false;
    const key = libraryPathKey(real);
    if (key === trashKey || within(key, trashKey)) return false;
    return sameFolder(real, recorded) || roots.some(root => key === root || within(key, root));
  }
  async function restoreNow(rawIds: unknown) {
    const trashIds = checkedIds(rawIds);
    let entries = trashIds.map(trashId => repo.trashEntry(trashId) ?? fail('library_not_found', `Recently Deleted has no entry ${trashId}.`, 'trash.entry_not_found', { trashId }));
    await settleMoving(entries);
    entries = trashIds.map(trashId => repo.trashEntry(trashId) ?? fail('library_not_found', `Recently Deleted has no entry ${trashId}.`, 'trash.entry_not_found', { trashId }));
    for (const entry of entries) {
      if (entry.kind === 'collection') { const [namespace, ...rest] = entry.itemId.split(':'); if (repo.collections(namespace).some(value => value.id === rest.join(':'))) fail('library_conflict', `${entry.itemId} exists again; it cannot be restored over.`, 'trash.collection_exists', { item: entry.itemId }); }
      else if (repo.get(entry.kind, entry.itemId)) fail('library_conflict', `${entry.kind}:${entry.itemId} exists again; delete it before restoring this entry.`, 'trash.item_exists', { item: `${entry.kind}:${entry.itemId}` });
    }
    const [roots, trashKey] = [await managedRootKeys(), await trashRootKey()];
    type Move = { trashId: string; ordinal: number; role: string; from: string; to: string; original: string };
    const moves: Move[] = [], dedupe: string[] = [], lost = new Map<string, number>(), relocations = new Map<string, Array<{ from: string; to: string }>>();
    const taken = new Set<string>();
    for (const entry of entries) for (const file of repo.trashFiles(entry.trashId)) {
      if (file.state !== 'moved' || !file.trashPath) continue;
      if (!await lstatOrNull(file.trashPath)) { lost.set(entry.trashId, (lost.get(entry.trashId) ?? 0) + 1); continue; }
      let destination = file.path;
      if (!await destinationAllowed(destination, file.realDirectory, roots, trashKey)) fail('library_conflict', `A file of ${entry.name} cannot go back to its folder (it is no longer the same folder); nothing was restored.`, 'trash.folder_changed', { name: entry.name });
      if (await lstatOrNull(destination) || taken.has(libraryPathKey(destination))) {
        if (!taken.has(libraryPathKey(destination)) && await sameFile(destination, file.trashPath)) { dedupe.push(file.trashPath); continue; }
        // Only a path the item's own record names can move to a free name (a study or cover path follows from its identity).
        if (!PAYLOAD_PATH_ROLE.test(file.role) || entry.kind === 'study') fail('library_conflict', `A different file now occupies a file of ${entry.name}; nothing was restored.`, 'trash.file_occupied', { name: entry.name });
        destination = await freeSibling(destination, taken);
        relocations.set(entry.trashId, [...(relocations.get(entry.trashId) ?? []), { from: file.path, to: destination }]);
      }
      taken.add(libraryPathKey(destination));
      moves.push({ trashId: entry.trashId, ordinal: file.ordinal, role: file.role, from: file.trashPath, to: destination, original: file.path });
    }
    // A cleared cover comes back only when nobody set a new one; its file must still be there.
    const coverFiles = new Map<string, boolean>();
    for (const entry of entries) for (const cleared of entry.data.clearedCovers ?? []) if (typeof cleared.cover?.sha256 === 'string') coverFiles.set(cleared.cover.sha256, !!await lstatOrNull(path.join(libraryDirectory, 'covers', `${cleared.cover.sha256}.webp`)));
    const restoreJournal = journal('trash-restore', { trashIds, moves: moves.map(({ trashId, ordinal, from, to }) => ({ trashId, ordinal, from, to })) });
    const done: Move[] = [];
    const rollback = async () => {
      for (const move of done.reverse()) { try { await moveFile(move.to, move.from, '.partial'); } catch (error) { log('a restored file could not go back to Recently Deleted', error); } }
      repo.completeFileOperation(restoreJournal);
    };
    try { for (const move of moves) { if (await moveFile(move.from, move.to, '.nai-trash-partial') === 'moved') done.push(move); } }
    catch (error) { await rollback(); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: (error as any)?.code ?? 'library_storage_failed' }); }
    let result;
    try {
      await options.interrupt?.('restore-commit');
      result = repo.transaction(() => {
        const restored: Array<Record<string, unknown>> = [], collections: Array<Record<string, unknown>> = [], unusedCovers: string[] = [];
        const fresh = new Map<string, TrashEntry>();
        for (const entry of entries) {
          if (entry.kind === 'collection') {
            const value = repo.restoreTrashedCollection(entry.trashId);
            collections.push({ trashId: entry.trashId, collectionId: entry.itemId, name: value.collection.name, ...(value.renamed ? { renamedFrom: entry.name } : {}), members: { restored: value.members.restored.length, pending: value.members.pending.length, skipped: value.members.skipped.length } });
            continue;
          }
          const files = repo.trashFiles(entry.trashId);
          const back = repo.restoreTrashedItem(entry.trashId);
          let item = back.item;
          const moved = relocations.get(entry.trashId) ?? [];
          if (moved.length) {
            let payload = item.payload; for (const value of moved) payload = relocate(payload, value.from, value.to);
            item = repo.put(item.kind, item.id, payload, { expectedRevision: item.revision, name: item.name, archived: item.archived, createdAt: item.createdAt, updatedAt: new Date().toISOString(), source: item.source });
          }
          const covers = { restored: [] as string[], notRestored: [] as Array<{ id: string; reason: string }> };
          // The entry as it is now: an earlier entry of this restore may have handed it a cleared cover of its own tag.
          for (const cleared of fresh.get(entry.trashId)?.data.clearedCovers ?? entry.data.clearedCovers ?? []) {
            const current = repo.get('tag', cleared.id) ? repo.getCover('tag', cleared.id) : null;
            const blob = path.join(libraryDirectory, 'covers', `${cleared.cover.sha256}.webp`);
            const tagEntry = current ? null : repo.trashEntryFor('tag', cleared.id);
            // The tag is in Recently Deleted too: its entry takes the cover over (and keeps its file) for when it comes back.
            if (tagEntry && repo.adoptClearedCover(tagEntry.trashId, cleared, { path: blob, sha256: cleared.cover.sha256 })) { covers.notRestored.push({ id: cleared.id, reason: 'tag_in_recently_deleted' }); fresh.set(tagEntry.trashId, repo.trashEntry(tagEntry.trashId)!); }
            else if (!current) { covers.notRestored.push({ id: cleared.id, reason: 'tag_missing' }); unusedCovers.push(blob); }
            else if (current.cover !== null || current.coverRevision !== cleared.clearedCoverRevision) { covers.notRestored.push({ id: cleared.id, reason: 'cover_changed' }); unusedCovers.push(blob); }
            else if (!(coverFiles.get(cleared.cover.sha256) ?? existsSync(blob))) covers.notRestored.push({ id: cleared.id, reason: 'cover_file_missing' });
            else { repo.setCover('tag', cleared.id, cleared.cover, { expectedRevision: cleared.clearedCoverRevision }); covers.restored.push(cleared.id); }
          }
          const counts = { restored: files.filter(file => file.state === 'moved').length - (lost.get(entry.trashId) ?? 0), relocated: moved.length, inPlace: files.filter(file => KEPT.includes(file.state)).length, missing: files.filter(file => file.state === 'missing').length + (lost.get(entry.trashId) ?? 0) };
          restored.push({ trashId: entry.trashId, kind: item.kind, id: item.id, revision: item.revision, name: item.name, ...(moved.length ? { relocatedFrom: back.item.revision } : {}), files: counts,
            collections: back.memberships, covers });
        }
        repo.completeFileOperation(restoreJournal);
        // Trash copies that an identical file made unnecessary, and the files of covers that did not come back (deleted
        // only if nothing uses them).
        const cleanup = journal('trash-purge', { trashIds, unlink: dedupe.map(file => ({ path: file, inTrash: true })), inPlace: [...new Set(unusedCovers)].map(file => ({ path: file, realDirectory: null, records: [{ byteLength: null, sha256: /^([a-f0-9]{64})\.webp$/.exec(path.basename(file))?.[1] ?? null }] })) });
        return { restored, collections, cleanup };
      });
    } catch (error) { await rollback(); throw error; }
    await finishPurge(result.cleanup);
    return { ...bounded('restored', result.restored), collections: result.collections, revision: repo.getRevision() };
  }

  // ---------------------------------------------------------------- purge
  type InPlaceRecord = { byteLength: number | null; sha256: string | null };
  async function purgeNow(rawIds: unknown, all: boolean) {
    await retryPurges();
    const trashIds = all ? repo.allTrashIds().slice(0, TRASH_BATCH_LIMIT) : checkedIds(rawIds);
    if (!trashIds.length) return { purged: [], remaining: 0, revision: repo.getRevision() };
    let entries = trashIds.map(trashId => repo.trashEntry(trashId) ?? fail('library_not_found', `Recently Deleted has no entry ${trashId}.`, 'trash.entry_not_found', { trashId }));
    await settleMoving(entries);
    entries = trashIds.map(trashId => repo.trashEntry(trashId)!).filter(Boolean);
    const roots = await managedRootKeys(), trashKey = await trashRootKey();
    // In-place files are deleted only when nothing outside this purge uses them, they are plain managed files, and
    // they are still the file a purged entry recorded (same digest, or same size where no digest was recorded).
    const inPlace = new Map<string, Fact & { recorded: string | null; records: InPlaceRecord[]; unchanged: boolean }>();
    for (const entry of entries) for (const file of repo.trashFiles(entry.trashId)) {
      if (!IN_PLACE_PURGEABLE.includes(file.state)) continue;
      const record = { byteLength: file.byteLength, sha256: file.sha256 }, known = inPlace.get(file.path);
      if (known) { known.records.push(record); known.recorded ??= file.realDirectory; continue; }
      inPlace.set(file.path, { ...await fact(file.path, roots, trashKey), recorded: file.realDirectory, records: [record], unchanged: false });
    }
    for (const [file, facts] of inPlace) facts.unchanged = facts.regular && await stillRecorded(file, facts.records);
    const result = repo.transaction(() => {
      const purging = new Set(entries.map(entry => `trash:${entry.trashId}`));
      const owners = repo.fileOwners([...inPlace.keys()].filter(file => inPlace.get(file)!.regular));
      const unused = (file: string) => [...owners.get(file) ?? []].every(owner => purging.has(owner));
      const deletable = new Set([...inPlace.entries()].filter(([file, facts]) => facts.regular && facts.unchanged && (facts.managed || sameFolder(facts.realDirectory, facts.recorded)) && unused(file)).map(([file]) => file));
      // Kept because it changed since the deletion (otherwise it would have gone).
      const changed = new Set([...inPlace.entries()].filter(([file, facts]) => facts.regular && !facts.unchanged && (facts.managed || sameFolder(facts.realDirectory, facts.recorded)) && unused(file)).map(([file]) => file));
      const purged = entries.map(entry => {
        const files = repo.trashFiles(entry.trashId);
        const deleted = files.filter(file => file.state === 'moved' || (IN_PLACE_PURGEABLE.includes(file.state) && deletable.has(file.path) && file.state !== 'retained')).length;
        const kept = files.filter(file => KEPT.includes(file.state) && !deletable.has(file.path));
        const changedHere = kept.filter(file => changed.has(file.path)).length;
        return { trashId: entry.trashId, kind: entry.kind, ...(entry.kind === 'collection' ? { collectionId: entry.itemId } : { id: entry.itemId, revision: entry.revision }), name: entry.name,
          files: { deleted, kept: kept.length, ...(changedHere ? { changed: changedHere } : {}) },
          ...(changedHere ? { note: 'A file left in place changed after the deletion (another size or content); it was kept.' } : {}) };
      });
      repo.deleteTrashEntries(entries.map(entry => entry.trashId));
      repo.advanceTrashClock(now());
      const operation = journal('trash-purge', { trashIds: entries.map(entry => entry.trashId), unlink: [], inPlace: [...deletable].map(file => ({ path: file, realDirectory: inPlace.get(file)!.recorded, records: inPlace.get(file)!.records })) });
      return { purged, operation };
    });
    await options.interrupt?.('purge-files');
    const unfinished = await finishPurge(result.operation);
    return { ...bounded('purged', result.purged), ...(all ? { remaining: repo.allTrashIds().length } : {}), ...(unfinished ? { retryLater: unfinished } : {}), revision: repo.getRevision(),
      note: `Purged entries and their files are gone for good.${unfinished ? ` ${unfinished} file(s) could not be removed yet; they are retried at the next purge and the next start.` : ''}` };
  }
  /**
   * Deletes what one trash-purge journal names (also used by recovery and a restore's cleanup): trash copies, entry
   * folders, and in-place files that nothing uses and that are still the recorded file. A file or folder that cannot
   * be removed now stays in the journal, which remains pending and is retried by the next purge and the next start;
   * nothing is thrown for it. Returns how many are left.
   */
  async function finishPurge(operationId: string): Promise<number> {
    const operation = repo.pendingFileOps().find(value => value.id === operationId);
    if (!operation) return 0;
    const trashKey = await trashRootKey(), roots = await managedRootKeys();
    const left = { unlink: [] as unknown[], inPlace: [] as unknown[], trashIds: [] as string[] };
    for (const value of Array.isArray(operation.payload.unlink) ? operation.payload.unlink : []) {
      const file = String(value.path), key = libraryPathKey(file);
      if (!within(key, libraryPathKey(trashRoot))) { log(`a purge journal names ${file} outside Recently Deleted; left in place`); continue; }
      try { await fs.rm(file, { force: true }); } catch (error) { log('a Recently Deleted copy could not be removed yet', error); left.unlink.push(value); }
    }
    const named = (Array.isArray(operation.payload.inPlace) ? operation.payload.inPlace : []).map((value: any) => typeof value === 'string'
      ? { path: value, realDirectory: null, records: [] as InPlaceRecord[] }
      : { path: String(value?.path), realDirectory: typeof value?.realDirectory === 'string' ? value.realDirectory : null, records: Array.isArray(value?.records) ? value.records as InPlaceRecord[] : [] });
    const owners = repo.fileOwners(named.map(value => value.path));
    for (const value of named) {
      try {
        const facts = await fact(value.path, roots, trashKey);
        if (!facts.exists) continue;
        // Rechecked: an interrupted purge never deletes a file something started using since, or one that changed.
        if (!facts.regular || !(facts.managed || sameFolder(facts.realDirectory, value.realDirectory)) || (owners.get(value.path)?.size ?? 0) > 0 || !await stillRecorded(value.path, value.records)) continue;
        await fs.unlink(value.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } catch (error) { log('a file of a purged entry could not be removed yet', error); left.inPlace.push(value); }
    }
    for (const trashId of Array.isArray(operation.payload.trashIds) ? operation.payload.trashIds : []) {
      if (repo.trashEntry(trashId)) continue;
      try { await removeEntryFolder(trashId); } catch (error) { log('a Recently Deleted folder could not be removed yet', error); left.trashIds.push(trashId); }
    }
    const remaining = left.unlink.length + left.inPlace.length + left.trashIds.length;
    if (remaining) repo.putFileOperation({ ...operation, state: 'pending', payload: { ...operation.payload, ...left }, error: `${remaining} file(s) or folder(s) could not be removed yet.` });
    else repo.completeFileOperation(operationId);
    return remaining;
  }
  /** Retries the file work earlier purges (and restore cleanups) could not finish. */
  async function retryPurges() {
    for (const operation of repo.pendingFileOps().filter(value => value.action === 'trash-purge' && value.payload?.scope === 'trash' && value.state === 'pending')) await finishPurge(operation.id);
  }
  async function purgeExpiredNow() {
    await retryPurges();
    let purged = 0;
    for (let round = 0; round < 20; round++) {
      const ids = repo.expiredTrash(now(), TRASH_BATCH_LIMIT);
      if (!ids.length) break;
      purged += (await purgeNow(ids, false)).purged.length;
    }
    return { purged };
  }

  // ---------------------------------------------------------------- recovery
  /** Finishes or rolls back every Recently Deleted file journal an interruption left, oldest first. Call once at startup, before serving. */
  async function recoverNow() {
    const operations = repo.pendingFileOps().filter(value => value.payload?.scope === 'trash' && value.state === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const operation of operations) {
      try {
        if (operation.action === 'trash-move') await finishMoves(operation.id, true);
        else if (operation.action === 'trash-purge') await finishPurge(operation.id);
        else if (operation.action === 'trash-restore') {
          // Restores commit after their files moved and complete this journal in the same commit: a pending one did not commit.
          const moves = Array.isArray(operation.payload.moves) ? operation.payload.moves : [];
          for (const move of moves) {
            if (!repo.trashEntry(move.trashId)) continue;
            await fs.rm(`${move.to}.nai-trash-partial`, { force: true });
            const [inTrash, outside] = [await lstatOrNull(move.from), await lstatOrNull(move.to)];
            if (outside && !inTrash) { try { await moveFile(move.to, move.from, '.partial'); } catch (error) { log('a file of an interrupted restore could not go back to Recently Deleted', error); } }
            else if (outside && inTrash && await sameFile(move.to, move.from)) await fs.unlink(move.to);
          }
          repo.completeFileOperation(operation.id);
        } else repo.putFileOperation({ ...operation, state: 'failed', error: 'Unknown Recently Deleted journal.' });
      } catch (error) {
        log('a Recently Deleted journal needs attention', error);
        repo.putFileOperation({ ...operation, state: 'failed', error: error instanceof Error ? error.message : 'Recently Deleted recovery failed.' });
      }
    }
  }

  return {
    /** Moves items to Recently Deleted; preview lists the effects without changing anything. */
    deleteItems: (selections: Selection[], args: { preview?: boolean; deletedBy?: TrashActor } = {}) => serial(() => deleteNow(selections, args.preview === true, args.deletedBy)),
    deleteCollection: (collectionId: string, args: { preview?: boolean; deletedBy?: TrashActor } = {}) => serial(() => deleteCollectionNow(collectionId, args.preview === true, args.deletedBy)),
    deleteArchived: (args: { kinds?: LibraryKind[]; preview?: boolean; deletedBy?: TrashActor } = {}) => serial(() => deleteArchivedNow(args.kinds, args.preview === true, args.deletedBy)),
    list: (args: { query?: string; offset?: number; limit?: number } = {}) => listNow(args),
    restore: (trashIds: unknown) => serial(() => restoreNow(trashIds)),
    purge: (args: { trashIds?: unknown; all?: boolean }) => serial(() => purgeNow(args.trashIds, args.all === true)),
    purgeExpired: () => serial(() => purgeExpiredNow()),
    recover: () => serial(() => recoverNow()),
    /** Purges expired entries now and then every TRASH_PURGE_INTERVAL_MS (an unref'd timer). */
    startAutoPurge(intervalMs = TRASH_PURGE_INTERVAL_MS) {
      if (timer) return;
      const run = () => { void serial(() => purgeExpiredNow()).catch(error => log('automatic purge failed', error)); };
      run(); timer = setInterval(run, intervalMs); timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = undefined; },
    /** Settles once every queued trash operation has finished (tests, shutdown). */
    idle: () => serial(async () => undefined),
  };
}
export type LibraryTrash = ReturnType<typeof createLibraryTrash>;
