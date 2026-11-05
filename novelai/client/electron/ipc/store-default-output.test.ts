// Step 3a review rework (P1-1): the default image output folder follows the data root's isolation. With
// NOVELAI_DATA_DIR set it is <data root>/output; without it <Pictures>/MCP for NovelAI. A saved outputDir always wins.
// Electron's paths point into a temporary folder; NOVELAI_DATA_DIR is set or removed per test and restored after.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => path.join(state.root, key), isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } },
}));

const originalDataDir = process.env.NOVELAI_DATA_DIR;
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.NOVELAI_DATA_DIR; else process.env.NOVELAI_DATA_DIR = originalDataDir;
  vi.resetModules();
  if (state.root) fs.rmSync(state.root, { recursive: true, force: true });
});
function temporaryRoot() {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-default-output-"));
  fs.mkdirSync(path.join(state.root, "userData"), { recursive: true });
  return state.root;
}

describe("default outputDir", () => {
  it("is <data root>/output when NOVELAI_DATA_DIR isolates the run", async () => {
    const root = temporaryRoot();
    process.env.NOVELAI_DATA_DIR = path.join(root, "isolated data");
    const store = await import("./store");
    expect(store.defaultSettings().outputDir).toBe(path.join(root, "isolated data", "output"));
    expect(store.getSettings().outputDir).toBe(path.join(root, "isolated data", "output"));
    expect(store.getSettings().outputDir.startsWith(path.join(root, "pictures"))).toBe(false);
  });

  it("is <Pictures>/MCP for NovelAI on the default data root", async () => {
    const root = temporaryRoot();
    delete process.env.NOVELAI_DATA_DIR;
    const store = await import("./store");
    expect(store.defaultSettings().outputDir).toBe(path.join(root, "pictures", "MCP for NovelAI"));
  });

  it("an agent's first start of a fresh default data root (NOVELAI_DATA_DIR = that root) saves <Pictures>/MCP for NovelAI (review rework P2-1)", async () => {
    const root = temporaryRoot();
    // A throwaway home, so the default data root computed from it is inside the test folder.
    const home = path.join(root, "home");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    try {
      process.env.HOME = home; process.env.USERPROFILE = home; process.env.APPDATA = path.join(home, "AppData", "Roaming"); delete process.env.XDG_CONFIG_HOME;
      const { defaultDataRoot } = await import("../../shared/runtime/data-paths.cjs");
      process.env.NOVELAI_DATA_DIR = `${defaultDataRoot()}${path.sep}`;
      expect(process.env.NOVELAI_DATA_DIR.startsWith(home)).toBe(true);
      const store = await import("./store");
      expect(store.getSettings().outputDir).toBe(path.join(root, "pictures", "MCP for NovelAI"));
      const written = JSON.parse(fs.readFileSync(path.join(root, "userData", "settings.json"), "utf8"));
      expect(written.settings.outputDir).toBe(path.join(root, "pictures", "MCP for NovelAI"));
    } finally {
      for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it("keeps an outputDir already saved in the settings, isolated or not", async () => {
    const root = temporaryRoot();
    const chosen = path.join(root, "chosen output");
    fs.writeFileSync(path.join(root, "userData", "settings.json"), JSON.stringify({ settings: { outputDir: chosen }, history: [], historyGroups: [] }));
    process.env.NOVELAI_DATA_DIR = path.join(root, "isolated data");
    const store = await import("./store");
    expect(store.getSettings().outputDir).toBe(chosen);
  });
});
