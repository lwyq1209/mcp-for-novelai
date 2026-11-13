/**
 * Issue #1 (2026-10-14), host edges of the enqueue output: refusals that must not use the requestKey, a prefix
 * without a group, an older client seen from the new MCP server, and one rule set on both sides. Same wiring as
 * queue-output-isolation.test.ts (the frozen two-session counterexample), which is kept byte-identical.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

const fixture = vi.hoisted(() => ({
  outputDir: '',
  groups: [] as Array<{ id: string; name: string; createdAt: string }>,
  history: [] as any[],
  post: vi.fn(),
}));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const wrap = (buffer: Buffer): any => {
    let png: PNG; try { png = PNG.sync.read(buffer); } catch { return { isEmpty: () => true }; }
    return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png) };
  };
  return { app: { getPath: () => fixture.outputDir }, dialog: {}, nativeImage: { createFromBuffer: wrap } };
});
vi.mock('axios', () => ({ default: { post: fixture.post, isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./ipc/store', () => ({
  getToken: () => 'synthetic-test-token',
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false, outputDir: fixture.outputDir, generationGroupId: '', keepImageMetadata: true, imageNameTemplate: '' }),
  getHistoryGroups: () => fixture.groups,
  ensureHistoryGroup: (name: string) => {
    const existing = fixture.groups.find(group => group.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const created = { id: `group-${fixture.groups.length + 1}`, name, createdAt: new Date().toISOString() };
    fixture.groups.push(created); return created;
  },
  getAccountSummary: () => ({ hasToken: true }), addHistory: (items: any[]) => { fixture.history.push(...structuredClone(items)); return []; },
  setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./ipc/logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./ipc/proxy', () => ({ proxyConfig: () => ({}) }));

import { generateImage } from './ipc/nai';
import { cancelAllJobs, hasActiveGenerationJobs } from './ipc/job-registry';
import { createGenerationService } from './generation-service';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { FROZEN_COMPACTION_POLICY } from './batch-storage';
import { queueBridgeError } from './queue-bridge-error';
import { ensureHistoryGroup, getHistoryGroups } from './ipc/store';
import { QUEUE_FILE_PREFIX_MAX, QUEUE_HISTORY_GROUP_MAX, QueueHistoryGroupConflict, normalizeHistoryGroupName, resolveQueueHistoryGroup, sanitizeGroupFolderName, validFileNamePrefix, validHistoryGroupName } from './queue-output';
import { createNovelAiMcpServer, BridgeError } from '../../src/mcp.mjs';
import * as mcpQueue from '../../src/recipe-queue.mjs';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { waitUntil } from '../src/test-support/wait-until';

const pad = (n: number) => String(n).padStart(2, '0');
const today = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`; };
const sizeOf = (bytes: Buffer) => { const png = PNG.sync.read(bytes); return { width: png.width, height: png.height }; };
async function reply() {
  const png = new PNG({ width: 64, height: 64 }); png.data.fill(120);
  const zip = new JSZip(); zip.file('image_0.png', PNG.sync.write(png));
  return { data: await zip.generateAsync({ type: 'nodebuffer' }) };
}

let base = '';
const closers: Array<() => Promise<unknown> | unknown> = [];
beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-queue-output-host-'));
  fixture.outputDir = path.join(base, 'novelai', '.runtime', 'output');
  await fs.mkdir(fixture.outputDir, { recursive: true });
  fixture.groups = []; fixture.history = [];
  fixture.post.mockReset(); fixture.post.mockImplementation(reply);
});
afterEach(() => runCleanups([...closers.splice(0).reverse(), () => cancelAllJobs(), () => fs.rm(base, { recursive: true, force: true })]));

const mainResolver = (name: string) => resolveQueueHistoryGroup(name, getHistoryGroups(), ensureHistoryGroup); // as main.ts
async function startHost({ resolveHistoryGroup = mainResolver, olderClient = false }: { resolveHistoryGroup?: (name: string) => { id: string; name: string }; olderClient?: boolean } = {}) {
  // holdNext(): the next enqueue reaches the host only when release() runs; the caller sees a transport timeout.
  let hold = false; const held: Array<() => Promise<unknown>> = [];
  const runtimeDir = path.join(base, 'runtime'); await fs.mkdir(runtimeDir, { recursive: true });
  const generation = createGenerationService({ isBusy: hasActiveGenerationJobs, validateImage: bytes => sizeOf(bytes),
    async execute(mode, snapshot, execution) { if (mode !== 't2i') throw new Error('t2i only in this fixture'); return generateImage(snapshot.params, snapshot.extras, undefined, execution); } });
  const batch = createBatchService({ generation, isBusy: hasActiveGenerationJobs, runtimeDir });
  closers.push(() => batch.dispose());
  const resolver = vi.fn(resolveHistoryGroup);
  const queue: any = createQueueRecipeService({ runtimeDir, batch, generation, historyById: id => fixture.history.find(item => item.id === id) ?? null,
    resolveHistoryGroup: resolver, validateImage: data => sizeOf(data) });
  const json = (value: unknown) => JSON.parse(JSON.stringify(value));
  const bridgeClient = { async call(method: string, args: any) {
    if (!(QUEUE_METHODS as readonly string[]).includes(method)) throw new BridgeError('unsupported_method', 'No such host method.');
    // A client from before 2026-10-14 refuses the new field itself (its first check, before any I/O).
    if (olderClient && method === 'enqueue_queue_recipes' && Object.hasOwn(args, 'output')) throw new BridgeError('invalid_argument', 'Unknown queue field.');
    if (hold && method === 'enqueue_queue_recipes') { hold = false; const late = json(args); held.push(() => queue[method](late)); throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
    try { return json(await queue[method](json(args))); }
    catch (error) { const bridged: any = queueBridgeError(error); throw new BridgeError(bridged.code, bridged.message, bridged.details); }
  } };
  // wholeResults (a test option of the server): these tests read the whole receipts and batches; the compact ones agents get are tested in novelai/tests.
  const server = createNovelAiMcpServer({ wholeResults: true, bridgeClient, projectRoot: base });
  // lookup_enqueue left the MCP surface on 2026-11-13; what a key holds is asserted through the recipe module's lookup.
  const lookup = mcpQueue.createRecipeQueue({ bridge: bridgeClient }).lookup;
  const client = new Client({ name: 'queue-output-host-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown>) => { if (name === 'lookup_enqueue') return { ok: true, value: json(await lookup(args)) }; const result: any = await client.callTool({ name, arguments: args }); return { ok: !result.isError, value: result.structuredContent }; };
  const ok = async (name: string, args: Record<string, unknown>) => { const result = await call(name, args); expect(result.ok, `${name}: ${JSON.stringify(result.value)}`).toBe(true); return result.value; };
  return { queue, resolver, call, ok, holdNext: () => { hold = true; }, release: async () => { for (const deliver of held.splice(0)) await deliver(); } };
}
const t2i = { mode: 't2i', model: 'nai-diffusion-5-full', width: 64, height: 64, steps: 1, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 3, qualityPreset: 'none', stylePrompt: '', positivePrompt: 'a teacup', negativePrompt: '', seed: 1 };
const ref = (recipe: any) => ({ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash });
/** Until the batch ends (the test timeout bounds it). */
function settle(ok: (name: string, args: Record<string, unknown>) => Promise<any>, batchId: string) {
  return waitUntil(async () => { const read = await ok('read_queue', { batchId }); expect(['succeeded', 'blocked', 'cancelled'], read.status).toContain(read.status); return read; }, { interval: 50 });
}

