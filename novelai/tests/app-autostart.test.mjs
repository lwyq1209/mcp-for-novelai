// The automatic start of the app (src/app-autostart.mjs) with a fake bridge client, fake clocks and a fake launcher:
// nothing here starts a real app. What decides a start, how long it waits, what is sent again and what never is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError, undeliveredError } from '../src/bridge-client.mjs';
import { AUTOSTART_LIMITS, AUTOSTART_STATES, CLAIM_FILE, STILL_LOADING, appInstanceState, autostartPolicy, createAutostartBridge, createStartClaim } from '../src/app-autostart.mjs';

const noBridge = () => undeliveredError('no_bridge', 'unavailable', 'no app');
const refused = fingerprint => undeliveredError('refused', 'unavailable', 'gone', undefined, fingerprint);
const APP = { ok: true, kind: 'packaged', platform: 'darwin', executable: '/A.app/Contents/MacOS/A', args: [], macApp: '/A.app' };

/** A world with a fake clock: `bridge` is the bridge.json fingerprint (null: none), `running` the app's lock. */
function world({ policy = { launch: true, reason: null }, app = APP, launchResult = { ok: true, via: 'open' }, onLaunch, fresh = false, claimWins = true, limits } = {}) {
  const state = { now: 0, bridge: null, running: false, launches: [], sleeps: 0, fresh, claimWins };
  const launcher = { resolve: () => app, launch: async (resolved, options) => { state.launches.push({ resolved, options }); await onLaunch?.(state); return launchResult; } };
  const options = {
    dataPaths: { root: '/data', runtime: '/data/runtime' }, launcher, policy, limits,
    monotonicNow: () => state.now,
    sleep: async ms => { state.sleeps++; state.now += ms; state.tick?.(state); },
    instanceState: async () => state.running ? 'running' : 'absent',
    bridgeFingerprint: async () => state.bridge,
    // As the real claim file: losing the claim means another server's claim is fresh.
    claims: { fresh: async () => state.fresh, claim: async () => { if (!state.claimWins) state.fresh = true; return state.claimWins; } },
    log: () => {},
  };
  return { state, options };
}
/** A bridge client that fails `failures` times as given, then answers from `answer`. */
function client(failures, answer = (method) => ({ ok: method })) {
  const sent = [];
  return { sent, call: async (method, args, signal, caller) => { sent.push({ method, args, caller }); const next = failures.shift(); if (next) throw typeof next === 'function' ? next() : next; return answer(method, args); } };
}
const caller = { tool: 'list_queue', client: { name: 'claude-code', version: '2.1.0' }, callId: 'c-1' };

test('autostartPolicy: NOVELAI_MCP_AUTOSTART=0 turns starting off; test processes never start unless a launcher is injected', () => {
  for (const value of ['0', 'false', 'OFF', ' no ']) assert.deepEqual(autostartPolicy({ env: { NOVELAI_MCP_AUTOSTART: value }, proc: { argv: [], execArgv: [] } }), { launch: false, reason: 'off' });
  for (const value of [undefined, '1', 'true', '']) assert.deepEqual(autostartPolicy({ env: value === undefined ? {} : { NOVELAI_MCP_AUTOSTART: value }, proc: { argv: ['x', 'server.mjs'], execArgv: [] } }), { launch: true, reason: null });
  assert.deepEqual(autostartPolicy({ env: { NODE_TEST_CONTEXT: 'child' }, proc: { argv: [], execArgv: [] } }), { launch: false, reason: 'off_in_tests' });
  assert.deepEqual(autostartPolicy({ env: { VITEST: 'true' }, proc: { argv: [], execArgv: [] } }), { launch: false, reason: 'off_in_tests' });
  assert.deepEqual(autostartPolicy({ env: { NOVELAI_TEST_RUN_DATA_DIR: '/tmp/run/data' }, proc: { argv: [], execArgv: [] } }), { launch: false, reason: 'off_in_tests' });
  assert.deepEqual(autostartPolicy({ env: {}, proc: { argv: ['node', 'x.test.mjs'], execArgv: [] } }), { launch: false, reason: 'off_in_tests' });
  assert.deepEqual(autostartPolicy({ env: { NODE_TEST_CONTEXT: 'child' }, proc: { argv: [], execArgv: [] }, launcherInjected: true }), { launch: true, reason: null });
  assert.deepEqual(autostartPolicy({ env: { NODE_TEST_CONTEXT: 'child', NOVELAI_MCP_AUTOSTART: '0' }, launcherInjected: true }), { launch: false, reason: 'off' });
  // This very process is a test process: the default policy never starts anything here.
  assert.deepEqual(autostartPolicy(), { launch: false, reason: 'off_in_tests' });
});

