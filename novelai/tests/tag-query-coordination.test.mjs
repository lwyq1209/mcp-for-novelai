import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import { createTagQueryCoordinator as createCoordinator, tagQueryEvidence } from '../src/tag-query-coordinator.mjs';
import { lookupTagDetails, queryTagDetails } from '../src/tag-details.mjs';
import { lookupTagCooccurrence } from '../src/tag-cooccurrence.mjs';

const tag = (name, extra = {}) => ({ id: 12, name, category: 0, post_count: 123, is_deprecated: false, ...extra });
const wiki = (title, body = 'A public fixture definition.') => ({ id: 23, title, body, is_deleted: false });
const json = (value, status = 200, headers = {}) => {
  const text = JSON.stringify(value);
  return new Response(text, { status, headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), ...headers } });
};
// The coordinators each test opens on its cache root, closed before the root is removed: Windows cannot delete an
// open coordination.sqlite, and a failing after hook would skip the later ones (the mock server, the child processes).
const opened = new Map();
function createTagQueryCoordinator(options) {
  const coordinator = createCoordinator(options);
  opened.get(options?.root)?.push(coordinator);
  return coordinator;
}
async function root(t, prefix = 'nai-tag-coordinate-') {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  opened.set(directory, []);
  t.after(async () => {
    for (const coordinator of opened.get(directory)) await coordinator.close();
    opened.delete(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return directory;
}
function endpointFixture(onCall = () => {}) {
  return async address => {
    const url = new URL(address), path = url.pathname;
    const field = path === '/tags.json' ? 'name' : path === '/tag_aliases.json' ? 'antecedent_name' : 'title';
    const name = url.searchParams.get(`search[${field}]`);
    onCall(url);
    if (path === '/tags.json') return json(name === 'missing_fixture' ? [] : [tag(name)]);
    if (path === '/tag_aliases.json') return json([]);
    if (path === '/wiki_pages.json') return json(name === 'missing_fixture' ? [] : [wiki(name)]);
    throw new Error('unexpected endpoint');
  };
}

async function mockServer(t, handler) {
  const calls = [];
  const server = http.createServer((request, response) => {
    calls.push({ url: request.url, at: Date.now() });
    handler(request, response, calls.length);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  return { calls, origin: `http://127.0.0.1:${server.address().port}` };
}
// Covers startup + bounded initialization/coordination/request/publication,
// without weakening production deadlines or leaving a hanging test child.
function childQuery({ t, cacheRoot, origin, url, minIntervalMs = 0, defaultCooldownMs = 100, maxCooldownMs = 200, failureTtlMs = 1000, timeoutMs = 20000 }) {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'tag-query-coordinator.mjs')).href;
  const script = `
    import { createTagQueryCoordinator, tagQueryEvidence } from ${JSON.stringify(moduleUrl)};
    const [root, origin, target, interval, cooldown, maxCooldown, failureTtl] = process.argv.slice(1);
    const fetchImpl = async (url, init) => {
      const source = new URL(url), response = await fetch(origin + source.pathname + source.search, { signal: init.signal });
      const bytes = await response.arrayBuffer();
      const rebuilt = new Response(bytes, { status: response.status, headers: response.headers });
      Object.defineProperty(rebuilt, 'url', { value: url });
      return rebuilt;
    };
    let granted = null;
    const failpoint = async (stage, detail) => { if (stage === 'throttle-granted') granted = detail.at; };
    const coordinator = createTagQueryCoordinator({ root, fetchImpl, minIntervalMs: Number(interval), defaultCooldownMs: Number(cooldown), maxCooldownMs: Number(maxCooldown), failureTtlMs: Number(failureTtl), pollMs: 5, maxWaitMs: 3000, requestTimeoutMs: 2000, lockLeaseMs: 15000, failpoint });
    const response = await coordinator.fetch(target, { method: 'GET' });
    process.stdout.write(JSON.stringify({ status: response.status, body: await response.text(), evidence: tagQueryEvidence(response), granted }));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, cacheRoot, origin, url, String(minIntervalMs), String(defaultCooldownMs), String(maxCooldownMs), String(failureTtlMs)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', settled = false;
  child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; });
  t?.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return new Promise((resolveChild, reject) => {
    const timer = setTimeout(() => {
      if (settled) return; settled = true; child.kill('SIGKILL');
      reject(new Error(`child query exceeded ${timeoutMs}ms: ${stderr}`));
    }, timeoutMs);
    child.once('error', error => {
      if (settled) return; settled = true; clearTimeout(timer); reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code !== 0) reject(new Error(`child exited ${code ?? signal}: ${stderr}`));
      else { try { resolveChild(JSON.parse(stdout)); } catch (error) { reject(new Error(`invalid child output: ${stdout}\n${stderr}`, { cause: error })); } }
    });
  });
}

test('same-process concurrent details merge and later cache hits retain original evidence time', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl: endpointFixture(() => calls++), minIntervalMs: 0, pollMs: 2 });
  const [first, joined] = await Promise.all([
    lookupTagDetails('teacup', { queryCoordinator: coordinator }),
    lookupTagDetails('teacup', { queryCoordinator: coordinator }),
  ]);
  assert.equal(calls, 3, 'tag, alias and wiki HTTP evidence must each dispatch once');
  assert.equal(first.resolution, 'canonical'); assert.equal(joined.resolution, 'canonical');
  const cached = await queryTagDetails({ name: 'teacup' }, { queryCoordinator: coordinator });
  assert.equal(calls, 3); assert.equal(cached.items[0].evidence.retrieval, 'cache');
  assert.equal(cached.items[0].evidence.sourceCheckedAt, first.checkedAt);
  assert.equal(cached.checkedAt, first.checkedAt, 'a cache hit must not claim a fresh lookup time');
  assert.ok(cached.items[0].sources.length >= 2);
});

test('cached empty arrays remain not_found rather than unknown', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl: endpointFixture(() => calls++), minIntervalMs: 0, pollMs: 2 });
  const first = await lookupTagDetails('missing_fixture', { queryCoordinator: coordinator });
  const cached = await lookupTagDetails('missing_fixture', { queryCoordinator: coordinator });
  assert.equal(calls, 3); assert.equal(first.resolution, 'not_found'); assert.equal(cached.resolution, 'not_found');
  assert.equal(cached.tag.status, 'not_found'); assert.equal(cached.evidence.retrieval, 'cache');
  assert.equal(cached.checkedAt, first.checkedAt);
});

test('cooccurrence cache keys and returned scope preserve the explicit rating', async t => {
  const cacheRoot = await root(t); const urls = [];
  const fetchImpl = async address => {
    const url = new URL(address); urls.push(url);
    const query = url.searchParams.get('search[query]');
    return json({ query, post_count: 5, tag: { name: 'teacup', category: 0, post_count: 20 }, related_tags: [{ tag: { name: 'table', category: 0, post_count: 30 }, frequency: .8 }] });
  };
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl, minIntervalMs: 0, pollMs: 2 });
  const first = await lookupTagCooccurrence('teacup', { rating: 'e', queryCoordinator: coordinator });
  const cached = await lookupTagCooccurrence('teacup', { rating: 'e', queryCoordinator: coordinator });
  const general = await lookupTagCooccurrence('teacup', { rating: 'g', queryCoordinator: coordinator });
  assert.equal(urls.length, 2); assert.deepEqual(urls.map(url => url.searchParams.get('search[query]')), ['teacup rating:e', 'teacup rating:g']);
  assert.equal(first.scope, 'rating:e'); assert.equal(cached.scope, 'rating:e'); assert.equal(general.scope, 'rating:g');
  assert.equal(cached.evidence.retrieval, 'cache'); assert.equal(cached.checkedAt, first.checkedAt);
});

test('details validates its options envelope and aggregates all shared failures exactly', async t => {
  await assert.rejects(lookupTagDetails('teacup', null), { code: 'invalid_arguments' });
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, failureTtlMs: 1000, fetchImpl: async () => { calls++; return json({ error: 'fixture' }, 503); } });
  await lookupTagDetails('teacup', { queryCoordinator: coordinator });
  const shared = await lookupTagDetails('teacup', { queryCoordinator: coordinator });
  assert.equal(calls, 3); assert.equal(shared.evidence.retrieval, 'shared_failure'); assert.equal(shared.evidence.sharedFailures, 3);
  assert.equal(shared.resolution, 'unknown'); assert.ok(shared.errors.every(error => error.code === 'upstream_error'));
});

test('separate processes merge one identical public HTTP query through the shared cache', async t => {
  const cacheRoot = await root(t, 'nai-tag-cross-process-');
  const server = await mockServer(t, (_request, response) => {
    setTimeout(() => { const text = JSON.stringify([{ id: 12, name: 'teacup' }]); response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text); }, 80);
  });
  const url = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=teacup&limit=2';
  const [a, b] = await Promise.all([childQuery({ t, cacheRoot, origin: server.origin, url }), childQuery({ t, cacheRoot, origin: server.origin, url })]);
  assert.equal(server.calls.length, 1); assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(a.body, b.body);
  assert.deepEqual(new Set([a.evidence.retrieval, b.evidence.retrieval]), new Set(['network', 'cache']));
  assert.equal(a.evidence.checkedAt, b.evidence.checkedAt);
});

test('concurrent stale-lease reapers use token CAS and cannot replace the winner', async t => {
  const cacheRoot = await root(t, 'nai-tag-stale-cas-');
  const initializer = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, fetchImpl: async () => json([]) });
  await initializer.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=initialize', { method: 'GET' });
  const server = await mockServer(t, (_request, response) => {
    setTimeout(() => { const text = '[]'; response.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' }); response.end(text); }, 80);
  });
  const url = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=stale_cas&limit=2';
  const key = createHash('sha256').update(url).digest('hex'), db = new DatabaseSync(join(cacheRoot, 'coordination.sqlite'));
  db.prepare('INSERT INTO query_locks(name, token, pid, acquired_at, hard_until) VALUES(?, ?, ?, ?, ?)')
    .run(`request:${key}`, 'dead-owner', 2147483646, Date.now() - 20_000, Date.now() - 1);
  db.close();
  const results = await Promise.all(Array.from({ length: 4 }, () => childQuery({ t, cacheRoot, origin: server.origin, url })));
  assert.equal(server.calls.length, 1); assert.ok(results.every(result => result.status === 200));
  assert.equal(results.filter(result => result.evidence.retrieval === 'network').length, 1);
});

test('a former owner losing its token immediately before rename cannot publish', async t => {
  const cacheRoot = await root(t); let calls = 0, revoked = false;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, maxWaitMs: 100, requestTimeoutMs: 100,
    lockHardLimitMs: 10200, fetchImpl: async () => { calls++; return json([]); }, failpoint: async stage => {
      if (stage !== 'before-fenced-publish' || revoked) return;
      revoked = true;
      const db = new DatabaseSync(join(cacheRoot, 'coordination.sqlite'));
      db.prepare("UPDATE query_locks SET token = 'replacement-owner', hard_until = ? WHERE name LIKE 'request:%'").run(Date.now() - 1);
      db.close();
    } });
  const url = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=fenced_publish';
  const stale = await coordinator.fetch(url, { method: 'GET' });
  assert.ok(tagQueryEvidence(stale).coordinationErrors.includes('stale_owner_not_published'));
  const fresh = await coordinator.fetch(url, { method: 'GET' });
  assert.equal(calls, 2); assert.equal(tagQueryEvidence(fresh).retrieval, 'network');
});

test('cross-process concurrent HTTP failures fan out once without becoming cached facts', async t => {
  const cacheRoot = await root(t, 'nai-tag-cross-failure-');
  const server = await mockServer(t, (_request, response) => {
    setTimeout(() => { const text = JSON.stringify({ error: 'fixture unavailable' }); response.writeHead(503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); response.end(text); }, 60);
  });
  const url = 'https://danbooru.donmai.us/wiki_pages.json?search%5Btitle%5D=teacup&limit=2';
  // The second process must read the shared failure while it is fresh; the longest sharing window (10 s) keeps a slow
  // process start on a busy machine from turning the merge into a second request.
  const [a, b] = await Promise.all([childQuery({ t, cacheRoot, origin: server.origin, url, failureTtlMs: 10_000 }), childQuery({ t, cacheRoot, origin: server.origin, url, failureTtlMs: 10_000 })]);
  assert.equal(server.calls.length, 1); assert.equal(a.status, 503); assert.equal(b.status, 503);
  assert.match(a.body, /fixture unavailable/); assert.equal(a.body, b.body, 'shared HTTP failures retain the bounded response body');
  assert.deepEqual(new Set([a.evidence.retrieval, b.evidence.retrieval]), new Set(['network', 'shared_failure']));
  assert.equal(a.evidence.checkedAt, b.evidence.checkedAt);
});

test('cross-process throttle spaces distinct requests without holding a global request lock', async t => {
  const cacheRoot = await root(t, 'nai-tag-throttle-');
  const server = await mockServer(t, (_request, response) => {
    const text = '[]'; response.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' }); response.end(text);
  });
  const one = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=one&limit=2';
  const two = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=two&limit=2';
  const [a, b] = await Promise.all([childQuery({ t, cacheRoot, origin: server.origin, url: one, minIntervalMs: 120 }), childQuery({ t, cacheRoot, origin: server.origin, url: two, minIntervalMs: 120 })]);
  assert.equal(server.calls.length, 2); assert.equal(a.status, 200); assert.equal(b.status, 200);
  // Both distinct requests were dispatched; the shared throttle granted their slots at least minIntervalMs apart.
  // The slots are compared, not the arrival times at the fixture server, which also contain each process's scheduling.
  assert.ok(Number.isFinite(a.granted) && Number.isFinite(b.granted), JSON.stringify([a.granted, b.granted]));
  assert.ok(Math.abs(b.granted - a.granted) >= 120, `throttle slots only ${Math.abs(b.granted - a.granted)}ms apart`);
  // … and each request was sent only after its own slot was granted (one wall clock for all three processes).
  for (const [name, child] of [['one', a], ['two', b]]) {
    const arrival = server.calls.find(call => new URL(call.url, server.origin).searchParams.get('search[name]') === name);
    assert.ok(arrival && arrival.at >= child.granted, `${name}: arrived at ${arrival?.at}, slot granted at ${child.granted}`);
  }
});

/** A virtual clock: waiting advances it at once, so timing assertions do not depend on how busy the machine is. */
function virtualClock(start = 1_800_000_000_000) {
  let time = start;
  return { now: () => time, wait: async ms => { time += ms; } };
}

test('429 creates bounded shared cooldown, is not retried, and keeps unknown distinct from absence', async t => {
  const cacheRoot = await root(t); const calls = [], clock = virtualClock();
  const fetchImpl = async address => {
    calls.push({ address, at: clock.now() });
    if (new URL(address).pathname === '/tags.json') return json({ error: 'rate limited' }, 429, { 'retry-after': '0' });
    return json([]);
  };
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl, minIntervalMs: 0, defaultCooldownMs: 120, maxCooldownMs: 150, pollMs: 5, clock });
  const exact = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=limited_fixture&limit=2';
  const firstResponse = await coordinator.fetch(exact, { method: 'GET' });
  const secondResponse = await coordinator.fetch(exact, { method: 'GET' });
  assert.equal(firstResponse.status, 429); assert.equal(secondResponse.status, 429);
  assert.equal(tagQueryEvidence(secondResponse).retrieval, 'shared_failure');
  assert.equal(calls.length, 1, 'the failed query is never immediately retried');
  await coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=different_fixture&limit=2', { method: 'GET' });
  // Retry-After 0 still means the bounded default cooldown (120 ms), counted from the 429; the next dispatch waits it
  // out and starts within one poll after it ends.
  const delay = calls[1].at - calls[0].at;
  assert.ok(delay >= 120 && delay <= 125, `cooldown dispatch came ${delay}ms after the 429`);
  const unknownResult = await lookupTagDetails('unknown_fixture', { queryCoordinator: coordinator });
  assert.equal(unknownResult.tag.status, 'unknown'); assert.notEqual(unknownResult.resolution, 'not_found');
  assert.ok(unknownResult.errors.some(error => error.code === 'upstream_error'));
});

test('a caller can cancel while broken body cancellation cannot retain the URL lock', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls > 1) return json([]);
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
  };
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl, minIntervalMs: 0, requestTimeoutMs: 100, lockLeaseMs: 15000, maxWaitMs: 3000, pollMs: 2 });
  const url = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=teacup';
  const controller = new AbortController();
  const pending = coordinator.fetch(url, { method: 'GET', signal: controller.signal });
  // A second waiter observes the shared upstream's actual terminal event. A
  // fixed sleep could rejoin that still-live request under process contention.
  const sharedWaiter = coordinator.fetch(url, { method: 'GET' });
  const sharedOutcome = assert.rejects(sharedWaiter, { code: 'upstream_timeout' });
  controller.abort(Object.assign(new Error('cancelled fixture'), { code: 'fixture_abort' }));
  await assert.rejects(pending, { code: 'fixture_abort' });
  await sharedOutcome;
  const recovered = await coordinator.fetch(url, { method: 'GET' });
  assert.equal(recovered.status, 200); assert.equal(await recovered.text(), '[]'); assert.equal(calls, 2);
});

test('cache publication enforces a shared physical entry bound', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, maxCacheEntries: 2, minIntervalMs: 0, fetchImpl: async () => { calls++; return json([]); } });
  for (const name of ['one', 'two', 'three']) await coordinator.fetch(`https://danbooru.donmai.us/tags.json?search%5Bname%5D=${name}`, { method: 'GET' });
  const count = (await readdir(join(cacheRoot, 'responses'))).filter(name => name.endsWith('.json')).length
    + (await readdir(join(cacheRoot, 'failures'))).filter(name => name.endsWith('.json')).length;
  assert.equal(calls, 3); assert.equal(count, 2);
});

test('endpoint query whitelist rejects credentials and unbounded searches before dispatch', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, fetchImpl: async () => { calls++; return json([]); } });
  for (const url of [
    'https://danbooru.donmai.us/tags.json?search%5Bname%5D=shirt&login=user&api_key=secret',
    'https://danbooru.donmai.us/tags.json?search%5Bname_matches%5D=*',
    'https://danbooru.donmai.us/wiki_pages.json?search%5Btitle%5D=shirt&limit=999',
    'https://danbooru.donmai.us/related_tag.json?search%5Bquery%5D=shirt%20rating%3Ag&search%5Bcategory%5D=general',
  ]) await assert.rejects(coordinator.fetch(url, { method: 'GET' }), { code: 'invalid_arguments' });
  assert.equal(calls, 0);
});

