import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runCleanups } from '../src/test-support/temp-dirs';
import { createQueueTombstones, QUEUE_TOMBSTONE_FILE, tornIdentity, type CleanedBatchRecord, type CleanedRecord, type TornIdentity } from './queue-tombstones';

// The cleaned-batch records (review rework P1): a hash chain plus two anchors in two folders. Damage of any kind fails
// closed (never an answer "no record"); the crash states an interrupted append can leave are accepted.
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));
const hex = (n: number) => n.toString(16).padStart(64, '0');
const batch = (n: number): CleanedBatchRecord => ({ kind: 'batch', v: 1, keyHash: hex(n), batchId: randomUUID(), mode: 't2i', status: 'succeeded', stopCode: null, count: 1,
  counts: { succeeded: 1, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }, requestHash: hex(1000 + n), recipePlanHash: hex(2000 + n), intervalSeconds: 0, createdAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z', cleanedAt: '2026-11-05T00:00:00.000Z' });
const recipe = (): CleanedRecord => ({ kind: 'recipe', v: 1, recipeId: randomUUID(), recipeRevision: 1, cleanedAt: '2026-11-05T00:00:00.000Z' });

async function store(pending: (identity: TornIdentity) => Promise<boolean> = async () => false) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-tombstones-')));
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const runtime = path.join(base, 'runtime'), anchorDir = path.join(base, 'queue-anchor'); await fs.mkdir(runtime);
  const open = () => createQueueTombstones(runtime, { anchorDir, log: () => {}, pending });
  const file = path.join(runtime, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.name);
  const anchorA = path.join(runtime, QUEUE_TOMBSTONE_FILE.directory, QUEUE_TOMBSTONE_FILE.anchor), anchorB = path.join(anchorDir, QUEUE_TOMBSTONE_FILE.secondAnchor);
  const lines = async () => (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  return { base, runtime, anchorDir, open, file, anchorA, anchorB, lines };
}
/** Three batch records and a recipe record, written by one store. */
async function filled(pending?: (identity: TornIdentity) => Promise<boolean>) {
  const h = await store(pending), t = h.open(), records = [batch(1), batch(2), recipe(), batch(3)];
  await t.append(records.slice(0, 2)); await t.append(records.slice(2));
  return { ...h, records };
}
const expectBroken = async (h: Awaited<ReturnType<typeof store>>, problem: string) => {
  const t = h.open();
  await t.load();
  expect(t.health()).toMatchObject({ state: 'broken', problem });
  await expect(t.byKeyHash(hex(1))).rejects.toMatchObject({ code: 'queue_storage_failed', problem });
  await expect(t.byKeyHash(hex(999))).rejects.toMatchObject({ code: 'queue_storage_failed', problem });
  await expect(t.append([batch(50)])).rejects.toMatchObject({ code: 'queue_storage_failed' });
  return t;
};

describe('cleaned-batch records: chain and anchors', () => {
  it('creates both anchors (count 0) before the first line, chains every line and keeps both anchors at the last one', async () => {
    const h = await store(), t = h.open();
    await t.load(); expect(t.health()).toMatchObject({ state: 'ok', readable: 0 });
    await expect(t.byKeyHash(hex(1))).resolves.toBeNull();
    await fs.mkdir(path.dirname(h.file), { recursive: true });
    await t.append([batch(1), batch(2)]);
    const lines = (await h.lines()).map(line => JSON.parse(line));
    expect(lines.map(line => line.prev)).toEqual([null, lines[0].hash]);
    expect(Object.keys(lines[0]).slice(0, 4)).toEqual(['prev', 'kind', 'keyHash', 'batchId']);
    for (const anchor of [h.anchorA, h.anchorB]) expect(JSON.parse(await fs.readFile(anchor, 'utf8'))).toMatchObject({ v: 1, count: 2, lastHash: lines[1].hash });
    expect(t.health()).toMatchObject({ state: 'ok', anchored: 2, readable: 2 });
    await expect(h.open().byKeyHash(hex(2))).resolves.toMatchObject({ keyHash: hex(2) });
  });

  it.each([
    ['a middle line removed', async (h: any) => { const lines = await h.lines(); lines.splice(1, 1); await fs.writeFile(h.file, `${lines.join('\n')}\n`); }, 'chain_broken'],
    ['a line changed', async (h: any) => { const text = await fs.readFile(h.file, 'utf8'); await fs.writeFile(h.file, text.replace('"succeeded":1', '"succeeded":2')); }, 'chain_broken'],
    ['the last line removed whole', async (h: any) => { const lines = await h.lines(); await fs.writeFile(h.file, `${lines.slice(0, -1).join('\n')}\n`); }, 'records_missing'],
    ['cut at a line boundary', async (h: any) => { const lines = await h.lines(); await fs.writeFile(h.file, `${lines.slice(0, 2).join('\n')}\n`); }, 'records_missing'],
    ['cut in the middle of the last line', async (h: any) => { const text = await fs.readFile(h.file); await fs.writeFile(h.file, text.subarray(0, text.length - 40)); }, 'records_missing'],
    ['the record file deleted', async (h: any) => { await fs.rm(h.file); }, 'records_missing'],
    ['the whole runtime/queue-cleaned folder deleted', async (h: any) => { await fs.rm(path.dirname(h.file), { recursive: true }); }, 'records_missing'],
    ['anchor A deleted', async (h: any) => { await fs.rm(h.anchorA); }, 'anchor_missing'],
    ['anchor B deleted', async (h: any) => { await fs.rm(h.anchorB); }, 'anchor_missing'],
    ['both anchors deleted', async (h: any) => { await fs.rm(h.anchorA); await fs.rm(h.anchorB); }, 'anchor_missing'],
    ['an anchor edited by hand', async (h: any) => { const text = await fs.readFile(h.anchorB, 'utf8'); await fs.writeFile(h.anchorB, text.replace('"count":4', '"count":9')); }, 'anchor_invalid'],
    ['the file replaced by an older copy and its anchor rewritten to match it', async (h: any) => {
      const lines = await h.lines(); await fs.writeFile(h.file, `${lines.slice(0, 2).join('\n')}\n`);
      const { createHash } = await import('node:crypto'); const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
      const anchor = { v: 1, count: 2, lastHash: JSON.parse(lines[1]).hash, updatedAt: new Date().toISOString() };
      await fs.writeFile(h.anchorA, JSON.stringify({ ...anchor, hash: createHash('sha256').update(JSON.stringify(canonical(anchor))).digest('hex') }));
    }, 'records_missing'],
  ])('fails closed when %s', async (_name, damage, problem) => {
    const h = await filled(); await damage(h);
    await expectBroken(h, problem);
  });

  it('accepts what an interrupted append leaves: lines the anchors had not caught up with, and one anchor behind the other', async () => {
    const h = await filled(), oldA = await fs.readFile(h.anchorA), oldB = await fs.readFile(h.anchorB);
    await h.open().append([batch(7)]);
    // Lines written, anchor A advanced, anchor B not: and then neither.
    await fs.writeFile(h.anchorB, oldB);
    let t = h.open(); await t.load(); expect(t.health()).toMatchObject({ state: 'ok', readable: 5 });
    await fs.writeFile(h.anchorA, oldA);
    t = h.open(); await t.load(); expect(t.health()).toMatchObject({ state: 'ok', readable: 5 });
    await expect(t.byKeyHash(hex(7))).resolves.toMatchObject({ keyHash: hex(7) });
    await t.settleAnchors();
    for (const anchor of [h.anchorA, h.anchorB]) expect(JSON.parse(await fs.readFile(anchor, 'utf8')).count).toBe(5);
  });

  it('a torn last line beyond the anchors is cut off only when what it names is still there; otherwise it fails closed', async () => {
    for (const still of [true, false]) {
      const asked: TornIdentity[] = [];
      const h = await filled(async identity => { asked.push(identity); return still; });
      const half = (await import('./queue-tombstones')).tornIdentity;
      const t0 = h.open(); const tornLine = JSON.stringify({ prev: JSON.parse((await h.lines()).at(-1)!).hash, kind: 'batch', keyHash: hex(42), batchId: '11111111-2222-4333-8444-555555555555', v: 1 });
      await fs.appendFile(h.file, tornLine.slice(0, tornLine.length - 6));
      expect(half(tornLine.slice(0, tornLine.length - 6))).toEqual({ kind: 'batch', keyHash: hex(42), batchId: '11111111-2222-4333-8444-555555555555' });
      await t0.load();
      expect(asked).toEqual([{ kind: 'batch', keyHash: hex(42), batchId: '11111111-2222-4333-8444-555555555555' }]);
      if (!still) { expect(t0.health()).toMatchObject({ state: 'broken', problem: 'torn_unverified' }); continue; }
      expect(t0.health().state).toBe('ok');
      await t0.append([batch(43)]);
      const lines = await h.lines();
      expect(lines).toHaveLength(5); expect(lines.every(line => JSON.parse(line).kind)).toBe(true);
      const again = h.open(); await again.load(); expect(again.health()).toMatchObject({ state: 'ok', readable: 5 });
    }
    // A torn line too short to say what it names fails closed.
    const h = await filled(async () => true);
    await fs.appendFile(h.file, '{"prev":"ab');
    await expectBroken(h, 'torn_unverified');
    expect(tornIdentity('{"prev":null,"kind":"recipe","recipeId":"11111111-2222-4333-8444-555555555555","recipeRevision":3,"v"')).toEqual({ kind: 'recipe', recipeId: '11111111-2222-4333-8444-555555555555', recipeRevision: 3 });
  });

  it('a crash while the first anchors were being created (no line written yet) is no damage', async () => {
    const h = await store(), t = h.open();
    await t.append([batch(1)]);
    await fs.rm(h.file); await fs.rm(h.anchorB);
    await fs.writeFile(h.anchorA, (await fs.readFile(h.anchorA, 'utf8')).replace(/.*/s, ''));
    // Rewritten as a valid count-0 anchor: what the first append writes before any line.
    const { createHash } = await import('node:crypto'); const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
    const anchor = { v: 1, count: 0, lastHash: null, updatedAt: new Date().toISOString() };
    await fs.writeFile(h.anchorA, JSON.stringify({ ...anchor, hash: createHash('sha256').update(JSON.stringify(canonical(anchor))).digest('hex') }));
    const again = h.open(); await again.load();
    expect(again.health()).toMatchObject({ state: 'ok', readable: 0 });
    await again.append([batch(2)]);
    expect(JSON.parse(await fs.readFile(h.anchorB, 'utf8')).count).toBe(1);
  });
});

describe('cleaned-batch records: anchors behind and anchors that are not files (review rework 2)', () => {
  it('anchors left behind by a crash catch up (append of known records, settleAnchors); health reports what the anchors say; a later loss is noticed', async () => {
    const h = await filled(), oldA = await fs.readFile(h.anchorA), oldB = await fs.readFile(h.anchorB);
    await h.open().append([batch(7)]);
    await fs.writeFile(h.anchorA, oldA); await fs.writeFile(h.anchorB, oldB); // a crash after the line was synced
    const t = h.open(); await t.load();
    expect(t.health()).toMatchObject({ state: 'ok', anchored: 4, readable: 5 });
    expect(t.anchorsBehind()).toBe(true);
    // The next cleaning appends the same (already known) record: nothing new, but the anchors catch up.
    expect(await t.append([batch(7)])).toBe(0);
    for (const anchor of [h.anchorA, h.anchorB]) expect(JSON.parse(await fs.readFile(anchor, 'utf8')).count).toBe(5);
    expect(t.health()).toMatchObject({ state: 'ok', anchored: 5, readable: 5 }); expect(t.anchorsBehind()).toBe(false);
    // Losing that last line now is damage, never "no record".
    const lines = await h.lines(); await fs.writeFile(h.file, `${lines.slice(0, -1).join('\n')}\n`);
    await expectBroken(h, 'records_missing');
    // settleAnchors does the same at start.
    const h2 = await filled(), a2 = await fs.readFile(h2.anchorA), b2 = await fs.readFile(h2.anchorB);
    await h2.open().append([batch(8)]); await fs.writeFile(h2.anchorA, a2); await fs.writeFile(h2.anchorB, b2);
    const t2 = h2.open(); await t2.settleAnchors();
    expect(t2.health()).toMatchObject({ state: 'ok', anchored: 5, readable: 5 });
  });

  it('an anchor replaced by a folder, or its folder by a file, is damage (anchor_invalid), never a raw read error', async () => {
    const h = await filled();
    await fs.rm(h.anchorA); await fs.mkdir(h.anchorA);
    const t = await expectBroken(h, 'anchor_invalid');
    expect(t.health().detail).toMatch(/anchor-v1\.json/);
    const h2 = await filled();
    await fs.rm(h2.anchorDir, { recursive: true }); await fs.writeFile(h2.anchorDir, 'not a folder');
    await expectBroken(h2, 'anchor_invalid');
  });
});

describe('cleaned-batch records: knowing repair and restore from a backup', () => {
  it('repair keeps every readable record, adds the recovered ones and a repair line, and anchors the new chain', async () => {
    const h = await filled(), lines = await h.lines(); lines.splice(1, 1); await fs.writeFile(h.file, `${lines.join('\n')}\n`);
    const t = await expectBroken(h, 'chain_broken');
    const readable = await t.readable();
    expect(readable.map(record => record.kind)).toEqual(['batch', 'recipe', 'batch']);
    const recovered = { kind: 'recovered' as const, v: 1 as const, keyHash: hex(2), batchId: randomUUID(), savedImages: 2, recoveredAt: new Date().toISOString() };
    expect(await t.repair([recovered], { anchored: 4, readable: 3, recovered: 1, problem: 'chain_broken' })).toEqual({ kept: 3, added: 1 });
    expect(t.health()).toMatchObject({ state: 'ok', readable: 5 });
    await expect(t.byKeyHash(hex(2))).resolves.toMatchObject({ kind: 'recovered', savedImages: 2 });
    await expect(t.byKeyHash(hex(999))).resolves.toBeNull();
    expect((await h.lines()).map(line => JSON.parse(line).kind)).toEqual(['batch', 'recipe', 'batch', 'recovered', 'repair']);
    const reopened = h.open(); await reopened.load(); expect(reopened.health().state).toBe('ok');
  });

  it('restores a deleted file from a backup that covers the anchors; an older backup is not enough; healthy records only gain the missing ones', async () => {
    const h = await filled(), t = h.open(), backup = await t.exportFiles();
    expect(backup.map(file => file.name).sort()).toEqual(['anchor-a.json', 'anchor-b.json', 'cleaned-v1.jsonl']);
    await fs.rm(h.file);
    const broken = await expectBroken(h, 'records_missing');
    expect(await broken.restore(backup)).toEqual({ status: 'restored', added: 0 });
    expect(broken.health()).toMatchObject({ state: 'ok', readable: 4 });
    await expect(broken.byKeyHash(hex(3))).resolves.toMatchObject({ keyHash: hex(3) });
    // A backup made before the last append cannot cover what the anchors say was written.
    const older = await broken.exportFiles(); await broken.append([batch(8)]); await fs.rm(h.file);
    const again = await expectBroken(h, 'records_missing');
    expect(await again.restore(older)).toEqual({ status: 'incomplete', added: 0 });
    expect(again.health().state).toBe('broken');
    // Both anchors deleted: the backup's anchors are the target.
    const h2 = await filled(), t2 = h2.open(), backup2 = await t2.exportFiles(); await fs.rm(h2.anchorA); await fs.rm(h2.anchorB);
    const b2 = await expectBroken(h2, 'anchor_missing');
    expect(await b2.restore(backup2)).toMatchObject({ status: 'restored' });
    expect(b2.health().state).toBe('ok');
    // Healthy records: a backup's unknown records are appended, nothing is taken away.
    const h3 = await store(), other = h3.open(); await other.append([batch(70)]);
    expect(await t2.restore(await other.exportFiles())).toEqual({ status: 'added', added: 1 });
    await expect(t2.byKeyHash(hex(70))).resolves.toMatchObject({ keyHash: hex(70) });
    await expect(t2.byKeyHash(hex(1))).resolves.toMatchObject({ keyHash: hex(1) });
  });
});
