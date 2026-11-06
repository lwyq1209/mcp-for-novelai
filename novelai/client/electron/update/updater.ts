// "Update and restart": download, verify, stage and hand over to the helper (the main process does all of it; the
// window only shows the progress and the buttons). Every outside effect is an injected dependency (updater.test.ts).
//
//   start()    the latest release again (the source's API) → SHA256SUMS.txt and its signature from the release's
//              download URL → signature, version and file checks (release-files.ts; a failure stops: verify_failed,
//              nothing is installed) → the file of this platform (resumable, progress, SHA-256 against the signed
//              checksum) → staged and checked next to the app (install.ts) → ready. When the queue has nothing running
//              or waiting, it goes on to install() at once; otherwise it stays ready until the user clicks again.
//   install()  only from ready and only while the queue is idle (no running, waiting, pausing or cancelling batch,
//              manual ones included; paused batches stay paused and are kept): checks the staged version once more
//              (macOS signature and certificate, Windows the installer's SHA-256), holds the queue (no image starts
//              from now on; new batches still queue), writes the helper script, pending.json and the updating marker
//              (runtime/updating.json: the MCP server starts no app meanwhile), starts the helper (it must answer
//              within a few seconds), looks at the queue once more — a batch that arrived meanwhile withdraws the
//              update (the helper sees its state folder gone and stops) and lifts the hold — and otherwise quits the
//              app normally (before-quit closes the bridge, the queue and the library), never forcefully.
//   cancel()   stops a download or check (the partial file stays for a later resume) and removes a staged version.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { LatestRelease } from "../ipc/update";
import { isNewerVersion } from "../ipc/update";
import { downloadFile, downloadSmall, DownloadError } from "./download";
import { CHECKSUMS_FILE, CHECKSUMS_MAX_BYTES, ManifestError, SIGNATURE_FILE, SIGNATURE_MAX_BYTES, ed25519PublicKey, verifyReleaseManifest, versionOfTag, type VerifiedManifest } from "./release-files";
import type { UpdateSource } from "./source";
import { createHash } from "node:crypto";
import { InstallError, installSupport, installTarget, macCertificateSha256, safePathArgument, stageLinuxUpdate, stageMacUpdate, type InstallDeps, type InstallUnsupportedReason, type StagedUpdate } from "./install";
import { DOWNLOADS_DIR, STATE_FILES, UPDATING_MARKER_MS, removePending, removeStagedRecord, removeUpdatingMarker, writePending, writeStagedRecord, writeUpdatingMarker, type PendingUpdate } from "./journal";
import { POSIX_HELPER_SCRIPT } from "./helper-posix";
import { helperEnvironment, linuxAppEnvironment } from "./environment";
import { WINDOWS_HELPER_SCRIPT } from "./helper-windows";

export type UpdatePhase = "idle" | "checking" | "downloading" | "verifying" | "preparing" | "ready" | "installing" | "failed";
export type UpdateErrorCode = "verify_failed" | "download_failed" | "no_update" | "install_unsupported" | "install_failed" | "check_failed" | "cancelled" | "unpack_failed";

export interface UpdateProgress {
  phase: UpdatePhase;
  /** The version being installed. */
  version?: string;
  received?: number;
  total?: number | null;
  error?: { code: UpdateErrorCode; message: string; retryable: boolean; reason?: string };
  /** ready: the queue has running or waiting batches, so the app does not restart yet. */
  queueBusy?: boolean;
  /** Whether this installation can update itself; reason when not (the window then offers the download page only). */
  install?: { supported: boolean; reason?: InstallUnsupportedReason };
}

/** Largest update file accepted (the macOS zip is about 150 MB). */
export const UPDATE_FILE_MAX_BYTES = 1024 * 1024 * 1024;
/** Automatic attempts of one download (each resumes the partial file). */
export const DOWNLOAD_ATTEMPTS = 3;
/** The helper must have written its first state within this time, else the app does not quit. */
export const HELPER_START_TIMEOUT_MS = 10_000;
/** Windows: PowerShell started through WMI can take much longer on a cold or busy system. */
export const HELPER_START_TIMEOUT_WINDOWS_MS = 30_000;

export interface HelperLaunch {
  platform: "darwin" | "linux" | "win32";
  /** The helper script the app writes (helper.sh, helper.ps1) in the state folder. */
  script: string;
  command: string;
  args: string[];
  /** The helper's environment (Linux and Windows: the restarted app gets it too). */
  env: Record<string, string>;
  cwd: string;
}