test('coordinator strips caller representation state and reconstructs bodyless responses safely', async t => {
  const cacheRoot = await root(t); let observed;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, fetchImpl: async (_url, init) => {
    observed = init;
    return new Response(null, { status: 204, headers: { 'content-encoding': 'gzip', 'content-length': '99', 'set-cookie': 'session=secret', 'x-private': 'secret' } });
  } });
  const response = await coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=empty', {
    method: 'GET', credentials: 'include', headers: { Authorization: 'secret', Cookie: 'secret', Range: 'bytes=0-10', Accept: 'text/html', 'User-Agent': 'untrusted variant' },
  });
  const headers = new Headers(observed.headers);
  assert.equal(observed.credentials, 'omit'); assert.equal(observed.redirect, 'error');
  assert.equal(headers.has('authorization'), false); assert.equal(headers.has('cookie'), false); assert.equal(headers.has('range'), false);
  assert.equal(headers.get('accept'), 'application/json'); assert.equal(headers.get('user-agent'), 'MCP-for-NovelAI/0.1.0 (public tag evidence)');
  assert.equal(response.status, 204); assert.equal(await response.text(), ''); assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('x-private'), null);
});

test('timestamps require an actual response and coordinator timeout codes remain specific', async t => {
  const controller = new AbortController(); controller.abort(new Error('private abort'));
  let calls = 0;
  const cancelled = await lookupTagDetails('shirt', { signal: controller.signal, fetchImpl: async () => { calls++; return json([]); } });
  assert.equal(calls, 0); assert.equal(cancelled.checkedAt, null); assert.ok(cancelled.errors.every(error => error.code === 'aborted'));
  let respondedAt;
  const found = await lookupTagDetails('shirt', { fetchImpl: async address => {
    const path = new URL(address).pathname; respondedAt ??= Date.now();
    return path === '/tags.json' ? json([tag('shirt')]) : path === '/wiki_pages.json' ? json([wiki('shirt')]) : json([]);
  } });
  assert.ok(Date.parse(found.checkedAt) >= respondedAt); assert.equal(found.resolution, 'canonical');
  const coordination = await lookupTagDetails('shirt', { queryCoordinator: async () => { throw Object.assign(new Error('private'), { code: 'coordination_timeout' }); } });
  assert.equal(coordination.checkedAt, null); assert.ok(coordination.errors.every(error => error.code === 'coordination_timeout'));
  const upstream = await lookupTagCooccurrence('shirt', { queryCoordinator: async () => { throw Object.assign(new Error('private'), { code: 'upstream_timeout' }); } });
  assert.equal(upstream.checkedAt, null); assert.equal(upstream.error.code, 'upstream_timeout');
});

