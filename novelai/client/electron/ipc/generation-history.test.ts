/**
 * The history record every generation saves passes the complete generation parameters (generatedHistoryPayload), for
 * every mode, manual and queued (execution options as generation-service passes them). Real nai.ts save path, real
 * store.addHistory (its strict check and the library put) over a real SQLite library; only NovelAI is a stub (axios
 * answers a ZIP) and the token and endpoint come from a partial store mock. Then the strict check failing: before the
 * request (refused, nothing sent) and, not expected, after it (the record is kept, with a warning). Throwaway folders.
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ base: '', post: vi.fn(), strict: [] as Array<'pass' | 'fail'>, warnings: [] as string[] }));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const nodePath = await import('node:path');
  const make = (png: any): any => ({
    isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) { const out = new PNG({ width, height }); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const sx = Math.min(png.width - 1, Math.floor(x * png.width / width)), sy = Math.min(png.height - 1, Math.floor(y * png.height / height)); png.data.copy(out.data, (y * width + x) * 4, (sy * png.width + sx) * 4, (sy * png.width + sx) * 4 + 4); } return make(out); },
  });
  return {
    app: { getPath: (key: string) => key === 'userData' ? nodePath.join(fixture.base, 'data') : nodePath.join(fixture.base, key), getVersion: () => 'test', isPackaged: false, getName: () => 'test' },
    dialog: {}, shell: {},
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`k:${value}`), decryptString: (value: Buffer) => value.toString().slice(2) },
    nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } } },
  };
});
vi.mock('axios', () => ({ default: { post: fixture.post, get: () => Promise.reject(new Error('offline test')), isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
// Only the token and the provider endpoint are replaced; addHistory, getHistoryGroups and ensureHistoryGroup are real.
vi.mock('./store', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, getToken: () => 'synthetic-test-token',
    getSettings: () => ({ ...real.getSettings(), imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: false }) };
});
// The real strict check, unless a test queues a decision: 'fail' makes that call refuse as an incomplete record would.
vi.mock('../library/validation', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, validateGeneratedHistoryPayload: (payload: unknown) => {
    if (fixture.strict.shift() === 'fail') throw Object.assign(new Error("生成历史字段无效：data/params must have required property 'qualityPreset'"), { code: 'invalid_argument' });
    return real.validateGeneratedHistoryPayload(payload);
  } };
});
vi.mock('./logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: (level: string, message: string) => { if (level === 'WARN') fixture.warnings.push(message); } }));
vi.mock('./proxy', () => ({ proxyConfig: () => ({}) }));

import { generateImage, generateI2I, inpaintImage, upscaleImg, augmentImg, setBridgeWorkbenchPath, HISTORY_PARAMS_INVALID } from './nai';
import * as store from './store';
import { openLibraryRepository } from '../library/repository';
import { activateLibrary, deactivateLibrary } from '../library-runtime';
import { DEFAULT_PARAMS, DEFAULT_AUGMENT_OPTIONS, DIRECTOR_TOOLS, normalizeInheritedGenerateParams } from '../../src/types';
import { cancelAllJobs } from './job-registry';

const square = (size: number, value = 200) => { const out = new PNG({ width: size, height: size }); for (let i = 0; i < out.data.length; i += 4) out.data.set([value, (i / 4) % 255, 90, 255], i); return PNG.sync.write(out); };
async function zip(size = 64) { const z = new JSZip(); z.file('image_0.png', square(size)); return { data: await z.generateAsync({ type: 'nodebuffer' }) }; }
let repo: ReturnType<typeof openLibraryRepository>, source = '', mask = '';
const previousDataDir = process.env.NOVELAI_DATA_DIR;
const params = { ...DEFAULT_PARAMS, positivePrompt: 'a small blue teacup on a table', width: 64, height: 64, seed: 42, seedMode: 'fixed' as const };
const chars = [{ prompt: 'a gardener', negativePrompt: '', useCoords: true, x: 0.3, y: 0.7 }];
const extras = { vibeImages: [], charCaptions: chars } as any;
const directorTools = DIRECTOR_TOOLS.map(item => item.value);

beforeAll(async () => {
  fixture.base = fss.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-generation-history-')));
  const data = path.join(fixture.base, 'data'); await fs.mkdir(data, { recursive: true });
  // The real store's default output folder is <NOVELAI_DATA_DIR>/output.
  process.env.NOVELAI_DATA_DIR = data;
  repo = openLibraryRepository({ filePath: path.join(data, 'library.sqlite'), userDataRoot: data, libraryDirectory: path.join(data, 'library') });
  activateLibrary(repo, { userDataRoot: data, libraryDirectory: path.join(data, 'library') });
  source = path.join(fixture.base, 'source.png'); await fs.writeFile(source, square(64, 30));
  const m = new PNG({ width: 64, height: 64 }); m.data.fill(0); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) m.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
  mask = PNG.sync.write(m).toString('base64');
});
afterAll(async () => {
  cancelAllJobs(); setBridgeWorkbenchPath(null); repo.close(); deactivateLibrary();
  if (previousDataDir === undefined) delete process.env.NOVELAI_DATA_DIR; else process.env.NOVELAI_DATA_DIR = previousDataDir;
  await fs.rm(fixture.base, { recursive: true, force: true });
});
beforeEach(() => { fixture.post.mockReset(); fixture.post.mockImplementation(async (url: string) => /upscale/.test(url) ? zip(128) : zip()); fixture.strict = []; fixture.warnings = []; });

/** The saved items are library history records that pass the strict check, their files exist, no journal is left. */
async function saved(label: string, result: any) {
  expect(result.ok, `${label}: ${result.message}`).toBe(true);
  const items = result.items ?? (result.item ? [result.item] : []);
  expect(items.length, label).toBeGreaterThan(0);
  for (const item of items) {
    const row = repo.get('history', item.id);
    expect(row?.payload, `${label}: history ${item.id} in the library`).toEqual(JSON.parse(JSON.stringify(item)));
    expect(fss.existsSync(item.filePath), `${label}: file`).toBe(true);
  }
  expect(repo.pendingFileOps(), `${label}: no pending file operation`).toEqual([]);
  expect(fixture.warnings, `${label}: saved without a warning`).toEqual([]);
  return items;
}
const exec = (mode: string, sourceBytes?: Buffer) => ({ singleRequest: true as const, signal: new AbortController().signal, sourceBytes, historyGroupId: '', onSubmitted: () => {},
  provenance: { jobId: randomUUID(), mode, originWorkspaceId: 'queue', submittedRevision: 0, actualSeed: ['upscale', 'director'].includes(mode) ? null : 42 },
  queueOrigin: { batchId: randomUUID(), requestKey: 'mcp-test', itemIndex: 0 } });
