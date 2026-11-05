import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { COMPACTION_UNLINK_DELAYS_MS, createCompactionUnlink, createBatchStorage, FROZEN_COMPACTION_POLICY, FROZEN_QUEUE_LIMITS, BatchInputError, BatchQuotaError, type FrozenBatchInput } from './batch-storage';
import { runCleanups } from '../src/test-support/temp-dirs';

const directories: string[] = [];
// The cleanup after H10 removes 4,000 stored batches (about 12,000 files and 4,000 folders): fast alone, but past the
// 30 s hook limit while two full suites share the disk. A longer explicit limit for it; nothing it checks changes.
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(directories.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); }, 240_000);
async function setup() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-storage-')); directories.push(dir); const storage = createBatchStorage(dir); await storage.load(); return { dir, storage, files: path.join(dir, 'frozen-queue') }; }
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function input(id = randomUUID(), sequence = 1): FrozenBatchInput {
  const snapshots = [{ params: { positivePrompt: 'a blue teacup', seed: 17 } as any, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] } }];
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const payloadHash = createHash('sha256').update(JSON.stringify(canonical(snapshots))).digest('hex');
  return { schemaVersion: 1, batchId: id, sequence, fingerprint: 'fixture-only', payloadHash, request: { workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: id, execution: 'queued', mode: 't2i', count: 1, intervalSeconds: 0, seeds: [17] }, snapshots, initial: { batchId: id, execution: 'queued', status: 'queued', items: [{ plannedSeed: 17, status: 'pending' }] } as any };
}

it('waits through a legacy owner publication window without entering its critical section', async () => {
  const h = await setup(), contender = createBatchStorage(h.dir); await contender.load();
  const lock = path.join(h.files, '.quota.lock'), ownerHandle = await fs.open(lock, 'wx', 0o600), nonce = randomUUID(), firstRead = deferred<string>(), validRead = deferred(), resumeFirstRead = deferred();
  const originalOpen = fs.open.bind(fs); let intercepted = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
    const handle: any = await (originalOpen as any)(...args);
    if (args[0] === lock) {
      const originalRead = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs: any[]) => {
        const value = await originalRead(...readArgs);
        if (!intercepted) { intercepted = true; firstRead.resolve(String(value)); await resumeFirstRead.promise; }
        else if (String(value).includes(nonce)) validRead.resolve();
        return value;
      };
    }
    return handle;
  });
  let settled = false; const pending = contender.create(input()).finally(() => { settled = true; });
  expect(await firstRead.promise).toBe('');
  const now = Date.now(); await ownerHandle.writeFile(JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce, createdAt: now, leaseUntil: now + 60_000 })); await ownerHandle.sync(); resumeFirstRead.resolve();
  await validRead.promise; expect(settled).toBe(false);
  await ownerHandle.close(); await fs.unlink(lock);
  await expect(pending).resolves.toBe(1);
});

it('retries when a lock observed through EEXIST is normally released before owner read', async () => {
  const h = await setup(), contender = createBatchStorage(h.dir); await contender.load();
  const lock = path.join(h.files, '.quota.lock'), nonce = randomUUID(), now = Date.now();
  await fs.writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce, createdAt: now, leaseUntil: now + 60_000 }), { flag: 'wx', mode: 0o600 });
  const aboutToRead = deferred(), resumeRead = deferred(), originalOpen = fs.open.bind(fs); let intercepted = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
    if (args[0] === lock && !intercepted) { intercepted = true; aboutToRead.resolve(); await resumeRead.promise; }
    return (originalOpen as any)(...args);
  });
  const pending = contender.create(input()); await aboutToRead.promise; await fs.unlink(lock); resumeRead.resolve();
  await expect(pending).resolves.toBe(1);
});

it('does not let a lock contender publication candidate break the current holder recovery or quota scan', async () => {
  const h = await setup(), holder = createBatchStorage(h.dir), contender = createBatchStorage(h.dir); await Promise.all([holder.load(), contender.load()]);
  const lock = path.join(h.files, '.quota.lock'), holderPaused = deferred(), letHolderRead = deferred(), holderListedCandidate = deferred(), returnHolderListing = deferred(), contenderCandidate = deferred(), letContenderLink = deferred(), candidateRemoved = deferred();
  const originalReadDir = fs.readdir.bind(fs), originalLink = fs.link.bind(fs), originalUnlink = fs.unlink.bind(fs); let lockedReads = 0, lockLinks = 0, candidatePath = '';
  vi.spyOn(fs, 'readdir').mockImplementation(async (...args: any[]) => {
    let pausedHolderRead = false;
    if (String(args[0]) === h.files) {
      const lockExists = await fs.stat(lock).then(() => true, () => false);
      if (lockExists && ++lockedReads === 3) { pausedHolderRead = true; holderPaused.resolve(); await letHolderRead.promise; }
    }
    const entries: any = await (originalReadDir as any)(...args);
    if (pausedHolderRead && candidatePath && entries.some((entry: any) => (typeof entry === 'string' ? entry : entry.name) === path.basename(candidatePath))) { holderListedCandidate.resolve(); await returnHolderListing.promise; }
    return entries;
  });
  vi.spyOn(fs, 'link').mockImplementation(async (...args: any[]) => {
    if (String(args[1]) === lock && ++lockLinks === 2) { candidatePath = String(args[0]); contenderCandidate.resolve(); await letContenderLink.promise; }
    return (originalLink as any)(...args);
  });
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { const result = await (originalUnlink as any)(...args); if (String(args[0]) === candidatePath) candidateRemoved.resolve(); return result; });
  const first = holder.create(input()), secondInput = input(); let contenderSettled = false; await holderPaused.promise;
  const second = contender.create(secondInput).finally(() => { contenderSettled = true; }); await contenderCandidate.promise; letHolderRead.resolve(); await holderListedCandidate.promise;
  expect(contenderSettled).toBe(false); letContenderLink.resolve(); await candidateRemoved.promise; returnHolderListing.resolve();
  await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
  expect((await createBatchStorage(h.dir).load()).map(record => record.input.sequence)).toEqual([1, 2]);
});

it.each(['present', 'disappears'] as const)('keeps a contender publication candidate outside durable quota when it %s during scan', async disposition => {
  const h = await setup(), candidate = path.join(h.files, `.txn-${randomUUID()}-${randomUUID()}.tmp`), originalReadDir = fs.readdir.bind(fs); let directoryReads = 0, injected = false;
  vi.spyOn(fs, 'readdir').mockImplementation(async (...args: any[]) => {
    if (String(args[0]) !== h.files || ++directoryReads !== 6) return (originalReadDir as any)(...args);
    await fs.writeFile(candidate, 'complete contender publication candidate', { flag: 'wx', mode: 0o600 }); const entries = await (originalReadDir as any)(...args); injected = true;
    if (disposition === 'disappears') await fs.unlink(candidate);
    return entries;
  });
  await expect(h.storage.create(input())).resolves.toBe(1); expect(injected).toBe(true);
  if (disposition === 'present') expect(await fs.readFile(candidate, 'utf8')).toBe('complete contender publication candidate');
  vi.restoreAllMocks(); await expect(createBatchStorage(h.dir).load()).resolves.toHaveLength(1);
  await expect(fs.stat(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects and preserves non-UUID transaction candidates instead of excluding them from quota', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-invalid-candidate-')); directories.push(dir); const files = path.join(dir, 'frozen-queue'), limits = { total: 8 * 1024 };
  const storage = createBatchStorage(dir, limits); await storage.load(); const candidate = path.join(files, `.txn-${'a'.repeat(36)}-${'b'.repeat(36)}.tmp`), bytes = Buffer.alloc(16 * 1024, 1); await fs.writeFile(candidate, bytes);
  await expect(storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' }); expect(await fs.readFile(candidate)).toEqual(bytes);
  await expect(createBatchStorage(dir, limits).load()).rejects.toMatchObject({ code: 'queue_storage_error' }); expect((await fs.stat(candidate)).size).toBe(bytes.length);
});

it('waits through legacy recovery-claim publication and does not steal from its live owner', async () => {
  const h = await setup(), contender = createBatchStorage(h.dir); await contender.load();
  const nonce = randomUUID(), claimFile = path.join(h.files, `.quota.recover-${nonce}`), claimHandle = await fs.open(claimFile, 'wx', 0o600), firstRead = deferred<string>(), validRead = deferred(), resumeFirstRead = deferred();
  const originalOpen = fs.open.bind(fs); let intercepted = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => {
    const handle: any = await (originalOpen as any)(...args);
    if (args[0] === claimFile) {
      const originalRead = handle.readFile.bind(handle);
      handle.readFile = async (...readArgs: any[]) => { const value = await originalRead(...readArgs); if (!intercepted) { intercepted = true; firstRead.resolve(String(value)); await resumeFirstRead.promise; } else if (String(value).includes(nonce)) validRead.resolve(); return value; };
    }
    return handle;
  });
  let settled = false; const pending = contender.create(input()).finally(() => { settled = true; }); expect(await firstRead.promise).toBe('');
  const now = Date.now(); await claimHandle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: now, leaseUntil: now + 60_000 })); await claimHandle.sync(); resumeFirstRead.resolve();
  await validRead.promise; expect(settled).toBe(false); await claimHandle.close(); await fs.unlink(claimFile);
  await expect(pending).resolves.toBe(1);
});

