// Windows, with the real Electron of the client: the first window of an app an agent started appears minimized in the
// taskbar without ever being activated or seen (window-show.ts showMinimizedInactive, bundled here with esbuild and run
// in an Electron main process on a throwaway userData). Nothing of the app itself starts.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, expect, it } from 'vitest';

const client = path.resolve(__dirname, '..');
const electron = (() => { try { return path.join(client, 'node_modules', 'electron', 'dist', fs.readFileSync(path.join(client, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()); } catch { return null; } })();
const runnable = process.platform === 'win32' && Boolean(electron && fs.existsSync(electron));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });

const MAIN = String.raw`const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const [userData, modulePath, out] = process.argv.slice(-3);
app.setPath('userData', userData);
const { presentAgentWindow } = require(modulePath);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The system's foreground window (GetForegroundWindow), from outside this process.
const foreground = () => Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -Name F -Namespace N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern System.IntPtr GetForegroundWindow();'; [N.F]::GetForegroundWindow().ToInt64()"],
  { encoding: 'utf8', windowsHide: true }).trim());
app.whenReady().then(async () => {
  // The main window's own options (main.ts createWindow) that matter here.
  const win = new BrowserWindow({ width: 1120, height: 720, show: false, frame: false, backgroundColor: '#0b0a10', webPreferences: { backgroundThrottling: false } });
  const events = [];
  for (const name of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore']) win.on(name, () => events.push({ name, opacity: win.getOpacity(), minimized: win.isMinimized() }));
  const ready = new Promise(resolve => win.once('ready-to-show', resolve));
  await win.loadURL('data:text/html,<body style="background:#0b0a10;color:#fff">agent window</body>');
  await ready;
  const hwnd = Number(win.getNativeWindowHandle().readBigUInt64LE(0));
  const before = foreground();
  const shown = presentAgentWindow(win, 'win32');
  const atOnce = { state: shown.state, mode: shown.mode, minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused(), focusedWindow: BrowserWindow.getFocusedWindow() !== null, opacity: win.getOpacity() };
  atOnce.foreground = foreground();
  await sleep(1500);
  const later = { minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused(), opacity: win.getOpacity(), foreground: foreground() };
  const eventsBeforeRestore = events.slice();
  // The user clicking its taskbar button.
  win.restore(); await sleep(800);
  const restored = { minimized: win.isMinimized(), visible: win.isVisible(), opacity: win.getOpacity() };
  fs.writeFileSync(out, JSON.stringify({ hwnd, before, atOnce, later, eventsBeforeRestore, restored }));
  app.exit(0);
}).catch(error => { fs.writeFileSync(out, JSON.stringify({ error: String(error && error.stack || error) })); app.exit(1); });
`;

it.runIf(runnable)('win32: the first window of an agent start is minimized in the taskbar, never activated or shown opaque; its button restores it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-agent-window-')); roots.push(root);
  const modulePath = path.join(root, 'window-show.cjs'), main = path.join(root, 'main.cjs'), out = path.join(root, 'out.json'), userData = path.join(root, 'user data');
  buildSync({ entryPoints: [path.join(__dirname, 'window-show.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: modulePath, external: ['electron'], logLevel: 'silent' });
  fs.writeFileSync(main, MAIN);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ELECTRON_/i.test(key)));
  const child = spawn(electron!, [main, userData, modulePath, out], { env, stdio: 'ignore' });
  const code = await new Promise<number | null>(resolve => { const timer = setTimeout(() => { child.kill(); resolve(null); }, 90_000); child.once('exit', status => { clearTimeout(timer); resolve(status); }); });
  const report = JSON.parse(fs.readFileSync(out, 'utf8'));
  expect(report.error, report.error).toBeUndefined();
  expect(code).toBe(0);
  // At once: minimized (not "visible" by Electron's Windows definition), not focused, not the foreground, still transparent.
  expect(report.atOnce).toMatchObject({ mode: 'minimized', state: 'minimized', minimized: true, visible: false, focused: false, focusedWindow: false, opacity: 0 });
  expect(report.atOnce.foreground).not.toBe(report.hwnd);
  // After the minimize animation: opaque again, still minimized and never focused.
  expect(report.later).toMatchObject({ minimized: true, visible: false, focused: false, opacity: 1 });
  expect(report.later.foreground).not.toBe(report.hwnd);
  // It never had the focus, and it was only ever shown while fully transparent.
  expect(report.eventsBeforeRestore.map((event: { name: string }) => event.name)).not.toContain('focus');
  for (const event of report.eventsBeforeRestore.filter((row: { name: string }) => row.name === 'show' || row.name === 'minimize')) expect(event.opacity).toBe(0);
  expect(report.eventsBeforeRestore.map((event: { name: string }) => event.name)).toContain('minimize');
  // Its taskbar button restores it as an ordinary, opaque window.
  expect(report.restored).toEqual({ minimized: false, visible: true, opacity: 1 });
}, 120_000);
