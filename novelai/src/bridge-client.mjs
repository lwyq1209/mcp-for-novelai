/**
 * Transport to the local NovelAI client bridge (HTTP on loopback, discovered from
 * <data root>/runtime/bridge.json on every call; the data root is NOVELAI_DATA_DIR or
 * <appData>/mcp-for-novelai, computed by the module the client uses, src/data-paths.mjs).
 * Shared by the MCP server (src/mcp.mjs) and the core modules; it has no MCP dependency,
 * so nothing here imports a server module.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveDataPaths } from './data-paths.mjs';

/** Credential-like key names dropped from every host result and error detail. */
export const SECRET_KEY = /^(?:.*(?:token|password|secret|credential|authorization|cookie)|api_?key|auth|settings)$/i;

export class BridgeError extends Error {
  constructor(code, message, details) { super(message); this.name = 'BridgeError'; this.code = code; this.details = details; }
}

/** Drops credential-like keys at any depth and replaces the given secret strings. */
export function sanitize(value, secrets = []) {
  if (typeof value === 'string') return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, sanitize(item, secrets)]));
}

/** Read discovery on every call, so a restarted client is found on the next explicit call. Never retry.
 * `caller` ({tool, client:{name, version}|null, callId}) names who calls; an older host ignores it. */
export function createBridgeClient({ runtimeDir = resolveDataPaths().runtime, timeoutMs = 65000, fetchImpl = fetch } = {}) {
  return { async call(method, args, signal, caller) {
    let connection;
    try { connection = JSON.parse(await readFile(resolve(runtimeDir, 'bridge.json'), 'utf8')); }
    catch { throw new BridgeError('unavailable', 'NovelAI client connection is unavailable. Start this route’s client, then read the workspace again.'); }
    let url;
    try { url = new URL(connection.url); } catch { throw new BridgeError('invalid_connection', 'The local client connection file is invalid.'); }
    if (connection.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || typeof connection.token !== 'string' || !connection.token.trim()) throw new BridgeError('invalid_connection', 'The client connection must be a local loopback URL and valid versioned credential.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const response = await fetchImpl(new URL('/rpc', url), { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args, ...(caller ? { caller } : {}) }), redirect: 'error', signal: controller.signal });
      let body;
      try { body = await response.json(); } catch { throw new BridgeError('invalid_response', 'The client returned an invalid response; mutation outcome may be unknown. Read current state before taking further action.'); }
      if (!response.ok || body?.ok !== true) {
        const error = sanitize(body?.error ?? {}, [connection.token]);
        throw new BridgeError(typeof error.code === 'string' ? error.code : `http_${response.status}`, typeof error.message === 'string' ? error.message : 'The client rejected the request.', error.details);
      }
      if (!Object.hasOwn(body, 'result')) throw new BridgeError('invalid_response', 'The client response is missing its result.');
      return sanitize(body.result, [connection.token]);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (controller.signal.aborted) throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown; read current state. Do not automatically repeat a mutation.');
      throw new BridgeError('unavailable', 'The NovelAI client disconnected or rejected transport. Read current state after reconnecting; do not automatically repeat a mutation.');
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  } };
}