test('cancellation after response headers but before body completion leaves lookup time unknown', async () => {
  let startedResolve, calls = 0;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const stalled = async () => {
    if (++calls >= 2) startedResolve();
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
  };
  const detailsController = new AbortController();
  const detailsPending = lookupTagDetails('shirt', { fetchImpl: stalled, signal: detailsController.signal, timeoutMs: 1000 });
  await started; detailsController.abort();
  const details = await detailsPending;
  assert.equal(details.checkedAt, null); assert.ok(details.errors.every(error => error.code === 'aborted'));

  let cooccurrenceStarted;
  const responseStarted = new Promise(resolve => { cooccurrenceStarted = resolve; });
  const cooccurrenceController = new AbortController();
  const cooccurrencePending = lookupTagCooccurrence('shirt', { signal: cooccurrenceController.signal, timeoutMs: 1000, fetchImpl: async () => {
    cooccurrenceStarted();
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'content-type': 'application/json' } });
  } });
  await responseStarted; await new Promise(done => setImmediate(done)); cooccurrenceController.abort();
  const cooccurrence = await cooccurrencePending;
  assert.equal(cooccurrence.checkedAt, null); assert.equal(cooccurrence.error.code, 'aborted');
});

test('an implausibly old reused PID lease recovers only beyond the full operation window', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, maxWaitMs: 100, requestTimeoutMs: 100,
    lockHardLimitMs: 10200, pollMs: 2, fetchImpl: async () => { calls++; return json([]); } });
  await coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=initialize', { method: 'GET' });
  const target = 'https://danbooru.donmai.us/tags.json?search%5Bname%5D=reused_pid';
  const key = createHash('sha256').update(target).digest('hex'), db = new DatabaseSync(join(cacheRoot, 'coordination.sqlite'));
  db.prepare('INSERT INTO query_locks(name, token, pid, acquired_at, hard_until) VALUES(?, ?, ?, ?, ?)')
    .run(`request:${key}`, 'stale-reused-pid', process.pid, Date.now() - 20_000, Date.now() - 1);
  db.close();
  const response = await coordinator.fetch(target, { method: 'GET' });
  assert.equal(response.status, 200); assert.equal(calls, 2);
});

