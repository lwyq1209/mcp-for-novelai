// The record of an update in progress (journal.ts): validation of pending.json, what the next start does with it, the
// reason of a failed attempt, and which staging folders the app may remove.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activeUpdatingMarker, failureReason, readPending, removableStaging, removeOldStateFolders, removeStaleStaging, removeUpdatingMarker, startupUpdate, writePending, writeStagedRecord, writeUpdatingMarker, type PendingUpdate } from "./journal";

let root: string, updates: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-journal-")); updates = path.join(root, "updates"); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const id = "aaaaaaaaaaaaaaaaaaaaaaaa";
function pending(overrides: Partial<PendingUpdate> = {}): PendingUpdate {
  const parent = path.join(root, "Applications");
  return { schema: 1, id, platform: process.platform === "win32" ? "win32" : "linux", from: "0.1.3", to: "0.1.4", target: path.join(parent, "app"), staging: path.join(parent, ".mcp-for-novelai-update-xyz"), stateDir: path.join(updates, id), createdAt: "2026-11-05T12:00:00.000Z", ...overrides };
}

describe("pending.json", () => {
  it("round-trips and refuses records that are not exactly one", () => {
    writePending(updates, pending());
    expect(readPending(updates)).toEqual(pending());
    for (const bad of [{ schema: 2 }, { id: "../x" }, { platform: "freebsd" }, { stateDir: path.join(root, "elsewhere") }, { to: "0.1.4\nmore" }, { staging: "" }]) {
      fs.writeFileSync(path.join(updates, "pending.json"), JSON.stringify({ ...pending(), ...bad }));
      expect(readPending(updates), JSON.stringify(bad)).toBeNull();
    }
    fs.writeFileSync(path.join(updates, "pending.json"), "{not json");
    expect(readPending(updates)).toBeNull();
  });

  it("names the reason of the helper's last state", () => {
    expect(failureReason(["waiting", "swapped", "launched", "rolling_back:new_app_exited", "rolled_back:new_app_exited"])).toBe("new_app_exited");
    expect(failureReason(["waiting", "aborted:not_movable"])).toBe("not_movable");
    expect(failureReason(["waiting", "installing", "failed:installer_failed"])).toBe("installer_failed");
    expect(failureReason(["waiting"])).toBe("stopped_waiting");
    expect(failureReason([])).toBe("not_started");
  });

  it("removes only the recorded staging folder next to the target with the helper's name", () => {
    expect(removableStaging(pending())).toBe(pending().staging);
    expect(removableStaging(pending({ staging: path.join(root, ".mcp-for-novelai-update-xyz") }))).toBeNull();
    expect(removableStaging(pending({ staging: path.join(root, "Applications", "Other.app") }))).toBeNull();
    expect(removableStaging(pending({ staging: null }))).toBeNull();
  });
});

describe("the next start", () => {
  const target = () => pending().target;
  beforeEach(() => { fs.mkdirSync(pending().stateDir, { recursive: true }); fs.mkdirSync(path.join(pending().staging!, "old"), { recursive: true }); writePending(updates, pending()); });

  it("of the new version confirms, then removes the old version, the downloads and the record", () => {
    fs.mkdirSync(path.join(updates, "downloads"), { recursive: true });
    const start = startupUpdate({ updatesDir: updates, version: "0.1.4", target: target(), pid: 77, platform: pending().platform });
    expect(start.result).toEqual({ kind: "updated", from: "0.1.3", to: "0.1.4" });
    expect(fs.readFileSync(path.join(pending().stateDir, "started"), "utf8")).toBe("77\n");
    expect(fs.existsSync(path.join(pending().stateDir, "confirmed"))).toBe(false);
    start.confirm();
    expect(fs.readFileSync(path.join(pending().stateDir, "confirmed"), "utf8")).toBe("77\n");
    start.cleanup();
    expect(fs.existsSync(pending().staging!)).toBe(false);
    expect(fs.existsSync(path.join(updates, "downloads"))).toBe(false);
    expect(readPending(updates)).toBeNull();
  });

  it("of the old version reports the attempt and keeps a staging folder that still holds the old app", () => {
    fs.writeFileSync(path.join(pending().stateDir, "helper-state"), "waiting\nswapped\nrolling_back:move_failed\nrollback_failed:move_failed\n");
    const start = startupUpdate({ updatesDir: updates, version: "0.1.3", target: target(), pid: 77, platform: pending().platform });
    expect(start.result).toEqual({ kind: "failed", to: "0.1.4", reason: "move_failed" });
    start.cleanup();
    expect(fs.existsSync(path.join(pending().staging!, "old"))).toBe(true);
    expect(readPending(updates)).toBeNull();
    expect(fs.existsSync(path.join(pending().stateDir, "started"))).toBe(false);
  });

  it("of another installation or version only drops the record", () => {
    const other = startupUpdate({ updatesDir: updates, version: "0.1.4", target: path.join(root, "elsewhere"), pid: 1, platform: pending().platform });
    expect(other.result).toBeNull();
    expect(readPending(updates)).toBeNull();
    writePending(updates, pending());
    expect(startupUpdate({ updatesDir: updates, version: "0.2.0", target: target(), pid: 1, platform: pending().platform }).result).toBeNull();
    expect(fs.existsSync(pending().staging!)).toBe(true);
  });

  it("removes old state folders but never the pending one", () => {
    const old = path.join(updates, "bbbbbbbbbbbbbbbbbbbbbbbb");
    fs.mkdirSync(old, { recursive: true });
    removeOldStateFolders(updates, 1000, Date.now() + 10_000);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(pending().stateDir)).toBe(true);
  });
});

