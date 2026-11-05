/**
 * Wrapper-layer guards for the NovelAI MCP server (src/mcp.mjs). The bridge guard
 * and the scrubbing apply to every tool; the inbox/export checks apply to the
 * material and study tools.
 *
 * The cores (src/material-tools.mjs, src/study-tools.mjs) stay authoritative
 * and unchanged; these checks run before a request is handed to them:
 * - directories are normalized with resolve(), because the project defaults end
 *   with a separator and lstat('link/') follows the link, silently disabling the
 *   cores' "inbox/exports cannot be a symlink" checks;
 * - inbox files are lstat-preflighted so only one ordinary single-link file is
 *   accepted (no symlink, hard link, FIFO, device, socket or directory);
 * - error text is scrubbed of absolute paths and explicit key/value credentials
 *   (also `message` fields inside host success payloads; identity fields such as
 *   requestKey are never rewritten), and unrecognized bridge failures are
 *   reduced to an opaque internal error;
 * - a study manifest listing more than 20 files is refused before any lstat;
 * - export/report paths inside the project are returned project-relative.
 * A race between this preflight and the core's own open remains possible for a
 * local process that can write the inbox concurrently; the cores keep their
 * O_NOFOLLOW/O_NONBLOCK and type checks where they have them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstat } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BridgeError } from './bridge-client.mjs';
import { openNoFollow } from './platform-fs.mjs';
import { MATERIAL_EXPORTS, MATERIAL_INBOX } from './material-tools.mjs';
import { STUDY_EXPORTS, STUDY_INBOX } from './study-tools.mjs';
import { resolveProjectRoot } from './data-paths.mjs';

const projectRoot = resolveProjectRoot();
/**
 * The project root that the inbox/export folders (novelai/library-inbox and friends) and every
 * project-relative path are based on: NOVELAI_PROJECT_ROOT when set, else <data root>/workspace.
 * PROJECT_ROOT_SOURCE names which ('NOVELAI_PROJECT_ROOT' or 'data-dir-workspace'); results with
 * pathBase:'project-root' carry it as projectRoot, never the absolute path.
 */
export const PROJECT_ROOT = projectRoot.root;
export const PROJECT_ROOT_SOURCE = projectRoot.source;
const MANIFEST_LIMIT = 1024 * 1024;

/** resolve() drops the trailing separator carried by the default constants. */
export function resolveBusinessDirectories({ materialInbox = MATERIAL_INBOX, materialExports = MATERIAL_EXPORTS, studyInbox = STUDY_INBOX, studyExports = STUDY_EXPORTS } = {}) {
  return { materialInbox: resolve(materialInbox), materialExports: resolve(materialExports), studyInbox: resolve(studyInbox), studyExports: resolve(studyExports) };
}

export class InboxInputError extends Error {
  constructor(message) { super(message); this.name = 'InboxInputError'; this.code = 'invalid_input'; }
}

/** Raised in place of any non-BridgeError thrown by a bridge client; its outcome is unknown. */
export class HostCallError extends Error {
  constructor() { super('The host call failed with an unrecognized error.'); this.name = 'HostCallError'; }
}

/** Raised (before anything is sent) when a tool reaches a host method outside its fixed hostMethods. */
export class HostMethodNotAllowedError extends Error {
  constructor(method) { super(`Host method ${method} is outside this tool's fixed list.`); this.name = 'HostMethodNotAllowedError'; this.code = 'host_method_not_allowed'; this.method = method; }
}
/** Raised (before anything is sent) for a host call made outside any tool call. */
export class HostCallOutsideToolError extends Error {
  constructor(method) { super(`Host method ${method} was called outside a tool call; nothing was sent.`); this.name = 'HostCallOutsideToolError'; this.code = 'host_call_outside_tool'; this.method = method; }
}
/** Printable text of 1–max characters, else null. */
/** Bidirectional controls, zero-width and other invisible format characters (removed: a client name is plain text). */
const INVISIBLE_FORMAT_CHARACTERS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
const boundedText = (value, max) => {
  if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  const text = value.replace(INVISIBLE_FORMAT_CHARACTERS, '').trim();
  return text && text.length <= max ? text : null;
};
/**
 * The calling client as the host records it: the name and version the MCP client sent in initialize (clientInfo),
 * or null when it sent no usable name. Nothing else of clientInfo is passed on.
 */
