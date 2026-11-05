// Save folders (images, backups, logs) are refused inside the application's install directory: installing another
// version replaces it. Electron's paths point into a temporary folder whose "exe" sits directly in it, so that
// folder plays the install directory.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", exe: "" }));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => key === "exe" && state.exe ? state.exe : path.join(state.root, key), isPackaged: true },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } },
}));

const outside: string[] = [];
afterEach(() => {
  vi.resetModules();
  state.exe = "";
  for (const folder of [state.root, ...outside.splice(0)]) if (folder) fs.rmSync(folder, { recursive: true, force: true });
});

describe("save folders and the install directory", () => {
  it("refuses outputDir, backupDir and logDir inside the install directory and accepts them elsewhere", async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-install-dir-"));
    fs.mkdirSync(path.join(state.root, "userData"), { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "nai-install-dir-outside-"));
    outside.push(elsewhere);
    const store = await import("./store");
    for (const key of ["outputDir", "backupDir", "logDir"] as const) {
      expect(() => store.setSetting(key, path.join(state.root, "images", key))).toThrow("install folder");
      expect(store.setSetting(key, path.join(elsewhere, key))).toBe(path.join(elsewhere, key));
    }
  });

  // Replacing a macOS app replaces its whole bundle, not only the Contents/MacOS folder that holds the executable.
  it.runIf(process.platform === "darwin")("refuses save folders anywhere inside the macOS application bundle", async () => {
    state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-install-bundle-"));
    fs.mkdirSync(path.join(state.root, "userData"), { recursive: true });
    const bundle = path.join(state.root, "MCP for NovelAI.app");
    state.exe = path.join(bundle, "Contents", "MacOS", "MCP for NovelAI");
    fs.mkdirSync(path.dirname(state.exe), { recursive: true });
    const store = await import("./store");
    for (const inside of [path.join(bundle, "images"), path.join(bundle, "Contents", "Resources", "images"), path.join(bundle, "Contents", "MacOS", "images")]) {
      expect(() => store.setSetting("outputDir", inside)).toThrow("install folder");
    }
    expect(store.setSetting("outputDir", path.join(state.root, "images"))).toBe(path.join(state.root, "images"));
  });
});
