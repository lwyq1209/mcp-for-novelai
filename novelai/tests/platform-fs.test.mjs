import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, symlink, rm, mkdir, open, unlink, lstat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { createPlatformFs, syncDirectory, openNoFollow, renameReplace, createExclusive } from '../src/platform-fs.mjs';

const vectors = JSON.parse(await readFile(new URL('./fixtures/platform-fs-vectors.json', import.meta.url), 'utf8'));
const win32 = process.platform === 'win32';

function stats(spec) {
  return { isSymbolicLink: () => spec.type === 'symlink', isFile: () => spec.type === 'file', dev: BigInt(spec.dev ?? 0), ino: BigInt(spec.ino ?? 0) };
}
function fakeIo(vector) {
  const calls = [], sleeps = []; let renames = 0; const errors = [...(vector.errors ?? [])];
  const coded = code => Object.assign(new Error(code), { code });
  const handle = { sync: async () => { calls.push('sync'); if (vector.syncError) throw coded(vector.syncError); }, close: async () => { calls.push('close'); }, stat: async () => { calls.push('fstat'); return stats(vector.opened); } };
  const io = {
    open: async (file, flags) => { calls.push(`open:${file}:${flags}`); return handle; },
    lstat: async file => { calls.push(`lstat:${file}`); if (vector.entry.type === 'missing') throw coded('ENOENT'); return stats(vector.entry); },
    rename: async () => { renames++; const code = errors.shift(); if (code) throw coded(code); },
  };
  return { calls, sleeps, get renames() { return renames; }, fs: createPlatformFs({ platform: vector.platform, io, sleep: async ms => { sleeps.push(ms); } }) };
}
const outcome = async work => { try { await work(); return 'ok'; } catch (error) { return error.code; } };

test('privateModeOk vectors', () => {
  for (const vector of vectors.privateModeOk) assert.equal(createPlatformFs({ platform: vector.platform }).privateModeOk({ mode: vector.mode }), vector.expect, JSON.stringify(vector));
});
test('syncDirectory vectors: win32 never opens the directory', async () => {
  for (const vector of vectors.syncDirectory) {
    const fake = fakeIo(vector); const result = await outcome(() => fake.fs.syncDirectory('dir'));
    assert.equal(result, vector.expect ?? 'ok', JSON.stringify(vector)); assert.deepEqual(fake.calls, vector.expectCalls, JSON.stringify(vector));
  }
});
test('openNoFollow vectors', async () => {
  for (const vector of vectors.openNoFollow) {
    const fake = fakeIo(vector); const result = await outcome(() => fake.fs.openNoFollow('f', vector.flags));
    assert.equal(result === 'ok' ? 'opened' : result, vector.expect, JSON.stringify(vector)); assert.deepEqual(fake.calls, vector.expectCalls, JSON.stringify(vector));
  }
});
test('renameReplace vectors: bounded win32 retry only for EPERM/EBUSY/EACCES', async () => {
  for (const vector of vectors.renameReplace) {
    const fake = fakeIo(vector); const result = await outcome(() => fake.fs.renameReplace('a', 'b'));
    assert.equal(result, vector.expect, JSON.stringify(vector)); assert.equal(fake.renames, vector.renames, JSON.stringify(vector)); assert.deepEqual(fake.sleeps, vector.sleeps, JSON.stringify(vector));
  }
});

test('createExclusive: POSIX passes the caller flags through; win32 refuses any entry at the name and a link swapped in after the create', async () => {
  const coded = code => Object.assign(new Error(code), { code });
  const fileStat = (ino, type = 'file') => ({ isSymbolicLink: () => type === 'symlink', isFile: () => type === 'file', dev: 1n, ino });
  const run = async (platform, entries, opened = fileStat(7n)) => {
    const calls = [], queue = [...entries];
    const handle = { stat: async () => { calls.push('fstat'); return opened; }, close: async () => { calls.push('close'); } };
    const io = {
      open: async (file, flags, mode) => { calls.push(`open:${file}:${flags}:${mode}`); return handle; },
      lstat: async file => { calls.push(`lstat:${file}`); const next = queue.shift(); if (next === 'missing') throw coded('ENOENT'); return next; },
    };
    let result;
    try { result = await createPlatformFs({ platform, io }).createExclusive('f', 1234, 0o600); } catch (error) { result = error.code; }
    return { result: result === handle ? 'created' : result, calls };
  };
  assert.deepEqual(await run('linux', []), { result: 'created', calls: ['open:f:1234:384'] });
  assert.deepEqual(await run('darwin', []), { result: 'created', calls: ['open:f:1234:384'] });
  const create = `open:f:${constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL}:384`;
  assert.deepEqual(await run('win32', ['missing', fileStat(7n)]), { result: 'created', calls: ['lstat:f', create, 'fstat', 'lstat:f'] });
  for (const existing of [fileStat(3n), fileStat(3n, 'symlink'), fileStat(3n, 'directory')])
    assert.deepEqual(await run('win32', [existing]), { result: 'EEXIST', calls: ['lstat:f'] }, 'an existing entry, a (dangling) link or a folder is never created through');
  assert.deepEqual(await run('win32', ['missing', fileStat(9n, 'symlink')]), { result: 'ELOOP', calls: ['lstat:f', create, 'fstat', 'lstat:f', 'close'] }, 'a link swapped in before the create');
  assert.deepEqual(await run('win32', ['missing', fileStat(8n)]), { result: 'ELOOP', calls: ['lstat:f', create, 'fstat', 'lstat:f', 'close'] }, 'the name is another file than the one opened');
});