export function callerClient(info) {
  const name = boundedText(info?.name, 100);
  return name ? { name, version: boundedText(info?.version, 50) } : null;
}
/**
 * The tool call in progress: {tool, allowed: Set of host methods, denied: [], client, callId}. src/mcp-registry.mjs runs every
 * handler inside it; it follows the call through awaits (and timers started from it), so it also covers modules
 * created once per server (the recipe queue) that hold this same guarded bridge.
 */
export const hostCallScope = new AsyncLocalStorage();

/**
 * History-image reads (asset_library {action:"image"}) this guard lets run at the same time. The host's asset-library
 * reader (client/electron/asset-library-image.ts HISTORY_IMAGE_LIMITS.active) takes two at once and refuses a third
 * with image_busy instead of queueing it, so the guard queues the rest here. That covers every MCP path that reads a
 * history image: recipe source metadata and alpha layers (src/recipe-sources.mjs), asset_library {action:"image"} and
 * set_cover_from_history (src/history-cover.mjs). Other processes (another agent session) can still meet
 * image_busy. So can this one right after one of its reads was cancelled or timed out: the gate frees that slot at
 * once, while the host may still be reading.
 */
export const HISTORY_IMAGE_READ_SLOTS = 2;
export const isHistoryImageRead = (method, args) => method === 'asset_library' && args !== null && typeof args === 'object' && args.action === 'image';
const cancelledBeforeSending = () => new BridgeError('aborted', 'The request was cancelled while it waited for a history-image read slot; nothing was sent to the host.');

/**
 * A FIFO of at most `limit` concurrent tasks. Waiting is never an error and never a retry: a queued task waits for a
 * slot. A task whose signal aborts while it waits leaves the queue and is never run; one whose signal is already
 * aborted when its slot comes up is not run either (both reject with BridgeError aborted).
 */
export function createSlotGate(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('The slot limit must be a positive integer.');
  let active = 0;
  const waiting = [];
  // A finished task hands its slot straight to the next waiter, so a newcomer cannot overtake the queue.
  const release = () => { const next = waiting.shift(); if (next) next.grant(); else active--; };
  const acquire = signal => {
    if (signal?.aborted) return Promise.reject(cancelledBeforeSending());
    if (active < limit && !waiting.length) { active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const onAbort = () => { const index = waiting.indexOf(waiter); if (index >= 0) waiting.splice(index, 1); reject(cancelledBeforeSending()); };
      const waiter = { grant: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting.push(waiter);
    });
  };
  return {
    async run(signal, task) {
      await acquire(signal);
      try {
        if (signal?.aborted) throw cancelledBeforeSending();
        return await task();
      } finally { release(); }
    },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

/**
 * Keeps BridgeError facts, hides everything else. Carries no code, so cores treat it as an unknown outcome.
 * Inside a tool call it also enforces that tool's hostMethods: anything else is refused before it is sent.
 * Outside any tool call nothing is sent at all (the server never calls the host on its own).
 * History-image reads pass a slot gate of HISTORY_IMAGE_READ_SLOTS (one gate per guarded bridge; the server builds
 * one guarded bridge, and the stdio entry point runs one server per process).
 * `allowOutsideToolCalls` exists ONLY for tests that drive a core module directly with this guard; the server
 * (src/mcp.mjs) never passes it.
 */
export function guardBridge(bridgeClient, { allowOutsideToolCalls = false } = {}) {
  const imageReads = createSlotGate(HISTORY_IMAGE_READ_SLOTS);
  const forward = async (method, args, signal, caller) => {
    // The caller goes as a fourth argument only when there is one, so a three-argument client sees no change.
    try { return await bridgeClient.call(...[method, args, signal, ...(caller ? [caller] : [])]); }
    catch (error) { if (error instanceof BridgeError) throw error; throw new HostCallError(); }
  };
  return { async call(method, args, signal) {
    const scope = hostCallScope.getStore();
    if (!scope && !allowOutsideToolCalls) throw new HostCallOutsideToolError(method);
    if (scope && !scope.allowed.has(method)) { scope.denied.push(method); throw new HostMethodNotAllowedError(method); }
    // Who is calling (client, tool, call id), never the arguments; the host records it and names queued batches by it.
    const caller = scope?.tool ? { tool: scope.tool, client: scope.client ?? null, ...(scope.callId ? { callId: scope.callId } : {}) } : undefined;
    if (isHistoryImageRead(method, args)) return imageReads.run(signal, () => forward(method, args, signal, caller));
    return forward(method, args, signal, caller);
  } };
}

const directName = name => typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\\/\x00]/.test(name) && name !== '.' && name !== '..';

async function entryKind(path) {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

/** A referenced inbox must be a real directory. A missing one is left to the core to report. */
export async function assertRealDirectory(directory, label) {
  const kind = await entryKind(directory);
  if (kind === 'symlink' || kind === 'other') throw new InboxInputError(`${label} must be a real directory, not a symlink; nothing was read or sent to the host.`);
}

/**
 * Only one ordinary single-link file directly in the inbox passes. Non-direct
 * names and missing files are left to the core, which rejects or reports them
 * without touching anything outside the inbox.
 */
export async function assertInboxFile(directory, name, label) {
  if (!directName(name)) return;
  let stat;
  try { stat = await lstat(join(directory, name)); }
  catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.nlink !== 1) throw new InboxInputError(`Inbox file ${JSON.stringify(name)} must be one ordinary file directly in ${label}; symlinks, hard links, FIFOs, devices, sockets and directories are refused. Nothing was sent to the host.`);
}

/** Same 1–20 file limit as the study import core, applied before any per-file lstat. */
export const STUDY_IMPORT_LIMIT = 20;

/**
 * Bounded, non-blocking, no-follow read of a study manifest, used only to
 * preflight the image names it lists. A manifest listing more than
 * STUDY_IMPORT_LIMIT entries is refused here, before a single listed name is
 * lstat-ed. Unreadable or malformed manifests yield no names; the core re-reads
 * and validates them.
 */
export async function manifestFileNames(directory, name) {
  if (!directName(name)) return [];
  let files;
  let handle;
  try {
    handle = await openNoFollow(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MANIFEST_LIMIT) return [];
    const buffer = Buffer.alloc(MANIFEST_LIMIT + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > MANIFEST_LIMIT) return [];
    const value = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    files = Array.isArray(value?.files) ? value.files : [];
  } catch { return []; }
  finally { await handle?.close().catch(() => {}); }
  if (files.length > STUDY_IMPORT_LIMIT) throw new InboxInputError(`The study manifest lists ${files.length} files; import takes 1–${STUDY_IMPORT_LIMIT}. Nothing was checked, read or sent to the host.`);
  return files.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? item.file : undefined).filter(file => typeof file === 'string');
}

