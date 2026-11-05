// Step 3a: the single data-root module shared by the client and the MCP server (shared/runtime/data-paths.cjs),
// and the startup order main.ts depends on. Pure path computation; nothing here touches a real data folder.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_DATA_DIR_NAME, DEFAULT_OUTPUT_FOLDER_NAME, PROJECT_FOLDERS, SETTINGS_FILE_NAME, appDataDirectory, dataPathsFor, defaultOutputDirectory, projectDirectories, resolveDataPaths, resolveDataRoot, resolveProjectRoot, isTestProcess,
} from "../shared/runtime/data-paths.cjs";

describe("data root", () => {
  it("is mcp-for-novelai in Electron's appData folder on each platform", () => {
    expect(APP_DATA_DIR_NAME).toBe("mcp-for-novelai");
    expect(resolveDataRoot({ platform: "darwin", env: {}, homedir: "/Users/u" })).toBe("/Users/u/Library/Application Support/mcp-for-novelai");
    expect(resolveDataRoot({ platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, homedir: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming\\mcp-for-novelai");
    expect(resolveDataRoot({ platform: "linux", env: {}, homedir: "/home/u" })).toBe("/home/u/.config/mcp-for-novelai");
    expect(resolveDataRoot({ platform: "linux", env: { XDG_CONFIG_HOME: "/data/config" }, homedir: "/home/u" })).toBe("/data/config/mcp-for-novelai");
  });

  it("falls back like Electron when APPDATA or XDG_CONFIG_HOME is missing, blank or relative", () => {
    expect(appDataDirectory({ platform: "win32", env: {}, homedir: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming");
    expect(appDataDirectory({ platform: "win32", env: { APPDATA: "   " }, homedir: "C:\\Users\\u" })).toBe("C:\\Users\\u\\AppData\\Roaming");
    expect(appDataDirectory({ platform: "linux", env: { XDG_CONFIG_HOME: "relative/config" }, homedir: "/home/u" })).toBe("/home/u/.config");
    expect(appDataDirectory({ platform: "freebsd", env: {}, homedir: "/home/u" })).toBe("/home/u/.config");
  });

  it("NOVELAI_DATA_DIR replaces the whole data root on every platform (trimmed, made absolute)", () => {
    expect(resolveDataRoot({ platform: "darwin", env: { NOVELAI_DATA_DIR: "/tmp/isolated" }, homedir: "/Users/u" })).toBe("/tmp/isolated");
    expect(resolveDataRoot({ platform: "linux", env: { NOVELAI_DATA_DIR: "  /srv/nai/data  ", XDG_CONFIG_HOME: "/x" }, homedir: "/home/u" })).toBe("/srv/nai/data");
    expect(resolveDataRoot({ platform: "win32", env: { NOVELAI_DATA_DIR: "D:\\nai-data", APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, homedir: "C:\\Users\\u" })).toBe("D:\\nai-data");
    expect(resolveDataRoot({ platform: process.platform, env: { NOVELAI_DATA_DIR: "relative-data" } })).toBe(path.resolve("relative-data"));
    expect(resolveDataRoot({ platform: "darwin", env: { NOVELAI_DATA_DIR: "   " }, homedir: "/Users/u" })).toBe("/Users/u/Library/Application Support/mcp-for-novelai");
  });

  it("lays the library, runtime, backups, logs and workspace out under the root", () => {
    const paths = dataPathsFor("/data", { platform: "linux" });
    expect(paths).toEqual({
      root: "/data", library: "/data/library", libraryDatabase: "/data/library.sqlite", studies: "/data/library/studies",
      runtime: "/data/runtime", bridgeFile: "/data/runtime/bridge.json", tagDictionary: "/data/runtime/tag-dictionary",
      tagQueryCache: "/data/runtime/public-tag-query-cache-v1", backups: "/data/backups", logs: "/data/logs", imageInputs: "/data/image-inputs", workspace: "/data/workspace",
    });
    expect(resolveDataPaths({ platform: "win32", env: { NOVELAI_DATA_DIR: "D:\\d" } }).bridgeFile).toBe("D:\\d\\runtime\\bridge.json");
    expect(DEFAULT_OUTPUT_FOLDER_NAME).toBe("MCP for NovelAI");
    expect(SETTINGS_FILE_NAME).toBe("settings.json");
  });
});

describe("default image output folder", () => {
  it("is <Pictures>/MCP for NovelAI on the default data root", () => {
    expect(defaultOutputDirectory("/Users/u/Pictures", { platform: "darwin", env: {}, homedir: "/Users/u" })).toBe("/Users/u/Pictures/MCP for NovelAI");
    expect(defaultOutputDirectory("C:\\Users\\u\\Pictures", { platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" } })).toBe("C:\\Users\\u\\Pictures\\MCP for NovelAI");
    expect(defaultOutputDirectory("/home/u/Pictures", { platform: "linux", env: { NOVELAI_DATA_DIR: "  " }, homedir: "/home/u" })).toBe("/home/u/Pictures/MCP for NovelAI");
  });

  it("is <data root>/output when NOVELAI_DATA_DIR isolates the run, so no image reaches the real Pictures folder", () => {
    expect(defaultOutputDirectory("/Users/u/Pictures", { platform: "darwin", env: { NOVELAI_DATA_DIR: "/tmp/isolated" }, homedir: "/Users/u" })).toBe("/tmp/isolated/output");
    expect(defaultOutputDirectory("C:\\Users\\u\\Pictures", { platform: "win32", env: { NOVELAI_DATA_DIR: "D:\\测试 数据" } })).toBe("D:\\测试 数据\\output");
  });
});

describe("project root of the inbox and export folders", () => {
  it("is NOVELAI_PROJECT_ROOT when set, otherwise <data root>/workspace", () => {
    expect(resolveProjectRoot({ platform: "linux", env: { NOVELAI_PROJECT_ROOT: "/work/my-project", NOVELAI_DATA_DIR: "/data" } })).toEqual({ root: "/work/my-project", source: "NOVELAI_PROJECT_ROOT" });
    expect(resolveProjectRoot({ platform: "linux", env: { NOVELAI_DATA_DIR: "/data" } })).toEqual({ root: "/data/workspace", source: "data-dir-workspace" });
    expect(resolveProjectRoot({ platform: "darwin", env: { NOVELAI_PROJECT_ROOT: " " }, homedir: "/Users/u" })).toEqual({ root: "/Users/u/Library/Application Support/mcp-for-novelai/workspace", source: "data-dir-workspace" });
  });

  it("keeps the novelai/<folder> layout under either root", () => {
    expect(PROJECT_FOLDERS).toEqual({ materialInbox: "novelai/library-inbox", materialExports: "novelai/library-exports", studyInbox: "novelai/study-inbox", studyExports: "novelai/study-exports" });
    expect(projectDirectories("/work/p", { platform: "linux" })).toEqual({ materialInbox: "/work/p/novelai/library-inbox", materialExports: "/work/p/novelai/library-exports", studyInbox: "/work/p/novelai/study-inbox", studyExports: "/work/p/novelai/study-exports" });
    expect(projectDirectories("C:\\data\\workspace", { platform: "win32" }).studyInbox).toBe("C:\\data\\workspace\\novelai\\study-inbox");
  });
});

describe("main.ts startup (single run mode)", () => {
  const main = readFileSync("electron/main.ts", "utf8");
  it("refuses UI capture without NOVELAI_DATA_DIR before any data folder is resolved or created", () => {
    const guard = main.indexOf("const uiCaptureRefused = uiCaptureRefusal(process.env);");
    expect(guard).toBeGreaterThan(0);
    expect(main.slice(guard, guard + 200)).toMatch(/fs\.writeSync\(2, uiCaptureRefused\);\s*process\.exit\(2\);/);
    for (const later of ["const dataPaths = resolveDataPaths();", "prepareDataRoot(dataPaths)", 'app.setPath("userData"', "requestSingleInstanceLock()"]) expect(guard).toBeLessThan(main.indexOf(later));
  });

  it("admits restored workbench inputs only from <data root>/image-inputs, the folder pasted sources are saved to", () => {
    expect(main).toContain("registerWorkbenchSync(() => mainWindow, dataPaths.imageInputs);");
    expect(readFileSync("electron/ipc/image-clipboard.ts", "utf8")).toContain('dataPathsFor(app.getPath("userData")).imageInputs');
  });

  it("pins userData to the data root, with its runtime folder, before the single-instance lock and the library opens", () => {
    const pin = main.indexOf('app.setPath("userData", dataPaths.root);');
    expect(main.indexOf("const dataPaths = resolveDataPaths();")).toBeGreaterThan(0);
    // prepareDataRoot (startup-failure.ts) creates the data root and its runtime folder and checks they can be written.
    expect(main.indexOf("const dataRootFailure = prepareDataRoot(dataPaths);")).toBeGreaterThan(0);
    expect(main.indexOf("const dataRootFailure = prepareDataRoot(dataPaths);")).toBeLessThan(pin);
    expect(pin).toBeGreaterThan(0);
    expect(pin).toBeLessThan(main.indexOf("requestSingleInstanceLock()"));
    expect(pin).toBeLessThan(main.indexOf("await initializeAssetLibrary({ userDataRoot: dataPaths.root, libraryDirectory: dataPaths.library });"));
  });

  it("always registers the bridge, queue and material services and starts the bridge in <data root>/runtime", () => {
    expect(main).toContain("startWorkspaceBridge(() => mainWindow, dataPaths.runtime, queueMethods, (method, caller) => agentActivity?.record(method, caller))");
    expect(main).toContain("createQueueRecipeService({ runtimeDir: dataPaths.runtime");
    expect(main).toContain("directory: dataPaths.library");
    expect(main).toContain("libraryDirectory: dataPaths.library");
    for (const removed of ["NOVELAI_BRIDGE_RUNTIME_DIR", "pinUserDataAndMigrate", "recoverLegacyCredentials", "NAI_UI_CAPTURE_USER_DATA", "wireAutoUpdater", "'../../..'"]) expect(main).not.toContain(removed);
  });

  it("loads the tag modules from its own build, never from outside the client directory", () => {
    expect(main).toContain('require(path.join(__dirname, "..", "vendor", "tag-details.cjs"))');
    expect(main).not.toContain("pathToFileURL");
    expect(main).not.toMatch(/path\.(?:join|resolve)\([^)]*src\/tag-details/);
    expect(readFileSync("electron/bootstrap.ts", "utf8").trim().split("\n").filter(line => !line.startsWith("//"))).toEqual(['require("./main");']);
    expect(readFileSync("electron/preload.ts", "utf8")).not.toMatch(/workspaceEnabled/i);
  });
});

describe("test isolation (review rework 2)", () => {
  it("a Vitest worker is a test process; with NOVELAI_DATA_DIR removed it is refused the default root, explicit options still compute", () => {
    expect(isTestProcess()).toBe(true);
    expect(isTestProcess({}, { execArgv: [], argv: ["node", "/x/main.js"] })).toBe(false);
    expect(isTestProcess({ NODE_TEST_CONTEXT: "child-v8" }, { execArgv: [] })).toBe(true);
    expect(isTestProcess({}, { execArgv: ["--test-isolation=none"] })).toBe(true);
    expect(isTestProcess({}, { execArgv: [], argv: ["node", "/x/a.test.mjs"] })).toBe(true);
    // A child as one Vitest file run without the config's data root would be (VITEST set, no NOVELAI_DATA_DIR), with a
    // throwaway HOME so nothing real could be touched even by a regression.
    const home = mkdtempSync(path.join(os.tmpdir(), "isolation-home-"));
    try {
      const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, VITEST: "true" };
      delete env.NOVELAI_DATA_DIR; delete env.NOVELAI_PROJECT_ROOT;
      const script = `const p = require(${JSON.stringify(path.resolve("shared/runtime/data-paths.cjs"))}); const r = f => { try { return f(); } catch (e) { return e.code; } };
console.log(JSON.stringify([r(() => p.resolveDataRoot()), r(() => p.resolveProjectRoot()), r(() => p.defaultOutputDirectory("/x/Pictures")), p.resolveDataRoot({ env: {}, platform: "linux", homedir: "/home/u" })]));`;
      const result = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8" });
      expect(JSON.parse(result.stdout.trim())).toEqual(["test_isolation_required", "test_isolation_required", "/x/Pictures/MCP for NovelAI", "/home/u/.config/mcp-for-novelai"]);
      expect(readdirSync(home)).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
