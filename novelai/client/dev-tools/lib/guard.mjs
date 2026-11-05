// Safety guard of every dev-tools entry that takes a data root. A test data root must be explicit, must not be (or be
// inside) a real client location, and must be a fresh folder or one these tools marked as a test data root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolError } from './cli.mjs';
import { clientDir, dataPaths, devToolsDir, devToolsFolder, novelaiDir, worktreeRoot } from './paths.mjs';

export const MARKER_FILE = 'marker.json';
const MARKER_TOOL = 'mcp-for-novelai dev-tools test data root';

function pathFor(platform) { return platform === 'win32' ? path.win32 : path.posix; }

/** Locations whose contents belong to a real installation or the user (each blocks itself and everything inside). */
export function blockedRoots({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const p = pathFor(platform);
  const roots = [];
  const add = value => { if (typeof value === 'string' && value.trim() && p.isAbsolute(value.trim())) roots.push({ path: p.normalize(value.trim()) }); };
  // Whatever the client itself would use as its application data folder (data-paths.cjs).
  add(dataPaths.appDataDirectory({ platform, env, homedir }));
  if (platform === 'darwin') {
    add(p.join(homedir, 'Library'));
    add(p.join(homedir, 'Pictures'));
  } else if (platform === 'win32') {
    add(env.APPDATA); add(env.LOCALAPPDATA);
    add(p.join(homedir, 'AppData'));
    add(p.join(homedir, 'Pictures'));
    add(p.join(homedir, 'OneDrive', 'Pictures'));
  } else {
    add(env.XDG_CONFIG_HOME); add(p.join(homedir, '.config'));
    add(env.XDG_DATA_HOME); add(p.join(homedir, '.local', 'share'));
    add(p.join(homedir, 'Pictures'));
  }
  return roots;
}

const sameOrInside = (p, child, parent) => {
  const relative = p.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !p.isAbsolute(relative));
};

/** The absolute path with every existing ancestor resolved through symbolic links (the missing tail kept as written). */
export function canonicalPath(value, platform = process.platform) {
  const p = pathFor(platform);
  let current = p.resolve(value);
  const tail = [];
  for (;;) {
    try { return p.join(fs.realpathSync.native(current), ...tail.reverse()); }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      const parent = p.dirname(current);
      if (parent === current) return p.join(current, ...tail.reverse());
      tail.push(p.basename(current));
      current = parent;
    }
  }
}

/**
 * Why `dataRoot` may not be used as a test data root, or null. Pure apart from resolving symbolic links of existing
 * ancestors. Platform/env/homedir are injectable for tests.
 */
export function dataRootRefusal(dataRoot, { platform = process.platform, env = process.env, homedir = os.homedir(), tmpdir = platform === process.platform ? os.tmpdir() : null, checkout = { worktreeRoot, novelaiDir, clientDir, devToolsDir } } = {}) {
  const p = pathFor(platform);
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) return 'A test data root must be given explicitly with --data <folder>.';
  const resolved = platform === process.platform ? canonicalPath(dataRoot.trim(), platform) : p.resolve(dataRoot.trim());
  const compare = platform === 'win32' || platform === 'darwin' ? value => value.toLowerCase() : value => value;
  const inside = (child, parent) => sameOrInside(p, compare(child), compare(parent));
  const home = p.normalize(homedir);
  // A subfolder of the OS temp folder is always a throwaway location (on Windows it lives inside %LOCALAPPDATA%).
  const temp = tmpdir ? (platform === process.platform ? canonicalPath(tmpdir, platform) : p.normalize(tmpdir)) : null;
  const inTemp = Boolean(temp && inside(resolved, temp) && compare(resolved) !== compare(temp));
  for (const root of inTemp ? [] : blockedRoots({ platform, env, homedir })) {
    const canonicalRoot = platform === process.platform ? canonicalPath(root.path, platform) : root.path;
    if (inside(resolved, canonicalRoot) || inside(resolved, root.path)) return `${resolved} is inside ${root.path}, a real application-data or Pictures location; test data roots never go there.`;
  }
  const segments = compare(resolved).split(/[\\/]+/);
  if (segments.includes('.runtime') || segments.includes('.isolated')) return `${resolved} is inside a .runtime or .isolated folder (live client state of a checkout); test data roots never go there.`;
  // The data root must not hold (or be) the home folder, the file-system root or this checkout.
  for (const keep of [home, checkout.worktreeRoot, checkout.novelaiDir, checkout.clientDir, checkout.devToolsDir]) {
    if (inside(keep, resolved)) return `${resolved} is ${compare(keep) === compare(resolved) ? '' : 'an ancestor of '}${keep}; choose a dedicated empty folder.`;
  }
  // Inside this checkout only its ignored .tmp folders are allowed (a data root must never land in tracked files).
  if (inside(resolved, checkout.worktreeRoot)) {
    const allowed = [p.join(checkout.worktreeRoot, '.tmp'), p.join(checkout.novelaiDir, '.tmp'), p.join(checkout.clientDir, '.tmp')];
    if (!allowed.some(folder => inside(resolved, folder) && compare(resolved) !== compare(folder))) return `${resolved} is inside this checkout but not under one of its .tmp/ folders.`;
  }
  return null;
}

/** The marker of a test data root, or null (never throws on unreadable markers: an unreadable marker is no marker). */
export function readMarker(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(devToolsFolder(dataRoot), MARKER_FILE), 'utf8'));
    return value && value.tool === MARKER_TOOL ? value : null;
  } catch { return null; }
}

export function writeMarker(dataRoot) {
  const folder = devToolsFolder(dataRoot);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, MARKER_FILE);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ tool: MARKER_TOOL, createdAt: new Date().toISOString(), worktree: worktreeRoot }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Checks a data root for use and returns its resolved path. Refuses (ToolError refused_*) a missing --data, a real
 * location, a symbolic link, a file, and an existing non-empty folder that these tools did not mark, unless `adopt`.
 * `requireEmpty` (seed-library) also refuses a marked folder that holds anything besides the dev-tools folder.
 */
export function checkDataRoot(dataRoot, { adopt = false, requireEmpty = false, create = false } = {}) {
  const refusal = dataRootRefusal(dataRoot);
  if (refusal) throw new ToolError('refused_location', refusal);
  const resolved = canonicalPath(dataRoot.trim());
  let stat = null;
  try { stat = fs.lstatSync(path.resolve(dataRoot.trim())); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (stat?.isSymbolicLink()) throw new ToolError('refused_symlink', `${dataRoot} is a symbolic link; give the real folder.`);
  if (stat && !stat.isDirectory()) throw new ToolError('refused_not_folder', `${resolved} exists and is not a folder.`);
  const entries = stat ? fs.readdirSync(resolved).filter(name => name !== '.DS_Store') : [];
  const marked = Boolean(stat && readMarker(resolved));
  if (entries.length && !marked && !adopt) throw new ToolError('refused_unmarked', `${resolved} is not empty and was not created by these tools (no ${path.join('.dev-tools', MARKER_FILE)}). Use a new folder, or pass --adopt if it is a throwaway test folder.`);
  if (requireEmpty && entries.some(name => name !== '.dev-tools')) throw new ToolError('refused_not_empty', `${resolved} is not empty; seed-library builds a library only in a new, empty test data root.`);
  if (create) { fs.mkdirSync(resolved, { recursive: true, mode: 0o700 }); writeMarker(resolved); }
  return { dataRoot: resolved, existed: Boolean(stat), marked, empty: entries.length === 0 };
}
