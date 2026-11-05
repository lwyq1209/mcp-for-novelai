// The payment-safety boundary of the automatic start (src/app-autostart.mjs): which bridge failures certainly reached
// no host (no bridge.json, a refused connection) and which may have (everything else). Only the first kind may start
// the app and resend the call; these tests pin every failure the bridge client can meet, with real sockets where it
// matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, connectionFingerprint, createBridgeClient, fetchFailureDelivery, readBridgeFingerprint, refusedConnection, undeliveredError, undeliveredReason } from '../src/bridge-client.mjs';

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const fetchFailed = cause => new TypeError('fetch failed', { cause });

test('fetchFailureDelivery: only a refused connect is "not sent"; every other failure may have reached the host', () => {
  const notSent = [
    ['ECONNREFUSED on connect', fetchFailed(coded('ECONNREFUSED', { syscall: 'connect', address: '127.0.0.1', port: 1 }))],
    ['ECONNREFUSED without syscall', fetchFailed(coded('ECONNREFUSED'))],
    ['every connect attempt refused (AggregateError)', fetchFailed(Object.assign(new AggregateError([coded('ECONNREFUSED', { syscall: 'connect' }), coded('ECONNREFUSED', { syscall: 'connect' })], 'all refused'), { code: 'ECONNREFUSED' }))],
    ['a bare refused error', coded('ECONNREFUSED', { syscall: 'connect' })],
  ];
  for (const [name, error] of notSent) assert.equal(fetchFailureDelivery(error), 'not_sent', name);
  const maybeSent = [
    ['aborted (timeout or cancelled), even if the cause looks refused', fetchFailed(coded('ECONNREFUSED', { syscall: 'connect' })), { aborted: true }],
    ['ECONNRESET after connecting', fetchFailed(coded('ECONNRESET', { syscall: 'read' }))],
    ['EPIPE while writing the body', fetchFailed(coded('EPIPE', { syscall: 'write' }))],
    ['undici: other side closed', fetchFailed(coded('UND_ERR_SOCKET'))],
    ['undici: connect timeout', fetchFailed(coded('UND_ERR_CONNECT_TIMEOUT'))],
    ['undici: headers timeout', fetchFailed(coded('UND_ERR_HEADERS_TIMEOUT'))],
    ['ETIMEDOUT', fetchFailed(coded('ETIMEDOUT', { syscall: 'connect' }))],
    ['ECONNREFUSED of another syscall', fetchFailed(coded('ECONNREFUSED', { syscall: 'write' }))],
    ['refused mixed with a reset', fetchFailed(new AggregateError([coded('ECONNREFUSED', { syscall: 'connect' }), coded('ECONNRESET', { syscall: 'read' })], 'mixed'))],
    ['an unexpected redirect (no code)', fetchFailed(new Error('unexpected redirect'))],
    ['fetch failed without a cause', new TypeError('fetch failed')],
    ['AbortError', Object.assign(new Error('aborted'), { name: 'AbortError' })],
    ['a string', 'boom'],
    ['null', null],
  ];
  for (const [name, error, options] of maybeSent) assert.equal(fetchFailureDelivery(error, options), 'maybe_sent', name);
});

test('undelivered errors carry their reason off the enumerable fields; other BridgeErrors carry none', () => {
  const error = undeliveredError('refused', 'unavailable', 'gone', undefined, 'f'.repeat(64));
  assert.equal(undeliveredReason(error), 'refused'); assert.equal(refusedConnection(error), 'f'.repeat(64));
  assert.deepEqual(Object.keys(error).sort(), ['code', 'details', 'name'].sort());
  assert.equal(JSON.stringify({ ...error }).includes('refused'), false);
  assert.equal(undeliveredReason(new BridgeError('unavailable', 'x')), null);
  assert.equal(undeliveredReason(new Error('x')), null);
  assert.throws(() => undeliveredError('sent', 'unavailable', 'x'), TypeError);
});

async function runtime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'nai-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const writeBridge = (dir, port, token = 't'.repeat(64)) => writeFile(join(dir, 'bridge.json'), JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${port}`, token, pid: process.pid }));
async function closedPort() {
  const server = createTcpServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}
async function listen(t, handler, { tcp = false } = {}) {
  const server = tcp ? createTcpServer(handler) : createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); });
  return server.address().port;
}