test('a call that reached no app starts it once, waits for its bridge and is sent once more with the same caller', async () => {
  const { state, options } = world({ onLaunch: s => { s.tick = x => { if (x.now >= 1500) x.bridge = 'new'; }; } });
  const bridge = client([noBridge()]);
  const autostart = createAutostartBridge(bridge, options);
  assert.deepEqual(await autostart.call('list_queue', {}, undefined, caller), { ok: 'list_queue' });
  assert.equal(state.launches.length, 1);
  assert.deepEqual(state.launches[0].options, { client: caller.client });
  assert.equal(bridge.sent.length, 2);
  assert.deepEqual(bridge.sent[1], bridge.sent[0], 'the same call, with the same caller (one row in recent connections)');
  assert.equal(autostart.stats.starts, 1);
});

test('a refused connection (an app that is gone) also starts it; the stale bridge.json is not mistaken for the new one', async () => {
  const { state, options } = world({ onLaunch: s => { s.tick = x => { if (x.now >= 4000) x.bridge = 'fresh'; }; } });
  state.bridge = 'stale';
  const bridge = client([refused('stale')]);
  assert.deepEqual(await createAutostartBridge(bridge, options).call('enqueue_queue_recipes', { requestKey: 'k' }), { ok: 'enqueue_queue_recipes' });
  assert.equal(state.launches.length, 1); assert.equal(bridge.sent.length, 2); assert.ok(state.now >= 4000, 'it waited for the new bridge');
});

test('PAYMENT SAFETY: a failure that may have reached the host never starts the app and is never sent again', async () => {
  const maybe = [
    new BridgeError('timeout', 'outcome unknown'),
    new BridgeError('unavailable', 'disconnected after sending'),
    new BridgeError('invalid_response', 'garbled'),
    new BridgeError('queue_storage_error', 'host refusal'),
    new BridgeError('workspace_not_ready', 'canvas loading'),
    new BridgeError('conflict', 'revision'),
    new BridgeError('host_method_not_allowed', 'x'),
    new Error('not a bridge error'),
  ];
  for (const error of maybe) {
    const { state, options } = world();
    const bridge = client([error]);
    await assert.rejects(createAutostartBridge(bridge, options).call('enqueue_queue_recipes', { requestKey: 'k' }, undefined, caller), thrown => thrown === error);
    assert.equal(state.launches.length, 0, error.message); assert.equal(bridge.sent.length, 1, error.message); assert.equal(state.sleeps, 0, error.message);
  }
});

test('the call is sent once more only: a second failure after the start is returned as it is', async () => {
  for (const second of [new BridgeError('timeout', 'unknown'), new BridgeError('unavailable', 'dropped after sending'), new BridgeError('queue_full', 'refused')]) {
    const { state, options } = world({ onLaunch: s => { s.bridge = 'new'; } });
    const bridge = client([noBridge(), second]);
    await assert.rejects(createAutostartBridge(bridge, options).call('enqueue_queue_recipes', {}), thrown => thrown === second);
    assert.equal(bridge.sent.length, 2); assert.equal(state.launches.length, 1);
  }
  // The new bridge vanished before the second send reached it: unavailable (lost), never a third send or a second start.
  const { state, options } = world({ onLaunch: s => { s.bridge = 'new'; } });
  const bridge = client([noBridge(), noBridge()]);
  await assert.rejects(createAutostartBridge(bridge, options).call('list_queue', {}), error => error.code === 'unavailable' && error.details.autostart === 'lost');
  assert.equal(bridge.sent.length, 2); assert.equal(state.launches.length, 1);
});

test('an app that is already starting (its lock names a live process) is waited for, never started a second time', async () => {
  const { state, options } = world({ policy: { launch: false, reason: 'off' } });
  state.running = true; state.tick = x => { if (x.now >= 2000) x.bridge = 'up'; };
  const bridge = client([noBridge()]);
  assert.deepEqual(await createAutostartBridge(bridge, options).call('list_queue', {}), { ok: 'list_queue' });
  assert.equal(state.launches.length, 0, 'NOVELAI_MCP_AUTOSTART=0 still waits for an app that is starting');
  // Still starting after 30 s: unavailable, nothing started.
  const slow = world(); slow.state.running = true;
  await assert.rejects(createAutostartBridge(client([noBridge()]), slow.options).call('list_queue', {}), error => error.details.autostart === 'starting_not_ready' && /starting but was not ready within 30 seconds/.test(error.message));
  assert.equal(slow.state.launches.length, 0); assert.ok(slow.state.now <= AUTOSTART_LIMITS.waitMs);
});

