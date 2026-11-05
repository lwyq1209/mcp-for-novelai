import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createPlatformFs, openNoFollow, renameReplace, syncDirectory, type PlatformFsIo } from './platform-fs';

// Same vectors as novelai/tests/platform-fs.test.mjs (ESM twin in novelai/src/platform-fs.mjs).
const vectors = JSON.parse(readFileSync(path.join(__dirname, '../../tests/fixtures/platform-fs-vectors.json'), 'utf8'));
const win32 = process.platform === 'win32';

function stats(spec: any) {
  return { isSymbolicLink: () => spec.type === 'symlink', isFile: () => spec.type === 'file', dev: BigInt(spec.dev ?? 0), ino: BigInt(spec.ino ?? 0) };
}
function fakeIo(vector: any) {
  const calls: string[] = [], sleeps: number[] = [], errors = [...(vector.errors ?? [])]; let renames = 0;
  const coded = (code: string) => Object.assign(new Error(code), { code });
  const handle = { sync: async () => { calls.push('sync'); if (vector.syncError) throw coded(vector.syncError); }, close: async () => { calls.push('close'); }, stat: async () => { calls.push('fstat'); return stats(vector.opened); } };
  const io = {
    open: async (file: string, flags: string | number) => { calls.push(`open:${file}:${flags}`); return handle; },
    lstat: async (file: string) => { calls.push(`lstat:${file}`); if (vector.entry.type === 'missing') throw coded('ENOENT'); return stats(vector.entry); },
    rename: async () => { renames++; const code = errors.shift(); if (code) throw coded(code); },
  } as unknown as PlatformFsIo;
  return { calls, sleeps, renames: () => renames, fs: createPlatformFs({ platform: vector.platform, io, sleep: async ms => { sleeps.push(ms); } }) };
}
const outcome = async (work: () => Promise<unknown>) => { try { await work(); return 'ok'; } catch (error: any) { return error.code; } };

describe('platform-fs shared vectors', () => {
  it('privateModeOk', () => {
    for (const vector of vectors.privateModeOk) expect(createPlatformFs({ platform: vector.platform }).privateModeOk({ mode: vector.mode }), JSON.stringify(vector)).toBe(vector.expect);
  });
  it('syncDirectory: win32 never opens the directory', async () => {
    for (const vector of vectors.syncDirectory) {
      const fake = fakeIo(vector);
      expect(await outcome(() => fake.fs.syncDirectory('dir')), JSON.stringify(vector)).toBe(vector.expect ?? 'ok');
      expect(fake.calls, JSON.stringify(vector)).toEqual(vector.expectCalls);
    }
  });
  it('openNoFollow', async () => {
    for (const vector of vectors.openNoFollow) {
      const fake = fakeIo(vector), result = await outcome(() => fake.fs.openNoFollow('f', vector.flags));
      expect(result === 'ok' ? 'opened' : result, JSON.stringify(vector)).toBe(vector.expect);
      expect(fake.calls, JSON.stringify(vector)).toEqual(vector.expectCalls);
    }
  });
  it('renameReplace: bounded win32 retry only for EPERM/EBUSY/EACCES', async () => {
    for (const vector of vectors.renameReplace) {
      const fake = fakeIo(vector);
      expect(await outcome(() => fake.fs.renameReplace('a', 'b')), JSON.stringify(vector)).toBe(vector.expect);
      expect(fake.renames(), JSON.stringify(vector)).toBe(vector.renames);
      expect(fake.sleeps, JSON.stringify(vector)).toEqual(vector.sleeps);
    }
  });
});

describe.runIf(win32)('platform-fs on real win32 filesystem', () => {
  it('refuses a symlink and a directory, opens a regular file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-fs-')), target = path.join(dir, 'target.txt'), link = path.join(dir, 'link.txt'), sub = path.join(dir, 'sub');
    try {
      await fs.writeFile(target, 'secret'); await fs.symlink(target, link, 'file'); await fs.mkdir(sub);
      await expect(openNoFollow(link, 0)).rejects.toMatchObject({ code: 'ELOOP' });
      await expect(openNoFollow(sub, 0)).rejects.toMatchObject({ code: 'EINVAL' });
      await expect(openNoFollow(path.join(dir, 'missing'), 0)).rejects.toMatchObject({ code: 'ENOENT' });
      const handle = await openNoFollow(target, 0); try { expect(await handle.readFile('utf8')).toBe('secret'); } finally { await handle.close(); }
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('refuses a file swapped for a symlink between lstat and open', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-fs-')), victim = path.join(dir, 'victim.txt'), outside = path.join(dir, 'outside.txt');
    try {
      await fs.writeFile(victim, 'inbox'); await fs.writeFile(outside, 'outside');
      const io = { open: fs.open, rename: fs.rename, lstat: async (file: string, options: any) => { const entry = await fs.lstat(file, options); await fs.unlink(file); await fs.symlink(outside, file, 'file'); return entry; } } as unknown as PlatformFsIo;
      await expect(createPlatformFs({ platform: 'win32', io }).openNoFollow(victim, 0)).rejects.toMatchObject({ code: 'ELOOP' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('syncDirectory succeeds where a raw directory fsync is refused', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-fs-'));
    try {
      const raw = await fs.open(dir, 'r'); try { await expect(raw.sync()).rejects.toMatchObject({ code: 'EPERM' }); } finally { await raw.close(); }
      await expect(syncDirectory(dir)).resolves.toBeUndefined();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it('renameReplace waits for a reader holding the destination', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-fs-')), source = path.join(dir, 'next.json'), destination = path.join(dir, 'bridge.json');
    try {
      await fs.writeFile(source, 'new'); await fs.writeFile(destination, 'old');
      const reader = await fs.open(destination, 'r'); setTimeout(() => { void reader.close(); }, 25);
      await renameReplace(source, destination);
      expect(await fs.readFile(destination, 'utf8')).toBe('new');
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
