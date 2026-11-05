import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { LIBRARY_CHANGE_ID_LIMIT, type LibraryChange } from './types';

// In-memory history view index (2026-11-01). The SQL views scanned every
// history row (and ran json_extract for date/group filters) on each library
// change notification. This index keeps, per history row, only what the views
// read, so the view order and the date list become in-memory passes.
//
// Equivalence with the SQL views is by construction:
// - Every predicate value is computed by SQLite with the same SQL expressions
//   the views use (HISTORY_DATE_TYPE_SQL, HISTORY_UNGROUPED_SQL, ...).
// - Text is compared as UTF-8 bytes, like SQLite's BINARY collation: a "byte
//   key" is a string with one char (0-255) per UTF-8 byte, so JS string
//   equality and `<` are memcmp. Stored values are read with CAST(... AS BLOB)
//   (json_extract can yield bytes that are not valid UTF-8); filter values are
//   encoded the way node:sqlite binds a JS string (lone surrogates become
//   U+FFFD, exactly what Buffer.from(text, 'utf8') does).
// - Dates for the date list use the same JS values as the SQL version:
//   String(json_extract) for text dates, String(JSON.parse(record).payload.date)
//   for any other type (decoded only for those rows).

/** `json_type` of the history date / group, as the SQL views test it. */
export const HISTORY_DATE_TYPE_SQL = "json_type(record_json,'$.payload.date')";
export const HISTORY_DATE_VALUE_SQL = "json_extract(record_json,'$.payload.date')";
export const HISTORY_GROUP_TYPE_SQL = "json_type(record_json,'$.payload.groupId')";
export const HISTORY_GROUP_VALUE_SQL = "json_extract(record_json,'$.payload.groupId')";
/** The `"__ungrouped"` view: `!item.groupId` (missing, null, false, "" and 0). */
export const HISTORY_UNGROUPED_SQL = `(${HISTORY_GROUP_TYPE_SQL} IS NULL OR ${HISTORY_GROUP_TYPE_SQL} IN ('null','false') OR (${HISTORY_GROUP_TYPE_SQL}='text' AND ${HISTORY_GROUP_VALUE_SQL}='') OR (${HISTORY_GROUP_TYPE_SQL} IN ('integer','real') AND ${HISTORY_GROUP_VALUE_SQL}=0))`;

/** A validated history view: `date`/`groupId` are non-empty when present; `ungrouped` replaces groupId "__ungrouped". */
export interface HistoryViewQuery { date?: string; groupId?: string; ungrouped: boolean }

