import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import { HISTORY_ITEMS_LIMIT, mergeHistorySnapshot } from './history-sync';
import { HISTORY_ITEMS_LIMIT as HOST_HISTORY_ITEMS_LIMIT } from '../electron/ipc/store';
import { LIBRARY_CHANGE_ID_LIMIT as HOST_CHANGE_ID_LIMIT } from '../electron/library/types';
import { LIBRARY_CHANGE_ID_LIMIT, mergeLibraryChanges } from './asset-library/library-changes';
import { refreshLibraryReadModels } from './workspace/library-read-models';
import { DEFAULT_PARAMS, type HistoryItem, type HistoryItemsSnapshot } from './types';
import { waitUntil } from './test-support/wait-until';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, safeStorage: { isEncryptionAvailable: () => false } }));

const entry = (id: string, date = '2026-11-01', extra: Partial<HistoryItem> = {}): HistoryItem => ({ id, date, filePath: `/out/${id}.png`, fileUrl: `media://${id}`, createdAt: `${date}T00:00:00.000Z`, model: DEFAULT_PARAMS.model, width: 832, height: 1216, actualSeed: 1, params: { ...DEFAULT_PARAMS, positivePrompt: id }, ...extra });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('history merge', () => {
  it('takes fresh payloads for changed items, keeps the rest, follows the view order and reports what it lacks', () => {
    const previous = [entry('a'), entry('b'), entry('c'), entry('gone')];
    const result = mergeHistorySnapshot(previous, ['b', 'new', 'gone'], { order: ['new', 'a', 'b', 'x', 'c'], items: [entry('new'), entry('b', '2026-11-01', { groupId: 'g' })] });
    expect(result.history.map(item => item.id)).toEqual(['new', 'a', 'b', 'c']);
    expect(result.history[1]).toBe(previous[0]);
    expect(result.history[2].groupId).toBe('g');
    expect(result.missing).toEqual(['x']);
    // A changed item absent from the fresh payloads is not silently kept from the old list.
    expect(mergeHistorySnapshot(previous, ['a'], { order: ['a'], items: [] }).missing).toEqual(['a']);
    // The full refresh's per-item presentation (completed-image bridge) applies to every visible item.
    const bridged = mergeHistorySnapshot(previous, ['a'], { order: ['a', 'b'], items: [entry('a')] }, item => item.id === 'b' ? { ...item, fileUrl: 'data:bridge' } : item);
    expect(bridged.history.map(item => item.fileUrl)).toEqual(['media://a', 'data:bridge']);
    expect(() => mergeHistorySnapshot(previous, [], { items: [] } as unknown as HistoryItemsSnapshot)).toThrow();
  });

  it('uses one identity bound on both sides', () => {
    expect(HISTORY_ITEMS_LIMIT).toBe(HOST_HISTORY_ITEMS_LIMIT);
    expect(LIBRARY_CHANGE_ID_LIMIT).toBe(HOST_CHANGE_ID_LIMIT);
    expect(HISTORY_ITEMS_LIMIT).toBe(LIBRARY_CHANGE_ID_LIMIT);
  });
});