test('another server\'s fresh claim means its start is under way: this one waits; a lost claim race waits too', async () => {
  const claimed = world({ fresh: true });
  claimed.state.tick = x => { if (x.now >= 3000) x.bridge = 'up'; };
  assert.deepEqual(await createAutostartBridge(client([noBridge()]), claimed.options).call('list_queue', {}), { ok: 'list_queue' });
  assert.equal(claimed.state.launches.length, 0);
  const race = world({ claimWins: false });
  race.state.tick = x => { if (x.now >= 1000) x.bridge = 'up'; };
  assert.deepEqual(await createAutostartBridge(client([noBridge()]), race.options).call('list_queue', {}), { ok: 'list_queue' });
  assert.equal(race.state.launches.length, 0);
});

test('the app that was starting went away: the call goes on to start it (when allowed)', async () => {
  const { state, options } = world({ onLaunch: s => { s.tick = x => { if (x.now >= 2500) x.bridge = 'up'; }; } });
  state.running = true; state.tick = x => { if (x.now >= 500) x.running = false; };
  assert.deepEqual(await createAutostartBridge(client([noBridge()]), options).call('list_queue', {}), { ok: 'list_queue' });
  assert.equal(state.launches.length, 1);
});

test('no second start within a minute of the last one; after a minute it may start again', async () => {
  const { state, options } = world({ onLaunch: s => { s.bridge = `up-${s.launches.length}`; } });
  const answers = [noBridge()];
  const bridge = client(answers);
  const autostart = createAutostartBridge(bridge, options);
  await autostart.call('list_queue', {});
  // The app quit again; 10 s later the next call finds no app.
  state.bridge = null; state.now += 10_000; answers.push(noBridge());
  await assert.rejects(autostart.call('list_queue', {}), error => error.details.autostart === 'recently_started' && /less than a minute ago/.test(error.message));
  assert.equal(state.launches.length, 1);
  state.now += AUTOSTART_LIMITS.cooldownMs; answers.push(noBridge());
  assert.deepEqual(await autostart.call('list_queue', {}), { ok: 'list_queue' });
  assert.equal(state.launches.length, 2);
});

test('concurrent calls of one server share one start and one wait', async () => {
  const { state, options } = world({ onLaunch: s => { s.tick = x => { if (x.now >= 1000) x.bridge = 'up'; }; } });
  let first = 5;
  const bridge = { sent: 0, call: async () => { bridge.sent++; if (first-- > 0) throw noBridge(); return 'ok'; } };
  const autostart = createAutostartBridge(bridge, options);
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => autostart.call('list_queue', {}))), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(state.launches.length, 1); assert.equal(bridge.sent, 10);
});

