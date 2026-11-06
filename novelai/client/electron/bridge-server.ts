import http from 'node:http';
import { validateLibraryRequest } from './library/validation';
import fs from 'node:fs/promises';
import { readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { renameReplace } from './platform-fs';
import { plainClientText } from '../src/agent-clients';

type Args = Record<string, unknown>;
/**
 * Who made a bridge call, as the MCP server names it in the request body (`caller`): the MCP tool, the MCP client's
 * initialize clientInfo name and version, and one id per tool call. Never any argument. An MCP server that sends no
 * caller (an older one) gives {tool:null, client:null, callId:null}; an in-process call has no caller at all.
 */
export interface BridgeCaller { tool: string | null; client: { name: string; version: string | null } | null; callId: string | null }
type Dispatch = (method: string, args: Args, caller?: BridgeCaller) => Promise<any>;
// Invisible format characters (bidirectional controls, zero-width) are removed: names are shown as plain text.
const callerText = (value: unknown, max: number) => plainClientText(value, max);
/** The caller of an HTTP bridge request; anything malformed reads as unknown (null), never as a refusal. */
export function parseBridgeCaller(raw: unknown): BridgeCaller {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const client = value.client && typeof value.client === 'object' && !Array.isArray(value.client) ? value.client as Record<string, unknown> : null;
  const name = client ? callerText(client.name, 100) : null;
  const tool = callerText(value.tool, 80);
  return { tool: tool && /^[a-z][a-z0-9_]*$/.test(tool) ? tool : null, client: name ? { name, version: callerText(client!.version, 50) } : null, callId: callerText(value.callId, 64) };
}
// Canvas methods the MCP canvas tools reach. The canvas generation methods (submit_generation, submit_batch, their
// job and batch reads and controls) were retired on 2026-11-02; canvas images go through capture_canvas_recipe.
const METHODS = new Set(['list_workspaces', 'read_workspace', 'get_asset', 'draft_edit', 'apply_edit', 'undo_edit']);
const MAX_BODY = 64 * 1024 * 1024;
METHODS.add('read_prompt_review');
for (const method of ['material_library', 'material_tags', 'material_samples', 'material_studies', 'asset_library']) METHODS.add(method);
for (const method of ['capture_canvas_recipe', 'put_queue_recipe', 'read_queue_recipe', 'preview_queue_recipe', 'enqueue_queue_recipes', 'lookup_queue_request', 'list_queue', 'read_queue', 'pause_queue', 'resume_queue', 'cancel_queue', 'get_queue_result']) METHODS.add(method);
const MAX_IMAGE = 20 * 1024 * 1024;

export class BridgeError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); }
}

function imageType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  return undefined;
}

async function materializeAsset(asset: any) {
  if (!asset || typeof asset !== 'object') throw new BridgeError('invalid_asset', '图片资源缺失。');
  let bytes: Buffer;
  if (typeof asset.data === 'string') {
    if (asset.data.length > MAX_IMAGE * 1.4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)) throw new BridgeError('invalid_asset', '图片编码无效或过大。');
    bytes = Buffer.from(asset.data, 'base64');
  } else if (typeof asset.path === 'string' && path.isAbsolute(asset.path)) {
    const stat = await fs.stat(asset.path);
    if (!stat.isFile() || stat.size > MAX_IMAGE) throw new BridgeError('invalid_asset', '图片文件无效或过大。');
    bytes = await fs.readFile(asset.path);
  } else throw new BridgeError('invalid_asset', '图片没有可读取的数据。');
  const mimeType = imageType(bytes);
  if (!mimeType || bytes.length > MAX_IMAGE) throw new BridgeError('invalid_asset', '仅支持 PNG、JPEG、WebP 和 GIF 图片。');
  return { ...asset, path: undefined, mimeType, data: bytes.toString('base64') };
}

async function readBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BridgeError('too_large', '请求超过 64 MiB。', 413);
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('invalid_json', '请求必须是合法 JSON。'); }
}

