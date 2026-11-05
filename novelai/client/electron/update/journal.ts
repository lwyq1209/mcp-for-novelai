// The record of an update in progress (<data root>/updates/pending.json) and what the next start of the app does with
// it (startup.ts wires it into main.ts).
//
// The app writes pending.json right before it starts the helper and quits. The next start reads it:
// - the new version, at the path it replaces (the helper started it, or the user did after the helper was stopped):
//   it writes <state>/started (its pid) at once and <state>/confirmed once its window exists, which tells the helper the
//   update worked; it then removes the staging folder (the old version), the downloads and the record, and shows
//   "Updated to x.y.z";
// - the old version (the helper put it back, or the update never started): it shows why the update did not complete
//   (from <state>/helper-state) and removes what is left of the attempt, except a staging folder that still holds the
//   old app (old/), which stays for the user;
// - any other version: the record is dropped.
import fs from "node:fs";
import path from "node:path";
import { STAGING_PREFIX } from "./install";

export interface PendingUpdate {
  schema: 1;
  id: string;
  platform: "darwin" | "linux" | "win32";
  from: string;
  to: string;
  /** The app the update replaces: macOS bundle, Linux folder, Windows installation folder. */
  target: string;
  /** macOS, Linux: the staging folder next to the target. */
  staging: string | null;
  /** <data root>/updates/<id> */
  stateDir: string;
  createdAt: string;
}

export const PENDING_FILE = "pending.json";
export const DOWNLOADS_DIR = "downloads";
export const STATE_FILES = { started: "started", confirmed: "confirmed", helperState: "helper-state", helperLog: "helper.log", launchEnv: "launch.env" } as const;

const isText = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);

export function writePending(updatesDir: string, pending: PendingUpdate) {
  fs.mkdirSync(updatesDir, { recursive: true, mode: 0o700 });
  const file = path.join(updatesDir, PENDING_FILE), temporary = `${file}.${process.pid}.tmp`;
  const handle = fs.openSync(temporary, "w", 0o600);
  try { fs.writeSync(handle, `${JSON.stringify(pending, null, 2)}\n`); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  fs.renameSync(temporary, file);
}

export function readPending(updatesDir: string): PendingUpdate | null {
  let value: any;
  try { value = JSON.parse(fs.readFileSync(path.join(updatesDir, PENDING_FILE), "utf8")); } catch { return null; }
  if (!value || value.schema !== 1 || !/^[0-9a-f]{16,64}$/.test(value.id ?? "") || !["darwin", "linux", "win32"].includes(value.platform)) return null;
  if (![value.from, value.to, value.target, value.stateDir, value.createdAt].every(item => isText(item)) || !(value.staging === null || isText(value.staging))) return null;
  // The state folder is this record's own folder under updates/.
  if (path.resolve(value.stateDir) !== path.resolve(updatesDir, value.id)) return null;
  return value as PendingUpdate;
}

export function removePending(updatesDir: string) {
  try { fs.rmSync(path.join(updatesDir, PENDING_FILE), { force: true }); } catch { /* best effort */ }
}

/** The helper's steps so far (helper-state, one word per line), oldest first. */
export function helperStates(stateDir: string): string[] {
  try { return fs.readFileSync(path.join(stateDir, STATE_FILES.helperState), "utf8").split("\n").map(line => line.trim()).filter(line => /^[a-z_]+(:[a-z_]+)?$/.test(line)).slice(-50); }
  catch { return []; }
}

/** Why an attempt did not complete, as a short code from the helper's last state (unknown when it left none). */
export function failureReason(states: string[]): string {
  for (let index = states.length - 1; index >= 0; index--) {
    const match = /^(?:rolled_back|aborted|failed|rollback_failed):([a-z_]+)$/.exec(states[index]);
    if (match) return match[1];
  }
  return states.length ? `stopped_${states[states.length - 1].replace(/:.*/, "")}` : "not_started";
}

/** A staging folder the app may remove: exactly the recorded one, next to the target, with the helper's name. */
export function removableStaging(pending: PendingUpdate): string | null {
  if (!pending.staging) return null;
  const p = pending.platform === "win32" ? path.win32 : path.posix;
  if (p.dirname(pending.staging) !== p.dirname(pending.target) || !p.basename(pending.staging).startsWith(STAGING_PREFIX)) return null;
  return pending.staging;
}

export type StartupUpdateResult =
  | { kind: "updated"; from: string; to: string }
  | { kind: "failed"; to: string; reason: string };

export interface StartupUpdate {
  result: StartupUpdateResult | null;
  /** The new version's window exists: tell the helper (confirmed). */
  confirm(): void;
  /** Removes what the attempt left (after confirm, a little later; at once for a failed attempt). */
  cleanup(): void;
}

/**
 * The start of an app with a pending update record. `target`: the installation of this run (installTarget).
 * Synchronous (main.ts calls it before the window exists); file errors only make it do less.
 */
export function startupUpdate({ updatesDir, version, target, pid, platform }: { updatesDir: string; version: string; target: string | null; pid: number; platform: NodeJS.Platform }): StartupUpdate {
  const pending = readPending(updatesDir);
  const none: StartupUpdate = { result: null, confirm() {}, cleanup() {} };
  if (!pending) return none;
  const p = pending.platform === "win32" ? path.win32 : path.posix;
  const sameTarget = Boolean(target) && pending.platform === platform && p.resolve(target!) === p.resolve(pending.target);
  const remove = (what: string | null) => { if (what) { try { fs.rmSync(what, { recursive: true, force: true }); } catch { /* best effort */ } } };
  if (sameTarget && version === pending.to) {
    try { fs.writeFileSync(path.join(pending.stateDir, STATE_FILES.started), `${pid}\n`, { mode: 0o600 }); } catch { /* the helper then waits its time */ }
    let confirmed = false;
    return {
      result: { kind: "updated", from: pending.from, to: pending.to },
      confirm() {
        if (confirmed) return;
        confirmed = true;
        try { fs.writeFileSync(path.join(pending.stateDir, STATE_FILES.confirmed), `${pid}\n`, { mode: 0o600 }); } catch { /* best effort */ }
      },
      cleanup() {
        // The old version (staging/old) is no longer needed once this version runs.
        remove(removableStaging(pending));
        remove(path.join(updatesDir, DOWNLOADS_DIR));
        removePending(updatesDir);
      },
    };
  }
  if (sameTarget && version === pending.from) {
    const reason = failureReason(helperStates(pending.stateDir));
    return {
      result: { kind: "failed", to: pending.to, reason },
      confirm() {},
      cleanup() {
        const staging = removableStaging(pending);
        // A staging folder that still holds an app (old/ after a failed rollback) stays for the user.
        if (staging && !fs.existsSync(p.join(staging, "old"))) remove(staging);
        removePending(updatesDir);
      },
    };
  }
  removePending(updatesDir);
  return none;
}

/** Removes state folders of earlier attempts (not the one in pending.json) older than `maxAgeMs`. */
export function removeOldStateFolders(updatesDir: string, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  const keep = readPending(updatesDir)?.id;
  let names: string[] = [];
  try { names = fs.readdirSync(updatesDir); } catch { return; }
  for (const name of names) {
    if (!/^[0-9a-f]{16,64}$/.test(name) || name === keep) continue;
    const dir = path.join(updatesDir, name);
    try { if (now - fs.statSync(dir).mtimeMs > maxAgeMs) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
