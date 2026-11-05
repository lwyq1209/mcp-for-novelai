import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSET_CATEGORY_KINDS, assetCategoryForKind, normalizeAssetLibraryRequest } from '../src/asset-library-categories.mjs';

// The ten-kind taxonomy of asset_library's `category`. Until step 4c2 this compared it with the old material browser's
// category module (client/src/asset-library/material-categories.ts), which was removed with that browser; the
// taxonomy it mirrored is written out here, so the MCP side keeps the same guard.
const EXPECTED = {
  history: ['history'],
  imports: ['study'],
  tags: ['tag', 'artist_favorite'],
  presets: ['combo', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'],
  notes: ['note'],
};

test('both public MCP routes share exactly the same ten-kind taxonomy', () => {
  assert.deepEqual(ASSET_CATEGORY_KINDS, EXPECTED);
  assert.equal(Object.values(EXPECTED).flat().length, 10);
  for (const [category, kinds] of Object.entries(EXPECTED)) {
    assert.deepEqual(normalizeAssetLibraryRequest({ action: 'list', category }).kinds, kinds);
    for (const kind of kinds) assert.equal(assetCategoryForKind(kind), category);
  }
  assert.equal(assetCategoryForKind('combo'), 'presets');
});