/**
 * The project root as given and as its real path. A root that does not exist yet (the default <data root>/workspace
 * before its first export) still gets the real path of its nearest existing parent with the rest appended, so files
 * later written below it (and reported by their real path) are recognized as inside the project.
 */
export function projectRoots(projectRoot = PROJECT_ROOT) {
  const roots = [resolve(projectRoot)];
  const missing = [];
  for (let current = resolve(projectRoot); ;) {
    try { roots.push(join(realpathSync.native(current), ...missing)); break; }
    catch {
      const parent = dirname(current);
      if (parent === current) break;
      missing.unshift(basename(current)); current = parent;
    }
  }
  return [...new Set(roots)].sort((a, b) => b.length - a.length);
}

/** Project-relative POSIX-style path for an absolute path inside the project, else null. */
export function projectRelative(path, roots = projectRoots()) {
  if (typeof path !== 'string' || !isAbsolute(path)) return null;
  for (const root of roots) {
    const rel = relative(root, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/');
  }
  return null;
}

/** Rewrite known path fields; adds pathBase only when something was made relative. */
export function withProjectPaths(result, keys, roots) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const output = { ...result }; let changed = false;
  for (const key of keys) {
    const rel = projectRelative(output[key], roots);
    if (rel) { output[key] = rel; changed = true; }
  }
  return changed ? { ...output, pathBase: 'project-root' } : output;
}