it('retries when a listed recovery claim disappears before its actual filesystem read', async () => {
  const h = await setup(), contender = createBatchStorage(h.dir); await contender.load();
  const nonce = randomUUID(), claimFile = path.join(h.files, `.quota.recover-${nonce}`), now = Date.now(); await fs.writeFile(claimFile, JSON.stringify({ pid: process.pid, nonce, createdAt: now, leaseUntil: now + 60_000 }), { flag: 'wx', mode: 0o600 });
  const aboutToRead = deferred(), resumeRead = deferred(), originalOpen = fs.open.bind(fs); let intercepted = false;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => { if (args[0] === claimFile && !intercepted) { intercepted = true; aboutToRead.resolve(); await resumeRead.promise; } return (originalOpen as any)(...args); });
  const pending = contender.create(input()); await aboutToRead.promise; await fs.unlink(claimFile); resumeRead.resolve();
  await expect(pending).resolves.toBe(1);
});

it('keeps permanently incomplete or structurally corrupt owners and fails closed after bounded inspection', async () => {
  for (const damaged of ['', '{}', JSON.stringify({ schemaVersion: 1, pid: 99_999_999, nonce: randomUUID(), leaseUntil: 0 })]) {
    const h = await setup(), contender = createBatchStorage(h.dir), lock = path.join(h.files, '.quota.lock'); await contender.load(); await fs.writeFile(lock, damaged, { flag: 'wx', mode: 0o600 });
    await expect(contender.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' }); expect(await fs.readFile(lock, 'utf8')).toBe(damaged);
  }
});

it('retains stale-owner recovery while publishing complete recovery claims', async () => {
  const h = await setup(), contender = createBatchStorage(h.dir); await contender.load(); const lock = path.join(h.files, '.quota.lock'), nonce = randomUUID();
  await fs.writeFile(lock, JSON.stringify({ schemaVersion: 1, pid: 99_999_999, nonce, createdAt: 0, leaseUntil: 0 }), { flag: 'wx', mode: 0o600 });
  await expect(contender.create(input())).resolves.toBe(1);
  expect((await fs.readdir(h.files)).filter(name => name.startsWith('.quota.'))).toEqual([]);
});

it.each([
  ['invalid filename nonce', `${'a'.repeat(36)}`],
  ['malformed JSON', randomUUID()],
  ['unknown owner field', randomUUID()],
] as const)('preserves and rejects stale-lock evidence with %s', async (failure, filenameNonce) => {
  const h = await setup(), stale = path.join(h.files, `.quota.lock.stale-${filenameNonce}`), owner = { schemaVersion: 1, pid: 99_999_999, nonce: randomUUID(), createdAt: 0, leaseUntil: 0 };
  const evidence = failure === 'malformed JSON' ? '{malformed' : JSON.stringify(failure === 'unknown owner field' ? { ...owner, unknown: true } : owner);
  await fs.writeFile(stale, evidence, { flag: 'wx', mode: 0o600 }); await expect(h.storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(stale, 'utf8')).toBe(evidence);
});

it('preserves and rejects symlinked stale-lock evidence', async () => {
  const h = await setup(), target = path.join(h.dir, 'stale-owner.json'), stale = path.join(h.files, `.quota.lock.stale-${randomUUID()}`), now = Date.now();
  await fs.writeFile(target, JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: randomUUID(), createdAt: now, leaseUntil: now + 60_000 })); await fs.symlink(target, stale);
  await expect(h.storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' }); expect((await fs.lstat(stale)).isSymbolicLink()).toBe(true);
});

