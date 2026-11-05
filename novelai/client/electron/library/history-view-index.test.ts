// In-memory history view index (2026-11-01): after every write sequence the
// index must answer historyOrder / historyDates / historyEntries exactly like
// the repository's SQL views did at d917b22. The reference below is that SQL,
// verbatim, run on a second (read-only) connection to the same database file.
import { afterEach, describe, expect, it } from 'vitest';
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LIBRARY_CHANGE_ID_LIMIT, LibraryError, openLibraryRepository, type HistoryViewFilter, type LibraryItem, type LibraryRepository } from './repository';
import { createHistoryViewIndex } from './history-view-index';

const roots: string[] = [], closers: Array<() => void> = [];
afterEach(() => { closers.splice(0).reverse().forEach(close => { try { close(); } catch { /* closed */ } }); runCleanupsSync(roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))); });
function open(options: { readOnly?: boolean; filePath?: string } = {}) {
  let filePath = options.filePath;
  if (!filePath) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-history-index-')); roots.push(root); filePath = path.join(root, 'library.sqlite'); }
  const repository = openLibraryRepository({ filePath, readOnly: options.readOnly });
  closers.push(() => repository.close());
  return { repository, filePath };
}
function referenceConnection(filePath: string) {
  const db = new DatabaseSync(filePath, { readOnly: true, timeout: 200 });
  closers.push(() => db.close());
  return db;
}

// ---- Reference: repository.ts history views at d917b22, verbatim. ----
const fail = (code: string, message: string): never => { throw new LibraryError(code, message); };
const decode = (row: any): LibraryItem | null => row ? JSON.parse(String(row.record_json)) : null;
function historyWhere(filter: HistoryViewFilter): { sql: string; args: string[] } {
  const clauses = ["kind='history'", 'archived=0'], args: string[] = [];
  if (filter.date !== undefined && filter.date !== '') {
    if (typeof filter.date !== 'string') fail('invalid_argument', 'Invalid history date filter.');
    clauses.push("json_type(record_json,'$.payload.date')='text'", "json_extract(record_json,'$.payload.date')=?"); args.push(filter.date);
  }
  if (filter.groupId === '__ungrouped') clauses.push("(json_type(record_json,'$.payload.groupId') IS NULL OR json_type(record_json,'$.payload.groupId') IN ('null','false') OR (json_type(record_json,'$.payload.groupId')='text' AND json_extract(record_json,'$.payload.groupId')='') OR (json_type(record_json,'$.payload.groupId') IN ('integer','real') AND json_extract(record_json,'$.payload.groupId')=0))");
  else if (filter.groupId !== undefined && filter.groupId !== '') {
    if (typeof filter.groupId !== 'string') fail('invalid_argument', 'Invalid history group filter.');
    clauses.push("json_type(record_json,'$.payload.groupId')='text'", "json_extract(record_json,'$.payload.groupId')=?"); args.push(filter.groupId);
  }
  return { sql: clauses.join(' AND '), args };
}
function referenceOrder(db: DatabaseSync, filter: HistoryViewFilter = {}): string[] {
  const where = historyWhere(filter);
  return db.prepare(`SELECT id FROM items WHERE ${where.sql} ORDER BY updated_at DESC,kind,id`).all(...where.args).map((row: any) => String(row.id));
}
function referenceDates(db: DatabaseSync): string[] {
  const dates = new Set<string>(); let other = false;
  for (const row of db.prepare("SELECT DISTINCT json_type(record_json,'$.payload.date') AS type,json_extract(record_json,'$.payload.date') AS date FROM items WHERE kind='history' AND archived=0").all() as any[]) {
    if (row.type === 'text') dates.add(String(row.date)); else other = true;
  }
  if (other) for (const row of db.prepare("SELECT record_json FROM items WHERE kind='history' AND archived=0 AND json_type(record_json,'$.payload.date') IS NOT 'text'").all()) dates.add(String(decode(row)!.payload.date));
  return [...dates].sort().reverse();
}
function referenceEntries(db: DatabaseSync, ids: readonly string[], filter: HistoryViewFilter = {}): Array<{ id: string; archived: boolean; visible: boolean; item?: LibraryItem }> {
  if (!Array.isArray(ids) || ids.length > LIBRARY_CHANGE_ID_LIMIT) fail('invalid_argument', 'Too many history identities.');
  const wanted = [...new Set(ids.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 500 && !/[\x00-\x1f]/.test(id)))];
  if (!wanted.length) return [];
  const where = historyWhere(filter);
  return db.prepare(`SELECT id,archived,CASE WHEN ${where.sql} THEN record_json END AS record_json FROM items WHERE kind='history' AND id IN (${wanted.map(() => '?').join(',')})`).all(...where.args, ...wanted)
    .map((row: any) => ({ id: String(row.id), archived: Number(row.archived) !== 0, visible: row.record_json !== null, ...(row.record_json !== null ? { item: decode(row)! } : {}) }));
}
// Reads inside an open write transaction see its uncommitted writes. The reference connection cannot, so the
// reference SQL runs on an in-memory copy of the items this connection currently sees, written as put() writes them.
function referenceCopy(repository: LibraryRepository): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE items(kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,archived INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_namespace TEXT NOT NULL,record_json TEXT NOT NULL,search_text TEXT NOT NULL,PRIMARY KEY(kind,id))');
  const insert = db.prepare('INSERT INTO items VALUES(?,?,?,?,?,?,?,?,?,?)');
  for (const item of repository.all()) insert.run(item.kind, item.id, item.revision, item.name, item.archived ? 1 : 0, item.createdAt, item.updatedAt, item.source.namespace, JSON.stringify(item), '');
  return db;
}

