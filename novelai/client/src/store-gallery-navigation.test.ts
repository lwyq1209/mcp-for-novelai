import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from './store';
import { DEFAULT_PARAMS, type HistoryItem } from './types';
import { waitUntil } from './test-support/wait-until';

const artwork: HistoryItem = { id: 'editing-fern', filePath: '/fixtures/fern.png', fileUrl: 'fixture://fern', date: '2026-09-12', createdAt: '2026-09-12T00:00:00.000Z', model: DEFAULT_PARAMS.model, width: 832, height: 1216, actualSeed: 0, params: { ...DEFAULT_PARAMS, seed: 456, seedMode: 'random', positivePrompt: 'a green fern in watercolor' } };
const listed: HistoryItem = { ...artwork, id: 'listed-teacup', filePath: '/fixtures/teacup.png', fileUrl: 'fixture://teacup' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ currentImage: artwork, history: [artwork], selectedDate: 'current-date', selectedGroupId: 'current-group', params: { ...DEFAULT_PARAMS, positivePrompt: 'Keep my current prose', stylePrompt: 'pencil sketch', seed: 999 }, charCaptions: [{ id: 'gardener', prompt: 'adult gardener', negativePrompt: '', useCoords: false, x: .5, y: .5 }], workbenchImage: { filePath: '/fixtures/source.png', fileUrl: 'fixture://source', width: 832, height: 1216 }, inpaintMask: 'SFW-fixture-mask', activeTab: 'generate' });
});
afterEach(() => vi.unstubAllGlobals());

describe('gallery filtering and explicit source loading', () => {
  it('filters dates and groups without changing the canvas, prompt, source, mask or characters', async () => {
    const getHistory = vi.fn().mockResolvedValue([listed]), setSetting = vi.fn().mockResolvedValue({});
    vi.stubGlobal('window', { naiDesktop: { getHistory, setSetting } });
    const before = useAppStore.getState();
    await before.setSelectedDate('other-date'); await useAppStore.getState().setSelectedGroupId('other-group');
    const state = useAppStore.getState();
    expect(state).toMatchObject({ selectedDate: 'other-date', selectedGroupId: 'other-group', history: [listed] });
    for (const key of ['currentImage', 'params', 'workbenchImage', 'inpaintMask', 'charCaptions', 'inpaintRecipe', 'comparisonBeforeImage'] as const) expect(state[key]).toBe(before[key]);
    expect(getHistory).toHaveBeenLastCalledWith('other-date', 'other-group');
  });

  it('uses the latest combined date/group filter when responses arrive out of order', async () => {
    const oldDate = deferred<HistoryItem[]>(), oldGroup = deferred<HistoryItem[]>(), latest = deferred<HistoryItem[]>();
    const getHistory = vi.fn().mockReturnValueOnce(oldDate.promise).mockReturnValueOnce(oldGroup.promise).mockReturnValueOnce(latest.promise);
    vi.stubGlobal('window', { naiDesktop: { getHistory, setSetting: vi.fn().mockResolvedValue({}) } });
    const first = useAppStore.getState().setSelectedDate('early-day');
    const second = useAppStore.getState().setSelectedGroupId('new-group');
    const third = useAppStore.getState().setSelectedDate('latest-day');
    expect(getHistory.mock.calls).toEqual([['early-day', 'current-group'], ['early-day', 'new-group'], ['latest-day', 'new-group']]);
    latest.resolve([listed]); await third;
    oldDate.resolve([artwork]); oldGroup.resolve([]); await Promise.all([first, second]);
    expect(useAppStore.getState()).toMatchObject({ selectedDate: 'latest-day', selectedGroupId: 'new-group', history: [listed], currentImage: artwork });
  });

  it('keeps a slow earlier refresh from changing a later explicit filter', async () => {
    const old = deferred<HistoryItem[]>();
    const getHistory = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce([listed]);
    vi.stubGlobal('window', { naiDesktop: { getHistory, getHistoryDates: vi.fn().mockResolvedValue(['old-day']), getHistoryGroups: vi.fn().mockResolvedValue([]) } });
    const refresh = useAppStore.getState().refreshHistory('old-day');
    await waitUntil(() => expect(getHistory).toHaveBeenCalledOnce());
    await useAppStore.getState().setSelectedDate('chosen-day'); old.resolve([artwork]); await refresh;
    expect(useAppStore.getState()).toMatchObject({ selectedDate: 'chosen-day', history: [listed], currentImage: artwork });
  });

  it('serializes group preference writes so an older selection cannot be persisted last', async () => {
    const oldWrite = deferred<unknown>();
    const setSetting = vi.fn().mockReturnValueOnce(oldWrite.promise).mockResolvedValueOnce({});
    vi.stubGlobal('window', { naiDesktop: { getHistory: vi.fn().mockResolvedValue([listed]), setSetting } });
    const first = useAppStore.getState().setSelectedGroupId('earlier');
    await waitUntil(() => expect(setSetting).toHaveBeenCalledWith('activeHistoryGroupId', 'earlier'));
    const second = useAppStore.getState().setSelectedGroupId('latest');
    await Promise.resolve(); expect(setSetting).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().selectedGroupId).toBe('latest');
    oldWrite.resolve({}); await Promise.all([first, second]);
    expect(setSetting.mock.calls).toEqual([['activeHistoryGroupId', 'earlier'], ['activeHistoryGroupId', 'latest']]);
    expect(useAppStore.getState().currentImage).toBe(artwork);
  });

  it.each(['picker', 'path', 'path-false'] as const)('loads %s image pixels without implicitly applying embedded prompt, Style, seed or characters', async mode => {
    const result = { ok: true, image: { filePath: '/fixtures/new-source.png', fileUrl: 'fixture://new-source', width: 832, height: 1216 }, metadata: { imported: { positivePrompt: 'Embedded prose', stylePrompt: 'oil painting', seed: 12 }, characterCaptions: [] } };
    vi.stubGlobal('window', { naiDesktop: { loadImage: vi.fn().mockResolvedValue(result), loadImageFromPath: vi.fn().mockResolvedValue(result) } });
    const before = useAppStore.getState();
    if (mode === 'picker') await before.loadWorkbenchImage();
    else await before.loadWorkbenchFromPath(result.image.filePath, mode === 'path-false' ? { restoreMetadata: false } : undefined);
    const after = useAppStore.getState();
    expect(after.workbenchImage).toEqual(result.image);
    for (const key of ['params', 'charCaptions', 'currentImage', 'vibeImages', 'preciseReferences'] as const) expect(after[key]).toBe(before[key]);
  });

  it('retains the explicitly requested metadata restore path', async () => {
    vi.stubGlobal('window', { naiDesktop: { loadImageFromPath: vi.fn().mockResolvedValue({ ok: true, image: { filePath: '/fixtures/import.png', fileUrl: 'fixture://import', width: 832, height: 1216 }, metadata: { imported: { positivePrompt: 'Explicitly reviewed fern', seed: 0 }, characterCaptions: [] } }) } });
    await useAppStore.getState().loadWorkbenchFromPath('/fixtures/import.png', { restoreMetadata: true });
    expect(useAppStore.getState().params).toMatchObject({ positivePrompt: 'Explicitly reviewed fern', seed: 0 });
  });

  it('locks a variation to actual seed zero instead of the saved pre-random seed', () => {
    useAppStore.getState().variationFromImage(artwork);
    expect(useAppStore.getState().params).toMatchObject({ seed: 0, seedMode: 'fixed', positivePrompt: artwork.params.positivePrompt });
  });
});