/** What a generation the strict check refused left: nothing sent, nothing saved, no file, no journal. */
async function refusedBeforeSending(label: string, result: any, historyBefore: number, filesBefore: string[]) {
  expect(result, label).toMatchObject({ ok: false, errorCode: HISTORY_PARAMS_INVALID, failureKind: 'validation' });
  expect(result.message, label).toMatch(/^history_params_invalid: 生成历史字段无效：.*qualityPreset.*没有发送生成请求/);
  expect(fixture.post, `${label}: no request`).not.toHaveBeenCalled();
  expect(repo.all('history'), label).toHaveLength(historyBefore);
  expect(await outputFiles(), `${label}: no file`).toEqual(filesBefore);
  expect(repo.pendingFileOps(), label).toEqual([]);
}
async function outputFiles() {
  const root = store.getSettings().outputDir, files: string[] = [];
  const walk = (dir: string) => { for (const entry of fss.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else files.push(path.relative(root, file)); } };
  if (fss.existsSync(root)) walk(root);
  return files.sort();
}

describe('every mode saves a history record that passes the complete generation parameters', () => {
  it('manual t2i, i2i, enhance-like i2i, inpaint, upscale and director (each tool)', async () => {
    const t2i = await saved('manual t2i', await generateImage(params, extras));
    expect(t2i[0]).toMatchObject({ params: { ...params, seed: 42 }, characterSnapshot: { version: 1, captions: [expect.objectContaining({ prompt: 'a gardener' })] } });
    setBridgeWorkbenchPath(source);
    await saved('manual i2i', await generateI2I(params, { strength: 0.5, noise: 0, extraNoiseSeed: 5 }, extras));
    await saved('manual enhance (i2i, low strength)', await generateI2I(params, { strength: 0.2, noise: 0.1, extraNoiseSeed: 6 }, extras));
    const inpaint = await saved('manual inpaint', await inpaintImage(params, 'nai-diffusion-5-full-inpainting', mask, 1, 0));
    expect(inpaint[0].model).toBe('nai-diffusion-5-full-inpainting');
    const upscale = await saved('manual upscale', await upscaleImg(2, params.model));
    expect(upscale[0]).toMatchObject({ model: 'upscale', actualSeed: 0, params: { positivePrompt: 'upscale' } });
    for (const tool of directorTools) await saved(`manual director ${tool}`, await augmentImg(tool, { ...DEFAULT_AUGMENT_OPTIONS, colorizePrompt: 'blue', emotion: 'happy', emotionLevel: 2 }));
    expect(directorTools).toHaveLength(6);
  });

  it('queued t2i, i2i, enhance, inpaint, upscale and director (each tool), with provenance and queueOrigin', async () => {
    const bytes = await fs.readFile(source);
    const run = async (label: string, mode: string, call: (execution: ReturnType<typeof exec>) => Promise<any>) => {
      const execution = exec(mode, bytes), result = await call(execution);
      const items = await saved(label, result.item ? { ...result, items: [result.item] } : result);
      for (const item of items) expect(item, label).toMatchObject({ generationOrigin: { jobId: execution.provenance.jobId, mode }, queueOrigin: execution.queueOrigin });
    };
    await run('queued t2i', 't2i', execution => generateImage(params, extras, undefined, { ...execution, sourceBytes: undefined }));
    await run('queued i2i', 'i2i', execution => generateI2I(params, { strength: 0.5, noise: 0, extraNoiseSeed: 5 }, extras, execution));
    await run('queued enhance', 'enhance', execution => generateI2I({ ...params, width: 128, height: 128 }, { strength: 0.35, noise: 0, extraNoiseSeed: 7 }, extras, execution));
    await run('queued inpaint', 'inpaint', execution => inpaintImage(params, 'nai-diffusion-5-full-inpainting', mask, 1, 0, execution));
    await run('queued upscale', 'upscale', execution => upscaleImg(2, params.model, execution));
    for (const tool of directorTools) await run(`queued director ${tool}`, 'director', execution => augmentImg(tool, DEFAULT_AUGMENT_OPTIONS, execution));
  });

  it('reused and other parameters: a sparse stored record restored, metadata replay, V3, Furry V3, V5 light with transparency', async () => {
    const sparse = { positivePrompt: 'from an old record', model: 'nai-diffusion-3', width: 64, height: 64 } as any;
    await saved('reuse sparse V3 params', await generateImage(normalizeInheritedGenerateParams(sparse), { vibeImages: [], charCaptions: [] } as any));
    const replay = { model: 'nai-diffusion-4-5-full', parameters: { uncond_scale: 1, dynamic_thresholding: false, cfg_sched_eligibility: 'enable' }, positive: { use_order: true } };
    const replayed = await saved('metadata replay + V4.5 + qualityPreset none', await generateImage({ ...params, model: 'nai-diffusion-4-5-full', qualityPreset: 'none', qualityToggle: false, metadataReplay: replay, preservePromptText: true } as any, extras));
    expect(replayed[0].params.metadataReplay).toMatchObject(replay);
    await saved('Furry V3 ucPreset 3', await generateImage({ ...params, model: 'nai-diffusion-furry-3', ucPreset: 3, transparentBackground: true } as any, { vibeImages: [], charCaptions: [] } as any));
    await saved('V5 light + transparent', await generateImage({ ...params, qualityPreset: 'light', transparentBackground: true } as any, extras));
    await saved('params with an unknown extra key', await generateImage({ ...params, someFutureKey: 1 } as any, extras));
  });
});