const URL_QUERY = /(https?:\/\/[^\s?#'"`<>]+)\?[^\s#'"`<>]*/gi;
// Credential key names. Plurals ("tokens: 225", "secrets") are counts or prose, never a single credential.
const SECRET_NAME = '[A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|credential|authorization|cookie|api[-_]?key|apikey|access[-_]?key|private[-_]?key|session[-_]?id)(?!s\\b)[A-Za-z0-9_-]*|密码|令牌|密钥|口令|凭据';
// A value may carry an auth scheme first ("Authorization: Basic dXNl…"); short all-digit values are counts, not secrets.
const SECRET_VALUE = `(?:(?:Bearer|Basic|Token|Digest)\\s+)?(?!\\d{1,6}(?![^\\s,;&)'"」，；]))(?:"[^"]*"|'[^']*'|「[^」]*」|[^\\s,;&)'"」，；]+)`;
// Only explicit key[:=：＝]value forms, bare or with a quoted key as in JSON ("apiKey":"…", 'password': '…').
const KEY_VALUE = new RegExp(`(?<![A-Za-z0-9_-])(${SECRET_NAME})(\\s*[:=：＝]\\s*)${SECRET_VALUE}`, 'gi');
const QUOTED_KEY_VALUE = new RegExp(`(["'])(${SECRET_NAME})\\1(\\s*[:=：＝]\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;&)}\\]]+)`, 'gi');
// A Bearer credential contains a digit or symbol ("Bearer token required" is prose).
const BEARER = /\b(Bearer)(\s+)(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{6,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// Characters that end an unquoted path, including CJK punctuation.
const PATH_END = `\\s'"\`)\\]}>,;」』）】，；。|*`;
// Paths look real: they start at a boundary (also after ":", "：", "「", "|" or "*", but never "//", so URLs stay intact)
// and have at least two non-empty segments from / or ~. "/tags.json", "(/20 max)" and "artist:/abc/" stay prose.
const PATH_START = `(^|[\\s'"\`(\\[{<=,;:：「『（【，；、|*])`;
const SEGMENT = `[^${PATH_END}/]+`;
// An unquoted path may continue across single spaces while the next token still contains "/"
// ("/Users/x/Library/Application Support/novelai/a.png"), so no tail of it is left behind.
// A token after the space is never a continuation when it is a URL (scheme://), or when the WHOLE token is a
// date (2026/09/27) or a fraction/ratio (3/20, 16/9), or one of the common word pairs in WORD_PAIRS (and/or,
// w/o, 和/或 …). Opening punctuation before it and closing punctuation after it are allowed ("(and/or)",
// "and/or.", "3/20:"); anything else after it ("2024/12/a.png", "and/or/x") keeps the path going.
// Known limits: a relative path right after an absolute one ("/a/b docs/x.md") is still merged,
// and a real path whose spaced part is exactly such a token ("/Users/x/Backup 3/20") keeps that tail.
// Windows paths never continue across spaces.
export const WORD_PAIRS = Object.freeze(['and/or', 'or/and', 'w/o', 'yes/no', 'on/off', 'true/false', 'input/output', 'read/write', 'I/O', 'N/A', '和/或', '或/和', '是/否', '及/或']);
const caseless = word => [...word].map(ch => /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch === '/' ? '\\/' : ch).join('');
const OPEN_PUNCT = `(\\[{<'"\`「『（【`;
const CLOSE_PUNCT = `.,;:!?)\\]}>'"\`」』）】，；。：！？、…`;
// The token ends here: only closing punctuation until whitespace or the end of the text.
const TOKEN_END = `(?=[${CLOSE_PUNCT}]*(?:\\s|$))`;
const NOT_CONTINUATION = `(?![A-Za-z][A-Za-z0-9+.-]*:\\/\\/|[${OPEN_PUNCT}]*(?:\\d{4}\\/\\d{1,2}\\/\\d{1,2}|\\d+\\/\\d+|${WORD_PAIRS.map(caseless).join('|')})${TOKEN_END})`;
const CONTINUATION = `(?: ${NOT_CONTINUATION}[^${PATH_END}/]*\\/[^${PATH_END}]*)*`;
const ABSOLUTE_PATH = new RegExp(`${PATH_START}(?:\\/(?!\\/)${SEGMENT}\\/${SEGMENT}(?:\\/[^${PATH_END}]*)?${CONTINUATION}|~\\/${SEGMENT}(?:\\/[^${PATH_END}]*)?${CONTINUATION}|[A-Za-z]:\\\\[^${PATH_END}]*|file:\\/\\/[^${PATH_END}]*)`, 'g');
// Quoted paths may contain spaces ("Application Support"); the whole quoted span is replaced.
const QUOTED_BODY = close => `(?:\\/(?!\\/)[^${close}\\n/]+\\/[^${close}\\n/]+(?:\\/[^${close}\\n]*)?|~\\/[^${close}\\n/]+(?:\\/[^${close}\\n]*)?|[A-Za-z]:\\\\[^${close}\\n]*|file:\\/\\/[^${close}\\n]*)`;
const QUOTED_PATH = new RegExp(`'${QUOTED_BODY("'")}'|"${QUOTED_BODY('"')}"|\`${QUOTED_BODY('`')}\`|「${QUOTED_BODY('」')}」|『${QUOTED_BODY('』')}』`, 'g');
const redactQuoted = (match, quote, name, separator) => `${quote}${name}${quote}${separator}${/["']$/.test(match) ? `${match.at(-1)}[redacted]${match.at(-1)}` : '[redacted]'}`;

/**
 * Keep explanatory text; drop credentials, URL queries and absolute paths (project paths become relative).
 * Deliberately narrow (few false positives): only explicit key[:=：＝]value forms (bare or quoted keys),
 * Bearer credentials, JWTs and URL queries. Prose such as "token is …" or "密码是…" is not rewritten.
 */
export function scrubText(text, roots = projectRoots()) {
  if (typeof text !== 'string') return text;
  let value = text.replace(URL_QUERY, '$1?[redacted]').replace(QUOTED_KEY_VALUE, redactQuoted).replace(KEY_VALUE, '$1$2[redacted]').replace(BEARER, '$1$2[redacted]').replace(JWT, '[redacted]');
  for (const root of roots) value = withoutRoot(value, root);
  return value.replace(QUOTED_PATH, match => `${match[0]}<path>${match.at(-1)}`).replace(ABSOLUTE_PATH, '$1<path>');
}

const ENDS_UNQUOTED_PATH = new RegExp(`[${PATH_END}]`);
/**
 * `text` with every `<root><separator>` prefix removed, so paths inside the project read project-relative. With the
 * Windows separator the rest of each such path (up to its closing quote when quoted, else up to the first character
 * that ends an unquoted path) is written with "/", the same form as every project-relative path the tools return
 * (novelai/library-inbox/x.json, never novelai\library-inbox\x.json).
 */
export function withoutRoot(text, root, separator = sep) {
  const prefix = root + separator;
  if (separator === '/') return text.split(prefix).join('');
  let output = '', index = 0;
  for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, index)) {
    const quote = /['"`]/.test(text[at - 1] ?? '') ? text[at - 1] : null;
    let end = at + prefix.length;
    while (end < text.length && (quote ? text[end] !== quote && text[end] !== '\n' : !ENDS_UNQUOTED_PATH.test(text[end]))) end++;
    output += text.slice(index, at) + text.slice(at + prefix.length, end).split(separator).join('/');
    index = end;
  }
  return output + text.slice(index);
}

/**
 * Host success payloads can embed raw error text (for example material import
 * coverWarnings[].message and error.message). Scrub every `message` /
 * `messageDetail` string at any depth; library content fields are left untouched.
 */
export function scrubMessages(value, roots = projectRoots()) {
  if (Array.isArray(value)) return value.map(item => scrubMessages(item, roots));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'string' && (key === 'message' || key === 'messageDetail') ? scrubText(item, roots) : scrubMessages(item, roots)]));
}

/**
 * Identity fields the model must be able to echo back unchanged (a scrubbed requestKey would become a
 * different, new paid request). They pass through scrubDeep only when the value is either exactly what
 * the model submitted in this call (`trusted`) or a string of the expected identity format: a UUID, a
 * 64-hex input hash, one of this server's mcp- host keys, or a safe integer revision. Anything else
 * under these keys — nested objects, path- or credential-like strings a host might put there — is
 * scrubbed like any other value.
 */
const UUID_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HOST_KEY_ID = /^mcp-[a-f0-9]{24}-[a-f0-9]{64}$/;
export const IDENTITY_FORMATS = Object.freeze({
  requestKey: HOST_KEY_ID, hostRequestKey: HOST_KEY_ID, recipeId: UUID_ID, batchId: UUID_ID, jobId: UUID_ID, entryId: UUID_ID,
  inputHash: /^[a-f0-9]{64}$/, recipeRevision: null, historyRevision: null, historyId: null, assetId: null,
});
export const IDENTITY_KEYS = Object.freeze(new Set(Object.keys(IDENTITY_FORMATS)));
/** The identity values a tool call itself supplied; only exact equality with these is trusted. */
export function trustedIdentities(args) {
  if (!args || typeof args !== 'object') return {};
  return Object.fromEntries([...IDENTITY_KEYS].filter(key => typeof args[key] === 'string').map(key => [key, args[key]]));
}
function identityAllowed(key, value, trusted) {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string') return false;
  if (Object.hasOwn(trusted, key) && trusted[key] === value) return true;
  const format = IDENTITY_FORMATS[key];
  return Boolean(format) && format.test(value);
}

export function scrubDeep(value, roots = projectRoots(), trusted = {}) {
  if (typeof value === 'string') return scrubText(value, roots);
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, roots, trusted));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, IDENTITY_KEYS.has(key) && identityAllowed(key, item, trusted) ? item : scrubDeep(item, roots, trusted)]));
}
