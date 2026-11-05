import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", roots: [] as string[], systemLanguages: [] as string[], locale: "" }));
vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => path.join(state.root, key),
    isPackaged: false,
    getPreferredSystemLanguages: () => state.systemLanguages,
    getLocale: () => state.locale,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error("unavailable"); },
    decryptString: () => { throw new Error("unavailable"); },
  },
}));

afterEach(() => {
  vi.resetModules();
  state.systemLanguages = [];
  state.locale = "";
  for (const root of state.roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function storeWith(settings: Record<string, unknown> | null) {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-store-language-"));
  state.roots.push(state.root);
  const userData = path.join(state.root, "userData");
  fs.mkdirSync(userData, { recursive: true });
  if (settings) fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ settings: { hasOnboarded: true, ...settings } }));
  return import("./store");
}

describe("the saved interface language", () => {
  it("keeps zh-CN and en-US whatever the system language", async () => {
    state.systemLanguages = ["ja-JP"];
    expect((await storeWith({ language: "zh-CN" })).getSettings().language).toBe("zh-CN");
    vi.resetModules();
    state.systemLanguages = ["zh-Hans-CN"];
    expect((await storeWith({ language: "en-US" })).getSettings().language).toBe("en-US");
  });

  for (const [system, expected] of [[["zh-Hans-CN", "en-US"], "zh-CN"], [["en-US"], "en-US"], [["ja-JP", "zh-CN"], "en-US"]] as const) {
    it(`reads a retired or missing language as ${expected} on a ${system[0]} system`, async () => {
      for (const language of ["zh-TW", "ja-JP", "ko-KR", undefined, 42]) {
        vi.resetModules();
        state.systemLanguages = [...system];
        const store = await storeWith(language === undefined ? {} : { language });
        expect(store.getSettings().language, String(language)).toBe(expected);
      }
      vi.resetModules();
      state.systemLanguages = [...system];
      expect((await storeWith(null)).getSettings().language, "no settings file").toBe(expected);
    });
  }

  it("uses app.getLocale() when there are no preferred system languages", async () => {
    state.locale = "zh-TW";
    expect((await storeWith({ language: "ko-KR" })).getSettings().language).toBe("zh-CN");
  });

  it("stores a retired language set later as the system language", async () => {
    state.systemLanguages = ["zh-CN"];
    const store = await storeWith({ language: "en-US" });
    store.setSetting("language", "ja-JP");
    expect(store.getSettings().language).toBe("zh-CN");
  });
});
