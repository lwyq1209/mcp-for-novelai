import type { LibraryItem, LibraryKind, AssetPreview, AssetVersionSummary, AssetVersions, AssetThumbnail, AssetLibraryDesktopRequest, AssetLibraryRequest, HistoryTag, HistoryTagCoverage } from '../generated/library-contracts.mjs' with { 'resolution-mode': 'import' };
export type AssetKind = LibraryKind;
/** The generic browser enumerates fields; domain editors use the generated discriminated union. */
export type AssetItem = Omit<LibraryItem, 'payload'> & { payload: LibraryItem['payload'] & Record<string, any>; preview?: AssetPreview; matchedTags?: HistoryTag[] };
export type { AssetPreview, AssetVersionSummary, AssetVersions, AssetThumbnail, AssetLibraryDesktopRequest, AssetLibraryRequest, HistoryTag, HistoryTagCoverage };
export interface AssetCollection { id: string; name: string; revision?: number; namespace?: string }
export interface AssetList { items: AssetItem[]; total: number; offset: number; limit: number; hasMore: boolean; revision: number }
export interface AssetDetail { item: AssetItem; assets: Array<{ id?: string; role?: string; filePath?: string; fileUrl?: string; mimeType?: string; sha256?: string; byteLength?: number }>; links: unknown[]; tags?: HistoryTag[]; tagCoverage?: HistoryTagCoverage }
export interface AssetLibraryApi { exportAssetImages?: (args: import('./image-export').ImageExportRequest) => Promise<import('./image-export').ImageExportResult>; assetLibrary(args: Record<string, unknown>): Promise<any>; onAssetLibraryChange?: (listener: (event: unknown) => void) => (() => void) }
export const ASSET_KIND_NAMES: Record<AssetKind, string> = { tag: '标签', combo: '组合', note: '心得', study: '研读作品', history: '生成历史', artist_favorite: '画师收藏', style_preset: 'Style 预设', positive_preset: '正文预设', prompt_chunk: '提示词片段', reference_preset: '参考预设' };
export const assetIdentity = (item: Pick<AssetItem, 'kind'|'id'>) => `${item.kind}:${item.id}`;
