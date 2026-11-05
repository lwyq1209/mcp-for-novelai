import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store';
import { creativeMode, useWorkbenchNavigation } from './workbench-navigation';

// localStorage entries this version does not write (here shaped like the per-page state of a feature that no
// longer exists) are neither read nor changed: the app boots onto the creative workbench as usual.
const pageId = '00000000-0000-4000-8000-000000000001';
const LEFTOVER: Record<string, string> = {
  'nai.unknown-feature.recovery.v1': JSON.stringify([{ requestKey: 'page-2b8f', pageId, createdAt: '2026-09-20T00:00:00.000Z', planId: null }]),
  [`nai-unknown-view-v1:${pageId}`]: JSON.stringify({ version: 1, filter: { includeArchived: false }, items: [], page: 0, cursors: [null], scroll: 120, view: 'all' }),
  [`nai-unknown-execution-v1:${pageId}`]: JSON.stringify({ intentId: '00000000-0000-4000-8000-0000000000aa' }),
  [`nai-unknown-pending-v1:${pageId}`]: JSON.stringify([]),
};

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial)), reads: string[] = [];
  return {
    reads,
    values,
    getItem: (key: string) => { reads.push(key); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    clear: () => values.clear(),
  };
}
function naiDesktop() {
  return {
    onGenerationPreview: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn(() => vi.fn()),
    getSettings: vi.fn().mockResolvedValue({ language: 'zh-CN', persistGenerateParams: true, persistI2IParams: true, persistInpaintParams: true, persistUpscaleParams: true, persistDirectorParams: true }),
    accountCached: vi.fn().mockResolvedValue({ hasToken: false }),
    isFirstRun: vi.fn().mockResolvedValue(false),
    getHistoryDates: vi.fn().mockResolvedValue([]),
    getHistoryGroups: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue([]),
  };
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useWorkbenchNavigation.setState({ lastCreative: 't2i' });
});
afterEach(() => vi.unstubAllGlobals());

describe('a profile carrying localStorage entries this version does not write', () => {
  it('boots onto the creative workbench and leaves those entries unread and untouched', async () => {
    const local = storage(LEFTOVER);
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('window', { naiDesktop: naiDesktop(), localStorage: local });
    await useAppStore.getState().load();
    const state = useAppStore.getState();
    expect(state.bootDone).toBe(true);
    expect(state.bootError).toBeNull();
    expect(state.activeTab).toBe('generate');
    expect(creativeMode(state)).toBe('t2i');
    expect(local.reads.filter(key => Object.hasOwn(LEFTOVER, key))).toEqual([]);
    expect(Object.fromEntries([...local.values].filter(([key]) => Object.hasOwn(LEFTOVER, key)))).toEqual(LEFTOVER);
  });
});
