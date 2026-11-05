import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
import { DEFAULT_AUGMENT_OPTIONS, DEFAULT_PARAMS } from '../src/types';
import { createManualGeneration, createManualSourceStore, manualSeeds, MANUAL_SOURCE_MAX_BYTES, parseManualRequest, readManualSourceFile } from './manual-generation';
import { runCleanups } from '../src/test-support/temp-dirs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups(cleanups.splice(0)));
const SOURCE_ID = '0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a01';
/** A source store holding one captured image under SOURCE_ID. */
function heldSources(source = { bytes: Buffer.from('source'), mimeType: 'image/png', name: 'source.png' }) {
  const take = vi.fn((id: string) => id === SOURCE_ID ? source : null);
  return { take };
}

const extras = { vibeImages: [{ base64: 'vibe-bytes', infoExtracted: 1, strength: .6 }], preciseReferences: [], charCaptions: [], historyGroupId: 'group-1', modelMode: 'anime' as const };
const request = (extra: Record<string, unknown> = {}) => ({ requestKey: 'manual-0123456789', mode: 't2i', count: 1, intervalSeconds: 0, params: { ...DEFAULT_PARAMS, positivePrompt: '{red|blue} mug', seed: 40, seedMode: 'fixed' }, extras, ...extra });
function fakeBatch() {
  const batches = new Map<string, any>();
  return {
    batches,
    enqueueManual: vi.fn(async (raw: any, options: any) => { const batch = { batchId: `b-${batches.size + 1}`, requestKey: raw.requestKey, count: raw.count, raw, options }; batches.set(raw.requestKey, batch); return batch as any; }),
    lookupManual: vi.fn((_workspace: string, key: string) => batches.get(key) ?? null),
    itemsAhead: vi.fn(() => 3),
  };
}

it('freezes the click: parameters, extras with their references, the group and (image modes) the source captured at the click', async () => {
  const batch = fakeBatch(), sources = heldSources();
  const manual = createManualGeneration({ batch, sources });
  const t2i = await manual.enqueue(request({ count: 3, intervalSeconds: 2 }));
  expect(t2i).toMatchObject({ ahead: 3, batch: { batchId: 'b-1' } });
  expect(sources.take).not.toHaveBeenCalled();
  const raw = batch.enqueueManual.mock.calls[0][0];
  expect(raw).toMatchObject({ workspaceId: 'recipe-queue', expectedRevision: 0, execution: 'queued', mode: 't2i', count: 3, intervalSeconds: 2, seeds: [40, 41, 42] });
  expect(raw.snapshot.extras).toEqual(extras);
  // {a|b} picks per image, right before it is submitted.
  const prepare = batch.enqueueManual.mock.calls[0][1].prepare;
  vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.9);
  expect([prepare(raw.snapshot, 0), prepare(raw.snapshot, 1)].map((value: any) => value.params.positivePrompt)).toEqual(['red mug', 'blue mug']);
  vi.restoreAllMocks();
  await manual.enqueue(request({ requestKey: 'manual-i2i-000000', mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, sourceId: SOURCE_ID }));
  // The source bytes travel beside the snapshot, never inside it.
  expect(batch.enqueueManual.mock.calls[1][0].snapshot).toMatchObject({ sourceName: 'source.png', i2i: { strength: .5 } });
  expect(batch.enqueueManual.mock.calls[1][0].snapshot).not.toHaveProperty('sourceImage');
  expect(batch.enqueueManual.mock.calls[1][1].source).toEqual({ bytes: Buffer.from('source'), mimeType: 'image/png' });
  await manual.enqueue(request({ requestKey: 'manual-up-0000000', mode: 'upscale', upscale: { scale: 4 }, sourceId: SOURCE_ID }));
  expect(batch.enqueueManual.mock.calls[2][0]).toMatchObject({ mode: 'upscale', seeds: [0], snapshot: { upscale: { scale: 4 } } });
  expect(Object.keys(batch.enqueueManual.mock.calls[2][1])).toEqual(['source']);
  await manual.enqueue(request({ requestKey: 'manual-dir-000000', mode: 'director', director: { tool: 'bg-removal', options: DEFAULT_AUGMENT_OPTIONS }, sourceId: SOURCE_ID }));
  expect(sources.take).toHaveBeenCalledTimes(3);
  // An image mode without a captured source, or with one no longer held, is refused before anything is queued.
  await expect(manual.enqueue(request({ requestKey: 'manual-nosrc-0000', mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 } }))).rejects.toMatchObject({ code: 'source_missing' });
  await expect(manual.enqueue(request({ requestKey: 'manual-gone-00000', mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, sourceId: '0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a02' }))).rejects.toMatchObject({ code: 'source_missing', reason: 'manual.source_expired' });
  expect(batch.enqueueManual).toHaveBeenCalledTimes(4);
});

