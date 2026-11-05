import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeDataDirectory, isInstallationDataPath } from './data-directory-guard';

let root: string;
let install: string;
let outside: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-data-directory-guard-'));
  install = path.join(root, 'App 中文'); outside = path.join(root, 'App 中文-pictures');
  fs.mkdirSync(install); fs.mkdirSync(outside);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('save folders outside the install directory', () => {
  it('refuses arbitrary custom names inside the install directory and the install root itself', () => {
    for (const dir of [install, path.join(install, '我的图片', '2026-09-10'), path.join(install, 'saved')]) {
      expect(() => assertSafeDataDirectory(dir, install)).toThrow("install folder");
      expect(isInstallationDataPath(dir, install)).toBe(true);
    }
  });
  it('allows sibling names and unrelated external folders without changing files', () => {
    fs.writeFileSync(path.join(outside, 'image.webp'), 'image');
    expect(isInstallationDataPath(outside, install)).toBe(false);
    expect(() => assertSafeDataDirectory(outside, install)).not.toThrow();
    expect(fs.readFileSync(path.join(outside, 'image.webp'), 'utf8')).toBe('image');
  });
  it('refuses traversal back into the install directory and not-yet-created folders there', () => {
    expect(() => assertSafeDataDirectory(path.join(outside, '..', path.basename(install), 'new'), install)).toThrow();
  });
  it('refuses a relative folder and leaves an empty value to the caller', () => {
    expect(() => assertSafeDataDirectory('relative/folder', install)).toThrow();
    expect(() => assertSafeDataDirectory('', install)).not.toThrow();
  });
  it('resolves junction aliases including missing children', () => {
    const alias = path.join(root, 'alias'); fs.symlinkSync(install, alias, 'junction');
    expect(() => assertSafeDataDirectory(path.join(alias, 'future'), install)).toThrow();
    expect(isInstallationDataPath(alias, install)).toBe(true);
  });
  it('refuses an in-install junction even when its physical target is external', () => {
    const link = path.join(install, 'linked'); fs.symlinkSync(outside, link, 'junction');
    expect(() => assertSafeDataDirectory(link, install)).toThrow();
  });
});
