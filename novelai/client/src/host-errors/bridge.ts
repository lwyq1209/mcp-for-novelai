/**
 * Host errors across contextBridge (step 4b1 review rework). Electron copies an Error from the preload world into the
 * window as a new Error with its message only: code, reason, params and details are dropped (measured on Electron 42:
 * Object.keys of the copy is empty; name, cause and stack do not carry them either). The preload therefore writes an
 * error's structure into its message, after the readable text, as an invisible suffix (format characters, rendered
 * with no width), and the window reads it back in one place: readHostError. Everything that reads an error's code,
 * reason, params or details, or shows its message, goes through readHostError, so the catalog (host-errors) works
 * for thrown host errors as it does for returned ones, and a message shown anywhere else still reads as before.
 *
 * The suffix is MARK followed by the UTF-8 bytes of {v:1, k, code?, reason?, params?, details?} in base 4, one format
 * character per digit. A message without a well-formed suffix is used as it is (no structure).
 *
 * Only the preload writes a suffix (the main process never does), and only for an error's own fields (step 4b2, P3 of
 * the 4b1 review): a suffix already in a message — text from upstream, an agent or a file that imitates one — is
 * removed at the preload, never merged. k is a random key of this launch that the preload makes and gives the window
 * (naiDesktop.hostErrorKey); the window decodes a suffix only with that key, so text it builds itself, a returned
 * object or a string that carries an imitated suffix never gains code, reason or params from it.
 */

export interface HostErrorShape { message: string; code?: string; reason?: string; params?: Record<string, unknown>; details?: Record<string, unknown> }
type Fields = Omit<HostErrorShape, 'message'>;

/** Invisible separator, invisible plus, invisible separator: starts the suffix. */
export const HOST_ERROR_MARK = '\u2063\u2064\u2063';
/** Zero width space, non-joiner, joiner, word joiner: the base-4 digits 0–3. */
const DIGITS = ['\u200b', '\u200c', '\u200d', '\u2060'] as const;
const DIGIT_VALUE = new Map<string, number>(DIGITS.map((digit, index) => [digit, index]));
/** The suffix stays small: a larger structure drops details, then shortens params, then drops params. */
const MAX_PAYLOAD_BYTES = 8 * 1024;
const CODE = /^[a-z][a-z0-9_]{0,79}$/;
const REASON = /^[a-z][a-z0-9_.]{0,79}$/;

/** The key of this launch (32 hex digits). In the window it is the preload's (naiDesktop.hostErrorKey); in the preload,
 * and wherever no preload key is exposed (tests), this module makes its own once. */
const KEY = /^[0-9a-f]{32}$/;
let launchKey: string | undefined;
function exposedKey(): string | undefined {
  try { const value = (globalThis as { naiDesktop?: { hostErrorKey?: unknown } }).naiDesktop?.hostErrorKey; return typeof value === 'string' && KEY.test(value) ? value : undefined; } catch { return undefined; }
}
function randomKey(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
/** The launch key: the preload exposes it to the window as naiDesktop.hostErrorKey. */
export function hostErrorBridgeKey(): string {
  launchKey ??= exposedKey() ?? randomKey();
  return launchKey;
}

const plainObject = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try { return JSON.parse(JSON.stringify(value)) as Record<string, unknown>; } catch { return undefined; }
};
const read = (value: unknown, key: string): unknown => { try { return value && (typeof value === 'object' || typeof value === 'function') ? (value as Record<string, unknown>)[key] : undefined; } catch { return undefined; } };
const fieldsOf = (value: unknown): Fields => {
  const code = read(value, 'code'), reason = read(value, 'reason'), params = plainObject(read(value, 'params')), details = plainObject(read(value, 'details'));
  return {
    ...(typeof code === 'string' && CODE.test(code) ? { code } : {}),
    ...(typeof reason === 'string' && REASON.test(reason) ? { reason } : {}),
    ...(params ? { params } : {}),
    ...(details ? { details } : {}),
  };
};
const hasFields = (fields: Fields) => Object.keys(fields).length > 0;

function encodePayload(fields: Fields, key: string): string {
  const encoder = new TextEncoder();
  const shortened = (params: Record<string, unknown>) => Object.fromEntries(Object.entries(params).map(([name, value]) => [name, typeof value === 'string' ? value.slice(0, 200) : value]));
  const attempts: Fields[] = [fields, { ...fields, details: undefined }, { ...fields, details: undefined, params: fields.params && shortened(fields.params) }, { code: fields.code, reason: fields.reason }];
  let bytes = encoder.encode('{}');
  for (const attempt of attempts) {
    bytes = encoder.encode(JSON.stringify({ v: 1, k: key, ...attempt }));
    if (bytes.length <= MAX_PAYLOAD_BYTES) break;
  }
  let out = '';
  for (const byte of bytes) out += DIGITS[(byte >> 6) & 3] + DIGITS[(byte >> 4) & 3] + DIGITS[(byte >> 2) & 3] + DIGITS[byte & 3];
  return out;
}

function decodePayload(text: string): Fields | null {
  if (!text.length || text.length % 4) return null;
  const bytes = new Uint8Array(text.length / 4);
  for (let index = 0; index < text.length; index += 4) {
    let byte = 0;
    for (let offset = 0; offset < 4; offset++) { const digit = DIGIT_VALUE.get(text[index + offset]); if (digit === undefined) return null; byte = (byte << 2) | digit; }
    bytes[index / 4] = byte;
  }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    // Only a suffix the preload wrote this launch: an imitation (no key, another key) is not structure.
    return value && typeof value === 'object' && value.v === 1 && value.k === hostErrorBridgeKey() ? fieldsOf(value) : null;
  } catch { return null; }
}

