import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDanbooruService, danbooruImageUrl } from './danbooru-service';
import { TAG_DICTIONARY, type createTagDictionary } from './search-tag-dictionary';
import { APP_VERSION } from '../src/types';

// Synthetic SFW metadata and a one-pixel PNG. No test contacts a public service.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const PREVIEW = 'https://cdn.donmai.us/180x180/fixture.png';
const SAMPLE = 'https://cdn.donmai.us/sample/fixture.png';
function post(overrides: Record<string, unknown> = {}) {
  return { id: 42, rating: 'g', is_deleted: false, is_banned: false, image_width: 1, image_height: 1, file_ext: 'png', preview_file_url: PREVIEW, large_file_url: SAMPLE, file_url: 'https://cdn.donmai.us/original/fixture.png', score: 4, tag_string_general: 'tree sky tree', tag_string_artist: 'sample_artist', tag_string_character: 'sample_character', tag_string_copyright: 'sample_series', tag_string_meta: 'highres', ...overrides };
}
function json(value: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init }); }
function transport(...responses: Array<Response | Error>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request');
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetchImpl, service: createDanbooruService({ fetchImpl }) };
}
function dictionary(entries: any[] = []) {
  return { search: vi.fn(async () => entries), lookup: vi.fn(async () => new Map(entries.map(entry => [entry.name, entry]))) } as unknown as ReturnType<typeof createTagDictionary>;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Danbooru public metadata admission', () => {
  it('filters artists in the official query before limiting results, preserving old prefix search', async () => {
    const { service, fetchImpl } = transport(json([{ name: 'sample_artist', category: 1, post_count: 42 }, { name: 'sample_general', category: 0, post_count: 99 }]), json([]));
    expect((await service.tags({ query: 'sample', category: 'artist', limit: 2 })).items.map(item => item.name)).toEqual(['sample_artist']);
    const artist = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(artist.searchParams.get('search[category]')).toBe('1');
    expect(artist.searchParams.get('search[name_matches]')).toBe('*sample*');
    await service.tags({ query: 'sample', limit: 2 });
    const normal = new URL(String(fetchImpl.mock.calls[1][0]));
    expect(normal.searchParams.has('search[category]')).toBe(false);
    expect(normal.searchParams.get('search[name_matches]')).toBe('sample*');
    await expect(service.tags({ query: 'sample', category: 'wrong' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('preserves the score threshold and score ordering metatags in the existing query', async () => {
    const { service, fetchImpl } = transport(json([post({ score: 20 })]));
    const result = await service.search({ query: 'door score:>=20 order:score', limit: 1 });
    expect(result.effectiveQuery).toBe('door score:>=20 order:score rating:g');
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('tags')).toBe(result.effectiveQuery);
    expect(result.items[0].score).toBe(20);
  });
  it('uses only anonymous metadata, preserves five tag categories, and adds one General filter', async () => {
    const { service, fetchImpl } = transport(json([post()]));
    const result = await service.search({ query: 'tree sky rating:g', limit: 1, page: 2 });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(String(url)).searchParams.get('tags')).toBe('tree sky rating:g');
    expect(new URL(String(url)).searchParams.get('page')).toBe('2');
    expect(new Headers(options?.headers).has('authorization')).toBe(false);
    expect(new Headers(options?.headers).has('cookie')).toBe(false);
    expect(new Headers(options?.headers).get('user-agent')).toBe(`MCP-for-NovelAI/${APP_VERSION} (personal reference browser)`);
    expect(options?.redirect).toBe('error');
    expect(options?.signal?.aborted).toBe(true);
    expect(result).toMatchObject({ hasMore: true, filteredCount: 0, items: [{ postId: 42, rating: 'g', sourceUrl: 'https://danbooru.donmai.us/posts/42', tags: { general: ['tree', 'sky'], artists: ['sample_artist'], characters: ['sample_character'], copyrights: ['sample_series'], meta: ['highres'] } }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit g/s/q/e rating and rejects conflicting or malformed overrides', async () => {
    for (const selected of ['s', 'q', 'e'] as const) {
      const { service, fetchImpl } = transport(json([post({ rating: selected })]));
      const result = await service.search({ query: `loli rating:${selected}`, rating: selected, limit: 1 });
      expect(result).toMatchObject({ rating: selected, effectiveQuery: `loli rating:${selected}`, items: [{ rating: selected }] });
      expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('tags')).toBe(`loli rating:${selected}`);
    }
    const { service, fetchImpl } = transport();
    for (const args of [{ query: 'tree rating:s', rating: 'e' }, { query: 'tree rating:s rating:s', rating: 's' }, { query: 'rating:safe' }, { query: 'rating:sfw' }, { query: '-rating:g' }]) {
      await expect(service.search(args as any)).rejects.toMatchObject({ code: 'invalid_arguments' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults to General and filters missing/unknown/different ratings, deleted/banned records, malformed rows and duplicate IDs', async () => {
    const records = [post(), post(), ...[undefined, null, '', 'G', 's', 'q', 'e'].map(rating => post({ rating })), post({ is_deleted: true }), post({ is_banned: true }), null, post({ file_ext: 'webm' })];
    const { service } = transport(json(records));
    const result = await service.search({ query: 'tree', limit: 20 });
    expect(result.items.map(item => item.postId)).toEqual([42]);
    expect(result.filteredCount).toBe(records.length - 1);
  });

  it('rechecks the selected rating before any image request', async () => {
    const { service, fetchImpl } = transport(json([post()]), json(post({ rating: 's' })));
    await service.search({ query: 'tree' });
    await expect(service.image({ postId: 42 })).rejects.toMatchObject({ code: 'rating_blocked' });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['danbooru.donmai.us', 'danbooru.donmai.us']);

    const explicit = transport(json(post({ rating: 'e' })), new Response(PNG), json(post({ rating: 'q' })));
    await expect(explicit.service.image({ postId: 42, rating: 'e' })).resolves.toMatchObject({ postId: 42, variant: 'sample' });
    await expect(explicit.service.image({ postId: 42, rating: 'e' })).rejects.toMatchObject({ code: 'rating_blocked' });
    expect(explicit.fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('rejects a different detail ID and does not fetch caller-supplied URLs', async () => {
    const { service, fetchImpl } = transport(json(post({ id: 43 })));
    await expect(service.image({ postId: 42, url: 'https://example.test/private.png' })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid arguments without transport', async () => {
    const { service, fetchImpl } = transport();
    await expect(service.detail({ postId: '../secret' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(service.image({ postId: 42, variant: 'original' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(service.search({ query: 'tree\nflower' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(service.search({ query: '', limit: 31 })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects missing media, unsupported originals, or excessive declared pixel count', async () => {
    for (const overrides of [{ preview_file_url: '' }, { file_ext: 'mp4' }, { image_width: 65535, image_height: 65535 }]) {
      const { service } = transport(json(post(overrides)));
      await expect(service.detail({ postId: 42 })).rejects.toBeInstanceOf(Error);
    }
  });

  it('rejects malformed JSON, non-list searches, and a response exceeding requested page size', async () => {
    for (const response of [new Response('{'), json({ success: false }), json([post(), post({ id: 43 })])]) {
      const { service } = transport(response);
      await expect(service.search({ query: 'tree', limit: 1 })).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });
});

describe('Danbooru image URL and byte transport', () => {
  it('admits only HTTPS CDN URLs without credentials, nondefault ports, or fragments', () => {
    expect(danbooruImageUrl(SAMPLE)).toBe(SAMPLE);
    for (const value of ['http://cdn.donmai.us/a.png', 'https://cdn.donmai.us.evil.test/a.png', 'https://127.0.0.1/a.png', 'https://[::1]/a.png', 'https://cdn.donmai.us@127.0.0.1/a.png', 'https://user:pass@cdn.donmai.us/a.png', 'https://cdn.donmai.us:8443/a.png', 'https://cdn.donmai.us/a.png#x', 'file:///tmp/a.png', '//cdn.donmai.us/a.png']) {
      expect(danbooruImageUrl(value), value).toBe('');
    }
  });

  it('blocks an untrusted metadata image URL before fetching media', async () => {
    const { service, fetchImpl } = transport(json(post({ preview_file_url: 'https://example.test/a.png' })));
    await expect(service.image({ postId: 42 })).rejects.toMatchObject({ code: 'image_unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns sample bytes with exact provenance, and supports preview and GIF', async () => {
    const { service, fetchImpl } = transport(json(post()), new Response(PNG), json(post({ file_ext: 'gif' })), new Response(GIF));
    const sample = await service.image({ postId: 42 });
    expect(sample).toEqual({ postId: 42, mimeType: 'image/png', data: PNG.toString('base64'), sourceUrl: 'https://danbooru.donmai.us/posts/42', imageUrl: SAMPLE, variant: 'sample' });
    expect(await service.image({ postId: 42, variant: 'preview' })).toMatchObject({ mimeType: 'image/gif', imageUrl: PREVIEW, variant: 'preview' });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual(['https://danbooru.donmai.us/posts/42.json', SAMPLE, 'https://danbooru.donmai.us/posts/42.json', PREVIEW]);
  });

  it('rejects HTML served with an image content-type', async () => {
    const { service } = transport(json(post()), new Response('<html>not an image</html>', { headers: { 'Content-Type': 'image/png' } }));
    await expect(service.image({ postId: 42 })).rejects.toMatchObject({ code: 'invalid_image' });
  });

  it('rejects changed response URLs and followed redirects and aborts the rejected transport', async () => {
    for (const fields of [{ redirected: true }, { url: 'https://example.test/changed' }]) {
      const response = new Response(PNG);
      for (const [key, value] of Object.entries(fields)) Object.defineProperty(response, key, { value });
      const { service, fetchImpl } = transport(json(post()), response);
      await expect(service.image({ postId: 42 })).rejects.toMatchObject({ code: 'redirect_blocked' });
      expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
    }
  });

  it('aborts early when advertised JSON or image content length exceeds its independent cap', async () => {
    const meta = transport(new Response('[]', { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } }));
    await expect(meta.service.search({ query: 'tree' })).rejects.toMatchObject({ code: 'too_large' });
    expect(meta.fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const image = transport(json(post()), new Response(PNG, { headers: { 'Content-Length': String(20 * 1024 * 1024 + 1) } }));
    await expect(image.service.image({ postId: 42 })).rejects.toMatchObject({ code: 'too_large' });
    expect(image.fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it('counts streamed image bytes even when Content-Length lies, cancels and aborts on overflow', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel });
    const { service, fetchImpl } = transport(json(post()), new Response(body, { headers: { 'Content-Length': '1' } }));
    await expect(service.image({ postId: 42 })).rejects.toMatchObject({ code: 'too_large' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1][1]?.signal?.aborted).toBe(true);
  });

  it('propagates anonymous rejection and rate limiting without retry or account fallback', async () => {
    for (const status of [401, 403, 422, 429, 503]) {
      const { service, fetchImpl } = transport(new Response('unavailable', { status }));
      await expect(service.tags({ query: 'tree' })).rejects.toMatchObject({ code: 'upstream_error', message: expect.stringContaining(String(status)) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
  });

  it('propagates a network error without replacing it with an empty successful result', async () => {
    const { service, fetchImpl } = transport(new TypeError('fetch failed'));
    await expect(service.search({ query: 'tree' })).rejects.toMatchObject({ code: 'upstream_unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('aborts a pending fetch at 15 seconds and does not retry', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const service = createDanbooruService({ fetchImpl });
    const assertion = expect(service.search({ query: 'tree' })).rejects.toMatchObject({ code: 'upstream_timeout' });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('canonical tags and separate Chinese translations', () => {
  it('uses canonical API categories and count ordering, dropping deprecated or unknown-category tags', async () => {
    const { service, fetchImpl } = transport(json([{ name: 'blue_flower', category: 0, post_count: 100 }, { name: 'old_flower', category: 0, post_count: 80, is_deprecated: true }, { name: 'unknown_flower', category: 2, post_count: 1 }]));
    const result = await service.tags({ query: 'blue flower' });
    const query = new URL(String(fetchImpl.mock.calls[0][0])).searchParams;
    expect(query.get('search[name_matches]')).toBe('blue_flower*');
    expect(query.get('search[order]')).toBe('count');
    expect(result.items).toEqual([{ name: 'blue_flower', category: 0, postCount: 100, source: 'danbooru-api' }]);
  });

  it('reports a missing Chinese dictionary without silently installing data or querying the network', async () => {
    const { service, fetchImpl } = transport();
    expect(await service.tags({ query: '树木' })).toMatchObject({ source: 'dictionary-unavailable', items: [], note: expect.any(String) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('verifies Chinese candidates by exact canonical names and keeps third-party translation and nsfw provenance', async () => {
    const entries = [{ name: 'handshake', translation: '握手', category: 0, postCount: 8, aliases: [], matchKind: 'primary-exact', nsfw: false }, { name: 'holding_hands', translation: '牵手', category: 0, postCount: 900, aliases: ['握手'], matchKind: 'alias-exact', nsfw: true }];
    const fetchImpl = vi.fn<typeof fetch>(async () => json([{ name: 'holding_hands', category: 0, post_count: 1000 }, { name: 'handshake', category: 0, post_count: 30 }]));
    const service = createDanbooruService({ fetchImpl, dictionary: dictionary(entries) });
    const result = await service.tags({ query: '握手', limit: 2 });
    expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.get('search[name_normalize]')).toBe('handshake,holding_hands');
    expect(result.items.map(item => item.name)).toEqual(['handshake', 'holding_hands']);
    expect(result.items[0]).toMatchObject({ name: 'handshake', translation: '握手', postCount: 30, nsfw: false, verified: true, source: 'danbooru-api', translationSource: `DanbooruSearchOnline@${TAG_DICTIONARY.commit}`, matchKind: 'primary-exact' });
    expect(result.items[1]).toMatchObject({ name: 'holding_hands', nsfw: true, verified: true });
  });

  it('does not accept unrelated, deprecated, or unverified names in a successful candidate verification response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json([{ name: 'tree', category: 0, post_count: 50, is_deprecated: true }, { name: 'other_tree', category: 0, post_count: 50 }]));
    const service = createDanbooruService({ fetchImpl, dictionary: dictionary([{ name: 'tree', translation: '树木', matchKind: 'primary-exact' }, { name: 'forest', translation: '森林', matchKind: 'alias-partial' }]) });
    expect(await service.tags({ query: '树木', limit: 2 })).toMatchObject({ items: [], filteredCount: 2 });
  });

  it('keeps English canonical names while decorating only translations found locally', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json([{ name: 'tree', category: 0, post_count: 50 }, { name: 'tree_branch', category: 0, post_count: 20 }]));
    const service = createDanbooruService({ fetchImpl, dictionary: dictionary([{ name: 'tree', translation: '树木' }]) });
    const result = await service.tags({ query: 'tree' });
    expect(result.items[0]).toMatchObject({ name: 'tree', translation: '树木', source: 'danbooru-api', verified: true });
    expect(result.items[1]).toMatchObject({ name: 'tree_branch', verified: true });
    expect(result.items[1]).not.toHaveProperty('translation');
  });

  it('reports failed anonymous verification and returns explicitly unverified Chinese candidates without retry', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Forbidden', { status: 403 }));
    const service = createDanbooruService({ fetchImpl, dictionary: dictionary([{ name: 'tree', translation: '树木', category: 0, postCount: 80, matchKind: 'primary-exact' }]) });
    const result = await service.tags({ query: '树木' });
    expect(result).toMatchObject({ source: 'DanbooruSearchOnline', verificationError: { code: 'upstream_error', message: expect.stringContaining('403') }, note: expect.stringContaining('未完成'), items: [{ name: 'tree', translation: '树木', source: 'DanbooruSearchOnline', verified: false, postCount: 80 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.items[0].name).toBe('tree');
  });

  it('keeps successful English API results when optional translation lookup fails', async () => {
    const local = dictionary();
    vi.mocked(local.lookup).mockRejectedValue(new Error('corrupt local hash'));
    const fetchImpl = vi.fn<typeof fetch>(async () => json([{ name: 'tree', category: 0, post_count: 50 }]));
    const service = createDanbooruService({ fetchImpl, dictionary: local });
    expect(await service.tags({ query: 'tree' })).toMatchObject({ source: 'danbooru-api', translationError: { code: 'dictionary_unavailable' }, items: [{ name: 'tree', category: 0, postCount: 50, source: 'danbooru-api' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed or overlarge tag lists and wildcard/search-operator input', async () => {
    for (const response of [json({ tags: [] }), json([{ name: 'tree', category: 0 }, { name: 'flower', category: 0 }])]) {
      const { service } = transport(response);
      await expect(service.tags({ query: 'tree', limit: 1 })).rejects.toMatchObject({ code: 'invalid_response' });
    }
    const { service, fetchImpl } = transport();
    await expect(service.tags({ query: 'tree*' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await expect(service.tags({ query: 'rating:g' })).rejects.toMatchObject({ code: 'invalid_arguments' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
