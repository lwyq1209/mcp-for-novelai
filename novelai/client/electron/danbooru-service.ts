/** Public Danbooru metadata and image transport for the material library (tag search, single-tag samples and covers). */
import { TAG_DICTIONARY, type createTagDictionary } from './search-tag-dictionary';
import { DANBOORU_RATINGS, type DanbooruRating } from '../src/workspace/danbooru-types';
import { USER_AGENT } from '../src/types';
const API = 'https://danbooru.donmai.us';
const MAX_JSON = 8 * 1024 * 1024;
const MAX_IMAGE = 20 * 1024 * 1024;
const CATEGORIES = new Set([0, 1, 3, 4, 5]);
type RecordValue = Record<string, any>;

/**
 * message: the text MCP has always read (unchanged); reason/params: the window's catalog text of the same refusal
 * (src/host-errors/danbooru.ts), rendered in the interface language (step 4c1). reason and params never cross the bridge.
 */
export class DanbooruError extends Error {
  constructor(public code: string, message: string, public reason?: string, public params?: Record<string, string | number>) { super(message); }
}
function fail(code: string, message: string, reason?: string, params?: Record<string, string | number>): never { throw new DanbooruError(code, message, reason, params); }
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('invalid_response', 'Danbooru 返回的数据格式无效。', 'danbooru.invalid_data');
  return value as RecordValue;
}
function int(value: unknown, fallback: number, min: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) return fail('invalid_arguments', '页码、数量或作品 ID 超出范围。', 'danbooru.range');
  return value as number;
}
function queryText(value: unknown) {
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f]/.test(value)) return fail('invalid_arguments', '搜索内容必须是最多 500 字符的单行文字。', 'danbooru.query_text');
  return value.trim();
}
function tagList(value: unknown): string[] {
  return typeof value === 'string' ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}
