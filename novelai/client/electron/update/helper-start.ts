// Starts the update helper so that it outlives the app: macOS and Linux a detached child in its own session (no stdio,
// unref'd); Windows outside the app's process tree and job objects through Win32_Process.Create (the same way the MCP
// server starts the app, novelai/src/win32-process.mjs), hidden, with a detached child as the fallback.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HelperLaunch } from "./updater";

/** One Windows command-line argument, quoted the way CommandLineToArgvW reads it back (novelai/src/win32-process.mjs). */
export function windowsArgument(value: string): string {
  if (value && !/[\s"]/.test(value)) return value;
  let out = '"', backslashes = 0;
  for (const ch of value) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === '"') { out += `${"\\".repeat(backslashes * 2 + 1)}"`; backslashes = 0; continue; }
    out += `${"\\".repeat(backslashes)}${ch}`; backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

export function windowsCommandLine(program: string, args: string[]): string {
  if (program.includes('"')) throw new TypeError("A Windows program path cannot contain a quote.");
  return [`"${program}"`, ...args.map(windowsArgument)].join(" ");
}

/** PowerShell of this Windows (System32), else the one on PATH. */
export function powershellPath(env: Record<string, string | undefined>): string {
  const root = Object.entries(env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
  const full = root ? path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
  return full && fs.existsSync(full) ? full : "powershell.exe";
}

const WMI_CREATE = [
  "$ErrorActionPreference = 'Stop'",
  "$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json",
  "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = [string[]]$j.env }",
  "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$j.commandLine; CurrentDirectory = [string]$j.cwd; ProcessStartupInformation = $startup }",
  "[Console]::Out.Write('wmi:' + $r.ReturnValue + ':' + $r.ProcessId)",
].join("; ");

function spawnDetached(command: string, args: string[], launch: HelperLaunch): Promise<{ ok: true } | { ok: false; reason: string }> {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, { cwd: launch.cwd, env: launch.env, detached: true, stdio: "ignore", windowsHide: true }); }
    catch (error: any) { resolve({ ok: false, reason: `the update helper could not be started (${error?.code ?? error})` }); return; }
    child.once("error", (error: any) => resolve({ ok: false, reason: `the update helper could not be started (${error?.code ?? error})` }));
    child.once("spawn", () => { child.unref(); resolve({ ok: true }); });
  });
}

export async function startHelper(launch: HelperLaunch): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (launch.platform !== "win32") return spawnDetached(launch.command, launch.args, launch);
  const powershell = powershellPath(launch.env);
  const commandLine = windowsCommandLine(powershell, launch.args);
  const payload = Buffer.from(JSON.stringify({ commandLine, cwd: launch.cwd, env: Object.entries(launch.env).map(([key, value]) => `${key}=${value}`) }), "utf8").toString("base64");
  const created = await new Promise<{ pid: number | null; ambiguous: boolean }>(resolve => {
    let stdout = "", done = false;
    const finish = (pid: number | null, ambiguous: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve({ pid, ambiguous }); } };
    let child;
    try { child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WMI_CREATE], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }); }
    catch { finish(null, false); return; }
    // No answer in time: the helper may have been created anyway (ambiguous).
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(null, true); }, 60_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-4096); });
    child.once("error", () => finish(null, false));
    child.once("close", code => { const match = /wmi:(\d+):(\d+)$/.exec(stdout.trim()); finish(match && match[1] === "0" && match[2] !== "0" ? Number(match[2]) : null, code === 0 && !match); });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(payload);
  });
  if (created.pid) return { ok: true };
  // Never a second helper while the first may exist: the caller waits for the helper's first state and withdraws the
  // update (its state folder) when none comes, and a helper that starts late finds its folder gone and stops.
  if (created.ambiguous) return { ok: true };
  return spawnDetached(powershell, launch.args, launch);
}
