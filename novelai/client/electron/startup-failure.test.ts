import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataRootFailureDialog, prepareDataRoot, startupFailureDialog } from "./startup-failure";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    try { fs.chmodSync(root, 0o700); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const temporary = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-startup-failure-")); roots.push(root); return root; };
const canDenyWrites = process.platform !== "win32" && process.getuid?.() !== 0;

describe("the data folder check before anything starts", () => {
  it("creates the data root and its runtime folder and leaves no probe file behind", () => {
    const root = path.join(temporary(), "data"), runtime = path.join(root, "runtime");
    expect(prepareDataRoot({ root, runtime })).toBeNull();
    expect(fs.readdirSync(root)).toEqual(["runtime"]);
    expect(fs.readdirSync(runtime)).toEqual([]);
  });

  it.runIf(canDenyWrites)("reports an existing folder that cannot be written", () => {
    const root = temporary();
    fs.chmodSync(root, 0o500);
    expect(prepareDataRoot({ root, runtime: path.join(root, "runtime") })).toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
  });

  it.runIf(canDenyWrites)("reports a writable root whose existing runtime folder is read-only", () => {
    const root = temporary(), runtime = path.join(root, "runtime");
    fs.mkdirSync(runtime); fs.chmodSync(runtime, 0o500);
    try { expect(prepareDataRoot({ root, runtime })).toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) }); }
    finally { fs.chmodSync(runtime, 0o700); }
    expect(fs.readdirSync(root)).toEqual(["runtime"]);
  });

  it("reports a data root below a regular file", () => {
    const file = path.join(temporary(), "not-a-folder");
    fs.writeFileSync(file, "x");
    expect(prepareDataRoot({ root: path.join(file, "data"), runtime: path.join(file, "data", "runtime") })).toMatchObject({ code: expect.stringMatching(/^(ENOTDIR|EEXIST|ENOENT)$/) });
  });
});

describe("startup error dialogs", () => {
  it("name the unusable data folder, its source and the reason in Chinese and English", () => {
    const error = Object.assign(new Error("permission denied, mkdir '/Volumes/RO/data'"), { code: "EACCES" });
    const plain = dataRootFailureDialog("/Volumes/RO/data", error, false);
    expect(plain.title).toBe("数据文件夹不可用 / Data folder not usable");
    for (const text of ["无法在数据文件夹中创建或写入文件", "数据文件夹：/Volumes/RO/data", "cannot create or write files in its data folder", "Data folder: /Volumes/RO/data", "EACCES: permission denied", "NOVELAI_DATA_DIR"]) expect(plain.message).toContain(text);
    const custom = dataRootFailureDialog("/Volumes/RO/data", error, true);
    expect(custom.message).toContain("（由环境变量 NOVELAI_DATA_DIR 指定）");
    expect(custom.message).toContain("(set by the environment variable NOVELAI_DATA_DIR)");
    // A message that already names its code does not repeat it.
    expect(dataRootFailureDialog("/d", Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" }), false).message).toContain("原因：EROFS: read-only file system\n");
  });

  it("tell a bridge failure apart from a library failure", () => {
    const bridge = startupFailureDialog("bridge", new Error("listen EADDRINUSE"), "/data/runtime");
    expect(bridge.title).toBe("AI 接入服务未能启动 / AI access could not start");
    for (const text of ["AI 接入服务", "/data/runtime", "另一个 MCP for NovelAI", "AI access bridge", "listen EADDRINUSE"]) expect(bridge.message).toContain(text);
    expect(bridge.message).not.toMatch(/素材库|library\.sqlite|启动检查/);
    const library = startupFailureDialog("library", new Error("database is locked"), "/data/runtime");
    expect(library.title).toBe("素材库未能打开 / Library could not be opened");
    for (const text of ["不要删除或替换 library.sqlite", "新建一个空的素材库", "do not delete or replace library.sqlite", "creates a new, empty library", "database is locked"]) expect(library.message).toContain(text);
    // There is no older snapshot to fall back to: the library has one store.
    expect(library.message).not.toMatch(/快照|snapshot/i);
    const other = startupFailureDialog("startup", "boom", "/data/runtime");
    expect(other.title).toBe("启动未完成 / Startup did not complete");
    expect(other.message).toContain("原因：boom"); expect(other.message).not.toMatch(/素材库|AI 接入/);
  });

  it("are wired into the main process: the data folder check runs before userData is set and every start failure names its step", () => {
    const main = fs.readFileSync(path.join(process.cwd(), "electron", "main.ts"), "utf8");
    const check = main.indexOf("const dataRootFailure = prepareDataRoot(dataPaths);");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(main.indexOf('app.setPath("userData", dataPaths.root);'));
    expect(main).toContain("dialog.showErrorBox(failure.title, failure.message);\n  process.exit(1);");
    expect(main).toContain('startupStep = "bridge";\n  workspaceBridge = await startWorkspaceBridge(');
    expect(main).toContain("const failure = startupFailureDialog(startupStep, error, dataPaths.runtime);");
    expect(main).not.toContain("素材库或启动检查失败");
    expect(main).not.toMatch(/fs\.mkdirSync\(dataPaths\.(root|runtime)/);
  });
});