function rating(value: unknown, fallback: DanbooruRating = 'g'): DanbooruRating {
  const selected = value === undefined ? fallback : value;
  if (!DANBOORU_RATINGS.includes(selected as DanbooruRating)) return fail('invalid_arguments', '分级必须是 g、s、q 或 e。', 'danbooru.rating');
  return selected as DanbooruRating;
}
export function danbooruImageUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  let url: URL;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.donmai.us' || url.port || url.username || url.password || url.hash) return '';
  return url.href;
}
function parsePost(value: unknown, expectedRating: DanbooruRating) {
  const post = object(value);
  if (!DANBOORU_RATINGS.includes(post.rating) || post.rating !== expectedRating || post.is_deleted === true || post.is_banned === true) return fail('rating_blocked', `这条记录不属于当前选择的 rating:${expectedRating} 分级。`, 'danbooru.rating_blocked', { rating: expectedRating });
  const postId = int(post.id, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!postId) return fail('invalid_response', '作品 ID 缺失。', 'danbooru.post_id_missing');
  const width = int(post.image_width, 0, 1, 65535);
  const height = int(post.image_height, 0, 1, 65535);
  if (!width || !height || width * height > 64 * 1024 * 1024) return fail('invalid_image', '图片尺寸无效或超过 64 百万像素。', 'danbooru.image_size');
  const previewUrl = danbooruImageUrl(post.preview_file_url);
  const sampleUrl = [post.large_file_url, post.file_url].map(danbooruImageUrl).find(Boolean) ?? '';
  if (!sampleUrl || !previewUrl || !['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(String(post.file_ext).toLowerCase())) return fail('image_unavailable', '这条记录没有可读取的 Danbooru 静态预览。', 'danbooru.image_unavailable');
  return {
    postId, rating: expectedRating, sourceUrl: `${API}/posts/${postId}`, width, height, previewUrl, sampleUrl,
    score: Number.isFinite(post.score) ? Number(post.score) : 0,
    tags: { general: tagList(post.tag_string_general), artists: tagList(post.tag_string_artist), characters: tagList(post.tag_string_character), copyrights: tagList(post.tag_string_copyright), meta: tagList(post.tag_string_meta) },
  };
}
function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return fail('invalid_image', '远程响应不是支持的图片。', 'danbooru.image_type');
}

export function createDanbooruService(options: { fetchImpl?: typeof fetch; dictionary?: ReturnType<typeof createTagDictionary> } = {}) {
  // Resolve global fetch on each request so isolated acceptance can substitute
  // only the external transport, leaving IPC, renderer and the MCP tools real.
  const request = async (url: string, maxBytes: number, externalSignal?: AbortSignal, onBytes?: (length: number) => void) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    try {
      signal.throwIfAborted();
      const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
        headers: { 'User-Agent': `${USER_AGENT} (personal reference browser)`, Accept: maxBytes === MAX_JSON ? 'application/json' : 'image/*', Referer: `${API}/` },
        redirect: 'error', signal,
      });
      if (!response.ok) return fail('upstream_error', `Danbooru 请求失败（HTTP ${response.status}）。请修改搜索或稍后手动重试。`, 'danbooru.http', { status: response.status });
      if (response.redirected || (response.url && response.url !== url)) return fail('redirect_blocked', 'Danbooru 请求发生了未允许的跳转。', 'danbooru.redirect');
      const size = Number(response.headers.get('content-length'));
      if (size > maxBytes) return fail('too_large', '远程响应超过大小上限。', 'danbooru.too_large');
      const reader = response.body?.getReader();
      if (!reader) return fail('invalid_response', '远程响应为空。', 'danbooru.empty');
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maxBytes) { await reader.cancel(); return fail('too_large', '远程响应超过大小上限。', 'danbooru.too_large'); }
          onBytes?.(value.length);
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      return Buffer.concat(chunks);
    } catch (error) {
      if (error instanceof DanbooruError) throw error;
      return fail(signal.aborted ? 'upstream_timeout' : 'upstream_unavailable', signal.aborted ? 'Danbooru 请求超时；尚未重试。' : 'Danbooru 网络请求失败；尚未重试。', signal.aborted ? 'danbooru.timeout' : 'danbooru.network');
    } finally { clearTimeout(timer); controller.abort(); }
  };
  const json = async (pathname: string, params: Record<string, string | number> = {}, signal?: AbortSignal) => {
    const url = new URL(pathname, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const bytes = await request(url.href, MAX_JSON, signal);
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { return fail('invalid_response', 'Danbooru 返回的 JSON 无效。', 'danbooru.invalid_json'); }
  };
  const detail = async (raw: unknown, options: { signal?: AbortSignal } = {}) => {
    const args = object(raw); const postId = int(args.postId, 0, 1, Number.MAX_SAFE_INTEGER);
    if (!postId) return fail('invalid_arguments', '需要作品 ID。', 'danbooru.post_id_required');
    const expectedRating = rating(args.rating);
    const item = parsePost(await json(`/posts/${postId}.json`, {}, options.signal), expectedRating);
    if (item.postId !== postId) return fail('invalid_response', 'Danbooru 返回了不同的作品。', 'danbooru.other_post');
    return item;
  };
  return {
    async search(raw: unknown) {
      const args = object(raw); const query = queryText(args.query);
      const page = int(args.page, 1, 1, 1000); const limit = int(args.limit, 12, 1, 30); const selectedRating = rating(args.rating);
      const tokens = query.split(/\s+/).filter(Boolean);
      const ratingTokens = tokens.filter(token => /^-?rating:/i.test(token));
      if (ratingTokens.some(token => token.toLowerCase() !== `rating:${selectedRating}`) || ratingTokens.length > 1) return fail('invalid_arguments', '查询中的 rating 必须与单独选择的分级一致。', 'danbooru.rating_query');
      const effectiveQuery = [...tokens.filter(token => !/^-?rating:/i.test(token)), `rating:${selectedRating}`].join(' ');
      const rawPosts = await json('/posts.json', { tags: effectiveQuery, page, limit });
      if (!Array.isArray(rawPosts)) return fail('invalid_response', 'Danbooru 没有返回作品列表。', 'danbooru.no_posts');
      if (rawPosts.length > limit) return fail('invalid_response', 'Danbooru 返回数量超过请求页大小。', 'danbooru.too_many');
      const items: ReturnType<typeof parsePost>[] = [];
      for (const post of rawPosts) {
        try { const item = parsePost(post, selectedRating); if (!items.some(existing => existing.postId === item.postId)) items.push(item); }
        catch (error) { if (!(error instanceof DanbooruError)) throw error; }
      }
      return { query, effectiveQuery, rating: selectedRating, page, limit, hasMore: rawPosts.length >= limit, items, filteredCount: rawPosts.length - items.length };
    },
    detail,
    async image(raw: unknown, options: { signal?: AbortSignal; onImageBytes?: (length: number) => void } = {}) {
      const args = object(raw); const variant = args.variant ?? 'sample';
      if (variant !== 'sample' && variant !== 'preview') return fail('invalid_arguments', '图片类型只能是 sample 或 preview。', 'danbooru.variant');
      // Recheck the record before fetching; a stale cached rating is insufficient.
      const item = await detail(args, options);
      const imageUrl = variant === 'preview' ? item.previewUrl : item.sampleUrl;
      const bytes = await request(imageUrl, MAX_IMAGE, options.signal, options.onImageBytes);
      return { postId: item.postId, mimeType: imageType(bytes), data: bytes.toString('base64'), sourceUrl: item.sourceUrl, imageUrl, variant };
    },
    async tags(raw: unknown) {
      const args = object(raw); const query = queryText(args.query); const limit = int(args.limit, 12, 1, 50);
      if (args.category !== undefined && args.category !== 'artist') return fail('invalid_arguments', '候选类别仅支持 artist。', 'danbooru.category');
      const category = args.category === 'artist' ? 1 : undefined;
      if (!query) return fail('invalid_arguments', '请输入标签文字。', 'danbooru.tag_required');
      if (/[\u3400-\u9fff]/.test(query)) {
        const matches = options.dictionary ? await options.dictionary.search(query, category === 1 ? 50 : limit) : null;
        const candidates = matches?.filter(item => category === undefined || item.category === category).slice(0, limit) ?? matches;
        if (candidates === null) return { query, items: [], source: 'dictionary-unavailable', note: '中文辅助词库尚未安装；可先输入英文标签，或运行本路线的词库安装脚本。' };
        if (!candidates.length) return { query, items: [], source: 'DanbooruSearchOnline', note: '词库没有匹配项；请换一个短词，或用英文标签检索。' };
        let rawTags: any;
        try { rawTags = await json('/tags.json', { 'search[name_normalize]': candidates.map(item => item.name).join(','), limit }); }
        catch (error) {
          if (!(error instanceof DanbooruError)) throw error;
          return { query, items: candidates.map(candidate => ({ name: candidate.name, category: candidate.category, postCount: candidate.postCount, source: 'DanbooruSearchOnline', translation: candidate.translation, translationSource: `DanbooruSearchOnline@${TAG_DICTIONARY.commit}`, matchKind: candidate.matchKind, nsfw: candidate.nsfw, verified: false })), source: 'DanbooruSearchOnline', dictionary: TAG_DICTIONARY, verificationError: { code: error.code, message: error.message }, note: '官网核对未完成；这些是固定版第三方词库候选，英文名、分类和数量尚未实时确认。' };
        }
        if (!Array.isArray(rawTags) || rawTags.length > limit) return fail('invalid_response', 'Danbooru 标签核对响应无效。', 'danbooru.tag_check');
        const items = candidates.flatMap(candidate => {
          const tag = rawTags.find(tag => tag && tag.name === candidate.name && CATEGORIES.has(tag.category) && (category === undefined || tag.category === category) && tag.is_deprecated !== true);
          if (!tag) return [];
          return [{ name: tag.name, category: tag.category, postCount: Number.isFinite(tag.post_count) ? tag.post_count : 0, source: 'danbooru-api', translation: candidate.translation, translationSource: `DanbooruSearchOnline@${TAG_DICTIONARY.commit}`, matchKind: candidate.matchKind, nsfw: candidate.nsfw, verified: true }];
        });
        return { query, items, source: 'danbooru-api+DanbooruSearchOnline', dictionary: TAG_DICTIONARY, filteredCount: candidates.length - items.length, note: '英文标签已由官网核对；中文主译名和扩展别名由第三方整理，主译名精确匹配优先。' };
      }
      if (!/^[\w\-().!+\/' ]+$/u.test(query)) return fail('invalid_arguments', '请输入单个标签前缀，不包含搜索操作符。', 'danbooru.tag_prefix');
      const rawTags = await json('/tags.json', { 'search[name_matches]': `${category === 1 ? '*' : ''}${query.replaceAll(' ', '_')}*`, 'search[order]': 'count', ...(category === undefined ? {} : { 'search[category]': category }), limit });
      if (!Array.isArray(rawTags)) return fail('invalid_response', 'Danbooru 没有返回标签列表。', 'danbooru.no_tags');
      if (rawTags.length > limit) return fail('invalid_response', 'Danbooru 返回数量超过标签请求上限。', 'danbooru.too_many_tags');
      const items = rawTags.filter(tag => tag && typeof tag.name === 'string' && CATEGORIES.has(tag.category) && (category === undefined || tag.category === category) && tag.is_deprecated !== true).map(tag => ({ name: tag.name, category: tag.category, postCount: Number.isFinite(tag.post_count) ? tag.post_count : 0, source: 'danbooru-api' }));
      if (!options.dictionary) return { query, items, source: 'danbooru-api' };
      let translations: Awaited<ReturnType<NonNullable<typeof options.dictionary>['lookup']>>;
      try { translations = await options.dictionary.lookup(items.map(item => item.name)); }
      catch {
        return { query, items, source: 'danbooru-api', note: '英文标签查询成功，但本地中文辅助词库校验或读取失败；未附中文释义。', translationError: { code: 'dictionary_unavailable' } };
      }
      return { query, items: items.map(item => {
        const entry = translations.get(item.name);
        return entry ? { ...item, translation: entry.translation, translationSource: `DanbooruSearchOnline@${TAG_DICTIONARY.commit}`, nsfw: entry.nsfw, verified: true } : { ...item, verified: true };
      }), source: 'danbooru-api' };
    },
  };
}