it.each([
  ['live', process.pid],
  ['unexpired', 99_999_999],
] as const)('preserves and rejects %s stale-lock owner evidence', async (_kind, pid) => {
  const h = await setup(), stale = path.join(h.files, `.quota.lock.stale-${randomUUID()}`), createdAt = Date.now(), owner = { schemaVersion: 1, pid, nonce: randomUUID(), createdAt, leaseUntil: createdAt + 60_000 };
  await fs.writeFile(stale, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); await expect(h.storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(JSON.parse(await fs.readFile(stale, 'utf8'))).toEqual(owner);
});

it('removes only valid dead and expired stale-lock evidence before continuing', async () => {
  const h = await setup(), stale = path.join(h.files, `.quota.lock.stale-${randomUUID()}`), owner = { schemaVersion: 1, pid: 99_999_999, nonce: randomUUID(), createdAt: 0, leaseUntil: 0 };
  await fs.writeFile(stale, JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); await expect(h.storage.create(input())).resolves.toBe(1);
  await expect(fs.stat(stale)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('separates immutable recipe bytes from small state and reloads accepted FIFO order', async () => {
  const h = await setup(), a = input(), b = input(randomUUID(), 2);
  await h.storage.create(a); await h.storage.create(b);
  const before = await fs.readFile(path.join(h.files, `${a.batchId}.input.json`), 'utf8');
  await h.storage.save(a.batchId, { ...a.initial, status: 'succeeded', items: [{ ...a.initial.items[0], status: 'succeeded', results: [{ id: 'saved-result' }] }] } as any);
  expect(await fs.readFile(path.join(h.files, `${a.batchId}.input.json`), 'utf8')).toBe(before);
  const recovered = await createBatchStorage(h.dir).load();
  expect(recovered.map(row => row.input.batchId)).toEqual([a.batchId, b.batchId]);
  expect(recovered[0].job.items[0].results[0].id).toBe('saved-result');
  expect(recovered[0].input.snapshots[0].params.positivePrompt).toBe('a blue teacup');
  expect((await fs.readdir(h.files)).some(name => name.endsWith('.tmp'))).toBe(false);
});

it('keeps a failed item\'s upstream answer across a restart; an item error without one (older batches) reads as before (step 4c1)', async () => {
  const h = await setup(), a = input(), b = input(randomUUID(), 2);
  await h.storage.create(a); await h.storage.create(b);
  const upstream = { status: 400, message: 'prompt rejected' };
  await h.storage.save(a.batchId, { ...a.initial, status: 'failed', items: [{ ...a.initial.items[0], status: 'failed', error: { code: 'generation_failed', message: 'm', reason: 'generation.request_failed', upstream } }] } as any);
  await h.storage.save(b.batchId, { ...b.initial, status: 'failed', items: [{ ...b.initial.items[0], status: 'failed', error: { code: 'generation_failed', message: 'm' } }] } as any);
  const recovered = await createBatchStorage(h.dir).load();
  expect(recovered[0].job.items[0].error).toEqual({ code: 'generation_failed', message: 'm', reason: 'generation.request_failed', upstream });
  expect(recovered[1].job.items[0].error).toEqual({ code: 'generation_failed', message: 'm' });
});

it('detects a valid old current-state rollback behind immutable history', async () => {
  const h = await setup(), value = input(); await h.storage.create(value);
  const current = path.join(h.files, `${value.batchId}.state.json`), old = await fs.readFile(current);
  await h.storage.save(value.batchId, { ...value.initial, status: 'running', activeIndex: 0, activeJobId: 'paid-child', items: [{ ...value.initial.items[0], status: 'running', jobId: 'paid-child', actualSeed: 17 }] } as any);
  expect((await fs.readdir(path.join(h.files, `${value.batchId}.states`))).length).toBe(2);
  await fs.writeFile(current, old);
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
});

it('refuses a state of any schema but the revision-chained one, without changing the batch files', async () => {
  const h = await setup(), value = input();
  const text = JSON.stringify(value), digest = createHash('sha256').update(text).digest('hex');
  await fs.writeFile(path.join(h.files, `${value.batchId}.input.json`), text);
  const state = JSON.stringify({ schemaVersion: 1, batchId: value.batchId, inputHash: digest, job: value.initial });
  await fs.writeFile(path.join(h.files, `${value.batchId}.state.json`), state);
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(path.join(h.files, `${value.batchId}.input.json`), 'utf8')).toBe(text);
  expect(await fs.readFile(path.join(h.files, `${value.batchId}.state.json`), 'utf8')).toBe(state);
});

it('does not overwrite an immutable input or continue after a write failure', async () => {
  const h = await setup(), value = input(); await h.storage.create(value);
  const file = path.join(h.files, `${value.batchId}.input.json`), before = await fs.readFile(file, 'utf8');
  await expect(h.storage.create({ ...value, snapshots: [] })).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(h.storage.save(value.batchId, value.initial)).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
});

it('refuses to overwrite state externally changed after loading', async () => {
  const h = await setup(), value = input(); await h.storage.create(value);
  const state = path.join(h.files, `${value.batchId}.state.json`); await fs.writeFile(state, '{broken');
  await expect(h.storage.save(value.batchId, value.initial)).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(state, 'utf8')).toBe('{broken');
});

it.each(['bad-json', 'changed-input', 'orphan', 'symlink', 'unknown-file'])('rejects %s without replacing the damaged queue with empty records', async failure => {
  const h = await setup(), value = input(); await h.storage.create(value);
  const source = path.join(h.files, `${value.batchId}.input.json`), state = path.join(h.files, `${value.batchId}.state.json`);
  if (failure === 'bad-json') await fs.writeFile(state, '{');
  if (failure === 'changed-input') { const modified = structuredClone(value); modified.snapshots[0].params.positivePrompt = 'unbound changed text'; await fs.writeFile(source, JSON.stringify(modified)); }
  if (failure === 'orphan') await fs.unlink(state);
  if (failure === 'symlink') { await fs.unlink(state); await fs.symlink(source, state); }
  if (failure === 'unknown-file') await fs.writeFile(path.join(h.files, 'unexpected.json'), '{}');
  const before = await fs.readFile(source, 'utf8'), storage = createBatchStorage(h.dir);
  await expect(storage.load()).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(source, 'utf8')).toBe(before);
});

it('rejects path traversal and symlinked queue/runtime directories without writing through them', async () => {
  const h = await setup();
  await expect(h.storage.create(input('../elsewhere'))).rejects.toMatchObject({ code: 'queue_storage_error' });
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-symlink-')); directories.push(other);
  await fs.symlink(h.files, path.join(other, 'frozen-queue'));
  await expect(createBatchStorage(other).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-runtime-link-')); directories.push(parent); const target = path.join(parent, 'target'), linked = path.join(parent, 'linked'); await fs.mkdir(target); await fs.symlink(target, linked);
  await expect(createBatchStorage(linked).load()).rejects.toMatchObject({ code: 'queue_storage_error' }); expect(await fs.readdir(target)).toEqual([]);
});

it('ignores only unpublished atomic temporary files and rejects other temporary names and oversized recipe files', async () => {
  const h = await setup(); await fs.writeFile(path.join(h.files, `.txn-${randomUUID()}-${randomUUID()}.tmp`), 'incomplete');
  expect(await createBatchStorage(h.dir).load()).toEqual([]);
  const other = path.join(h.files, `.${randomUUID()}.tmp`); await fs.writeFile(other, 'incomplete');
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' }); await fs.unlink(other);
  const value = input(); await h.storage.create(value);
  const handle = await fs.open(path.join(h.files, `${value.batchId}.input.json`), 'r+'); await handle.truncate(64 * 1024 * 1024 + 1); await handle.close();
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
});

it('recovers save markers both before history publication and with history one revision ahead of current', async () => {
  for (const historyPublished of [false, true]) {
    const h = await setup(), value = input(); await h.storage.create(value);
    const current = path.join(h.files, `${value.batchId}.state.json`), old = await fs.readFile(current);
    const nextJob = { ...value.initial, status: 'running', activeIndex: 0, activeJobId: 'paid-child', items: [{ ...value.initial.items[0], status: 'running', jobId: 'paid-child', actualSeed: 17 }] } as any;
    if (historyPublished) { await h.storage.save(value.batchId, nextJob); await fs.writeFile(current, old); }
    const nonce = randomUUID(); await fs.writeFile(path.join(h.files, `.txn-${nonce}.json`), JSON.stringify({ schemaVersion: 1, nonce, kind: 'save', batchId: value.batchId, revision: 2 }));
    const records = await createBatchStorage(h.dir).load();
    expect(records[0].job.status).toBe(historyPublished ? 'running' : 'queued');
    expect((await fs.readdir(h.files)).filter(name => name.startsWith('.txn-'))).toEqual([]);
  }
});

it('allocates unique FIFO sequences across independently loaded writers sharing one directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-multiwriter-')); directories.push(dir);
  const a = createBatchStorage(dir), b = createBatchStorage(dir); await Promise.all([a.load(), b.load()]);
  const first = input(), second = input(randomUUID(), 1);
  const allocated = await Promise.all([a.create(first), b.create(second)]);
  expect([...allocated].sort((x, y) => x - y)).toEqual([1, 2]);
  const records = await createBatchStorage(dir).load();
  expect(records.map(record => record.input.sequence)).toEqual([1, 2]);
  expect(new Set(records.map(record => record.input.batchId))).toEqual(new Set([first.batchId, second.batchId]));
});

it('serializes near-512MiB reservations across independent writers so only one can publish', async () => {
  // A scaled limit exercises the identical production 512 MiB algorithm without
  // allocating half a GiB in every test process.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-quota-')); directories.push(dir); const files = path.join(dir, 'frozen-queue');
  const limits = { total: 100 * 1024, input: 64 * 1024, state: 16 * 1024 }, seed = createBatchStorage(dir, limits); await seed.load();
  const makeLarge = (size: number) => { const value = input(); value.snapshots[0].params.positivePrompt = 'x'.repeat(size); const canonical = (raw: any): any => Array.isArray(raw) ? raw.map(canonical) : raw && typeof raw === 'object' ? Object.fromEntries(Object.keys(raw).sort().map(key => [key, canonical(raw[key])])) : raw; value.payloadHash = createHash('sha256').update(JSON.stringify(canonical(value.snapshots))).digest('hex'); return value; };
  await seed.create(makeLarge(45 * 1024));
  const a = createBatchStorage(dir, limits), b = createBatchStorage(dir, limits); await Promise.all([a.load(), b.load()]);
  const outcomes = await Promise.allSettled([a.create(makeLarge(30 * 1024)), b.create(makeLarge(30 * 1024))]);
  expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
  const rootSize = async () => { let total = 0; for (const entry of await fs.readdir(files, { withFileTypes: true })) { if (entry.isDirectory()) for (const child of await fs.readdir(path.join(files, entry.name))) total += (await fs.lstat(path.join(files, entry.name, child))).size; else total += (await fs.lstat(path.join(files, entry.name))).size; } return total; };
  expect(await rootSize()).toBeLessThanOrEqual(limits.total);
});

