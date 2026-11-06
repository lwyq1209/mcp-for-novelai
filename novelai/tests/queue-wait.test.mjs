// read_queue wait, the place in the queue and the whole-batch thumbnails of get_queue_result (0.1.4): the queue
// never stops on a failure, so an agent waits inside one call instead of polling with sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Offline: no test here reaches any network.
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in queue wait tests.'); };
const { BridgeError, createNovelAiMcpServer, TOOL_DEFINITIONS, INSTRUCTIONS } = await import('../src/mcp.mjs');
const { ITEM_REASONS, QUEUE_RESULT_PAGE, QUEUE_WAIT, waitForQueuedBatch } = await import('../src/queue-control.mjs');

const BATCH = 'abcdef01-2345-6789-abcd-ef0123456789';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const item = (index, status, results = [], extra = {}) => ({ index, status, jobId: status === 'pending' ? null : `job-${index}`, results, error: null, ...extra });
const saved = index => [{ index: 0, id: `h${index}`, actualSeed: 100 + index, filePath: `/outside/project/img_${index}.png` }];
const batch = (status, items, extra = {}) => ({ batchId: BATCH, requestKey: 'mcp-wait', execution: 'queued', status, count: items.length, recipePlanHash: 'a'.repeat(64), intervalSeconds: 0, activeJobId: null, error: null, items, ...extra });

/** A fake clock: sleep moves it on at once, so a 300 s wait takes no real time. */
function clock() {
  let at = 1_000_000;
  const sleeps = [];
  return { now: () => at, sleep: async (ms, signal) => { if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); sleeps.push(ms); at += ms; }, sleeps, advance: ms => { at += ms; } };
}
/** A bridge that answers read_queue with the next of `replies` (the last one repeats); a function reply is called. */
function bridgeOf(replies) {
  const calls = [];
  let next = 0;
  return { calls, call: async (method, args) => { calls.push({ method, args }); const reply = replies[Math.min(next++, replies.length - 1)]; return typeof reply === 'function' ? reply() : structuredClone(reply); } };
}
const waitFor = (bridge, wait, time = clock(), signal) => waitForQueuedBatch({ batchId: BATCH, wait }, { bridge, signal, now: time.now, sleep: time.sleep });

test('wait done returns as soon as the batch ended, with the waited time; an ended batch returns at once', async () => {
  const time = clock();
  const bridge = bridgeOf([batch('running', [item(0, 'running'), item(1, 'pending')]), batch('running', [item(0, 'succeeded', saved(0)), item(1, 'running')]), batch('partial', [item(0, 'succeeded', saved(0)), item(1, 'failed', [], { error: { code: 'rate_limited', message: 'x' } })])]);
  const { value } = await waitFor(bridge, { until: 'done', seconds: 600 }, time);
  assert.equal(value.status, 'partial');
  assert.deepEqual(value.wait, { until: 'done', ended: 'done', waitedSeconds: 2 });
  assert.deepEqual(value.itemCounts, { pending: 0, running: 0, succeeded: 1, failed: 1, unknown: 0, cancelled: 0, skipped: 0 });
  assert.deepEqual(value.itemReasons, { rate_limited: ITEM_REASONS.rate_limited });
  assert.equal(bridge.calls.length, 3);
  assert.ok(bridge.calls.every(call => call.method === 'read_queue' && call.args.batchId === BATCH));
  assert.deepEqual(time.sleeps, [QUEUE_WAIT.pollMs, QUEUE_WAIT.pollMs]);
  const ended = bridgeOf([batch('succeeded', [item(0, 'succeeded', saved(0))])]);
  assert.deepEqual((await waitFor(ended, { until: 'done', seconds: 5 })).value.wait, { until: 'done', ended: 'done', waitedSeconds: 0 });
  assert.equal(ended.calls.length, 1);
});

