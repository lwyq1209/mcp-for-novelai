import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import ts from 'typescript';
import sharp from 'sharp';
import { createImageStudyService, IMAGE_STUDY_LIMITS } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { waitUntil } from '../src/test-support/wait-until';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); await runCleanups(cleanup.splice(0).reverse()); });
/** The studies folder of a throwaway data root (its library file is beside the folder). */
async function root() { const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-studies-')); cleanup.push(() => fs.rm(parent, { recursive: true, force: true })); const directory = path.join(parent, 'studies'); await fs.mkdir(directory); return directory; }
const picture = (background = '#70b090') => sharp({ create: { width: 6, height: 4, channels: 3, background } }).png().toBuffer();
/** Every call is another connection to the library of this studies folder (a restart). */
const library = (directory: string): LibraryRepository => { const repository = openLibraryRepository({ filePath: `${directory}.library.sqlite`, libraryDirectory: path.dirname(directory) }); cleanup.push(() => repository.close()); return repository; };
const make = (directory: string, extra: Parameters<typeof createImageStudyService>[0] extends infer O ? Partial<O> : never = {}) => { const service = createImageStudyService({ directory, repository: library(directory), parse: parseImageStudy, ...extra }); cleanup.push(() => service.dispose()); return service; };
async function imported(service: ReturnType<typeof createImageStudyService>, background?: string) { const bytes = await picture(background); return { bytes, ...(await service.material_studies({ action: 'import', name: 'garden.png', data: bytes.toString('base64'), sourceUrl: 'https://discord.com/channels/1/2/3', sourceAuthor: 'Community author' })) }; }

describe('image studies independent persistence', () => {
  it('reopens exact originals and previews without parser calls, keeps summaries compact', async () => {
    const directory = await root(), first = make(directory), saved = await imported(first);
    const before = await first.material_studies({ action: 'image', id: saved.study.id }); first.dispose();
    const parser = vi.fn(async () => { throw new Error('Offline parser must not run'); }), second = make(directory, { parse: parser });
    const original = await second.material_studies({ action: 'original', id: saved.study.id });
    expect(Buffer.from(original.data, 'base64')).toEqual(saved.bytes); expect(original.sha256).toBe(createHash('sha256').update(saved.bytes).digest('hex'));
    expect(await second.material_studies({ action: 'image', id: saved.study.id })).toEqual(before);
    const list = await second.material_studies({ action: 'list' });
    expect(list.total).toBe(1); expect(list.items[0]).not.toHaveProperty('data'); expect(JSON.stringify(list)).not.toContain(saved.bytes.toString('base64'));
    expect(await second.material_studies({ action: 'read', id: saved.study.id })).toEqual({ study: saved.study, section: 'summary' });
    expect(await second.material_studies({ action: 'read', id: saved.study.id, section: 'raw' })).toEqual({ study: saved.study, section: 'raw', raw: {} });
    expect(parser).not.toHaveBeenCalled();
  });
  it('deduplicates exact bytes without replacing notes, source or original filename', async () => {
    const directory = await root(), service = make(directory), saved = await imported(service);
    const changed = await service.material_studies({ action: 'update', id: saved.study.id, expectedRevision: 1, patch: { name: '水彩观察', notes: 'soft light', sourceAuthor: 'Original credit' } });
    const again = await service.material_studies({ action: 'import', name: 'replacement.jpg', data: saved.bytes.toString('base64'), sourceAuthor: 'Changed credit' });
    expect(again).toEqual({ study: changed.study, duplicate: true });
    expect((await service.material_studies({ action: 'read', id: saved.study.id, section: 'notes' })).notes).toBe('soft light');
    expect((await service.material_studies({ action: 'original', id: saved.study.id })).name).toBe('garden.png');
    expect((await service.material_studies({ action: 'list', query: 'soft light' })).items).toHaveLength(1);
  });
  it('reads original prompt sections on demand without putting text in summaries', async () => {
    const service = make(await root());
    const originalText = 'a ceramic mug, watercolor\nNegative prompt: watermark\nSteps: 24, Sampler: Euler a, Seed: 42';
    const bytes = await sharp(await picture()).jpeg().withExif({ IFD0: { ImageDescription: originalText } }).toBuffer();
    const { study } = await service.material_studies({ action: 'import', name: 'reference.jpeg', data: bytes.toString('base64') });
    const summary = await service.material_studies({ action: 'read', id: study.id }); expect(JSON.stringify(summary)).not.toContain('watercolor');
    const prompts = await service.material_studies({ action: 'read', id: study.id, section: 'prompts' }); expect(prompts.fields.find((field: any) => field.key.endsWith('.positive')).value).toBe('a ceramic mug, watercolor');
    const raw = await service.material_studies({ action: 'read', id: study.id, section: 'raw' }); expect(raw.raw.exif.ImageDescription).toBe(originalText);
    const parameters = await service.material_studies({ action: 'read', id: study.id, section: 'parameters' }); expect(parameters.fields.some((field: any) => field.key.endsWith('.Seed') && field.value === '42')).toBe(true);
  });
  it('serializes content updates with CAS and preserves unrelated fields', async () => {
    const service = make(await root()), saved = await imported(service);
    const results = await Promise.allSettled(['first', 'second'].map(notes => service.material_studies({ action: 'update', id: saved.study.id, expectedRevision: 1, patch: { notes } })));
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const next = await service.material_studies({ action: 'update', id: saved.study.id, expectedRevision: 2, patch: { archived: true } });
    expect(next.study.sourceAuthor).toBe('Community author'); expect(next.study.revision).toBe(3);
    expect((await service.material_studies({ action: 'list' })).total).toBe(0);
    expect((await service.material_studies({ action: 'list', includeArchived: true })).total).toBe(1);
  });
  it('does not publish half entries or overwrite prior records on write failure', async () => {
    const directory = await root(), repository = library(directory), service = make(directory, { repository }), saved = await imported(service), before = repository.get('study', saved.study.id);
    const real = fs.rename;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (String(to).startsWith(directory + path.sep)) throw Object.assign(new Error('Fixture disk failure'), { code: 'EIO' }); return real(from, to); });
    await expect(imported(service, '#ffffff')).rejects.toMatchObject({ code: 'EIO' });
    vi.spyOn(repository, 'put').mockImplementation(() => { throw Object.assign(new Error('Fixture disk failure'), { code: 'EIO' }); });
    await expect(service.material_studies({ action: 'update', id: saved.study.id, expectedRevision: 1, patch: { notes: 'failed change' } })).rejects.toMatchObject({ code: 'EIO' });
    expect(repository.get('study', saved.study.id)).toEqual(before); expect(await fs.readdir(directory)).toEqual([saved.study.id]);
    expect((await service.material_studies({ action: 'list' })).total).toBe(1);
  });
  it('counts capacity before publishing and does not charge duplicates twice', async () => {
    const directory = await root(), service = make(directory), saved = await imported(service), maximum = IMAGE_STUDY_LIMITS.totalBytes;
    IMAGE_STUDY_LIMITS.totalBytes = 1; cleanup.push(() => { IMAGE_STUDY_LIMITS.totalBytes = maximum; });
    expect((await service.material_studies({ action: 'import', name: 'duplicate', data: saved.bytes.toString('base64') })).duplicate).toBe(true);
    await expect(imported(service, '#ffffff')).rejects.toMatchObject({ code: 'study_storage_full' });
    expect((await service.material_studies({ action: 'list' })).total).toBe(1);
  });
  it('validates image digests and keeps the record readable when its original is damaged', async () => {
    const directory = await root(), service = make(directory), first = await imported(service), second = await imported(service, '#ffffff');
    // The record and its sections are in the library; the folder holds only the original and its preview.
    expect((await fs.readdir(path.join(directory, first.study.id))).sort()).toEqual(['original.png', 'preview.webp']);
    const imageFile = path.join(directory, second.study.id, 'original.png'), damaged = Buffer.from(second.bytes); damaged[damaged.length - 1] ^= 1; await fs.writeFile(imageFile, damaged);
    await expect(service.material_studies({ action: 'original', id: second.study.id })).rejects.toMatchObject({ code: 'study_corrupt' });
    expect((await service.material_studies({ action: 'read', id: second.study.id })).study.id).toBe(second.study.id);
  });
  it('rejects arbitrary paths, unrecognized fields, symlinks and credentialed links', async () => {
    const directory = await root(), service = make(directory), saved = await imported(service);
    await expect(service.material_studies({ action: 'image', id: '../outside' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.material_studies({ action: 'read', id: saved.study.id, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.material_studies({ action: 'import', name: 'x', data: saved.bytes.toString('base64'), sourceUrl: 'https://user:password@example.com/' })).rejects.toMatchObject({ code: 'invalid_argument' });
    const original = path.join(directory, saved.study.id, 'original.png'); await fs.unlink(original); await fs.symlink(path.join(directory, saved.study.id, 'preview.webp'), original);
    await expect(service.material_studies({ action: 'original', id: saved.study.id })).rejects.toBeTruthy();
  });
  it('bounds parser concurrency and concurrent duplicate publication', async () => {
    const directory = await root(), bytes = await picture(); let active = 0, maximum = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const parse = vi.fn(async (input: Buffer) => { active++; maximum = Math.max(maximum, active); await gate; const result = await parseImageStudy(input); active--; return result; });
    const service = make(directory, { parse });
    const work = Array.from({ length: 3 }, () => service.material_studies({ action: 'import', name: 'same.png', data: bytes.toString('base64') }));
    await waitUntil(() => expect(parse).toHaveBeenCalledTimes(2)); release();
    const results = await Promise.all(work); expect(maximum).toBe(2); expect(results.filter(value => !value.duplicate)).toHaveLength(1); expect(new Set(results.map(value => value.study.id)).size).toBe(1);
  });
});

async function compiledWorker(directory: string) {
  const root = process.cwd(), files = ['electron/image-study-worker.ts', 'electron/image-study-parser.ts', 'electron/host-error.ts', 'src/png-meta.ts', 'src/types.ts', 'src/metadata-replay.ts', 'src/nai-dimensions.ts'];
  for (const source of files) {
    const output = path.join(directory, source.replace(/\.ts$/, '.js')); await fs.mkdir(path.dirname(output), { recursive: true });
    const compiled = ts.transpileModule(await fs.readFile(path.join(root, source), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
    await fs.writeFile(output, compiled.outputText);
  }
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"test"}'); await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  return path.join(directory, 'electron/image-study-worker.js');
}
describe('actual isolated study workers', () => {
  it('runs the actual parser in a compiled worker and saves its verified original', async () => {
    const directory = await root(), workerPath = await compiledWorker(path.join(directory, 'worker'));
    const service = make(path.join(directory, 'library'), { parse: undefined, workerPath }), saved = await imported(service);
    expect(saved.study.metadataStatus).toBe('missing'); expect(saved.study.width).toBe(6);
    expect(Buffer.from((await service.material_studies({ action: 'original', id: saved.study.id })).data, 'base64')).toEqual(saved.bytes);
  });
  it('terminates real hung workers before releasing their slots and never publishes their records', async () => {
    const directory = await root(), workerPath = path.join(directory, 'hung-worker.cjs'), log = path.join(directory, 'starts.txt'), heartbeat = path.join(directory, 'heartbeat.txt');
    await fs.writeFile(workerPath, `const fs=require('node:fs'); fs.appendFileSync(${JSON.stringify(log)},Date.now()+'\\n'); setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'x'),10);`);
    const previous = IMAGE_STUDY_LIMITS.timeoutMs; IMAGE_STUDY_LIMITS.timeoutMs = 180; cleanup.push(() => { IMAGE_STUDY_LIMITS.timeoutMs = previous; });
    const service = make(path.join(directory, 'library'), { parse: undefined, workerPath }), bytes = await picture(), settled: number[] = [];
    const outcomes = await Promise.all(Array.from({ length: 3 }, () => service.material_studies({ action: 'import', name: 'hung.png', data: bytes.toString('base64') }).then(() => 'unexpected', error => { settled.push(Date.now()); return error.code; })));
    expect(outcomes).toEqual(['study_parse_timeout', 'study_parse_timeout', 'study_parse_timeout']);
    const starts = (await fs.readFile(log, 'utf8')).trim().split('\n').map(Number); expect(starts).toHaveLength(3); expect(starts[2]).toBeGreaterThanOrEqual(settled[0]);
    const finalHeartbeat = await fs.readFile(heartbeat, 'utf8'); await wait(60); expect(await fs.readFile(heartbeat, 'utf8')).toBe(finalHeartbeat);
    expect((await service.material_studies({ action: 'list' })).total).toBe(0);
  });
  it('reports a real worker crash without publishing an empty successful study', async () => {
    const directory = await root(), workerPath = path.join(directory, 'broken-worker.cjs'); await fs.writeFile(workerPath, 'throw new Error("fixture crash")');
    const service = make(path.join(directory, 'library'), { parse: undefined, workerPath });
    await expect(imported(service)).rejects.toMatchObject({ code: 'study_parse_failed' });
    expect((await service.material_studies({ action: 'list' })).total).toBe(0);
  });
});
