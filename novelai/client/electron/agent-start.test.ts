// The app side of the automatic start (novelai/src/app-autostart.mjs): what an MCP server may safely send again after
// it started the app, and when the app is reachable. workspace_not_ready is answered before anything reaches the
// renderer and before any side effect, for every canvas method and for prepare_recipe {canvas}; and bridge.json only
// appears once its port accepts connections, so a server that sees the file never meets a refused connection.
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter(), app: {}, dialog: {}, nativeImage: {} };
});
vi.mock('axios', () => ({ default: { get: () => { throw new Error('DENY_NETWORK'); }, post: () => { throw new Error('DENY_NETWORK'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('DENY_CREDENTIAL'); }, getSettings: () => { throw new Error('DENY_PRODUCTION_SETTINGS'); } }));

import { ipcMain, type BrowserWindow } from 'electron';
import { startWorkspaceBridge } from './bridge-host';
import { startHttpBridge } from './bridge-server';
import { createCanvasRecipeCapture } from './canvas-recipe-capture';
import { runCleanups } from '../src/test-support/temp-dirs';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { try { await runCleanups(cleanup.splice(0).reverse()); } finally { ipcMain.removeAllListeners(); } });
async function runtime() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-agent-start-')); cleanup.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

function rpc(connection: { url: string; token: string }, method: string, args: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = http.request(new URL('/rpc', connection.url), { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => { try { resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.end(JSON.stringify({ method, args }));
  });
}

/** The renderer methods the canvas tools reach (bridge-server.ts METHODS without the host's own). */
const RENDERER_METHODS = ['list_workspaces', 'read_workspace', 'get_asset', 'draft_edit', 'apply_edit', 'undo_edit', 'read_prompt_review'];

describe('workspace_not_ready is a refusal before anything runs (the MCP server may send it again after starting the app)', () => {
  it('every canvas method, also a draft_edit with image references, is refused while the window is loading; nothing reaches the renderer', async () => {
    const dir = await runtime();
    const send = vi.fn();
    // A window whose renderer has not said ready yet (the first seconds after a start).
    const window = { isDestroyed: () => false, webContents: { id: 7, send, isDestroyed: () => false } } as unknown as BrowserWindow;
    const hostMethods = { list_queue: vi.fn(async () => ({ batches: [] })) };
    const bridge = await startWorkspaceBridge(() => window, dir, hostMethods); cleanup.push(() => bridge.close());
    const connection = JSON.parse(await fs.readFile(path.join(dir, 'bridge.json'), 'utf8'));
    const args: Record<string, unknown> = { workspaceId: 'w', expectedRevision: 3, assetId: 'a', mode: 't2i', draftId: 'd',
      patch: { vibeImages: [{ assetId: 'ref-1', strength: 0.5 }], inpaintMask: { assetId: 'mask' } } };
    for (const method of RENDERER_METHODS) {
      const answer = await rpc(connection, method, args);
      expect(answer.status, method).toBe(503);
      expect(answer.body, method).toMatchObject({ ok: false, error: { code: 'workspace_not_ready' } });
    }
    expect(send).not.toHaveBeenCalled();
    expect(hostMethods.list_queue).not.toHaveBeenCalled();
    // Without any window at all (closed, or not created yet): the same refusal.
    const none = await startWorkspaceBridge(() => null, await runtime(), {}); cleanup.push(() => none.close());
    for (const method of RENDERER_METHODS) await expect(none.dispatch(method, args)).rejects.toMatchObject({ code: 'workspace_not_ready' });
  });

  it('prepare_recipe {canvas}: the collection is refused first, so nothing is saved or previewed', async () => {
    const put = vi.fn(), preview = vi.fn();
    const capture = createCanvasRecipeCapture({ collect: async () => { throw Object.assign(new Error('客户端画布尚未就绪。'), { code: 'workspace_not_ready' }); }, put, preview });
    for (const previewing of [false, true]) await expect(capture({ workspaceId: 'w', expectedRevision: 1, mode: 't2i', preview: previewing })).rejects.toMatchObject({ code: 'workspace_not_ready' });
    expect(put).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
  });

  it('the renderer and the main process name workspace_not_ready only where nothing has run yet', () => {
    // Every source file that produces the code (tests aside): bridge-host.ts (window not ready) and main.ts (no bridge
    // for the canvas capture) — both before any dispatch to the renderer. The renderer itself never answers it.
    const root = path.resolve(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) { walk(file); continue; }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        if (/['"]workspace_not_ready['"]/.test(readFileSync(file, 'utf8'))) found.push(path.relative(root, file).split(path.sep).join('/'));
      }
    };
    walk(path.join(root, 'src')); walk(path.join(root, 'electron'));
    expect(found.sort()).toEqual(['electron/bridge-host.ts', 'electron/canvas-recipe-capture.ts', 'electron/main.ts']);
    const host = readFileSync(path.join(root, 'electron', 'bridge-host.ts'), 'utf8');
    // The refusal comes before the request is registered or sent.
    expect(host.indexOf("'workspace_not_ready'")).toBeLessThan(host.indexOf("win.webContents.send('novelai:bridge:request'"));
    const capture = readFileSync(path.join(root, 'electron', 'canvas-recipe-capture.ts'), 'utf8');
    expect(capture).toMatch(/RENDERER_REFUSALS = new Set\(\[[^\]]*'workspace_not_ready'/);
  });
});

describe('bridge.json appears only once the bridge accepts connections', () => {
  it('a reader that sees the file the moment it appears can connect at once', async () => {
    const dir = await runtime(), file = path.join(dir, 'bridge.json');
    let seen: { url: string; token: string } | null = null, connected: boolean | null = null;
    const watching = (async () => {
      for (const end = Date.now() + 10_000; Date.now() < end && !seen;) {
        try { seen = JSON.parse(await fs.readFile(file, 'utf8')); } catch { await new Promise(resolve => setImmediate(resolve)); }
      }
      if (!seen) return;
      const url = new URL(seen.url);
      connected = await new Promise<boolean>(resolve => { const socket = net.connect(Number(url.port), url.hostname, () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    })();
    const bridge = await startHttpBridge({ runtimeDir: dir, dispatch: async () => ({}) }); cleanup.push(() => bridge.close());
    await watching;
    expect(seen).not.toBeNull(); expect(connected).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});
