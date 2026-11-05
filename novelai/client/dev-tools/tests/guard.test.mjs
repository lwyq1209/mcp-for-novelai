import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blockedRoots, checkDataRoot, dataRootRefusal, readMarker, windowsPicturesDirectory, xdgPicturesDirectory } from '../lib/guard.mjs';
import { dataPaths, worktreeRoot } from '../lib/paths.mjs';
import { tempDir } from './helpers.mjs';

const home = os.homedir();
/** This platform's real application-data folder (macOS ~/Library/Application Support, Windows %APPDATA%, Linux ~/.config). */
const appData = dataPaths.appDataDirectory();

/**
 * The Pictures folder the client's default output folder goes into, found independently of the guard: what the
 * operating system itself reports (Windows: the .NET known-folder lookup; Linux: xdg-user-dir when installed).
 */
function systemPictures() {
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetFolderPath('MyPictures')"], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).trim() || null;
    if (process.platform === 'linux') return execFileSync('xdg-user-dir', ['PICTURES'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
  return null;
}

test('a data root must be given explicitly', () => {
  for (const value of [undefined, '', '   ', true]) assert.match(dataRootRefusal(value), /explicitly/);
});

test('real application-data and Pictures locations are refused, with everything inside them (macOS rules)', () => {
  const darwin = { platform: 'darwin', env: {}, homedir: '/Users/someone', checkout: { worktreeRoot: '/w', novelaiDir: '/w/novelai', clientDir: '/w/novelai/client', devToolsDir: '/w/novelai/client/dev-tools' } };
  for (const value of [
    '/Users/someone/Library/Application Support/mcp-for-novelai',
    '/Users/someone/Library/Application Support/MCP for NovelAI',
    '/Users/someone/Library/Application Support/novelai-image-desktop',
    '/Users/someone/Library/Application Support/Langbai Studio/x',
    '/Users/someone/Library/Application Support',
    '/Users/someone/Library/Caches/x',
    '/Users/someone/Pictures/MCP for NovelAI',
    '/Users/someone/Pictures',
  ]) assert.ok(dataRootRefusal(value, darwin), `${value} should be refused`);
  assert.equal(dataRootRefusal('/Users/someone/tests/data-1', darwin), null);
  assert.equal(dataRootRefusal('/private/var/folders/x/T/nai-1', darwin), null);
});

test('Windows and Linux locations are refused too', () => {
  const win = { platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, homedir: 'C:\\Users\\x', checkout: { worktreeRoot: 'D:\\w', novelaiDir: 'D:\\w\\novelai', clientDir: 'D:\\w\\novelai\\client', devToolsDir: 'D:\\w\\novelai\\client\\dev-tools' } };
  for (const value of ['C:\\Users\\x\\AppData\\Roaming\\mcp-for-novelai', 'c:\\users\\X\\appdata\\roaming\\MCP for NovelAI', 'C:\\Users\\x\\AppData\\Local\\Temp\\..\\x', 'C:\\Users\\x\\Pictures\\MCP for NovelAI', 'C:\\Users\\x\\OneDrive\\Pictures\\a', 'C:\\Users\\x', 'C:\\'])
    assert.ok(dataRootRefusal(value, win), `${value} should be refused`);
  assert.equal(dataRootRefusal('D:\\tests\\data', win), null);
  // The OS temp folder sits inside %LOCALAPPDATA% on Windows: its subfolders stay usable, the rest of it does not.
  const winTemp = { ...win, tmpdir: 'C:\\Users\\x\\AppData\\Local\\Temp' };
  assert.equal(dataRootRefusal('C:\\Users\\x\\AppData\\Local\\Temp\\nai-1', winTemp), null);
  assert.ok(dataRootRefusal('C:\\Users\\x\\AppData\\Local\\Temp', winTemp));
  assert.ok(dataRootRefusal('C:\\Users\\x\\AppData\\Roaming\\mcp-for-novelai', winTemp));
  assert.equal(dataRootRefusal('D:\\w\\.tmp\\data', win), null);
  const linux = { platform: 'linux', env: {}, homedir: '/home/u', checkout: { worktreeRoot: '/w', novelaiDir: '/w/novelai', clientDir: '/w/novelai/client', devToolsDir: '/w/novelai/client/dev-tools' } };
  for (const value of ['/home/u/.config/mcp-for-novelai', '/home/u/.local/share/x', '/home/u/Pictures/a', '/home/u', '/']) assert.ok(dataRootRefusal(value, linux), `${value} should be refused`);
  assert.equal(dataRootRefusal('/tmp/nai-test', linux), null);
});

test('.runtime / .isolated folders of any checkout are refused (the main repository live state)', () => {
  assert.match(dataRootRefusal('/Users/Alice/Projects/mcp-for-novelai/novelai/.runtime'), /\.runtime/);
  assert.match(dataRootRefusal('/Users/Alice/Projects/mcp-for-novelai/novelai/.runtime/user-data'), /\.runtime/);
  assert.match(dataRootRefusal(path.join(os.tmpdir(), 'x', '.isolated', 'y')), /\.isolated/);
});

test('this checkout: only data roots under its .tmp folders, never the checkout or its ancestors', () => {
  assert.ok(dataRootRefusal(worktreeRoot));
  assert.ok(dataRootRefusal(path.dirname(worktreeRoot)));
  assert.ok(dataRootRefusal(path.join(worktreeRoot, 'novelai', 'client', 'src', 'data')));
  assert.ok(dataRootRefusal(path.join(worktreeRoot, '.tmp')), '.tmp itself is refused, a subfolder is needed');
  assert.equal(dataRootRefusal(path.join(worktreeRoot, '.tmp', 'tests', 'a')), null);
  assert.equal(dataRootRefusal(path.join(worktreeRoot, 'novelai', 'client', '.tmp', 'a')), null);
  assert.ok(dataRootRefusal(home));
  assert.ok(dataRootRefusal('/'));
});

test(`this platform's real data root, its former names and the default output folder are refused (${process.platform})`, () => {
  for (const name of ['mcp-for-novelai', 'MCP for NovelAI', 'novelai-image-desktop', 'Langbai Studio']) {
    assert.ok(dataRootRefusal(path.join(appData, name)), `<appData>/${name} is refused`);
    assert.ok(dataRootRefusal(path.join(appData, name, 'nested')), `inside <appData>/${name} is refused`);
  }
  const pictures = [path.join(home, 'Pictures'), systemPictures()].filter(Boolean);
  for (const folder of pictures) {
    const output = dataPaths.defaultOutputDirectory(folder, { env: {} });
    assert.equal(path.basename(output), 'MCP for NovelAI');
    assert.ok(dataRootRefusal(output), 'the default output folder is refused');
    assert.ok(dataRootRefusal(path.join(output, 'nested')), 'inside the default output folder is refused');
  }
});

test('the Pictures folder the OS reports is blocked: XDG user-dirs on Linux, the registry on Windows', () => {
  assert.equal(xdgPicturesDirectory('# written by xdg-user-dirs-update\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_PICTURES_DIR="$HOME/图片"\n', '/home/u'), '/home/u/图片');
  assert.equal(xdgPicturesDirectory('XDG_PICTURES_DIR="/data/My \\"pics\\""', '/home/u'), '/data/My "pics"');
  for (const text of ['XDG_PICTURES_DIR="relative/pics"', '#XDG_PICTURES_DIR="$HOME/x"', '', null]) assert.equal(xdgPicturesDirectory(text, '/home/u'), null, String(text));
  const reg = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders\r\n    My Pictures    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Bilder\r\n\r\n';
  assert.equal(windowsPicturesDirectory(reg, { USERPROFILE: 'C:\\Users\\x' }), 'C:\\Users\\x\\OneDrive\\Bilder');
  assert.equal(windowsPicturesDirectory('    My Pictures    REG_SZ    D:\\Pics\r\n', {}), 'D:\\Pics');
  assert.equal(windowsPicturesDirectory('    My Pictures    REG_EXPAND_SZ    %UNSET%\\Pics\r\n', {}), null, 'an unexpanded variable is not a path');
  const linux = { platform: 'linux', env: {}, homedir: '/home/u', pictures: ['/home/u/图片'], checkout: { worktreeRoot: '/w', novelaiDir: '/w/novelai', clientDir: '/w/novelai/client', devToolsDir: '/w/novelai/client/dev-tools' } };
  assert.ok(blockedRoots(linux).some(root => root.path === '/home/u/图片'));
  const win = { platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, homedir: 'C:\\Users\\x', pictures: ['D:\\Pics'] };
  assert.ok(blockedRoots(win).some(root => root.path === 'D:\\Pics'));
});

/** A directory link (a junction on Windows: no symlink rights needed), or null where the OS refuses links. */
function directoryLink(target, link) {
  try { fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return link; }
  catch (error) { if (error?.code === 'EPERM' || error?.code === 'EACCES') return null; throw error; }
}

test('a symbolic link into a real location is resolved before the check', t => {
  const dir = tempDir(t);
  // The link points at the real application-data folder; nothing is read or written through it.
  const link = directoryLink(appData, path.join(dir, 'link'));
  if (!link) return t.skip('this account may not create directory links');
  assert.ok(dataRootRefusal(path.join(link, 'mcp-for-novelai')), 'a path through a link to the real application-data folder is refused');
  assert.throws(() => checkDataRoot(link), error => error.code === 'refused_location' || error.code === 'refused_symlink');
  // A link whose target does not exist yet still resolves into it.
  const dangling = directoryLink(path.join(appData, `nai-devtools-never-${process.pid}`), path.join(dir, 'dangling'));
  assert.ok(dataRootRefusal(path.join(dangling, 'data')), 'a path through a dangling link into the real application-data folder is refused');
  assert.equal(fs.existsSync(path.join(appData, `nai-devtools-never-${process.pid}`)), false);
});

test('checkDataRoot: creates and marks a new folder; refuses unmarked non-empty folders, files and links', t => {
  const dir = tempDir(t);
  const fresh = path.join(dir, 'fresh');
  const created = checkDataRoot(fresh, { create: true });
  assert.equal(created.dataRoot, fresh);
  assert.ok(readMarker(fresh), 'marker written');
  assert.equal(checkDataRoot(fresh).marked, true);

  const foreign = path.join(dir, 'foreign');
  fs.mkdirSync(foreign); fs.writeFileSync(path.join(foreign, 'settings.json'), '{}');
  assert.throws(() => checkDataRoot(foreign), { code: 'refused_unmarked' });
  assert.equal(checkDataRoot(foreign, { adopt: true }).marked, false);

  const file = path.join(dir, 'file');
  fs.writeFileSync(file, 'x');
  assert.throws(() => checkDataRoot(file), { code: 'refused_not_folder' });

  if (directoryLink(fresh, path.join(dir, 'alias'))) assert.throws(() => checkDataRoot(path.join(dir, 'alias')), { code: 'refused_symlink' });

  // requireEmpty (seed-library): a marked folder may hold only the dev-tools folder.
  assert.doesNotThrow(() => checkDataRoot(fresh, { requireEmpty: true }));
  fs.writeFileSync(path.join(fresh, 'library.sqlite'), '');
  assert.throws(() => checkDataRoot(fresh, { requireEmpty: true }), { code: 'refused_not_empty' });
});

test('checkDataRoot never creates a refused folder', () => {
  const target = path.join(appData, `nai-devtools-never-${process.pid}`);
  assert.throws(() => checkDataRoot(target, { create: true }), { code: 'refused_location' });
  assert.equal(fs.existsSync(target), false);
});
