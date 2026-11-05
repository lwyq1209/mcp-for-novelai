// Windows: how the automatic start sees an app that is starting (src/app-autostart.mjs appInstanceState). Chromium's
// single-instance lock on Windows is <userData>\lockfile, held open with delete-on-close by the running instance;
// checked here with the real Electron of the client (no window, a throwaway userData). macOS and Linux use the
// SingletonLock symlink (tests/app-autostart.test.mjs; seen on a real macOS client while writing the feature).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appInstanceState } from '../src/app-autostart.mjs';

const client = join(import.meta.dirname, '..', 'client');
const electron = (() => { try { return join(client, 'node_modules', 'electron', 'dist', readFileSync(join(client, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()); } catch { return null; } })();
const skip = process.platform !== 'win32' ? 'win32 only' : !electron || !existsSync(electron) ? 'Electron is not installed in novelai/client' : false;

const MAIN = `const { app } = require('electron');
const fs = require('node:fs');
const [userData, marker] = process.argv.slice(-2);
app.setPath('userData', userData);
if (!app.requestSingleInstanceLock()) { fs.writeFileSync(marker, 'second'); app.exit(0); }
else { fs.writeFileSync(marker, 'locked'); setTimeout(() => app.exit(0), 60000); }
`;

const waitFor = async (check, ms = 30_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await check()) return true; await new Promise(resolve => setTimeout(resolve, 100)); } return false; };

test('win32: a running Electron instance holds <userData>\\lockfile; it is gone once the instance exits', { skip, timeout: 120_000 }, async t => {
  const base = mkdtempSync(join(tmpdir(), 'nai-instance-win32-'));
  const children = [];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  const main = join(base, 'main.js'), userData = join(base, 'user data'), first = join(base, 'first.txt'), second = join(base, 'second.txt');
  writeFileSync(main, MAIN);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ELECTRON_/i.test(key)));
  assert.equal(await appInstanceState(userData, { platform: 'win32' }), 'absent');
  const one = spawn(electron, [main, userData, first], { env, stdio: 'ignore' }); children.push(one);
  assert.ok(await waitFor(() => existsSync(first)), 'the first instance started');
  assert.equal(readFileSync(first, 'utf8'), 'locked');
  assert.equal(await appInstanceState(userData, { platform: 'win32' }), 'running');
  const two = spawn(electron, [main, userData, second], { env, stdio: 'ignore' }); children.push(two);
  assert.ok(await waitFor(() => existsSync(second)), 'the second instance started');
  assert.equal(readFileSync(second, 'utf8'), 'second', 'the lock of that userData is held');
  const exited = new Promise(resolve => one.once('exit', resolve));
  one.kill(); await exited;
  assert.ok(await waitFor(async () => (await appInstanceState(userData, { platform: 'win32' })) === 'absent', 10_000), 'lockfile is removed when the instance is gone');
});
