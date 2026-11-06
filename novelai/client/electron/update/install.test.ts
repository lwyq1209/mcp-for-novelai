// Staging and checking an update next to the app (install.ts) with stand-ins for ditto, plutil, codesign and tar on
// real temporary folders: every refusal removes the staging folder and leaves the running app untouched.
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstallError, installSupport, installTarget, macCertificateSha256, safePathArgument, stageLinuxUpdate, stageMacUpdate, STAGING_PREFIX, type InstallDeps, type RunResult } from "./install";

let root: string;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-install-"))); });
afterEach(() => { try { fs.chmodSync(path.join(root, "Applications"), 0o755); } catch { /* unchanged */ } fs.rmSync(root, { recursive: true, force: true }); });

const certificate = Buffer.from("leaf certificate DER");
const certificateSha = createHash("sha256").update(certificate).digest("hex");

interface MacPackage { bundleId?: string; version?: string; apps?: string[]; codesignOk?: boolean; certificate?: Buffer | null; dittoOk?: boolean }
/** Stand-ins: ditto "extracts" the described package, plutil answers from it, codesign verifies and extracts its certificate. */
function deps(pkg: MacPackage = {}, calls: string[][] = []): InstallDeps {
  const fsDeps: InstallDeps["fs"] = {
    mkdtemp: prefix => fsp.mkdtemp(prefix), mkdir: (dir, options) => fsp.mkdir(dir, options), rm: (target, options) => fsp.rm(target, options),
    rename: (a, b) => fsp.rename(a, b), readdir: dir => fsp.readdir(dir), lstat: target => fsp.lstat(target), readFile: file => fsp.readFile(file),
    writeFile: (file, data, options) => fsp.writeFile(file, data, options), access: (target, mode) => fsp.access(target, mode),
  };
  return {
    fs: fsDeps,
    async run(command, args): Promise<RunResult> {
      calls.push([command, ...args]);
      if (command === "/usr/bin/ditto") {
        if (pkg.dittoOk === false) return { code: 1, stdout: "", stderr: "bad zip" };
        for (const name of pkg.apps ?? ["MCP for NovelAI.app"]) fs.mkdirSync(path.join(args[3], name, "Contents"), { recursive: true });
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/plutil") return { code: 0, stdout: `${args[1] === "CFBundleIdentifier" ? pkg.bundleId ?? "io.github.lwyq1209.mcp-for-novelai" : pkg.version ?? "0.1.4"}\n`, stderr: "" };
      if (command === "/usr/bin/codesign" && args[0] === "--verify") return { code: pkg.codesignOk === false ? 3 : 0, stdout: "", stderr: "" };
      if (command === "/usr/bin/codesign" && args[0] === "-d") {
        const prefix = args[1].slice("--extract-certificates=".length);
        const cert = pkg.certificate === undefined ? certificate : pkg.certificate;
        if (cert) fs.writeFileSync(`${prefix}0`, cert);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "/usr/bin/tar" || command === "/bin/tar") {
        fs.mkdirSync(path.join(args[3], "MCP-for-NovelAI-0.1.4-linux-x64", "resources"), { recursive: true });
        fs.writeFileSync(path.join(args[3], "MCP-for-NovelAI-0.1.4-linux-x64", "mcp-for-novelai"), "#!/bin/sh\n", { mode: 0o755 });
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: "unexpected" };
    },
    packagedVersion: async () => pkg.version ?? "0.1.4",
    exists: file => file === "/usr/bin/tar",
  };
}
function macApp() {
  const target = path.join(root, "Applications", "MCP for NovelAI.app");
  fs.mkdirSync(path.join(target, "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(target, "Contents", "MacOS", "MCP for NovelAI"), "old");
  return target;
}
const leftovers = () => fs.readdirSync(path.join(root, "Applications")).filter(name => name.startsWith(STAGING_PREFIX));
const stageMac = (pkg: MacPackage, target = macApp()) => stageMacUpdate({ deps: deps(pkg), archive: path.join(root, "update.zip"), target, version: "0.1.4", bundleId: "io.github.lwyq1209.mcp-for-novelai", expectedCertificateSha256: certificateSha });
const failure = async (promise: Promise<unknown>) => { try { await promise; return "ok"; } catch (error) { return error instanceof InstallError ? error.code : String(error); } };

describe("where the app is installed", () => {
  it("is the .app bundle on macOS and the executable's folder elsewhere", () => {
    expect(installTarget("darwin", "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI")).toEqual({ target: "/Applications/MCP for NovelAI.app", executable: "MCP for NovelAI" });
    expect(installTarget("darwin", "/usr/local/bin/node")).toBeNull();
    expect(installTarget("darwin", "/A.app/Contents/MacOS/x/y")).toBeNull();
    expect(installTarget("linux", "/home/u/apps/mcp-for-novelai/mcp-for-novelai")).toEqual({ target: "/home/u/apps/mcp-for-novelai", executable: "mcp-for-novelai" });
    expect(installTarget("win32", "C:\\Users\\u\\AppData\\Local\\Programs\\mcp-for-novelai\\MCP for NovelAI.exe")).toEqual({ target: "C:\\Users\\u\\AppData\\Local\\Programs\\mcp-for-novelai", executable: "MCP for NovelAI.exe" });
  });

  it("hands the helper only absolute, normalised paths without control characters (and no quotes on Windows)", () => {
    expect(safePathArgument("darwin", "/Applications/MCP for NovelAI.app")).toBe(true);
    expect(safePathArgument("win32", "C:\\Users\\Zoë 李\\AppData\\Local\\Programs\\mcp-for-novelai")).toBe(true);
    for (const value of ["relative/path", "/a/../b", "/a/b\nrm -rf ~", "/a/\u0000b", "", "/a//b"]) expect(safePathArgument("linux", value), JSON.stringify(value)).toBe(false);
    expect(safePathArgument("win32", "C:\\a\"b")).toBe(false);
  });
});

const posix = process.platform !== "win32";

describe("whether the app can update itself here", () => {
  const support = (platform: NodeJS.Platform, execPath: string, extra: Partial<Parameters<typeof installSupport>[0]> = {}) => installSupport({ platform, execPath, packaged: true, env: {}, deps: deps(), ...extra });

  it.runIf(posix)("needs a packaged app in a writable folder", async () => {
    const target = macApp();
    const exe = path.join(target, "Contents", "MacOS", "MCP for NovelAI");
    expect(await support("darwin", exe)).toBeNull();
    expect(await support("darwin", exe, { packaged: false })).toBe("not_packaged");
    expect(await support("darwin", "/private/var/folders/x/AppTranslocation/ABC/d/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI")).toBe("translocated");
    expect(await support("freebsd" as NodeJS.Platform, exe)).toBe("platform");
    if (process.getuid?.() !== 0) {
      fs.chmodSync(path.join(root, "Applications"), 0o555);
      expect(await support("darwin", exe)).toBe("not_writable");
    }
  });

  it.runIf(posix)("Linux: refuses a folder whose chrome-sandbox root set up (setuid), which the app cannot carry over", async () => {
    const folder = path.join(root, "Applications", "mcp-for-novelai");
    fs.mkdirSync(folder, { recursive: true });
    const base = deps();
    const setuid: InstallDeps = { ...base, fs: { ...base.fs, lstat: async target => target.endsWith("chrome-sandbox") ? { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: 0o104755, uid: 0 } : fsp.lstat(target) } };
    expect(await support("linux", path.join(folder, "mcp-for-novelai"))).toBeNull();
    expect(await support("linux", path.join(folder, "mcp-for-novelai"), { deps: setuid })).toBe("sandbox_helper");
  });

  it("Windows: only a per-user NSIS installation (Program Files needs an administrator)", async () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)" };
    expect(await support("win32", "C:\\Program Files\\MCP for NovelAI\\MCP for NovelAI.exe", { env })).toBe("per_machine");
    expect(await support("win32", "C:\\Program Files (x86)\\MCP for NovelAI\\MCP for NovelAI.exe", { env })).toBe("per_machine");
    const base = deps();
    const installed = (uninstaller: boolean, writable: boolean): InstallDeps => ({ ...base, fs: { ...base.fs,
      lstat: async () => { if (!uninstaller) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return { isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false, mode: 0o644, uid: 1 }; },
      access: async () => { if (!writable) throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
    const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\mcp-for-novelai\\MCP for NovelAI.exe";
    expect(await support("win32", exe, { env, deps: installed(true, true) })).toBeNull();
    expect(await support("win32", exe, { env, deps: installed(false, true) })).toBe("not_installed");
    expect(await support("win32", exe, { env, deps: installed(true, false) })).toBe("not_writable");
  });
});

describe.runIf(posix)("macOS: the new version is staged next to the app and checked there", () => {
  it("extracts it, checks bundle identifier, version, signature and certificate, and stages it under the app's own name", async () => {
    const target = macApp();
    const calls: string[][] = [];
    const staged = await stageMacUpdate({ deps: deps({}, calls), archive: path.join(root, "update.zip"), target, version: "0.1.4", bundleId: "io.github.lwyq1209.mcp-for-novelai", expectedCertificateSha256: certificateSha.toUpperCase() });
    expect(path.dirname(staged.staging)).toBe(path.dirname(target));
    expect(path.basename(staged.staging).startsWith(STAGING_PREFIX)).toBe(true);
    expect(staged.staged).toBe(path.join(staged.staging, "new", "MCP for NovelAI.app"));
    expect(fs.existsSync(staged.staged)).toBe(true);
    expect(fs.readdirSync(staged.staging).sort()).toEqual(["new"]);
    expect(calls.map(call => call[0] + " " + call[1])).toEqual(["/usr/bin/ditto -x", "/usr/bin/plutil -extract", "/usr/bin/plutil -extract", "/usr/bin/codesign --verify", `/usr/bin/codesign -d`]);
    expect(calls[3]).toEqual(["/usr/bin/codesign", "--verify", "--deep", "--strict", expect.stringContaining("/extract/MCP for NovelAI.app")]);
    // The running app is untouched.
    expect(fs.readFileSync(path.join(target, "Contents", "MacOS", "MCP for NovelAI"), "utf8")).toBe("old");
  });

  it("refuses another app, another version, a bad signature, another certificate, an ad-hoc build and odd packages, leaving nothing behind", async () => {
    const cases: Array<[MacPackage, string]> = [
      [{ bundleId: "com.example.other" }, "package_invalid"],
      [{ version: "0.1.5" }, "package_invalid"],
      [{ codesignOk: false }, "signature_mismatch"],
      [{ certificate: Buffer.from("another certificate") }, "signature_mismatch"],
      [{ certificate: null }, "signature_mismatch"],
      [{ apps: ["MCP for NovelAI.app", "Second.app"] }, "package_invalid"],
      [{ apps: ["not-an-app"] }, "package_invalid"],
      [{ apps: [] }, "package_invalid"],
      [{ dittoOk: false }, "extract_failed"],
    ];
    const target = macApp();
    for (const [pkg, expected] of cases) {
      expect(await failure(stageMac(pkg, target)), JSON.stringify(pkg)).toBe(expected);
      expect(leftovers(), JSON.stringify(pkg)).toEqual([]);
    }
    expect(fs.readFileSync(path.join(target, "Contents", "MacOS", "MCP for NovelAI"), "utf8")).toBe("old");
  });

  it("says not_writable when no staging folder can be made next to the app", async () => {
    if (process.getuid?.() === 0) return;
    const target = macApp();
    fs.chmodSync(path.join(root, "Applications"), 0o555);
    const error = await stageMac({}, target).catch(e => e);
    expect([error.code, error.reason]).toEqual(["not_writable", "not_writable"]);
  });

  it("reads the leaf certificate's SHA-256 of a bundle, and none for an ad-hoc signature", async () => {
    expect(await macCertificateSha256(deps(), "/x.app", root)).toBe(certificateSha);
    expect(await macCertificateSha256(deps({ certificate: null }), "/x.app", root)).toBeNull();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe.runIf(posix)("Linux: the new folder is staged next to the app", () => {
  it("extracts the archive and checks the executable and the packaged version", async () => {
    const target = path.join(root, "Applications", "mcp-for-novelai");
    fs.mkdirSync(target, { recursive: true });
    const staged = await stageLinuxUpdate({ deps: deps(), archive: path.join(root, "u.tar.gz"), target, executable: "mcp-for-novelai", version: "0.1.4" });
    expect(staged.staged).toBe(path.join(staged.staging, "new", "mcp-for-novelai"));
    expect(fs.existsSync(path.join(staged.staged, "mcp-for-novelai"))).toBe(true);
    expect(await failure(stageLinuxUpdate({ deps: deps({ version: "0.1.5" }), archive: "/x", target, executable: "mcp-for-novelai", version: "0.1.4" }))).toBe("package_invalid");
    expect(await failure(stageLinuxUpdate({ deps: deps(), archive: "/x", target, executable: "other-name", version: "0.1.4" }))).toBe("package_invalid");
    expect(leftovers().length).toBe(1); // the first, successful one
  });
});
