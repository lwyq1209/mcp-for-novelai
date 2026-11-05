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

  it("keeps an outputDir already saved in the settings, isolated or not", async () => {
    const root = temporaryRoot();
    const chosen = path.join(root, "chosen output");
    fs.writeFileSync(path.join(root, "userData", "settings.json"), JSON.stringify({ settings: { outputDir: chosen }, history: [], historyGroups: [] }));
    process.env.NOVELAI_DATA_DIR = path.join(root, "isolated data");
    const store = await import("./store");
    expect(store.getSettings().outputDir).toBe(chosen);
  });
});
