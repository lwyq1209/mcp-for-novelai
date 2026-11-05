import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeError, startHttpBridge } from './bridge-server';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter(), app: {}, dialog: {}, nativeImage: { createFromBuffer: () => { throw new Error('NO_IMAGES_IN_FIXTURE'); } } };
});
vi.mock('axios', () => ({ default: { get: () => { throw new Error('DENY_NETWORK'); }, post: () => { throw new Error('DENY_NETWORK'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('DENY_CREDENTIAL'); }, getSettings: () => { throw new Error('DENY_PRODUCTION_SETTINGS'); } }));

import { ipcMain, type BrowserWindow } from 'electron';
import { startWorkspaceBridge } from './bridge-host';
import { createQueueRecipeService } from './queue-recipe-service';
import { createBridgeClient } from '../../src/mcp.mjs';
import { runCleanups } from '../src/test-support/temp-dirs';

// A synthetic one-pixel PNG; tests never access user images or NovelAI endpoints.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=', 'base64');
const GIF89 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const GIF87 = Buffer.from('R0lGODdhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const connectionName = 'bridge.json';
type Connection = { schemaVersion: number; url: string; token: string; pid: number };
const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.useRealTimers();
  try { await runCleanups(cleanup.splice(0).reverse()); } finally { ipcMain.removeAllListeners(); }
});

/** The caller of an HTTP bridge call whose body names none (an MCP server older than step 4a). */
const NO_CALLER = { tool: null, client: null, callId: null };

async function temporaryRuntime() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-bridge-test-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

it('routes independent recipes and queue operations to the host with no window; legacy canvas calls still require it', async () => {
  const runtimeDir = await temporaryRuntime();
  const host = { put_queue_recipe: vi.fn(async (args: any) => ({ recipeId: 'isolated', preparation: args.preparation })), list_queue: vi.fn(async () => ({ batches: [] })), asset_library: vi.fn(async (args: any) => ({ received: args })), style_experiment: vi.fn(async () => ({ removed: false })) };
  const bridge = await startWorkspaceBridge(() => null, runtimeDir, host); cleanup.push(() => bridge.close());
  const connection = JSON.parse(await fs.readFile(path.join(runtimeDir, connectionName), 'utf8'));
  const saved = await rpc(connection, 'put_queue_recipe', { preparation: { mode: 't2i' } });
  expect(saved.status).toBe(200);
  expect(host.put_queue_recipe).toHaveBeenCalledWith({ preparation: { mode: 't2i' } }, NO_CALLER);
  expect((await rpc(connection, 'list_queue')).status).toBe(200);
  const assets = await rpc(connection, 'asset_library', { action: 'list', limit: 5 });
  expect(assets).toMatchObject({ status: 200, body: { ok: true, result: { received: { action: 'list', limit: 5 } } } });
  // The removed style experiment methods are no longer bridge methods, even if a host still had a handler.
  for (const removed of ['style_trial', 'style_experiment', 'style_sweep']) expect((await rpc(connection, removed, { action: 'list_experiments' })).status).toBe(400);
  expect(host.style_experiment).not.toHaveBeenCalled();
  expect((await rpc(connection, 'read_workspace', { workspaceId: 'not-connected' })).status).toBe(503);
  expect((await rpc(connection, 'toString')).status).toBe(400);
});

async function server(dispatch = vi.fn(async (_method: string, _args: Record<string, unknown>): Promise<any> => ({ workspaces: [] }))) {
  const runtimeDir = await temporaryRuntime();
  const bridge = await startHttpBridge({ runtimeDir, dispatch });
  cleanup.push(() => bridge.close());
  return { ...bridge, runtimeDir, dispatch };
}

function rpc(connection: Connection, method: string, args: unknown = {}, options: {
  headers?: Record<string, string | undefined>;
  method?: string;
  route?: string;
  raw?: string;
  caller?: unknown;
} = {}) {
  const body = options.raw ?? JSON.stringify({ method, args, ...(options.caller !== undefined ? { caller: options.caller } : {}) });
  const url = new URL(options.route ?? '/rpc', connection.url);
  const headers = {
    authorization: `Bearer ${connection.token}`,
    'content-type': 'application/json',
    ...options.headers,
  };
  for (const key of Object.keys(headers)) if (headers[key as keyof typeof headers] === undefined) delete headers[key as keyof typeof headers];
  return new Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'POST', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), headers: res.headers }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('Test HTTP request timed out')));
    req.end(body);
  });
}

