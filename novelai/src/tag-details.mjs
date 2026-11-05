/** Read-only facts for review; Danbooru existence is not NovelAI model support. */
import { lookupTagCooccurrence, normalizeCooccurrenceQuery } from './tag-cooccurrence.mjs';
import { coordinatedTagFetch, tagQueryEvidence } from './tag-query-coordinator.mjs';
import { USER_AGENT } from './version.mjs';
const API = 'https://danbooru.donmai.us';
const CATEGORIES = new Map([[0, 'general'], [1, 'artist'], [3, 'copyright'], [4, 'character'], [5, 'meta']]);
const MAX_ALIAS_HOPS = 3;
const MAX_BATCH_NAMES = 20;
const BATCH_CONCURRENCY = 4;

class LookupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new LookupError(code, message); };
const invalid = () => fail('invalid_response', 'Danbooru returned an invalid or mismatched record.');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function normalizeName(value) {
  if (typeof value !== 'string' || value.length > 200 || /[^\x20-\x7e]/.test(value)) {
    fail('invalid_arguments', 'Use one English tag name or concept, up to 200 printable ASCII characters.');
  }
  const name = value.trim().toLowerCase().replaceAll(' ', '_');
  // Preserve punctuation such as :), /, apostrophes and parentheses. This is
  // exact metadata lookup, never a post search or a translation service.
  if (!name || /[*,]/.test(name) || /^[~_-]|_$|__/.test(name) || /^https?:\/\//.test(name)
    || /^(?:rating|score|order|sort|limit|status|id|user|date|age|fav|pool):/.test(name)) {
    fail('invalid_arguments', 'Use a single tag name without wildcard, list, URL, or post-search operators.');
  }
  return name;
}

function boundedOption(value, fallback, maximum, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid_arguments', 'Lookup resource limit is invalid.');
  return value;
}

