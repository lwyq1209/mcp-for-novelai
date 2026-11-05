/** Bounded public tag cooccurrence facts, not images or semantic suggestions. */
import { coordinatedTagFetch, tagQueryEvidence } from './tag-query-coordinator.mjs';
import { USER_AGENT } from './version.mjs';
const API = 'https://danbooru.donmai.us';
const CATEGORIES = new Set([0, 1, 3, 4, 5]);
const RATINGS = new Set(['g', 's', 'q', 'e']);
class LookupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new LookupError(code, message); };
const invalid = () => fail('invalid_response', 'Danbooru returned an invalid or mismatched cooccurrence response.');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

function normalizeName(value) {
  if (typeof value !== 'string' || value.length > 200 || /[^\x20-\x7e]/.test(value)) fail('invalid_arguments', 'Use one English tag name, up to 200 printable ASCII characters.');
  const name = value.trim().toLowerCase().replaceAll(' ', '_');
  // This value is part of a post query. Unlike exact tag metadata lookup,
  // query operators, colon faces and grouping syntax are deliberately excluded.
  if (!name || !/^[a-z0-9][a-z0-9_!?()./'&#+=\-]*$/.test(name) || /_$|__/.test(name)) fail('invalid_arguments', 'Use one tag without metatags, wildcards, lists, URLs or search operators; ordinary tag phrases may use spaces.');
  return name;
}
function responseName(value) {
  // Returned tags are data, not new searches. Real general tags such as :d
  // remain valid candidates even though colon is disallowed in input queries.
  if (typeof value !== 'string' || !value || value.length > 200 || /[^\x21-\x7e]|[*,]/.test(value) || value !== value.toLowerCase()) invalid();
  return value;
}
function bounded(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('invalid_arguments', 'Lookup resource limit is invalid.');
  return value;
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/** Shared request identity validation, including before any task-ledger reuse. */
export function normalizeCooccurrenceQuery(inputName, options = {}) {
  const name = normalizeName(inputName);
  if (!record(options)) fail('invalid_arguments', 'Lookup options must be an object.');
  const limit = bounded(options.limit, 8, 20), rating = options.rating === undefined ? 'g' : options.rating;
  if (!RATINGS.has(rating)) fail('invalid_arguments', 'rating must be g, s, q or e.');
  return { name, limit, rating };
}
/** One fixed unauthenticated GET; errors remain unknown and are never retried. */
export async function lookupTagCooccurrence(inputName, options = {}) {
  const { name, limit, rating } = normalizeCooccurrenceQuery(inputName, options);
  const timeoutMs = bounded(options.timeoutMs, 15000, 30000);
  const maxResponseBytes = bounded(options.maxResponseBytes, 256 * 1024, 1024 * 1024);
  const coordinator = options.queryCoordinator;
  const fetchImpl = coordinator === undefined ? (options.fetchImpl ?? coordinatedTagFetch) : (typeof coordinator === 'function' ? coordinator : coordinator?.fetch?.bind(coordinator));
  if (typeof fetchImpl !== 'function' || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) fail('invalid_arguments', 'A fetch function, optional query coordinator and optional AbortSignal are required.');
  const query = `${name} rating:${rating}`, url = new URL('/related_tag.json', API);
  for (const [key, value] of Object.entries({ 'search[query]': query, 'search[category]': 'general', 'search[order]': 'frequency', 'search[search_sample_size]': '5000', limit: String(limit + 1) })) url.searchParams.set(key, value);
  const sourceUrl = url.href;
  const result = { source: 'danbooru-public-api', detail: 'cooccurrence', checkedAt: null, name, canonicalName: null, query, limit,
    status: 'unknown', queryPostCount: null, scope: `rating:${rating}`, category: 'general', order: 'frequency', frequencyBasis: 'upstream_sample', sampleLimit: 5000, postCountScope: 'all_ratings', count: 0, items: [], sourceUrl };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new LookupError('upstream_timeout', 'Danbooru lookup timed out.')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let reader;
  try {
    signal.throwIfAborted();
    const response = await abortable(fetchImpl(sourceUrl, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': `${USER_AGENT} (public tag cooccurrence)` }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal }), signal);
    const evidence = tagQueryEvidence(response);
    if (evidence) {
      result.checkedAt = evidence.checkedAt;
      if (evidence.retrieval === 'cache' || evidence.retrieval === 'shared_failure') result.evidence = {
        retrieval: evidence.retrieval,
        sourceCheckedAt: evidence.checkedAt,
        ...(evidence.cachedAt ? { cachedAt: evidence.cachedAt } : {}),
      };
    } else result.checkedAt = new Date().toISOString();
    if (response.redirected || (response.url && response.url !== sourceUrl)) fail('redirect_blocked', 'Danbooru lookup redirected; no alternate source was requested.');
    if (!response.ok) fail('upstream_error', `Danbooru returned HTTP ${Number.isInteger(response.status) ? response.status : 'unknown'}.`);
    if (Number(response.headers.get('content-length')) > maxResponseBytes) fail('too_large', 'Danbooru response exceeded the size limit.');
    if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) invalid();
    reader = response.body?.getReader();
    if (!reader) invalid();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      size += value.byteLength;
      if (size > maxResponseBytes) fail('too_large', 'Danbooru response exceeded the size limit.');
      chunks.push(value);
    }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { invalid(); }
    if (!record(body) || typeof body.query !== 'string' || !Array.isArray(body.related_tags) || body.related_tags.length > limit + 1) invalid();
    // Upstream may time out counting and return null with no tags. That is an
    // unknown query, never evidence of zero matching posts.
    if (body.post_count === null) fail('upstream_count_unavailable', 'Danbooru could not count this query; cooccurrence remains unknown.');
    if (!count(body.post_count)) invalid();
    let canonicalName = null;
    if (body.tag === null) {
      if (body.query !== query || body.post_count !== 0 || body.related_tags.length) invalid();
    } else {
      if (!record(body.tag) || !CATEGORIES.has(body.tag.category) || !count(body.tag.post_count)) invalid();
      canonicalName = responseName(body.tag.name);
      if (body.query !== `${canonicalName} rating:${rating}`) invalid();
      if (canonicalName !== name) {
        const error = new LookupError('canonical_name_required', 'Danbooru returned a different tag name. Verify its alias and canonical name with compact details, then explicitly query that canonical name; no additional request was made.');
        error.suggestedCanonicalName = canonicalName;
        throw error;
      }
    }
    const seen = new Set(), items = []; let previousFrequency = Infinity;
    for (const row of body.related_tags) {
      if (!record(row) || !record(row.tag) || !CATEGORIES.has(row.tag.category) || !count(row.tag.post_count) || typeof row.frequency !== 'number' || !Number.isFinite(row.frequency) || row.frequency < 0 || row.frequency > 1 || row.frequency > previousFrequency) invalid();
      const tagName = responseName(row.tag.name);
      if (seen.has(tagName)) invalid();
      seen.add(tagName); previousFrequency = row.frequency;
      if (row.tag.category === 0 && tagName !== name && tagName !== canonicalName) items.push({ name: tagName, postCount: row.tag.post_count, frequency: row.frequency });
    }
    if (body.post_count === 0 && body.related_tags.length) invalid();
    const selected = items.slice(0, limit);
    return { ...result, canonicalName, query: body.query, status: selected.length ? 'found' : 'empty', queryPostCount: body.post_count, count: selected.length, items: selected };
  } catch (error) {
    const known = error instanceof LookupError ? error : null;
    const inherited = ['coordination_timeout', 'upstream_timeout'].includes(error?.code) ? error.code : null;
    const code = signal.aborted ? (controller.signal.aborted ? 'upstream_timeout' : 'aborted') : known?.code ?? inherited ?? 'upstream_unavailable';
    const message = signal.aborted ? (code === 'aborted' ? 'Danbooru lookup was cancelled; cooccurrence remains unknown.' : 'Danbooru lookup timed out; cooccurrence remains unknown.')
      : known?.message ?? (code === 'coordination_timeout' ? 'Public tag query coordination timed out; no retry was made.'
        : code === 'upstream_timeout' ? 'Danbooru lookup timed out; no retry was made.' : 'Danbooru network request failed; no retry was made.');
    if (code === 'aborted' || code === 'upstream_timeout') { result.checkedAt = null; delete result.evidence; }
    return { ...result, ...(known?.code === 'canonical_name_required' ? { suggestedCanonicalName: known.suggestedCanonicalName } : {}), error: { code, message } };
  } finally {
    clearTimeout(timeout); controller.abort();
    if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock(); } catch {} }
  }
}
