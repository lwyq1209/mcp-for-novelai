// Where the running app is installed, whether the app can replace itself there, and the checked new version made
// ready next to it (macOS, Linux) or the installer to run (Windows). Every system call goes through InstallDeps, so the
// steps and their clean-up after a failure are tested with stand-ins (install.test.ts).
//
// macOS: the .app bundle of the running executable. The update zip is extracted with ditto into a staging folder next
//   to the bundle (<parent>/.mcp-for-novelai-update-<random>/, the same volume, so the helper's swap is two renames);
//   the extracted app must be exactly one .app with this app's bundle identifier and the release version, pass
//   `codesign --verify --deep --strict`, and be signed by the certificate of the running app (SHA-256 of the leaf
//   certificate) — or, when the running app has none (an ad-hoc signed build), by the certificate built into it.
// Linux: the folder of the running executable (the extracted tar.gz). The archive is extracted into the same kind of
//   staging folder; it must hold exactly one folder with this app's executable, resources/app.asar and the release
//   version in its package.json. A chrome-sandbox set up by root (setuid) cannot be carried over, so such a folder is
//   updated by hand (sandbox_helper).
// Windows: the NSIS installation folder of the running executable (per user: %LOCALAPPDATA%\Programs\…); the helper
//   runs the checked installer silently into the same folder. A per-machine installation (Program Files) would need
//   elevation and is updated by hand (per_machine).
import path from "node:path";
import { createHash } from "node:crypto";

export type InstallUnsupportedReason = "not_packaged" | "platform" | "translocated" | "read_only" | "not_writable" | "per_machine" | "not_installed" | "sandbox_helper" | "unknown_layout";

export class InstallError extends Error {
  constructor(readonly code: "install_unsupported" | "package_invalid" | "signature_mismatch" | "extract_failed" | "not_writable", message: string, readonly reason?: InstallUnsupportedReason) {
    super(message);
    this.name = "InstallError";
  }
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
export interface InstallDeps {
  run(command: string, args: string[], options?: { timeoutMs?: number }): Promise<RunResult>;
  fs: {
    mkdtemp(prefix: string): Promise<string>;
    mkdir(dir: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
    rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    readdir(dir: string): Promise<string[]>;
    lstat(target: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }>;
    readFile(file: string): Promise<Buffer>;
    writeFile(file: string, data: string | Buffer, options?: { mode?: number }): Promise<void>;
    access(target: string, mode: number): Promise<void>;
  };
  /** Linux: the version in <app folder>/resources/app.asar/package.json (Electron reads into app.asar). */
  packagedVersion?(appFolder: string): Promise<string | null>;
}

export const STAGING_PREFIX = ".mcp-for-novelai-update-";
const W_OK = 2;

/** The installation the running executable belongs to: macOS its .app bundle, elsewhere its folder. */
export function installTarget(platform: NodeJS.Platform, execPath: string): { target: string; executable: string } | null {
  if (platform === "darwin") {
    const at = execPath.lastIndexOf(".app/Contents/MacOS/");
    if (at < 0 || execPath.slice(at + ".app/Contents/MacOS/".length).includes("/")) return null;
    return { target: execPath.slice(0, at + 4), executable: path.posix.basename(execPath) };
  }
  const p = platform === "win32" ? path.win32 : path.posix;
  return { target: p.dirname(execPath), executable: p.basename(execPath) };
}

/** A path the helper receives as an argument: absolute, without line breaks, NUL or (Windows) quotes. */
export function safePathArgument(platform: NodeJS.Platform, value: string): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (typeof value !== "string" || !value || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value) || !p.isAbsolute(value)) return false;
  // A Windows path cannot contain a quote; one here would end the quoted argument early.
  if (platform === "win32" && value.includes('"')) return false;
  return p.normalize(value) === value;
}

/**
 * Whether the running app can replace itself (cheap checks, no download): null when it can, else why not. The parent
 * folder must be writable (macOS, Linux: the swap renames inside it; Windows: the installer writes the installation
 * folder).
 */
