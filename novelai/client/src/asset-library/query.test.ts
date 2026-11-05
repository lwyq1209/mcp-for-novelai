import { afterEach, describe, expect, it, vi } from 'vitest';
import { onlineManager, QueryObserver } from '@tanstack/react-query';
import { assetQueryClient, assetQueryKey, invalidateAssetQueries, readAssetQuery, watchAssetLibraryChanges } from './query';
import { waitUntil } from '../test-support/wait-until';

afterEach(() => { assetQueryClient.clear(); onlineManager.setOnline(true); });
describe('local material query policy', () => {
  it('reads local IPC while offline, deduplicates readers, and never retries failures', async () => {
    onlineManager.setOnline(false);
    const api = {}, call = vi.fn(async () => ({ revision: 1 })), key = assetQueryKey(api, 'list');
    await Promise.all([readAssetQuery(key, call), readAssetQuery(key, call)]);
    expect(call).toHaveBeenCalledTimes(1);
    const failure = vi.fn(async () => { throw new Error('storage failed'); });
    await expect(readAssetQuery(assetQueryKey(api, 'missing'), failure)).rejects.toThrow('storage failed');
    expect(failure).toHaveBeenCalledTimes(1);
    expect(assetQueryClient.getDefaultOptions().queries).toMatchObject({ refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false, networkMode: 'always' });
    expect(assetQueryClient.getDefaultOptions().mutations).toMatchObject({ retry: false, networkMode: 'always' });
  });
  it('a host change supersedes a slow first read without accepting its late response', async () => {
    let resolveOld!: (value: { revision: number }) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ revision: 2 });
    const key = assetQueryKey({}, 'list'), observer = new QueryObserver(assetQueryClient, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitUntil(() => expect(read).toHaveBeenCalledTimes(1));
    await invalidateAssetQueries();
    expect(assetQueryClient.getQueryData(key)).toEqual({ revision: 2 });
    resolveOld({ revision: 1 }); await Promise.resolve(); await Promise.resolve();
    expect(assetQueryClient.getQueryData(key)).toEqual({ revision: 2 }); unsubscribe();
  });
  it('panels share one host listener until the final panel releases it', async () => {
    let listener!: (event: unknown) => void;
    const unsubscribe = vi.fn(), api = { onAssetLibraryChange: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }) };
    const stop = watchAssetLibraryChanges(api), stopOther = watchAssetLibraryChanges(api);
    expect(api.onAssetLibraryChange).toHaveBeenCalledOnce();
    listener({ revision: 5 }); await Promise.resolve();
    stop(); stop(); expect(unsubscribe).not.toHaveBeenCalled();
    stopOther(); expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