describe('the strict check failing', () => {
  it('before the request: every mode, manual and queued, is refused without sending anything', async () => {
    const bytes = await fs.readFile(source), historyBefore = repo.all('history').length, filesBefore = await outputFiles();
    setBridgeWorkbenchPath(source);
    const cases: Array<[string, () => Promise<any>]> = [
      ['manual t2i', () => generateImage(params, extras)],
      ['queued t2i', () => generateImage(params, extras, undefined, exec('t2i'))],
      ['manual i2i', () => generateI2I(params, { strength: 0.5, noise: 0, extraNoiseSeed: 5 }, extras)],
      ['queued enhance', () => generateI2I({ ...params, width: 128, height: 128 }, { strength: 0.35, noise: 0, extraNoiseSeed: 7 }, extras, exec('enhance', bytes))],
      ['manual inpaint', () => inpaintImage(params, 'nai-diffusion-5-full-inpainting', mask, 1, 0)],
      ['queued inpaint', () => inpaintImage(params, 'nai-diffusion-5-full-inpainting', mask, 1, 0, exec('inpaint', bytes))],
      ['manual upscale', () => upscaleImg(2, params.model)],
      ['queued upscale', () => upscaleImg(2, params.model, exec('upscale', bytes))],
      ['manual director', () => augmentImg('lineart', DEFAULT_AUGMENT_OPTIONS)],
      ['queued director', () => augmentImg('emotion', { ...DEFAULT_AUGMENT_OPTIONS, emotion: 'happy', emotionLevel: 2 }, exec('director', bytes))],
    ];
    for (const [label, call] of cases) {
      fixture.strict = ['fail'];
      await refusedBeforeSending(label, await call(), historyBefore, filesBefore);
      expect(fixture.strict, `${label}: checked once, before the request`).toEqual([]);
    }
  });

  it('before the request, with the real schema: a queued record whose provenance names no generation mode', async () => {
    const historyBefore = repo.all('history').length, filesBefore = await outputFiles(), execution = exec('t2i');
    const result = await generateImage(params, extras, undefined, { ...execution, provenance: { ...execution.provenance, mode: 'not-a-mode' as any } });
    expect(result).toMatchObject({ ok: false, errorCode: HISTORY_PARAMS_INVALID });
    expect(result.message).toMatch(/generationOrigin\/mode/);
    expect(fixture.post).not.toHaveBeenCalled();
    expect(repo.all('history')).toHaveLength(historyBefore);
    expect(await outputFiles()).toEqual(filesBefore);
  });

  it('after the request (not expected): the paid image keeps its record and queue link, with a warning in the log', async () => {
    const bytes = await fs.readFile(source);
    setBridgeWorkbenchPath(source);
    const cases: Array<[string, string, (execution?: ReturnType<typeof exec>) => Promise<any>]> = [
      ['t2i', 't2i', execution => generateImage(params, extras, undefined, execution && { ...execution, sourceBytes: undefined })],
      ['inpaint', 'inpaint', execution => inpaintImage(params, 'nai-diffusion-5-full-inpainting', mask, 1, 0, execution)],
      ['upscale', 'upscale', execution => upscaleImg(2, params.model, execution)],
      ['director', 'director', execution => augmentImg('declutter', DEFAULT_AUGMENT_OPTIONS, execution)],
    ];
    for (const [label, mode, call] of cases) for (const queued of [false, true]) {
      const name = `${queued ? 'queued' : 'manual'} ${label}`, execution = queued ? exec(mode, bytes) : undefined;
      fixture.post.mockClear(); fixture.warnings = [];
      fixture.strict = ['pass', 'fail'];
      const result = await call(execution);
      expect(result.ok, `${name}: ${result.message}`).toBe(true);
      expect(fixture.post, name).toHaveBeenCalledTimes(1);
      const items = result.items ?? [result.item];
      for (const item of items) {
        expect(repo.get('history', item.id)?.payload, `${name}: the record is saved`).toEqual(JSON.parse(JSON.stringify(item)));
        expect(fss.existsSync(item.filePath), name).toBe(true);
        if (execution) expect(item, name).toMatchObject({ queueOrigin: execution.queueOrigin, generationOrigin: { jobId: execution.provenance.jobId } });
      }
      expect(repo.pendingFileOps(), name).toEqual([]);
      expect(fixture.warnings, name).toEqual([expect.stringMatching(new RegExp(`已按存储格式保存.*${items[0].id}.*qualityPreset`))]);
    }
  });
});
