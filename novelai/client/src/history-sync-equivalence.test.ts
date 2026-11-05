// R4 equivalence (2026-11-01): after any sequence of library writes, patching the
// history from the change notifications must leave exactly the state a full
// refreshHistory() produces. Real repository, real host store functions, the
// renderer store, and IPC emulated by structured cloning.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PARAMS, type HistoryItem } from './types';

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
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-history-sync-')); vi.resetModules(); });
afterEach(() => { closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } }); vi.unstubAllGlobals(); fs.rmSync(fixture.root, { recursive: true, force: true }); });

async function setup() {
  const { openLibraryRepository } = await import('../electron/library/repository');
  const repository = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite') });
  closers.push(() => repository.close());
  const { activateLibrary, deactivateLibrary } = await import('../electron/library-runtime');
  activateLibrary(repository, { userDataRoot: path.join(fixture.root, 'user-data'), libraryDirectory: path.join(fixture.root, 'library') });
  closers.unshift(() => deactivateLibrary());
  const host = await import('../electron/ipc/store');
  const calls: string[] = [];
  const ipc = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => async (...args: A) => { calls.push(name); await Promise.resolve(); return structuredClone(fn(...args)); };
  vi.stubGlobal('window', { naiDesktop: {
    getHistory: ipc('getHistory', host.getHistory), getHistoryItems: ipc('getHistoryItems', host.getHistoryItems),
    getHistoryDates: ipc('getHistoryDates', host.getHistoryDates), getHistoryGroups: ipc('getHistoryGroups', host.getHistoryGroups),
    setSetting: async () => ({}),
  } });
  const { useAppStore } = await import('./store');
  const { mergeLibraryChanges } = await import('./asset-library/library-changes');
  const { refreshLibraryReadModels } = await import('./workspace/library-read-models');
  const pending: unknown[] = [];
  repository.subscribe((revision, change) => { pending.push({ revision, ...change }); });
  const pick = () => { const state = useAppStore.getState(); return structuredClone({ history: state.history, historyDates: state.historyDates, historyGroups: state.historyGroups, selectedDate: state.selectedDate, selectedGroupId: state.selectedGroupId }); };
  /** Deliver the notifications since the last step as one batch, then compare with a full refresh. */
  async function settle(label: string, expectFull = false) {
    const batch = mergeLibraryChanges(pending.splice(0));
    calls.length = 0;
    await Promise.all(refreshLibraryReadModels(batch, { refreshSettings: async () => undefined, refreshHistoryItems: useAppStore.getState().refreshHistoryItems }).map(entry => entry.read));
    const incremental = pick(), usedFull = calls.includes('getHistory');
    await useAppStore.getState().refreshHistory();
    expect(incremental, label).toEqual(pick());
    expect(usedFull, `${label}: ${expectFull ? 'full' : 'incremental'} path`).toBe(expectFull);
  }
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 20, 12, minute)).toISOString();
  // Records as generation saves them (addHistory checks the complete parameters); only the list behaviour matters here.
  const item = (id: string, date: string, extra: Record<string, unknown> = {}) => { const filePath = path.join(fixture.root, 'out', date, `${id}.png`); return ({ id, date, createdAt: `${date}T12:00:00.000Z`, filePath, fileUrl: `file://${filePath}`, model: 'nai-diffusion-4-5-full', width: 832, height: 1216, actualSeed: 1, params: { ...DEFAULT_PARAMS, positivePrompt: `1girl, ${id}` }, ...extra }) as unknown as HistoryItem; };
  return { repository, host, useAppStore, settle, item, at, pending };
}

