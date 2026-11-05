/** Danbooru metadata types of the main-process Danbooru service, shared by the material library
 * (tag search, single-tag samples and covers). The Danbooru gallery page itself was removed. */
export const DANBOORU_TAG_GROUPS = ["general", "artists", "characters", "copyrights", "meta"] as const;
export type DanbooruTagGroup = typeof DANBOORU_TAG_GROUPS[number];
export const DANBOORU_RATINGS = ["g", "s", "q", "e"] as const;
export type DanbooruRating = typeof DANBOORU_RATINGS[number];

/** Keep errors as data through Electron IPC and contextBridge. */
export type IpcResponse<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface DanbooruPost {
  postId: number;
  rating: DanbooruRating;
  sourceUrl: string;
  tags: Record<DanbooruTagGroup, string[]>;
  width: number;
  height: number;
  previewUrl: string;
  sampleUrl: string;
  score: number;
}

export interface DanbooruSearchResult {
  query: string;
  effectiveQuery: string;
  rating: DanbooruRating;
  page: number;
  limit: number;
  hasMore: boolean;
  items: DanbooruPost[];
  filteredCount: number;
}

export interface DanbooruImage {
  postId: number;
  mimeType: string;
  data: string;
  sourceUrl: string;
  imageUrl: string;
  variant: "preview" | "sample";
}

export interface DanbooruTagResult {
  query: string;
  items: Array<{ name: string; category: number; postCount: number; translation?: string; translationSource?: string; matchKind?: string; verified?: boolean; nsfw?: boolean; source: string }>;
  source: string;
  note?: string;
  verificationError?: { code: string; message: string };
}

export interface DanbooruService {
  search(args: { query: string; rating?: DanbooruRating; page?: number; limit?: number }): Promise<DanbooruSearchResult>;
  detail(args: { postId: number; rating?: DanbooruRating }): Promise<DanbooruPost>;
  image(args: { postId: number; rating?: DanbooruRating; variant?: "preview" | "sample" }): Promise<DanbooruImage>;
  tags(args: { query: string; limit?: number; category?: 'artist' }): Promise<DanbooruTagResult>;
}
