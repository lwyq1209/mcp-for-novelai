import type { AppLanguage } from "../../src/types";

const APP_LANGUAGES: ReadonlySet<string> = new Set<AppLanguage>(["zh-CN", "en-US"]);

/** Interface language for system language tags, most preferred first: the first tag starting with "zh" reads zh-CN, anything else en-US. */
export function appLanguageForSystemLanguages(tags: readonly unknown[]): AppLanguage {
  const first = tags.find((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
  return first !== undefined && first.trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/** A saved zh-CN or en-US is kept; any other value (a retired interface language, missing, not a string) follows the system language. */
export function normalizeSavedLanguage(value: unknown, systemLanguages: () => readonly unknown[]): AppLanguage {
  return typeof value === "string" && APP_LANGUAGES.has(value) ? (value as AppLanguage) : appLanguageForSystemLanguages(systemLanguages());
}

interface SystemLanguageSource {
  getPreferredSystemLanguages?: () => string[];
  getLocale?: () => string;
}

/**
 * Electron's preferred system languages, or app.getLocale() when that list is empty. Without a usable app (tests,
 * a mock without these methods, or a throw) the list is empty, so the safe default is en-US.
 */
export function systemLanguages(app: SystemLanguageSource | undefined): string[] {
  try {
    const preferred = typeof app?.getPreferredSystemLanguages === "function" ? app.getPreferredSystemLanguages() : [];
    if (Array.isArray(preferred) && preferred.some((tag) => typeof tag === "string" && tag.trim() !== "")) return preferred;
    const locale = typeof app?.getLocale === "function" ? app.getLocale() : "";
    return typeof locale === "string" && locale.trim() !== "" ? [locale] : [];
  } catch {
    return [];
  }
}