test('close releases the coordination database once its requests settle, and a later fetch opens it again', async t => {
  const cacheRoot = await root(t); let calls = 0;
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, fetchImpl: async () => { calls++; return json([]); } });
  const pending = coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=before_close', { method: 'GET' });
  await coordinator.close();
  assert.equal((await pending).status, 200, 'a request in flight finishes before the database closes');
  // Closed: the database files can be removed, also on Windows, where an open database file cannot be deleted.
  for (const name of await readdir(cacheRoot)) if (name.startsWith('coordination.sqlite')) await rm(join(cacheRoot, name));
  assert.equal((await coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=after_close', { method: 'GET' })).status, 200);
  assert.ok((await readdir(cacheRoot)).includes('coordination.sqlite'), 'the next fetch created the database again');
  assert.equal(calls, 2);
  await coordinator.close(); await coordinator.close();
});

test('overflow reconstruction removes stale compression headers', async t => {
  const cacheRoot = await root(t);
  const coordinator = createTagQueryCoordinator({ root: cacheRoot, minIntervalMs: 0, maxCaptureBytes: 1024,
    fetchImpl: async () => new Response('x'.repeat(1025), { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }) });
  const response = await coordinator.fetch('https://danbooru.donmai.us/tags.json?search%5Bname%5D=large', { method: 'GET' });
  assert.equal(response.headers.get('content-encoding'), null); assert.equal(response.headers.get('content-length'), '1025');
});
