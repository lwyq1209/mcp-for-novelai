/**
 * Windows only: start a process outside the caller's process tree and job objects, with Win32_Process.Create (WMI).
 * Some terminals and agent hosts put everything they start into a job that is killed when a tab closes; a process the
 * WMI host creates is not in that job, so it outlives the caller. Used by the source launcher
 * (scripts/win32-launch.mjs, start-client.mjs --detach) and by the MCP server's automatic start of the app
 * (src/app-launch.mjs). Nothing here runs on another platform.
 *
 * Win32_ProcessStartup.EnvironmentVariables replaces the whole environment block of the new process, so callers pass
 * the complete environment they want it to have. ShowWindow is the first window's show state (STARTUPINFO
 * wShowWindow): 0 (SW_HIDE) for a console launcher, 4 (SW_SHOWNOACTIVATE) for an app window that must not take the
 * focus.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const SW_HIDE = 0;
export const SW_SHOWNOACTIVATE = 4;

const WMI_CREATE = [
  "$ErrorActionPreference = 'Stop'",
  '$j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
  '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]$j.showWindow; EnvironmentVariables = [string[]]$j.env }',
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$j.commandLine; CurrentDirectory = [string]$j.cwd; ProcessStartupInformation = $startup }',
  "[Console]::Out.Write('wmi:' + $r.ReturnValue + ':' + $r.ProcessId)",
].join('; ');

/**
 * One argument of a Windows command line, quoted the way CommandLineToArgvW (and so Chromium and Node) reads it back:
 * bare when it has no space, tab or quote; otherwise in double quotes, with every quote escaped and the backslashes
 * before a quote (or before the closing quote) doubled. Not for the program name (see windowsCommandLine).
 */
export function windowsArgument(value) {
  const text = String(value);
  if (text && !/[\s"]/.test(text)) return text;
  let out = '"', backslashes = 0;
  for (const ch of text) {
    if (ch === '\\') { backslashes++; continue; }
    if (ch === '"') { out += `${'\\'.repeat(backslashes * 2 + 1)}"`; backslashes = 0; continue; }
    out += `${'\\'.repeat(backslashes)}${ch}`; backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

/** A command line for `program` and `args`. The program name is read up to its closing quote, without escapes (a
 * Windows path cannot contain a quote), so it is always quoted plainly. */
export function windowsCommandLine(program, args = []) {
  const name = String(program);
  if (name.includes('"')) throw new TypeError('A Windows program path cannot contain a quote.');
  return [`"${name}"`, ...args.map(windowsArgument)].join(' ');
}

/** PowerShell of this Windows (System32), falling back to the one on PATH. */
export function powershellPath(env = process.env, exists = existsSync) {
  const root = Object.entries(env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  const full = root ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
  return full && exists(full) ? full : 'powershell.exe';
}

/** The PowerShell call that creates the process: {command, args, input}. `env` is the complete environment. */
export function outsideJobRequest({ commandLine, cwd, env, showWindow = SW_HIDE }, { powershell = 'powershell.exe' } = {}) {
  if (!Number.isInteger(showWindow) || showWindow < 0 || showWindow > 11) throw new TypeError('showWindow must be an SW_* value 0–11.');
  const payload = Buffer.from(JSON.stringify({ commandLine, cwd, showWindow, env: Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`) }), 'utf8').toString('base64');
  return { command: powershell, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WMI_CREATE], input: payload };
}

/**
 * The outcome of that call: {pid} when Win32_Process.Create answered 0 with a process id; otherwise {pid: null,
 * reason, ambiguous}. Ambiguous: the call timed out, or PowerShell succeeded without a readable answer — the process
 * may have been created anyway. A definite failure never created a process.
 */
export function outsideJobOutcome(result) {
  const match = /wmi:(\d+):(\d+)$/.exec(String(result.stdout ?? '').trim());
  if (!result.error && result.status === 0 && match && match[1] === '0' && match[2] !== '0') return { pid: Number(match[2]) };
  const ambiguous = result.error?.code === 'ETIMEDOUT' || (!result.error && result.status === 0 && !match);
  const reason = result.error?.message ?? (match ? `Win32_Process.Create returned ${match[1]}` : `PowerShell exit ${result.status}${result.stderr ? `: ${String(result.stderr).trim().split(/\r?\n/)[0]}` : ''}`);
  return { pid: null, reason, ambiguous };
}

/** Synchronous form (the source launcher). `run` is injectable for tests. */
export function createOutsideJob(request, { run = spawnSync, timeoutMs = 60_000, powershell = 'powershell.exe' } = {}) {
  const { command, args, input } = outsideJobRequest(request, { powershell });
  return outsideJobOutcome(run(command, args, { input, encoding: 'utf8', windowsHide: true, timeout: timeoutMs }));
}

/** Asynchronous form (the MCP server, whose event loop must keep serving other calls meanwhile). */
export function createOutsideJobAsync(request, { spawnImpl = spawn, timeoutMs = 60_000, powershell = 'powershell.exe' } = {}) {
  const { command, args, input } = outsideJobRequest(request, { powershell });
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, timedOut = false;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(outsideJobOutcome(result)); };
    let child;
    try { child = spawnImpl(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (error) { finish({ error }); return; }
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } finish({ error: Object.assign(new Error(`PowerShell did not answer within ${timeoutMs} ms`), { code: 'ETIMEDOUT' }) }); }, timeoutMs);
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-4096); });
    child.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4096); });
    child.once('error', error => finish({ error }));
    child.once('close', status => { if (!timedOut) finish({ status, stdout, stderr }); });
    child.stdin?.on('error', () => { /* the exit status tells */ });
    child.stdin?.end(input);
  });
}