function expectError(response: Awaited<ReturnType<typeof rpc>>, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({ ok: false, error: { code } });
}

function document(assets: any[] = []) {
  return {
    schemaVersion: 1,
    state: { params: { prompt: 'a blue teacup on a table', model: 'nai-diffusion-5-full', seed: 42 }, charCaptions: [] },
    assets,
  };
}

describe('Workspace bridge real HTTP boundary', () => {
  it('routes unified library queries and versioned edits to the host without a renderer', async () => {
    const runtimeDir = await temporaryRuntime();
    const asset_library = vi.fn(async (args: any) => ({ received: args, revision: 7 }));
    const bridge = await startWorkspaceBridge(() => null, runtimeDir, { asset_library });
    cleanup.push(() => bridge.close());
    const connection = JSON.parse(await fs.readFile(path.join(runtimeDir, connectionName), 'utf8'));
    for (const args of [
      { action: 'list', query: 'blue mug', kinds: ['history'], limit: 5 },
      { action: 'collections' },
      { action: 'read', kind: 'note', id: 'sfw-note', revision: 2 },
      { action: 'mutate', command: 'archive', items: [{ kind: 'note', id: 'sfw-note', expectedRevision: 2 }], patch: { archived: true } },
    ]) {
      const result = await rpc(connection, 'asset_library', args);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, result: { received: args, revision: 7 } });
      expect(asset_library).toHaveBeenLastCalledWith(args, NO_CALLER);
    }
    expectError(await rpc(connection, 'read_workspace', { workspaceId: 'absent' }), 503, 'workspace_not_ready');
  });

  it('writes a private loopback connection and dispatches authenticated JSON', async () => {
    const bridge = await server();
    const file = path.join(bridge.runtimeDir, connectionName);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(bridge.connection);
    // win32 reports no POSIX permission bits (always 0o666); privacy there relies on the user profile ACL.
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(bridge.connection.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(bridge.connection.token).toMatch(/^[a-f0-9]{64}$/);
    const result = await rpc(bridge.connection, 'list_workspaces');
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, result: { workspaces: [] } });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(bridge.dispatch).toHaveBeenCalledExactlyOnceWith('list_workspaces', {}, NO_CALLER);
    expect(JSON.stringify(result.body)).not.toContain(bridge.connection.token);
  });

  async function queueHttpHarness() {
    const root = await temporaryRuntime(), queueRuntime = path.join(root, 'queue'), enqueue = vi.fn(async () => { throw new Error('NO_ENQUEUE_AUTHORIZED'); });
    await fs.mkdir(queueRuntime);
    const host = createQueueRecipeService({ runtimeDir: queueRuntime, batch: { ready: Promise.resolve(), enqueue, lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })) } as any });
    const source = await host.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { positivePrompt: 'still life, red cup on table', negativePrompt: '', stylePrompt: '', seed: 41, seedMode: 'fixed', width: 64, height: 64 }, charCaptions: [] }, assets: [] } });
    const routed: string[] = [], bridge = await startHttpBridge({ runtimeDir: path.join(root, 'http'), dispatch: async (method, args) => { routed.push(method); return (host as any)[method](args); } });
    cleanup.push(() => bridge.close());
    return { host, source, routed, enqueue, bridge, queueStore: path.join(queueRuntime, 'queue-recipes'), client: createBridgeClient({ runtimeDir: path.join(root, 'http') }) };
  }

  it('routes recipe reads through the authenticated HTTP boundary without a renderer; the retired derive methods are unsupported', async () => {
    const h = await queueHttpHarness();
    const identity = { recipeId: h.source.recipeId, recipeRevision: h.source.recipeRevision };
    const source = await h.client.call('read_queue_recipe', identity);
    expect(source.inputHash).toBe(h.source.inputHash);
    expect(h.routed).toEqual(['read_queue_recipe']);
    expectError(await rpc(h.bridge.connection, 'read_queue_recipe', identity, { headers: { authorization: undefined } }), 401, 'unauthorized');
    expectError(await rpc(h.bridge.connection, 'read_queue_recipe', identity, { headers: { origin: 'https://example.test' } }), 403, 'forbidden_origin');
    for (const method of ['derive_queue_recipe', 'lookup_derived_queue_recipe', 'unknown_queue_recipe_method']) expectError(await rpc(h.bridge.connection, method, { requestKey: 'x' }), 400, 'unsupported_method');
    expect(h.routed).toEqual(['read_queue_recipe']);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('routes preview_queue_recipe through the authenticated HTTP boundary as a write-free dry run', async () => {
    const h = await queueHttpHarness();
    const preparation = { mode: 't2i', authored: { params: { positivePrompt: 'still life, red cup on table', negativePrompt: '', stylePrompt: '', seed: 41, seedMode: 'fixed', width: 64, height: 64 }, charCaptions: [] }, assets: [] };
    const listing = async () => Promise.all((await fs.readdir(h.queueStore)).sort().map(async name => [name, (await fs.readFile(path.join(h.queueStore, name))).toString('base64')]));
    const before = await listing();
    const preview = await h.client.call('preview_queue_recipe', { preparation, assetData: 'omit' });
    expect(preview).toMatchObject({ preview: true, saved: false, recipeId: null, inputHash: h.source.inputHash, previewImage: null, snapshot: { mode: 't2i', revision: null } });
    expect(h.routed).toEqual(['preview_queue_recipe']);
    expect(await listing()).toEqual(before);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it.each([undefined, 'Bearer wrong', `Bearer ${'0'.repeat(64)}`])('rejects missing or incorrect authorization (%s)', async authorization => {
    const bridge = await server();
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { headers: { authorization } }), 401, 'unauthorized');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it.each(['https://example.test', 'null', ''])('rejects every supplied browser Origin (%s)', async origin => {
    const bridge = await server();
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { headers: { origin } }), 403, 'forbidden_origin');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it.each(['example.test', 'localhost:1234', '127.0.0.1:1'])('rejects a substituted Host (%s)', async host => {
    const bridge = await server();
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { headers: { host } }), 403, 'forbidden_origin');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it.each(['GET', 'PUT', 'OPTIONS'])('only serves POST (%s)', async method => {
    const bridge = await server();
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { method }), 404, 'not_found');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it('rejects unrecognized routes, malformed JSON, media types and RPC shapes', async () => {
    const bridge = await server();
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { route: '/other' }), 404, 'not_found');
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { raw: '{' }), 400, 'invalid_json');
    expectError(await rpc(bridge.connection, 'list_workspaces', {}, { headers: { 'content-type': 'text/plain' } }), 415, 'invalid_content_type');
    for (const [method, args] of [['read_workspace', []], ['read_workspace', null]]) {
      expectError(await rpc(bridge.connection, method as string, args), 400, 'invalid_request');
    }
    for (const method of ['generate', 'export_document', 'stage_restore']) {
      const response = await rpc(bridge.connection, method, {});
      expectError(response, 400, 'unsupported_method');
      expect(response.body.error.message).toContain('正常重开客户端');
      expect(response.body.error.message).toContain('不是填写参数错误');
      expect(JSON.stringify(response.body)).not.toContain(bridge.connection.token);
    }
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it('preserves conflict status and structured details without retrying dispatch', async () => {
    const dispatch = vi.fn(async () => { throw new BridgeError('revision_conflict', 'changed manually', 409, { expectedRevision: 4, actualRevision: 5 }); });
    const bridge = await server(dispatch);
    const response = await rpc(bridge.connection, 'apply_edit', { workspaceId: 'work', expectedRevision: 4, draftId: 'draft' });
    expectError(response, 409, 'revision_conflict');
    expect(response.body.error.details).toEqual({ expectedRevision: 4, actualRevision: 5 });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not expose filesystem error messages to clients', async () => {
    const dispatch = vi.fn(async () => { throw Object.assign(new Error('ENOENT: /private/example/account.json'), { code: 'ENOENT' }); });
    const bridge = await server(dispatch);
    const response = await rpc(bridge.connection, 'read_workspace', { workspaceId: 'work' });
    expectError(response, 400, 'bridge_error');
    expect(JSON.stringify(response.body)).not.toContain('/private/example');
  });

  it('forwards the read-only review mode and optional draft without applying or generating', async () => {
    const bridge = await server();
    const result = { schemaVersion: 1, workspaceId: 'work', revision: 7, mode: 'inpaint', draftId: 'draft', reviewInput: { assets: [], effective: null, readiness: { status: 'blocked', issues: [] } } };
    bridge.dispatch.mockResolvedValueOnce(result);
    const args = { workspaceId: 'work', expectedRevision: 7, mode: 'inpaint', draftId: 'draft' };
    const response = await rpc(bridge.connection, 'read_prompt_review', args);
    expect(response.body).toEqual({ ok: true, result });
    expect(bridge.dispatch.mock.calls).toEqual([['read_prompt_review', args, NO_CALLER]]);
  });

  it('materializes an image path, detects MIME from bytes and removes the path', async () => {
    const bridge = await server();
    const image = path.join(bridge.runtimeDir, 'fixture.png');
    await fs.writeFile(image, PNG);
    bridge.dispatch.mockResolvedValueOnce({ mimeType: 'text/plain', path: image });
    const args = { workspaceId: 'work', expectedRevision: 7, assetId: 'current' };
    const response = await rpc(bridge.connection, 'get_asset', args);
    expect(response.body).toEqual({ ok: true, result: { mimeType: 'image/png', data: PNG.toString('base64') } });
    expect(bridge.dispatch).toHaveBeenCalledExactlyOnceWith('get_asset', args);
  });

  it.each([
    { mimeType: 'image/png', data: Buffer.from('ordinary text').toString('base64') },
    { mimeType: 'image/png', data: 'not!base64' },
    { mimeType: 'image/png', path: 'relative.png' },
  ])('rejects non-image or invalid encoded assets', async asset => {
    const bridge = await server();
    bridge.dispatch.mockResolvedValueOnce(asset);
    expectError(await rpc(bridge.connection, 'get_asset', { workspaceId: 'work', expectedRevision: 0, assetId: 'current' }), 400, 'invalid_asset');
  });

  it('forwards a queue result\'s saved file name, path and actual seed but never its history item (issue #1); the retired canvas result method is gone', async () => {
    const bridge = await server();
    const result = { jobId: 'job', index: 0, mimeType: 'image/png', data: PNG.toString('base64'), historyId: 'h1', actualSeed: 77, historyItem: { id: 'h1', filePath: '/out/a.png', params: { positivePrompt: 'secret prompt' } }, fileName: 'a.png', filePath: '/out/a.png' };
    bridge.dispatch.mockResolvedValueOnce(structuredClone(result));
    const queued = await rpc(bridge.connection, 'get_queue_result', { batchId: 'b', itemIndex: 0, index: 0 });
    expect(queued.body.result).toMatchObject({ historyId: 'h1', actualSeed: 77, fileName: 'a.png', filePath: '/out/a.png' });
    expect(queued.body.result).not.toHaveProperty('historyItem');
    const dispatched = bridge.dispatch.mock.calls.length;
    for (const retired of ['get_generation_result', 'submit_generation', 'list_generation_jobs', 'read_generation_job', 'cancel_generation_job', 'submit_batch', 'list_batches', 'read_batch', 'pause_batch', 'resume_batch', 'cancel_batch', 'batch_checkpoint', 'collect_canvas_preparation'])
      expectError(await rpc(bridge.connection, retired, { workspaceId: 'work', jobId: 'job', index: 0 }), 400, 'unsupported_method');
    expect(bridge.dispatch.mock.calls.length).toBe(dispatched);
  });

  it('rejects a non-image file even when it has a PNG extension', async () => {
    const bridge = await server();
    const file = path.join(bridge.runtimeDir, 'not-an-image.png');
    await fs.writeFile(file, 'synthetic plain-text fixture');
    bridge.dispatch.mockResolvedValueOnce({ path: file, mimeType: 'image/png' });
    expectError(await rpc(bridge.connection, 'get_asset', { workspaceId: 'work', expectedRevision: 0, assetId: 'current' }), 400, 'invalid_asset');
  });

  it.each([['GIF87a', GIF87], ['GIF89a', GIF89]])('returns native GIF image bytes for %s assets', async (_name, bytes) => {
    const bridge = await server();
    bridge.dispatch.mockResolvedValueOnce({ mimeType: 'application/octet-stream', data: (bytes as Buffer).toString('base64') });
    const response = await rpc(bridge.connection, 'get_asset', { workspaceId: 'work', expectedRevision: 0, assetId: 'current' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, result: { mimeType: 'image/gif', data: (bytes as Buffer).toString('base64') } });
  });

  it('closes connections, removes its own connection file and tolerates repeated close', async () => {
    const bridge = await server();
    await bridge.close();
    await bridge.close();
    await expect(fs.access(path.join(bridge.runtimeDir, connectionName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rpc(bridge.connection, 'list_workspaces')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('removes its own connection file before close() first yields, so a quit that cannot await it still cleans up', async () => {
    // main.ts before-quit calls `void workspaceBridge?.close()`; the process may exit before any await resumes.
    const bridge = await server();
    const pending = bridge.close();
    await expect(fs.access(path.join(bridge.runtimeDir, connectionName))).rejects.toMatchObject({ code: 'ENOENT' });
    await pending;
  });

  it('does not remove a replacement bridge connection when the old server closes', async () => {
    const bridge = await server();
    const replacement = { ...bridge.connection, token: 'replacement-token' };
    await fs.writeFile(path.join(bridge.runtimeDir, connectionName), JSON.stringify(replacement));
    await bridge.close();
    expect(JSON.parse(await fs.readFile(path.join(bridge.runtimeDir, connectionName), 'utf8'))).toEqual(replacement);
  });
});

describe('Workspace bridge startup rollback', () => {
  it.each(['server', 'host'])('closes the listening socket when %s cannot publish its connection file', async mode => {
    const runtimeDir = await temporaryRuntime();
    // Real rename failure: the connection destination is a directory, not a file.
    await fs.mkdir(path.join(runtimeDir, connectionName));
    const originalCreate = http.createServer;
    let created: http.Server | undefined;
    let didListen = false;
    const spy = vi.spyOn(http, 'createServer').mockImplementation(((...args: any[]) => {
      const actual = Reflect.apply(originalCreate, http, args) as http.Server;
      created = actual;
      actual.once('listening', () => { didListen = true; });
      // Ensure a failing implementation cannot leak a socket from the test itself.
      cleanup.push(async () => {
        actual.closeAllConnections();
        if (actual.listening) await new Promise<void>(resolve => actual.close(() => resolve()));
      });
      return actual;
    }) as typeof http.createServer);
    try {
      const started = mode === 'server'
        ? startHttpBridge({ runtimeDir, dispatch: async () => ({}) })
        : startWorkspaceBridge(() => null, runtimeDir);
      await expect(started).rejects.toBeDefined();
      expect(didListen).toBe(true);
      expect(created?.listening).toBe(false);
      expect(ipcMain.listenerCount('novelai:bridge:ready')).toBe(0);
      expect(ipcMain.listenerCount('novelai:bridge:response')).toBe(0);
      expect((await fs.readdir(runtimeDir)).filter(name => /^bridge-.+\.tmp$/.test(name))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Bridge draft asset references', () => {
  it('resolves both reference roles at the requested revision before staging the draft', async () => {
    const bridge = await server();
    const source = path.join(bridge.runtimeDir, 'reference.png');
    await fs.writeFile(source, PNG);
    bridge.dispatch.mockImplementation(async (method, args) => {
      if (method === 'get_asset') return args.assetId === 'vibe-source'
        ? { mimeType: 'image/png', data: PNG.toString('base64') }
        : { mimeType: 'image/png', path: source };
      return { draftId: 'draft', baseRevision: args.expectedRevision };
    });
    const args = {
      workspaceId: 'work', expectedRevision: 7,
      patch: {
        params: { prompt: 'a quiet blue tea room' },
        vibeImages: [{ assetId: 'vibe-source', strength: 0.4, infoExtracted: 0.7 }],
        preciseReferences: [{ assetId: 'precise-source', type: 'style', strength: 0.6, fidelity: 0.8 }],
      },
    };
    const response = await rpc(bridge.connection, 'draft_edit', args);
    expect(response.body).toEqual({ ok: true, result: { draftId: 'draft', baseRevision: 7 } });
    expect(bridge.dispatch.mock.calls).toEqual([
      ['get_asset', { workspaceId: 'work', expectedRevision: 7, assetId: 'vibe-source' }, NO_CALLER],
      ['get_asset', { workspaceId: 'work', expectedRevision: 7, assetId: 'precise-source' }, NO_CALLER],
      ['draft_edit', {
        ...args,
        patch: {
          params: args.patch.params,
          vibeImages: [{ strength: 0.4, infoExtracted: 0.7, base64: PNG.toString('base64') }],
          preciseReferences: [{ type: 'style', strength: 0.6, fidelity: 0.8, base64: PNG.toString('base64') }],
        },
      }, NO_CALLER],
    ]);
  });

  it('aborts the whole draft if the revision changes while resolving the next reference', async () => {
    const bridge = await server();
    bridge.dispatch.mockImplementation(async (_method, args) => {
      if (args.assetId === 'first') return { mimeType: 'image/png', data: PNG.toString('base64') };
      throw new BridgeError('revision_conflict', 'Manual edit during reference read', 409, { actualRevision: 8 });
    });
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7,
      patch: { vibeImages: [{ assetId: 'first', strength: 0.4 }, { assetId: 'second', strength: 0.6 }] },
    });
    expectError(response, 409, 'revision_conflict');
    expect(response.body.error.details).toEqual({ actualRevision: 8 });
    expect(bridge.dispatch.mock.calls.map(([method]) => method)).toEqual(['get_asset', 'get_asset']);
  });

  it('keeps the expected revision for the final renderer check after materialization', async () => {
    const bridge = await server();
    bridge.dispatch.mockImplementation(async (method, args) => {
      if (method === 'get_asset') return { mimeType: 'image/png', data: PNG.toString('base64') };
      expect(args.expectedRevision).toBe(7);
      throw new BridgeError('revision_conflict', 'Manual edit before staging', 409, { actualRevision: 8 });
    });
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7, patch: { preciseReferences: [{ assetId: 'reference', strength: 0.6 }] },
    });
    expectError(response, 409, 'revision_conflict');
    expect(bridge.dispatch.mock.calls.map(([method]) => method)).toEqual(['get_asset', 'draft_edit']);
  });

  it.each(['vibeImages', 'preciseReferences'])('rejects dual assetId and base64 sources for %s', async role => {
    const bridge = await server();
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7,
      patch: { [role]: [{ assetId: 'reference', base64: PNG.toString('base64'), strength: 0.6 }] },
    });
    expectError(response, 400, 'invalid_asset');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it('resolves a mask asset at the requested revision into its exact original bytes', async () => {
    const bridge = await server();
    bridge.dispatch.mockImplementation(async method => method === 'get_asset'
      ? { mimeType: 'image/png', data: PNG.toString('base64') }
      : { draftId: 'mask-draft', baseRevision: 7 });
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7, patch: { inpaintMask: { assetId: 'mask' } },
    });
    expect(response.status).toBe(200);
    expect(bridge.dispatch.mock.calls).toEqual([
      ['get_asset', { workspaceId: 'work', expectedRevision: 7, assetId: 'mask' }, NO_CALLER],
      ['draft_edit', { workspaceId: 'work', expectedRevision: 7, patch: { inpaintMask: PNG.toString('base64') } }, NO_CALLER],
    ]);
  });

  it('rejects extra mask source fields instead of reading an arbitrary path', async () => {
    const bridge = await server();
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7,
      patch: { inpaintMask: { assetId: 'mask', path: '/synthetic/not-read.png' } },
    });
    expectError(response, 400, 'invalid_asset');
    expect(bridge.dispatch).not.toHaveBeenCalled();
  });

  it('propagates an unknown manifest asset without staging or guessing a source', async () => {
    const bridge = await server();
    bridge.dispatch.mockImplementation(async () => { throw new BridgeError('unknown_asset', 'Not in this workspace manifest', 404); });
    const response = await rpc(bridge.connection, 'draft_edit', {
      workspaceId: 'work', expectedRevision: 7, patch: { inpaintMask: { assetId: 'missing' } },
    });
    expectError(response, 404, 'unknown_asset');
    expect(bridge.dispatch).toHaveBeenCalledExactlyOnceWith('get_asset', { workspaceId: 'work', expectedRevision: 7, assetId: 'missing' }, NO_CALLER);
  });
});

// Compatibility: saved workspace projects were removed. A runtime written by an older
// version still has its projects/ directory; it must not affect startup or other calls.
describe('leftover saved projects from an older version', () => {
  it('starts with the old projects/ directory, leaves its files untouched and refuses the removed project methods', async () => {
    const runtimeDir = await temporaryRuntime();
    const projects = path.join(runtimeDir, 'projects');
    await fs.mkdir(projects, { mode: 0o700 });
    const projectId = randomUUID();
    const saved = JSON.stringify({ schemaVersion: 1, projectId, name: 'Old garden', savedAt: '2026-09-01T00:00:00.000Z', document: document([{ id: 'current', role: 'currentImage', data: PNG.toString('base64'), mimeType: 'image/png' }]) });
    await fs.writeFile(path.join(projects, `${projectId}.json`), saved);
    await fs.writeFile(path.join(projects, 'unreadable.json'), '{not json');
    const dispatch = vi.fn(async (method: string, _args: Record<string, unknown>): Promise<any> => method === 'list_workspaces' ? { workspaces: [{ workspaceId: 'work' }] } : { workspaceId: 'work', revision: 3 });
    const bridge = await startHttpBridge({ runtimeDir, dispatch });
    cleanup.push(() => bridge.close());
    expect((await rpc(bridge.connection, 'list_workspaces')).body).toEqual({ ok: true, result: { workspaces: [{ workspaceId: 'work' }] } });
    expect((await rpc(bridge.connection, 'read_workspace', { workspaceId: 'work' })).body).toEqual({ ok: true, result: { workspaceId: 'work', revision: 3 } });
    for (const [method, args] of [['list_projects', {}], ['save_project', { workspaceId: 'work', expectedRevision: 3, name: 'Again' }], ['restore_project', { workspaceId: 'work', expectedRevision: 3, projectId }]] as const)
      expectError(await rpc(bridge.connection, method, args), 400, 'unsupported_method');
    expect(dispatch.mock.calls.map(([method]) => method)).toEqual(['list_workspaces', 'read_workspace']);
    expect((await fs.readdir(projects)).sort()).toEqual([`${projectId}.json`, 'unreadable.json'].sort());
    expect(await fs.readFile(path.join(projects, `${projectId}.json`), 'utf8')).toBe(saved);
  });

  it('does not create a projects/ directory in a new runtime', async () => {
    const bridge = await server();
    expect(await fs.readdir(bridge.runtimeDir)).toEqual([connectionName]);
  });
});

async function host() {
  const runtimeDir = await temporaryRuntime();
  const sender = Object.assign(new EventEmitter(), { id: 71, send: vi.fn() });
  const win = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
  const bridge = await startWorkspaceBridge(() => win, runtimeDir);
  cleanup.push(() => bridge.close());
  const connection = JSON.parse(await fs.readFile(path.join(runtimeDir, connectionName), 'utf8')) as Connection;
  const ready = () => ipcMain.emit('novelai:bridge:ready', { sender });
  const nextRequest = () => new Promise<any>(resolve => sender.send.mockImplementationOnce((channel, request) => {
    expect(channel).toBe('novelai:bridge:request'); resolve(request);
  }));
  return { bridge, sender, connection, ready, nextRequest };
}

describe('Electron host dispatch through real HTTP', () => {
  it('requires the selected renderer to announce readiness', async () => {
    const h = await host();
    expectError(await rpc(h.connection, 'list_workspaces'), 503, 'workspace_not_ready');
    ipcMain.emit('novelai:bridge:ready', { sender: { id: 999 } });
    expectError(await rpc(h.connection, 'list_workspaces'), 503, 'workspace_not_ready');
    expect(h.sender.send).not.toHaveBeenCalled();
  });

  it('ignores responses from another webContents and preserves the selected renderer result', async () => {
    const h = await host(); h.ready();
    const sent = h.nextRequest();
    const result = rpc(h.connection, 'read_workspace', { workspaceId: 'work' });
    const request = await sent;
    ipcMain.emit('novelai:bridge:response', { sender: { id: 999 } }, { requestId: request.requestId, result: { revision: 999 } });
    ipcMain.emit('novelai:bridge:response', { sender: h.sender }, { requestId: request.requestId, result: { revision: 4 } });
    expect((await result).body).toEqual({ ok: true, result: { revision: 4 } });
  });

  it.each(['did-start-loading', 'render-process-gone', 'destroyed'])('rejects outstanding operations after %s and requires fresh readiness', async event => {
    const h = await host(); h.ready();
    const sent = h.nextRequest();
    const result = rpc(h.connection, 'read_workspace', { workspaceId: 'work' });
    const request = await sent;
    h.sender.emit(event);
    expectError(await result, 503, 'workspace_unavailable');
    ipcMain.emit('novelai:bridge:response', { sender: h.sender }, { requestId: request.requestId, result: { stale: true } });
    expectError(await rpc(h.connection, 'list_workspaces'), 503, 'workspace_not_ready');
  });

  it('preserves renderer revision conflicts as HTTP 409', async () => {
    const h = await host(); h.ready();
    const sent = h.nextRequest();
    const result = rpc(h.connection, 'apply_edit', { workspaceId: 'work', expectedRevision: 3, draftId: 'draft' });
    const request = await sent;
    ipcMain.emit('novelai:bridge:response', { sender: h.sender }, { requestId: request.requestId, error: { code: 'revision_conflict', message: 'Changed', details: { actualRevision: 4 } } });
    const response = await result;
    expectError(response, 409, 'revision_conflict');
    expect(response.body.error.details).toEqual({ actualRevision: 4 });
  });

  it('preserves renderer unavailability as HTTP 503', async () => {
    const h = await host(); h.ready();
    const sent = h.nextRequest();
    const result = rpc(h.connection, 'read_workspace', { workspaceId: 'work' });
    const request = await sent;
    ipcMain.emit('novelai:bridge:response', { sender: h.sender }, { requestId: request.requestId, error: { code: 'workspace_unavailable', message: 'No active workspace' } });
    expectError(await result, 503, 'workspace_unavailable');
  });

  it('returns timeout without retrying the operation and cleans IPC listeners on close', async () => {
    const h = await host(); h.ready();
    const sent = h.nextRequest();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = rpc(h.connection, 'apply_edit', { workspaceId: 'work', expectedRevision: 3, draftId: 'draft' });
    await sent;
    await vi.advanceTimersByTimeAsync(20_000);
    expectError(await result, 504, 'timeout');
    expect(h.sender.send).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await h.bridge.close();
    expect(ipcMain.listenerCount('novelai:bridge:ready')).toBe(0);
    expect(ipcMain.listenerCount('novelai:bridge:response')).toBe(0);
  });
});

it('passes the caller of each call to the host method and to onCall, never its arguments; a malformed caller reads as unknown', async () => {
  const runtimeDir = await temporaryRuntime();
  const host = { list_queue: vi.fn(async () => ({ batches: [] })) };
  const seen: unknown[] = [];
  const bridge = await startWorkspaceBridge(() => null, runtimeDir, host, (method, caller) => seen.push({ method, caller })); cleanup.push(() => bridge.close());
  const connection = JSON.parse(await fs.readFile(path.join(runtimeDir, connectionName), 'utf8'));
  const caller = { tool: 'list_queue', client: { name: 'claude-code', version: '2.1.112' }, callId: 'c-1' };
  expect((await rpc(connection, 'list_queue', {}, { caller })).status).toBe(200);
  expect(host.list_queue).toHaveBeenLastCalledWith({}, caller);
  expect((await rpc(connection, 'list_queue', {}, { caller: { tool: 'List Queue', client: { name: 'x\u0000' }, callId: 7 } })).status).toBe(200);
  expect(host.list_queue).toHaveBeenLastCalledWith({}, NO_CALLER);
  expect((await rpc(connection, 'list_queue', {}, { caller: { tool: 'list_queue', client: { name: 'pi' } } })).status).toBe(200);
  expect(host.list_queue).toHaveBeenLastCalledWith({}, { tool: 'list_queue', client: { name: 'pi', version: null }, callId: null });
  // An unknown method and an unauthorized request are not recorded.
  expect((await rpc(connection, 'toString', {}, { caller })).status).toBe(400);
  expect((await rpc(connection, 'list_queue', {}, { caller, headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  expect(seen).toEqual([{ method: 'list_queue', caller }, { method: 'list_queue', caller: NO_CALLER }, { method: 'list_queue', caller: { tool: 'list_queue', client: { name: 'pi', version: null }, callId: null } }]);
  expect(JSON.stringify(seen)).not.toContain('batches');
});