// ---- Awkward but storable values. ----
const MISSING = Symbol('missing');
// Text dates whose bytes differ from what a JS filter binds (lone surrogates become CESU-8 bytes in json_extract,
// U+FFFD when bound), NUL, astral and private-use characters, and every non-text JSON type.
const DATES: unknown[] = ['2026-10-01', '2026-10-01', '2026-10-02', '2026-10-03', '', 'a\ud800b', 'a\ufffdb', 'a\ufffd\ufffd\ufffdb', '\u0000x', '日期', '\u{1F600}', '\uE000', '\u{10000}', '20261003', 20261003, 1.5, -0, 1e21, null, true, false, { y: 2026 }, [1, 2], [], [[]], MISSING];
// (A group name with a control character cannot be stored: put() projects it into a collection identity.)
const GROUPS: unknown[] = [MISSING, MISSING, null, '', 0, 0.5, -0, false, true, 'g1', 'g1', 'g2', '__ungrouped', '0', ' ', 'g\ud800', 'g\ufffd', 5, {}, [], 'G1'];
// Byte order differs from UTF-16 order for U+E000 vs U+10000; a lone surrogate id is stored as U+FFFD.
const IDS = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'H01', 'a', 'Z', 'é', '\uE000a', '\u{10000}a', 'h\ud800', 'h\ufffd2', '日', 'h1', 'h10a', 'h-'];
// Ties and timestamp spellings whose byte order differs from their time order.
const UPDATED: Array<string | undefined> = [undefined, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-19T23:59:59.999Z', '2026-10-21T08:00:00.000Z', '2026-10-20', 'Tue, 20 Oct 2026 00:00:00 GMT', '2026-10-20T00:00:00.000+08:00', '2025-01-01T00:00:00.000Z'];
const VIEW_DATES: Array<string | undefined> = [undefined, '', '2026-10-01', '2026-10-02', 'a\ud800b', 'a\ufffdb', 'a\ufffd\ufffd\ufffdb', '\u0000x', '20261003', 'null', 'undefined', '日期', '\u{1F600}', 'missing'];
const VIEW_GROUPS: Array<string | undefined> = [undefined, '', '__ungrouped', 'g1', 'G1', 'g\u0000', 'g\ud800', 'g\ufffd', '0', '5', 'false', ' '];
const VIEWS: HistoryViewFilter[] = VIEW_DATES.flatMap(date => VIEW_GROUPS.map(groupId => ({ date, groupId })));
const ENTRY_VIEWS: HistoryViewFilter[] = [{}, { date: '2026-10-01' }, { groupId: '__ungrouped' }, { date: 'a\ud800b', groupId: 'g1' }, { groupId: 'g\ud800' }];
const ENTRY_IDS = [...IDS, 'h\udc00', 'never', 'h01', 'bad\u0001id', 'n1'];

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, pick: <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] };
}
function payloadFor(rng: ReturnType<typeof random>, id: string, old?: Record<string, unknown>) {
  const payload: Record<string, unknown> = old ? { ...old } : { id, createdAt: '2026-10-01T00:00:00.000Z', params: { positivePrompt: `1girl ${id}` } };
  const change = old ? rng.next() : 1;
  if (!old || change < 0.4) { const date = rng.pick(DATES); if (date === MISSING) delete payload.date; else payload.date = date; }
  if (!old || (change >= 0.3 && change < 0.7)) { const group = rng.pick(GROUPS); if (group === MISSING) delete payload.groupId; else payload.groupId = group; }
  if (change >= 0.7) payload.params = { positivePrompt: `edited ${rng.next()}` };
  if (rng.next() < 0.1) payload.archived = rng.next() < 0.5;
  return payload;
}