test('what an unavailable says when the app is not started: off, off in tests, unsupported, failed, not ready, closed again', async () => {
  const cases = [
    [{ policy: { launch: false, reason: 'off' } }, 'off', /automatic start is turned off \(NOVELAI_MCP_AUTOSTART=0\)/],
    [{ policy: { launch: false, reason: 'off_in_tests' } }, 'off_in_tests', /off in test runs/],
    [{ app: { ok: false, reason: 'not_electron' } }, 'unsupported', /only when the MCP server runs with the app's own executable/],
    [{ launchResult: { ok: false, reason: 'open exited 1' } }, 'start_failed', /starting it failed \(open exited 1\)/],
    [{}, 'started_not_ready', /started it in the background, but it was not ready within 30 seconds/],
    [{ onLaunch: s => { s.tick = x => { x.running = x.now < 1000; }; s.running = true; } }, 'started_exited', /closed again before it was ready/],
  ];
  for (const [setup, state, message] of cases) {
    const w = world(setup);
    await assert.rejects(createAutostartBridge(client([noBridge()]), w.options).call('list_queue', {}), error => {
      assert.equal(error.code, 'unavailable', state); assert.deepEqual(error.details, { autostart: state }); assert.match(error.message, message);
      assert.match(error.message, /Nothing was sent\./); return true;
    });
    assert.ok(w.state.now <= AUTOSTART_LIMITS.waitMs, `${state} waited at most 30 s`);
    assert.equal(w.state.launches.length, ['off', 'off_in_tests', 'unsupported'].includes(state) ? 0 : 1, state);
  }
  assert.ok(AUTOSTART_STATES.includes('lost') && AUTOSTART_STATES.length === 9);
});

test('after a start by this call, workspace_not_ready is sent again every 500 ms within the same 30 s; nothing else is', async () => {
  const notReady = () => new BridgeError('workspace_not_ready', '客户端画布尚未就绪。', undefined);
  const started = world({ onLaunch: s => { s.bridge = 'up'; } });
  const bridge = client([noBridge(), notReady, notReady, notReady]);
  assert.deepEqual(await createAutostartBridge(bridge, started.options).call('list_workspaces', {}), { ok: 'list_workspaces' });
  assert.equal(bridge.sent.length, 5);
  // Another code after the start: returned at once.
  const other = world({ onLaunch: s => { s.bridge = 'up'; } });
  const conflict = new BridgeError('conflict', 'revision');
  const second = client([noBridge(), notReady, conflict]);
  await assert.rejects(createAutostartBridge(second, other.options).call('apply_edit', {}), thrown => thrown === conflict);
  assert.equal(second.sent.length, 3);
  // Not started by this call (the app was already starting): workspace_not_ready is returned at once.
  const waited = world(); waited.state.running = true; waited.state.tick = x => { x.bridge = 'up'; };
  const third = client([noBridge(), notReady]);
  await assert.rejects(createAutostartBridge(third, waited.options).call('read_workspace', {}), error => error.code === 'workspace_not_ready' && !error.message.includes(STILL_LOADING));
  assert.equal(third.sent.length, 2);
  // Still loading at the end of the 30 s: the host's answer, with a word on why.
  const slow = world({ onLaunch: s => { s.bridge = 'up'; } });
  const fourth = { sent: 0, call: async () => { fourth.sent++; if (fourth.sent === 1) throw noBridge(); throw notReady(); } };
  await assert.rejects(createAutostartBridge(fourth, slow.options).call('list_workspaces', {}), error => error.code === 'workspace_not_ready' && error.message.endsWith(STILL_LOADING));
  assert.ok(slow.state.now <= AUTOSTART_LIMITS.waitMs); assert.ok(fourth.sent > 10);
  // The bridge went away while the window was loading: unavailable at once.
  const gone = world({ onLaunch: s => { s.bridge = 'up'; } });
  const fifth = client([noBridge(), notReady, noBridge()]);
  await assert.rejects(createAutostartBridge(fifth, gone.options).call('list_workspaces', {}), error => error.code === 'unavailable' && error.details.autostart === 'lost');
  assert.equal(fifth.sent.length, 3);
});

test('a cancelled call stops waiting and reports the original failure; the start is not repeated', async () => {
  const { state, options } = world({ onLaunch: s => { s.tick = x => { if (x.now >= 2000) controller.abort(); }; } });
  const controller = new AbortController();
  const original = noBridge();
  await assert.rejects(createAutostartBridge(client([original]), options).call('list_queue', {}, controller.signal), thrown => thrown === original);
  assert.equal(state.launches.length, 1);
});

test('the app came up between the failure and the check: nothing is started', async () => {
  const { state, options } = world();
  const bridge = { sent: 0, call: async () => { bridge.sent++; if (bridge.sent === 1) { state.bridge = 'up'; throw noBridge(); } return 'ok'; } };
  assert.equal(await createAutostartBridge(bridge, options).call('list_queue', {}), 'ok');
  assert.equal(state.launches.length, 0);
});

test('appInstanceState reads the data root\'s single-instance lock: a live pid is running, a dead one or none is absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nai-instance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await appInstanceState(root, { platform: 'darwin' }), 'absent');
  await symlink(`host.local-${process.pid}`, join(root, 'SingletonLock'));
  assert.equal(await appInstanceState(root, { platform: 'darwin' }), 'running');
  assert.equal(await appInstanceState(root, { platform: 'linux', isAlive: () => false }), 'absent', 'left behind by a crashed app');
  assert.equal(await appInstanceState(root, { platform: 'win32' }), 'absent', 'Windows looks at lockfile');
  await writeFile(join(root, 'lockfile'), '');
  assert.equal(await appInstanceState(root, { platform: 'win32' }), 'running');
  const odd = await mkdtemp(join(tmpdir(), 'nai-instance-odd-'));
  t.after(() => rm(odd, { recursive: true, force: true }));
  await symlink('garbage', join(odd, 'SingletonLock'));
  assert.equal(await appInstanceState(odd, { platform: 'darwin' }), 'absent');
});