const ASCII = /^[\x00-\x7f]*$/;
/** Byte key of a JS string as node:sqlite binds it (UTF-8, lone surrogates as U+FFFD). */
export function textKey(text: string): string { return ASCII.test(text) ? text : Buffer.from(text, 'utf8').toString('latin1'); }
/** Byte key of a BLOB read from SQLite. */
export function bytesKey(bytes: Uint8Array): string { return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'); }

interface Entry {
  /** Byte key of `items.id` (the identity and the secondary sort key). */
  key: string;
  /** `String(items.id)` as the SQL views return it. */
  id: string;
  /** Byte key of `items.updated_at` (primary sort key, descending). */
  updated: string;
  /** `archived=0`. */
  live: boolean;
  /** Byte key of a text `payload.date`; null for any other type (never matches a date view). */
  dateKey: string | null;
  /** `String(payload.date)` for the date list. */
  dateText: string;
  /** Byte key of a text `payload.groupId`; null for any other type. */
  groupKey: string | null;
  /** HISTORY_UNGROUPED_SQL. */
  ungrouped: boolean;
}

// `ORDER BY updated_at DESC, kind, id` (kind is always 'history' here).
function compare(a: Entry, b: Entry): number {
  if (a.updated !== b.updated) return a.updated > b.updated ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

const ROW_COLUMNS = `id,typeof(id) AS id_type,CAST(id AS BLOB) AS id_key,typeof(updated_at) AS updated_type,CAST(updated_at AS BLOB) AS updated_key,archived=0 AS live,
  ${HISTORY_DATE_TYPE_SQL} AS date_type,
  CASE WHEN ${HISTORY_DATE_TYPE_SQL}='text' THEN ${HISTORY_DATE_VALUE_SQL} END AS date_text,
  CASE WHEN ${HISTORY_DATE_TYPE_SQL}='text' THEN CAST(${HISTORY_DATE_VALUE_SQL} AS BLOB) END AS date_key,
  CASE WHEN ${HISTORY_GROUP_TYPE_SQL}='text' THEN CAST(${HISTORY_GROUP_VALUE_SQL} AS BLOB) END AS group_key,
  ${HISTORY_UNGROUPED_SQL} AS ungrouped,
  CASE WHEN ${HISTORY_DATE_TYPE_SQL} IS NOT 'text' THEN record_json END AS record_json`;

interface State {
  rows: Entry[];
  byKey: Map<string, Entry>;
  /** Live rows per `dateText`. */
  dates: Map<string, number>;
  sortedDates: string[] | null;
  /** SQLite data_version (other connections' commits) at the last full read. */
  dataVersion: number;
  /** This connection's total_changes() once its own writes are accounted for. */
  changes: number;
}

export interface HistoryViewIndexStats { ready: boolean; stale: boolean; rows: number; pending: number; builds: number; refreshes: number; refreshedIds: number }

/**
 * The repository owns the connection and calls `sync()` only outside any
 * transaction of its own, inside a read transaction it opened for the view.
 * Maintenance follows the repository's commit announcements: named history ids
 * are re-read by primary key; an unknown change, a kind-only history change or
 * more than LIBRARY_CHANGE_ID_LIMIT pending ids mark the index stale, and the
 * next use rebuilds it. Commits by other connections (data_version) and any
 * write on this connection outside `transaction()` (total_changes) also force
 * a rebuild.
 */
export function createHistoryViewIndex(db: DatabaseSync) {
  let state: State | null = null, stale = false;
  const pending = new Set<string>();
  const stats = { builds: 0, refreshes: 0, refreshedIds: 0 };
  let tokenStatement: StatementSync | null = null, buildStatement: StatementSync | null = null;
  // Interning keeps one string per distinct date/group across thousands of rows.
  let interned = new Map<string, string>();
  const intern = (value: string) => { const found = interned.get(value); if (found !== undefined) return found; interned.set(value, value); return value; };

  function token(): { dataVersion: number; changes: number } {
    tokenStatement ??= db.prepare('SELECT (SELECT data_version FROM pragma_data_version) AS data_version,total_changes() AS changes');
    const row = tokenStatement.get() as { data_version: number; changes: number };
    return { dataVersion: Number(row.data_version), changes: Number(row.changes) };
  }
  function changes(): number { return token().changes; }
  function invalidate() { stale = true; pending.clear(); }

  function entryOf(row: any): Entry {
    if (row.id_type !== 'text' || row.updated_type !== 'text') throw new Error('History rows with non-text identities or timestamps keep the SQL views.');
    const id = String(row.id), key = bytesKey(row.id_key);
    const dateText = row.date_type === 'text' ? String(row.date_text) : String(JSON.parse(String(row.record_json)).payload.date);
    return {
      key: key === id ? id : key, id, updated: bytesKey(row.updated_key), live: Number(row.live) === 1,
      dateKey: row.date_key === null ? null : intern(bytesKey(row.date_key)), dateText: intern(dateText),
      groupKey: row.group_key === null ? null : intern(bytesKey(row.group_key)), ungrouped: Number(row.ungrouped) === 1,
    };
  }
  function countDate(current: State, date: string, delta: 1 | -1) {
    const next = (current.dates.get(date) ?? 0) + delta;
    if (next > 0) current.dates.set(date, next); else current.dates.delete(date);
    if (next === 0 || (delta === 1 && next === 1)) current.sortedDates = null;
  }
  function position(current: State, entry: Entry): number {
    let low = 0, high = current.rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (compare(current.rows[middle], entry) < 0) low = middle + 1; else high = middle; }
    return low;
  }
  function drop(current: State, key: string) {
    const old = current.byKey.get(key); if (!old) return;
    const at = position(current, old);
    if (current.rows[at] !== old) throw new Error('History view index order is inconsistent.');
    current.rows.splice(at, 1); current.byKey.delete(key);
    if (old.live) countDate(current, old.dateText, -1);
  }
  function add(current: State, entry: Entry) {
    drop(current, entry.key);
    current.rows.splice(position(current, entry), 0, entry); current.byKey.set(entry.key, entry);
    if (entry.live) countDate(current, entry.dateText, 1);
  }

  function rebuild(now: { dataVersion: number; changes: number }) {
    state = null; stale = true; pending.clear(); interned = new Map();
    buildStatement ??= db.prepare(`SELECT ${ROW_COLUMNS} FROM items WHERE kind='history'`);
    const rows: Entry[] = [], byKey = new Map<string, Entry>(), dates = new Map<string, number>();
    for (const row of buildStatement.all()) {
      const entry = entryOf(row);
      if (byKey.has(entry.key)) throw new Error('Duplicate history identity.');
      rows.push(entry); byKey.set(entry.key, entry);
      if (entry.live) dates.set(entry.dateText, (dates.get(entry.dateText) ?? 0) + 1);
    }
    rows.sort(compare);
    state = { rows, byKey, dates, sortedDates: null, dataVersion: now.dataVersion, changes: now.changes };
    stale = false; stats.builds++;
  }
  function refresh(current: State) {
    const ids = [...pending]; pending.clear();
    const fresh = db.prepare(`SELECT ${ROW_COLUMNS} FROM items WHERE kind='history' AND id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(entryOf);
    for (const id of ids) drop(current, textKey(id));
    for (const entry of fresh) add(current, entry);
    stats.refreshes++; stats.refreshedIds += ids.length;
  }

  return {
    /**
     * Bring the index up to date with the committed database. Call inside a
     * read transaction so the token and the rows come from one snapshot.
     * Returns false when the index cannot answer (the caller uses SQL).
     */
    sync(): boolean {
      try {
        const now = token();
        if (!state || stale || now.dataVersion !== state.dataVersion || now.changes !== state.changes) rebuild(now);
        else if (pending.size) refresh(state);
        return true;
      } catch {
        state = null; stale = true; pending.clear();
        return false;
      }
    },
    /** Right after BEGIN IMMEDIATE of an outermost write: a write outside `transaction()` since the last account makes the index stale. */
    writeBegan() {
      try { if (state && !stale && changes() !== state.changes) invalidate(); } catch { invalidate(); }
    },
    /** After COMMIT (with what it announced) or ROLLBACK (null) of an outermost write. Never throws. */
    writeEnded(change: LibraryChange | null) {
      try {
        if (!state || stale) return;
        if (change) {
          if (!change.changedKinds) return invalidate();
          if (change.changedKinds.includes('history')) {
            if (!change.ids) return invalidate();
            for (const id of change.ids) pending.add(id);
            if (pending.size > LIBRARY_CHANGE_ID_LIMIT) return invalidate();
          }
        }
        // A rolled-back write leaves the committed data as it was; either way
        // this connection's own writes are now accounted for.
        state.changes = changes();
      } catch { invalidate(); }
    },
    invalidate,
    /** Forget everything (the connection is closing). */
    drop() { state = null; stale = false; pending.clear(); interned = new Map(); tokenStatement = null; buildStatement = null; },

    /** View identities in `updated_at DESC, kind, id` order. Requires a successful `sync()`. */
    order(view: HistoryViewQuery): string[] {
      const current = state!, dateKey = view.date === undefined ? undefined : textKey(view.date), groupKey = view.groupId === undefined ? undefined : textKey(view.groupId);
      const order: string[] = [];
      for (const entry of current.rows) {
        if (!entry.live || (dateKey !== undefined && entry.dateKey !== dateKey) || (view.ungrouped && !entry.ungrouped) || (groupKey !== undefined && entry.groupKey !== groupKey)) continue;
        order.push(entry.id);
      }
      return order;
    },
    /** Distinct `String(payload.date)` of live rows, sorted descending like the original list. */
    dates(): string[] {
      const current = state!;
      current.sortedDates ??= [...current.dates.keys()].sort().reverse();
      return [...current.sortedDates];
    },
    /**
     * The history rows named by `ids` (deduplicated by stored identity, in
     * identity byte order), whether archived, and whether in the view. `bind`
     * is a caller id that selects the row in SQL.
     */
    entries(ids: readonly string[], view: HistoryViewQuery): Array<{ key: string; id: string; bind: string; archived: boolean; visible: boolean }> {
      const current = state!, dateKey = view.date === undefined ? undefined : textKey(view.date), groupKey = view.groupId === undefined ? undefined : textKey(view.groupId);
      const found = new Map<string, { key: string; id: string; bind: string; archived: boolean; visible: boolean }>();
      for (const bind of ids) {
        const key = textKey(bind), entry = current.byKey.get(key);
        if (!entry || found.has(key)) continue;
        const visible = entry.live && (dateKey === undefined || entry.dateKey === dateKey) && (!view.ungrouped || entry.ungrouped) && (groupKey === undefined || entry.groupKey === groupKey);
        found.set(key, { key, id: entry.id, bind, archived: !entry.live, visible });
      }
      return [...found.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    },
    stats(): HistoryViewIndexStats {
      return { ready: !!state && !stale, stale, rows: state?.rows.length ?? 0, pending: pending.size, ...stats };
    },
  };
}
export type HistoryViewIndex = ReturnType<typeof createHistoryViewIndex>;
