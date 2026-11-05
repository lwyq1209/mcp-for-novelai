import { readHostError, stripHostErrorSuffixes } from "./host-errors/bridge";

export interface CompactRemoteErrorOptions {
  status?: number;
  /** Shown when the value has no text (already in the language wanted). Default: remote.failed in `language`. */
  fallback?: string;
  maxLength?: number;
  /**
   * The interface language of the window (settings.language). Without it the text is English: the host's messages,
   * logs and what MCP reads stay English (step 4c1); the window renders the same failures in its language.
   */
  language?: unknown;
}

/**
 * NovelAI failures that are not a readable upstream message (step 4c1): an unavailable service (HTTP 502/503/504), an
 * HTML error page, nothing at all. The window renders them by reason in its language (src/host-errors catalog); the
 * host keeps the English text. statusText is " Bad Gateway" etc. (with its space) or "".
 */
export const REMOTE_ERROR_TEXTS = {
  "remote.unavailable": { "zh-CN": "NovelAI 暂时不可用（HTTP {status}{statusText}），请稍后重试。", "en-US": "NovelAI is unavailable right now (HTTP {status}{statusText}); try again later." },
  "remote.html_page": { "zh-CN": "NovelAI 返回了网页错误，请稍后重试。", "en-US": "NovelAI answered with an error page; try again later." },
  "remote.failed": { "zh-CN": "请求失败，请稍后重试。", "en-US": "The request failed; try again later." },
} as const;
export type RemoteErrorReason = keyof typeof REMOTE_ERROR_TEXTS;
/** What a failure says, in English, and the reason (with params) when the window should render it by catalog. */
export interface RemoteError { text: string; reason?: RemoteErrorReason; params?: { status?: number; statusText?: string } }

const remoteLanguage = (language: unknown): "zh-CN" | "en-US" => typeof language === "string" && language.trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
/** The text of a remote reason in a language (English without one), placeholders filled from params. */
export function remoteErrorText(reason: RemoteErrorReason, params: RemoteError["params"] = {}, language?: unknown): string {
  const values = params as Record<string, unknown>;
  return REMOTE_ERROR_TEXTS[reason][remoteLanguage(language)].replace(/\{(\w+)\}/g, (_match, name: string) => values[name] === undefined ? "" : String(values[name]));
}

const ERROR_TEXT_KEYS = ["message", "detail", "error", "title"] as const;

function objectStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const direct = Number(record.statusCode ?? record.status);
  if (Number.isInteger(direct) && direct >= 100 && direct <= 599) return direct;
  const response = record.response;
  if (response && typeof response === "object") {
    const nested = Number((response as Record<string, unknown>).status);
    if (Number.isInteger(nested) && nested >= 100 && nested <= 599) return nested;
  }
  return undefined;
}