describe('enqueue output at the host boundary (issue #1)', () => {
  it('applies one rule set on both sides of the bridge', () => {
    expect(QUEUE_FILE_PREFIX_MAX).toBe(mcpQueue.QUEUE_FILE_PREFIX_MAX);
    expect(QUEUE_HISTORY_GROUP_MAX).toBe(mcpQueue.QUEUE_HISTORY_GROUP_MAX);
    const samples = ['sketchbook6', 'Clockwork_Detective', '项目.v2', 'a', 'x'.repeat(40), 'x'.repeat(41), 'x'.repeat(80), 'x'.repeat(81), '', ' a', 'a ', 'a b', '.a', '-a', 'a-', 'a.b', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0000b', 'a\nb', 'a\u007fb', 'a\u3000b', '😀', '😀'.repeat(20), '😀'.repeat(21), '😀'.repeat(40), '😀'.repeat(41), 'ClockworkDetective · 美术',
      'CON', 'con', 'Con.txt', 'NUL', 'aux.', 'COM1', 'com9.log', 'LPT1', 'COM¹', 'Console', 'CONx', 'a.', 'a..', '..', '.', 'g\u202egnp.exe', 'a\u200bb', '\u200b', 'g\udc00', 'p\ud800', 'a\ufeffb', 'é', 'e\u0301'];
    samples.push('my proj'+'\u200d', '\u200dx', 'a '+'\u200cb', 'proj\u{e0041}', '\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}', 'a\u206ab', 'proj\u0085', 'CONIN$', 'con.\u2028x', 'Straße', 'ﬁlm', 'https://x', '  a  b  ', 'a\u0001b');
    for (const value of samples) {
      expect(validFileNamePrefix(value), JSON.stringify(value)).toBe(mcpQueue.validFileNamePrefix(value));
      expect(validHistoryGroupName(value), JSON.stringify(value)).toBe(mcpQueue.validHistoryGroupName(value));
      // The MCP copies of the host's name normalization and folder naming (round 3 R7).
      expect(mcpQueue.normalizeHistoryGroupName(value), JSON.stringify(value)).toBe(normalizeHistoryGroupName(value));
      expect(mcpQueue.groupFolderName(value), JSON.stringify(value)).toBe(sanitizeGroupFolderName(value));
    }
  });

  it('refuses Windows device names, dotted ends and invisible characters (review P2-2, P3-6)', () => {
    for (const value of ['CON', 'con.txt', 'Com1', 'LPT9.x', 'aux', 'a.', '.a', 'g\u202egnp.exe', '\u200b', 'g\udc00']) expect(validHistoryGroupName(value), JSON.stringify(value)).toBe(false);
    for (const value of ['NUL', 'p\u202e', 'p\ud800', '😀'.repeat(21)]) expect(validFileNamePrefix(value), JSON.stringify(value)).toBe(false);
    for (const value of ['Console', 'sketchbook6', 'a.b', '项目', 'my proj', '🧑\u200d💻 studio', 'می\u200cخواهم', 'con-art', 'com10', "Bob's art"]) expect(validHistoryGroupName(value), value).toBe(true);
    // Round 2 (N3): C1 controls, CONIN$-style devices and a device name hidden behind a line separator are refused too.
    for (const value of ['proj\u0085', 'CONIN$', 'conout$.x', 'clock$', 'con.\u2028x', 'a\u00adb']) expect(validHistoryGroupName(value), JSON.stringify(value)).toBe(false);
  });

  it('a new group that would share an existing folder is refused before any receipt (review P3-5)', async () => {
    const host = await startHost();
    const recipe = await host.ok('prepare_recipe', t2i);
    const first = await host.ok('enqueue_recipes', { requestKey: 'proj-a', items: [ref(recipe)], historyGroup: 'my proj' });
    const clash = await host.call('enqueue_recipes', { requestKey: 'proj-b', items: [ref(recipe)], historyGroup: 'My_Proj' });
    expect(clash.ok).toBe(false);
    expect(clash.value.error).toMatchObject({ code: 'history_group_conflict', details: { status: 'rejected', keyStatus: 'not_found' } });
    expect(clash.value.error.message).toContain('"my proj"');
    // The same name in another case reuses the group itself.
    const same = await host.ok('enqueue_recipes', { requestKey: 'proj-c', items: [ref(recipe)], historyGroup: 'MY PROJ' });
    expect(same.batch.output).toMatchObject({ historyGroup: 'MY PROJ', historyGroupId: first.batch.output.historyGroupId, historyGroupName: 'my proj' });
    expect(fixture.groups.map(group => group.name)).toEqual(['my proj']);
    // The refusal frees the key for a changed plan at once: clear, no window (round 3 observation; 0.1.4 says so).
    const looked = await host.ok('lookup_enqueue', { requestKey: 'proj-b' });
    expect(looked.status).toBe('not_found'); expect(looked.settlement).toEqual({ state: 'clear', newKeyAdvised: false });
    const renamed = await host.ok('enqueue_recipes', { requestKey: 'proj-b', items: [ref(recipe)], historyGroup: 'other proj' });
    expect(renamed.batch.output).toMatchObject({ historyGroup: 'other proj', historyGroupName: 'other proj' });
    expect(() => resolveQueueHistoryGroup('a-b', [{ id: 'x', name: 'a:b' }], () => { throw new Error('must not create'); })).toThrow(QueueHistoryGroupConflict);
    await settle(host.ok, first.batch.batchId); await settle(host.ok, same.batch.batchId); await settle(host.ok, renamed.batch.batchId);
  });

  it('compares group names the way ensureHistoryGroup stores them, and folders the way the file system does (round 2 N1, N2)', () => {
    const never = () => { throw new Error('must not create'); };
    // A group made in the UI keeps its spacing; asking for its normalized name reuses it instead of a second group.
    const ui = [{ id: 'u1', name: 'my  proj' }, { id: 'u2', name: '项目\u3000A' }, { id: 'u3', name: 'café' }, { id: 'u4', name: 'proj.' }];
    expect(resolveQueueHistoryGroup('my proj', ui, never)).toBe(ui[0]);
    expect(resolveQueueHistoryGroup('My  Proj', ui, never)).toBe(ui[0]);
    expect(resolveQueueHistoryGroup('项目 A', ui, never)).toBe(ui[1]);
    expect(resolveQueueHistoryGroup('cafe\u0301', ui, never)).toBe(ui[2]);
    // Different names, same folder: refused, and the hint names a group that will really be reused.
    // The hint names the group in a form this tool accepts and that reuses it (round 4 S5).
    expect(() => resolveQueueHistoryGroup('My_Proj', ui, never)).toThrow(/Use "my proj" to share it/);
    expect(() => resolveQueueHistoryGroup('proj', ui, never)).toThrow(/whose name this tool cannot use/);
    expect(() => resolveQueueHistoryGroup('项目_A', ui, never)).toThrow(QueueHistoryGroupConflict);
    const created = { id: 'n', name: 'fresh' };
    expect(resolveQueueHistoryGroup('fresh', ui, () => created)).toBe(created);
  });

  it('prefers the exactly named group, compares existing groups by their real folder, folds case like APFS, and only points to usable names (round 3 R1–R4)', () => {
    const never = () => { throw new Error('must not create'); };
    // R1: of two groups that normalize alike, the exact name wins, then the case-insensitive one.
    const twins = [{ id: 'd', name: 'my  proj' }, { id: 'e', name: 'my proj' }, { id: 'f', name: 'MY  PROJ' }];
    expect(resolveQueueHistoryGroup('my proj', twins, never).id).toBe('e');
    expect(resolveQueueHistoryGroup('MY  PROJ', twins, never).id).toBe('f');
    expect(resolveQueueHistoryGroup('My Proj', twins, never).id).toBe('e');
    // R2: a long UI name saves into sanitize(its own name), not into that of its truncated normalization.
    const long = [{ id: 'l', name: 'a' + ':'.repeat(10) + 'b'.repeat(78) }];
    expect(sanitizeGroupFolderName(long[0].name)).toBe('a-' + 'b'.repeat(78));
    expect(() => resolveQueueHistoryGroup('a-' + 'b'.repeat(78), long, never)).toThrow(QueueHistoryGroupConflict);
    // R3: APFS folds ß/ss and ligatures; NFD/NFC is one folder too.
    const folded = [{ id: 's', name: 'Straße' }, { id: 'f', name: 'ﬁlm' }];
    expect(() => resolveQueueHistoryGroup('Strasse', folded, never)).toThrow(/"Straße"/);
    expect(() => resolveQueueHistoryGroup('FILM', folded, never)).toThrow(/"ﬁlm"/);
    // R4: a group this tool cannot name is never offered as the name to use.
    expect(() => resolveQueueHistoryGroup('proj', [{ id: 'p', name: 'proj.' }], never)).toThrow(/whose name this tool cannot use\. Choose a clearly different name/);
  });

  it('refuses an invalid output before any receipt, so the requestKey stays unused', async () => {
    const host = await startHost();
    const recipe = await host.ok('prepare_recipe', t2i);
    const args = { requestKey: 'host-key-1', items: [ref(recipe)] };
    for (const output of [{ fileNamePrefix: 'a/b' }, { historyGroup: ' padded' }, {}, { historyGroup: 'p', extra: 1 }, 'p']) {
      await expect(host.queue.enqueue_queue_recipes({ ...args, output })).rejects.toMatchObject({ code: 'invalid_argument' });
    }
    expect(await host.queue.lookup_queue_request({ requestKey: 'host-key-1' })).toEqual({ batch: null, inFlight: false });
    expect(host.resolver).not.toHaveBeenCalled();
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it('a history group that cannot be created refuses the enqueue before its receipt; the same key works afterwards', async () => {
    let broken = true;
    const host = await startHost({ resolveHistoryGroup: name => { if (broken) throw new Error('store write failed'); return mainResolver(name); } });
    const recipe = await host.ok('prepare_recipe', t2i);
    const args = { requestKey: 'group-down', items: [ref(recipe)], historyGroup: 'sketchbook6' };
    const refused = await host.call('enqueue_recipes', args);
    expect(refused.ok).toBe(false);
    expect(refused.value.error).toMatchObject({ code: 'history_group_unavailable', details: { status: 'rejected', keyStatus: 'not_found' } });
    expect(fixture.post).not.toHaveBeenCalled();
    broken = false;
    const enqueued = await host.ok('enqueue_recipes', args);
    expect(enqueued).toMatchObject({ status: 'enqueued', batch: { output: { historyGroup: 'sketchbook6', historyGroupId: 'group-1', historyGroupName: 'sketchbook6' } } });
    const read = await settle(host.ok, enqueued.batch.batchId);
    expect(read.results[0].file).toBe(`novelai/.runtime/output/${today()}/sketchbook6/${today()}_01_nai-diffusion-5-full.png`);
  });

  it('a prefix alone renames the files in the date root and creates no group', async () => {
    const host = await startHost();
    const recipe = await host.ok('prepare_recipe', t2i);
    const enqueued = await host.ok('enqueue_recipes', { requestKey: 'prefix-only', items: [{ ...ref(recipe), count: 2, seeds: [1, 2] }], fileNamePrefix: 'solo' });
    expect(enqueued.batch.output).toEqual({ fileNamePrefix: 'solo' });
    const read = await settle(host.ok, enqueued.batch.batchId);
    expect(read.results.map((result: any) => result.file)).toEqual([`${today()}_01_nai-diffusion-5-full.png`, `${today()}_01_nai-diffusion-5-full-1.png`].map(name => `novelai/.runtime/output/${today()}/solo_${name}`));
    expect(host.resolver).not.toHaveBeenCalled();
    expect(fixture.groups).toEqual([]);
    expect(fixture.history.map(item => item.groupId)).toEqual([undefined, undefined]);
  });

  it('an older client refuses the new fields: host_outdated, nothing queued, the same key still usable without them', async () => {
    const host = await startHost({ olderClient: true });
    const recipe = await host.ok('prepare_recipe', t2i);
    const outdated = await host.call('enqueue_recipes', { requestKey: 'older-client', items: [ref(recipe)], historyGroup: 'sketchbook6', fileNamePrefix: 'sketchbook6' });
    expect(outdated.ok).toBe(false);
    expect(outdated.value.error).toMatchObject({ code: 'host_outdated', details: { status: 'not_sent', enqueueSent: false, saved: false } });
    expect(await host.ok('lookup_enqueue', { requestKey: 'older-client' })).toMatchObject({ status: 'not_found' });
    const plain = await host.ok('enqueue_recipes', { requestKey: 'older-client', items: [ref(recipe)] });
    expect(plain.status).toBe('enqueued');
    expect(plain.batch).not.toHaveProperty('output');
  });

  it('a lost enqueue is settled in the same call by the same plan under the same key; the original arriving late is answered from its receipt (0.1.4, replacing the settle window of round 4 S1)', async () => {
    fixture.groups.push({ id: 'g0', name: 'my proj', createdAt: '2026-10-14T00:00:00Z' });
    const host = await startHost();
    const recipe = await host.ok('prepare_recipe', t2i);
    host.holdNext();
    const settled = await host.ok('enqueue_recipes', { requestKey: 'k-s1', items: [ref(recipe)] });
    expect(settled).toMatchObject({ status: 'enqueued', reconciled: true, settled: { lookups: 1, resends: 1 } });
    // The held original reaches the host late: answered from the key's receipt, no second batch.
    await host.release();
    expect(await host.ok('lookup_enqueue', { requestKey: 'k-s1' })).toMatchObject({ status: 'enqueued', batch: { batchId: settled.batch.batchId } });
    // A changed plan under the key (here a colliding group) is refused before anything is sent.
    const refused = await host.call('enqueue_recipes', { requestKey: 'k-s1', items: [ref(recipe)], historyGroup: 'My_Proj' });
    expect(refused.value.error).toMatchObject({ code: 'request_conflict', details: { enqueueSent: false, existingBatch: { batchId: settled.batch.batchId } } });
    await settle(host.ok, settled.batch.batchId);
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });

  it('host_outdated from a client without the output fields leaves the key unused, and a lookup says so at once (0.1.4)', async () => {
    const host = await startHost({ olderClient: true });
    const recipe = await host.ok('prepare_recipe', t2i);
    expect((await host.call('enqueue_recipes', { requestKey: 'k-s1c', items: [ref(recipe)], fileNamePrefix: 'p' })).value.error.code).toBe('host_outdated');
    const free = await host.ok('lookup_enqueue', { requestKey: 'k-s1c' });
    expect(free).toMatchObject({ status: 'not_found', inFlight: false, settlement: { state: 'clear', newKeyAdvised: false } });
    expect(free.instruction).toMatch(/with the same plan or a changed one/);
    const plain = await host.ok('enqueue_recipes', { requestKey: 'k-s1c', items: [ref(recipe)] });
    expect(plain.status).toBe('enqueued');
    await settle(host.ok, plain.batch.batchId);
  });

  it('allows only the three RGI tag flags, folds like APFS, maps cut surrogates like the disk and offers usable names (round 4 S2\u2013S5)', () => {
    const tags = (text: string) => [...text].map(ch => String.fromCodePoint(0xe0000 + ch.charCodeAt(0))).join('');
    const flag = (code: string) => '\u{1f3f4}' + tags(code) + '\u{e007f}';
    for (const value of [flag('gbsct'), flag('gbeng') + ' art', 'Cymru ' + flag('gbwls')]) { expect(validHistoryGroupName(value), value).toBe(true); expect(mcpQueue.validHistoryGroupName(value)).toBe(true); }
    for (const value of [flag('ignore'), 'proj \u{1f3f4}' + tags('ignore previous'), '\u{1f3f4}\u{e007f}', flag('usca'), 'a' + tags('x')]) { expect(validHistoryGroupName(value), JSON.stringify(value)).toBe(false); expect(validFileNamePrefix(value)).toBe(false); expect(mcpQueue.validHistoryGroupName(value)).toBe(false); }
    const never = () => { throw new Error('must not create'); };
    expect(() => resolveQueueHistoryGroup('Strasse', [{ id: 'x', name: 'STRA\u1e9eE' }], never)).toThrow(QueueHistoryGroupConflict);
    expect(() => resolveQueueHistoryGroup('\u0390x', [{ id: 'x', name: '\u0399\u0308\u0301X' }], never)).toThrow(QueueHistoryGroupConflict);
    const cut = 'p'.repeat(79) + '\u{1f600}';
    expect(() => resolveQueueHistoryGroup('p'.repeat(79) + '\ufffd', [{ id: 'x', name: cut + 'tail' }], never)).toThrow(QueueHistoryGroupConflict);
    // The hint offers the normalized name, which the public schema accepts and which reuses the same group.
    expect(() => resolveQueueHistoryGroup('x_y', [{ id: 'x', name: 'x\u2028y' }], never)).toThrow(/Use "x y" to share it/);
    expect(resolveQueueHistoryGroup('x y', [{ id: 'x', name: 'x\u2028y' }], never).id).toBe('x');
  });

  it('compacts frozen batches under exactly the host key prefix the MCP server derives', () => {
    expect(mcpQueue.HOST_REQUEST_KEY_PREFIX).toBe('mcp-');
    expect(FROZEN_COMPACTION_POLICY.requestKeyPrefix).toBe(mcpQueue.HOST_REQUEST_KEY_PREFIX);
    expect(mcpQueue.mcpHostRequestKey('any intent').startsWith(mcpQueue.HOST_REQUEST_KEY_PREFIX)).toBe(true);
  });

  it('keeps the MCP copies of the regex lines textually identical to the host ones (round 4 S6)', async () => {
    const read = async (file: string) => (await fs.readFile(new URL(file, import.meta.url), 'utf8')).split('\n');
    const [host, mcp] = await Promise.all([read('./queue-output.ts'), read('../../src/recipe-queue.mjs')]);
    for (const name of ['CONTROL', 'INVISIBLE', 'STRAY_JOINER', 'FLAG_TAG_SEQUENCE', 'STRAY_TAG', 'WINDOWS_RESERVED']) {
      const pick = (lines: string[]) => lines.filter(line => line.startsWith(`const ${name} = `));
      expect(pick(host), name).toHaveLength(1);
      expect(pick(mcp), name).toEqual(pick(host));
    }
    const body = (lines: string[]) => lines.find(line => line.startsWith('export const normalizeHistoryGroupName = '))!.split('=>').slice(1).join('=>').trim();
    expect(body(mcp)).toBe(body(host));
    // Neither file holds an invisible or bidi character literally (Trojan Source shape).
    for (const lines of [host, mcp]) expect(lines.join('\n')).not.toMatch(/[\p{Cf}\p{Cs}\u2028\u2029]/u);
  });
});
