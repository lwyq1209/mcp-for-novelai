// The record of an update in progress (journal.ts): validation of pending.json, what the next start does with it, the
// reason of a failed attempt, and which staging folders the app may remove.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failureReason, readPending, removableStaging, removeOldStateFolders, startupUpdate, writePending, type PendingUpdate } from "./journal";

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