it('the same requestKey returns its batch without taking or freezing anything again; lookup finds it or says nothing was queued', async () => {
  const batch = fakeBatch(), sources = heldSources();
  const manual = createManualGeneration({ batch, sources });
  const first = await manual.enqueue(request({ mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, sourceId: SOURCE_ID }));
  const again = await manual.enqueue(request({ mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, sourceId: SOURCE_ID }));
  expect(again.batch.batchId).toBe(first.batch.batchId);
  expect(batch.enqueueManual).toHaveBeenCalledTimes(1); expect(sources.take).toHaveBeenCalledTimes(1);
  expect(manual.lookup({ requestKey: 'manual-0123456789' }).batch?.batchId).toBe(first.batch.batchId);
  expect(manual.lookup({ requestKey: 'manual-never-queued' })).toEqual({ batch: null, ahead: 3 });
});

it('reads a click\'s source as the manual generation read its workbench: a WebP turned by its EXIF orientation, files larger than 20 MiB', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-manual-source-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  // A 64×32 WebP whose EXIF orientation 6 shows it as 32×64.
  const webp = path.join(dir, 'turned.webp');
  await fs.writeFile(webp, await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 10, b: 10 } } }).webp().withMetadata({ orientation: 6 }).toBuffer());
  const turned = await readManualSourceFile(webp);
  expect(turned).toMatchObject({ mimeType: 'image/png', name: 'turned.webp' });
  expect(await sharp(turned.bytes).metadata()).toMatchObject({ format: 'png', width: 32, height: 64 });
  // 25 MiB is read (the agent queue's 20 MiB limit is not the manual one); more than 128 MiB is refused without reading.
  const large = path.join(dir, 'large.png');
  await fs.writeFile(large, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(25 * 1024 * 1024)]));
  expect((await readManualSourceFile(large)).bytes.length).toBe(25 * 1024 * 1024 + 8);
  const huge = path.join(dir, 'huge.png');
  await fs.writeFile(huge, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); await fs.truncate(huge, MANUAL_SOURCE_MAX_BYTES + 1);
  await expect(readManualSourceFile(huge)).rejects.toMatchObject({ code: 'invalid_image', reason: 'manual.source_too_large', params: { max: 128 } });
  await expect(readManualSourceFile(path.join(dir, 'missing.png'))).rejects.toMatchObject({ code: 'source_missing', reason: 'manual.source_unreadable' });
  await expect(readManualSourceFile('relative.png')).rejects.toMatchObject({ code: 'invalid_arguments' });
  const text = path.join(dir, 'notes.txt'); await fs.writeFile(text, 'not an image');
  await expect(readManualSourceFile(text)).rejects.toMatchObject({ code: 'invalid_image', reason: 'manual.source_type' });
});

it('the source store hands a capture to one enqueue, keeps at most two and lets an abandoned one go', async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(async (file: unknown) => ({ bytes: Buffer.from(String(file)), mimeType: 'image/png', name: String(file) }));
    const store = createManualSourceStore({ read, ttlMs: 1000, max: 2 });
    const a = await store.capture('/a.png'), b = await store.capture('/b.png'), c = await store.capture('/c.png');
    expect(store.size()).toBe(2);
    expect(store.take(a.sourceId)).toBeNull();
    expect(store.take(b.sourceId)?.name).toBe('/b.png');
    expect(store.take(b.sourceId)).toBeNull();
    vi.advanceTimersByTime(1001);
    expect(store.take(c.sourceId)).toBeNull();
    expect(store.size()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('seeds as the window chose them; requests outside the manual shape are refused before anything is read', () => {
  expect(manualSeeds({ mode: 't2i', count: 3, params: { ...DEFAULT_PARAMS, seed: 0xffff_ffff, seedMode: 'fixed' } })).toEqual([0xffff_ffff, 0, 1]);
  expect(manualSeeds({ mode: 't2i', count: 2, params: { ...DEFAULT_PARAMS, seed: 7, seedMode: 'random' } }, () => 99)).toEqual([99, 99]);
  expect(manualSeeds({ mode: 'director', count: 1, params: DEFAULT_PARAMS })).toEqual([0]);
  for (const bad of [request({ requestKey: 'mcp-key' }), request({ mode: 'enhance' }), request({ count: 1000 }), request({ mode: 'upscale', count: 2, upscale: { scale: 2 }, sourceId: SOURCE_ID }), request({ intervalSeconds: 3601 }),
    request({ mode: 'upscale', upscale: { scale: 3 }, sourceId: SOURCE_ID }), request({ mode: 'inpaint', inpaint: { model: 'x', strength: 1, maskBase64: 'AA==' }, sourceId: SOURCE_ID }), request({ mode: 'i2i', i2i: { strength: .5, noise: 0, extraNoiseSeed: 0 }, sourceId: 'not-a-uuid' }), request({ extras: { vibeImages: [] } })]) expect(() => parseManualRequest(bad), JSON.stringify(bad).slice(0, 80)).toThrow();
});
