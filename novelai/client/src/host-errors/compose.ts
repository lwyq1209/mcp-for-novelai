import { normalizeAppLanguage } from "../i18n";
import { hostErrorText, readHostError } from "./index";

/**
 * Host texts with details (electron/host-message.ts): each detail is rendered in the interface language and fills the
 * placeholder of the same name before the text itself is rendered. Details nest one level only; a detail without a
 * known code or reason shows its message. An array detail keeps at most 20 entries, joined per language.
 */
const MAX_DETAILS = 20;
const SEPARATOR = { "zh-CN": "；", "en-US": "; " } as const;

/** A field of a host error or result, read with readHostError (also across contextBridge). */
const read = (value: unknown, key: "code" | "message" | "reason" | "params" | "details"): unknown => value && typeof value === "object" ? readHostError(value)[key] : undefined;
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** The text of one detail: its catalog text (reason, then code) or its message; its own details are not read. */
function detailText(value: unknown, language: unknown): string {
  return hostErrorText({ code: read(value, "code"), message: read(value, "message"), reason: read(value, "reason"), params: read(value, "params") }, language, "");
}

/** The text of a host result or error in the interface language, with its details filled in. */
export function hostMessageText(value: unknown, language: unknown, fallback?: string): string {
  const details = record(read(value, "details"));
  if (!details) return hostErrorText(value, language, fallback);
  const lang = normalizeAppLanguage(language);
  const params: Record<string, unknown> = { ...(record(read(value, "params")) ?? {}) };
  for (const [key, detail] of Object.entries(details)) {
    params[key] = Array.isArray(detail)
      ? detail.slice(0, MAX_DETAILS).map(item => detailText(item, lang)).filter(Boolean).join(SEPARATOR[lang])
      : detailText(detail, lang);
  }
  return hostErrorText({ code: read(value, "code"), message: read(value, "message"), reason: read(value, "reason"), params }, lang, fallback);
}