it('incremental history patches equal a full refresh across writes, filters and view switches', async () => {
  const { repository, host, useAppStore, settle, item, at, pending } = await setup();
  repository.putCollection({ namespace: 'history', id: 'g1', name: 'Group 1', payload: { id: 'g1', name: 'Group 1' } });
  repository.putCollection({ namespace: 'history', id: 'g2', name: 'Group 2', payload: { id: 'g2', name: 'Group 2' } });
  repository.transaction(() => {
    for (let index = 0; index < 40; index++) repository.put('history', `base${index}`, item(`base${index}`, `2026-10-${String(10 + (index % 4)).padStart(2, '0')}`, index % 5 === 0 ? {} : { groupId: index % 3 ? 'g1' : index % 2 ? '' : 'g2' }), { updatedAt: at(index % 7 === 0 ? 0 : index) });
  });
  pending.length = 0;
  await useAppStore.getState().refreshHistory();
  const views: Array<[string, string]> = [['', ''], ['2026-10-12', ''], ['2026-10-12', 'g1'], ['', '__ungrouped'], ['2026-10-11', '__ungrouped'], ['', 'g2'], ['2026-10-13', 'g1']];
  for (const [date, group] of views) {
    await useAppStore.getState().setSelectedDate(date);
    await useAppStore.getState().setSelectedGroupId(group);
    const view = `[${date || 'all'} / ${group || 'all'}]`;
    host.addHistory([item(`new-${date}-${group}`, '2026-10-12', { groupId: 'g1' })]);
    await settle(`${view} add on 2026-10-12`);
    host.addHistory([item(`other-${date}-${group}`, '2026-10-01')]);
    await settle(`${view} add on another, new date`);
    host.updateHistoryItem('base3', { params: { positivePrompt: `edited ${view}` } } as unknown as Partial<HistoryItem>);
    await settle(`${view} edit payload`);
    host.updateHistoryItem('base4', { groupId: group === 'g1' ? 'g2' : 'g1' });
    await settle(`${view} move between groups`);
    host.updateHistoryItem('base6', { groupId: '' });
    host.updateHistoryItem('base7', { groupId: null as unknown as string });
    await settle(`${view} ungroup with "" and null`);
    const archived = repository.get('history', 'base8')!;
    repository.put('history', 'base8', archived.payload, { expectedRevision: archived.revision, archived: true });
    await settle(`${view} archive`);
    const restored = repository.get('history', 'base8')!;
    repository.put('history', 'base8', restored.payload, { expectedRevision: restored.revision, archived: false });
    await settle(`${view} unarchive`);
    repository.remove('history', `new-${date}-${group}`);
    await settle(`${view} delete`);
    const tie = repository.get('history', 'base9')!;
    repository.put('history', 'base9', { ...tie.payload, date: '2026-10-12' }, { expectedRevision: tie.revision, updatedAt: at(0) });
    await settle(`${view} change date with an updated_at tie`);
    repository.transaction(() => { host.addHistory([item(`batch-a-${view}`, '2026-10-12'), item(`batch-b-${view}`, '2026-10-11', { groupId: 'g2' })]); repository.remove('history', 'base10'); });
    host.addHistory([item(`burst-${view}`, '2026-10-13', { groupId: 'g1' })]);
    await settle(`${view} several transactions in one batch`);
    // Restore base10 so the next view starts from a comparable set.
    host.addHistory([item('base10', '2026-10-12', { groupId: 'g1' })]);
    await settle(`${view} re-add`);
  }
  // A put that creates a new group announces kinds only: the full path, still equal.
  host.addHistory([item('grouped', '2026-10-12', { groupId: 'fresh-group' })]);
  await settle('new group created by a put', true);
});

it('after a saved image the patched view equals a full refresh, also when the canvas switched to another date', async () => {
  const { host, useAppStore, item, settle, pending } = await setup();
  host.addHistory([item('a', '2026-10-01'), item('b', '2026-10-02'), item('c', '2026-10-02')]);
  pending.length = 0;
  await useAppStore.getState().refreshHistory('2026-10-01');
  // Like showCompletedImage: the new image is shown first and its date selected, from a list of another date.
  const saved = item('d', '2026-10-02', { updatedAt: '2099-01-01T00:00:00.000Z' }); host.addHistory([saved]); pending.length = 0;
  const fresh = host.getHistory('2026-10-02').find(value => value.id === 'd')!;
  useAppStore.setState(state => ({ selectedDate: saved.date, history: [fresh, ...state.history.filter(value => value.date === saved.date)] }));
  await useAppStore.getState().refreshHistoryAfterSave(saved);
  const patched = structuredClone(useAppStore.getState().history);
  await useAppStore.getState().refreshHistory();
  expect(patched).toEqual(useAppStore.getState().history);
  expect(patched[0].id).toBe('d');
  expect(patched.map(value => value.id).sort()).toEqual(['b', 'c', 'd']);
  // A saved image of another date than the selected one loads that date like refreshHistory(item.date).
  const elsewhere = item('e', '2026-10-05'); host.addHistory([elsewhere]); pending.length = 0;
  await useAppStore.getState().refreshHistoryAfterSave(elsewhere);
  expect(useAppStore.getState()).toMatchObject({ selectedDate: '2026-10-05', history: [expect.objectContaining({ id: 'e' })] });
  // An unclassified write announces nothing specific: the full path, still equal.
  const { repository } = { repository: (await import('../electron/library-runtime')).activeLibrary()! };
  repository.transaction(() => host.addHistory([item('f', '2026-10-05')]), { unknownChange: true });
  await settle('unknown change', true);
});