// What the comparisons actually exercised (non-empty views, listed dates), so the edge cases are known to occur.
const exercised = new Set<string>();
function verify(repository: LibraryRepository, db: DatabaseSync, label: string) {
  for (const view of VIEWS) {
    const order = repository.historyOrder(view);
    expect(order, `${label} order ${JSON.stringify(view)}`).toStrictEqual(referenceOrder(db, view));
    if (order.length) exercised.add(`view ${JSON.stringify(view)}`);
  }
  const dates = repository.historyDates();
  expect(dates, `${label} dates`).toStrictEqual(referenceDates(db));
  for (const date of dates) exercised.add(`date ${JSON.stringify(date)}`);
  for (const view of ENTRY_VIEWS) {
    const entries = repository.historyEntries(ENTRY_IDS, view);
    expect(entries, `${label} entries ${JSON.stringify(view)}`).toStrictEqual(referenceEntries(db, ENTRY_IDS, view));
    for (const entry of entries) exercised.add(`entry ${entry.visible ? 'visible' : entry.archived ? 'archived' : 'hidden'}`);
  }
}

describe('history view index', () => {
  it('equals the SQL views after every step of random write sequences (puts, edits, archive, remove, transactions, rollbacks, unknown and external changes)', () => {
    for (const seed of [1, 2, 3]) {
      const { repository, filePath } = open();
      const db = referenceConnection(filePath);
      // Another connection to the same file: its commits reach this repository only through SQLite's data_version.
      const other = openLibraryRepository({ filePath }); closers.push(() => other.close());
      const rng = random(seed), counts: Record<string, number> = {};
      const write = (target: LibraryRepository) => {
        const id = rng.pick(IDS), current = target.get('history', id), roll = rng.next();
        if (!current || roll < 0.55) target.put('history', id, payloadFor(rng, id, current?.payload), { updatedAt: rng.pick(UPDATED), ...(rng.next() < 0.15 ? { archived: rng.next() < 0.5 } : {}) });
        else if (roll < 0.75) target.put('history', id, current.payload, { expectedRevision: current.revision, archived: !current.archived, updatedAt: rng.pick(UPDATED) });
        else target.remove('history', id);
      };
      verify(repository, db, `seed ${seed} empty`);
      for (let step = 0; step < 160; step++) {
        const roll = rng.next(); let op: string;
        if (roll < 0.5) { op = 'write'; write(repository); }
        else if (roll < 0.62) { op = 'transaction'; repository.transaction(() => { const writes = 2 + Math.floor(rng.next() * 4); for (let index = 0; index < writes; index++) write(repository); }); }
        else if (roll < 0.7) { op = 'rollback'; expect(() => repository.transaction(() => { write(repository); write(repository); throw new Error('abort'); })).toThrow('abort'); }
        else if (roll < 0.75) { op = 'unknown'; repository.transaction(() => write(repository), { unknownChange: true }); }
        else if (roll < 0.79) { op = 'kinds'; repository.putCollection({ namespace: 'history', id: `group-${step}`, name: `group ${step}`, payload: {} }); }
        else if (roll < 0.86) { op = 'external'; write(other); }
        else if (roll < 0.9) { op = 'other-kind'; repository.put('note', rng.pick(IDS), { name: 'note', date: '2026-10-01', groupId: 'g1' }); }
        else if (roll < 0.94) {
          op = 'in-transaction';
          // Reads inside an open write transaction see its uncommitted writes, like the SQL views do; rolling back leaves the index as it was.
          const commit = rng.next() < 0.5;
          const attempt = () => repository.transaction(() => {
            write(repository); write(repository);
            const copy = referenceCopy(repository);
            try { verify(repository, copy, `seed ${seed} step ${step} inside a transaction`); } finally { copy.close(); }
            if (!commit) throw new Error('abort');
          });
          if (commit) attempt(); else expect(attempt).toThrow('abort');
        } else { op = 'mixed'; repository.transaction(() => { write(repository); repository.put('note', 'n1', { name: 'n' }); write(repository); }); }
        counts[op] = (counts[op] ?? 0) + 1;
        verify(repository, db, `seed ${seed} step ${step} ${op}`);
      }
      // The index answered (not the SQL fallback), mostly by re-reading named rows.
      const stats = repository.historyViewIndexStats();
      expect(stats.ready).toBe(true);
      expect(stats.refreshes).toBeGreaterThan(20);
      expect(stats.builds).toBeLessThan(80);
      for (const op of ['write', 'transaction', 'rollback', 'unknown', 'kinds', 'external', 'other-kind', 'in-transaction', 'mixed']) expect(counts[op], `seed ${seed} ${op}`).toBeGreaterThan(0);
    }
    // The awkward cases really occurred: a bound lone surrogate matching a stored U+FFFD, CESU-8 date bytes listed,
    // every non-text date type, ungrouped and astral/lone-surrogate groups, and visible, hidden and archived entries.
    const views: HistoryViewFilter[] = [{ date: 'a\ud800b' }, { date: 'a\ufffd\ufffd\ufffdb' }, { groupId: '__ungrouped' }, { groupId: 'g\ud800' }, { groupId: '0' }, { date: '20261003', groupId: '__ungrouped' }];
    const dates = ['a\ufffd\ufffd\ufffdb', 'a\ufffdb', '\u0000x', '', 'undefined', 'null', 'true', 'false', '1.5', '0', '1e+21', '[object Object]', '1,2', '\u{10000}'];
    for (const marker of [...views.map(view => `view ${JSON.stringify(view)}`), ...dates.map(date => `date ${JSON.stringify(date)}`), 'entry visible', 'entry hidden', 'entry archived']) expect(exercised, marker).toContain(marker);
  }, 120_000);

  it('re-reads only the named rows after an ordinary change and rebuilds after unknown, kind-only, oversized and external changes', () => {
    const { repository, filePath } = open();
    const db = referenceConnection(filePath);
    repository.transaction(() => { for (let index = 0; index < 50; index++) repository.put('history', `h${index}`, { id: `h${index}`, date: `2026-10-${String(1 + index % 5).padStart(2, '0')}`, ...(index % 3 ? { groupId: 'g1' } : {}) }); });
    verify(repository, db, 'seeded');
    const before = repository.historyViewIndexStats();
    expect(before).toMatchObject({ ready: true, rows: 50, builds: 1 });

    repository.put('history', 'fresh', { id: 'fresh', date: '2026-10-09', groupId: 'g1' });
    const h3 = repository.get('history', 'h3')!; repository.put('history', 'h3', h3.payload, { expectedRevision: h3.revision, archived: true });
    repository.remove('history', 'h4');
    expect(repository.historyViewIndexStats()).toMatchObject({ pending: 3, builds: 1 });
    verify(repository, db, 'incremental');
    expect(repository.historyViewIndexStats()).toMatchObject({ ready: true, pending: 0, builds: 1, rows: 50, refreshes: before.refreshes + 1, refreshedIds: before.refreshedIds + 3 });
    // A rolled-back write and a write of another kind change nothing to re-read.
    expect(() => repository.transaction(() => { repository.put('history', 'gone', { id: 'gone', date: '2026-10-01' }); throw new Error('abort'); })).toThrow('abort');
    repository.put('note', 'n', { name: 'n' });
    verify(repository, db, 'rollback and other kind');
    expect(repository.historyViewIndexStats()).toMatchObject({ builds: 1, refreshes: before.refreshes + 1 });

    const rebuildsAfter = (label: string, change: () => void) => {
      const builds = repository.historyViewIndexStats().builds;
      change();
      verify(repository, db, label);
      expect(repository.historyViewIndexStats().builds, label).toBe(builds + 1);
    };
    rebuildsAfter('unknown change', () => repository.transaction(() => repository.put('history', 'u', { id: 'u', date: '2026-10-11' }), { unknownChange: true }));
    rebuildsAfter('kind-only change', () => repository.putCollection({ namespace: 'history', id: 'g9', name: 'g9', payload: {} }));
    rebuildsAfter('oversized change', () => repository.transaction(() => { for (let index = 0; index <= LIBRARY_CHANGE_ID_LIMIT; index++) repository.put('history', `bulk${index}`, { id: `bulk${index}`, date: '2026-10-12' }); }));
    rebuildsAfter('pending ids beyond the limit', () => { for (let index = 0; index < 6; index++) repository.transaction(() => { for (let item = 0; item < 100; item++) repository.put('history', `bulk${item + index * 100}`, { id: `bulk${item}`, date: '2026-10-13' }); }); });
    rebuildsAfter('import', () => {
      const snapshot = repository.exportSnapshot();
      repository.importSnapshot({ ...snapshot, items: [...snapshot.items, { ...snapshot.items.find(item => item.kind === 'history' && item.id === 'h1')!, revision: 99, payload: { id: 'h1', date: '1999-01-01' } }] }, { requireEmpty: false });
    });
    const other = openLibraryRepository({ filePath }); closers.push(() => other.close());
    rebuildsAfter('external commit', () => { const h5 = other.get('history', 'h5')!; other.put('history', 'h5', { ...h5.payload, date: '2026-12-31' }, { expectedRevision: h5.revision }); });
    rebuildsAfter('external remove', () => other.remove('history', 'h6'));
  }, 60_000);

  it('keeps no index on a read-only connection, answers through SQL there, and forgets the index when closed', () => {
    const { repository, filePath } = open();
    repository.put('history', 'a', { id: 'a', date: '2026-10-01' });
    const reader = open({ readOnly: true, filePath }).repository;
    expect(reader.historyOrder()).toEqual(['a']);
    repository.put('history', 'b', { id: 'b', date: '2026-10-02' });
    const db = referenceConnection(filePath);
    verify(reader, db, 'read-only');
    expect(reader.historyViewIndexStats()).toMatchObject({ ready: false, builds: 0 });

    expect(repository.historyOrder()).toHaveLength(2);
    repository.close();
    expect(() => repository.historyOrder()).toThrow(/closed/);
    expect(() => repository.historyDates()).toThrow(/closed/);
    expect(repository.historyViewIndexStats()).toMatchObject({ ready: false, rows: 0 });
    // Written while the first connection was closed: a new connection reads the file afresh.
    const writer = open({ filePath }).repository;
    writer.remove('history', 'a');
    writer.close();
    const reopened = open({ filePath }).repository;
    verify(reopened, db, 'reopened');
    expect(reopened.historyOrder()).toEqual(['b']);
  });

  it('rebuilds after a write on its own connection that bypassed the commit announcements (total_changes)', () => {
    const { repository, filePath } = open();
    repository.transaction(() => { for (const id of ['a', 'b', 'c']) repository.put('history', id, { id, date: '2026-10-01' }); });
    repository.close();
    const db = new DatabaseSync(filePath); closers.push(() => db.close());
    const index = createHistoryViewIndex(db);
    const read = () => { db.exec('BEGIN DEFERRED'); try { expect(index.sync()).toBe(true); return index.order({ ungrouped: false }); } finally { db.exec('COMMIT'); } };
    expect(read()).toEqual(referenceOrder(db));
    expect(index.stats().builds).toBe(1);
    // An autocommit write on the same connection changes neither data_version nor any announcement.
    db.prepare("UPDATE items SET archived=1 WHERE kind='history' AND id='a'").run();
    expect(read()).toEqual(referenceOrder(db));
    expect(index.stats().builds).toBe(2);
    // The same write right before an announced transaction is not hidden by it.
    db.prepare("UPDATE items SET archived=1 WHERE kind='history' AND id='b'").run();
    db.exec('BEGIN IMMEDIATE'); index.writeBegan();
    db.prepare("UPDATE items SET updated_at='2030-01-01T00:00:00.000Z' WHERE kind='history' AND id='c'").run();
    db.exec('COMMIT'); index.writeEnded({ changedKinds: ['history'], ids: ['c'] });
    expect(read()).toEqual(referenceOrder(db));
    expect(read()).toEqual(['c']);
    expect(index.stats().builds).toBe(3);
    // A rolled-back write counts in total_changes but changes nothing.
    db.exec('BEGIN IMMEDIATE'); index.writeBegan();
    db.prepare("UPDATE items SET archived=0 WHERE kind='history'").run();
    db.exec('ROLLBACK'); index.writeEnded(null);
    expect(read()).toEqual(['c']);
    expect(index.stats().builds).toBe(3);
  });

  it('validates view filters exactly like the SQL views', () => {
    const { repository } = open();
    repository.put('history', 'a', { id: 'a', date: '2026-10-01' });
    repository.historyOrder();
    for (const filter of [{ date: 5 }, { date: null }, { groupId: false }, { groupId: 0 }, { date: '2026-10-01', groupId: [] }, { date: {}, groupId: 'g' }] as unknown as HistoryViewFilter[]) {
      let expected: unknown, actual: unknown;
      try { historyWhere(filter); } catch (error) { expected = error; }
      try { repository.historyOrder(filter); } catch (error) { actual = error; }
      expect(actual, JSON.stringify(filter)).toBeInstanceOf(LibraryError);
      expect([(actual as LibraryError).code, (actual as LibraryError).message]).toEqual([(expected as LibraryError).code, (expected as LibraryError).message]);
      // Like the SQL version, the identity list is checked first: no wanted identity, no filter check.
      expect(repository.historyEntries([], filter)).toEqual([]);
      expect(() => repository.historyEntries(['a'], filter)).toThrow((expected as LibraryError).message);
    }
    expect(() => repository.historyOrder(null as unknown as HistoryViewFilter)).toThrow(TypeError);
    expect(() => repository.historyEntries(Array.from({ length: LIBRARY_CHANGE_ID_LIMIT + 1 }, (_, index) => `x${index}`))).toThrow(/Too many/);
  });
});
