import { describe, expect, it } from "vitest";
import { appLanguageForSystemLanguages, normalizeSavedLanguage, systemLanguages } from "./app-language";

describe("interface language for the system languages", () => {
  it("reads zh-CN for a first tag starting with zh and en-US otherwise", () => {
    expect(appLanguageForSystemLanguages(["zh-Hans-CN", "en-US"])).toBe("zh-CN");
    expect(appLanguageForSystemLanguages(["zh-TW"])).toBe("zh-CN");
    expect(appLanguageForSystemLanguages(["ZH"])).toBe("zh-CN");
    expect(appLanguageForSystemLanguages(["en-GB", "zh-CN"])).toBe("en-US");
    expect(appLanguageForSystemLanguages(["ja-JP"])).toBe("en-US");
    expect(appLanguageForSystemLanguages(["ko-KR"])).toBe("en-US");
    expect(appLanguageForSystemLanguages([])).toBe("en-US");
    expect(appLanguageForSystemLanguages(["", 3, "zh-HK"])).toBe("zh-CN");
  });
});

describe("a saved language", () => {
  const system = (tags: string[]) => () => tags;

  it("keeps zh-CN and en-US whatever the system language", () => {
    for (const tags of [["zh-CN"], ["en-US"], ["ja-JP"]]) {
      expect(normalizeSavedLanguage("zh-CN", system(tags))).toBe("zh-CN");
      expect(normalizeSavedLanguage("en-US", system(tags))).toBe("en-US");
    }
  });

  it("follows the system language for a retired, missing or non-string value", () => {
    const expected: Record<string, string> = { "zh-Hans-CN": "zh-CN", "en-US": "en-US", "ja-JP": "en-US" };
    for (const [tag, language] of Object.entries(expected)) {
      for (const value of ["zh-TW", "ja-JP", "ko-KR", undefined, null, 1, "fr-FR", ""]) {
        expect(normalizeSavedLanguage(value, system([tag])), `${String(value)} on ${tag}`).toBe(language);
      }
    }
  });
});

describe("the Electron system languages", () => {
  it("uses the preferred system languages first, then app.getLocale()", () => {
    expect(systemLanguages({ getPreferredSystemLanguages: () => ["zh-Hans-CN", "en-US"], getLocale: () => "en-US" })).toEqual(["zh-Hans-CN", "en-US"]);
    expect(systemLanguages({ getPreferredSystemLanguages: () => [], getLocale: () => "zh-CN" })).toEqual(["zh-CN"]);
    expect(systemLanguages({ getLocale: () => "ja" })).toEqual(["ja"]);
  });

  it("is empty without a usable app, so the language falls back to en-US", () => {
    expect(systemLanguages(undefined)).toEqual([]);
    expect(systemLanguages({})).toEqual([]);
    expect(systemLanguages({ getPreferredSystemLanguages: () => { throw new Error("not ready"); } })).toEqual([]);
    expect(normalizeSavedLanguage("ko-KR", () => systemLanguages(undefined))).toBe("en-US");
  });
});
