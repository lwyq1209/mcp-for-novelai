import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialIssueKinds } from "../../src/settings/sections/logic";

// macOS safeStorage keeps its key in a keychain item named after the app ("<app name> Safe Storage"), so a token
// encrypted by a build with another app name cannot be decrypted after the rename. This stand-in encrypts under
// the current app name and fails to decrypt anything encrypted under another one, as the keychain would.
const state = vi.hoisted(() => ({ root: "", appName: "MCP for NovelAI", available: true }));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => path.join(state.root, key), isPackaged: false, getName: () => state.appName },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (value: string) => { if (!state.available) throw new Error("unavailable"); return Buffer.from(`${state.appName}:${value}`); },
    decryptString: (value: Buffer) => {
      const text = value.toString();
      if (!state.available || !text.startsWith(`${state.appName}:`)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text.slice(state.appName.length + 1);
    },
  },
}));

const encryptedUnder = (appName: string, value: string) => `enc:v1:${Buffer.from(`${appName}:${value}`).toString("base64")}`;

function writeSettingsFile(token: string) {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-token-unreadable-"));
  const userData = path.join(state.root, "userData");
  fs.mkdirSync(userData, { recursive: true });
  const file = path.join(userData, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ token, account: { tier: 3 }, settings: { hasOnboarded: true, outputDir: path.join(state.root, "out") }, history: [], historyGroups: [] }));
  return file;
}

afterEach(() => {
  state.available = true;
  vi.resetModules();
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
  state.root = "";
});

describe("a saved token that cannot be decrypted (for example after the app was renamed)", () => {
  it("reads as no token and asks for it again instead of failing", async () => {
    const file = writeSettingsFile(encryptedUnder("NovelAI Old Name", "old-secret"));
    const store = await import("./store");
    expect(() => store.readStore()).not.toThrow();
    expect(store.getToken()).toBe("");
    expect(store.getAccountSummary().hasToken).toBe(false);
    const settings = store.getSettings();
    expect(settings.hasOnboarded).toBe(true);
    expect(settings.credentialIssues).toEqual(["token"]);
    // The settings page shows its "unlock failed" banner (set.acc.credLocked): enter and save the token again.
    expect(credentialIssueKinds(settings.credentialIssues)).toMatchObject({ locked: true, unsupported: false });

    // An unrelated save neither fails nor writes the ciphertext out as a token value.
    store.setSetting("theme", "dark");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe(encryptedUnder("NovelAI Old Name", "old-secret"));

    // Entering the token again replaces it with one this app can read.
    store.setToken("new-secret");
    expect(store.getToken()).toBe("new-secret");
    expect(store.getAccountSummary().hasToken).toBe(true);
    expect(store.getSettings().credentialIssues).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe(encryptedUnder("MCP for NovelAI", "new-secret"));
    vi.resetModules();
    const reloaded = await import("./store");
    expect(reloaded.getToken()).toBe("new-secret");
  });

  it("also reads as no token when the OS key store is unavailable", async () => {
    writeSettingsFile(encryptedUnder("MCP for NovelAI", "secret"));
    state.available = false;
    const store = await import("./store");
    expect(() => store.getAccountSummary()).not.toThrow();
    expect(store.getAccountSummary().hasToken).toBe(false);
    expect(store.getSettings().credentialIssues).toEqual(["token"]);
    // Without a key store a new token cannot be stored encrypted; saving it fails with a message instead of writing plaintext.
    expect(() => store.setToken("new-secret")).toThrow("本地凭据加密暂不可用");
  });
});