describe('background read models follow what changed', () => {
  const ports = () => ({ refreshSettings: vi.fn(async () => undefined), refreshHistoryItems: vi.fn(async (_ids: readonly string[] | null) => undefined) });
  const run = (events: unknown[]) => { const value = ports(); const reads = refreshLibraryReadModels(mergeLibraryChanges(events), value); return { ...value, reads: reads.length, models: reads.map(entry => entry.model) }; };
  it('maps kinds to settings and history; unknown refreshes both in full', () => {
    const history = run([{ changedKinds: ['history'], ids: ['h1', 'h2'] }]);
    expect(history.refreshHistoryItems).toHaveBeenCalledWith(['h1', 'h2']);
    expect(history.refreshSettings).not.toHaveBeenCalled();
    expect(run([{ changedKinds: ['history'] }]).refreshHistoryItems).toHaveBeenCalledWith(null);
    // An unrelated kind named without ids does not cost history its named ids.
    expect(run([{ changedKinds: ['history'], ids: ['h1'] }, { changedKinds: ['style_preset'] }]).refreshHistoryItems).toHaveBeenCalledWith(['h1']);
    for (const kind of ['style_preset', 'positive_preset', 'prompt_chunk']) { const value = run([{ changedKinds: [kind], ids: ['p'] }]); expect(value.refreshSettings).toHaveBeenCalledOnce(); expect(value.reads).toBe(1); }
    for (const kind of ['tag', 'combo', 'note', 'study', 'reference_preset', 'artist_favorite']) expect(run([{ changedKinds: [kind], ids: ['x'] }]).reads).toBe(0);
    expect(run([{ changedKinds: [], ids: [] }]).reads).toBe(0);
    const unknown = run([{ changedKinds: ['history'], ids: ['h1'] }, { revision: 3 }]);
    expect(unknown.models).toEqual(['settings', 'history']); expect(unknown.refreshHistoryItems).toHaveBeenCalledWith(null);
  });
});

