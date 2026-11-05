import { ipcMain, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { BridgeError, startHttpBridge, type BridgeCaller } from './bridge-server';

/** hostMethods receive the bridge caller (who called, never arguments) as their second argument. */
export async function startWorkspaceBridge(getWindow: () => BrowserWindow | null, runtimeDir: string, hostMethods: Record<string, (args: Record<string, unknown>, caller?: BridgeCaller) => Promise<any>> = {}, onCall?: (method: string, caller: BridgeCaller) => void) {
  let readyId: number | null = null;
  let readyWorkspaceId: string | null = null;
  const watched = new Set<number>();
  const pending = new Map<string, { senderId: number; resolve: (result: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  const invalidate = (senderId: number) => {
    if (readyId === senderId) { readyId = null; readyWorkspaceId = null; }
    for (const [id, item] of pending) if (item.senderId === senderId) {
      clearTimeout(item.timer); pending.delete(id); item.reject(new BridgeError('workspace_unavailable', '画布已断开或重新加载，请重新读取。', 503));
    }
  };
  const onReady = (event: Electron.IpcMainEvent, payload?: {workspaceId?: string}) => {
    const win = getWindow();
    if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id) return;
    readyId = event.sender.id;
    readyWorkspaceId = typeof payload?.workspaceId === "string" ? payload.workspaceId : null;
    if (!watched.has(readyId)) {
      watched.add(readyId);
      const id = readyId;
      event.sender.on('did-start-loading', () => invalidate(id));
      event.sender.on('render-process-gone', () => invalidate(id));
      event.sender.on('destroyed', () => invalidate(id));
    }
  };
  const onResponse = (event: Electron.IpcMainEvent, response: any) => {
    const item = pending.get(response?.requestId);
    if (!item || item.senderId !== event.sender.id) return;
    pending.delete(response.requestId); clearTimeout(item.timer);
    if (response.error) {
      const code = response.error.code ?? 'client_error';
      const status = /conflict|stale|revision/.test(code) ? 409 : /unavailable|not_ready/.test(code) ? 503 : /timeout/.test(code) ? 504 : 400;
      item.reject(new BridgeError(code, response.error.message ?? '客户端操作失败。', status, response.error.details));
    }
    else item.resolve(response.result);
  };
  ipcMain.on('novelai:bridge:ready', onReady);
  ipcMain.on('novelai:bridge:response', onResponse);
  let bridge: Awaited<ReturnType<typeof startHttpBridge>>;
  const dispatch = (method: string, args: Record<string, unknown>, caller?: BridgeCaller): Promise<any> => {
    // Explicit host methods remain available before renderer ready and after window closure.
    if (Object.hasOwn(hostMethods, method)) return Promise.resolve().then(() => hostMethods[method](args, caller));
    const win = getWindow();
    if (!win || win.isDestroyed() || readyId !== win.webContents.id) return Promise.reject(new BridgeError('workspace_not_ready', '客户端画布尚未就绪。', 503));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new BridgeError('timeout', '客户端响应超时；请回读确认，不要自动重复提交。', 504)); }, 20_000);
      pending.set(requestId, { senderId: win.webContents.id, resolve, reject, timer });
      win.webContents.send('novelai:bridge:request', { requestId, method, args });
    });
  };
  try { bridge = await startHttpBridge({ runtimeDir, dispatch, onCall }); } catch (error) {
    ipcMain.off('novelai:bridge:ready', onReady); ipcMain.off('novelai:bridge:response', onResponse);
    throw error;
  }
  return { dispatch, call: bridge.call, isCurrentWorkspace: (id: string) => readyId !== null && readyWorkspaceId === id, async close() {
    ipcMain.off('novelai:bridge:ready', onReady); ipcMain.off('novelai:bridge:response', onResponse);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new BridgeError('workspace_unavailable', '客户端已关闭。', 503)); }
    pending.clear(); await bridge.close();
  } };
}
