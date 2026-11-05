import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupTagCooccurrence } from '../src/tag-cooccurrence.mjs';

// Offline SFW protocol fixtures; counts/frequencies are not live website facts.
const tag = (name, extra = {}) => ({ name, category: 0, post_count: 123, ...extra });
const related = (name, frequency, extra = {}) => ({ tag: tag(name, extra), frequency, cosine: .9, jaccard: .4 });
const body = (extra = {}) => ({ query: 'teacup rating:g', post_count: 99, tag: tag('teacup'), related_tags: [related('teacup', 1), related('table', .75), related('book', .5)], wiki_page_tags: [tag('private_wiki_text')], ...extra });
const json = (value, extra = {}) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' }, ...extra });
function transport(value = body()) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return typeof value === 'function' ? value(url, options) : json(value); } };
}
function unknown(result, code) {
  assert.equal(result.status, 'unknown'); assert.equal(result.queryPostCount, null); assert.equal(result.canonicalName, null);
  assert.equal(result.count, 0); assert.deepEqual(result.items, []); assert.equal(result.error.code, code);
}

test('fixed public GET preserves frequency fractions and compact provenance without wiki or fabricated counts', async () => {
  const api = transport(), result = await lookupTagCooccurrence('TEACUP', { ...api, baseUrl: 'https://untrusted.test', headers: { Authorization: 'secret', Cookie: 'secret' } });
  assert.equal(api.calls.length, 1);
  const { url, options } = api.calls[0];
  assert.equal(url.origin, 'https://danbooru.donmai.us'); assert.equal(url.pathname, '/related_tag.json');
  assert.deepEqual([...url.searchParams], [['search[query]', 'teacup rating:g'], ['search[category]', 'general'], ['search[order]', 'frequency'], ['search[search_sample_size]', '5000'], ['limit', '9']]);
  assert.equal(url.username, ''); assert.equal(url.hash, '');
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.headers.Authorization, undefined); assert.equal(options.headers.Cookie, undefined);
  assert.equal(result.source, 'danbooru-public-api'); assert.equal(result.detail, 'cooccurrence');
  assert.equal(result.name, 'teacup'); assert.equal(result.canonicalName, 'teacup'); assert.equal(result.query, 'teacup rating:g');
  assert.equal(result.queryPostCount, 99); assert.equal(result.scope, 'rating:g'); assert.equal(result.postCountScope, 'all_ratings');
  assert.equal(result.category, 'general'); assert.equal(result.order, 'frequency'); assert.equal(result.sampleLimit, 5000); assert.equal(result.frequencyBasis, 'upstream_sample');
  assert.equal(result.status, 'found'); assert.equal(result.count, 2);
  assert.deepEqual(result.items, [{ name: 'table', postCount: 123, frequency: .75 }, { name: 'book', postCount: 123, frequency: .5 }]);
  assert.equal(result.sourceUrl, url.href); assert.equal(new Date(result.checkedAt).toISOString(), result.checkedAt);
  assert.equal(result.error, undefined);
  assert.ok(!JSON.stringify(result).includes('wiki')); assert.equal(result.items[0].cooccurrenceCount, undefined);
});

test('all four explicit ratings are exact scopes and g remains the default', async () => {
  for (const rating of ['g', 's', 'q', 'e']) {
    const api = transport(body({ query: `teacup rating:${rating}` }));
    const value = await lookupTagCooccurrence('teacup', { ...api, rating });
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].url.searchParams.get('search[query]'), `teacup rating:${rating}`);
    assert.equal(value.query, `teacup rating:${rating}`); assert.equal(value.scope, `rating:${rating}`);
  }
  assert.equal((await lookupTagCooccurrence('teacup', transport())).scope, 'rating:g');
});

test('ordinary phrases normalize to one tag and exclude its canonical self record', async () => {
  const api = transport(body({ query: 'collared_shirt rating:g', tag: tag('collared_shirt'), related_tags: [related('collared_shirt', 1), related('blue_shirt', .8)] }));
  const value = await lookupTagCooccurrence(' Collared Shirt ', api);
  assert.equal(api.calls[0].url.searchParams.get('search[query]'), 'collared_shirt rating:g');
  assert.equal(value.name, 'collared_shirt'); assert.equal(value.canonicalName, 'collared_shirt'); assert.equal(value.query, 'collared_shirt rating:g');
  assert.deepEqual(value.items, [{ name: 'blue_shirt', postCount: 123, frequency: .8 }]);
});