describe("the updating marker (runtime/updating.json)", () => {
  const runtime = () => path.join(root, "runtime");
  const marker = (startedAt = Date.now(), overrides = {}) => ({ schema: 1 as const, id, pid: 1, from: "0.1.3", to: "0.1.4", startedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + 5 * 60_000).toISOString(), ...overrides });
  const helperPid = (pid: number) => { fs.mkdirSync(path.join(updates, id), { recursive: true }); fs.writeFileSync(path.join(updates, id, "helper-pid"), `${pid}\n`); };

  it("is valid while it has not expired and its helper lives (or has not started yet)", () => {
    writeUpdatingMarker(runtime(), marker());
    expect(activeUpdatingMarker(root)?.id).toBe(id);
    // No helper pid yet: valid only shortly after it was written.
    expect(activeUpdatingMarker(root, { now: Date.now() + 60_000 })).toBeNull();
    helperPid(process.pid);
    expect(activeUpdatingMarker(root, { now: Date.now() + 60_000 })?.id).toBe(id);
    expect(activeUpdatingMarker(root, { isAlive: () => false })).toBeNull();
    expect(activeUpdatingMarker(root, { now: Date.now() + 6 * 60_000 })).toBeNull();
    writeUpdatingMarker(runtime(), marker(Date.now(), { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() }));
    expect(activeUpdatingMarker(root)).toBeNull();
    fs.writeFileSync(path.join(runtime(), "updating.json"), "{garbage");
    expect(activeUpdatingMarker(root)).toBeNull();
  });

  it("is removed only for its own update id when one is named", () => {
    writeUpdatingMarker(runtime(), marker());
    removeUpdatingMarker(runtime(), "bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(true);
    removeUpdatingMarker(runtime(), id);
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(false);
  });

  it("makes the old version quit at once while the helper works, and not after a rollback or once the helper is gone", () => {
    fs.mkdirSync(path.join(updates, id), { recursive: true });
    writePending(updates, pending());
    writeUpdatingMarker(runtime(), marker());
    helperPid(process.pid);
    fs.writeFileSync(path.join(updates, id, "helper-state"), "waiting\n");
    const start = (argv: string[] = [], isAlive = (pid: number) => pid === process.pid) => startupUpdate({ updatesDir: updates, version: "0.1.3", target: pending().target, pid: 9, platform: pending().platform, argv, isAlive });
    const during = start();
    expect(during.inProgress).toEqual({ id, from: "0.1.3", to: "0.1.4" });
    expect(during.result).toBeNull();
    // It touched nothing.
    expect(readPending(updates)).not.toBeNull();
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(true);
    expect(fs.existsSync(path.join(updates, id, "started"))).toBe(false);
    // The start the helper makes after a rollback is an ordinary start that reports it.
    expect(start(["exe", "--update-rolled-back=0.1.4"]).inProgress).toBeUndefined();
    writePending(updates, pending());
    writeUpdatingMarker(runtime(), marker());
    // A helper that died: the old version reports the attempt and removes the marker.
    const after = start([], () => false);
    expect(after.inProgress).toBeUndefined();
    expect(after.result).toEqual({ kind: "failed", to: "0.1.4", reason: "stopped_waiting" });
    after.cleanup();
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(false);
  });

  it("is removed by the new version as soon as it confirms its start", () => {
    fs.mkdirSync(path.join(updates, id), { recursive: true });
    writePending(updates, pending());
    writeUpdatingMarker(runtime(), marker());
    const next = startupUpdate({ updatesDir: updates, version: "0.1.4", target: pending().target, pid: 9, platform: pending().platform });
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(true);
    next.confirm();
    expect(fs.existsSync(path.join(runtime(), "updating.json"))).toBe(false);
  });
});

describe("staging folders an earlier run left", () => {
  it("removes the recorded one at once and others with the helper's name after a day, never the pending one or other folders", () => {
    const parent = path.join(root, "Applications"), target = path.join(parent, "app");
    fs.mkdirSync(target, { recursive: true });
    const recorded = path.join(parent, ".mcp-for-novelai-update-rec"), fresh = path.join(parent, ".mcp-for-novelai-update-new"), old = path.join(parent, ".mcp-for-novelai-update-old");
    const pendingOne = path.join(parent, ".mcp-for-novelai-update-xyz"), other = path.join(parent, "Other.app");
    for (const dir of [recorded, fresh, old, pendingOne, other]) fs.mkdirSync(path.join(dir, "new"), { recursive: true });
    const dayAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    for (const dir of [old, pendingOne, other]) fs.utimesSync(dir, dayAgo, dayAgo);
    try { fs.symlinkSync(other, path.join(parent, ".mcp-for-novelai-update-link")); } catch { /* Windows without the privilege */ }
    writePending(updates, pending());
    writeStagedRecord(updates, { staging: recorded, target, platform: process.platform });
    const removed = removeStaleStaging({ updatesDir: updates, target, platform: process.platform === "win32" ? "win32" : "linux" });
    expect(removed.sort()).toEqual([old, recorded].sort());
    for (const dir of [fresh, pendingOne, other]) expect(fs.existsSync(dir), dir).toBe(true);
    expect(fs.existsSync(path.join(updates, "staged.json"))).toBe(false);
  });
});
