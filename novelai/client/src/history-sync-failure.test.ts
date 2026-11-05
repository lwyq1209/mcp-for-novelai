// Review P3-1 (2026-11-01), from the reviewer's probe zz-review-incremental-failure:
// a failed incremental history read must not leave its items stale. The old
// behaviour (a full refresh per notification) self-healed on the next
// notification; the incremental path must converge to the host state too.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import { DEFAULT_PARAMS, type HistoryItem, type HistoryItemsSnapshot } from './types';
import { waitUntil } from './test-support/wait-until';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, safeStorage: { isEncryptionAvailable: () => false } }));
const entry = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({ id, date: '2026-11-01', filePath: `/out/${id}.png`, fileUrl: `media://${id}`, createdAt: '2026-11-01T00:00:00.000Z', model: DEFAULT_PARAMS.model, width: 832, height: 1216, actualSeed: 1, params: { ...DEFAULT_PARAMS, positivePrompt: id }, ...extra });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); });
afterEach(() => { vi.unstubAllGlobals(); });

it('after a transient failure of one incremental read, a later successful batch also repairs that item', async () => {
  // Host truth after two commits: a was edited (groupId g), then b was edited.
  const host = { a: entry('a', { groupId: 'g' }), b: entry('b', { groupId: 'h' }) };
  let failNext = true;
  const getHistoryItems = vi.fn(async (request: { ids: string[] }): Promise<HistoryItemsSnapshot> => {
    if (failNext) { failNext = false; throw new Error('SQLITE_BUSY (simulated transient failure)'); }
    return { items: request.ids.map(id => host[id as 'a' | 'b']).filter(Boolean), removed: [], order: ['a', 'b'] };
  });
  vi.stubGlobal('window', { naiDesktop: { getHistoryItems, getHistory: vi.fn(async () => [host.a, host.b]), getHistoryDates: vi.fn(async () => ['2026-11-01']), getHistoryGroups: vi.fn(async () => []), setSetting: vi.fn() } });
  useAppStore.setState({ selectedDate: '2026-11-01', history: [entry('a'), entry('b')] });
  await expect(useAppStore.getState().refreshHistoryItems(['a'])).rejects.toThrow(/SQLITE_BUSY/);
  await useAppStore.getState().refreshHistoryItems(['b']);
  // The batch that only named b must also bring a to the host state, as a full refresh would.
  expect(useAppStore.getState().history.map(item => [item.id, item.groupId])).toEqual([['a', 'g'], ['b', 'h']]);
  // Once repaired, a is not read again.
  await useAppStore.getState().refreshHistoryItems(['b']);
  expect(getHistoryItems.mock.calls.map(([request]) => [...request.ids].sort())).toEqual([['a'], ['a', 'b'], ['b']]);
});

it('a read superseded by a full load that then fails reads again itself instead of reporting a silent success', async () => {
  const host = { a: entry('a', { groupId: 'g' }), b: entry('b') };
  const slow = deferred<HistoryItemsSnapshot>(), full = deferred<HistoryItem[]>();
  const getHistoryItems = vi.fn()
    .mockImplementationOnce(() => slow.promise)
    .mockImplementation(async (request: { ids: string[] }) => ({ items: request.ids.map(id => host[id as 'a' | 'b']).filter(Boolean), removed: [], order: ['a', 'b'] }));
  vi.stubGlobal('window', { naiDesktop: { getHistoryItems, getHistory: vi.fn(() => full.promise), getHistoryDates: vi.fn(async () => ['2026-11-01']), getHistoryGroups: vi.fn(async () => []), setSetting: vi.fn() } });
  useAppStore.setState({ selectedDate: '2026-11-01', history: [entry('a'), entry('b')] });
  const patch = useAppStore.getState().refreshHistoryItems(['a']);
  await waitUntil(() => expect(getHistoryItems).toHaveBeenCalledTimes(1));
  // A newer full load of the same view starts (it clears the list while loading) and then fails.
  const reselect = useAppStore.getState().setSelectedDate('2026-11-01');
  slow.resolve({ items: [host.a], removed: [], order: ['a', 'b'] });
  full.reject(new Error('library_closed'));
  await expect(reselect).rejects.toThrow('library_closed');
  await patch;
  // Nothing applied the superseded result, so the patch read again and repaired the whole view.
  expect(useAppStore.getState().history.map(item => [item.id, item.groupId])).toEqual([['a', 'g'], ['b', undefined]]);
});
