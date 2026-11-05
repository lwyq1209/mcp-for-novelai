// The macOS/Linux update helper (helper-posix.ts) run for real with /bin/sh on folders standing in for the old and the
// new app, and a stand-in launcher instead of `open` (no app is started): the swap, the confirmation, every rollback,
// a withdrawn update, refused arguments, and a helper stopped part-way (the next start finishes the update).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POSIX_HELPER_SCRIPT } from "./helper-posix";
import { startupUpdate, writePending } from "./journal";

const posix = process.platform !== "win32";
let root: string, parent: string, target: string, staging: string, updates: string, state: string, launcher: string;
const children: ChildProcess[] = [];
const id = "0123456789abcdef0123";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-helper-"));
  parent = path.join(root, "Applications");
  target = path.join(parent, "MCP for NovelAI.app");
  staging = path.join(parent, ".mcp-for-novelai-update-abc123");
  updates = path.join(root, "data", "updates");
  state = path.join(updates, id);
  for (const dir of [path.join(target, "Contents"), path.join(staging, "new", "MCP for NovelAI.app", "Contents"), state]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(target, "Contents", "version"), "0.1.3");
  fs.writeFileSync(path.join(staging, "new", "MCP for NovelAI.app", "Contents", "version"), "0.1.4");
  writePending(updates, { schema: 1, id, platform: process.platform === "darwin" ? "darwin" : "linux", from: "0.1.3", to: "0.1.4", target, staging, stateDir: state, createdAt: new Date().toISOString() });
  fs.writeFileSync(path.join(state, "helper.sh"), POSIX_HELPER_SCRIPT, { mode: 0o700 });
  // The stand-in launcher: logs its call; its behaviour for this call comes from <root>/behaviour (one word per call).
  launcher = path.join(root, "launcher.sh");
  fs.writeFileSync(launcher, `#!/bin/sh
printf '%s|%s\\n' "$1" "$2" >> "${root}/launches"
behaviour=$(head -n 1 "${root}/behaviour" 2>/dev/null); sed -i.bak '1d' "${root}/behaviour" 2>/dev/null
case "$behaviour" in
  confirm) sleep 30 & printf '%s\\n' "$!" >> "${root}/pids"; printf '%s\\n' "$!" > "${state}/started"; printf '%s\\n' "$!" > "${state}/confirmed" ;;
  exit) sh -c 'exit 0' & wait $!; printf '%s\\n' "$!" > "${state}/started" ;;
  slow) sleep 30 & printf '%s\\n' "$!" >> "${root}/pids"; printf '%s\\n' "$!" > "${state}/started" ;;
  fail) exit 1 ;;
  *) ;;
esac
exit 0
`, { mode: 0o700 });
});
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  // The stand-in apps the launcher started (their pids only; nothing else is signalled).
  try { for (const line of fs.readFileSync(path.join(root, "pids"), "utf8").split("\n")) if (/^\d+$/.test(line)) { try { process.kill(Number(line), "SIGKILL"); } catch { /* gone */ } } } catch { /* none */ }
  try { fs.chmodSync(parent, 0o755); } catch { /* not changed */ }
  fs.rmSync(root, { recursive: true, force: true });
});

