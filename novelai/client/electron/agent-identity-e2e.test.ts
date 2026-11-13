/**
 * Step 4a acceptance 5 (agent identity end to end): a real MCP server process over stdio — the source entry
 * (novelai/src/mcp.mjs) by default, or the single-file bundle when NAI_MCP_ENTRY names it — connects with a chosen
 * clientInfo to the real HTTP bridge, which dispatches like main.ts to the real recipe store, frozen batch queue,
 * asset library and Recently Deleted. The host records recent calls (client, tool, time; never arguments), names the
 * enqueuing client on the batch and the deleting client on the Recently Deleted entry. Nothing is generated: the
 * queue sees a busy generator, so a queued batch only waits. Every folder is temporary.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';

vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));

import { startHttpBridge, type BridgeCaller } from './bridge-server';
import { agentActor, createAgentActivity } from './agent-activity';
import { createBatchService } from './batch-service';
import { createQueueRecipeService, QUEUE_METHODS } from './queue-recipe-service';
import { queueBridgeError } from './queue-bridge-error';
import { BridgeError } from './bridge-server';
import { openLibraryRepository } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createLibraryTrash } from './library-trash';
import { agentClientLabel, batchSourceLabel } from '../src/agent-clients';
import { Client } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

const ENTRY = process.env.NAI_MCP_ENTRY ? path.resolve(process.env.NAI_MCP_ENTRY) : path.resolve(__dirname, '../../src/mcp.mjs');
const T2I = { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 64, height: 64, steps: 1, cfgScale: 5, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard', stylePrompt: '', positivePrompt: 'secret garden prompt text', negativePrompt: '', seed: 7 };
const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(() => runCleanups(closers.splice(0).reverse()));

async function host() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-agent-e2e-')));
  closers.push(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime'), library = path.join(root, 'library'), output = path.join(root, 'output');
  for (const dir of [runtimeDir, library, output, path.join(root, 'project')]) await fs.mkdir(dir, { recursive: true });
  const repository = openLibraryRepository({ filePath: path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root });
  closers.push(() => repository.close());
  const trash = createLibraryTrash({ repository, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], log: () => undefined, recipeReferences: async () => new Map() });
  closers.push(() => trash.idle());
  const assets = createAssetLibraryService({ repository, trash, toFileUrl: file => `fixture:${file}` });
  const batch = createBatchService({ generation: { lookup: () => null, submit: () => { throw new Error('nothing is generated here'); }, read: () => { throw new Error('none'); }, cancel: () => { throw new Error('none'); } }, isBusy: () => true, runtimeDir });
  closers.push(() => batch.dispose());
  const queue: any = createQueueRecipeService({ runtimeDir, batch, recipeReclaim: { auto: false } });
  const activity = createAgentActivity({ runtimeDir, writeDelayMs: 0 });
  closers.push(() => activity.flush());
  // As main.ts: an enqueue names its agent on the batch; a deletion through the bridge is the agent's.
  const hostMethods: Record<string, (args: any, caller?: BridgeCaller) => Promise<any>> = {
    ...Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: any, caller?: BridgeCaller) => {
      try { return method === 'enqueue_queue_recipes' && caller ? await queue.enqueue_queue_recipes(args, { source: agentActor(caller) }) : await queue[method](args); }
      catch (error) { throw queueBridgeError(error); }
    }])),
    asset_library: async (args, caller) => { try { return await assets.asset_library(args, { deletedBy: caller ? agentActor(caller) : { kind: 'user' } }); } catch (error: any) { throw new BridgeError(error?.code ?? 'material_failed', error?.message ?? 'failed'); } },
  };
  const bridge = await startHttpBridge({ runtimeDir, dispatch: (method, args, caller) => Object.hasOwn(hostMethods, method) ? hostMethods[method](args, caller) : Promise.reject(new BridgeError('workspace_not_ready', 'No canvas here.', 503)),
    onCall: (method, caller) => activity.record(method, caller) });
  closers.push(() => bridge.close());
  return { root, repository, output, queue, activity, assets };
}

async function connect(root: string, clientInfo: { name: string; version: string }) {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: os.tmpdir(), NOVELAI_DATA_DIR: root, NOVELAI_PROJECT_ROOT: path.join(root, 'project'), NOVELAI_MCP_AUTOSTART: '0', ...(process.env.NAI_MCP_ELECTRON ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
  const transport = new StdioClientTransport({ command: process.env.NAI_MCP_ELECTRON ?? process.execPath, args: [ENTRY], env, stderr: 'pipe' });
  const client = new Client(clientInfo);
  await client.connect(transport);
  closers.push(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name}: ${JSON.stringify(result.structuredContent).slice(0, 800)}`).not.toBe(true);
    return result.structuredContent;
  };
  return { client, call };
}

it('names the calling client in recent calls, on the queued batch and on the Recently Deleted entry; nothing of the arguments is kept', async () => {
  const h = await host();
  const file = path.join(h.output, 'garden.png'); await fs.writeFile(file, 'garden image bytes');
  const garden = h.repository.put('history', 'garden', { id: 'garden', filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-03', createdAt: '2026-11-03T00:00:00Z', params: { positivePrompt: 'sunlit garden', seed: 3 }, actualSeed: 3, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  const agent = await connect(h.root, { name: 'claude-code', version: '2.1.112' });
  await agent.call('list_queue');
  const recipe = await agent.call('prepare_recipe', T2I);
  const enqueued = await agent.call('enqueue_recipes', { requestKey: 'agent-identity-e2e', items: [{ recipeId: recipe.recipeId, recipeRevision: recipe.recipeRevision, inputHash: recipe.inputHash }] });
  expect(enqueued.status).toBe('enqueued');
  const batchId = enqueued.batchId;
  // The host keeps who enqueued the batch (the queue page shows it); an agent's own compact reads name a source only for a manual batch.
  expect((await h.queue.read_queue({ batchId })).source).toEqual({ kind: 'agent', client: { name: 'claude-code', version: '2.1.112' } });
  expect((await h.queue.list_queue({})).batches[0].source).toEqual({ kind: 'agent', client: { name: 'claude-code', version: '2.1.112' } });
  expect((await agent.call('read_queue', { batchId })).source).toBeUndefined();
  expect((await agent.call('list_queue')).batches[0]).toMatchObject({ batchId });
  const deleted = await agent.call('asset_library', { action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'garden', expectedRevision: garden.revision }] });
  expect(deleted.deleted).toHaveLength(1);
  const listed = await agent.call('asset_library', { action: 'recently-deleted' });
  expect(listed.entries[0].deletedBy).toEqual({ kind: 'agent', client: { name: 'claude-code', version: '2.1.112' } });

  // A deletion in the window (novelai:assets, the history panel) is the user's.
  const pond = h.repository.put('history', 'pond', { id: 'pond', filePath: path.join(h.output, 'pond.png'), fileUrl: 'fixture:pond', date: '2026-11-03', createdAt: '2026-11-03T00:00:00Z', params: { positivePrompt: 'pond', seed: 4 }, actualSeed: 4, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  await h.assets.asset_library({ action: 'mutate', command: 'delete', items: [{ kind: 'history', id: 'pond', expectedRevision: pond.revision }] }, { deletedBy: { kind: 'user' } });
  const both = await h.assets.asset_library({ action: 'recently-deleted' });
  expect(Object.fromEntries(both.entries.map((entry: any) => [entry.id, entry.deletedBy]))).toEqual({ pond: { kind: 'user' }, garden: { kind: 'agent', client: { name: 'claude-code', version: '2.1.112' } } });

  // The host's own views.
  const batch = (await h.queue.list_queue({})).batches.find((value: any) => value.batchId === batchId);
  expect(batchSourceLabel(batch.source, '手动')).toBe('Claude Code');
  const activity = await h.activity.read();
  expect(activity.recent.map(row => row.tool)).toEqual(['asset_library', 'asset_library', 'list_queue', 'read_queue', 'enqueue_recipes', 'prepare_recipe', 'list_queue']);
  expect(activity.recent.every(row => row.client?.name === 'claude-code' && row.client.version === '2.1.112')).toBe(true);
  expect(activity.clients.map(summary => [agentClientLabel(summary.client), summary.lastTool, summary.calls])).toEqual([['Claude Code', 'asset_library', 7]]);
  await h.activity.flush();
  const stored = await fs.readFile(path.join(h.root, 'runtime', 'agent-activity.json'), 'utf8');
  for (const leaked of ['secret garden prompt text', 'agent-identity-e2e', recipe.recipeId, 'garden.png', '"items"', 'requestKey']) expect(stored).not.toContain(leaked);

  // A client without a usable name is shown as "Agent".
  const anonymous = await connect(h.root, { name: '', version: '' });
  await anonymous.call('list_queue');
  const after = await h.activity.read();
  expect(after.recent[0]).toMatchObject({ client: null, tool: 'list_queue' });
  expect(agentClientLabel(after.recent[0].client)).toBe('Agent');
  expect(after.clients.map(summary => agentClientLabel(summary.client))).toEqual(['Agent', 'Claude Code']);
}, 60_000);