test('a possible alias or unrelated returned canonical name needs explicit verification, never automatic rebinding', async () => {
  for (const [input, canonical] of [['shirt_collar', 'collared_shirt'], ['teacup', 'unrelated']]) {
    const api = transport(body({ query: `${canonical} rating:g`, tag: tag(canonical), related_tags: [related(canonical, 1), related(input, .9), related('blue_shirt', .8)] }));
    const value = await lookupTagCooccurrence(input, api);
    unknown(value, 'canonical_name_required');
    assert.equal(value.name, input); assert.equal(value.query, `${input} rating:g`);
    assert.equal(value.suggestedCanonicalName, canonical); assert.equal(api.calls.length, 1);
    assert.match(value.error.message, /compact details/);
  }
});

test('default eight and maximum twenty candidates retain server order and exact limit plus one', async () => {
  for (const limit of [undefined, 1, 20]) {
    const selectedLimit = limit ?? 8;
    const api = transport(body({ related_tags: [related('teacup', 1), ...Array.from({ length: selectedLimit }, (_, index) => related(`tag_${index}`, .9 - index / 100))] }));
    const value = await lookupTagCooccurrence('teacup', { ...api, ...(limit === undefined ? {} : { limit }) });
    assert.equal(api.calls[0].url.searchParams.get('limit'), String(selectedLimit + 1));
    assert.equal(value.count, selectedLimit); assert.deepEqual(value.items.map(item => item.name), Array.from({ length: selectedLimit }, (_, index) => `tag_${index}`));
  }
});

test('valid non-general records are filtered and punctuation candidate tags are retained as data', async () => {
  const api = transport(body({ related_tags: [related('teacup', 1), related('fixture_artist', .9, { category: 1 }), related(':d', .5), related('<3', .4), related('table', 0)] }));
  const result = await lookupTagCooccurrence('teacup', api);
  assert.deepEqual(result.items.map(item => [item.name, item.frequency]), [[':d', .5], ['<3', .4], ['table', 0]]);
  assert.equal(api.calls.length, 1);
});

test('only valid zero results or a self-only result are empty; upstream null counts remain unknown', async () => {
  for (const value of [body({ post_count: 0, related_tags: [] }), body({ post_count: 0, tag: null, related_tags: [] }), body({ related_tags: [related('teacup', 1)] })]) {
    const result = await lookupTagCooccurrence('teacup', transport(value));
    assert.equal(result.status, 'empty'); assert.equal(result.count, 0); assert.equal(result.error, undefined);
    assert.equal(result.queryPostCount, value.post_count);
  }
  unknown(await lookupTagCooccurrence('teacup', transport(body({ post_count: null, related_tags: [] }))), 'upstream_count_unavailable');
});

test('invalid caller names, lists, search operators and resource limits fail before HTTP', async () => {
  const api = transport();
  for (const name of [null, 4, {}, ['teacup'], '', ' ', '茶杯', 'teacup\n', 'teacup\that', ':d', 'rating:g', 'teacup rating:e', 'foo:bar', '-teacup', '~teacup', 'teacup*', 'teacup,table', 'teacup|table', 'teacup;table', '(teacup)', '"teacup"', '{teacup}', '[teacup]', 'https://untrusted.test', 'teacup\\table', 'teacup  table', 'x'.repeat(201)]) await assert.rejects(lookupTagCooccurrence(name, api), { code: 'invalid_arguments' });
  for (const options of [null, [], { limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '2' }, { timeoutMs: 0 }, { timeoutMs: 30001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 1048577 }, { fetchImpl: 4 }, { signal: {} }, { rating: 'x' }, { rating: null }, { rating: 'general' }]) await assert.rejects(lookupTagCooccurrence('teacup', options === null || Array.isArray(options) ? options : { ...api, ...options }), { code: 'invalid_arguments' });
  assert.equal(api.calls.length, 0);
});

test('mismatched query, ratings, identity, malformed categories and counts never become empty', async () => {
  const malformed = [null, [], {}, body({ query: 'teacup rating:e' }), body({ query: 'teacup' }), body({ query: 'book rating:g' }), body({ query: 'teacup rating:g score:10' }), body({ tag: null }), body({ tag: null, post_count: 0, related_tags: [related('book', .5)] }), body({ tag: null, post_count: 0, query: 'different rating:g', related_tags: [] }), body({ tag: tag('Teacup') }), body({ tag: tag('teacup', { category: 2 }) }), body({ tag: tag('teacup', { post_count: -1 }) }), body({ post_count: -1 }), body({ post_count: 1.5 }), body({ post_count: Number.MAX_SAFE_INTEGER + 1 }), body({ post_count: '99' }), body({ post_count: 0 }), body({ related_tags: null })];
  for (const value of malformed) unknown(await lookupTagCooccurrence('teacup', transport(value)), 'invalid_response');
});

