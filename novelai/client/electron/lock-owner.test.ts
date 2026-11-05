// Queue storage locks (review rework P3): a lock names its owner's pid, start and host; a lock whose owner is gone is
// taken over at once (no 60 s wait after a crash or SIGKILL), a reused pid is gone too, older locks keep the lease rule.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCK_HOST, PROCESS_STARTED_AT, currentBootId, lockOwnerIdentity, lockOwnerLiveness, lockStillHeld, memoStartTimes, processStartTime, validLockIdentity } from './lock-owner';
import { createBatchStorage, type FrozenBatchInput } from './batch-storage';
import { createQueueRecipeService } from './queue-recipe-service';
import { runCleanups } from '../src/test-support/temp-dirs';
import { createHash } from 'node:crypto';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(directories.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); });
const temp = async (name: string) => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), name)); directories.push(dir); return dir; };
/** A pid with no process: a child that has exited (its pid is free again). */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid!;
}
const now = Date.now();
const owner = (pid: number, extra: Record<string, unknown> = {}) => ({ pid, nonce: randomUUID(), createdAt: now, leaseUntil: now + 60_000, ...extra });

describe('who holds a lock', () => {
  it('tells a gone owner from a running one, a reused pid from its first process, and keeps the lease for older locks', async () => {
    const gone = await deadPid(), identity = { startedAt: PROCESS_STARTED_AT, host: LOCK_HOST };
    await expect(lockOwnerLiveness(owner(gone, identity))).resolves.toBe('dead');
    await expect(lockOwnerLiveness(owner(gone))).resolves.toBe('unknown');
    await expect(lockOwnerLiveness(owner(gone, { ...identity, host: 'another-host' }))).resolves.toBe('unknown');
    await expect(lockOwnerLiveness(owner(process.pid, identity))).resolves.toBe('alive');
    await expect(lockOwnerLiveness(owner(process.pid))).resolves.toBe('alive');
    // This pid, another start: the process that took the lock is gone and its pid was given to this one.
    await expect(lockOwnerLiveness(owner(process.pid, { ...identity, startedAt: PROCESS_STARTED_AT - 3_600_000 }))).resolves.toBe('dead');
    const parent = process.ppid, started = 1_700_000_000_000;
    await expect(lockOwnerLiveness(owner(parent, { startedAt: started, host: LOCK_HOST }), async () => started + 1000)).resolves.toBe('alive');
    await expect(lockOwnerLiveness(owner(parent, { startedAt: started, host: LOCK_HOST }), async () => started + 60_000)).resolves.toBe('dead');
    await expect(lockOwnerLiveness(owner(parent, { startedAt: started, host: LOCK_HOST }), async () => null)).resolves.toBe('alive');
    // The lease rule for an older lock (and one from another host): held while the lease runs, free after it.
    await expect(lockStillHeld(owner(gone))).resolves.toBe(true);
    await expect(lockStillHeld({ ...owner(gone), leaseUntil: now - 1 })).resolves.toBe(false);
    await expect(lockStillHeld(owner(gone, identity))).resolves.toBe(false);
    const read = vi.fn(async () => 5), memo = memoStartTimes(read);
    await memo(7); await memo(7); await memo(8);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === 'win32')('reads a process start as ps reports it (whole seconds, close to its own)', async () => {
    const own = await processStartTime(process.pid);
    expect(own).not.toBeNull();
    expect(Math.abs(own! - PROCESS_STARTED_AT)).toBeLessThanOrEqual(2500);
    await expect(processStartTime(await deadPid())).resolves.toBeNull();
  });
});

function input(id = randomUUID(), sequence = 1): FrozenBatchInput {
  const snapshots = [{ params: { positivePrompt: 'a blue teacup', seed: 17 } as any, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] } }];
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const payloadHash = createHash('sha256').update(JSON.stringify(canonical(snapshots))).digest('hex');
  return { schemaVersion: 1, batchId: id, sequence, fingerprint: 'fixture-only', payloadHash, request: { workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: id, execution: 'queued', mode: 't2i', count: 1, intervalSeconds: 0, seeds: [17] }, snapshots, initial: { batchId: id, execution: 'queued', status: 'queued', items: [{ plannedSeed: 17, status: 'pending' }] } as any };
}

