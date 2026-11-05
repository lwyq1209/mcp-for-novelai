/**
 * What NovelAI said about a failed image of an agent batch (step 4c1), kept on the item's error for the window's queue
 * page only. It is never part of what MCP reads: the bridge answers drop it (queue-ui.ts withoutWindowOnlyFields) and
 * the MCP projection gives an item's error code alone.
 *
 * Only the message text of NovelAI's answer is kept (never its headers, the request, the token or a file path): at most
 * UPSTREAM_MESSAGE_MAX characters, cleaned by cleanUpstreamText (credentials, paths, addresses, invisible characters;
 * review rework). It is cleaned where the host makes it, again where a stored batch is read back (batch-service.ts)
 * and for the canvas's own failure text (ipc/nai.ts). An answer without a readable message keeps its HTTP status and
 * the remote reason (remote.unavailable, remote.html_page, remote.failed) the window renders in its language.
 */
export interface UpstreamReason {
  status?: number;
  message?: string;
  reason?: 'remote.unavailable' | 'remote.html_page' | 'remote.failed';
  params?: Record<string, string | number>;
}

export const UPSTREAM_MESSAGE_MAX = 300;
const REMOTE_REASONS = new Set(['remote.unavailable', 'remote.html_page', 'remote.failed']);

// Characters a path segment, a key-like token or a header value never runs across.
const SEG = String.raw`[^\s\\/"'<>` + '`' + String.raw`()\[\]{},;|\u0001]`;
// A path may hold spaces: a following word that itself goes on with a separator ("Application Support/x.png") is part of it.
const MORE = String.raw`(?: +${SEG}+(?:[\\/]${SEG}*)+)*`;
const URL_PATTERN = /\b([a-z][a-z0-9+.-]*):\/\/([^\s"'<>`\u0001]+)/gi;
const KEY_NAME = String.raw`[\w-]*(?:api[_-]?key|apikey|access[_-]?key|private[_-]?key|secret|token|passw(?:or)?d|pwd|session(?:[_-]?id)?|sessid|credentials?|signature|cookie|jwt)[\w-]*`;
// A short plain number ("tokens: 300") is a count, not a secret.
const KEY_VALUE = String.raw`(?!\d{1,6}\b)(?:"[^"\u0001]*"|'[^'\u0001]*'|[^\s&;,"'<>()\[\]{}\u0001]+)`;
// A credential after an authentication scheme: one token, then any comma-separated name=value parameters (Digest).
const CREDENTIALS = String.raw`(?:[\w-]+\s*=\s*"[^"\u0001]*"|"[^"\u0001]*"|[^\s,;"'\u0001]+)(?:\s*,\s*[\w-]+\s*=\s*(?:"[^"\u0001]*"|[^\s,;\u0001]+))*`;
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// Keys printed in equal groups (XXXX-XXXX-XXXX-XXXX-XXXX); model names and request ids have groups of different lengths.
const GROUPED_KEYS = [4, 5, 6, 7, 8].map(size => new RegExp(String.raw`\b(?:[A-Za-z0-9]{${size}}-){4,}[A-Za-z0-9]{${size}}\b`, 'g'));

/** Credentials, tokens and long key-like runs (also used inside a URL's path). */
function withoutTokens(text: string): string {
  return GROUPED_KEYS.reduce((value, pattern) => value.replace(pattern, '…'), text
    .replace(/pst\p{Pd}[\w\p{Pd}]*/gu, '…')
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, '…')
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '…')
    .replace(/[\p{L}\p{N}._%+-]+\s*[[(]\s*at\s*[\])]\s*[\p{L}\p{N}-]+(?:\s*[[(]\s*dot\s*[\])]\s*[\p{L}\p{N}-]+)+/giu, '…')
    .replace(IPV4, '…')
    // long runs without separators: keys, hashes, base64
    .replace(/\b[A-Za-z0-9+/=_]{32,}\b/g, '…'));
}