test('wait next returns on the first result of this batch saved after the call started, not on one already there', async () => {
  const time = clock();
  const bridge = bridgeOf([
    batch('running', [item(0, 'succeeded', saved(0)), item(1, 'running'), item(2, 'pending')]),
    batch('running', [item(0, 'succeeded', saved(0)), item(1, 'running'), item(2, 'pending')]),
    batch('running', [item(0, 'succeeded', saved(0)), item(1, 'succeeded', saved(1)), item(2, 'running')]),
  ]);
  const { value } = await waitFor(bridge, { until: 'next', seconds: 60 }, time);
  assert.equal(value.wait.ended, 'next'); assert.equal(value.wait.waitedSeconds, 2);
  assert.deepEqual(value.results.map(result => result.historyId), ['h0', 'h1']);
  // A batch that ends without a new result ends the wait as done.
  const failing = bridgeOf([batch('running', [item(0, 'running')]), batch('partial', [item(0, 'unknown', [], { error: { code: 'submission_unconfirmed', message: 'x' } })])]);
  assert.equal((await waitFor(failing, { until: 'next', seconds: 60 })).value.wait.ended, 'done');
});

test('wait returns at once for a paused, cancelling or cancelled batch, and after `seconds` with the current state', async () => {
  for (const [status, ended] of [['paused', 'paused'], ['cancelling', 'cancelled'], ['cancelled', 'cancelled']]) {
    const bridge = bridgeOf([batch('running', [item(0, 'running')]), batch(status, [item(0, status === 'paused' ? 'pending' : 'running')])]);
    assert.equal((await waitFor(bridge, { until: 'next', seconds: 30 })).value.wait.ended, ended, status);
  }
  // Pausing (the running image may still finish) keeps waiting.
  const pausing = bridgeOf([batch('pausing', [item(0, 'running')])]);
  const time = clock();
  const { value } = await waitFor(pausing, { until: 'done', seconds: 10 }, time);
  assert.deepEqual(value.wait, { until: 'done', ended: 'timeout', waitedSeconds: 10 });
  assert.equal(value.status, 'pausing');
  assert.equal(pausing.calls.length, 11);
  // A cleaned batch (queue retention) has ended.
  const cleaned = bridgeOf([{ batchId: BATCH, execution: 'queued', status: 'succeeded', cleaned: true, count: 1, intervalSeconds: 0, cleanedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), itemCounts: { succeeded: 1 } }]);
  assert.equal((await waitFor(cleaned, { until: 'next', seconds: 30 })).value.wait.ended, 'done');
});

test('wait polls every second, every two seconds while the time left is over a minute', async () => {
  const time = clock();
  const long = bridgeOf([batch('running', [item(0, 'running')], { etaSeconds: 600, ahead: { images: 4, batches: 2 }, imageSeconds: 12.5 })]);
  const { value } = await waitFor(long, { until: 'done', seconds: 6 }, time);
  assert.deepEqual(time.sleeps, [2000, 2000, 2000]);
  assert.deepEqual([value.ahead, value.etaSeconds, value.imageSeconds], [{ images: 4, batches: 2 }, 600, 12.5]);
});