it('revalidates every existing state chain before accepting another batch', async () => {
  const h = await setup(), first = input(); await h.storage.create(first);
  const current = path.join(h.files, `${first.batchId}.state.json`), tampered = JSON.parse(await fs.readFile(current, 'utf8')); tampered.job.status = 'succeeded'; await fs.writeFile(current, JSON.stringify(tampered));
  const next = input(); await expect(h.storage.create(next)).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(fs.stat(path.join(h.files, `${next.batchId}.input.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});

// ---- W2b: quota, incremental revalidation, compaction, limits ----
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const canonicalJson = (value: any): any => Array.isArray(value) ? value.map(canonicalJson) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonicalJson(value[key])])) : value;
const minutes = (count: number) => count * 60 * 1000;
function padded(value: FrozenBatchInput, bytes: number) { value.snapshots[0].params.positivePrompt = 'x'.repeat(bytes); value.payloadHash = sha256(JSON.stringify(canonicalJson(value.snapshots))); return value; }
/** A frozen MCP (mcp-) batch with an image-sized snapshot. */
function mcpInput(id = randomUUID(), options: { requestKey?: string; imageBytes?: number } = {}): FrozenBatchInput {
  const snapshots = [{ params: { positivePrompt: 'a red lantern', seed: 5 } as any, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, sourceImage: { mimeType: 'image/png', data: 'A'.repeat(options.imageBytes ?? 24 * 1024) } } as any];
  return { schemaVersion: 1, batchId: id, sequence: 1, fingerprint: 'fixture-only', payloadHash: sha256(JSON.stringify(canonicalJson(snapshots))),
    request: { workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: options.requestKey ?? `mcp-${'a'.repeat(24)}-${sha256(id)}`, execution: 'queued', mode: 'i2i', count: 1, intervalSeconds: 0, seeds: [5] }, snapshots,
    initial: { batchId: id, execution: 'queued', status: 'queued', finishedAt: null, activeIndex: null, activeJobId: null, items: [{ index: 0, plannedSeed: 5, status: 'pending', providerOutcome: 'not_submitted', jobId: null, results: [], error: null }] } as any };
}
const runningJob = (value: FrozenBatchInput) => ({ ...value.initial, status: 'running', activeIndex: 0, activeJobId: 'child-1', items: [{ ...value.initial.items[0], status: 'running', jobId: 'child-1', providerOutcome: 'unknown' }] }) as any;
function endedJob(value: FrozenBatchInput, options: { finishedAt?: number; unknown?: boolean } = {}) {
  const item = options.unknown ? { status: 'unknown', providerOutcome: 'unknown', results: [], error: { code: 'submission_unconfirmed', message: 'fixture' } } : { status: 'succeeded', providerOutcome: 'response_received', results: [{ index: 0, id: 'history-1', width: 64, height: 64, model: 'fixture', actualSeed: 5 }], error: null };
  return { ...value.initial, status: options.unknown ? 'blocked' : 'succeeded', activeIndex: null, activeJobId: null, finishedAt: new Date(options.finishedAt ?? Date.now() - minutes(11)).toISOString(), items: [{ ...value.initial.items[0], jobId: 'child-1', actualSeed: 5, ...item }] } as any;
}
/** create (r1) → running (r2) → terminal (r3). */
async function endedBatch(storage: ReturnType<typeof createBatchStorage>, value: FrozenBatchInput, job = endedJob(value)) {
  await storage.create(value); await storage.save(value.batchId, runningJob(value)); await storage.save(value.batchId, job); return job;
}
const batchFiles = (files: string, id: string) => ({ input: path.join(files, `${id}.input.json`), state: path.join(files, `${id}.state.json`), history: path.join(files, `${id}.states`) });
/** Gives the file a whole-second mtime, so it can be restored exactly after an edit. */
const pinnedMtime = new Date('2026-01-01T00:00:00.000Z');
async function pinMtime(file: string) { await fs.utimes(file, pinnedMtime, pinnedMtime); }
/** Same-size, same-inode rewrite with the pinned mtime restored: only ctime moves. */
async function inPlaceEdit(file: string, edit: (text: string) => string) {
  const before = await fs.stat(file, { bigint: true }), text = await fs.readFile(file, 'utf8'), next = edit(text);
  expect(before.mtimeNs).toBe(BigInt(pinnedMtime.getTime()) * 1_000_000n);
  expect(next).not.toBe(text); expect(Buffer.byteLength(next)).toBe(Buffer.byteLength(text));
  const handle = await fs.open(file, 'r+'); try { await handle.write(next, 0, 'utf8'); } finally { await handle.close(); }
  await fs.utimes(file, pinnedMtime, pinnedMtime);
  const after = await fs.stat(file, { bigint: true }); expect(after.ino).toBe(before.ino); expect(after.size).toBe(before.size); expect(after.mtimeNs).toBe(before.mtimeNs);
}
const flipHashDigit = (text: string) => text.replace(/("stateHash":"[a-f0-9]{63})([a-f0-9])"/, (_all, head, last) => `${head}${last === '0' ? '1' : '0'}"`);

it('H4 refuses an over-quota create explicitly, writes nothing and keeps the store usable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-quota-error-')); directories.push(dir); const files = path.join(dir, 'frozen-queue');
  const storage = createBatchStorage(dir, { total: 256 * 1024 }); await storage.load();
  const first = input(); await storage.create(first); const before = (await fs.readdir(files)).sort();
  const large = padded(input(), 300 * 1024), error = await storage.create(large).catch(caught => caught);
  expect(error).toBeInstanceOf(BatchQuotaError); expect(error).toMatchObject({ code: 'queue_storage_full', reason: 'bytes' });
  expect((await fs.readdir(files)).sort()).toEqual(before);
  await storage.save(first.batchId, runningJob(first));
  await expect(storage.create(input())).resolves.toBe(2);
  expect((await createBatchStorage(dir, { total: 256 * 1024 }).load()).map(record => record.input.batchId)).toEqual([first.batchId, expect.any(String)]);
});

it('H4 refuses the batch beyond the count limit as quota without breaking saves', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-count-')); directories.push(dir);
  const storage = createBatchStorage(dir, { batches: 2 }); await storage.load(); const first = input(); await storage.create(first); await storage.create(input());
  await expect(storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_full', reason: 'batches' });
  await expect(storage.save(first.batchId, runningJob(first))).resolves.toBeUndefined();
  expect(storage.capacity!()).toMatchObject({ batches: 2, batchLimit: 2 });
});

it('H4 keeps the save reserve free: a create that would physically fit is refused while saves still write', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-reserve-')); directories.push(dir); const limits = { total: 256 * 1024, reserve: 96 * 1024 };
  const storage = createBatchStorage(dir, limits); await storage.load(); const accepted = input(); await storage.create(accepted);
  const large = padded(input(), 170 * 1024), largeBytes = Buffer.byteLength(JSON.stringify(large)), used = storage.capacity!().bytes;
  expect(used + largeBytes + 4096).toBeLessThan(limits.total); expect(used + largeBytes + limits.reserve).toBeGreaterThan(limits.total);
  await expect(storage.create(large)).rejects.toMatchObject({ code: 'queue_storage_full', reason: 'bytes' });
  for (let index = 0; index < 20; index++) await storage.save(accepted.batchId, { ...runningJob(accepted), items: [{ ...runningJob(accepted).items[0], results: Array.from({ length: index }, (_, n) => ({ index: n, id: `history-${n}`, width: 64, height: 64, model: 'fixture', actualSeed: 5 })) }] });
  const capacity = storage.capacity!(); expect(capacity).toMatchObject({ batches: 1, byteLimit: limits.total, reserve: limits.reserve }); expect(capacity.bytes).toBeGreaterThan(used); expect(capacity.bytes).toBeLessThanOrEqual(limits.total);
  const records = await createBatchStorage(dir, limits).load(); expect(records[0].job.items[0].results).toHaveLength(19);
});

it('H5 does not reopen any unchanged batch file when creating or saving', async () => {
  const h = await setup(), values = [input(), input(), input()];
  for (const value of values) { await h.storage.create(value); await h.storage.save(value.batchId, runningJob(value)); }
  const opened: string[] = [], originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => { opened.push(String(args[0])); return (originalOpen as any)(...args); });
  const touching = (ids: string[]) => opened.filter(file => ids.some(id => path.basename(file).startsWith(id) || file.includes(`${id}.states`)));
  const added = input(); await h.storage.create(added);
  expect(touching(values.map(value => value.batchId))).toEqual([]);
  opened.length = 0; await h.storage.save(values[0].batchId, { ...runningJob(values[0]), status: 'pausing' });
  expect(touching([values[1].batchId, values[2].batchId, added.batchId])).toEqual([]);
  // The saved batch reads only its own current state; its history directory is opened only to fsync the new revision.
  expect(touching([values[0].batchId]).filter(file => file.includes(`.states${path.sep}`) && !file.endsWith('000000000003.json'))).toEqual([]);
});

it('H5 fully re-reads a batch whose files changed even when the bytes are identical', async () => {
  const h = await setup(), value = input(); await h.storage.create(value); await h.storage.create(input());
  const { state } = batchFiles(h.files, value.batchId); await fs.writeFile(state, await fs.readFile(state));
  const opened: string[] = [], originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => { opened.push(String(args[0])); return (originalOpen as any)(...args); });
  await expect(h.storage.create(input())).resolves.toBe(3);
  expect(opened.some(file => file.endsWith(`${value.batchId}.input.json`))).toBe(true);
  expect(opened.some(file => file.includes(`${value.batchId}.states`))).toBe(true);
});

