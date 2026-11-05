// The self-update of the running app, wired to Electron (main.ts creates it once): the update source of this build
// (source.ts), the record of an update that just ran (journal.ts), the updater (updater.ts) and what it needs from the
// system. Kept apart from main.ts so the wiring is small there.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveUpdateSource, TEST_ENV, TEST_MODE_MARKER, type UpdateSource } from "./source";
import { installTarget, type InstallDeps, type RunResult } from "./install";
import { removeOldStateFolders, startupUpdate, type StartupUpdate } from "./journal";
import { createUpdater, type Updater, type UpdateProgress } from "./updater";
import { startHelper } from "./helper-start";
import { fetchLatestRelease, type LatestRelease } from "../ipc/update";

/** Whether this build is an update rehearsal build (scripts/build-electron.mjs writes the marker only with NAI_UPDATE_TEST_BUILD=1). */
export function isUpdateTestBuild(electronDir: string): boolean {
  return fs.existsSync(path.join(electronDir, "..", TEST_MODE_MARKER));
}

export function run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    execFile(command, args, { encoding: "utf8", timeout: options.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as any).code === "number" ? (error as any).code : null) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

export const nodeInstallDeps: InstallDeps = {
  run,
  fs: {
    mkdtemp: prefix => fsp.mkdtemp(prefix),
    mkdir: (dir, options) => fsp.mkdir(dir, options),
    rm: (target, options) => fsp.rm(target, options),
    rename: (from, to) => fsp.rename(from, to),
    readdir: dir => fsp.readdir(dir),
    lstat: target => fsp.lstat(target),
    readFile: file => fsp.readFile(file),
    writeFile: (file, data, options) => fsp.writeFile(file, data, options),
    access: (target, mode) => fsp.access(target, mode),
  },
  // Electron's fs reads files inside app.asar.
  async packagedVersion(folder) {
    try { const version = JSON.parse(await fsp.readFile(path.join(folder, "resources", "app.asar", "package.json"), "utf8")).version; return typeof version === "string" ? version : null; }
    catch { return null; }
  },
};

/** macOS: CFBundleIdentifier of the running bundle (electron-builder writes an XML Info.plist). */
function bundleIdentifier(bundle: string): string | undefined {
  try { return /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(fs.readFileSync(path.join(bundle, "Contents", "Info.plist"), "utf8"))?.[1]; }
  catch { return undefined; }
}

/** The command-line switches a rehearsal build hands to the restarted app (the test client's own). */
const REHEARSAL_SWITCHES = /^--(use-mock-keychain|disable-backgrounding-occluded-windows|disable-renderer-backgrounding|remote-debugging-port=\d{4,5}|nai-dev-tools-data=.+)$/;

export interface AppUpdaterOptions {
  electronDir: string;
  dataRoot: string;
  customDataRoot: boolean;
  version: string;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  requestConfig(): Record<string, unknown>;
  queueBusy(): boolean;
  quit(): void;
  emit(progress: UpdateProgress): void;
  log(message: string): void;
}

export interface AppUpdater {
  source: UpdateSource;
  testBuild: boolean;
  updater: Updater;
  startup: StartupUpdate;
  fetchLatest(): Promise<LatestRelease | null>;
}

export function createAppUpdater(options: AppUpdaterOptions): AppUpdater {
  const testBuild = isUpdateTestBuild(options.electronDir);
  const source = resolveUpdateSource({ testBuild, env: options.env });
  if (testBuild) options.log(`[update] update rehearsal build: source ${source.kind}`);
  const updatesDir = path.join(options.dataRoot, "updates");
  const located = installTarget(process.platform, process.execPath);
  const startup = options.packaged
    ? startupUpdate({ updatesDir, version: options.version, target: located?.target ?? null, pid: process.pid, platform: process.platform })
    : { result: null, confirm() {}, cleanup() {} };
  if (options.packaged) removeOldStateFolders(updatesDir);
  const fetchLatest = () => fetchLatestRelease(source.latestApiUrl);
  const background = testBuild && options.env.NAI_DEV_TOOLS_BACKGROUND === "1";
  const updater = createUpdater({
    source, currentVersion: options.version, platform: process.platform, arch: process.arch, execPath: process.execPath, packaged: options.packaged, pid: process.pid,
    bundleId: process.platform === "darwin" && located ? bundleIdentifier(located.target) : undefined,
    updatesDir, env: { ...options.env }, installDeps: nodeInstallDeps, fetchLatest, requestConfig: options.requestConfig,
    queueBusy: options.queueBusy, quit: options.quit, startHelper, emit: options.emit, log: options.log, background,
    launchEnv() {
      const lines: string[] = [];
      if (options.customDataRoot) lines.push(`NOVELAI_DATA_DIR=${options.dataRoot}`);
      if (typeof options.env.NOVELAI_PROJECT_ROOT === "string" && options.env.NOVELAI_PROJECT_ROOT) lines.push(`NOVELAI_PROJECT_ROOT=${options.env.NOVELAI_PROJECT_ROOT}`);
      if (testBuild) for (const key of [TEST_ENV.feed, TEST_ENV.publicKey, TEST_ENV.macCertificate, "NAI_DEV_TOOLS_BACKGROUND"]) { const value = options.env[key]; if (typeof value === "string" && value) lines.push(`${key}=${value}`); }
      return lines;
    },
    launchArgs: () => testBuild ? options.argv.slice(1).filter(arg => REHEARSAL_SWITCHES.test(arg)) : [],
  });
  return { source, testBuild, updater, startup, fetchLatest };
}
