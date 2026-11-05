// SQL history views (2026-11-01): getHistory/getHistoryDates/getHistoryItems must
// return exactly what the original repo.all('history') + JS filter returned.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return path.join(fixture.root, 'user-data');
      if (key === 'pictures') return path.join(fixture.root, 'pictures');
      if (key === 'exe') return path.join(fixture.root, 'app', 'MCP for NovelAI');
      return fixture.root;
    },
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}));

const closers: Array<() => void> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-history-views-')); vi.resetModules(); });
afterEach(() => { closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } }); fs.rmSync(fixture.root, { recursive: true, force: true }); });

async function setup() {
  const { openLibraryRepository } = await import('../library/repository');
  const repository = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite') });
  closers.push(() => repository.close());
  const { activateLibrary, deactivateLibrary } = await import('../library-runtime');
  activateLibrary(repository, { userDataRoot: path.join(fixture.root, 'user-data'), libraryDirectory: path.join(fixture.root, 'library') });
  closers.unshift(() => deactivateLibrary());
  const store = await import('./store');
  const { toLocalMediaUrl } = await import('./local-media-protocol');
  return { repository, store, toLocalMediaUrl };
}
type Repo = Awaited<ReturnType<typeof setup>>['repository'];

// The original implementation, verbatim, as the reference.
function legacyHistory(repository: Repo, toUrl: (file: string) => string, date?: unknown, groupId?: unknown) {
  return repository.all('history').filter(item => !item.archived).map(item => item.payload as any)
    .filter(item => {
      if (date && item.date !== date) return false;
      if (!groupId) return true;
      if (groupId === '__ungrouped') return !item.groupId;
      return item.groupId === groupId;
    })
    .map(item => item.filePath ? { ...item, fileUrl: toUrl(item.filePath) } : item);
}
function legacyDates(repository: Repo) {
  return [...new Set(repository.all('history').filter(item => !item.archived).map(item => String(item.payload.date)))].sort().reverse();
}

// Awkward but storable values: every falsy and non-string group, non-text dates, ties in updated_at.
function seed(repository: Repo) {
  const groups: unknown[] = [undefined, null, '', 0, false, 'g1', 'g2', 5, true, {}, [], '0', ' '];
  const dates: unknown[] = ['2026-10-01', '2026-10-02', '2026-10-02', 20261003, null, undefined, '2026-10-01', true, { y: 2026 }, '日期', '\u{1F600}', '2026-10-0\u00e9'];
  const tie = '2026-10-20T00:00:00.000Z';
  let index = 0;
  for (const groupId of groups) for (const date of dates) {
    const id = `h${String(index).padStart(3, '0')}${index % 7 === 0 ? 'z' : ''}`;
    const payload: Record<string, unknown> = { id, createdAt: '2026-10-01T00:00:00.000Z', params: { positivePrompt: id } };
    if (date !== undefined) payload.date = date;
    if (groupId !== undefined) payload.groupId = groupId;
    if (index % 3) payload.filePath = path.join(fixture.root, 'out', `${id}.png`);
    repository.put('history', id, payload, { updatedAt: index % 4 === 0 ? tie : new Date(Date.UTC(2026, 9, 1) + (index * 7919 % 500) * 60_000).toISOString(), archived: index % 11 === 0 });
    index++;
  }
  repository.put('note', 'not-history', { name: 'note', date: '2026-10-01' });
}
const views: Array<[unknown, unknown]> = [];
for (const date of [undefined, '', '2026-10-01', '2026-10-02', '20261003', 'null', 'undefined', '日期', '\u{1F600}', 'missing-day']) for (const groupId of [undefined, '', '__ungrouped', 'g1', 'g2', '5', '0', ' ', 'true']) views.push([date, groupId]);

