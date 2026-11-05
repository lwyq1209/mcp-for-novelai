import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDataRoot, dataRootRefusal, readMarker } from '../lib/guard.mjs';
import { worktreeRoot } from '../lib/paths.mjs';
import { tempDir } from './helpers.mjs';

const home = os.homedir();

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

test('a symbolic link into a real location is resolved before the check', t => {
  if (process.platform === 'win32') return t.skip('symlink rights differ on Windows');
  const dir = tempDir(t);
  const link = path.join(dir, 'link');
  fs.symlinkSync(path.join(home, 'Library'), link);
  assert.ok(dataRootRefusal(path.join(link, 'Application Support', 'mcp-for-novelai')), 'a path through a symlink to ~/Library is refused');
  assert.throws(() => checkDataRoot(link), error => error.code === 'refused_location' || error.code === 'refused_symlink');
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

  if (process.platform !== 'win32') {
    fs.symlinkSync(fresh, path.join(dir, 'alias'));
    assert.throws(() => checkDataRoot(path.join(dir, 'alias')), { code: 'refused_symlink' });
  }

  // requireEmpty (seed-library): a marked folder may hold only the dev-tools folder.
  assert.doesNotThrow(() => checkDataRoot(fresh, { requireEmpty: true }));
  fs.writeFileSync(path.join(fresh, 'library.sqlite'), '');
  assert.throws(() => checkDataRoot(fresh, { requireEmpty: true }), { code: 'refused_not_empty' });
});

test('checkDataRoot never creates a refused folder', () => {
  const target = path.join(home, 'Library', 'Application Support', `nai-devtools-never-${process.pid}`);
  assert.throws(() => checkDataRoot(target, { create: true }), { code: 'refused_location' });
  assert.equal(fs.existsSync(target), false);
});
