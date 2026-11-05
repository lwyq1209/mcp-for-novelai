import type { AssetLibraryRequest, LibraryKind } from '../contracts/generated/library-contracts.mjs';
export type AssetCategory = 'history' | 'imports' | 'tags' | 'presets' | 'notes';
export type AssetLibraryPublicRequest = Exclude<AssetLibraryRequest, { action: 'list' }>
  | (Extract<AssetLibraryRequest, { action: 'list' }> & { category?: AssetCategory });
export const ASSET_CATEGORY_KINDS: Readonly<Record<AssetCategory, readonly LibraryKind[]>>;
export const ASSET_CATEGORY_GUIDANCE: string;
export const assetLibraryPublicSchema: { type: 'object'; description: string; properties: Record<string, unknown>; anyOf: unknown[]; additionalProperties: false };
export const assetLibraryFlatSchema: { type: 'object'; properties: Record<string, unknown>; required: ['action']; additionalProperties: false };
export const ASSET_LIBRARY_DESCRIPTION: string;
export function assetCategoryForKind(kind: string): AssetCategory | undefined;
export function normalizeAssetLibraryRequest(value: unknown): AssetLibraryRequest;
