/**
 * Library change notifications, coalesced (2026-11-01).
 *
 * The host announces every committed library transaction once, naming the
 * changed item kinds and identities when it can. One saved image is several
 * transactions, so the renderer gathers notifications into batches: a batch
 * flushes 150 ms after the last notification, and at the latest 1 s after the
 * first one, so continuous writes still refresh at least once per second.
 */
export interface LibraryChangeEvent { revision?: number; changedKinds?: readonly string[]; ids?: readonly string[] }

export interface LibraryChangeBatch {
  /** Some notification named nothing (older host or unclassified write): everything may have changed. */
  readonly unknown: boolean;
  /** Union of the named kinds. */
  readonly kinds: ReadonlySet<string>;
  /** Union of the named identities; null when there were too many to name (any item of `kinds` may have changed). */
  readonly ids: ReadonlySet<string> | null;
  /** Kinds some notification named without identities: any item of these kinds may have changed. */
  readonly idlessKinds: ReadonlySet<string>;
  /** Highest revision seen in the batch, when the host sent one. */
  readonly revision?: number;
  /** Number of host notifications in the batch. */
  readonly notifications: number;
}

export const LIBRARY_CHANGE_DEBOUNCE_MS = 150;
export const LIBRARY_CHANGE_MAX_WAIT_MS = 1000;
/** Same bound as the host: a batch naming more identities is treated as naming only its kinds. */
export const LIBRARY_CHANGE_ID_LIMIT = 500;

/**
 * Settings read models that come from the library: getSettings() projects
 * stylePromptPresets (style_preset), positivePromptPresets (positive_preset),
 * promptChunks (prompt_chunk) and stylePromptPresetGroups (collections of the
 * 'style' namespace, announced as style_preset). Unknown changes also refresh.
 */
export const SETTINGS_LIBRARY_KINDS = ['style_preset', 'positive_preset', 'prompt_chunk'] as const;

/** Whether the batch may have changed one item (kind, id), or any item of `kind` when id is omitted. */
export function libraryChangeAffects(batch: LibraryChangeBatch, kind: unknown, id?: unknown): boolean {
  if (batch.unknown) return true;
  if (typeof kind !== 'string' || !batch.kinds.has(kind)) return false;
  if (id === undefined || batch.ids === null || batch.idlessKinds.has(kind)) return true;
  return typeof id === 'string' && batch.ids.has(id);
}

/** The identities that may have changed in `kind`, or null when any item of it may have (unknown, unnamed or too many). */
export function libraryChangeIds(batch: LibraryChangeBatch, kind: string): string[] | null {
  if (batch.unknown || batch.ids === null || batch.idlessKinds.has(kind)) return null;
  return batch.kinds.has(kind) ? [...batch.ids] : [];
}

/** Whether the batch may have changed any item of these kinds. */
export function libraryChangeAffectsKinds(batch: LibraryChangeBatch, kinds: readonly string[]): boolean {
  return batch.unknown || kinds.some(kind => batch.kinds.has(kind));
}

/** Builds one batch from notifications; malformed fields count as unknown. */
export function mergeLibraryChanges(events: readonly unknown[]): LibraryChangeBatch {
  let unknown = false, revision: number | undefined;
  const kinds = new Set<string>(), idlessKinds = new Set<string>();
  let ids: Set<string> | null = new Set<string>();
  for (const raw of events) {
    const event = raw && typeof raw === 'object' ? raw as LibraryChangeEvent : {};
    if (typeof event.revision === 'number' && Number.isFinite(event.revision)) revision = revision === undefined ? event.revision : Math.max(revision, event.revision);
    const named = event.changedKinds;
    if (!Array.isArray(named) || named.some(kind => typeof kind !== 'string')) { unknown = true; continue; }
    for (const kind of named) kinds.add(kind);
    const changedIds = event.ids;
    // Host ids are not paired with kinds: a notification without ids leaves every kind it names open.
    if (!Array.isArray(changedIds) || changedIds.some(id => typeof id !== 'string')) { for (const kind of named) idlessKinds.add(kind); continue; }
    if (ids) for (const id of changedIds) ids.add(id);
    if (ids && ids.size > LIBRARY_CHANGE_ID_LIMIT) ids = null;
  }
  if (unknown) { kinds.clear(); idlessKinds.clear(); ids = null; }
  return { unknown, kinds, ids, idlessKinds, ...(revision === undefined ? {} : { revision }), notifications: events.length };
}

export interface LibraryChangeCoalescer {
  push(event: unknown): void;
  /** Flushes pending notifications now (no-op when none are pending). */
  flush(): void;
  /** Drops pending notifications and timers. */
  dispose(): void;
}

/** Trailing debounce with a maximum wait; `onFlush` receives each merged batch. */
export function createLibraryChangeCoalescer(onFlush: (batch: LibraryChangeBatch) => void, options: { debounceMs?: number; maxWaitMs?: number } = {}): LibraryChangeCoalescer {
  const debounceMs = options.debounceMs ?? LIBRARY_CHANGE_DEBOUNCE_MS, maxWaitMs = options.maxWaitMs ?? LIBRARY_CHANGE_MAX_WAIT_MS;
  let pending: unknown[] = [], firstAt = 0, timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  const clear = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const flush = () => {
    clear();
    if (!pending.length) return;
    const events = pending; pending = [];
    onFlush(mergeLibraryChanges(events));
  };
  return {
    push(event) {
      if (disposed) return;
      const now = Date.now();
      if (!pending.length) firstAt = now;
      pending.push(event);
      clear();
      timer = setTimeout(flush, Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now)));
    },
    flush,
    dispose() { disposed = true; clear(); pending = []; },
  };
}