describe("a token saved in plaintext (not this version's encrypted format)", () => {
  it("is not used, is reported, and is dropped from the settings file on the next write", async () => {
    const file = writeSettingsFile("plain-secret");
    const store = await import("./store");
    expect(store.getToken()).toBe("");
    expect(store.getAccountSummary().hasToken).toBe(false);
    const settings = store.getSettings();
    expect(settings.credentialIssues).toEqual(["token:unsupported-format"]);
    // The settings page shows its "not this version's format" banner (set.acc.credFormat).
    expect(credentialIssueKinds(settings.credentialIssues)).toMatchObject({ locked: false, unsupported: true });
    // The next write leaves the plaintext out; the notice stays until a token is entered again.
    store.setSetting("theme", "dark");
    const written = fs.readFileSync(file, "utf8");
    expect(written).not.toContain("plain-secret");
    expect(JSON.parse(written).token).toBe("");
    expect(store.getSettings().credentialIssues).toEqual(["token:unsupported-format"]);
    store.setToken("new-secret");
    expect(store.getSettings().credentialIssues).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe(encryptedUnder("MCP for NovelAI", "new-secret"));
    vi.resetModules();
    const reloaded = await import("./store");
    expect(reloaded.getToken()).toBe("new-secret");
    expect(reloaded.getSettings().credentialIssues).toEqual([]);
  });

  it("leaves an encrypted token as it was", async () => {
    writeSettingsFile(encryptedUnder("MCP for NovelAI", "kept-secret"));
    const store = await import("./store");
    expect(store.getToken()).toBe("kept-secret");
    expect(store.getAccountSummary().hasToken).toBe(true);
    expect(store.getSettings().credentialIssues).toEqual([]);
  });

  it("keeps the unavailable-encryption behaviour: still unused and reported, and a new token is refused rather than written in plaintext", async () => {
    const file = writeSettingsFile("plain-secret");
    state.available = false;
    const store = await import("./store");
    expect(store.getToken()).toBe("");
    expect(store.getSettings().credentialIssues).toEqual(["token:unsupported-format"]);
    expect(() => store.setToken("new-secret")).toThrow("本地凭据加密暂不可用");
    expect(fs.readFileSync(file, "utf8")).not.toContain("new-secret");
  });
});

describe("the backup generations of a settings file with a plaintext token", () => {
  it("lose the plaintext in the write that drops it, keep every other field and still recover; .corrupt-* copies stay", async () => {
    const file = writeSettingsFile("plain-secret");
    const generation = (token: string, language: string) => JSON.stringify({ token, settings: { hasOnboarded: true, language, outputDir: path.join(state.root, "out") }, history: [], historyGroups: [] });
    fs.writeFileSync(`${file}.bak`, generation("old-plain-one", "zh-CN"));
    fs.writeFileSync(`${file}.bak2`, generation("old-plain-two", "en-US"));
    fs.writeFileSync(`${file}.corrupt-1`, generation("corrupt-plain", "en-US"));
    const store = await import("./store");
    expect(store.getToken()).toBe("");
    store.setSetting("theme", "dark");
    const userData = path.dirname(file), contents = Object.fromEntries(fs.readdirSync(userData).map(name => [name, fs.readFileSync(path.join(userData, name), "utf8")]));
    expect(Object.keys(contents).sort()).toEqual(["settings.json", "settings.json.bak", "settings.json.bak2", "settings.json.corrupt-1"]);
    for (const [name, text] of Object.entries(contents)) if (name !== "settings.json.corrupt-1") for (const secret of ["plain-secret", "old-plain-one", "old-plain-two"]) expect(text, `${name}: ${secret}`).not.toContain(secret);
    // The backups are the previous file and the previous .bak, each with an empty token and nothing else changed.
    expect(JSON.parse(contents["settings.json.bak"])).toMatchObject({ token: "", account: { tier: 3 }, settings: { hasOnboarded: true } });
    expect(JSON.parse(contents["settings.json.bak2"])).toMatchObject({ token: "", settings: { language: "zh-CN" } });
    expect(contents["settings.json.corrupt-1"]).toBe(generation("corrupt-plain", "en-US"));
    // They still serve recovery.
    fs.writeFileSync(file, "{broken");
    vi.resetModules();
    const recovered = await import("./store");
    expect(recovered.getSettings()).toMatchObject({ hasOnboarded: true, theme: "light" });
    expect(recovered.getToken()).toBe("");
  });

  it("delete an unreadable backup only when its text still shows a plaintext token", async () => {
    const file = writeSettingsFile("plain-secret");
    fs.writeFileSync(`${file}.bak`, '{"token": "old-plain-one", "settings": {');
    const store = await import("./store");
    store.setSetting("theme", "dark");
    // .bak2 is the unreadable former .bak (deleted: it shows a plaintext token); .bak is the former file, scrubbed.
    expect(fs.existsSync(`${file}.bak2`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, "utf8")).token).toBe("");
  });

  it("leave encrypted and unreadable token-free backups exactly as they were", async () => {
    const file = writeSettingsFile(encryptedUnder("MCP for NovelAI", "kept-secret"));
    fs.writeFileSync(`${file}.bak`, '{"settings": {');
    const store = await import("./store");
    const before = fs.readFileSync(file, "utf8");
    store.setSetting("theme", "dark");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(before);
    expect(fs.readFileSync(`${file}.bak2`, "utf8")).toBe('{"settings": {');
    expect(store.getToken()).toBe("kept-secret");
  });
});