test('duplicate candidates, frequency inversions and invalid rows reject the entire response without repairs', async () => {
  const brokenRows = [[related('table', .6), related('table', .5)], [related('table', .2), related('book', .8)], [null], [{ tag: null, frequency: .5 }], [related('Table', .5)], [related('two words', .5)], [related('table', .5, { category: 2 })], [related('table', .5, { post_count: '5' })], [related('table', .5, { post_count: -1 })], [related('table', .5, { post_count: Number.MAX_SAFE_INTEGER + 1 })], ...[-.1, 1.1, '0.5', null].map(f => [related('table', f)]), [{ tag: tag('table') }], Array.from({ length: 10 }, (_, i) => related(`tag_${i}`, .5))];
  for (const related_tags of brokenRows) unknown(await lookupTagCooccurrence('teacup', transport(body({ related_tags }))), 'invalid_response');
});

test('network failures and HTTP errors do not retry or expose transport details', async () => {
  for (const [response, code] of [[() => { throw new Error('private-credential-stack'); }, 'upstream_unavailable'], [() => json({}, { status: 429 }), 'upstream_error'], [() => json({}, { status: 503 }), 'upstream_error']]) {
    const api = transport(response), value = await lookupTagCooccurrence('teacup', api);
    unknown(value, code); assert.equal(api.calls.length, 1); assert.ok(!JSON.stringify(value).includes('private-credential-stack'));
  }
});

test('redirects and changed final URLs stay unknown and never request alternate sources', async () => {
  for (const overrides of [{ redirected: true }, { url: 'https://untrusted.test/related_tag.json' }]) {
    const api = transport(() => { const response = json(body()); for (const [key, value] of Object.entries(overrides)) Object.defineProperty(response, key, { value }); return response; });
    unknown(await lookupTagCooccurrence('teacup', api), 'redirect_blocked'); assert.equal(api.calls.length, 1);
  }
});

test('oversize declarations and streamed bodies are bounded without retaining partial candidates', async () => {
  for (const response of [() => json(body(), { headers: { 'content-type': 'application/json', 'content-length': '1000' } }), () => json(body())]) {
    const api = transport(response); unknown(await lookupTagCooccurrence('teacup', { ...api, maxResponseBytes: 100 }), 'too_large'); assert.equal(api.calls.length, 1);
  }
});

test('wrong MIME, invalid JSON, invalid UTF-8 and absent bodies remain unknown', async () => {
  for (const response of [() => new Response('html', { headers: { 'content-type': 'text/html' } }), () => new Response('{', { headers: { 'content-type': 'application/json' } }), () => new Response(Uint8Array.of(0xff), { headers: { 'content-type': 'application/json' } }), () => new Response(null, { headers: { 'content-type': 'application/json' } })]) unknown(await lookupTagCooccurrence('teacup', transport(response)), 'invalid_response');
});

test('pre-aborted requests never dispatch, and a pending fetch cancels without a retry', async () => {
  const controller = new AbortController(); controller.abort(new Error('private-cancel-reason'));
  const api = transport(); unknown(await lookupTagCooccurrence('teacup', { ...api, signal: controller.signal }), 'aborted'); assert.equal(api.calls.length, 0);
  const active = new AbortController(), pending = transport(() => new Promise(() => {}));
  const result = lookupTagCooccurrence('teacup', { ...pending, signal: active.signal }); active.abort(new Error('private-cancel-reason'));
  const value = await result; unknown(value, 'aborted'); assert.equal(pending.calls.length, 1); assert.ok(!JSON.stringify(value).includes('private-cancel-reason'));
});

test('both a stalled fetch and a stalled response reader honor the bounded deadline', async () => {
  for (const response of [() => new Promise(() => {}), () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } })]) {
    const api = transport(response), value = await lookupTagCooccurrence('teacup', { ...api, timeoutMs: 10 });
    unknown(value, 'upstream_timeout'); assert.equal(api.calls.length, 1);
  }
});
