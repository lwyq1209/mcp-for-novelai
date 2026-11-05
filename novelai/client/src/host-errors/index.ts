import { normalizeAppLanguage } from "../i18n";
import type { AppLanguage } from "../types";
import { ACCOUNT_ERROR_TEXTS } from "./account";
import { BACKUP_ERROR_TEXTS } from "./backup";
import { DANBOORU_ERROR_TEXTS } from "./danbooru";
import { LIBRARY_ERROR_TEXTS } from "./library";
import { QUEUE_ERROR_TEXTS } from "./queue";
import { REMOTE_ERROR_TEXTS } from "../error-message";
import type { HostErrorTexts } from "./types";
import { readHostError, stripHostErrorSuffixes } from "./bridge";

/**
 * Host errors in the interface language (step 4a, user decision 10). The host gives every error it hands to the
 * window a code, an English message and, where the code has several cases, a reason with params
 * (electron/host-error.ts). The window shows the catalog text of the reason, else of the code, in its language; an
 * error the catalog does not know shows its message as it came. Fields are read with readHostError (./bridge.ts), so
 * an error thrown across contextBridge (message only, structure in its suffix) reads like one made in the window.
 */
export { readHostError } from "./bridge";
export type { HostErrorShape } from "./bridge";
export type { HostErrorText, HostErrorTexts } from "./types";
export const HOST_ERROR_TEXTS: HostErrorTexts = Object.freeze({ ...QUEUE_ERROR_TEXTS, ...LIBRARY_ERROR_TEXTS, ...BACKUP_ERROR_TEXTS, ...ACCOUNT_ERROR_TEXTS, ...DANBOORU_ERROR_TEXTS, ...REMOTE_ERROR_TEXTS });
export interface HostErrorLike { code?: unknown; message?: unknown; reason?: unknown; params?: unknown }

const GENERIC: Record<AppLanguage, string> = { "zh-CN": "操作未完成。", "en-US": "The operation did not complete." };
const field = (value: unknown, key: keyof HostErrorLike): unknown => readHostError(value)[key];
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : "";

/** Fills {name} placeholders from params; a missing value reads as an empty string. */
export function formatHostErrorText(template: string, params: unknown): string {
  const values = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : {};
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, name: string) => {
    const value = values[name];
    return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : "";
  });
}

/** The catalog entry an error names (reason first, then code), or undefined. */
export function hostErrorEntry(error: unknown) {
  for (const key of [text(field(error, "reason")), text(field(error, "code"))]) if (key && Object.hasOwn(HOST_ERROR_TEXTS, key)) return HOST_ERROR_TEXTS[key];
  return undefined;
}

/** The text to show for a host error in the interface language; fallback when it has neither a known code nor a message. */
export function hostErrorText(error: unknown, language: unknown, fallback?: string): string {
  const lang = normalizeAppLanguage(language);
  const entry = hostErrorEntry(error);
  // Never a suffix in the result, also not from a param filled in from another error's text.
  if (entry) return stripHostErrorSuffixes(formatHostErrorText(entry[lang], field(error, "params")));
  return stripHostErrorSuffixes(text(field(error, "message")) || fallback || GENERIC[lang]);
}