test('a read that fails during a wait is tried again at the next poll; a definite refusal ends it at once; abort stops it', async () => {
  let reads = 0;
  const flaky = bridgeOf([() => { reads++; throw new BridgeError('unavailable', 'The NovelAI client disconnected.'); }, () => { reads++; throw new Error('socket hang up'); }, batch('succeeded', [item(0, 'succeeded', saved(0))])]);
  const { value } = await waitFor(flaky, { until: 'done', seconds: 30 });
  assert.equal(value.wait.ended, 'done'); assert.equal(reads, 2); assert.equal(value.wait.lastReadFailed, undefined);
  // Failing at the end: the last good state, with the failure named.
  const late = bridgeOf([batch('running', [item(0, 'running')]), () => { throw new BridgeError('timeout', 'The client request timed out.'); }]);
  const timedOut = (await waitFor(late, { until: 'done', seconds: 3 })).value;
  assert.deepEqual([timedOut.status, timedOut.wait.ended, timedOut.wait.lastReadFailed], ['running', 'timeout', 'timeout']);
  // Never a good read: the error itself.
  const down = bridgeOf([() => { throw new BridgeError('unavailable', 'The NovelAI app is not running.'); }]);
  await assert.rejects(waitFor(down, { until: 'done', seconds: 3 }), error => error.code === 'unavailable');
  // A definite refusal is not read through.
  const gone = bridgeOf([() => { throw new BridgeError('batch_not_found', 'This client process has no such batch.'); }]);
  await assert.rejects(waitFor(gone, { until: 'done', seconds: 30 }), error => error.code === 'batch_not_found');
  assert.equal(gone.calls.length, 1);
  // The request's abort signal ends the wait.
  const controller = new AbortController(), running = bridgeOf([batch('running', [item(0, 'running')])]);
  const time = clock(), sleep = time.sleep;
  time.sleep = async (ms, signal) => { controller.abort(); return sleep(ms, signal); };
  await assert.rejects(waitForQueuedBatch({ batchId: BATCH, wait: { until: 'done', seconds: 30 } }, { bridge: running, signal: controller.signal, now: time.now, sleep: time.sleep }), error => error.name === 'AbortError');
  assert.equal(running.calls.length, 1);
});