export async function startHttpBridge(options: { runtimeDir: string; dispatch: Dispatch; /** Every authenticated call of a known method, before it runs (recent agent calls; never its arguments). */ onCall?: (method: string, caller: BridgeCaller) => void }) {
  const runtimeDir = path.resolve(options.runtimeDir);
  await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let address = '';
  let closed = false;

  const call = async (method: string, args: Args, caller?: BridgeCaller) => {
    if (closed) throw new BridgeError('workspace_unavailable', '作品服务已关闭。', 503);
    if (method === 'asset_library') {
      validateLibraryRequest('asset_library', args);
      const { detail: _detail, ...hostArgs } = args;
      return options.dispatch(method, args.action === 'list' ? { ...hostArgs, limit: args.limit ?? 10 } : hostArgs, caller);
    }
    if (method === 'get_queue_result') {
      const result = await materializeAsset(await options.dispatch(method, args, caller));
      // A queue result also names its saved file (issue #1); the MCP server never passes the absolute path on.
      // variant thumbnail (2026-12): the preview's size, the original's as sourceWidth/sourceHeight.
      const keys = ['workspaceId', 'jobId', 'index', 'mimeType', 'data', 'width', 'height', 'model', 'actualSeed', 'originWorkspaceId', 'submittedRevision', 'historyId', 'createdAt', 'providerRequestId', 'fileName', 'filePath', 'variant', 'sourceWidth', 'sourceHeight'];
      return Object.fromEntries(keys.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
    }
    if (method === 'get_asset') return materializeAsset(await options.dispatch(method, args));
    if (method === 'draft_edit' && args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) {
      const patch = structuredClone(args.patch) as Args;
      const readAsset = async (assetId: unknown) => {
        if (typeof assetId !== 'string' || !assetId) throw new BridgeError('invalid_asset', '素材 ID 无效。');
        return materializeAsset(await options.dispatch('get_asset', { workspaceId: args.workspaceId, expectedRevision: args.expectedRevision, assetId }, caller));
      };
      for (const role of ['vibeImages', 'preciseReferences']) {
        if (!Array.isArray(patch[role])) continue;
        const refs = patch[role] as any[];
        for (let index = 0; index < refs.length; index++) {
          const ref = refs[index];
          if (!ref || typeof ref !== 'object' || !Object.hasOwn(ref, 'assetId')) continue;
          if (Object.hasOwn(ref, 'base64')) throw new BridgeError('invalid_asset', '参考只可指定 assetId 或 base64 其中一种。');
          const { assetId, ...fields } = ref;
          refs[index] = { ...fields, base64: (await readAsset(assetId)).data };
        }
      }
      if (patch.inpaintMask && typeof patch.inpaintMask === 'object') {
        const ref = patch.inpaintMask as Args;
        if (Object.keys(ref).length !== 1 || !Object.hasOwn(ref, 'assetId')) throw new BridgeError('invalid_asset', 'Mask 素材引用必须仅包含 assetId。');
        patch.inpaintMask = (await readAsset(ref.assetId)).data;
      }
      return options.dispatch(method, { ...args, patch }, caller);
    }
    return options.dispatch(method, args, caller);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.headers.origin !== undefined || req.headers.host !== address || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) throw new BridgeError('forbidden_origin', '仅接受本机桥接连接。', 403);
      const supplied = Buffer.from(req.headers.authorization ?? '');
      if (supplied.length !== expectedAuth.length || !timingSafeEqual(supplied, expectedAuth)) throw new BridgeError('unauthorized', '桥接认证失败。', 401);
      if (req.method !== 'POST' || req.url !== '/rpc') throw new BridgeError('not_found', '接口不存在。', 404);
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('invalid_content_type', '请求须使用 application/json。', 415);
      const body = await readBody(req);
      if (!body || typeof body.method !== 'string' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new BridgeError('invalid_request', '请求格式无效；需要方法名和参数对象。');
      if (!METHODS.has(body.method)) throw new BridgeError('unsupported_method', '当前客户端未支持此操作。请正常重开客户端加载当前版本后再试；这不是填写参数错误，不要反复简化参数或自动重试。');
      const caller = parseBridgeCaller(body.caller);
      try { options.onCall?.(body.method, caller); } catch { /* Recording a call never affects it. */ }
      const result = await call(body.method, body.args, caller);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error: any) {
      const code = typeof error?.code === 'string' && !/^(E[A-Z]+)$/.test(error.code) ? error.code : 'bridge_error';
      const status = error?.status ?? (/(conflict|stale|revision)/i.test(code) ? 409 : /(unavailable|not_ready)/i.test(code) ? 503 : 400);
      res.statusCode = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
      res.end(JSON.stringify({ ok: false, error: { code, message: code === 'bridge_error' ? '桥接操作未完成。' : String(error.message), ...(error.details === undefined ? {} : { details: error.details }) } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const port = (server.address() as import('node:net').AddressInfo).port;
  address = `127.0.0.1:${port}`;
  const connection = { schemaVersion: 1, url: `http://${address}`, token, pid: process.pid };
  const connectionFile = path.join(runtimeDir, 'bridge.json');
  const temporary = path.join(runtimeDir, `bridge-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, JSON.stringify(connection), { mode: 0o600, flag: 'wx' });
    await renameReplace(temporary, connectionFile);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    connection,
    // In-process use by the main process.
    call,
    async close() {
      if (closed) return;
      closed = true;
      // Remove our own connection file synchronously, before the first await: the quit path
      // (main.ts before-quit) cannot await this promise and the process may exit right after,
      // which used to leave a stale bridge.json behind. A replacement file is left alone.
      const removeOwn = () => { try { if (JSON.parse(readFileSync(connectionFile, 'utf8')).token === token) unlinkSync(connectionFile); } catch { /* already removed or replaced */ } };
      removeOwn();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      // Second attempt when a reader without delete sharing blocked the first one.
      removeOwn();
    },
  };
}