export async function installSupport(input: { platform: NodeJS.Platform; execPath: string; packaged: boolean; env: Record<string, string | undefined>; deps: InstallDeps }): Promise<InstallUnsupportedReason | null> {
  const { platform, execPath, deps } = input;
  if (!input.packaged) return "not_packaged";
  if (!["darwin", "linux", "win32"].includes(platform)) return "platform";
  const located = installTarget(platform, execPath);
  if (!located || !safePathArgument(platform, located.target)) return "unknown_layout";
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "darwin") {
    // App Translocation (a quarantined app started from Downloads or a disk image) and disk images are read-only.
    if (located.target.includes("/AppTranslocation/")) return "translocated";
    if (located.target.startsWith("/Volumes/") && !(await writable(deps, p.dirname(located.target)))) return "read_only";
  }
  if (platform === "win32") {
    const programFiles = [input.env.ProgramFiles, input.env["ProgramFiles(x86)"], input.env.ProgramW6432].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (programFiles.some(folder => located.target.toLowerCase().startsWith(`${folder.toLowerCase().replace(/\\+$/, "")}\\`))) return "per_machine";
    // The NSIS installer leaves "Uninstall <product name>.exe" next to "<product name>.exe".
    try { await deps.fs.lstat(p.join(located.target, `Uninstall ${p.basename(located.executable, ".exe")}.exe`)); } catch { return "not_installed"; }
    if (!(await writable(deps, located.target))) return "not_writable";
    return null;
  }
  if (!(await writable(deps, p.dirname(located.target))) || !(await writable(deps, located.target))) return "not_writable";
  if (platform === "linux") {
    try {
      const sandbox = await deps.fs.lstat(p.join(located.target, "chrome-sandbox"));
      if (sandbox.uid === 0 && (sandbox.mode & 0o4000)) return "sandbox_helper";
    } catch { /* no helper in the folder */ }
  }
  return null;
}

async function writable(deps: InstallDeps, dir: string) {
  try { await deps.fs.access(dir, W_OK); return true; } catch { return false; }
}

/** SHA-256 (lowercase hex) of the leaf certificate a macOS bundle is signed with; null when it has none (ad-hoc). */
export async function macCertificateSha256(deps: InstallDeps, bundle: string, scratch: string): Promise<string | null> {
  const prefix = path.posix.join(scratch, `cert-${Math.random().toString(36).slice(2)}-`);
  const extracted = await deps.run("/usr/bin/codesign", ["-d", `--extract-certificates=${prefix}`, bundle], { timeoutMs: 60_000 });
  if (extracted.code !== 0) return null;
  try { return createHash("sha256").update(await deps.fs.readFile(`${prefix}0`)).digest("hex"); }
  catch { return null; }
  finally { for (let index = 0; index < 4; index++) await deps.fs.rm(`${prefix}${index}`, { recursive: false, force: true }).catch(() => undefined); }
}

async function plistValue(deps: InstallDeps, plist: string, key: string) {
  const result = await deps.run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], { timeoutMs: 30_000 });
  return result.code === 0 ? result.stdout.trim() : null;
}

/** The one entry of an extracted archive that is a real folder (not a link), ignoring Finder's metadata. */
async function onlyFolder(deps: InstallDeps, dir: string, suffix: string) {
  const entries = (await deps.fs.readdir(dir)).filter(name => name !== "__MACOSX" && name !== ".DS_Store");
  if (entries.length !== 1 || !entries[0].endsWith(suffix)) throw new InstallError("package_invalid", "The update package does not hold exactly one app.");
  const full = path.posix.join(dir, entries[0]);
  const info = await deps.fs.lstat(full);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new InstallError("package_invalid", "The update package does not hold an app folder.");
  return full;
}

export interface StagedUpdate {
  /** <parent>/.mcp-for-novelai-update-<random>: new/<name> is the checked new version. */
  staging: string;
  staged: string;
}