/** Our mark followed by base-4 digits, anywhere in a text (a message, a stack, a string built from one). */
const SUFFIX_RUN = new RegExp(`${HOST_ERROR_MARK}[${DIGITS.join('')}]*`, 'g');
/**
 * The text without any of our suffixes (well formed or not, at the end or inside, e.g. in a stack). Everything the
 * window shows, copies or sends back to the host goes through this or readHostError: the structure is for the window
 * only and never leaves it (step 4a: reason/params do not travel over the bridge to MCP).
 */
export function stripHostErrorSuffixes(text: string): string {
  return text.includes(HOST_ERROR_MARK) ? text.replace(SUFFIX_RUN, '') : text;
}

const isPlain = (value: object) => { const proto = Object.getPrototypeOf(value); return Array.isArray(value) || proto === Object.prototype || proto === null; };
/**
 * A copy of a plain value (objects, arrays, strings; nested) with every suffix removed from its strings; parts
 * without one are returned as they are (no copy). Other objects (typed arrays, Files, functions) pass unchanged.
 */
export function scrubHostErrorSuffixes<T>(value: T, depth = 0, done: Map<object, unknown> = new Map()): T {
  if (typeof value === 'string') return stripHostErrorSuffixes(value) as T;
  if (!value || typeof value !== 'object' || depth > 64 || !isPlain(value)) return value;
  // A part met twice (shared, or a cycle) gets the same result; a cycle in progress is left as it is.
  if (done.has(value)) return (done.get(value) ?? value) as T;
  done.set(value, undefined);
  let out: Record<string, unknown> | unknown[] | null = null;
  if (Array.isArray(value)) {
    value.forEach((item, index) => { const next = scrubHostErrorSuffixes(item, depth + 1, done); if (next !== item) { out ??= value.slice(); (out as unknown[])[index] = next; } });
  } else {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const next = scrubHostErrorSuffixes(item, depth + 1, done);
      if (next !== item) { out ??= { ...(value as Record<string, unknown>) }; (out as Record<string, unknown>)[key] = next; }
    }
  }
  done.set(value, out ?? value);
  return (out ?? value) as T;
}

/**
 * The plain text of a caught error for display or for a reply: an Error's message (and a string) without suffix;
 * anything else gives the fallback, or its String() without suffix when there is no fallback.
 */
export function plainErrorMessage(error: unknown, fallback?: string): string {
  if (error instanceof Error) return readHostError(error).message;
  if (typeof error === 'string') return stripHostErrorSuffixes(error);
  return fallback ?? stripHostErrorSuffixes(String(error));
}

/**
 * The message with an error's structure written into its invisible suffix. Any suffix already in the message is
 * removed first, never merged. key: the launch key (tests pass another one to imitate a forged suffix).
 */
export function encodeHostErrorMessage(message: string, fields: Fields, key: string = hostErrorBridgeKey()): string {
  const clean = stripHostErrorSuffixes(message);
  const checked = fieldsOf(fields);
  return hasFields(checked) ? `${clean}${HOST_ERROR_MARK}${encodePayload(checked, key)}` : clean;
}

/** The readable message and the structure of its suffix (null when it has no well-formed suffix). */
export function decodeHostErrorMessage(message: string): { message: string; fields: Fields | null } {
  const at = message.lastIndexOf(HOST_ERROR_MARK);
  if (at < 0) return { message, fields: null };
  const fields = decodePayload(message.slice(at + HOST_ERROR_MARK.length));
  return fields ? { message: message.slice(0, at), fields } : { message, fields: null };
}

/**
 * The one way the window reads a host error (or a host result with code/reason/params): its own fields first (an
 * error made in the window, a returned object), then the structure in its message's suffix; the message without the
 * suffix. Anything unreadable gives an empty message and no fields.
 */
export function readHostError(value: unknown): HostErrorShape {
  // The message never keeps a suffix, also a damaged one (it is then only without structure).
  if (typeof value === 'string') { const decoded = decodeHostErrorMessage(value); return { ...(decoded.fields ?? {}), message: stripHostErrorSuffixes(decoded.message) }; }
  const raw = read(value, 'message');
  const decoded = typeof raw === 'string' ? decodeHostErrorMessage(raw) : { message: '', fields: null };
  return { ...(decoded.fields ?? {}), ...fieldsOf(value), message: stripHostErrorSuffixes(decoded.message) };
}

/**
 * Preload: the error to throw into the window, with its own structure in the message (other values cross as they
 * are). A suffix already in the message is removed and never read (the main process never writes one).
 */
export function bridgeSafeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const fields = fieldsOf(error);
  const message = stripHostErrorSuffixes(error.message);
  if (!hasFields(fields) && message === error.message) return error;
  const copy = new Error(hasFields(fields) ? encodeHostErrorMessage(message, fields) : message);
  copy.name = error.name;
  return copy;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> => !!value && typeof (value as { then?: unknown }).then === 'function';
/**
 * Preload: every function of the API the window gets, with its errors (thrown, or a rejected promise) passed through
 * bridgeSafeError, and with what the window sends to the host (its arguments: a workspace reply to the bridge, a
 * request) scrubbed of suffixes, so error structure meant for the window never reaches the host, the bridge or MCP.
 * Values that are not functions, and what the functions return, are unchanged.
 */
export function bridgeSafeApi<T extends Record<string, unknown>>(api: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(api)) {
    if (typeof value !== 'function') { out[key] = value; continue; }
    const fn = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]) => {
      let result: unknown;
      try { result = fn(...args.map(arg => scrubHostErrorSuffixes(arg))); } catch (error) { throw bridgeSafeError(error); }
      return isThenable(result) ? Promise.resolve(result).catch(error => { throw bridgeSafeError(error); }) : result;
    };
  }
  return out as T;
}