test('win32: createExclusive never creates through a dangling symlink and creates a new file', { skip: !win32 && 'win32 only' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-')); const link = join(dir, 'link.png'), outside = join(dir, 'outside.png'), fresh = join(dir, 'fresh.png');
  try {
    await symlink(outside, link, 'file');
    await assert.rejects(createExclusive(link, 0, 0o600), { code: 'EEXIST' });
    await assert.rejects(lstat(outside), { code: 'ENOENT' }, 'nothing was created at the link target');
    const handle = await createExclusive(fresh, 0, 0o600);
    try { await handle.writeFile('new'); } finally { await handle.close(); }
    assert.equal(await readFile(fresh, 'utf8'), 'new');
    await assert.rejects(createExclusive(fresh, 0, 0o600), { code: 'EEXIST' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('win32: a symlink is refused and a regular file opens', { skip: !win32 && 'win32 only' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-')); const target = join(dir, 'target.txt'), link = join(dir, 'link.txt'), sub = join(dir, 'sub');
  try {
    await writeFile(target, 'secret'); await symlink(target, link, 'file'); await mkdir(sub);
    await assert.rejects(openNoFollow(link, 0), { code: 'ELOOP' });
    await assert.rejects(openNoFollow(sub, 0), { code: 'EINVAL' });
    await assert.rejects(openNoFollow(join(dir, 'missing'), 0), { code: 'ENOENT' });
    const handle = await openNoFollow(target, 0); try { assert.equal(await handle.readFile('utf8'), 'secret'); } finally { await handle.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('win32: a file swapped for a symlink between lstat and open is refused', { skip: !win32 && 'win32 only' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-')); const victim = join(dir, 'victim.txt'), outside = join(dir, 'outside.txt');
  try {
    await writeFile(victim, 'inbox'); await writeFile(outside, 'outside');
    const io = { open, rename, lstat: async (file, options) => { const entry = await lstat(file, options); await unlink(file); await symlink(outside, file, 'file'); return entry; } };
    await assert.rejects(createPlatformFs({ platform: 'win32', io }).openNoFollow(victim, 0), { code: 'ELOOP' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('win32: syncDirectory succeeds where a raw directory fsync is refused', { skip: !win32 && 'win32 only' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-'));
  try {
    const raw = await open(dir, 'r'); try { await assert.rejects(raw.sync(), { code: 'EPERM' }); } finally { await raw.close(); }
    await syncDirectory(dir);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('win32: renameReplace keeps replacing a file that another reader polls every few milliseconds', { skip: !win32 && 'win32 only', timeout: 120_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-')); const destination = join(dir, 'state.json');
  try {
    await writeFile(destination, '0');
    let stop = false, reads = 0, refused = 0;
    const reader = (async () => { while (!stop) { try { await readFile(destination); reads++; } catch { /* between replacements */ } await new Promise(done => setTimeout(done, 2)); } })();
    const io = { open, lstat, rename: async (from, to) => { try { return await rename(from, to); } catch (error) { if (['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) refused++; throw error; } } };
    const platformFs = createPlatformFs({ platform: 'win32', io }), started = Date.now();
    try {
      for (let round = 1; round <= 100; round++) { const next = join(dir, `next-${round}.json`); await writeFile(next, String(round)); await platformFs.renameReplace(next, destination); }
    } finally { stop = true; await reader; }
    t.diagnostic(`100 replacements in ${Date.now() - started} ms during ${reads} reads; ${refused} rename attempts were refused while the file was open and retried`);
    assert.equal(await readFile(destination, 'utf8'), '100');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('win32: renameReplace waits for a reader holding the destination', { skip: !win32 && 'win32 only' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'platform-fs-')); const source = join(dir, 'next.json'), destination = join(dir, 'bridge.json');
  try {
    await writeFile(source, 'new'); await writeFile(destination, 'old');
    const reader = await open(destination, 'r'); setTimeout(() => { reader.close(); }, 25);
    await renameReplace(source, destination);
    assert.equal(await readFile(destination, 'utf8'), 'new');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
