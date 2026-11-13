// Step 4a, user decision 3: every host call of a tool call names its caller (tool, the MCP client's initialize
// clientInfo name/version, one id per tool call) and never repeats the arguments there; queued batches report who
// put them in (source).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovelAiMcpServer, createBridgeClient } from '../src/mcp.mjs';
import { callerClient } from '../src/business-guards.mjs';
import { batchSource, compactQueuedBatch } from '../src/queue-control.mjs';

const BATCH = '11111111-2222-4333-8444-555555555555';

async function connect(t, clientInfo, handler) {
  const calls = [];
  const bridgeClient = { async call(method, args, signal, caller) { calls.push({ method, args: structuredClone(args), caller: structuredClone(caller), signal: signal instanceof AbortSignal }); return handler(method, args); } };
  const server = createNovelAiMcpServer({ wholeResults: true, bridgeClient });
  const client = new Client(clientInfo);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: (name, args) => client.callTool({ name, arguments: args }) };
}

test('each host call names the tool, the initialize client and one call id; arguments are never in it', async t => {
  const { calls, call } = await connect(t, { name: 'claude-code', version: '2.1.112' }, method => method === 'list_queue' ? { batches: [] } : { workspaces: [] });
  await call('list_queue', {});
  await call('asset_library', { action: 'collections' });
  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.deepEqual(Object.keys(first.caller).sort(), ['callId', 'client', 'tool']);
  assert.deepEqual(first.caller.client, { name: 'claude-code', version: '2.1.112' });
  assert.equal(first.caller.tool, 'list_queue');
  assert.equal(second.caller.tool, 'asset_library');
  assert.match(first.caller.callId, /^[a-f0-9-]{36}$/);
  assert.notEqual(first.caller.callId, second.caller.callId, 'one id per tool call');
  assert.ok(first.signal && second.signal);
});

test('a client without a usable name is sent as client null', async t => {
  for (const info of [{ name: '', version: '1' }, { name: 'bad\nname', version: '1' }, { name: 'x'.repeat(101), version: '1' }]) {
    const { calls, call } = await connect(t, info, () => ({ batches: [] }));
    await call('list_queue', {});
    assert.equal(calls[0].caller.client, null, JSON.stringify(info));
  }
  assert.deepEqual(callerClient({ name: ' pi ', version: 'v'.repeat(51) }), { name: 'pi', version: null }, 'an unusable version alone reads null');
  assert.equal(callerClient(undefined), null);
  // Bidirectional controls and zero-width characters are removed: the name is shown as plain text.
  assert.deepEqual(callerClient({ name: '\u202eedoc-edualc\u202c', version: '1\u200b.0' }), { name: 'edoc-edualc', version: '1.0' });
  assert.deepEqual(callerClient({ name: 'claude\u200d-code\ufeff', version: '\u2066\u2069' }), { name: 'claude-code', version: null });
  assert.equal(callerClient({ name: '\u200b\u200e\u2067' }), null, 'a name of invisible characters only is no name');
  assert.equal(callerClient({ name: 'bad\u0085name' }), null, 'a C1 control is refused like a C0 one');
});

test('the bridge request body carries the caller beside method and args; without one it is unchanged', async t => {
  const runtime = await mkdtemp(join(tmpdir(), 'nai-agent-identity-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await writeFile(join(runtime, 'bridge.json'), JSON.stringify({ schemaVersion: 1, url: 'http://127.0.0.1:1', token: 't'.repeat(64) }));
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: {} }), { headers: { 'content-type': 'application/json' } }); };
  const bridge = createBridgeClient({ runtimeDir: runtime, fetchImpl });
  const caller = { tool: 'list_queue', client: { name: 'pi', version: '1.5.0' }, callId: 'c-1' };
  await bridge.call('list_queue', {}, undefined, caller);
  await bridge.call('list_queue', {}, undefined);
  assert.deepEqual(bodies, [{ method: 'list_queue', args: {}, caller }, { method: 'list_queue', args: {} }]);
});

test('queue outputs name the batch source: agent client, unknown agent for older batches, manual for this run only', () => {
  assert.deepEqual(batchSource(undefined), { kind: 'agent', client: null });
  assert.deepEqual(batchSource({ kind: 'agent', client: { name: 'codex-mcp-client', version: '0.50.0', extra: 1 } }), { kind: 'agent', client: { name: 'codex-mcp-client', version: '0.50.0' } });
  assert.deepEqual(batchSource({ kind: 'manual', persistent: false }), { kind: 'manual', persistent: false });
  assert.deepEqual(batchSource({ kind: 'agent', client: { name: 'bad\u0000' } }), { kind: 'agent', client: null });
  assert.deepEqual(batchSource({ kind: 'agent', client: { name: '\u202ecodex\u200b', version: '\u2066' } }), { kind: 'agent', client: { name: 'codex', version: null } });
  const compact = compactQueuedBatch({ batchId: BATCH, requestKey: 'manual-x', execution: 'queued', status: 'running', count: 1, intervalSeconds: 0, items: [], source: { kind: 'manual', persistent: false } });
  assert.deepEqual(compact.source, { kind: 'manual', persistent: false });
});

test('list_queue and read_queue show each batch source', async t => {
  const agentBatch = { batchId: BATCH, requestKey: 'mcp-a', execution: 'queued', status: 'queued', count: 1, intervalSeconds: 0, activeJobId: null, items: [], source: { kind: 'agent', client: { name: 'claude-code', version: '2' } } };
  const manualBatch = { ...agentBatch, batchId: '22222222-2222-4333-8444-555555555555', requestKey: 'manual-b', source: { kind: 'manual', persistent: false } };
  const { call } = await connect(t, { name: 'claude-code', version: '2' }, method => method === 'list_queue' ? { batches: [manualBatch, agentBatch] } : agentBatch);
  const listed = (await call('list_queue', {})).structuredContent;
  assert.deepEqual(listed.batches.map(batch => batch.source), [{ kind: 'manual', persistent: false }, { kind: 'agent', client: { name: 'claude-code', version: '2' } }]);
  const read = (await call('read_queue', { batchId: BATCH })).structuredContent;
  assert.deepEqual(read.source, { kind: 'agent', client: { name: 'claude-code', version: '2' } });
});