test('real bridge client: no bridge.json and a refused connection are undelivered; nothing reaches a host', async t => {
  const dir = await runtime(t);
  const bridge = createBridgeClient({ runtimeDir: dir });
  await assert.rejects(bridge.call('list_queue', {}), error => error.code === 'unavailable' && undeliveredReason(error) === 'no_bridge' && /Nothing was sent/.test(error.message));
  const port = await closedPort();
  await writeBridge(dir, port);
  await assert.rejects(bridge.call('enqueue_queue_recipes', { requestKey: 'k' }), error => {
    assert.equal(error.code, 'unavailable'); assert.equal(undeliveredReason(error), 'refused');
    assert.equal(refusedConnection(error), connectionFingerprint({ url: `http://127.0.0.1:${port}`, token: 't'.repeat(64) }));
    return true;
  });
  assert.equal(await readBridgeFingerprint(dir), connectionFingerprint({ url: `http://127.0.0.1:${port}`, token: 't'.repeat(64) }));
});

test('real bridge client: every failure after the request may have reached the host carries no undelivered reason', async t => {
  const cases = [];
  // The host reads the request, then drops the connection without answering.
  cases.push(['dropped after the request', await listen(t, socket => { socket.once('data', () => socket.destroy()); }, { tcp: true }), 'unavailable']);
  // The host answers something that is not JSON.
  cases.push(['garbled reply', await listen(t, (request, response) => { request.resume(); response.end('not json'); }), 'invalid_response']);
  // The host answers with a refusal of its own.
  cases.push(['host refusal', await listen(t, (request, response) => { request.resume(); response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ok: false, error: { code: 'workspace_not_ready', message: 'not ready' } })); }), 'workspace_not_ready']);
  // The host never answers (timeout).
  cases.push(['no answer', await listen(t, request => { request.resume(); }), 'timeout']);
  // The host answers a redirect, which the client refuses to follow.
  cases.push(['redirect', await listen(t, (request, response) => { request.resume(); response.writeHead(302, { location: 'https://example.com/' }); response.end(); }), 'unavailable']);
  for (const [name, port, code] of cases) {
    const dir = await runtime(t); await writeBridge(dir, port);
    const bridge = createBridgeClient({ runtimeDir: dir, timeoutMs: 300 });
    await assert.rejects(bridge.call('enqueue_queue_recipes', { requestKey: 'k' }), error => {
      assert.equal(error.code, code, name); assert.equal(undeliveredReason(error), null, name); return true;
    });
  }
  // A cancelled call is never "not sent", even when the cancellation came first.
  const dir = await runtime(t); await writeBridge(dir, await closedPort());
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createBridgeClient({ runtimeDir: dir }).call('list_queue', {}, controller.signal), error => error.code === 'timeout' && undeliveredReason(error) === null);
});

test('real bridge client: an unreadable or invalid connection file is not "no app" and starts nothing', async t => {
  const dir = await runtime(t);
  await mkdir(join(dir, 'bridge.json'));
  await assert.rejects(createBridgeClient({ runtimeDir: dir }).call('list_queue', {}), error => error.code === 'unavailable' && undeliveredReason(error) === null);
  const other = await runtime(t);
  await writeFile(join(other, 'bridge.json'), '{"schemaVersion":1,"url":"https://example.com/","token":"x"}');
  await assert.rejects(createBridgeClient({ runtimeDir: other }).call('list_queue', {}), error => error.code === 'invalid_connection' && undeliveredReason(error) === null);
  await writeFile(join(other, 'bridge.json'), 'not json');
  await assert.rejects(createBridgeClient({ runtimeDir: other }).call('list_queue', {}), error => error.code === 'unavailable' && undeliveredReason(error) === null);
  assert.equal(await readBridgeFingerprint(other), null);
});

test('the server started before the app: the first call after its bridge appears reaches it (bridge.json is read on every call)', async t => {
  const dir = await runtime(t);
  const bridge = createBridgeClient({ runtimeDir: dir });
  await assert.rejects(bridge.call('list_queue', {}), error => undeliveredReason(error) === 'no_bridge');
  let calls = 0;
  const port = await listen(t, async (request, response) => { calls++; request.resume(); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true, result: { total: 0 } })); });
  await writeBridge(dir, port);
  assert.deepEqual(await bridge.call('list_queue', {}), { total: 0 });
  assert.equal(calls, 1);
});