/** An "app" that is still running: a sleep the test ends (or a pid that has already exited). */
function app(running = true) {
  if (!running) { const done = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" }); return { pid: Number(done.stdout.trim()), quit() {} }; }
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  children.push(child);
  return { pid: child.pid!, quit: () => child.kill("SIGTERM") };
}
function behaviour(...steps: string[]) { fs.writeFileSync(path.join(root, "behaviour"), `${steps.join("\n")}\n`); }
function runHelper(pid: number, { exitTimeout = 5, confirmTimeout = 2, stagingPath = staging } = {}) {
  const child = spawn("/bin/sh", [path.join(state, "helper.sh"), process.platform === "darwin" ? "darwin" : "linux", state, String(pid), target, stagingPath, "0.1.3", "0.1.4", launcher, "0", String(exitTimeout), String(confirmTimeout)], { stdio: "ignore" });
  children.push(child);
  return new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
}
const version = () => fs.readFileSync(path.join(target, "Contents", "version"), "utf8");
const states = () => fs.readFileSync(path.join(state, "helper-state"), "utf8").trim().split("\n");
const launches = () => { try { return fs.readFileSync(path.join(root, "launches"), "utf8").trim().split("\n").map(line => line.split("|")[1]); } catch { return []; } };

describe.runIf(posix)("the POSIX update helper", () => {
  it("waits for the app to quit, swaps in the new version, starts it and removes the old one once it confirms", async () => {
    behaviour("confirm");
    const running = app();
    const done = runHelper(running.pid);
    await new Promise(resolve => setTimeout(resolve, 600));
    // Nothing changes while the app runs.
    expect(version()).toBe("0.1.3");
    expect(states()).toEqual(["waiting"]);
    running.quit();
    expect(await done).toBe(0);
    expect(version()).toBe("0.1.4");
    expect(states()).toEqual(["waiting", "swapped", "launched", "confirmed", "done"]);
    expect(launches()).toEqual(["--updated-from=0.1.3"]);
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.readFileSync(path.join(state, "helper.log"), "utf8")).toMatch(/helper started for 0\.1\.3 -> 0\.1\.4/);
  });

  it("puts the old version back and starts it when the new one quits without confirming", async () => {
    behaviour("exit", "none");
    expect(await runHelper(app(false).pid)).toBe(1);
    expect(version()).toBe("0.1.3");
    expect(states()).toEqual(["waiting", "swapped", "launched", "rolling_back:new_app_exited", "rolled_back:new_app_exited"]);
    expect(launches()).toEqual(["--updated-from=0.1.3", "--update-rolled-back=0.1.4"]);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it("rolls back when the new version never starts, or cannot be started", async () => {
    behaviour("none", "none");
    expect(await runHelper(app(false).pid, { confirmTimeout: 1 })).toBe(1);
    expect(version()).toBe("0.1.3");
    expect(states().at(-1)).toBe("rolled_back:not_started");

    // A fresh attempt whose launch fails at once.
    fs.rmSync(path.join(state, "helper-state"));
    fs.rmSync(path.join(root, "launches"));
    fs.mkdirSync(path.join(staging, "new", "MCP for NovelAI.app", "Contents"), { recursive: true });
    fs.writeFileSync(path.join(staging, "new", "MCP for NovelAI.app", "Contents", "version"), "0.1.4");
    behaviour("fail", "none");
    expect(await runHelper(app(false).pid)).toBe(1);
    expect(version()).toBe("0.1.3");
    expect(states()).toEqual(["waiting", "swapped", "rolling_back:launch_failed", "rolled_back:launch_failed"]);
    expect(launches()).toEqual(["--updated-from=0.1.3", "--update-rolled-back=0.1.4"]);
  });

  it("leaves a new version that is still starting in place (it removes the old one itself once it confirms)", async () => {
    behaviour("slow");
    expect(await runHelper(app(false).pid, { confirmTimeout: 1 })).toBe(0);
    expect(version()).toBe("0.1.4");
    expect(states().at(-1)).toBe("slow");
    expect(fs.existsSync(path.join(staging, "old", "Contents", "version"))).toBe(true);
  });

  it("changes nothing when the app does not quit, the update was withdrawn or the arguments are wrong", async () => {
    behaviour("confirm");
    expect(await runHelper(app().pid, { exitTimeout: 1 })).toBe(1);
    expect(states()).toEqual(["waiting", "aborted:app_running"]);
    expect(version()).toBe("0.1.3");
    expect(launches()).toEqual([]);

    fs.rmSync(path.join(updates, "pending.json"));
    expect(await runHelper(app(false).pid)).toBe(1);
    expect(version()).toBe("0.1.3");
    expect(launches()).toEqual([]);

    expect(await runHelper(app(false).pid, { stagingPath: path.join(parent, "elsewhere") })).toBe(2);
    expect(await runHelper(app(false).pid, { stagingPath: path.join(root, ".mcp-for-novelai-update-x") })).toBe(2);
    expect(version()).toBe("0.1.3");
    expect(fs.existsSync(path.join(staging, "new"))).toBe(true);
  });

  it("changes nothing and starts the old app again when the app cannot be moved (no permission)", async () => {
    if (process.getuid?.() === 0) return; // root may rename anyway
    behaviour("none");
    fs.chmodSync(parent, 0o555);
    expect(await runHelper(app(false).pid)).toBe(1);
    fs.chmodSync(parent, 0o755);
    expect(version()).toBe("0.1.3");
    expect(states()).toEqual(["waiting", "aborted:not_movable"]);
    expect(launches()).toEqual(["--update-rolled-back=0.1.4"]);
  });

  it("is finished by the next start of the new version when the helper is stopped after the swap", async () => {
    behaviour("slow");
    const done = runHelper(app(false).pid, { confirmTimeout: 30 });
    // Stop the helper once the new version is in place (the user, a crash, a power cut).
    const until = Date.now() + 10_000;
    while (!fs.existsSync(path.join(state, "started")) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
    children.at(-1)!.kill("SIGKILL");
    await done;
    expect(version()).toBe("0.1.4");
    expect(fs.existsSync(path.join(staging, "old"))).toBe(true);
    // The new version starts (as the user would open it): it confirms and removes the old one.
    const next = startupUpdate({ updatesDir: updates, version: "0.1.4", target, pid: process.pid, platform: process.platform });
    expect(next.result).toEqual({ kind: "updated", from: "0.1.3", to: "0.1.4" });
    next.confirm();
    next.cleanup();
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(path.join(updates, "pending.json"))).toBe(false);
    expect(fs.readFileSync(path.join(state, "confirmed"), "utf8").trim()).toBe(String(process.pid));
  });

  it("is safe when stopped while it waits: nothing changed, and the old version reports the attempt", async () => {
    behaviour("confirm");
    const running = app();
    const done = runHelper(running.pid);
    await new Promise(resolve => setTimeout(resolve, 400));
    children.at(-1)!.kill("SIGKILL");
    await done;
    running.quit();
    expect(version()).toBe("0.1.3");
    const next = startupUpdate({ updatesDir: updates, version: "0.1.3", target, pid: process.pid, platform: process.platform });
    expect(next.result).toEqual({ kind: "failed", to: "0.1.4", reason: "stopped_waiting" });
    next.cleanup();
    expect(fs.existsSync(staging)).toBe(false);
  });
});
