// The Electron a background test window runs on (review rework 2, 2026-11). On macOS a copy of this checkout's
// node_modules/electron/dist/Electron.app whose Info.plist says LSUIElement=1 (an agent app: no Dock icon, no menu bar,
// and macOS never makes it the active app when it launches), ad-hoc signed again; elsewhere the plain Electron. The copy
// is an APFS clone (cp -c; a plain copy where the volume cannot clone) under node_modules/.cache/nai-dev-tools-electron/
// (never in git), made on first use and made again when Electron changes (version, executable or Info.plist).
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { clientDir, electronExecutable } from './paths.mjs';

/** Bump when the way the copy is made changes (every existing copy is then made again). */
export const BACKGROUND_APP_RECIPE = 1;
export const BACKGROUND_APP_CACHE = path.join(clientDir, 'node_modules', '.cache', 'nai-dev-tools-electron');
const READY = 'ready.json';

const sha = value => createHash('sha256').update(value).digest('hex');

/**
 * Where the copy for the installed Electron lives (nothing is made): {supported, source, executable, folder, stamp,
 * built}. `supported` is false off macOS (the plain Electron is used there).
 */
export function backgroundAppPaths({ cache = BACKGROUND_APP_CACHE, source = electronExecutable() } = {}) {
  if (process.platform !== 'darwin' || !source.includes('.app/')) return { supported: false, source, executable: source, built: true };
  const appDir = source.slice(0, source.indexOf('.app/') + 4), inside = source.slice(appDir.length + 1);
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(clientDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version; } catch { /* stamped by the files */ }
  const info = fs.statSync(source), plist = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'));
  const stamp = sha(JSON.stringify({ recipe: BACKGROUND_APP_RECIPE, version, size: info.size, mtimeMs: Math.floor(info.mtimeMs), plist: sha(plist) })).slice(0, 16);
  const folder = path.join(cache, `${version}-${stamp}`);
  const executable = path.join(folder, path.basename(appDir), inside);
  return { supported: true, source, sourceApp: appDir, version, stamp, folder, app: path.join(folder, path.basename(appDir)), executable, built: fs.existsSync(path.join(folder, READY)) && fs.existsSync(executable) };
}

/** Whether a bundle's Info.plist says LSUIElement=1. */
export function isAgentApp(app) {
  try { return execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSUIElement', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; }
  catch { return false; }
}

/**
 * The executable a test window starts (making the macOS copy first when it is missing or stale). Older copies are
 * removed when no process runs from them.
 */
export function backgroundElectronExecutable(options = {}) {
  const paths = backgroundAppPaths(options);
  if (!paths.supported || paths.built) return paths.executable;
  const cache = path.dirname(paths.folder);
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const building = path.join(cache, `.build-${process.pid}-${randomUUID()}`), app = path.join(building, path.basename(paths.sourceApp));
  fs.mkdirSync(building, { mode: 0o700 });
  try {
    try { execFileSync('cp', ['-c', '-R', paths.sourceApp, app], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { fs.rmSync(app, { recursive: true, force: true }); execFileSync('cp', ['-R', paths.sourceApp, app], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    execFileSync('plutil', ['-replace', 'LSUIElement', '-bool', 'YES', path.join(app, 'Contents', 'Info.plist')], { stdio: ['ignore', 'ignore', 'pipe'] });
    // Ad-hoc signature again over the changed Info.plist (every nested part too, so the whole bundle verifies).
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (!isAgentApp(app)) throw new Error('The copied Electron.app does not say LSUIElement=1.');
    fs.writeFileSync(path.join(building, READY), `${JSON.stringify({ recipe: BACKGROUND_APP_RECIPE, version: paths.version, stamp: paths.stamp, source: paths.sourceApp, madeAt: new Date().toISOString() }, null, 2)}\n`);
    try { fs.renameSync(building, paths.folder); }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; } // another process made it first
  } finally { fs.rmSync(building, { recursive: true, force: true }); }
  removeStaleCopies(cache, paths.folder);
  if (!fs.existsSync(paths.executable)) throw new Error(`The background Electron copy was not made (${paths.executable}).`);
  return paths.executable;
}

/** Every executable a test client of this checkout may run on (the plain Electron and, on macOS, its agent copy). */
export function clientExecutables() {
  const plain = electronExecutable(), paths = backgroundAppPaths({ source: plain });
  return paths.supported ? [plain, paths.executable] : [plain];
}

/** Removes copies made for an older Electron when no process runs from them (never the current one). */
function removeStaleCopies(cache, current) {
  let commands = '';
  try { commands = execFileSync('ps', ['-axww', '-o', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return; }
  for (const name of fs.readdirSync(cache)) {
    const folder = path.join(cache, name);
    if (folder === current || commands.includes(`${folder}/`)) continue;
    // A copy being made right now by another process is left alone; one left by a crashed maker goes after 10 minutes.
    if (name.startsWith('.build-')) { try { if (Date.now() - fs.statSync(folder).mtimeMs < 10 * 60_000) continue; } catch { continue; } }
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