/**
 * macOS: extracts and checks the update zip next to the running bundle `target`. Throws InstallError (and removes the
 * staging folder) when anything does not match; nothing of the running app is touched.
 */
export async function stageMacUpdate(input: { deps: InstallDeps; archive: string; target: string; version: string; bundleId: string; expectedCertificateSha256: string }): Promise<StagedUpdate> {
  const { deps, target } = input;
  const p = path.posix;
  let staging: string;
  try { staging = await deps.fs.mkdtemp(p.join(p.dirname(target), STAGING_PREFIX)); }
  catch { throw new InstallError("not_writable", "The folder of the app is not writable.", "not_writable"); }
  try {
    const extract = p.join(staging, "extract"), next = p.join(staging, "new");
    await deps.fs.mkdir(extract, { mode: 0o700 });
    await deps.fs.mkdir(next, { mode: 0o700 });
    const unzip = await deps.run("/usr/bin/ditto", ["-x", "-k", input.archive, extract], { timeoutMs: 10 * 60_000 });
    if (unzip.code !== 0) throw new InstallError("extract_failed", "The update package could not be extracted.");
    const app = await onlyFolder(deps, extract, ".app");
    const plist = p.join(app, "Contents", "Info.plist");
    if (await plistValue(deps, plist, "CFBundleIdentifier") !== input.bundleId) throw new InstallError("package_invalid", "The update package is a different app.");
    if (await plistValue(deps, plist, "CFBundleShortVersionString") !== input.version) throw new InstallError("package_invalid", "The update package has a different version than its release.");
    const verify = await deps.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { timeoutMs: 10 * 60_000 });
    if (verify.code !== 0) throw new InstallError("signature_mismatch", "The code signature of the update is not valid.");
    const certificate = await macCertificateSha256(deps, app, staging);
    if (!certificate || certificate !== input.expectedCertificateSha256.toLowerCase()) throw new InstallError("signature_mismatch", "The update is not signed with this app's certificate.");
    const staged = p.join(next, p.basename(target));
    await deps.fs.rename(app, staged);
    await deps.fs.rm(extract, { recursive: true, force: true });
    return { staging, staged };
  } catch (error) {
    await deps.fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Linux: extracts and checks the update tar.gz next to the running folder `target`. */
export async function stageLinuxUpdate(input: { deps: InstallDeps; archive: string; target: string; executable: string; version: string }): Promise<StagedUpdate> {
  const { deps, target } = input;
  const p = path.posix;
  let staging: string;
  try { staging = await deps.fs.mkdtemp(p.join(p.dirname(target), STAGING_PREFIX)); }
  catch { throw new InstallError("not_writable", "The folder of the app is not writable.", "not_writable"); }
  try {
    const extract = p.join(staging, "extract"), next = p.join(staging, "new");
    await deps.fs.mkdir(extract, { mode: 0o700 });
    await deps.fs.mkdir(next, { mode: 0o700 });
    const untar = await deps.run("tar", ["-xzf", input.archive, "-C", extract], { timeoutMs: 10 * 60_000 });
    if (untar.code !== 0) throw new InstallError("extract_failed", "The update package could not be extracted.");
    const folder = await onlyFolder(deps, extract, "");
    const exe = await deps.fs.lstat(p.join(folder, input.executable)).catch(() => null);
    if (!exe || !exe.isFile() || !(exe.mode & 0o100)) throw new InstallError("package_invalid", "The update package has no app executable.");
    const version = deps.packagedVersion ? await deps.packagedVersion(folder) : null;
    if (version !== input.version) throw new InstallError("package_invalid", "The update package has a different version than its release.");
    const staged = p.join(next, p.basename(target));
    await deps.fs.rename(folder, staged);
    await deps.fs.rm(extract, { recursive: true, force: true });
    return { staging, staged };
  } catch (error) {
    await deps.fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
