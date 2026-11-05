/**
 * Transport to the local NovelAI client bridge (HTTP on loopback, discovered from
 * <data root>/runtime/bridge.json on every call; the data root is NOVELAI_DATA_DIR or
 * <appData>/mcp-for-novelai, computed by the module the client uses, src/data-paths.mjs).
 * Shared by the MCP server (src/mcp.mjs) and the core modules; it has no MCP dependency,
 * so nothing here imports a server module.
 *
 * Every failure says whether the request can have reached a host (undeliveredReason): only a
 * missing bridge.json and a refused connection are "certainly not sent". The automatic start of
 * the app (src/app-autostart.mjs) acts on those alone; anything that may have reached the host
 * (a dropped connection after sending, a timeout, a garbled reply) is never resent.
 */
import { createHash } from 'node:crypto';
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

/**
 * Why a bridge call failed before anything reached a host: 'no_bridge' (no bridge.json: no app runs on this data
 * root) or 'refused' (bridge.json names an address where nothing listens: an app that is gone). Null for every other
 * failure, including every failure that may have reached the host. Kept off the error's enumerable fields, so it never
 * shows in a tool result.
 */
const UNDELIVERED = Symbol('novelai.bridge.undelivered');
/** The bridge.json identity a refused call used (a digest of its address and per-run secret), so a waiter can tell a new one. */
const CONNECTION = Symbol('novelai.bridge.connection');
export const UNDELIVERED_REASONS = Object.freeze(['no_bridge', 'refused']);
export function undeliveredReason(error) { return error instanceof BridgeError && UNDELIVERED_REASONS.includes(error[UNDELIVERED]) ? error[UNDELIVERED] : null; }
export function refusedConnection(error) { return error instanceof BridgeError ? error[CONNECTION] ?? null : null; }
/** A BridgeError that certainly reached no host (`reason` one of UNDELIVERED_REASONS). */
export function undeliveredError(reason, code, message, details, connection = null) {
  if (!UNDELIVERED_REASONS.includes(reason)) throw new TypeError(`Unknown undelivered reason ${reason}`);
  const error = new BridgeError(code, message, details);
  Object.defineProperty(error, UNDELIVERED, { value: reason });
  if (connection) Object.defineProperty(error, CONNECTION, { value: connection });
  return error;
}

/** Every error with a code in one failure and the errors it wraps (fetch puts the socket error in `cause`; a connect to
 * several addresses gives an AggregateError with `errors`). Wrappers without a code (fetch's TypeError) add nothing. */
function codedErrors(error, depth = 0) {
  if (!error || typeof error !== 'object' || depth > 4) return [];
  const nested = [...(Array.isArray(error.errors) ? error.errors : []), ...(error.cause !== undefined ? [error.cause] : [])];
  return [...(typeof error.code === 'string' ? [error] : []), ...nested.flatMap(item => codedErrors(item, depth + 1))];
}

/**
 * The delivery fact of one failed fetch to the bridge, the payment-safety boundary of the automatic start:
 * 'not_sent' only when the TCP connection itself was refused, so nothing of the request was written (every coded
 * error in the failure is ECONNREFUSED of a connect); 'maybe_sent' for everything else — an abort or timeout
 * (`aborted`), a reset or closed socket (ECONNRESET, EPIPE, UND_ERR_SOCKET…), a refused connect mixed with any other
 * code, an error without a code, a non-error value.
 */
export function fetchFailureDelivery(error, { aborted = false } = {}) {
  if (aborted) return 'maybe_sent';
  const errors = codedErrors(error);
  return errors.length > 0 && errors.every(item => item.code === 'ECONNREFUSED' && (item.syscall === undefined || item.syscall === 'connect')) ? 'not_sent' : 'maybe_sent';
}

/** The digest that identifies one bridge.json (address and per-run secret), or null when there is no valid one. */
export function connectionFingerprint(connection) {
  if (!connection || typeof connection !== 'object' || typeof connection.url !== 'string' || typeof connection.token !== 'string') return null;
  return createHash('sha256').update(`${connection.url}\n${connection.token}`).digest('hex');
}

/** The fingerprint of the bridge.json in `runtimeDir` now, or null when there is none (or it is not a valid file). */
export async function readBridgeFingerprint(runtimeDir = resolveDataPaths().runtime) {
  try { return connectionFingerprint(JSON.parse(await readFile(resolve(runtimeDir, 'bridge.json'), 'utf8'))); }
  catch { return null; }
}

const NOT_RUNNING = 'The NovelAI app is not running for this data folder (no connection file). Nothing was sent.';
const GONE = 'The NovelAI app that wrote the connection file is not running any more (the connection was refused). Nothing was sent.';

/** Read discovery on every call, so a restarted client is found on the next explicit call. Never retry.
 * `caller` ({tool, client:{name, version}|null, callId}) names who calls; an older host ignores it. */
export function createBridgeClient({ runtimeDir = resolveDataPaths().runtime, timeoutMs = 65000, fetchImpl = fetch } = {}) {
  return { async call(method, args, signal, caller) {
    let connection;
    try { connection = JSON.parse(await readFile(resolve(runtimeDir, 'bridge.json'), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') throw undeliveredError('no_bridge', 'unavailable', NOT_RUNNING);
      throw new BridgeError('unavailable', 'The NovelAI client connection file cannot be read. Nothing was sent. Restart the app; it writes a new one.');
    }
    let url;
    try { url = new URL(connection.url); } catch { throw new BridgeError('invalid_connection', 'The local client connection file is invalid.'); }
    if (connection.schemaVersion !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash || typeof connection.token !== 'string' || !connection.token.trim()) throw new BridgeError('invalid_connection', 'The client connection must be a local loopback URL and valid versioned credential.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      let response;
      try { response = await fetchImpl(new URL('/rpc', url), { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args, ...(caller ? { caller } : {}) }), redirect: 'error', signal: controller.signal }); }
      catch (error) {
        if (fetchFailureDelivery(error, { aborted: controller.signal.aborted }) === 'not_sent') throw undeliveredError('refused', 'unavailable', GONE, undefined, connectionFingerprint(connection));
        throw error;
      }
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