/** A URL keeps its scheme, host and path (key-like parts of it removed); never its user name, password, query or fragment. */
function cleanUrl(scheme: string, rest: string): string {
  if (scheme.toLowerCase() === 'file') return '…';
  const end = rest.search(/[/?#]/), authority = end < 0 ? rest : rest.slice(0, end), tail = end < 0 ? '' : rest.slice(end);
  const at = authority.lastIndexOf('@');
  const host = withoutTokens(at < 0 ? authority : authority.slice(at + 1));
  const path = withoutTokens(tail.replace(/[?#].*$/, ''));
  return `${scheme}://${at < 0 ? '' : '…@'}${host}${path}`;
}

/**
 * NovelAI's message text, cleaned: no control or invisible formatting characters, no credentials (authentication
 * headers of any scheme, cookies, key=value secrets, tokens, URL user names and passwords), no local paths (anything
 * that looks absolute: /a/b, ~/, C:\, \\server, file://, whatever character comes before it), no e-mail or IP
 * addresses, no URL queries and no long key-like runs; bounded to UPSTREAM_MESSAGE_MAX characters.
 */
export function cleanUpstreamText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // Invisible formatting (bidi marks and isolates, zero-width characters, tags), private-use and lone surrogates go;
  // control characters and line or paragraph separators become spaces.
  let text = raw.replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ');
  // URLs first, set aside so the path rules below do not take their "//host/path" for a local path.
  const urls: string[] = [];
  text = text.replace(URL_PATTERN, (_match, scheme: string, rest: string) => {
    const trailing = /[.,;:!?)\]}]+$/.exec(rest)?.[0] ?? '';
    urls.push(cleanUrl(scheme, trailing ? rest.slice(0, -trailing.length) : rest));
    return `\u0001${urls.length - 1}\u0001${trailing}`;
  });
  text = text
    // authentication headers (any scheme), cookies, then any key=value / "key": value secret
    .replace(new RegExp(String.raw`\b((?:proxy-)?authorization)(["']?)\s*[:=]\s*(?:[A-Za-z][\w-]*\s+)?${CREDENTIALS}`, 'gi'), '$1$2: …')
    .replace(new RegExp(String.raw`\b((?:set-)?cookie)(["']?)\s*[:=]\s*(?:[^\s;=\u0001]+=[^\s;\u0001]*|[^\s;\u0001]+)(?:\s*;\s*[^\s;=\u0001]+(?:=[^\s;\u0001]*)?)*`, 'gi'), '$1$2: …')
    .replace(/\bBearer\s+\S+/gi, 'Bearer …')
    .replace(/\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{6,}={0,2}/g, 'Basic …')
    .replace(/\bDigest\s+[\w-]+\s*=\s*(?:"[^"\u0001]*"|[^\s,\u0001]+)(?:\s*,\s*[\w-]+\s*=\s*(?:"[^"\u0001]*"|[^\s,\u0001]+))*/g, 'Digest …')
    .replace(new RegExp(String.raw`\b(${KEY_NAME})(["']?)(\s*[:=]\s*)${KEY_VALUE}`, 'gi'), '$1$2$3…')
    // local paths: quoted ones whole (they may hold spaces), then Windows shares and drives, home folders and any
    // absolute POSIX path of at least two segments
    .replace(/(["'`])((?:\/|~[\w.-]*\/|[A-Za-z]:[\\/]|\\\\)[^"'`\u0001]*)\1/g, (match, quote: string, path: string) => /^\/[^/\\]*$/.test(path) ? match : `${quote}…${quote}`)
    .replace(new RegExp(String.raw`\\\\${SEG}+(?:\\${SEG}*)+${MORE}`, 'g'), '…')
    // (a drive letter is one letter: "at:/x/y" is the word "at:" before a POSIX path)
    .replace(new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]${SEG}*(?:[\\/]${SEG}*)*${MORE}`, 'g'), '…')
    .replace(new RegExp(String.raw`~[\w.-]*\/${SEG}*(?:\/${SEG}*)*${MORE}`, 'g'), '…')
    .replace(new RegExp(String.raw`\/${SEG}+(?:\/${SEG}*)+${MORE}`, 'g'), '…')
    .replace(new RegExp(String.raw`\\${SEG}+(?:\\${SEG}*)+${MORE}`, 'g'), '…');
  text = withoutTokens(text).replace(/\u0001(\d+)\u0001/g, (_match, index: string) => urls[Number(index)] ?? '…');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= UPSTREAM_MESSAGE_MAX) return text;
  // Cut by code points: never half of a surrogate pair.
  let cut = text.slice(0, UPSTREAM_MESSAGE_MAX - 1);
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

// A remote reason's params are the ones describeRemoteError makes: the HTTP status and its standard text.
const plainParams = (value: unknown): Record<string, string | number> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>, out: Record<string, string | number> = {};
  if (Number.isInteger(raw.status) && (raw.status as number) >= 100 && (raw.status as number) <= 599) out.status = raw.status as number;
  if (typeof raw.statusText === 'string' && /^ ?[A-Za-z][A-Za-z -]{0,38}$|^$/.test(raw.statusText)) out.statusText = raw.statusText;
  return Object.keys(out).length ? out : undefined;
};

/**
 * A checked upstream reason (made by the host, read back from a stored batch or received from it): only its known
 * fields, cleaned again; undefined when nothing is left.
 */
export function upstreamReason(value: unknown): UpstreamReason | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = Number.isInteger(raw.status) && (raw.status as number) >= 100 && (raw.status as number) <= 599 ? raw.status as number : undefined;
  const reason = typeof raw.reason === 'string' && REMOTE_REASONS.has(raw.reason) ? raw.reason as UpstreamReason['reason'] : undefined;
  const message = reason ? '' : cleanUpstreamText(raw.message);
  const params = reason ? plainParams(raw.params) : undefined;
  if (status === undefined && !reason && !message) return undefined;
  return { ...(status !== undefined ? { status } : {}), ...(message ? { message } : {}), ...(reason ? { reason } : {}), ...(params ? { params } : {}) };
}
