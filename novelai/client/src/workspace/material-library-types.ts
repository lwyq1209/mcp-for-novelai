import type { DanbooruImage, DanbooruPost, DanbooruRating, DanbooruTagResult } from './danbooru-types';

export type MaterialKind = 'tag' | 'combo' | 'note';
export type MaterialSource = 'danbooru' | 'nai' | 'english';
export type MaterialTarget = 'style' | 'base' | 'character';
export type MaterialSampleSort = 'score' | 'newest' | 'oldest';
export interface MaterialTagEvidence {
  checkedAt: string | null;
  canonicalName: string | null;
  resolution: string;
  tagStatus: string;
  category: string | null;
  postCount: number | null;
  deprecated: boolean | null;
  aliasStatus: string;
  aliases?: Array<{ from: string; to: string }>;
  wiki: { status: string; body?: string; format?: string; truncated?: boolean };
  sources: string[];
  errors?: Array<{ stage: string; code: string; message: string }>;
}
export interface MaterialTag {
  text: string;
  source: MaterialSource;
  category: string | null;
  target: MaterialTarget;
  evidence?: MaterialTagEvidence;
}
export interface MaterialComponent {
  text: string;
  source: MaterialSource;
  category?: string | null;
  weight: number;
  target: MaterialTarget;
  entryId?: string;
  entryRevision?: number;
}
export interface MaterialLink { batchId?: string; itemIndex?: number; feedback?: string; studyId?: string; sourceSha256?: string; field?: string; excerpt?: string }
export interface MaterialEntryInput {
  kind: MaterialKind;
  name: string;
  group?: string;
  notes?: string;
  tag?: MaterialTag;
  components?: MaterialComponent[];
  links?: MaterialLink[];
}
export interface MaterialEntry extends MaterialEntryInput {
  schemaVersion: 1;
  id: string;
  revision: number;
  group: string;
  notes: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  coverRevision?: number;
  cover?: MaterialCover | null;
  coverStatus?: MaterialCoverStatus;
}
export interface MaterialSummary {
  id: string;
  revision: number;
  kind: MaterialKind;
  name: string;
  group: string;
  notesPreview: string;
  archived: boolean;
  updatedAt: string;
  tag?: { text: string; source: MaterialSource; category: string | null; target: MaterialTarget; postCount: number | null; resolution: string; checkedAt: string | null };
  componentCount?: number;
  coverRevision?: number;
  cover?: MaterialCover | null;
  coverStatus?: MaterialCoverStatus;
}
export type MaterialCoverStatus = 'none' | 'ready' | 'stale' | 'unavailable';
interface MaterialCoverBase {
  sha256: string;
  mimeType: 'image/webp';
  width: number;
  height: number;
  byteLength: number;
  tagText: string;
  tagCategory: string | null;
  savedAt: string;
  importedAt?: string;
}
export interface MaterialDanbooruCover extends MaterialCoverBase {
  source?: 'danbooru';
  postId: number;
  sourceUrl: string;
  rating: DanbooruRating;
  verification: 'online' | 'imported';
  checkedAt: string | null;
}
export interface MaterialLocalCover extends MaterialCoverBase {
  source: 'local';
  fileName: string;
  sourceSha256: string;
  tagSource: MaterialSource;
  postId: null;
  sourceUrl: null;
  rating: null;
  verification: 'local' | 'imported';
  checkedAt: null;
}
export type MaterialCover = MaterialDanbooruCover | MaterialLocalCover;
export interface MaterialCoverState { entryId: string; entryRevision: number; coverRevision: number; cover: MaterialCover | null; coverStatus: MaterialCoverStatus }
export interface MaterialCoverImage extends MaterialCoverState { mimeType: 'image/webp'; data: string }
export interface MaterialBackupCover { entryId: string; cover: MaterialCover; data: string }
export interface MaterialListResult { items: MaterialSummary[]; total: number; offset: number; limit: number; hasMore: boolean }
export interface MaterialBackup { schemaVersion: 1; entries: MaterialEntry[]; covers?: MaterialBackupCover[] }
export type MaterialLibraryRequest =
  | { action: 'list'; query?: string; kind?: MaterialKind; group?: string; includeArchived?: boolean; offset?: number; limit?: number }
  | { action: 'read'; id: string; revision?: number }
  | { action: 'save'; entry: MaterialEntryInput; id?: string; expectedRevision?: number; refreshEvidence?: boolean }
  | { action: 'archive'; id: string; expectedRevision: number; archived?: boolean }
  | { action: 'export'; ids?: string[] }
  | { action: 'import'; data: MaterialBackup };
export type MaterialLibraryResult = MaterialListResult | { entry: MaterialEntry } | { data: MaterialBackup } | { items: MaterialSummary[]; count: number };
export type MaterialTagsRequest =
  | { action: 'search'; query: string; limit?: number; category?: 'artist' }
  | { action: 'details'; name?: string; names?: string[] };
export type MaterialTagsResult = DanbooruTagResult | { source: string; detail: string; checkedAt: string | null; count: number; items: Array<MaterialTagEvidence & { name: string }> };
export type MaterialSamplesRequest =
  | { action: 'list'; entryId: string; revision?: number; page?: number; limit?: number; minScore?: number; rating?: DanbooruRating }
  | { action: 'list_all'; entryId: string; revision?: number; page?: number; limit?: number; minScore?: number; sort?: MaterialSampleSort }
  | { action: 'image'; entryId: string; revision?: number; postId: number; variant?: 'preview' | 'sample'; minScore?: number; rating?: DanbooruRating }
  | { action: 'set_cover'; entryId: string; revision: number; postId: number; expectedCoverRevision: number; minScore?: number; rating?: DanbooruRating }
  | { action: 'set_local_cover'; entryId: string; revision: number; expectedCoverRevision: number; fileName: string; data: string }
  | { action: 'cover'; entryId: string }
  | { action: 'clear_cover'; entryId: string; expectedCoverRevision: number };
export type MaterialSampleImage = DanbooruImage & { rating: DanbooruRating };
export interface MaterialSamplesResult {
  entryId: string;
  entryRevision: number;
  page: number;
  limit: number;
  hasMore: boolean;
  minScore: number;
  rating: DanbooruRating | 'all';
  sort?: MaterialSampleSort;
  filteredCount: number;
  items: Array<Omit<DanbooruPost, 'tags'>>;
}
export interface MaterialLibraryApi {
  materialLibrary(args: MaterialLibraryRequest): Promise<MaterialLibraryResult>;
  materialTags(args: MaterialTagsRequest): Promise<MaterialTagsResult>;
  materialSamples(args: MaterialSamplesRequest): Promise<MaterialSamplesResult | MaterialSampleImage | MaterialCoverState | MaterialCoverImage>;
}