it.each(['history', 'input', 'state'] as const)('H5 fails closed after a same-size in-place edit of a %s file with its mtime restored', async target => {
  const h = await setup(), value = input(); await h.storage.create(value); await h.storage.save(value.batchId, runningJob(value));
  const files = batchFiles(h.files, value.batchId), next = input(), file = target === 'history' ? path.join(files.history, '000000000001.json') : files[target];
  await pinMtime(file); await h.storage.create(input()); // this create caches the pinned signature
  await inPlaceEdit(file, target === 'input' ? text => text.replace('a blue teacup', 'a blue teacuP') : flipHashDigit);
  await expect(h.storage.create(next)).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(fs.stat(path.join(h.files, `${next.batchId}.input.json`))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('H5 also stops a save when another batch history was edited in place', async () => {
  const h = await setup(), a = input(), b = input(), file = () => path.join(batchFiles(h.files, b.batchId).history, '000000000002.json');
  await h.storage.create(a); await h.storage.create(b); await h.storage.save(b.batchId, runningJob(b));
  await pinMtime(file()); await h.storage.save(b.batchId, { ...runningJob(b), status: 'pausing' }); // caches the pinned signature
  await inPlaceEdit(file(), flipHashDigit);
  await expect(h.storage.save(a.batchId, runningJob(a))).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readdir(batchFiles(h.files, a.batchId).history)).toEqual(['000000000001.json']);
});

it('H6 compacts only ended MCP batches past their grace period and leaves every other batch byte-identical', async () => {
  const h = await setup(), ok = mcpInput(), okJob = await endedBatch(h.storage, ok);
  const recent = mcpInput(), recentJob = await endedBatch(h.storage, recent, endedJob(recent, { finishedAt: Date.now() - minutes(1) }));
  const unknown = mcpInput(), unknownJob = await endedBatch(h.storage, unknown, endedJob(unknown, { finishedAt: Date.now() - minutes(60), unknown: true }));
  const foreign = mcpInput(randomUUID(), { requestKey: 'style-plan-host-key' }); await endedBatch(h.storage, foreign);
  const running = mcpInput(); await h.storage.create(running); await h.storage.save(running.batchId, runningJob(running));
  const snapshotFiles = async (id: string) => { const f = batchFiles(h.files, id), names = await fs.readdir(f.history); return JSON.stringify([await fs.readFile(f.input, 'utf8'), await fs.readFile(f.state, 'utf8'), names, ...await Promise.all(names.map(name => fs.readFile(path.join(f.history, name), 'utf8')))]); };
  const untouched = Object.fromEntries(await Promise.all([recent, unknown, foreign, running].map(async value => [value.batchId, await snapshotFiles(value.batchId)])));
  const originalText = await fs.readFile(batchFiles(h.files, ok.batchId).input, 'utf8'), stateBefore = await fs.readFile(batchFiles(h.files, ok.batchId).state, 'utf8');
  const rev2 = JSON.parse(await fs.readFile(path.join(batchFiles(h.files, ok.batchId).history, '000000000002.json'), 'utf8'));

  expect(await h.storage.compact!(recent.batchId)).toEqual({ status: 'not_eligible', reason: 'grace_period', eligibleAt: Date.parse(recentJob.finishedAt) + FROZEN_COMPACTION_POLICY.graceMs });
  expect(await h.storage.compact!(unknown.batchId)).toEqual({ status: 'not_eligible', reason: 'grace_period', eligibleAt: Date.parse(unknownJob.finishedAt) + FROZEN_COMPACTION_POLICY.unknownGraceMs });
  expect(await h.storage.compact!(foreign.batchId)).toMatchObject({ status: 'not_eligible', reason: 'not_mcp' });
  expect(await h.storage.compact!(running.batchId)).toMatchObject({ status: 'not_eligible', reason: 'not_terminal' });
  expect(await h.storage.compact!(randomUUID())).toMatchObject({ status: 'not_eligible', reason: 'unknown_batch' });
  for (const [id, before] of Object.entries(untouched)) expect(await snapshotFiles(id)).toBe(before);

  const result = await h.storage.compact!(ok.batchId);
  expect(result).toMatchObject({ status: 'compacted', removedHistoryFiles: 2 }); expect((result as any).reclaimedBytes).toBeGreaterThan(24 * 1024);
  const files = batchFiles(h.files, ok.batchId), compacted = JSON.parse(await fs.readFile(files.input, 'utf8'));
  expect(compacted).not.toHaveProperty('snapshots');
  expect(compacted).toMatchObject({ schemaVersion: 2, batchId: ok.batchId, sequence: 1, request: ok.request, fingerprint: ok.fingerprint, payloadHash: ok.payloadHash, initial: ok.initial,
    compaction: { originalDigest: sha256(originalText), snapshotCount: 1, snapshotBytes: Buffer.byteLength(JSON.stringify(ok.snapshots)), historyFrom: 3, historyAnchor: rev2.stateHash } });
  const { compactedHash, ...body } = compacted; expect(compactedHash).toBe(sha256(JSON.stringify(canonicalJson(body))));
  expect(await fs.readdir(files.history)).toEqual(['000000000003.json']);
  expect(await fs.readFile(files.state, 'utf8')).toBe(stateBefore);
  expect(await h.storage.compact!(ok.batchId)).toEqual({ status: 'already_compacted', compactedAt: compacted.compaction.compactedAt });
  expect(await h.storage.compact!(unknown.batchId, { now: Date.parse(unknownJob.finishedAt) + FROZEN_COMPACTION_POLICY.unknownGraceMs })).toMatchObject({ status: 'compacted' });

  const records = await createBatchStorage(h.dir).load(), record = records.find(value => value.input.batchId === ok.batchId)!;
  expect(record.input.schemaVersion).toBe(2); expect(record.job).toEqual(okJob);
  expect(records.find(value => value.input.batchId === unknown.batchId)!.job).toEqual(unknownJob);
});

it('H6 keeps a compacted batch loadable, savable and re-compactable while other batches keep publishing', async () => {
  const h = await setup(), value = mcpInput(), job = await endedBatch(h.storage, value); await h.storage.compact!(value.batchId);
  const first = JSON.parse(await fs.readFile(batchFiles(h.files, value.batchId).input, 'utf8'));
  const reopened = createBatchStorage(h.dir); expect((await reopened.load()).map(record => record.job)).toEqual([job]);
  await expect(reopened.create(input())).resolves.toBe(2);
  await reopened.save(value.batchId, { ...job, updatedAt: 'later' });
  expect(await fs.readdir(batchFiles(h.files, value.batchId).history)).toEqual(['000000000003.json', '000000000004.json']);
  const rev4 = await createBatchStorage(h.dir).load(); expect(rev4.find(record => record.input.batchId === value.batchId)!.job.updatedAt).toBe('later');
  expect(await reopened.compact!(value.batchId)).toMatchObject({ status: 'compacted', removedHistoryFiles: 1 });
  const second = JSON.parse(await fs.readFile(batchFiles(h.files, value.batchId).input, 'utf8')), rev3 = JSON.parse(await fs.readFile(batchFiles(h.files, value.batchId).state, 'utf8'));
  expect(second.compaction).toEqual({ ...first.compaction, historyFrom: 4, historyAnchor: rev3.previousStateHash });
  expect(await fs.readdir(batchFiles(h.files, value.batchId).history)).toEqual(['000000000004.json']);
  await expect(createBatchStorage(h.dir).load()).resolves.toHaveLength(2);
});

it.each(['tampered-request', 'snapshots-smuggled', 'missing-kept-history', 'unfinished-batch'] as const)('H6 fails closed on a compacted input that is %s', async damage => {
  const h = await setup(), value = mcpInput();
  if (damage === 'unfinished-batch') {
    await h.storage.create(value); await h.storage.save(value.batchId, runningJob(value));
    const { input: file } = batchFiles(h.files, value.batchId), text = await fs.readFile(file, 'utf8');
    const body = { schemaVersion: 2, batchId: value.batchId, sequence: 1, request: value.request, fingerprint: value.fingerprint, payloadHash: value.payloadHash, initial: value.initial,
      compaction: { compactedAt: new Date().toISOString(), originalDigest: sha256(text), snapshotCount: 1, snapshotBytes: 1, historyFrom: 1, historyAnchor: null } };
    await fs.writeFile(file, JSON.stringify({ ...body, compactedHash: sha256(JSON.stringify(canonicalJson(body))) }));
  } else {
    await endedBatch(h.storage, value); await h.storage.compact!(value.batchId);
    const files = batchFiles(h.files, value.batchId), compacted = JSON.parse(await fs.readFile(files.input, 'utf8'));
    if (damage === 'tampered-request') { compacted.request.requestKey = 'mcp-other'; await fs.writeFile(files.input, JSON.stringify(compacted)); }
    if (damage === 'snapshots-smuggled') { const { compactedHash: _old, ...body } = compacted; body.snapshots = value.snapshots; await fs.writeFile(files.input, JSON.stringify({ ...body, compactedHash: sha256(JSON.stringify(canonicalJson(body))) })); }
    if (damage === 'missing-kept-history') await fs.unlink(path.join(files.history, '000000000003.json'));
  }
  const before = await fs.readFile(batchFiles(h.files, value.batchId).input, 'utf8');
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(h.storage.create(input())).rejects.toMatchObject({ code: 'queue_storage_error' });
  expect(await fs.readFile(batchFiles(h.files, value.batchId).input, 'utf8')).toBe(before);
});

it.each(['input-replace', 'first-history-unlink', 'second-history-unlink', 'marker-unlink'] as const)('H6 recovers a compaction interrupted at %s to a consistent, usable store', async step => {
  const h = await setup(), value = mcpInput(), job = await endedBatch(h.storage, value), files = batchFiles(h.files, value.batchId);
  const inputBefore = await fs.readFile(files.input, 'utf8'), stateBefore = await fs.readFile(files.state, 'utf8');
  const originalRename = fs.rename.bind(fs), originalUnlink = fs.unlink.bind(fs); let historyUnlinks = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => { if (step === 'input-replace' && String(args[1]) === files.input) throw Object.assign(new Error('simulated crash'), { code: 'EIO' }); return (originalRename as any)(...args); });
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => {
    const target = String(args[0]);
    if (target.startsWith(files.history + path.sep) && ++historyUnlinks === (step === 'first-history-unlink' ? 1 : step === 'second-history-unlink' ? 2 : 0)) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    if (step === 'marker-unlink' && /\/\.txn-[a-f0-9-]{36}\.json$/.test(target.split(path.sep).join('/'))) throw Object.assign(new Error('simulated crash'), { code: 'EIO' });
    return (originalUnlink as any)(...args);
  });
  await expect(h.storage.compact!(value.batchId)).rejects.toMatchObject({ code: 'queue_storage_error' });
  vi.restoreAllMocks();
  expect((await fs.readdir(h.files)).filter(name => /^\.txn-[a-f0-9-]{36}\.json$/.test(name))).toHaveLength(1);
  const reopened = createBatchStorage(h.dir), records = await reopened.load();
  expect((await fs.readdir(h.files)).filter(name => name.startsWith('.txn-'))).toEqual([]);
  expect(records.map(record => record.job)).toEqual([job]); expect(await fs.readFile(files.state, 'utf8')).toBe(stateBefore);
  if (step === 'input-replace') {
    expect(await fs.readFile(files.input, 'utf8')).toBe(inputBefore); expect(await fs.readdir(files.history)).toEqual(['000000000001.json', '000000000002.json', '000000000003.json']);
    expect(await reopened.compact!(value.batchId)).toMatchObject({ status: 'compacted' });
  } else {
    expect(records[0].input.schemaVersion).toBe(2); expect(await fs.readdir(files.history)).toEqual(['000000000003.json']);
    expect(await reopened.compact!(value.batchId)).toMatchObject({ status: 'already_compacted' });
  }
  await expect(reopened.create(input())).resolves.toBe(2);
  await expect(createBatchStorage(h.dir).load()).resolves.toHaveLength(2);
});