function apiUrl(path, field, name, only) {
  const url = new URL(path, API);
  url.searchParams.set(`search[${field}]`, name);
  if (path === '/tag_aliases.json') url.searchParams.set('search[status]', 'active');
  url.searchParams.set('limit', '2'); // Two detect ambiguity without fetching an unbounded list.
  url.searchParams.set('only', only);
  return url.href;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

/**
 * Fixed official endpoints, no authentication, no images and no retries.
 * Endpoint failures are explicit unknown facts; invalid caller arguments throw.
 * Wiki body is untrusted raw DText, not instructions or a verified translation.
 */
export async function lookupTagDetails(inputName, options = {}) {
  const name = normalizeName(inputName);
  if (!isRecord(options)) fail('invalid_arguments', 'Lookup options must be an object.');
  const timeoutMs = boundedOption(options.timeoutMs, 15000, 30000);
  const maxResponseBytes = boundedOption(options.maxResponseBytes, 256 * 1024, 1024 * 1024);
  const maxWikiChars = boundedOption(options.maxWikiChars, 6000, 12000);
  const coordinator = options.queryCoordinator;
  const fetchImpl = coordinator === undefined ? (options.fetchImpl ?? coordinatedTagFetch) : (typeof coordinator === 'function' ? coordinator : coordinator?.fetch?.bind(coordinator));
  if (typeof fetchImpl !== 'function' || (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    fail('invalid_arguments', 'A fetch function, optional query coordinator and optional AbortSignal are required.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new LookupError('upstream_timeout', 'Danbooru lookup timed out; no retry was made.')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const sources = [], errors = [], steps = [];
  let timingInvalid = false;
  const unknown = { status: 'unknown' };
  const result = { inputName, name, source: 'danbooru-public-api', checkedAt: null, resolution: 'unknown', canonicalName: null,
    tag: { ...unknown }, aliases: { ...unknown, steps }, wiki: { status: 'not_checked' }, sources, errors };

  async function request(kind, tagName, url, parse) {
    const source = { kind, name: tagName, url, status: 'unknown' };
    sources.push(source);
    let reader;
    try {
      signal.throwIfAborted();
      const response = await abortable(fetchImpl(url, {
        method: 'GET', headers: { Accept: 'application/json', 'User-Agent': `${USER_AGENT} (public tag definitions)` },
        credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
      }), signal);
      const evidence = tagQueryEvidence(response);
      if (evidence) {
        source.checkedAt = evidence.checkedAt;
        source.retrieval = evidence.retrieval;
        if (evidence.cachedAt) source.cachedAt = evidence.cachedAt;
      } else {
        // An injected transport has no coordinator metadata. Timestamp only
        // after a real Response exists, never at function entry or cancellation.
        source.checkedAt = new Date().toISOString();
        source.retrieval = 'network';
      }
      if (response.redirected || (response.url && response.url !== url)) fail('redirect_blocked', 'Danbooru lookup redirected; no alternate source was requested.');
      if (!response.ok) fail('upstream_error', `Danbooru returned HTTP ${Number.isInteger(response.status) ? response.status : 'unknown'}.`);
      const length = Number(response.headers.get('content-length'));
      if (length > maxResponseBytes) fail('too_large', 'Danbooru response exceeded the size limit.');
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
      if (!Array.isArray(body) || body.length > 2) invalid();
      const facts = parse(body);
      source.status = 'checked';
      return facts;
    } catch (error) {
      const known = error instanceof LookupError ? error : null;
      const inherited = ['coordination_timeout', 'upstream_timeout'].includes(error?.code) ? error.code : null;
      const code = signal.aborted ? (controller.signal.aborted ? 'upstream_timeout' : 'aborted') : known?.code ?? inherited ?? 'upstream_unavailable';
      const message = signal.aborted ? (code === 'aborted' ? 'Danbooru lookup was cancelled; unfinished facts remain unknown.' : 'Danbooru lookup timed out; unfinished facts remain unknown.')
        : known?.message ?? (code === 'coordination_timeout' ? 'Public tag query coordination timed out; no retry was made.'
          : code === 'upstream_timeout' ? 'Danbooru lookup timed out; no retry was made.' : 'Danbooru network request failed; no retry was made.');
      if (code === 'aborted' || code === 'upstream_timeout') {
        timingInvalid = true;
        delete source.checkedAt; delete source.retrieval; delete source.cachedAt;
      }
      errors.push({ stage: kind, name: tagName, code, message, sourceUrl: url });
      return { status: 'unknown' };
    } finally {
      // Do not wait on a broken transport's cancellation promise after deadline.
      if (reader) { try { Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock(); } catch {} }
    }
  }

  const readTag = tagName => request('tag', tagName, apiUrl('/tags.json', 'name', tagName, 'id,name,category,post_count,is_deprecated'), rows => {
    if (rows.length === 0) return { status: 'not_found', name: tagName };
    if (rows.length !== 1) invalid();
    const tag = rows[0];
    if (!isRecord(tag) || tag.name !== tagName || !Number.isSafeInteger(tag.id) || tag.id <= 0 || !CATEGORIES.has(tag.category)
      || !Number.isSafeInteger(tag.post_count) || tag.post_count < 0 || typeof tag.is_deprecated !== 'boolean') invalid();
    return { status: 'found', name: tag.name, id: tag.id, category: tag.category, categoryName: CATEGORIES.get(tag.category), postCount: tag.post_count, isDeprecated: tag.is_deprecated, sourceUrl: `${API}/tags/${tag.id}` };
  });
  const readAlias = tagName => request('alias', tagName, apiUrl('/tag_aliases.json', 'antecedent_name', tagName, 'id,antecedent_name,consequent_name,status'), rows => {
    // Even with status=active, never use a retired/deleted relationship.
    if (rows.some(row => !isRecord(row) || row.antecedent_name !== tagName || !['active', 'deleted', 'retired', 'pending', 'rejected'].includes(row.status))) invalid();
    const active = rows.filter(row => row.status === 'active');
    if (active.length > 1) invalid();
    if (!active.length) return { status: 'checked', alias: null };
    const row = active[0];
    let target;
    try { target = normalizeName(row.consequent_name); } catch { invalid(); }
    if (target !== row.consequent_name || !Number.isSafeInteger(row.id) || row.id <= 0) invalid();
    return { status: 'checked', alias: { antecedentName: tagName, consequentName: target, sourceUrl: `${API}/tag_aliases/${row.id}` } };
  });
  const readWiki = tagName => request('wiki', tagName, apiUrl('/wiki_pages.json', 'title', tagName, 'id,title,body,is_deleted'), rows => {
    if (!rows.length) return { status: 'not_found', title: tagName };
    if (rows.length !== 1) invalid();
    const page = rows[0];
    if (!isRecord(page) || page.title !== tagName || !Number.isSafeInteger(page.id) || page.id <= 0 || typeof page.is_deleted !== 'boolean' || typeof page.body !== 'string') invalid();
    const sourceUrl = `${API}/wiki_pages/${encodeURIComponent(tagName)}`;
    if (page.is_deleted) return { status: 'deleted', title: page.title, sourceUrl };
    return { status: 'found', title: page.title, body: page.body.slice(0, maxWikiChars), format: 'dtext', truncated: page.body.length > maxWikiChars, sourceUrl };
  });

  try {
    let current = name;
    const seen = new Set([name]);
    for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
      const [tag, alias] = await Promise.all([readTag(current), readAlias(current)]);
      result.tag = tag;
      if (alias.status === 'unknown') {
        result.wiki = await readWiki(current);
        break;
      }
      if (!alias.alias) {
        result.aliases.status = 'checked';
        result.wiki = await readWiki(current);
        if (tag.status === 'found') {
          result.canonicalName = current;
          result.resolution = steps.length ? 'alias' : 'canonical';
        } else if (tag.status === 'not_found' && !steps.length) result.resolution = 'not_found';
        else if (tag.status === 'not_found') errors.push({ stage: 'alias', name: current, code: 'alias_target_missing', message: 'The active alias target has no matching tag record; canonical resolution remains unknown.' });
        break;
      }
      steps.push(alias.alias);
      if (seen.has(alias.alias.consequentName) || hop === MAX_ALIAS_HOPS) {
        errors.push({ stage: 'alias', name: current, code: seen.has(alias.alias.consequentName) ? 'alias_cycle' : 'alias_limit', message: 'The alias chain could not be resolved within the bounded lookup.' });
        break;
      }
      current = alias.alias.consequentName;
      seen.add(current);
    }
    const coordinated = sources.filter(source => typeof source.checkedAt === 'string' && Number.isFinite(Date.parse(source.checkedAt)));
    if (timingInvalid) { result.checkedAt = null; delete result.evidence; }
    else if (coordinated.length) {
      result.checkedAt = coordinated.reduce((earliest, source) => Date.parse(source.checkedAt) < Date.parse(earliest) ? source.checkedAt : earliest, coordinated[0].checkedAt);
      const cached = coordinated.filter(source => source.retrieval === 'cache');
      const sharedFailures = coordinated.filter(source => source.retrieval === 'shared_failure');
      if (cached.length || sharedFailures.length) result.evidence = {
        retrieval: coordinated.every(source => source.retrieval === 'cache') ? 'cache'
          : coordinated.every(source => source.retrieval === 'shared_failure') ? 'shared_failure' : 'mixed',
        sourceCheckedAt: result.checkedAt,
        cacheHits: cached.length,
        ...(sharedFailures.length ? { sharedFailures: sharedFailures.length } : {}),
      };
    }
    return result;
  } finally { clearTimeout(timeout); controller.abort(); }
}

/** Presentation only: preserve known/unknown facts and raw wiki, omit API bookkeeping. */
export function compactTagDetails(result) {
  if (!isRecord(result)) invalid();
  const tag = result.tag ?? {}, aliases = result.aliases ?? {}, wiki = result.wiki ?? {};
  const steps = Array.isArray(aliases.steps) ? aliases.steps : [];
  const sources = [...new Set([tag.sourceUrl, wiki.sourceUrl, ...steps.map(step => step.sourceUrl)].filter(value => typeof value === 'string'))];
  const errors = (result.errors ?? []).map(error => ({ stage: error.stage, code: error.code, message: error.message,
    ...(error.name && error.name !== result.name ? { name: error.name } : {}) }));
  const distinctErrors = [...new Map(errors.map(error => [JSON.stringify(error), error])).values()];
  return {
    name: result.name, canonicalName: result.canonicalName ?? null, resolution: result.resolution ?? 'unknown',
    tagStatus: tag.status ?? 'unknown',
    ...(tag.name && tag.name !== result.name && tag.name !== result.canonicalName ? { tagName: tag.name } : {}),
    category: tag.categoryName ?? null, postCount: tag.postCount ?? null, deprecated: tag.isDeprecated ?? null,
    aliasStatus: aliases.status ?? 'unknown',
    ...(steps.length ? { aliases: steps.map(step => ({ from: step.antecedentName, to: step.consequentName })) } : {}),
    wiki: { status: wiki.status ?? 'not_checked',
      ...(wiki.title && wiki.title !== result.name && wiki.title !== result.canonicalName ? { title: wiki.title } : {}),
      ...(typeof wiki.body === 'string' ? { body: wiki.body, format: wiki.format, truncated: wiki.truncated } : {}),
    },
    sources,
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(distinctErrors.length ? { errors: distinctErrors } : {}),
  };
}

/** One bounded batch result for every caller; single-name calls use the same envelope. */
export async function queryTagDetails(args, options = {}) {
  if (!isRecord(args) || Object.keys(args).some(key => !['name', 'names', 'detail', 'limit', 'rating'].includes(key))
    || (args.name !== undefined) === (args.names !== undefined)) fail('invalid_arguments', 'Provide either name or names, not both.');
  const detail = args.detail ?? 'compact';
  if (!['compact', 'full', 'cooccurrence'].includes(detail)) fail('invalid_arguments', 'detail must be compact, full or cooccurrence.');
  if (detail === 'cooccurrence') {
    if (args.names !== undefined) fail('invalid_arguments', 'Cooccurrence requires one name; do not expand a whole names batch.');
    const { lookup, cooccurrenceLookup = lookupTagCooccurrence, ...cooccurrenceOptions } = options;
    const request = normalizeCooccurrenceQuery(args.name, args);
    if (typeof cooccurrenceLookup !== 'function') fail('invalid_arguments', 'A cooccurrence lookup function is required.');
    return cooccurrenceLookup(request.name, { ...cooccurrenceOptions, limit: request.limit, rating: request.rating });
  }
  if (args.limit !== undefined || args.rating !== undefined) fail('invalid_arguments', 'limit and rating are only used with detail:cooccurrence.');
  const names = args.names === undefined ? [args.name] : args.names;
  if (!Array.isArray(names) || names.length < 1 || names.length > MAX_BATCH_NAMES) fail('invalid_arguments', 'names must contain 1–20 English tag names.');
  // Validate the whole batch before dispatch, then deduplicate normalized names.
  const unique = new Map();
  for (const value of names) { const name = normalizeName(value); if (!unique.has(name)) unique.set(name, value); }
  const { lookup = lookupTagDetails, cooccurrenceLookup, ...lookupOptions } = options;
  if (typeof lookup !== 'function') fail('invalid_arguments', 'A tag lookup function is required.');
  const inputs = [...unique.values()], items = new Array(inputs.length), checkedTimes = new Array(inputs.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < inputs.length) {
      const index = cursor++;
      const raw = await lookup(inputs[index], lookupOptions);
      checkedTimes[index] = typeof raw?.checkedAt === 'string' && Number.isFinite(Date.parse(raw.checkedAt)) ? raw.checkedAt : null;
      items[index] = detail === 'full' ? raw : compactTagDetails(raw);
    }
  };
  await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, inputs.length) }, worker));
  // Use actual lookup timestamps, not a fresh wrapper timestamp that could
  // misrepresent an injected/cached record. Missing provenance stays unknown.
  const checkedAt = checkedTimes.every(Boolean) ? checkedTimes.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest) : null;
  return { source: 'danbooru-public-api', detail, checkedAt, count: items.length, items };
}