describe('owner start and boot (review rework 2)', () => {
  it.skipIf(process.platform === 'win32')('the start ps reports is the same in every time zone (read as UTC)', async () => {
    const own = await processStartTime(process.pid);
    const { spawnSync } = await import('node:child_process');
    const script = `const { execFileSync } = require('node:child_process'); const t = execFileSync('ps', ['-o', 'lstart=', '-p', '${process.pid}'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim().replace(/\\s+/g, ' '); console.log(Date.parse(t + ' UTC'));`;
    for (const tz of ['America/New_York', 'Asia/Tokyo', 'Europe/London', 'Australia/Lord_Howe']) {
      const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      expect(Number(result.stdout.trim()), tz).toBe(own);
    }
    expect(Math.abs(own! - PROCESS_STARTED_AT)).toBeLessThanOrEqual(2500);
  });

  it('records this boot where it can be read; a lock from another boot is gone even when its pid runs now', async () => {
    const boot = currentBootId();
    if (process.platform === 'darwin' || process.platform === 'linux') expect(boot).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(lockOwnerIdentity()).toEqual({ startedAt: PROCESS_STARTED_AT, host: LOCK_HOST, ...(boot ? { boot } : {}) });
    expect(validLockIdentity(lockOwnerIdentity())).toBe(true);
    expect(validLockIdentity({ ...lockOwnerIdentity(), boot: 'x' })).toBe(false);
    if (!boot) return;
    const identity = { startedAt: PROCESS_STARTED_AT, host: LOCK_HOST };
    await expect(lockOwnerLiveness(owner(process.pid, { ...identity, boot }))).resolves.toBe('alive');
    await expect(lockOwnerLiveness(owner(process.pid, { ...identity, boot: '00000000-0000-4000-8000-000000000000' }))).resolves.toBe('dead');
    // A lock without a boot (written before this change) keeps the start check.
    await expect(lockOwnerLiveness(owner(process.pid, identity))).resolves.toBe('alive');
    // The frozen queue accepts its schema-2 owner with and without the boot.
    const dir = await temp('nai-lock-boot-'), storage = createBatchStorage(dir); await storage.load();
    const lock = path.join(dir, 'frozen-queue', '.quota.lock');
    await fs.writeFile(lock, JSON.stringify({ schemaVersion: 2, pid: process.pid, nonce: randomUUID(), createdAt: Date.now(), leaseUntil: Date.now() + 60_000, ...identity, boot: '00000000-0000-4000-8000-000000000000' }), { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    await expect(storage.create(input())).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('a lock left by a killed process', () => {
  it('frozen queue: taken over at once when its owner is gone, the lease still running; an older lock waits for its lease', async () => {
    const dir = await temp('nai-lock-frozen-'), storage = createBatchStorage(dir); await storage.load();
    const lock = path.join(dir, 'frozen-queue', '.quota.lock'), gone = await deadPid();
    await fs.writeFile(lock, JSON.stringify({ schemaVersion: 2, pid: gone, nonce: randomUUID(), createdAt: Date.now(), leaseUntil: Date.now() + 60_000, startedAt: PROCESS_STARTED_AT, host: LOCK_HOST }), { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    await expect(storage.create(input())).resolves.toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await fs.readdir(path.join(dir, 'frozen-queue'))).filter(name => name.startsWith('.quota.'))).toEqual([]);
    // An older lock of a gone owner still counts until its lease ends (the write waits; freed by ending the lease).
    const legacy = { schemaVersion: 1, pid: gone, nonce: randomUUID(), createdAt: Date.now(), leaseUntil: Date.now() + 60_000 };
    await fs.writeFile(lock, JSON.stringify(legacy), { flag: 'wx', mode: 0o600 });
    let done = false; const write = storage.create(input(randomUUID(), 2)).then(value => { done = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(done).toBe(false);
    expect(JSON.parse(await fs.readFile(lock, 'utf8'))).toEqual(legacy);
    await fs.rm(lock); await fs.writeFile(lock, JSON.stringify({ ...legacy, leaseUntil: legacy.createdAt }), { flag: 'wx', mode: 0o600 });
    await expect(write).resolves.toBe(2);
  });

  it('recipe store: a lock whose owner was killed no longer refuses calls for a minute', async () => {
    const runtimeDir = await temp('nai-lock-recipes-');
    const batch: any = { ready: Promise.resolve(), enqueue: vi.fn(), lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
    const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97 });
    const preparation = { mode: 't2i', authored: { params: { positivePrompt: 'teacup', negativePrompt: '', seed: 42, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] };
    await service.put_queue_recipe({ preparation });
    const lock = path.join(runtimeDir, 'queue-recipes', '.quota.lock'), gone = await deadPid();
    await fs.writeFile(lock, JSON.stringify({ pid: gone, nonce: randomUUID(), leaseUntil: Date.now() + 60_000, startedAt: PROCESS_STARTED_AT, host: LOCK_HOST }), { flag: 'wx', mode: 0o600 });
    const started = Date.now();
    await expect(service.put_queue_recipe({ preparation: { ...preparation, authored: { params: { ...preparation.authored.params, positivePrompt: 'teacup, second' } } } })).resolves.toMatchObject({ recipeRevision: 1 });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    // The lock it writes itself names its start and host.
    const seen: string[] = []; const original = fs.link;
    vi.spyOn(fs, 'link').mockImplementation(async (from: any, to: any) => { if (String(to).endsWith('.quota.lock')) seen.push(await fs.readFile(from, 'utf8')); return original(from, to); });
    await service.put_queue_recipe({ preparation: { ...preparation, authored: { params: { ...preparation.authored.params, positivePrompt: 'teacup, third' } } } });
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.parse(seen[0])).toMatchObject({ pid: process.pid, startedAt: PROCESS_STARTED_AT, host: LOCK_HOST });
  });
});