describe('incremental history and full loads', () => {
  function api(overrides: Record<string, unknown> = {}) {
    return { getHistory: vi.fn(async () => [] as HistoryItem[]), getHistoryItems: vi.fn(async (): Promise<HistoryItemsSnapshot> => ({ items: [], removed: [], order: [] })), getHistoryDates: vi.fn(async () => ['2026-11-01']), getHistoryGroups: vi.fn(async () => []), setSetting: vi.fn(async () => ({})), ...overrides };
  }

  it('drops a late incremental result once a newer date selection started', async () => {
    const late = deferred<HistoryItemsSnapshot>();
    const naiDesktop = api({ getHistoryItems: vi.fn(() => late.promise), getHistory: vi.fn(async () => [entry('chosen', '2026-10-31')]) });
    vi.stubGlobal('window', { naiDesktop });
    useAppStore.setState({ selectedDate: '2026-11-01', history: [entry('a')] });
    const patch = useAppStore.getState().refreshHistoryItems(['b']);
    await waitUntil(() => expect(naiDesktop.getHistoryItems).toHaveBeenCalled());
    await useAppStore.getState().setSelectedDate('2026-10-31');
    late.resolve({ items: [entry('b')], removed: [], order: ['b', 'a'] });
    await patch;
    expect(useAppStore.getState()).toMatchObject({ selectedDate: '2026-10-31', history: [expect.objectContaining({ id: 'chosen' })] });
  });

  it('waits for a full load already in flight, then patches its possibly older result', async () => {
    const full = deferred<HistoryItem[]>();
    const naiDesktop = api({ getHistory: vi.fn(() => full.promise), getHistoryItems: vi.fn(async () => ({ items: [entry('b', '2026-11-01', { groupId: 'edited' })], removed: [], order: ['b', 'a'] })) });
    vi.stubGlobal('window', { naiDesktop });
    useAppStore.setState({ selectedDate: '2026-11-01' });
    const load = useAppStore.getState().refreshHistory();
    await waitUntil(() => expect(naiDesktop.getHistory).toHaveBeenCalled());
    const patch = useAppStore.getState().refreshHistoryItems(['b']);
    await Promise.resolve(); await Promise.resolve();
    expect(naiDesktop.getHistoryItems).not.toHaveBeenCalled();
    full.resolve([entry('a'), entry('b')]); // read before the change
    await Promise.all([load, patch]);
    expect(useAppStore.getState().history.map(item => [item.id, item.groupId])).toEqual([['b', 'edited'], ['a', undefined]]);
  });

  it('re-reads when the view moved without a load (the canvas showing a new image) and serializes overlapping requests', async () => {
    const first = deferred<HistoryItemsSnapshot>();
    const getHistoryItems = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async () => ({ items: [entry('n', '2026-11-02')], removed: [], order: ['n', 'm'] }))
      .mockImplementationOnce(async () => ({ items: [entry('m', '2026-11-02')], removed: [], order: [] }))
      .mockImplementationOnce(async () => ({ items: [entry('m', '2026-11-02', { groupId: 'g' })], removed: [], order: ['m', 'n'] }));
    vi.stubGlobal('window', { naiDesktop: api({ getHistoryItems }) });
    useAppStore.setState({ selectedDate: '2026-11-01', history: [entry('a')] });
    const one = useAppStore.getState().refreshHistoryItems(['n']);
    await waitUntil(() => expect(getHistoryItems).toHaveBeenCalledTimes(1));
    const two = useAppStore.getState().refreshHistoryItems(['m']);
    useAppStore.setState({ selectedDate: '2026-11-02', history: [entry('n', '2026-11-02')] });
    first.resolve({ items: [], removed: [], order: ['a'] });
    await Promise.all([one, two]);
    expect(getHistoryItems.mock.calls.map(([request]) => [request.ids, request.date, request.order])).toEqual([[['n'], '2026-11-01', undefined], [['n'], '2026-11-02', undefined], [['m'], '2026-11-02', false], [['m'], '2026-11-02', undefined]]);
    expect(useAppStore.getState().history.map(item => [item.id, item.groupId])).toEqual([['m', 'g'], ['n', undefined]]);
  });

  it('falls back to a full refresh without the host method, for too many identities, or when the view lacks too much', async () => {
    const naiDesktop = api({ getHistoryItems: undefined, getHistory: vi.fn(async () => [entry('full')]) });
    vi.stubGlobal('window', { naiDesktop });
    await useAppStore.getState().refreshHistoryItems(['x']);
    expect(naiDesktop.getHistory).toHaveBeenCalledOnce();
    const many = api({ getHistory: vi.fn(async () => [entry('full')]) });
    vi.stubGlobal('window', { naiDesktop: many });
    await useAppStore.getState().refreshHistoryItems(Array.from({ length: HISTORY_ITEMS_LIMIT + 1 }, (_, index) => `x${index}`));
    expect(many.getHistoryItems).not.toHaveBeenCalled(); expect(many.getHistory).toHaveBeenCalledOnce();
    const lacking = api({ getHistory: vi.fn(async () => [entry('full')]), getHistoryItems: vi.fn(async () => ({ items: [], removed: [], order: Array.from({ length: HISTORY_ITEMS_LIMIT + 1 }, (_, index) => `y${index}`) })) });
    vi.stubGlobal('window', { naiDesktop: lacking });
    await useAppStore.getState().refreshHistoryItems(['y0']);
    expect(lacking.getHistory).toHaveBeenCalledOnce();
    expect(useAppStore.getState().history.map(item => item.id)).toEqual(['full']);
  });

  it('after a save, patches the selected date and loads another date in full', async () => {
    const naiDesktop = api({ getHistory: vi.fn(async () => [entry('other', '2026-10-30')]), getHistoryItems: vi.fn(async () => ({ items: [entry('s')], removed: [], order: ['s'] })) });
    vi.stubGlobal('window', { naiDesktop });
    useAppStore.setState({ selectedDate: '2026-11-01' });
    await useAppStore.getState().refreshHistoryAfterSave(entry('s'));
    expect(naiDesktop.getHistory).not.toHaveBeenCalled();
    expect(useAppStore.getState().history.map(item => item.id)).toEqual(['s']);
    await useAppStore.getState().refreshHistoryAfterSave(entry('other', '2026-10-30'));
    expect(naiDesktop.getHistory).toHaveBeenCalledWith('2026-10-30', undefined);
    expect(useAppStore.getState()).toMatchObject({ selectedDate: '2026-10-30', history: [expect.objectContaining({ id: 'other' })] });
  });
});