test('start claims: one server per data root takes it; a fresh claim of another server holds, an old one expires', async t => {
  const runtimeDir = join(await mkdtemp(join(tmpdir(), 'nai-claim-')), 'runtime');
  t.after(() => rm(join(runtimeDir, '..'), { recursive: true, force: true }));
  let now = Date.now();
  const a = createStartClaim(runtimeDir, { pid: 101, now: () => now }), b = createStartClaim(runtimeDir, { pid: 202, now: () => now });
  assert.equal(await a.fresh(), false);
  const [forA, forB] = await Promise.all([a.claim(), b.claim()]);
  assert.deepEqual([forA, forB].sort(), [false, true], 'exactly one of two servers claims the start');
  assert.deepEqual(await readdir(runtimeDir), [CLAIM_FILE]);
  const winner = forA ? a : b;
  assert.equal(await winner.fresh(), false, 'a server does not wait for its own claim');
  assert.equal(await (winner === a ? b : a).fresh(), true);
  // A minute later the claim no longer holds anyone back.
  const old = (Date.now() - AUTOSTART_LIMITS.claimMs - 5_000) / 1000;
  await utimes(join(runtimeDir, CLAIM_FILE), old, old);
  assert.equal(await a.fresh(), false); assert.equal(await b.fresh(), false);
  assert.equal(await (winner === a ? b : a).claim(), true);
  now += 1;
});

test('the stdio server\'s default bridge in a test process starts nothing and writes nothing', async t => {
  const { createNovelAiMcpServer } = await import('../src/mcp.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const project = await mkdtemp(join(tmpdir(), 'nai-autostart-project-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const server = createNovelAiMcpServer({ projectRoot: project });
  const mcp = new Client({ name: 'autostart-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await mcp.connect(clientTransport);
  t.after(async () => { await mcp.close(); await server.close(); });
  const result = await mcp.callTool({ name: 'list_queue', arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent.error, { code: 'unavailable', message: 'The NovelAI app is not running for this data folder; automatic start is off in test runs. Nothing was sent.', details: { autostart: 'off_in_tests' } });
  const claim = await readdir(join(process.env.NOVELAI_DATA_DIR, 'runtime')).then(names => names.includes(CLAIM_FILE), () => false);
  assert.equal(claim, false, 'no start was claimed');
});

test('through the MCP server: list_queue with no app starts it once and answers; with automatic start off it is unavailable and says why', async t => {
  const { createNovelAiMcpServer } = await import('../src/mcp.mjs');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const project = await mkdtemp(join(tmpdir(), 'nai-autostart-mcp-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const connect = async bridgeClient => {
    const server = createNovelAiMcpServer({ bridgeClient, projectRoot: project });
    const mcp = new Client({ name: 'claude-code', version: '2.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await mcp.connect(clientTransport);
    t.after(async () => { await mcp.close(); await server.close(); });
    return mcp;
  };
  const listed = { total: 0, byStatus: {}, batches: [], storage: null };
  const on = world({ onLaunch: s => { s.bridge = 'up'; } });
  const raw = client([noBridge()], () => listed);
  const result = await (await connect(createAutostartBridge(raw, on.options))).callTool({ name: 'list_queue', arguments: {} });
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  assert.equal(on.state.launches.length, 1);
  assert.deepEqual(on.state.launches[0].options.client, { name: 'claude-code', version: '2.1.0' }, 'the app learns which agent started it');
  assert.deepEqual(raw.sent.map(call => call.method), ['list_queue', 'list_queue']);
  assert.equal(raw.sent[0].caller.callId, raw.sent[1].caller.callId, 'one tool call, one call id');
  const off = world({ policy: { launch: false, reason: 'off' } });
  const refusedResult = await (await connect(createAutostartBridge(client([noBridge()]), off.options))).callTool({ name: 'enqueue_recipes', arguments: { requestKey: 'k', items: [{ recipeId: '00000000-0000-4000-8000-000000000000', recipeRevision: 1, inputHash: 'a'.repeat(64) }] } });
  assert.equal(refusedResult.isError, true);
  assert.equal(refusedResult.structuredContent.error.code, 'unavailable');
  assert.match(refusedResult.structuredContent.error.message, /requestKey lookup failed \(The NovelAI app is not running for this data folder, and automatic start is turned off \(NOVELAI_MCP_AUTOSTART=0\)\. Nothing was sent\./);
  assert.equal(off.state.launches.length, 0);
});