it('H10 raises the frozen batch limit to 4096 and keeps incremental creates fast on 4,000 synthetic batches', async () => {
  expect(FROZEN_QUEUE_LIMITS).toMatchObject({ batches: 4096, total: 512 * 1024 * 1024, reserve: 32 * 1024 * 1024, stateRevisions: 4096 });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-4000-')); directories.push(dir); const files = path.join(dir, 'frozen-queue'); await fs.mkdir(files, { mode: 0o700 });
  const ids = Array.from({ length: 4000 }, () => randomUUID());
  for (let start = 0; start < ids.length; start += 200) await Promise.all(ids.slice(start, start + 200).map(async (id, offset) => {
    const value = padded(input(id, start + offset + 1), 4000), text = JSON.stringify(value), body = { schemaVersion: 2, batchId: id, inputHash: sha256(text), revision: 1, previousStateHash: null, job: { ...value.initial, status: 'succeeded' } };
    const state = JSON.stringify({ ...body, stateHash: sha256(JSON.stringify(canonicalJson(body))) });
    await fs.writeFile(path.join(files, `${id}.input.json`), text, { mode: 0o600 }); await fs.mkdir(path.join(files, `${id}.states`), { mode: 0o700 });
    await fs.writeFile(path.join(files, `${id}.states`, '000000000001.json'), state, { mode: 0o600 }); await fs.writeFile(path.join(files, `${id}.state.json`), state, { mode: 0o600 });
  }));
  const storage = createBatchStorage(dir); expect(await storage.load()).toHaveLength(4000);
  // Incremental: a create opens and reads only its own files, as many on 4,000 stored batches as on an empty store
  // (it lists the folder, but never reopens or rereads the stored inputs and states). Counted, not timed.
  const fileReads = async (run: () => Promise<unknown>) => {
    const counts = { open: 0, readFile: 0 }, open = fs.open.bind(fs), readFile = fs.readFile.bind(fs);
    const spies = [vi.spyOn(fs, 'open').mockImplementation(async (...args: any[]) => { counts.open++; return (open as any)(...args); }),
      vi.spyOn(fs, 'readFile').mockImplementation(async (...args: any[]) => { counts.readFile++; return (readFile as any)(...args); })];
    try { await run(); } finally { spies.forEach(spy => spy.mockRestore()); }
    return counts;
  };
  const empty = await setup(), baseline = await fileReads(() => empty.storage.create(input()));
  // Besides the counts, a loose bound on the CPU time of this process (its file-system threads included) for one
  // create, for O(n) work that opens or reads nothing (the folder scan already lstats every stored file once). Other
  // busy processes do not count against it. On Windows every lstat opens and closes a handle to the file (libuv:
  // CreateFileW, GetFileInformationByHandle), several times the CPU of a POSIX lstat, so the same scan gets 4x the bound.
  const cpuBoundMs = process.platform === 'win32' ? 8000 : 2000;
  const cpuMs: number[] = [];
  for (let index = 0; index < 3; index++) {
    let sequence = 0;
    const started = process.cpuUsage();
    expect(await fileReads(async () => { sequence = await storage.create(input()); })).toEqual(baseline);
    const used = process.cpuUsage(started); cpuMs.push((used.user + used.system) / 1000);
    expect(sequence).toBe(4001 + index);
  }
  expect(Math.min(...cpuMs), `CPU ms per create: ${cpuMs.map(ms => ms.toFixed(0)).join('/')}`).toBeLessThan(cpuBoundMs);
  expect(storage.capacity!()).toMatchObject({ batches: 4003, batchLimit: 4096 });
}, 240_000);

it('refuses an inconsistent new input alone (nothing written) and stays usable; damage found on disk still fails closed', async () => {
  const { storage, files, dir } = await setup(), kept = input();
  await storage.create(kept);
  const mismatched = input(); mismatched.payloadHash = 'f'.repeat(64);
  const malformed: any = input(); malformed.snapshots[0].params.bad = () => 0;
  for (const value of [mismatched, malformed]) await expect(storage.create(value)).rejects.toBeInstanceOf(BatchInputError);
  expect((await fs.readdir(files)).filter(name => name.includes(mismatched.batchId) || name.includes(malformed.batchId) || name.startsWith('.txn-'))).toEqual([]);
  const later = input(); await expect(storage.create(later)).resolves.toBe(2);
  expect((await createBatchStorage(dir).load()).map(record => record.input.batchId)).toEqual([kept.batchId, later.batchId]);
  // A stored input whose snapshots no longer match its payloadHash is damage: the store fails closed.
  const file = path.join(files, `${kept.batchId}.input.json`), text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('a blue teacup', 'a red teacup'));
  await expect(createBatchStorage(dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
});

// ---- Review rework P2-1: a compaction cleanup that cannot remove files must not stop the frozen queue ----
it('P2-1 retries a busy compaction unlink on win32 with the renameReplace backoff, and nowhere else', async () => {
  const run = async (platform: string, codes: string[]) => {
    const sleeps: number[] = [], queue = [...codes]; let calls = 0;
    const remove = createCompactionUnlink({ platform, sleep: async (ms: number) => { sleeps.push(ms); }, unlink: async () => { calls++; const code = queue.shift(); if (code) throw Object.assign(new Error(code), { code }); } });
    const outcome = await remove('/fixture/file').then(() => 'removed', (error: any) => error.code);
    return { outcome, calls, sleeps };
  };
  expect(await run('win32', ['EBUSY', 'EPERM', 'EACCES'])).toEqual({ outcome: 'removed', calls: 4, sleeps: [10, 20, 40] });
  expect(await run('win32', Array(6).fill('EBUSY'))).toEqual({ outcome: 'EBUSY', calls: 6, sleeps: [10, 20, 40, 60, 70] });
  expect(await run('win32', ['EIO'])).toEqual({ outcome: 'EIO', calls: 1, sleeps: [] });
  expect(await run('darwin', ['EBUSY'])).toEqual({ outcome: 'EBUSY', calls: 1, sleeps: [] });
  expect(await run('win32', ['ENOENT'])).toEqual({ outcome: 'removed', calls: 1, sleeps: [] });
});

it.each(['history', 'marker'] as const)('P2-1 a compaction whose %s cleanup stays busy is deferred: the store stays usable, the marker is kept and the next locked operation rolls it forward', async target => {
  const h = await setup(), value = mcpInput(), job = await endedBatch(h.storage, value), files = batchFiles(h.files, value.batchId);
  const markers = async () => (await fs.readdir(h.files)).filter(name => /^\.txn-[a-f0-9-]{36}\.json$/.test(name));
  let busy = true, busyMarker: string | null = null; const originalUnlink = fs.unlink.bind(fs);
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => {
    const file = String(args[0]).split(path.sep).join('/');
    // Only the compaction's own marker is held open; later operations' markers are not.
    if (target === 'marker' && !busyMarker && /\/\.txn-[a-f0-9-]{36}\.json$/.test(file)) busyMarker = file;
    const hit = target === 'history' ? file.startsWith(files.history.split(path.sep).join('/') + '/') : file === busyMarker;
    if (busy && hit) throw Object.assign(new Error('file is open in another process'), { code: 'EBUSY' });
    return (originalUnlink as any)(...args);
  });
  await expect(h.storage.compact!(value.batchId)).rejects.toMatchObject({ code: 'queue_compaction_deferred' });
  expect(JSON.parse(await fs.readFile(files.input, 'utf8')).schemaVersion).toBe(2); // published; only cleanup is pending
  expect(await markers()).toHaveLength(1);
  // Not broken: other batches still publish and save; another process still loads while the cleanup keeps failing.
  const other = input(); await expect(h.storage.create(other)).resolves.toBe(2);
  await expect(h.storage.save(other.batchId, { ...other.initial, status: 'paused' } as any)).resolves.toBeUndefined();
  expect((await createBatchStorage(h.dir).load()).map(record => record.input.batchId).sort()).toEqual([value.batchId, other.batchId].sort());
  expect(await markers()).toHaveLength(1);
  busy = false;
  await expect(h.storage.create(input())).resolves.toBe(3); // the next locked operation rolls the cleanup forward
  vi.restoreAllMocks();
  expect(await markers()).toEqual([]); expect(await fs.readdir(files.history)).toEqual(['000000000003.json']);
  const records = await createBatchStorage(h.dir).load();
  expect(records.find(record => record.input.batchId === value.batchId)).toMatchObject({ job, input: { schemaVersion: 2 } });
});