function errorValueText(value: unknown, depth = 0): string {
  if (value == null) return "";
  // Host errors keep their structure in an invisible message suffix (host-errors/bridge.ts); it is never shown.
  if (typeof value === "string") return readHostError(value).message;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return readHostError(value).message || value.name;
  if (depth > 2 || typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  const response = record.response;
  if (response && typeof response === "object" && "data" in response) {
    const nested = errorValueText((response as Record<string, unknown>).data, depth + 1);
    if (nested) return nested;
  }
  for (const key of ERROR_TEXT_KEYS) {
    if (!(key in record)) continue;
    const nested = errorValueText(record[key], depth + 1);
    if (nested && nested !== "[object Object]") return nested;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The readable text of a JSON error body (step 4b2): NovelAI answers a refusal such as HTTP 402 with
 * {"statusCode":402,"message":"…"}; its message (or detail / error / title) is shown instead of the raw JSON.
 * Undefined for text that is not a JSON object or array, or one without such a field.
 */
function jsonBodyText(raw: string): string | undefined {
  if (!/^[[{]/.test(raw) || raw.length > 64 * 1024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  const find = (value: unknown, depth: number): string | undefined => {
    if (typeof value === "string") return value.trim() || undefined;
    if (!value || typeof value !== "object" || depth > 3) return undefined;
    if (Array.isArray(value)) { for (const item of value) { const text = find(item, depth + 1); if (text) return text; } return undefined; }
    for (const key of ERROR_TEXT_KEYS) { const text = find((value as Record<string, unknown>)[key], depth + 1); if (text) return text; }
    return undefined;
  };
  return typeof parsed === "object" && parsed !== null ? find(parsed, 0) : undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#(\d+);?/g, (_match, digits: string) => {
      const code = Number(digits);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&#x([\da-f]+);?/gi, (_match, digits: string) => {
      const code = Number.parseInt(digits, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : " ";
    })
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--([\s\S]*?)-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function detectedHttpStatus(value: string): number | undefined {
  const explicit = value.match(/\bHTTP\s*[-:]?\s*([45]\d\d)\b/i)?.[1];
  const cloudflare = value.match(/\b(?:error\s*code|status(?:\s*code)?)\s*[:#-]?\s*([45]\d\d)\b/i)?.[1];
  const gateway = value.match(/\b(502|503|504)\b/)?.[1];
  const parsed = Number(explicit ?? cloudflare ?? gateway);
  return Number.isInteger(parsed) ? parsed : undefined;
}

const STATUS_TEXT: Record<number, string> = { 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" };

/**
 * What a rejected IPC/Axios payload says, bounded and as plain text (English): an unavailable service or an HTML
 * error page (Cloudflare occasionally returns a complete one, which must never be shown verbatim) become one reason
 * the window renders in its language; a readable upstream message (the message of a JSON body) is kept as it is.
 */
export function describeRemoteError(value: unknown, options: Omit<CompactRemoteErrorOptions, "language" | "fallback"> = {}): RemoteError {
  const maxLength = Math.max(80, Math.min(2_000, options.maxLength ?? 420));
  const failed = (): RemoteError => ({ text: remoteErrorText("remote.failed"), reason: "remote.failed" });
  const text = stripHostErrorSuffixes(errorValueText(value)).trim();
  if (!text) return failed();
  const raw = jsonBodyText(text) ?? text;

  const status = options.status ?? objectStatus(value) ?? detectedHttpStatus(raw) ?? (raw === text ? undefined : detectedHttpStatus(text));
  const looksLikeHtml = /<!doctype\s+html|<html\b|<head\b|<body\b|<\/?(?:div|span|script|style|h[1-6]|p)\b/i.test(raw);
  const looksLikeGatewayPage = /cloudflare|cf-error|bad\s+gateway|gateway\s+time-?out|service\s+unavailable/i.test(raw);
  if (status === 502 || status === 503 || status === 504) {
    const params = { status, statusText: STATUS_TEXT[status] ? ` ${STATUS_TEXT[status]}` : "" };
    return { text: remoteErrorText("remote.unavailable", params), reason: "remote.unavailable", params };
  }
  if (looksLikeHtml || looksLikeGatewayPage) return { text: remoteErrorText("remote.html_page"), reason: "remote.html_page", ...(status ? { params: { status } } : {}) };

  const plain = stripHtml(raw)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return failed();
  return { text: plain.length > maxLength ? `${plain.slice(0, maxLength - 1).trimEnd()}…` : plain };
}

/**
 * Converts rejected IPC/Axios payloads into a bounded, plain-text UI message: describeRemoteError, with its reasons in
 * `language` (English without one) and `fallback` when the value has no text.
 */
export function compactRemoteErrorText(
  value: unknown,
  options: CompactRemoteErrorOptions = {},
): string {
  const described = describeRemoteError(value, options);
  if (described.reason === "remote.failed" && options.fallback?.trim()) return options.fallback.trim();
  return described.reason ? remoteErrorText(described.reason, described.params, options.language) : described.text;
}
