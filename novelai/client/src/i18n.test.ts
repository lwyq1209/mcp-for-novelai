import { describe, expect, it } from "vitest";
import { localizedDesktopOptionLabel, normalizeAppLanguage, SUPPORTED_APP_LANGUAGES } from "./i18n";

// Step 4c2: the old pages' text tables (tabs, chrome, tools page, token guide, generate panel, settings dialog) were
// removed with their pages; the interface copy is in src/ui/*.strings.ts (checked by src/ui/strings.test.ts).
describe("desktop i18n resources", () => {
  it("supports Simplified Chinese and English only", () => {
    expect(SUPPORTED_APP_LANGUAGES.map((item) => item.code)).toEqual(["zh-CN", "en-US"]);
  });

  it("keeps zh-CN and en-US and reads any other value as zh-CN when it starts with zh, else en-US", () => {
    expect(normalizeAppLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeAppLanguage("en-US")).toBe("en-US");
    expect(normalizeAppLanguage("zh-TW")).toBe("zh-CN");
    expect(normalizeAppLanguage("zh-Hans-CN")).toBe("zh-CN");
    expect(normalizeAppLanguage("ja-JP")).toBe("en-US");
    expect(normalizeAppLanguage("ko-KR")).toBe("en-US");
    expect(normalizeAppLanguage("fr-FR")).toBe("en-US");
    expect(normalizeAppLanguage(undefined)).toBe("en-US");
    expect(normalizeAppLanguage(42)).toBe("en-US");
  });

  it("labels the canvas's options in either language and falls back for an unknown value", () => {
    expect(localizedDesktopOptionLabel("zh-CN", "nai-diffusion-5-full", "x")).toMatch(/V5 Full（/);
    expect(localizedDesktopOptionLabel("en-US", "nai-diffusion-5-full", "x")).toMatch(/^NAI Diffusion V5 Full \(/);
    expect(localizedDesktopOptionLabel("en-US", "no-such-option", "Fallback")).toBe("Fallback");
  });
});