// ---- Review round 3: P2-b busy input replacement, P3-a stale compact markers ----
/** fs spies for one batch: `rename` of its input and `unlink` of chosen markers fail with EBUSY while switched on. */
function busyFiles(files: { input: string }) {
  const state = { input: false, markers: new Set<string>(), seenMarkers: [] as string[] };
  const norm = (value: unknown) => String(value).split(path.sep).join('/'), inputPath = norm(files.input), originalRename = fs.rename.bind(fs), originalUnlink = fs.unlink.bind(fs);
  vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => { if (state.input && norm(args[1]) === inputPath) throw Object.assign(new Error('input held open'), { code: 'EBUSY' }); return (originalRename as any)(...args); });
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => {
    const file = norm(args[0]);
    if (/\/\.txn-[a-f0-9-]{36}\.json$/.test(file)) { if (!state.seenMarkers.includes(file)) state.seenMarkers.push(file); if (state.markers.has(file)) throw Object.assign(new Error('marker held open'), { code: 'EBUSY' }); }
    return (originalUnlink as any)(...args);
  });
  return state;
}
const compactMarkers = async (dir: string) => (await fs.readdir(dir)).filter(name => /^\.txn-[a-f0-9-]{36}\.json$/.test(name));

it('P2-b a busy input replacement defers the compaction before anything is published; the store stays usable and the unpublished marker is dropped later', async () => {
  const h = await setup(), value = mcpInput(), job = await endedBatch(h.storage, value), files = batchFiles(h.files, value.batchId), busy = busyFiles(files);
  const inputBefore = await fs.readFile(files.input, 'utf8');
  busy.input = true;
  await expect(h.storage.compact!(value.batchId)).rejects.toMatchObject({ code: 'queue_compaction_deferred', published: false });
  expect(await fs.readFile(files.input, 'utf8')).toBe(inputBefore); // nothing published
  expect(await compactMarkers(h.files)).toHaveLength(1);
  await expect(h.storage.create(input())).resolves.toBe(2); // not broken; recovery drops the unpublished marker
  expect(await compactMarkers(h.files)).toEqual([]);
  busy.input = false;
  await expect(h.storage.compact!(value.batchId)).resolves.toMatchObject({ status: 'compacted' });
  vi.restoreAllMocks();
  expect((await createBatchStorage(h.dir).load()).find(record => record.input.batchId === value.batchId)).toMatchObject({ job, input: { schemaVersion: 2 } });
});

it('P3-a a stale compact marker (its revision below the published historyFrom) is dropped on recovery instead of failing every load', async () => {
  // The chain: unpublished marker kept busy → the ended batch saves once more → compaction is retried and published.
  const h = await setup(), value = mcpInput(), job = await endedBatch(h.storage, value), files = batchFiles(h.files, value.batchId), busy = busyFiles(files);
  busy.input = true;
  await expect(h.storage.compact!(value.batchId)).rejects.toMatchObject({ code: 'queue_compaction_deferred' });
  const kept = await compactMarkers(h.files); expect(kept).toHaveLength(1);
  busy.markers.add(path.join(h.files, kept[0]).split(path.sep).join('/')); // the unpublished revision-3 marker stays held open
  busy.input = false;
  const later = { ...job, updatedAt: new Date().toISOString() };
  await h.storage.save(value.batchId, later); // revision 4
  await expect(h.storage.compact!(value.batchId)).resolves.toMatchObject({ status: 'compacted' }); // publishes historyFrom 4
  expect(await compactMarkers(h.files)).toHaveLength(1); // the stale revision-3 marker is still held open
  busy.markers.clear(); vi.restoreAllMocks();
  const records = await createBatchStorage(h.dir).load();
  expect(records.find(record => record.input.batchId === value.batchId)).toMatchObject({ input: { schemaVersion: 2, compaction: { historyFrom: 4 } } });
  expect(await compactMarkers(h.files)).toEqual([]);
});

it('P3-a a crafted stale compact marker never makes the store unloadable', async () => {
  const h = await setup(), value = mcpInput(); await endedBatch(h.storage, value); await h.storage.save(value.batchId, { ...endedJob(value), updatedAt: new Date().toISOString() });
  await expect(h.storage.compact!(value.batchId)).resolves.toMatchObject({ status: 'compacted' }); // historyFrom 4
  const nonce = randomUUID();
  await fs.writeFile(path.join(h.files, `.txn-${nonce}.json`), JSON.stringify({ schemaVersion: 1, nonce, kind: 'compact', batchId: value.batchId, revision: 3 }));
  await expect(createBatchStorage(h.dir).load()).resolves.toHaveLength(1);
  expect(await compactMarkers(h.files)).toEqual([]);
});

// ---- Review round 4 P3-1: busy markers must not make every locked operation slower and slower on win32 ----
it('P3-1 on win32, markers already deferred are tried once per lock without backoff: a save does not slow down as busy markers accumulate', async () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!, originalUnlink = fs.unlink.bind(fs), busy: string[] = [];
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    vi.resetModules();
    const win = await import('./batch-storage'); // module-level helpers now take the win32 branches (bounded retries)
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-win32-')); directories.push(dir);
    const storage = win.createBatchStorage(dir); await storage.load();
    let busyAttempts = 0;
    vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { const file = String(args[0]); if (busy.some(history => file.startsWith(history + path.sep))) { busyAttempts++; throw Object.assign(new Error('held open'), { code: 'EBUSY' }); } return (originalUnlink as any)(...args); });
    const running = input(); await storage.create(running);
    for (let index = 0; index < 6; index++) {
      const value = mcpInput(); await endedBatch(storage, value); busy.push(path.join(dir, 'frozen-queue', `${value.batchId}.states`));
      await expect(storage.compact!(value.batchId)).rejects.toMatchObject({ code: 'queue_compaction_deferred', published: true });
    }
    expect((await fs.readdir(path.join(dir, 'frozen-queue'))).filter(name => /^\.txn-[a-f0-9-]{36}\.json$/.test(name))).toHaveLength(6);
    // Counted, not timed: during a save each deferred marker is tried once and nothing waits out a retry backoff
    // (with backoff on every lock, 6 busy markers cost at least 6 × 200 ms per save).
    const timers = vi.spyOn(globalThis, 'setTimeout'), saves: Array<{ attempts: number; backoffs: number }> = [];
    for (const status of ['paused', 'queued', 'paused'] as const) {
      busyAttempts = 0; timers.mockClear();
      await storage.save(running.batchId, { ...running.initial, status } as any);
      saves.push({ attempts: busyAttempts, backoffs: timers.mock.calls.filter(([, ms]) => COMPACTION_UNLINK_DELAYS_MS.includes(Number(ms))).length });
    }
    expect(saves).toEqual(Array(3).fill({ attempts: 6, backoffs: 0 }));
  } finally { Object.defineProperty(process, 'platform', realPlatform); vi.resetModules(); }
}, 90_000);


