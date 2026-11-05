import { describe, expect, it, vi } from 'vitest';
import type { AssetItem } from '../asset-library/types';
import { setCoverFromHistory } from './HistoryCoverPicker';

describe('a history image as a tag cover (step 4c1)', () => {
  it('reads the exact registered original, then saves it through the ordinary local cover save with the read revisions', async () => {
    const api = {
      assetLibrary: vi.fn(async () => ({ data: 'iVBORw0KGgo=', mimeType: 'image/png' })),
      materialSamples: vi.fn(async () => ({ entry: { coverRevision: 2 } })),
    };
    const image = { kind: 'history', id: 'h/1', revision: 3, name: 'x', payload: {}, preview: { assetId: 'path:abc', role: 'original', cacheKey: 'k' } } as unknown as AssetItem;
    await setCoverFromHistory(api as never, { id: 'tag-1', revision: 5, coverRevision: 1 }, image);
    expect(api.assetLibrary).toHaveBeenCalledWith({ action: 'image', kind: 'history', id: 'h/1', revision: 3, assetId: 'path:abc', variant: 'original' });
    expect(api.materialSamples).toHaveBeenCalledWith({ action: 'set_local_cover', entryId: 'tag-1', revision: 5, expectedCoverRevision: 1, fileName: 'history-h_1-r3.png', data: 'iVBORw0KGgo=' });
  });
  it('an image without a registered original is refused before any read', async () => {
    const api = { assetLibrary: vi.fn(), materialSamples: vi.fn() };
    await expect(setCoverFromHistory(api as never, { id: 't', revision: 1, coverRevision: 0 }, { kind: 'history', id: 'h', revision: 1, payload: {} } as unknown as AssetItem)).rejects.toMatchObject({ reason: 'library.history_image_unregistered' });
    expect(api.assetLibrary).not.toHaveBeenCalled();
  });
});