describe('SQL history views', () => {
  it('getHistory equals the original filter for every date/group view, including __ungrouped and archived items', async () => {
    const { repository, store, toLocalMediaUrl } = await setup();
    seed(repository);
    for (const [date, groupId] of views) expect(store.getHistory(date as string, groupId as string), `${String(date)} / ${String(groupId)}`).toEqual(legacyHistory(repository, toLocalMediaUrl, date, groupId));
    // Non-string IPC input keeps the JS comparison (a number never equals a stored string, but does equal a stored number).
    for (const [date, groupId] of [[20261003, undefined], [undefined, 5], [true, 'g1']] as Array<[unknown, unknown]>) expect(store.getHistory(date as string, groupId as string)).toEqual(legacyHistory(repository, toLocalMediaUrl, date, groupId));
    expect(store.getHistory(20261003 as unknown as string).length).toBeGreaterThan(0);
  });

  it('getHistoryDates equals the original distinct, String()-ed, descending list without decoding text dates', async () => {
    const { repository, store } = await setup();
    seed(repository);
    expect(store.getHistoryDates()).toEqual(legacyDates(repository));
    expect(store.getHistoryDates()).toEqual(expect.arrayContaining(['undefined', 'null', '20261003', 'true', '[object Object]']));
    // Only text dates remain: nothing is decoded.
    for (const item of repository.all('history')) if (typeof item.payload.date !== 'string') repository.remove('history', item.id);
    const parse = vi.spyOn(JSON, 'parse');
    let dates: string[], calls: number;
    try { dates = store.getHistoryDates(); calls = parse.mock.calls.length; } finally { parse.mockRestore(); }
    expect(dates).toEqual(legacyDates(repository));
    expect(calls).toBe(0);
  });

  it('a filtered view decodes only its own rows', async () => {
    const { repository, store } = await setup();
    repository.transaction(() => { for (let index = 0; index < 400; index++) repository.put('history', `d${index}`, { id: `d${index}`, date: `2026-10-${String(1 + (index % 20)).padStart(2, '0')}`, groupId: index % 3 ? 'other' : undefined }); });
    const parse = vi.spyOn(JSON, 'parse');
    let day: unknown[], calls: number;
    try { day = store.getHistory('2026-10-05', '__ungrouped'); calls = parse.mock.calls.length; } finally { parse.mockRestore(); }
    expect(day).toHaveLength(7);
    expect(calls).toBe(7);
  });

  it('getHistoryItems names visible, hidden, archived and missing items and returns the exact view order', async () => {
    const { repository, store, toLocalMediaUrl } = await setup();
    seed(repository);
    const all = repository.all('history');
    const archived = all.find(item => item.archived)!, hiddenByGroup = all.find(item => !item.archived && item.payload.groupId === 'g2')!, visible = all.filter(item => !item.archived && item.payload.groupId === 'g1' && item.payload.date === '2026-10-02');
    const ids = [visible[0].id, visible[1].id, archived.id, hiddenByGroup.id, 'never-existed', 'not-history', visible[0].id, 'bad\u0001id'];
    const snapshot = store.getHistoryItems({ ids, date: '2026-10-02', groupId: 'g1' });
    const expected = legacyHistory(repository, toLocalMediaUrl, '2026-10-02', 'g1');
    expect(snapshot.order).toEqual(expected.map(item => item.id));
    expect(snapshot.items).toEqual([visible[0].id, visible[1].id].map(id => expected.find(item => item.id === id)));
    expect(snapshot.removed.sort()).toEqual([archived.id, 'bad\u0001id', 'never-existed', 'not-history'].sort());
    expect(store.getHistoryItems({ ids: [visible[0].id], date: '2026-10-02', groupId: 'g1', order: false })).toEqual({ items: [expected.find(item => item.id === visible[0].id)], removed: [] });
    for (const [date, groupId] of views) expect(store.getHistoryItems({ ids: [], date: date as string, groupId: groupId as string }).order).toEqual(legacyHistory(repository, toLocalMediaUrl, date, groupId).map(item => item.id));
    expect(() => store.getHistoryItems({ ids: Array.from({ length: 501 }, (_, index) => `x${index}`) })).toThrow();
    expect(() => store.getHistoryItems({ ids: [1 as unknown as string] })).toThrow();
  });

  it('history group writes go to the library and are announced as history changes; settings writes announce none', async () => {
    const { repository, store } = await setup();
    store.readStore(); // first read creates the settings file
    const seen: unknown[] = [];
    repository.subscribe((_revision, change) => { seen.push(change); });
    const [group] = store.createHistoryGroup('一组');
    store.renameHistoryGroup(group.id, '二组');
    store.setSetting('theme', 'dark');
    store.deleteHistoryGroup(group.id);
    expect(seen).toEqual([{ changedKinds: ['history'] }, { changedKinds: ['history'] }, { changedKinds: ['history'] }]);
    expect(repository.collections('history')).toEqual([]);
  });
});