async function connect(t, handler) {
  const calls = [];
  const bridgeClient = { async call(method, args) { calls.push({ method, args: structuredClone(args) }); return handler(method, args); } };
  const server = createNovelAiMcpServer({ bridgeClient });
  const client = new Client({ name: 'queue-wait-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: (name, args) => client.callTool({ name, arguments: args }) };
}

test('read_queue wait through the server: a real one-second poll returns when the batch ends; the tool says how to wait', async t => {
  let reads = 0;
  const { call, calls } = await connect(t, () => ++reads < 2 ? batch('running', [item(0, 'running')], { ahead: { images: 3, batches: 1 }, etaSeconds: 20, imageSeconds: 6.5 }) : batch('succeeded', [item(0, 'succeeded', saved(0))], { ahead: { images: 0, batches: 0 }, etaSeconds: 0, imageSeconds: 6.5 }));
  const started = Date.now();
  const result = await call('read_queue', { batchId: BATCH, wait: { until: 'done', seconds: 30 } });
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.ok(Date.now() - started >= 900 && Date.now() - started < 5000);
  assert.deepEqual(result.structuredContent.wait.ended, 'done');
  assert.deepEqual([result.structuredContent.ahead, result.structuredContent.etaSeconds], [{ images: 0, batches: 0 }, 0]);
  assert.deepEqual(calls.map(entry => entry.method), ['read_queue', 'read_queue']);
  assert.ok(calls.every(entry => !Object.hasOwn(entry.args, 'wait')), 'the host never sees the wait');
  const plain = await call('read_queue', { batchId: BATCH });
  assert.equal(plain.structuredContent.wait, undefined);
  const tool = TOOL_DEFINITIONS.find(entry => entry.name === 'read_queue');
  assert.deepEqual(tool.inputSchema.properties.wait.properties.until.enum, ['done', 'next']);
  assert.equal(tool.inputSchema.properties.wait.properties.seconds.maximum, 1200);
  for (const text of ['wait {until:"done"|"next", seconds}', 'partial', 'etaSeconds', 'never stops the queue']) assert.ok(tool.description.includes(text), text);
  assert.match(INSTRUCTIONS, /read_queue with wait/);
});

test('get_queue_result without itemIndex: the whole batch as thumbnails in item order, paged, a failed preview listed without an image', async t => {
  const items = Array.from({ length: 23 }, (_, index) => item(index, index === 3 ? 'failed' : 'succeeded', index === 3 ? [] : saved(index)));
  const { call, calls } = await connect(t, (method, args) => {
    if (method === 'read_queue') return batch('partial', items);
    if (method === 'get_queue_result') {
      assert.equal(args.variant, 'thumbnail');
      if (args.itemIndex === 5) throw new BridgeError('result_unavailable', 'The original cannot be read right now.');
      return { jobId: `job-${args.itemIndex}`, index: args.index, historyId: `h${args.itemIndex}`, variant: 'thumbnail', mimeType: 'image/webp', data: png, width: 384, height: 256, sourceWidth: 1216, sourceHeight: 832, actualSeed: 100 + args.itemIndex, filePath: `/outside/project/img_${args.itemIndex}.png` };
    }
    throw new Error(`unexpected ${method}`);
  });
  const first = await call('get_queue_result', { batchId: BATCH });
  assert.ok(!first.isError, JSON.stringify(first.structuredContent));
  const value = first.structuredContent;
  assert.deepEqual([value.status, value.total, value.offset, value.returned, value.nextOffset, value.thumbnails], ['partial', 22, 0, QUEUE_RESULT_PAGE, QUEUE_RESULT_PAGE, { maxEdge: 384 }]);
  assert.deepEqual(value.results.map(entry => entry.itemIndex), [0, 1, 2, ...Array.from({ length: 17 }, (_, index) => index + 4)]);
  assert.deepEqual(value.results[0], { itemIndex: 0, index: 0, historyId: 'h0', actualSeed: 100, fileName: 'img_0.png', file: null, width: 384, height: 256, imageAttached: true });
  assert.deepEqual(value.results.find(entry => entry.itemIndex === 5), { itemIndex: 5, index: 0, historyId: 'h5', actualSeed: 105, fileName: 'img_5.png', file: null, imageAttached: false, error: 'result_unavailable' });
  assert.equal(first.content.filter(entry => entry.type === 'image').length, QUEUE_RESULT_PAGE - 1);
  assert.ok(first.content.filter(entry => entry.type === 'image').every(entry => entry.mimeType === 'image/webp'));
  assert.deepEqual(calls.slice(0, 2).map(entry => [entry.method, entry.args]), [['read_queue', { batchId: BATCH }], ['get_queue_result', { batchId: BATCH, itemIndex: 0, index: 0, variant: 'thumbnail' }]]);
  const rest = (await call('get_queue_result', { batchId: BATCH, offset: QUEUE_RESULT_PAGE })).structuredContent;
  assert.deepEqual([rest.returned, rest.nextOffset, rest.results.map(entry => entry.itemIndex)], [2, null, [21, 22]]);
  // One image by itemIndex is unchanged (no variant, full size).
  await call('get_queue_result', { batchId: BATCH, itemIndex: 1 });
  assert.deepEqual(calls.at(-1), { method: 'get_queue_result', args: { batchId: BATCH, itemIndex: 1, index: 0 } });
});

test('get_queue_result whole batch refuses a client that does not know thumbnails, and a full-size reply is never passed on', async t => {
  const old = await connect(t, method => {
    if (method === 'read_queue') return batch('succeeded', [item(0, 'succeeded', saved(0))]);
    throw new BridgeError('invalid_argument', 'Unknown queue field.');
  });
  const refused = await old.call('get_queue_result', { batchId: BATCH });
  assert.equal(refused.isError, true); assert.equal(refused.structuredContent.error.code, 'host_outdated');
  const big = await connect(t, method => method === 'read_queue' ? batch('succeeded', [item(0, 'succeeded', saved(0))]) : { jobId: 'job-0', index: 0, historyId: 'h0', variant: 'thumbnail', mimeType: 'image/png', data: png, width: 1216, height: 832 });
  const result = await big.call('get_queue_result', { batchId: BATCH });
  assert.deepEqual(result.structuredContent.results.map(entry => [entry.imageAttached, entry.error]), [[false, 'invalid_response']]);
  assert.equal(result.content.filter(entry => entry.type === 'image').length, 0);
});