it('skips system metadata files in the queue and .states folders while loading, saving and compacting, and changes none of them', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-metadata-')); directories.push(root);
  const runtimeDir = path.join(root, 'runtime'); await fs.mkdir(runtimeDir); const storage = createBatchStorage(runtimeDir); await storage.load();
  const value = mcpInput(), files = path.join(runtimeDir, 'frozen-queue'), states = path.join(files, `${value.batchId}.states`);
  await storage.create(value);
  const metadata = [path.join(files, '.DS_Store'), path.join(files, '._input.json'), path.join(files, 'Thumbs.db'), path.join(files, 'desktop.ini'), path.join(states, '.DS_Store'), path.join(states, 'thumbs.DB')];
  for (const file of metadata) await fs.writeFile(file, path.basename(file));
  await storage.save(value.batchId, { ...value.initial, status: 'running', activeIndex: 0, activeJobId: 'child', items: [{ ...value.initial.items[0], status: 'running', jobId: 'child', actualSeed: 17 }] } as any);
  const job = endedJob(value); await storage.save(value.batchId, job);
  const restarted = createBatchStorage(runtimeDir);
  expect((await restarted.load()).find(record => record.input.batchId === value.batchId)?.job).toEqual(job);
  expect(await restarted.compact!(value.batchId, { now: Date.now() + 24 * 60 * 60 * 1000 })).toMatchObject({ status: 'compacted' });
  expect((await createBatchStorage(runtimeDir).load()).find(record => record.input.batchId === value.batchId)?.input.schemaVersion).toBe(2);
  for (const file of metadata) expect(await fs.readFile(file, 'utf8'), file).toBe(path.basename(file));
});

it('refuses any other entry naming it relative to the data root, changes nothing, and loads again once it is gone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-stray-')); directories.push(root);
  const runtimeDir = path.join(root, 'runtime'); await fs.mkdir(runtimeDir); const storage = createBatchStorage(runtimeDir); await storage.load();
  const value = input(); await storage.create(value);
  const files = path.join(runtimeDir, 'frozen-queue');
  for (const [relative, make] of [['notes.txt', (file: string) => fs.writeFile(file, 'mine')], [`.${randomUUID()}.tmp`, (file: string) => fs.writeFile(file, '{"partial":')], ['old', (file: string) => fs.mkdir(file)], [`${value.batchId}.states/notes.txt`, (file: string) => fs.writeFile(file, 'mine')], [`${value.batchId}.states/.DS_Store`, (file: string) => fs.mkdir(file)]] as const) {
    const file = path.join(files, ...relative.split('/')); await make(file);
    const before = await fs.readdir(files, { recursive: true });
    await expect(createBatchStorage(runtimeDir).load()).rejects.toMatchObject({ code: 'queue_storage_error', entry: `runtime/frozen-queue/${relative}`, message: expect.stringContaining(`runtime/frozen-queue/${relative}`) });
    expect(await fs.readdir(files, { recursive: true })).toEqual(before);
    await fs.rm(file, { recursive: true });
    expect((await createBatchStorage(runtimeDir).load()).map(record => record.input.batchId)).toEqual([value.batchId]);
  }
});

it('retention: purge removes ended batches with every file, frees their slots and bytes and leaves the others as they are', async () => {
  const h = await setup(), a = mcpInput(), b = mcpInput(), running = mcpInput();
  await endedBatch(h.storage, a); await endedBatch(h.storage, b, endedJob(b, { unknown: true }));
  await h.storage.create(running); await h.storage.save(running.batchId, runningJob(running));
  const before = h.storage.capacity!()!, keptFiles = await Promise.all(Object.values(batchFiles(h.files, running.batchId)).map(file => fs.stat(file).then(info => info.size)));
  const result = await h.storage.purge!([a.batchId, b.batchId, running.batchId]);
  expect(result.removed.sort()).toEqual([a.batchId, b.batchId].sort()); expect(result.deferred).toEqual([]);
  // The batch that has not ended is left as it is.
  for (const id of [a.batchId, b.batchId]) for (const file of Object.values(batchFiles(h.files, id))) await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await Promise.all(Object.values(batchFiles(h.files, running.batchId)).map(file => fs.stat(file).then(info => info.size)))).toEqual(keptFiles);
  const after = h.storage.capacity!()!;
  expect(after.batches).toBe(before.batches - 2); expect(before.bytes - after.bytes).toBe(result.reclaimedBytes); expect(result.reclaimedBytes).toBeGreaterThan(48 * 1024);
  expect((await fs.readdir(h.files)).filter(name => name.startsWith('.txn-'))).toEqual([]);
  // The store keeps working, and a fresh load sees exactly what is left.
  await h.storage.save(running.batchId, endedJob(running)); await expect(h.storage.create(mcpInput())).resolves.toBeGreaterThan(0);
  expect((await createBatchStorage(h.dir).load()).map(record => record.input.batchId)).toContain(running.batchId);
  expect((await createBatchStorage(h.dir).load()).map(record => record.input.batchId)).not.toContain(a.batchId);
  // Unknown or already removed IDs remove nothing; a malformed one is refused.
  await expect(h.storage.purge!([a.batchId])).resolves.toEqual({ removed: [], reclaimedBytes: 0, deferred: [] });
});

it('retention: a purge interrupted after its marker is rolled forward by the next start; nothing half-removed is left to fail the load', async () => {
  const h = await setup(), a = mcpInput(), b = mcpInput(); await endedBatch(h.storage, a); await endedBatch(h.storage, b);
  // The process dies after the first file of a: every later unlink of this run fails.
  const originalUnlink = fs.unlink.bind(fs); let unlinks = 0;
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { if (String(args[0]).includes(a.batchId) && ++unlinks > 1) throw Object.assign(new Error('killed'), { code: 'EIO' }); return (originalUnlink as any)(...args); });
  await expect(h.storage.purge!([a.batchId, b.batchId])).rejects.toMatchObject({ code: 'queue_storage_error' });
  vi.restoreAllMocks();
  expect((await fs.readdir(h.files)).filter(name => /^\.txn-.*\.json$/.test(name))).toHaveLength(1);
  const restarted = createBatchStorage(h.dir), records = await restarted.load();
  expect(records).toEqual([]);
  expect((await fs.readdir(h.files)).filter(name => !name.startsWith('.quota'))).toEqual([]);
  await expect(restarted.create(mcpInput())).resolves.toBe(1);
});

it('retention: a busy file defers a purge: the batch is hidden at once, the store keeps working and the removal is finished later', async () => {
  const h = await setup(), a = mcpInput(), kept = mcpInput(); await endedBatch(h.storage, a); await endedBatch(h.storage, kept);
  const originalUnlink = fs.unlink.bind(fs), state = batchFiles(h.files, a.batchId).state; let busy = true;
  vi.spyOn(fs, 'unlink').mockImplementation(async (...args: any[]) => { if (busy && String(args[0]) === state) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return (originalUnlink as any)(...args); });
  const result = await h.storage.purge!([a.batchId]);
  expect(result).toMatchObject({ removed: [], deferred: [a.batchId] });
  await h.storage.save(kept.batchId, endedJob(kept, { unknown: true }));
  await expect(h.storage.create(mcpInput())).resolves.toBeGreaterThan(0);
  expect(h.storage.capacity!()!.batches).toBe(2);
  // Another instance (a restart) does not see it either while the file stays busy, and removes it once free.
  const other = createBatchStorage(h.dir); expect((await other.load()).map(record => record.input.batchId)).not.toContain(a.batchId);
  busy = false; await other.create(mcpInput());
  await expect(fs.lstat(state)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await fs.readdir(h.files)).filter(name => /^\.txn-.*\.json$/.test(name))).toEqual([]);
});

it('retention: a compaction cleanup still pending for a batch that was purged is dropped instead of failing the store', async () => {
  const h = await setup(), a = mcpInput(); await endedBatch(h.storage, a);
  const nonce = randomUUID();
  await fs.writeFile(path.join(h.files, `.txn-${nonce}.json`), JSON.stringify({ schemaVersion: 1, nonce, kind: 'compact', batchId: a.batchId, revision: 3 }));
  await expect(h.storage.purge!([a.batchId])).resolves.toMatchObject({ removed: [a.batchId] });
  expect(await createBatchStorage(h.dir).load()).toEqual([]);
  expect((await fs.readdir(h.files)).filter(name => name.startsWith('.txn-'))).toEqual([]);
});

it('retention: a purge marker that is not this version\'s format stops the store without removing anything', async () => {
  const h = await setup(), a = mcpInput(); await endedBatch(h.storage, a);
  const nonce = randomUUID();
  await fs.writeFile(path.join(h.files, `.txn-${nonce}.json`), JSON.stringify({ schemaVersion: 1, nonce, kind: 'purge', batchId: a.batchId, revision: 0, batchIds: [randomUUID()] }));
  await expect(createBatchStorage(h.dir).load()).rejects.toMatchObject({ code: 'queue_storage_error' });
  await expect(fs.lstat(batchFiles(h.files, a.batchId).input)).resolves.toBeTruthy();
});
