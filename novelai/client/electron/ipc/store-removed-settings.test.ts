import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", encryption: false }));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => path.join(state.root, key), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => state.encryption,
    encryptString: (value: string) => { if (!state.encryption) throw new Error("unavailable"); return Buffer.from(`stable:${value}`); },
    decryptString: (value: Buffer) => {
      if (!state.encryption || !value.toString().startsWith("stable:")) throw new Error("unavailable");
      return value.toString().slice("stable:".length);
    },
  },
}));

afterEach(() => {
  state.encryption = false;
  vi.resetModules();
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
});

describe("settings this version does not know", () => {
  it("loads a settings file that carries an unknown folder key without failing and drops that key", async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-removed-settings-"));
    const userData = path.join(state.root, "userData");
    const outputDir = path.join(state.root, "pictures", "out");
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
      settings: { hasOnboarded: true, outputDir, onlineGalleryDownloadDir: path.join(state.root, "gallery") },
    }));
    const { getSettings } = await import("./store");
    const settings = getSettings();
    expect(settings.outputDir).toBe(outputDir);
    expect(settings.hasOnboarded).toBe(true);
    expect(Object.hasOwn(settings, "onlineGalleryDownloadDir")).toBe(false);
  });

  it("drops settings of removed features, including encrypted credentials, and keeps generation, account and output settings", async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-removed-settings-"));
    const userData = path.join(state.root, "userData");
    const outputDir = path.join(state.root, "pictures", "out");
    const file = path.join(userData, "settings.json");
    fs.mkdirSync(userData, { recursive: true });
    state.encryption = true;
    const encrypted = (value: string) => `enc:v1:${Buffer.from(`stable:${value}`).toString("base64")}`;
    const removed = {
      agentApiKey: encrypted("agent-secret"), agentApiBaseUrl: "https://example.invalid/v1", agentApiModel: "old-model",
      agentContextWindow: 128000, agentAutoCompact: false, agentVisionEnabled: true,
      visionApiKey: encrypted("vision-secret"), visionApiUrl: "https://example.invalid/v1", reversePromptMode: "natural",
      reversePromptTemplates: { tags: "x", natural: "", mixed: "" }, reverseConvertDshEnabled: true,
      reverseConvertPromptPresets: [{ id: "p1", name: "Old preset" }], reverseConvertPromptPresetId: "p1",
      convertApiKey: "enc:v1:bm90LW91cnM=", convertApiModel: "old", convertPromptTemplatesV45: { tags: "", natural: "", mixed: "" },
      comicAnalyzePromptTemplate: "split the story", comicAnalyzePromptTemplates: { tags: "", natural: "", mixed: "" },
      tagServerEnabled: true, tagServerUrl: "https://example.invalid/mcp", tagServerApiKey: encrypted("tag-secret"), tagServerType: "http",
      mcpForCapsule: true, mcpForReverse: true, mcpForConvert: false,
      translateProvider: "baidu", baiduAppId: "app", baiduSecret: "plain-baidu-secret", translateAiApiKey: encrypted("translate-secret"),
      proxyForMcp: false, proxyForAi: false, proxyForTranslate: false,
    };
    fs.writeFileSync(file, JSON.stringify({
      token: encrypted("plain-token"),
      account: { tierName: "Opus", anlasBalance: 42 },
      settings: { hasOnboarded: true, outputDir, language: "en-US", proxyMode: "direct", imageNameTemplate: "{seq}", ...removed },
    }));
    const store = await import("./store");
    const settings = store.getSettings() as unknown as Record<string, unknown>;
    expect(settings).toMatchObject({ hasOnboarded: true, outputDir, language: "en-US", proxyMode: "direct", imageNameTemplate: "{seq}" });
    for (const key of Object.keys(removed)) expect(Object.hasOwn(settings, key), key).toBe(false);
    expect(settings.credentialIssues).toEqual([]);
    expect(store.getToken()).toBe("plain-token");
    expect(store.getAccountSummary()).toMatchObject({ hasToken: true, tierName: "Opus", anlasBalance: 42 });
    store.setSetting("language", "zh-CN");
    const written = fs.readFileSync(file, "utf8");
    for (const key of Object.keys(removed)) expect(written, key).not.toContain(`"${key}"`);
    for (const secret of ["agent-secret", "vision-secret", "tag-secret", "translate-secret"]) expect(written).not.toContain(encrypted(secret));
    expect(written).not.toContain("plain-baidu-secret");
    expect(JSON.parse(written).settings).toMatchObject({ language: "zh-CN", outputDir });
  });

  it("ignores library arrays an earlier development build kept in the settings file and drops them on the next write", async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-removed-settings-"));
    const userData = path.join(state.root, "userData");
    const outputDir = path.join(state.root, "pictures", "out");
    const file = path.join(userData, "settings.json");
    fs.mkdirSync(userData, { recursive: true });
    const stamp = "2026-11-03T00:00:00.000Z";
    const history = { id: "old-image", filePath: path.join(outputDir, "old.png"), fileUrl: "", date: "2026-11-03", createdAt: stamp, params: { positivePrompt: "cup" }, actualSeed: 1, model: "nai-diffusion-4-5-full", width: 8, height: 8 };
    fs.writeFileSync(file, JSON.stringify({
      account: { tierName: "Opus" },
      settings: {
        hasOnboarded: true, outputDir,
        stylePromptPresets: [{ id: "style", name: "Style", prompt: "watercolor", group: "Paint", createdAt: stamp, previewImages: [] }],
        stylePromptPresetGroups: ["Default", "Paint"], positivePromptPresets: [{ id: "positive", name: "Cup", prompt: "cup", createdAt: stamp }],
        promptChunks: [{ id: "chunk", name: "Light", content: "soft light", createdAt: stamp, updatedAt: stamp }],
      },
      history: [history], historyGroups: [{ id: "group", name: "Group", createdAt: stamp }], somethingElse: { kept: false },
    }));
    const store = await import("./store");
    // Without a library the library read models are empty; nothing comes from the settings file.
    const settings = store.getSettings();
    expect(settings).toMatchObject({ hasOnboarded: true, outputDir, stylePromptPresets: [], stylePromptPresetGroups: [], positivePromptPresets: [], promptChunks: [] });
    expect(Object.keys(store.readStore()).sort()).toEqual(["account", "settings", "token"]);
    expect(() => store.setSetting("stylePromptPresets", [])).toThrow(expect.objectContaining({ reason: "settings.library_kept" }));
    store.setSetting("language", "en-US");
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(Object.keys(written)).toEqual(["account", "settings"]);
    expect(written.account).toEqual({ tierName: "Opus" });
    for (const key of ["stylePromptPresets", "stylePromptPresetGroups", "positivePromptPresets", "promptChunks"]) expect(Object.hasOwn(written.settings, key), key).toBe(false);
    expect(Object.keys(written.settings).sort()).toEqual(Object.keys(store.defaultSettings()).sort());
    expect(JSON.stringify(written)).not.toMatch(/old-image|"Group"|soft light/);
  });
});