export interface UpdaterOptions {
  source: UpdateSource;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  execPath: string;
  packaged: boolean;
  pid: number;
  /** macOS: CFBundleIdentifier of the running app. */
  bundleId?: string;
  /** <data root>/updates */
  updatesDir: string;
  /** <data root>/runtime (the updating marker; default: next to updatesDir). */
  runtimeDir?: string;
  env: Record<string, string | undefined>;
  installDeps: InstallDeps;
  fetchLatest(): Promise<LatestRelease | null>;
  requestConfig(): Record<string, unknown>;
  queueBusy(): boolean;
  /** Holds the queue (no image starts; batches still queue) from the hand-over on, or lifts the hold. */
  holdQueue?(hold: boolean): void;
  quit(): void;
  startHelper(launch: HelperLaunch): Promise<{ ok: true } | { ok: false; reason: string }>;
  emit(progress: UpdateProgress): void;
  log(message: string): void;
  /** macOS: NAME=value lines for `open --env` (the data folder of a custom data root, rehearsal variables). */
  launchEnv(): string[];
  /** Extra arguments of the restarted app (rehearsal builds only). */
  launchArgs(): string[];
  /** Rehearsal builds: the restarted app starts in the background (open -g, SW_SHOWNOACTIVATE). */
  background: boolean;
  /** Rehearsal builds only: a pause between the helper's answer and the last queue check (to catch it on purpose). */
  handoverDelayMs?: number;
  sleep?(ms: number): Promise<void>;
}

interface Prepared { manifest: VerifiedManifest; file: string; staged: StagedUpdate | null; target: string; executable: string; certificateSha256?: string }

