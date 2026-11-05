/**
 * Cross-process coordination for fixed, unauthenticated Danbooru tag evidence.
 *
 * The cache contains only public HTTP JSON responses. Locks are per URL except
 * for the millisecond-scale throttle state update; they never cover generation
 * or any workspace/author data.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDataPaths } from './data-paths.mjs';
import { USER_AGENT } from './version.mjs';

const API = 'https://danbooru.donmai.us';
const PATHS = new Set(['/tags.json', '/tag_aliases.json', '/wiki_pages.json', '/related_tag.json']);
/** <data root>/runtime/public-tag-query-cache-v1, shared by the MCP server and the client. */
const defaultRoot = () => resolveDataPaths().tagQueryCache;
const EVIDENCE = Symbol.for('novelai.publicTagQueryEvidence.v1');
// Test harnesses and embedders may intentionally replace global fetch with an
// isolated transport. Do not let project cache state bypass that transport;
// callers can explicitly provide a coordinator when they want it coordinated.
const PLATFORM_FETCH = globalThis.fetch;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const PUBLIC_RESPONSE_HEADERS = ['content-type', 'content-length', 'retry-after', 'date', 'etag', 'last-modified', 'cache-control'];
function publicResponseHeaders(input) {
  const source = new Headers(input), headers = {};
  for (const name of PUBLIC_RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers[name] = value;
  }
  return headers;
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function option(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Object.assign(new Error(`${name} is invalid.`), { code: 'invalid_arguments' });
  return value;
}
function validateUrl(value) {
  const invalid = () => { throw Object.assign(new Error('Only bounded public Danbooru tag queries may be coordinated.'), { code: 'invalid_arguments' }); };
  let url;
  try { url = new URL(value); } catch { invalid(); }
  if (url.origin !== API || !PATHS.has(url.pathname) || url.username || url.password || url.hash) invalid();
  const entries = [...url.searchParams], keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length || entries.some(([key]) => /(?:api[_-]?key|login|token|password|auth|cookie)/i.test(key))) invalid();
  const exactKeys = allowed => keys.every(key => allowed.has(key));
  const boundedName = name => typeof name === 'string' && name.length >= 1 && name.length <= 200 && !/[^\x20-\x7e]/.test(name);
  const optionalDetails = (primary, only) => exactKeys(new Set([primary, 'limit', 'only'])) && boundedName(url.searchParams.get(primary))
    && (!url.searchParams.has('limit') || url.searchParams.get('limit') === '2')
    && (!url.searchParams.has('only') || url.searchParams.get('only') === only);
  const valid = url.pathname === '/tags.json'
    ? optionalDetails('search[name]', 'id,name,category,post_count,is_deprecated')
    : url.pathname === '/tag_aliases.json'
      ? exactKeys(new Set(['search[antecedent_name]', 'search[status]', 'limit', 'only']))
        && boundedName(url.searchParams.get('search[antecedent_name]'))
        && (!url.searchParams.has('search[status]') || url.searchParams.get('search[status]') === 'active')
        && (!url.searchParams.has('limit') || url.searchParams.get('limit') === '2')
        && (!url.searchParams.has('only') || url.searchParams.get('only') === 'id,antecedent_name,consequent_name,status')
      : url.pathname === '/wiki_pages.json'
        ? optionalDetails('search[title]', 'id,title,body,is_deleted')
        : exactKeys(new Set(['search[query]', 'search[category]', 'search[order]', 'search[search_sample_size]', 'limit']))
          && /^[a-z0-9][a-z0-9_!?()./'&#+=\-]{0,199} rating:[gsqe]$/.test(url.searchParams.get('search[query]') ?? '')
          && url.searchParams.get('search[category]') === 'general'
          && url.searchParams.get('search[order]') === 'frequency'
          && url.searchParams.get('search[search_sample_size]') === '5000'
          && /^(?:[2-9]|1\d|2[01])$/.test(url.searchParams.get('limit') ?? '');
  if (!valid) invalid();
  return url.href;
}
function abortError(signal) { return signal?.reason ?? Object.assign(new Error('The public tag query was cancelled.'), { name: 'AbortError' }); }
async function awaitCaller(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);
  return new Promise((resolveWait, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolveWait(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
function responseFrom(snapshot) {
  const bytes = Buffer.from(snapshot.body ?? '', 'base64');
  const body = [204, 205, 304].includes(snapshot.status) ? null : bytes;
  const response = new Response(body, { status: snapshot.status, statusText: snapshot.statusText, headers: publicResponseHeaders(snapshot.headers) });
  // Native constructed responses have no request URL/redirect history, so
  // restore both from the bounded snapshot for the consumer's redirect check.
  Object.defineProperty(response, 'url', { value: snapshot.responseUrl || snapshot.url, configurable: true });
  Object.defineProperty(response, 'redirected', { value: snapshot.redirected === true, configurable: true });
  Object.defineProperty(response, EVIDENCE, { value: snapshot.evidence, configurable: false });
  return response;
}
export function tagQueryEvidence(response) {
  const value = response?.[EVIDENCE];
  return record(value) && ['network', 'cache', 'shared_failure'].includes(value.retrieval) && Number.isFinite(Date.parse(value.checkedAt)) ? { ...value } : null;
}

export function createTagQueryCoordinator(options = {}) {
  if (!record(options)) throw Object.assign(new Error('Coordinator options must be an object.'), { code: 'invalid_arguments' });
  const root = resolve(options.root ?? process.env.NOVELAI_TAG_QUERY_CACHE_DIR ?? defaultRoot());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw Object.assign(new Error('A fetch function is required.'), { code: 'invalid_arguments' });
  const cacheTtlMs = option(options.cacheTtlMs, 6 * 60 * 60 * 1000, 1000, 7 * 24 * 60 * 60 * 1000, 'cacheTtlMs');
  const minIntervalMs = option(options.minIntervalMs, 250, 0, 10_000, 'minIntervalMs');
  const defaultCooldownMs = option(options.defaultCooldownMs, 5_000, 100, 60_000, 'defaultCooldownMs');
  const failureTtlMs = option(options.failureTtlMs, 1_000, 100, 10_000, 'failureTtlMs');
  const maxCooldownMs = option(options.maxCooldownMs, 60_000, defaultCooldownMs, 5 * 60_000, 'maxCooldownMs');
  const maxWaitMs = option(options.maxWaitMs, 30_000, 100, 120_000, 'maxWaitMs');
  const requestTimeoutMs = option(options.requestTimeoutMs, 30_000, 100, 120_000, 'requestTimeoutMs');
  const minimumLockWindowMs = maxWaitMs + requestTimeoutMs + 10_000;
  const lockHardLimitMs = option(options.lockHardLimitMs ?? options.lockLeaseMs, minimumLockWindowMs, minimumLockWindowMs, 300_000, 'lockHardLimitMs');
  const pollMs = option(options.pollMs, 25, 1, 1000, 'pollMs');
  const maxCaptureBytes = option(options.maxCaptureBytes, 1024 * 1024, 1024, 2 * 1024 * 1024, 'maxCaptureBytes');
  const maxCacheEntries = option(options.maxCacheEntries, 512, 1, 10_000, 'maxCacheEntries');
  const failpoint = options.failpoint ?? (async () => {});
  if (typeof failpoint !== 'function') throw Object.assign(new Error('failpoint is invalid.'), { code: 'invalid_arguments' });
  // The time source of every lease, throttle slot, cooldown and expiry (default the system clock). Tests inject a
  // virtual clock: now() returns its time in ms and wait(ms) advances it, so no test depends on real time passing.
  const clock = options.clock ?? { now: Date.now, wait: sleep };
  if (!record(clock) || typeof clock.now !== 'function' || typeof clock.wait !== 'function') throw Object.assign(new Error('clock must provide now() and wait(ms).'), { code: 'invalid_arguments' });
  const now = () => clock.now(), wait = ms => clock.wait(ms);
  const responses = resolve(root, 'responses'), failures = resolve(root, 'failures');
  const databaseFile = resolve(root, 'coordination.sqlite');
  const inflight = new Map();
  let database, initialization;

  async function initialize() {
    initialization ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await Promise.all([responses, failures].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
      const deadline = now() + Math.min(maxWaitMs, 5_000);
      while (now() < deadline) {
        let candidate;
        try {
          candidate = new DatabaseSync(databaseFile);
          candidate.exec(`PRAGMA busy_timeout=${Math.min(100, maxWaitMs)};`);
          candidate.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS query_locks (
              name TEXT PRIMARY KEY, token TEXT NOT NULL, pid INTEGER NOT NULL,
              acquired_at INTEGER NOT NULL, hard_until INTEGER NOT NULL
            ) STRICT;
            CREATE TABLE IF NOT EXISTS throttle_state (
              id INTEGER PRIMARY KEY CHECK (id = 1), next_at INTEGER NOT NULL, cooldown_until INTEGER NOT NULL
            ) STRICT;
            INSERT OR IGNORE INTO throttle_state(id, next_at, cooldown_until) VALUES(1, 0, 0);`);
          database = candidate;
          return;
        } catch (error) {
          try { candidate?.close(); } catch {}
          if (!sqliteBusy(error)) throw error;
          await wait(Math.min(pollMs, Math.max(1, deadline - now())));
        }
      }
      throw Object.assign(new Error('Public tag query coordination database timed out.'), { code: 'coordination_timeout' });
    })();
    return initialization;
  }
  function runFenced(owner, action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (!owner.owns()) { database.exec('ROLLBACK'); return false; }
      action();
      database.exec('COMMIT');
      return true;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  async function atomicWrite(file, value, owner) {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      await failpoint('before-fenced-publish', { file });
      // The transaction contains no await: reapers cannot replace owner
      // between the token check and atomic publication rename.
      return runFenced(owner, () => renameSync(temporary, file));
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function readJson(file, maximum = maxCaptureBytes * 2) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > maximum) return null;
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  }
  const sqliteBusy = error => /(?:busy|locked)/i.test(error?.message ?? '');
  async function acquire(name, deadline) {
    const token = randomUUID();
    const insert = database.prepare('INSERT OR IGNORE INTO query_locks(name, token, pid, acquired_at, hard_until) VALUES(?, ?, ?, ?, ?)');
    const select = database.prepare('SELECT token, pid, acquired_at, hard_until FROM query_locks WHERE name = ?');
    const reap = database.prepare('DELETE FROM query_locks WHERE name = ? AND token = ? AND hard_until = ?');
    const releaseStatement = database.prepare('DELETE FROM query_locks WHERE name = ? AND token = ?');
    const ownsStatement = database.prepare('SELECT 1 AS owned FROM query_locks WHERE name = ? AND token = ?');
    while (now() < deadline) {
      const current = now();
      try {
        if (insert.run(name, token, process.pid, current, current + lockHardLimitMs).changes === 1) {
          const release = async () => { releaseStatement.run(name, token); };
          release.owns = () => Boolean(ownsStatement.get(name, token));
          return release;
        }
        const owner = select.get(name);
        if (!owner) continue;
        let alive = true;
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); } catch (ownerError) { alive = ownerError.code !== 'ESRCH'; }
        } else alive = false;
        const deadAfterGrace = !alive && current - owner.acquired_at > Math.max(100, pollMs * 4);
        if (deadAfterGrace || current > owner.hard_until) {
          // Token + deadline are the fencing comparison: another reaper that
          // already replaced this row makes this DELETE a no-op.
          reap.run(name, owner.token, owner.hard_until);
          continue;
        }
      } catch (error) { if (!sqliteBusy(error)) throw error; }
      await wait(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    throw Object.assign(new Error('Public tag query coordination timed out before dispatch.'), { code: 'coordination_timeout' });
  }
  async function publish(file, value, owner) {
    const release = await acquire('cache-quota', now() + Math.min(maxWaitMs, 5_000));
    try {
      let existing = true;
      try { await stat(file); } catch (error) { if (error.code === 'ENOENT') existing = false; else throw error; }
      if (!existing) {
        const files = [];
        for (const directory of [responses, failures]) for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) files.push(resolve(directory, entry.name));
        }
        if (files.length >= maxCacheEntries) {
          const candidates = [];
          for (const candidate of files) try { candidates.push({ file: candidate, mtimeMs: (await stat(candidate)).mtimeMs }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
          for (const candidate of candidates.slice(0, Math.max(0, candidates.length - maxCacheEntries + 1))) await unlink(candidate.file).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
      }
      return await atomicWrite(file, value, owner);
    } finally { await release(); }
  }
  function paths(url) {
    const key = hash(url);
    return { key, cache: resolve(responses, `${key}.json`), failure: resolve(failures, `${key}.json`), lock: `request:${key}` };
  }
  function validSnapshot(value, url) {
    return record(value) && value.schemaVersion === 1 && value.url === url && Number.isSafeInteger(value.status) && value.status >= 200 && value.status <= 599
      && typeof value.statusText === 'string' && record(value.headers) && typeof value.body === 'string' && Number.isFinite(Date.parse(value.fetchedAt));
  }
  async function cached(url, file) {
    const value = await readJson(file);
    if (!validSnapshot(value, url) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
      if (value) await unlink(file).catch(() => {});
      return null;
    }
    return { ...value, evidence: { retrieval: 'cache', checkedAt: value.fetchedAt, cachedAt: value.cachedAt } };
  }
  async function recentFailure(url, file) {
    const value = await readJson(file);
    if (!validSnapshot(value, url) || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) {
      if (value) await unlink(file).catch(() => {});
      return null;
    }
    return { ...value, evidence: { retrieval: 'shared_failure', checkedAt: value.fetchedAt } };
  }
  function retryDelay(headers) {
    const raw = headers.get('retry-after');
    if (raw && /^\d+$/.test(raw.trim())) return Math.min(maxCooldownMs, Math.max(defaultCooldownMs, Number(raw.trim()) * 1000));
    const date = raw ? Date.parse(raw) : NaN;
    return Math.min(maxCooldownMs, Math.max(defaultCooldownMs, Number.isFinite(date) ? date - now() : 0));
  }
  async function throttle(deadline) {
    const readState = database.prepare('SELECT next_at, cooldown_until FROM throttle_state WHERE id = 1');
    const updateState = database.prepare('UPDATE throttle_state SET next_at = ?, cooldown_until = ? WHERE id = 1');
    while (now() < deadline) {
      const release = await acquire('throttle', deadline);
      let blocked = 0, granted = null;
      try {
        const state = readState.get(), current = now();
        const blockedUntil = Math.max(state.next_at, state.cooldown_until);
        if (blockedUntil > current) blocked = blockedUntil - current;
        else { updateState.run(current + minIntervalMs, state.cooldown_until); granted = current; }
      } finally { await release(); }
      // Observation point for tests: the time this request's dispatch slot was granted (shared across processes).
      if (granted !== null) { await failpoint('throttle-granted', { at: granted }); return; }
      await wait(Math.min(blocked || pollMs, pollMs, Math.max(1, deadline - now())));
    }
    throw Object.assign(new Error('Public tag query throttle wait timed out.'), { code: 'coordination_timeout' });
  }
  async function setCooldown(until, deadline, owner) {
    const release = await acquire('throttle', deadline);
    try {
      return runFenced(owner, () => {
        const state = database.prepare('SELECT next_at, cooldown_until FROM throttle_state WHERE id = 1').get();
        database.prepare('UPDATE throttle_state SET cooldown_until = ? WHERE id = 1').run(Math.max(state.cooldown_until, until));
      });
    } finally { await release(); }
  }
  async function capture(response, url, fetchedAt, signal) {
    const headers = publicResponseHeaders(response.headers);
    const base = { schemaVersion: 1, url, responseUrl: response.url || url, redirected: response.redirected === true,
      status: response.status, statusText: response.statusText, headers, fetchedAt };
    const reader = response.body?.getReader();
    if (!reader) {
      delete headers['content-encoding']; delete headers['transfer-encoding'];
      headers['content-length'] = '0';
      return { ...base, headers, body: '', cacheable: false };
    }
    const chunks = []; let size = 0, overflow = false, complete = false;
    try {
      while (true) {
        const { done, value } = await awaitCaller(reader.read(), signal);
        if (done) { complete = true; break; }
        if (!(value instanceof Uint8Array)) { overflow = true; break; }
        size += value.byteLength;
        if (size > maxCaptureBytes) { overflow = true; break; }
        chunks.push(value);
      }
    } finally {
      // A broken transport is allowed to ignore cancellation. Releasing the
      // coordination lock must never await its cancel promise.
      if (overflow || !complete) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
      try { reader.releaseLock(); } catch {}
    }
    if (overflow) {
      delete headers['content-encoding']; delete headers['transfer-encoding'];
      headers['content-length'] = String(maxCaptureBytes + 1);
      return { ...base, headers, body: '', cacheable: false };
    }
    const bytes = Buffer.concat(chunks);
    // Fetch exposes decoded body bytes. Do not replay stale wire encoding or
    // transfer headers; the reconstructed response describes these bytes.
    delete headers['content-encoding']; delete headers['transfer-encoding'];
    headers['content-length'] = String(bytes.byteLength);
    let cacheable = /^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(headers['content-type'] ?? '');
    if (cacheable) { try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { cacheable = false; } }
    return { ...base, headers, body: bytes.toString('base64'), cacheable: response.status === 200 && cacheable && !base.redirected && base.responseUrl === url };
  }
  async function execute(url, init, files) {
    await initialize();
    const deadline = now() + maxWaitMs;
    let value = await cached(url, files.cache) ?? await recentFailure(url, files.failure);
    if (value) return value;
    const release = await acquire(files.lock, deadline);
    try {
      value = await cached(url, files.cache) ?? await recentFailure(url, files.failure);
      if (value) return value;
      await throttle(deadline);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(Object.assign(new Error('Public tag upstream request timed out.'), { code: 'upstream_timeout' })), requestTimeoutMs);
      let response, snapshot;
      try {
        response = await awaitCaller(fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
        const fetchedAt = new Date(now()).toISOString();
        snapshot = await capture(response, url, fetchedAt, controller.signal);
      } finally { clearTimeout(timeout); }
      const fetchedAt = snapshot.fetchedAt;
      snapshot.evidence = { retrieval: 'network', checkedAt: fetchedAt };
      const persistenceError = stage => { (snapshot.evidence.coordinationErrors ??= []).push(stage); };
      if (snapshot.status === 429) {
        const cooldownUntil = now() + retryDelay(response.headers);
        snapshot.expiresAt = cooldownUntil;
        try { if (!await setCooldown(cooldownUntil, now() + Math.min(maxWaitMs, 5_000), release)) persistenceError('stale_owner_not_published'); }
        catch { persistenceError('cooldown_not_recorded'); }
        try { if (!await publish(files.failure, snapshot, release)) persistenceError('stale_owner_not_published'); }
        catch { persistenceError('failure_not_shared'); }
      } else if (snapshot.status >= 200 && snapshot.status < 300 && snapshot.cacheable) {
        snapshot.cachedAt = new Date(now()).toISOString(); snapshot.expiresAt = now() + cacheTtlMs;
        try { if (!await publish(files.cache, snapshot, release)) persistenceError('stale_owner_not_published'); }
        catch { persistenceError('response_not_cached'); }
      } else {
        // Briefly fan out the same bounded HTTP/malformed-response evidence to
        // concurrent waiters. This is not a retry or a long-lived fact cache.
        snapshot.expiresAt = now() + failureTtlMs;
        try { if (!await publish(files.failure, snapshot, release)) persistenceError('stale_owner_not_published'); }
        catch { persistenceError('failure_not_shared'); }
      }
      return snapshot;
    } finally { await release(); }
  }

  async function coordinatedFetch(input, init = {}) {
    const url = validateUrl(input);
    if (!record(init) || (init.method !== undefined && init.method !== 'GET')) throw Object.assign(new Error('Only public GET tag evidence may be coordinated.'), { code: 'invalid_arguments' });
    if (init.signal !== undefined && !(init.signal instanceof AbortSignal)) throw Object.assign(new Error('An optional AbortSignal is required.'), { code: 'invalid_arguments' });
    // Never forward caller credentials or ambient referrer state. These fixed
    // public endpoints need only content negotiation and a descriptive agent.
    const sharedInit = { method: 'GET', headers: {
      Accept: 'application/json',
      'User-Agent': `${USER_AGENT} (public tag evidence)`,
    }, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' };
    const files = paths(url);
    let pending = inflight.get(files.key);
    if (!pending) {
      pending = execute(url, sharedInit, files).finally(() => inflight.delete(files.key));
      inflight.set(files.key, pending);
    }
    return responseFrom(await awaitCaller(pending, init.signal));
  }
  return { fetch: coordinatedFetch, root };
}

let defaultCoordinator;
export function coordinatedTagFetch(url, options) {
  // node:test commonly swaps global fetch per isolated fixture. Its explicit
  // coordinator tests still exercise this module without allowing one fixture's
  // synthetic response to leak into another fixture through the default cache.
  if (process.env.NODE_TEST_CONTEXT || globalThis.fetch !== PLATFORM_FETCH) return globalThis.fetch(url, options);
  defaultCoordinator ??= createTagQueryCoordinator({ fetchImpl: PLATFORM_FETCH });
  return defaultCoordinator.fetch(url, options);
}