export interface Updater {
  status(): UpdateProgress;
  /** Whether this installation can update itself (cached after the first call). */
  support(): Promise<{ supported: boolean; reason?: InstallUnsupportedReason }>;
  start(): Promise<UpdateProgress>;
  install(): Promise<UpdateProgress>;
  cancel(): Promise<UpdateProgress>;
  /** The queue changed: a ready update says again whether it can restart now. */
  queueChanged(): void;
  /** The app is quitting without an update: a staged version is removed. */
  disposeSync(): void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createUpdater(options: UpdaterOptions): Updater {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let progress: UpdateProgress = { phase: "idle" };
  let prepared: Prepared | null = null;
  let controller: AbortController | null = null;
  let supportCache: { supported: boolean; reason?: InstallUnsupportedReason } | null = null;
  let running: Promise<UpdateProgress> | null = null;

  const set = (next: UpdateProgress) => { progress = { ...next, install: supportCache ?? next.install }; options.emit(progress); return progress; };
  const fail = (code: UpdateErrorCode, text: string, retryable: boolean, reason?: string, version = progress.version) => set({ phase: "failed", version, error: { code, message: text, retryable, ...(reason ? { reason } : {}) } });

  async function support() {
    if (supportCache) return supportCache;
    const reason = await installSupport({ platform: options.platform, execPath: options.execPath, packaged: options.packaged, env: options.env, deps: options.installDeps }).catch(() => "unknown_layout" as const);
    supportCache = reason ? { supported: false, reason } : { supported: true };
    return supportCache;
  }

  const runtimeDir = options.runtimeDir ?? path.join(path.dirname(options.updatesDir), "runtime");

  async function removeStaged() {
    const staging = prepared?.staged?.staging;
    prepared = null;
    removeStagedRecord(options.updatesDir);
    if (staging) await options.installDeps.fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }

  async function download(manifest: VerifiedManifest, tag: string, signal: AbortSignal): Promise<string> {
    const dir = path.join(options.updatesDir, DOWNLOADS_DIR);
    await options.installDeps.fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, manifest.asset);
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      try {
        await downloadFile({
          url: options.source.downloadUrl(tag, manifest.asset), allows: url => options.source.allowsDownloadUrl(url, tag),
          destination: file, expectedSha256: manifest.sha256, maxBytes: UPDATE_FILE_MAX_BYTES, signal, requestConfig: options.requestConfig,
          onProgress: (received, total) => { if (progress.phase === "downloading") set({ phase: "downloading", version: manifest.version, received, total }); },
        });
        return file;
      } catch (error) {
        lastError = error;
        if (!(error instanceof DownloadError) || !error.retryable || error.code === "cancelled" || attempt === DOWNLOAD_ATTEMPTS) throw error;
        options.log(`[update] download attempt ${attempt} failed (${error.code}); trying again`);
        await sleep(attempt * 2000);
        if (signal.aborted) throw new DownloadError("cancelled", "The download was cancelled.", true);
      }
    }
    throw lastError;
  }

  async function stage(manifest: VerifiedManifest, file: string): Promise<Prepared> {
    const located = installTarget(options.platform, options.execPath);
    if (!located) throw new InstallError("install_unsupported", "The installation of this app is not recognised.", "unknown_layout");
    if (options.platform === "darwin") {
      // The certificate of the running app; an ad-hoc signed app has none, then the one built into it.
      const scratch = path.join(options.updatesDir, DOWNLOADS_DIR);
      const current = await macCertificateSha256(options.installDeps, located.target, scratch);
      const certificateSha256 = (current ?? options.source.macCertificateSha256).toLowerCase();
      const staged = await stageMacUpdate({ deps: options.installDeps, archive: file, target: located.target, version: manifest.version, bundleId: options.bundleId ?? "", expectedCertificateSha256: certificateSha256 });
      return { manifest, file, staged, ...located, certificateSha256 };
    }
    if (options.platform === "linux") {
      const staged = await stageLinuxUpdate({ deps: options.installDeps, archive: file, target: located.target, executable: located.executable, version: manifest.version });
      return { manifest, file, staged, ...located };
    }
    return { manifest, file, staged: null, ...located };
  }

  async function pipeline(): Promise<UpdateProgress> {
    const supported = await support();
    if (!supported.supported) return fail("install_unsupported", "This installation cannot update itself.", false, supported.reason);
    controller = new AbortController();
    const { signal } = controller;
    set({ phase: "checking" });
    let latest: LatestRelease | null;
    try { latest = await options.fetchLatest(); }
    catch (error) { return fail("check_failed", `The latest release could not be read: ${message(error)}`, true); }
    const version = latest ? versionOfTag(latest.tag) : null;
    if (!latest || !version || !isNewerVersion(version, options.currentVersion)) return fail("no_update", "No newer release to install.", false);
    const tag = latest.tag;
    set({ phase: "downloading", version, received: 0, total: null });
    let manifest: VerifiedManifest;
    try {
      const small = (file: string, maxBytes: number) => downloadSmall({ url: options.source.downloadUrl(tag, file), allows: url => options.source.allowsDownloadUrl(url, tag), maxBytes, signal, requestConfig: options.requestConfig });
      const checksums = await small(CHECKSUMS_FILE, CHECKSUMS_MAX_BYTES);
      const signature = await small(SIGNATURE_FILE, SIGNATURE_MAX_BYTES);
      set({ phase: "verifying", version });
      const publicKey = ed25519PublicKey(options.source.publicKey);
      if (!publicKey) throw new ManifestError("signature_invalid", "The update key of this app is not usable.");
      manifest = verifyReleaseManifest({ tag, checksums, signature, publicKey, currentVersion: options.currentVersion, platform: options.platform, arch: options.arch });
    } catch (error) {
      if (error instanceof DownloadError) return error.code === "cancelled" ? set({ phase: "idle" }) : fail("download_failed", error.message, error.retryable, error.code, version);
      if (error instanceof ManifestError) {
        options.log(`[update] ${tag}: the release could not be verified (${error.code}); nothing is installed`);
        return fail(error.code === "asset_missing" ? "install_unsupported" : "verify_failed", error.message, false, error.code, version);
      }
      return fail("download_failed", message(error), true, undefined, version);
    }
    set({ phase: "downloading", version, received: 0, total: null });
    let file: string;
    try { file = await download(manifest, tag, signal); }
    catch (error) {
      if (error instanceof DownloadError && error.code === "cancelled") return set({ phase: "idle" });
      if (error instanceof DownloadError && error.code === "checksum_mismatch") { options.log(`[update] ${manifest.asset}: checksum mismatch; nothing is installed`); return fail("verify_failed", error.message, false, error.code, version); }
      if (error instanceof DownloadError && error.code === "redirect_refused") { options.log(`[update] ${manifest.asset}: ${error.message}`); return fail("verify_failed", error.message, false, error.code, version); }
      return fail("download_failed", message(error), error instanceof DownloadError ? error.retryable : true, error instanceof DownloadError ? error.code : undefined, version);
    }
    if (signal.aborted) return set({ phase: "idle" });
    set({ phase: "preparing", version });
    try { prepared = await stage(manifest, file); }
    catch (error) {
      if (error instanceof InstallError) {
        options.log(`[update] ${manifest.asset}: ${error.code}: ${error.message}`);
        if (error.code === "not_writable" || error.code === "install_unsupported") return fail("install_unsupported", error.message, false, error.reason ?? "not_writable", version);
        // A full disk, a missing tool, a timeout: nothing about the release; the next try extracts it again.
        if (error.code === "extract_failed") return fail("unpack_failed", error.message, true, error.code, version);
        return fail("verify_failed", error.message, false, error.code, version);
      }
      return fail("install_failed", message(error), true, undefined, version);
    }
    if (prepared.staged) writeStagedRecord(options.updatesDir, { staging: prepared.staged.staging, target: prepared.target, platform: options.platform });
    if (signal.aborted) { await removeStaged(); return set({ phase: "idle" }); }
    controller = null;
    options.log(`[update] ${manifest.version} is downloaded, verified and ready`);
    if (options.queueBusy()) return set({ phase: "ready", version, queueBusy: true });
    return install();
  }

  function helperLaunch(stateDir: string, ready: Prepared): HelperLaunch {
    const { platform } = options;
    const from = options.currentVersion, to = ready.manifest.version;
    for (const value of [ready.target, stateDir, ready.file, ...(ready.staged ? [ready.staged.staging] : [])]) if (!safePathArgument(platform, value)) throw new InstallError("install_unsupported", "A path of this installation cannot be handed to the update helper.", "unknown_layout");
    // Never the app's whole environment (environment.ts): the helper gets what it needs to run, the restarted app what
    // a start from the desktop would have plus the hand-over lines.
    const env = helperEnvironment(platform, options.env, options.launchEnv());
    if (platform === "win32") {
      const script = path.win32.join(stateDir, "helper.ps1");
      return { platform, script, command: "powershell.exe", cwd: stateDir, env, args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script,
        "-State", stateDir, "-AppPid", String(options.pid), "-Installer", ready.file, "-Sha256", ready.manifest.sha256, "-InstallDir", ready.target, "-Exe", ready.executable, "-From", from, "-To", to, "-Background", options.background ? "1" : "0"] };
    }
    const script = path.posix.join(stateDir, "helper.sh");
    const launcher = platform === "darwin" ? "/usr/bin/open" : ready.executable;
    // -p: no ENV/BASH_ENV file, no shell functions from the environment (which is minimal anyway). Linux: bash where
    // there is one, which can close every descriptor the helper inherited (dash only 3-9) before the new app starts.
    const shell = platform === "linux" && fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
    return { platform: platform as "darwin" | "linux", script, command: shell, cwd: stateDir, env, args: ["-p", script, platform, stateDir, String(options.pid), ready.target, ready.staged!.staging, from, to, launcher, options.background ? "1" : "0", platform === "darwin" ? ready.certificateSha256 ?? "" : "-"] };
  }

  /** The staged version once more, right before it is handed over (it may have waited for the queue for hours). */
  async function recheck(ready: Prepared) {
    if (options.platform === "darwin" && ready.staged) {
      const verify = await options.installDeps.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", ready.staged.staged], { timeoutMs: 10 * 60_000 });
      const certificate = verify.code === 0 ? await macCertificateSha256(options.installDeps, ready.staged.staged, ready.staged.staging) : null;
      if (!certificate || certificate !== ready.certificateSha256) throw new InstallError("signature_mismatch", "The staged update no longer has a valid signature of this app's certificate.");
    }
    if (options.platform === "win32" || options.platform === "linux") {
      // The downloaded file, read back from the disk.
      const hash = createHash("sha256");
      for await (const chunk of fs.createReadStream(ready.file)) hash.update(chunk as Buffer);
      if (hash.digest("hex") !== ready.manifest.sha256) throw new InstallError("package_invalid", "The downloaded update file changed after it was checked.");
    }
  }

  /** Takes back an update handed to the helper that must not run (the queue got busy): the helper stops by itself. */
  async function withdraw(stateDir: string, id: string) {
    removePending(options.updatesDir);
    removeUpdatingMarker(runtimeDir, id);
    await options.installDeps.fs.rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async function install(): Promise<UpdateProgress> {
    const ready = prepared;
    if (progress.phase !== "ready" && progress.phase !== "preparing") return progress;
    if (!ready) return fail("install_failed", "Nothing is ready to install.", true);
    const version = ready.manifest.version;
    if (options.queueBusy()) return set({ phase: "ready", version, queueBusy: true });
    try { await recheck(ready); }
    catch (error) {
      options.log(`[update] ${ready.manifest.asset}: ${message(error)}; nothing is installed`);
      await removeStaged();
      return fail("verify_failed", message(error), false, error instanceof InstallError ? error.code : undefined, version);
    }
    // The recheck took a moment: a batch may have arrived meanwhile.
    if (options.queueBusy()) return set({ phase: "ready", version, queueBusy: true });
    set({ phase: "installing", version });
    // From here on no image starts (batches still queue); a batch that arrives withdraws the update below.
    options.holdQueue?.(true);
    const id = randomBytes(12).toString("hex");
    const stateDir = path.join(options.updatesDir, id);
    try {
      const launch = helperLaunch(stateDir, ready);
      await options.installDeps.fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
      await options.installDeps.fs.writeFile(launch.script, launch.platform === "win32" ? WINDOWS_HELPER_SCRIPT : POSIX_HELPER_SCRIPT, { mode: 0o700 });
      const lines = (values: string[]) => values.filter(value => value && !/[\0\r\n]/.test(value)).join("\n");
      if (launch.platform === "darwin") await options.installDeps.fs.writeFile(path.join(stateDir, STATE_FILES.launchEnv), `${lines(options.launchEnv())}\n`, { mode: 0o600 });
      if (launch.platform === "linux") await options.installDeps.fs.writeFile(path.join(stateDir, STATE_FILES.launchEnv), `${lines(linuxAppEnvironment(options.env, options.launchEnv()))}\n`, { mode: 0o600 });
      const extra = options.launchArgs().filter(value => !/[\0\r\n"]/.test(value) && !value.endsWith("\\"));
      if (extra.length) await options.installDeps.fs.writeFile(path.join(stateDir, "launch.args"), `${lines(extra)}\n`, { mode: 0o600 });
      const pending: PendingUpdate = { schema: 1, id, platform: launch.platform, from: options.currentVersion, to: version, target: ready.target, staging: ready.staged?.staging ?? null, stateDir, createdAt: new Date().toISOString() };
      writePending(options.updatesDir, pending);
      const now = Date.now();
      writeUpdatingMarker(runtimeDir, { schema: 1, id, pid: options.pid, from: options.currentVersion, to: version, startedAt: new Date(now).toISOString(), expiresAt: new Date(now + UPDATING_MARKER_MS).toISOString() });
      const started = await options.startHelper(launch);
      if (!started.ok) throw new Error(started.reason);
      // The helper says it runs (its first state) before the app quits.
      const until = Date.now() + (options.platform === "win32" ? HELPER_START_TIMEOUT_WINDOWS_MS : HELPER_START_TIMEOUT_MS);
      while (!helperAnswered(stateDir)) {
        if (Date.now() > until) throw new Error("The update helper did not start.");
        await sleep(100);
      }
      if (options.handoverDelayMs) await sleep(options.handoverDelayMs);
    } catch (error) {
      await withdraw(stateDir, id);
      options.holdQueue?.(false);
      options.log(`[update] the update could not be handed over: ${message(error)}`);
      return fail("install_failed", message(error), true, undefined, version);
    }
    // The last look at the queue, right before quitting (nothing can be enqueued between it and quit()).
    if (options.queueBusy()) {
      await withdraw(stateDir, id);
      options.holdQueue?.(false);
      options.log(`[update] a batch arrived while the update was handed over; the update is withdrawn and waits for the queue`);
      return set({ phase: "ready", version, queueBusy: true });
    }
    options.log(`[update] ${options.currentVersion} → ${version}: the helper runs; the app quits now`);
    prepared = null; // the helper owns the staged version now
    removeStagedRecord(options.updatesDir);
    options.quit();
    return progress;
  }

  function helperAnswered(stateDir: string) {
    try { return fs.readFileSync(path.join(stateDir, STATE_FILES.helperState), "utf8").includes("waiting"); } catch { return false; }
  }

  return {
    status: () => ({ ...progress, install: supportCache ?? progress.install }),
    support,
    start() {
      if (progress.phase === "ready") return install();
      if (running) return running;
      running = pipeline().catch(error => fail("install_failed", message(error), true)).finally(() => { running = null; });
      return running;
    },
    install,
    async cancel() {
      if (progress.phase === "installing") return progress;
      controller?.abort();
      controller = null;
      if (running) await running.catch(() => undefined);
      await removeStaged();
      return set({ phase: "idle" });
    },
    queueChanged() {
      if (progress.phase !== "ready") return;
      const busy = options.queueBusy();
      if (busy !== Boolean(progress.queueBusy)) set({ ...progress, queueBusy: busy });
    },
    disposeSync() {
      const staging = progress.phase === "installing" ? null : prepared?.staged?.staging;
      if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ } removeStagedRecord(options.updatesDir); }
    },
  };
}
