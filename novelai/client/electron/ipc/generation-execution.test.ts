import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../../src/test-support/temp-dirs';
const fixture = vi.hoisted(() => ({ outputDir: '', keepImageMetadata: true, generationGroupId: '', groups: [] as Array<{ id: string; name: string; createdAt: string }>, getToken: vi.fn(() => 'synthetic-test-token'), post: vi.fn(), addHistory: vi.fn() }));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const wrap = (buffer: Buffer): any => {
    let png: PNG; try { png = PNG.sync.read(buffer); } catch { return { isEmpty: () => true }; }
    return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
      resize: ({ width, height }: { width: number; height: number }) => {
        const out = new PNG({ width, height });
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const src = (Math.min(png.height - 1, Math.floor(y * png.height / height)) * png.width + Math.min(png.width - 1, Math.floor(x * png.width / width))) * 4;
          png.data.copy(out.data, (y * width + x) * 4, src, src + 4);
        }
        return wrap(PNG.sync.write(out));
      },
    };
  };
  return { app: { getPath: () => fixture.outputDir }, dialog: {}, nativeImage: { createFromBuffer: wrap } };
});
vi.mock('axios', () => ({ default: { post: fixture.post, isCancel: (error: any) => error?.code === 'ERR_CANCELED' } }));
vi.mock('./store', () => ({
  getToken: fixture.getToken,
  getSettings: () => ({ imageBaseUrl: 'https://generation-fixture.example.test', allowCustomEndpoint: true, allowCustomEndpointFallback: true, streamPreviewEnabled: true, outputDir: fixture.outputDir, generationGroupId: fixture.generationGroupId, keepImageMetadata: fixture.keepImageMetadata, imageNameTemplate: '{date}_{seed}_{seq}' }),
  getHistoryGroups: () => fixture.groups, getAccountSummary: () => ({ hasToken: true }), addHistory: fixture.addHistory,
  ensureHistoryGroup: vi.fn(() => ({ id: 'fixture-group', name: 'Fixture', createdAt: '2026-09-20' })), setAccountSummary: vi.fn(), setToken: vi.fn(), updateHistoryItem: vi.fn(),
}));
vi.mock('./logger', () => ({ logError: vi.fn(), logInfo: vi.fn(), appendLog: vi.fn() }));
vi.mock('./proxy', () => ({ proxyConfig: () => ({}) }));
import { generateImage, generateI2I, inpaintImage, upscaleImg, augmentImg, setBridgeWorkbenchPath } from './nai';
import { cancelAllJobs, hasActiveGenerationJobs } from './job-registry';
import { DEFAULT_PARAMS, DEFAULT_AUGMENT_OPTIONS, DIRECTOR_TOOLS } from '../../src/types';
import { waitUntil } from '../../src/test-support/wait-until';

const png = new PNG({ width: 64, height: 64 }); png.data.fill(255); png.data[0] = 20;
const IMAGE = PNG.sync.write(png);
const params = { ...DEFAULT_PARAMS, positivePrompt: 'a small blue teacup on a table', width: 64, height: 64, seed: 42, seedMode: 'fixed' as const };
const extras = { vibeImages: [], charCaptions: [] };
const options = (sourceBytes?: Buffer) => ({ singleRequest: true as const, signal: new AbortController().signal, sourceBytes, onSubmitted: vi.fn() });
async function archive() { const zip = new JSZip(); zip.file('image_0.png', IMAGE); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; }
beforeEach(async () => { fixture.outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-execution-test-')); fixture.keepImageMetadata = true; fixture.generationGroupId = ''; fixture.groups = []; fixture.getToken.mockClear(); fixture.post.mockReset(); fixture.addHistory.mockReset(); fixture.addHistory.mockReturnValue([]); });
afterEach(() => runCleanups([() => vi.unstubAllEnvs(), () => setBridgeWorkbenchPath(null), () => cancelAllJobs(), () => fs.rm(fixture.outputDir, { recursive: true, force: true })]));

describe('Queue generation policy through the real NovelAI generation functions', () => {
  it.each([0, 2, '1', null, false, undefined])('rejects an explicit invalid assembly marker before credentials, provider work or history (%s)', async (value) => {
    const invalid = { ...params, promptAssemblyVersion: value } as any;
    const requests = [
      () => generateImage(invalid, extras, undefined, options()),
      () => generateI2I(invalid, { strength: 0.5, noise: 0, extraNoiseSeed: 42 }, extras, options(IMAGE)),
      () => inpaintImage(invalid, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, options(IMAGE)),
    ];
    for (const execute of requests) {
      await expect(execute()).resolves.toMatchObject({ ok: false, message: expect.stringContaining('invalid_argument'), failureKind: 'validation', statusCode: 422, items: [] });
    }
    expect(fixture.getToken).not.toHaveBeenCalled();
    expect(fixture.post).not.toHaveBeenCalled();
    expect(fixture.addHistory).not.toHaveBeenCalled();
  });

  it('uses exactly one ZIP generation POST even when streamed previews and custom fallback are enabled', async () => {
    fixture.post.mockResolvedValueOnce(await archive());
    const execution = options(); const preview = vi.fn();
    const result = await generateImage(params, extras, { onPreview: preview }, execution);
    expect(result.ok).toBe(true); expect(fixture.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = fixture.post.mock.calls[0];
    expect(url).toBe('https://generation-fixture.example.test/ai/generate-image');
    expect(body).toMatchObject({ model: params.model, parameters: { n_samples: 1, seed: 42 } });
    expect(config).toMatchObject({ maxRedirects: 0, responseType: 'arraybuffer' });
    expect(preview).not.toHaveBeenCalled(); expect(execution.onSubmitted).toHaveBeenCalledTimes(1);
    expect(fixture.addHistory).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(result.items[0].filePath)).toEqual(IMAGE);
  });

  it('never retries 429, gateway errors, preflight network failures, or a custom endpoint auth failure', async () => {
    const errors = [
      { response: { status: 429, data: 'rate limited', headers: { 'retry-after': '0.001' } } },
      { response: { status: 500, data: 'gateway failure' } },
      { code: 'ENOTFOUND', message: 'fixture DNS failure' },
      { response: { status: 401, data: 'fixture auth rejection' } },
    ];
    for (const error of errors) {
      fixture.post.mockReset().mockRejectedValueOnce(error);
      expect((await generateImage(params, extras, undefined, options())).ok).toBe(false);
      expect(fixture.post).toHaveBeenCalledTimes(1);
    }
    expect(fixture.addHistory).not.toHaveBeenCalled();
  });

  it('reads a JSON error body: HTTP 402 names a refused charge with the provider message, not the raw JSON (step 4b2)', async () => {
    const body = Buffer.from(JSON.stringify({ statusCode: 402, message: 'An active subscription is required to access this endpoint.' }));
    fixture.post.mockRejectedValueOnce({ response: { status: 402, data: body } });
    const refused = await generateImage(params, extras, undefined, options());
    expect(refused).toMatchObject({ ok: false, statusCode: 402, reason: 'generation.payment_required', params: { status: 402, detail: 'An active subscription is required to access this endpoint.' } });
    expect(refused.message).not.toContain('{');
    fixture.post.mockRejectedValueOnce({ response: { status: 400, data: Buffer.from(JSON.stringify({ statusCode: 400, message: 'Prompt too long.' })) } });
    const invalid = await generateImage(params, extras, undefined, options());
    expect(invalid).toMatchObject({ ok: false, reason: 'generation.failed_t2i', params: { detail: 'Prompt too long.' } });
    expect(fixture.post).toHaveBeenCalledTimes(2);
  });

  it('names NovelAI\'s own answer (cleaned) as upstream, and an unavailable service or an error page by reason (step 4c1)', async () => {
    fixture.post.mockRejectedValueOnce({ response: { status: 400, data: Buffer.from(JSON.stringify({ statusCode: 400, message: 'Prompt rejected (token pst-AbCdEf0123456789xyz, /Users/me/a.png)' })) } });
    const rejected = await generateImage(params, extras, undefined, options());
    expect(rejected).toMatchObject({ ok: false, statusCode: 400, reason: 'generation.failed_t2i', upstream: { status: 400, message: 'Prompt rejected (token …, …)' } });
    // The failure text the canvas shows (message and its detail) is NovelAI's answer cleaned the same way (review rework).
    expect(rejected.message).toBe('Image generation failed (HTTP 400): Prompt rejected (token …, …)');
    expect(rejected.params).toMatchObject({ detail: 'Prompt rejected (token …, …)' });
    fixture.post.mockRejectedValueOnce({ response: { status: 400, data: 'denied for /data/users/alice/x.png, Authorization: Basic YWxpY2U6aHVudGVyMg== \u2066x\u2069' } });
    const forged = await generateImage(params, extras, undefined, options());
    expect(forged).toMatchObject({ message: 'Image generation failed (HTTP 400): denied for …, Authorization: … x', params: { detail: 'denied for …, Authorization: … x' }, upstream: { message: 'denied for …, Authorization: … x' } });
    fixture.post.mockRejectedValueOnce({ response: { status: 502, data: '<!doctype html><html><body>Bad gateway</body></html>' } });
    const gateway = await generateImage(params, extras, undefined, options());
    expect(gateway).toMatchObject({ ok: false, reason: 'remote.unavailable', params: { status: 502, statusText: ' Bad Gateway' }, upstream: { status: 502, reason: 'remote.unavailable' } });
    expect(gateway.message).not.toMatch(/[\u4e00-\u9fff]/);
    // A failure without an HTTP answer has no upstream.
    fixture.post.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const dropped = await generateImage(params, extras, undefined, options());
    expect(dropped).not.toHaveProperty('upstream');
  });

  it('does not send a second pipe-caption POST after structured captions are rejected', async () => {
    fixture.post.mockRejectedValueOnce({ response: { status: 422, data: 'unsupported caption' } });
    const result = await generateImage(params, { ...extras, charCaptions: [{ prompt: 'a gardener', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }] }, undefined, options());
    expect(result.ok).toBe(false); expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(fixture.post.mock.calls[0][1].parameters.v4_prompt.caption.char_captions).toHaveLength(1);
  });

  it('rejects Vibe and Precise references before any generation or encode POST', async () => {
    for (const refs of [{ vibeImages: [{ base64: IMAGE.toString('base64'), strength: 1, infoExtracted: 1 }] }, { preciseReferences: [{ base64: IMAGE.toString('base64'), type: 'character', strength: 1, fidelity: 1 }] }]) {
      await expect(generateImage(params, { ...extras, ...refs } as any, undefined, options())).rejects.toMatchObject({ code: 'unsupported_reference' });
    }
    expect(fixture.post).not.toHaveBeenCalled();
  });

  it('uses frozen img2img bytes even when the global workbench points to a different nonexistent image', async () => {
    setBridgeWorkbenchPath('/private/never-read-this-image.png');
    fixture.post.mockResolvedValueOnce(await archive());
    const result = await generateI2I(params, { strength: 0.45, noise: 0, extraNoiseSeed: 567 }, extras, options(IMAGE));
    expect(result.ok).toBe(true); expect(fixture.post).toHaveBeenCalledTimes(1);
    const payload = fixture.post.mock.calls[0][1];
    expect(payload.action).toBe('img2img');
    expect(payload.parameters.extra_noise_seed).toBe(567);
    expect(PNG.sync.read(Buffer.from(payload.parameters.image, 'base64')).data).toEqual(png.data);
  });

  it('uses the exact inpaint model once and never falls back after model compatibility rejection', async () => {
    setBridgeWorkbenchPath('/private/never-read-this-mask-source.png');
    fixture.post.mockRejectedValueOnce({ response: { status: 400, data: 'Unknown model: nai-diffusion-5-full-inpainting' } });
    const result = await inpaintImage(params, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, options(IMAGE));
    expect(result.ok).toBe(false); expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(fixture.post.mock.calls[0][1]).toMatchObject({ model: 'nai-diffusion-5-full-inpainting', action: 'infill', parameters: { n_samples: 1 } });
  });

  it('links the particular queue AbortSignal without allowing the manual stop control to cancel it', async () => {
    fixture.post.mockImplementationOnce((_url, _body, config) => new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true })));
    const controller = new AbortController();
    const result = generateImage(params, extras, undefined, { singleRequest: true, signal: controller.signal });
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    expect(cancelAllJobs()).toBe(false); expect(fixture.post.mock.calls[0][2].signal.aborted).toBe(false);
    controller.abort(); expect((await result).failureKind).toBe('cancelled');
    expect(hasActiveGenerationJobs()).toBe(false);
  });

  it.each(['t2i', 'i2i', 'inpaint'] as const)('keeps the frozen %s destination when the current group changes during generation', async mode => {
    fixture.groups = [{ id: 'original', name: 'OriginalStudies', createdAt: '2026-09-10' }, { id: 'later', name: 'LaterStudies', createdAt: '2026-09-10' }];
    fixture.generationGroupId = 'original';
    fixture.post.mockImplementationOnce(async () => {
      fixture.generationGroupId = 'later';
      fixture.groups[0].name = 'RenamedAfterSubmit';
      return archive();
    });
    const execution = { ...options(IMAGE), historyGroupId: 'original' };
    const result = mode === 't2i' ? await generateImage(params, extras, undefined, execution)
      : mode === 'i2i' ? await generateI2I(params, { strength: 0.5, noise: 0, extraNoiseSeed: 42 }, extras, execution)
      : await inpaintImage(params, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, execution);
    expect(result.ok).toBe(true);
    expect(result.items[0].groupId).toBe('original');
    expect(result.items[0].filePath).toContain(`${path.sep}OriginalStudies${path.sep}`);
    expect(result.items[0].filePath).not.toMatch(/LaterStudies|RenamedAfterSubmit/);
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });

  it.each(['t2i', 'i2i', 'inpaint'] as const)('keeps explicitly ungrouped %s results out of a later active group', async mode => {
    fixture.groups = [{ id: 'later', name: 'LaterStudies', createdAt: '2026-09-10' }];
    fixture.generationGroupId = 'later';
    fixture.post.mockResolvedValueOnce(await archive());
    const execution = { ...options(IMAGE), historyGroupId: '' };
    const result = mode === 't2i' ? await generateImage(params, extras, undefined, execution)
      : mode === 'i2i' ? await generateI2I(params, { strength: 0.5, noise: 0, extraNoiseSeed: 42 }, extras, execution)
      : await inpaintImage(params, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, execution);
    expect(result.ok).toBe(true); expect(result.items[0].groupId).toBeUndefined();
    expect(result.items[0].filePath).not.toContain('LaterStudies');
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });
});


describe('Queue postprocessing through the existing paid execution functions', () => {
  it('uses the frozen Upscale image once, records actual output dimensions and freezes its destination', async () => {
    setBridgeWorkbenchPath('/private/not-the-submitted-source.png');
    fixture.groups = [{ id: 'old', name: 'Original', createdAt: '2026-09-10' }, { id: 'new', name: 'Changed', createdAt: '2026-09-10' }];
    fixture.generationGroupId = 'old';
    const output = new PNG({ width: 128, height: 128 }); output.data.fill(255);
    fixture.post.mockImplementationOnce(async () => {
      fixture.generationGroupId = 'new'; fixture.groups[0].name = 'Renamed';
      const zip = new JSZip(); zip.file('upscaled.png', PNG.sync.write(output)); return { data: await zip.generateAsync({ type: 'nodebuffer' }) };
    });
    const execution = { ...options(IMAGE), historyGroupId: 'old' };
    const result = await upscaleImg(2, params.model, execution);
    expect(result.ok).toBe(true); expect(fixture.post).toHaveBeenCalledTimes(1);
    const [url, payload, config] = fixture.post.mock.calls[0];
    expect(url).toMatch(/\/ai\/upscale$/);
    expect(Object.keys(payload).sort()).toEqual(['declared_blur_sigma', 'image', 'model']);
    expect(payload).toMatchObject({ model: 'nai-diffusion-5-curated', declared_blur_sigma: 0 });
    expect(PNG.sync.read(Buffer.from(payload.image, 'base64')).data).toEqual(png.data);
    expect(config.maxRedirects).toBe(0); expect(execution.onSubmitted).toHaveBeenCalledTimes(1);
    expect(result.item).toMatchObject({ width: 128, height: 128, groupId: 'old', model: 'nai-diffusion-5-curated' });
    expect(result.item!.filePath).toContain(`${path.sep}Original${path.sep}`);
    expect(PNG.sync.read(await fs.readFile(result.item!.filePath)).width).toBe(128);
  });

  it.each(['t2i', 'i2i', 'inpaint', 'upscale', 'director'] as const)('saves a queued %s image into the frozen group with the frozen prefix and queue origin; the history params stay as they were (issue #1)', async mode => {
    fixture.groups = [{ id: 'g1', name: 'sketchbook6', createdAt: '2026-10-14' }];
    const square = (size: number) => { const out = new PNG({ width: size, height: size }); out.data.fill(255); return out; };
    const mask = square(64); mask.data.fill(0); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) mask.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
    fixture.post.mockImplementation(async () => { const zip = new JSZip(); zip.file('image_0.png', PNG.sync.write(square(mode === 'upscale' ? 128 : 64))); return { data: await zip.generateAsync({ type: 'nodebuffer' }) }; });
    const queueOrigin = { batchId: 'abcdef01-2345-6789-abcd-ef0123456789', requestKey: 'mcp-key', itemIndex: 2 };
    const run = (execution: ReturnType<typeof options> & Record<string, unknown>) => mode === 't2i' ? generateImage({ ...params, fileNamePrefix: 'canvas' }, extras, undefined, execution)
      : mode === 'i2i' ? generateI2I({ ...params, fileNamePrefix: 'canvas' }, { strength: 0.5, noise: 0, extraNoiseSeed: 5 }, extras, execution)
      : mode === 'inpaint' ? inpaintImage({ ...params, fileNamePrefix: 'canvas' }, 'nai-diffusion-5-full-inpainting', PNG.sync.write(mask).toString('base64'), 1, 0, execution)
      : mode === 'upscale' ? upscaleImg(2, params.model, execution).then(result => ({ ...result, items: result.item ? [result.item] : [] }))
      : augmentImg('lineart', DEFAULT_AUGMENT_OPTIONS, execution);
    const queued: any = await run({ ...options(IMAGE), historyGroupId: 'g1', fileNamePrefix: 'proj', queueOrigin });
    expect(queued.ok, queued.message).toBe(true);
    const item = queued.items[0];
    expect(path.basename(path.dirname(item.filePath))).toBe('sketchbook6'); expect(item.groupId).toBe('g1');
    expect(path.basename(item.filePath)).toMatch(/^proj_\d{4}-\d{2}-\d{2}_/);
    expect(item.queueOrigin).toEqual(queueOrigin);
    expect(item.params.fileNamePrefix).toBe(['upscale', 'director'].includes(mode) ? '' : 'canvas');
    // Without the queue fields nothing changes: a canvas prefix still names seeded images, postprocess stays unprefixed.
    const plain: any = await run(options(IMAGE));
    expect(plain.ok, plain.message).toBe(true);
    expect(path.basename(plain.items[0].filePath)).toMatch(['upscale', 'director'].includes(mode) ? /^\d{4}-\d{2}-\d{2}_/ : /^canvas_/);
    expect(plain.items[0]).not.toHaveProperty('queueOrigin'); expect(plain.items[0].groupId).toBeUndefined();
  });

  it('rejects a queued 4× locally and preserves provider failure classification with no retry or fallback', async () => {
    expect((await upscaleImg(4, params.model, options(IMAGE))).ok).toBe(false);
    expect(fixture.post).not.toHaveBeenCalled();
    for (const status of [429, 500, 401]) {
      fixture.post.mockReset().mockRejectedValueOnce({ response: { status, data: 'synthetic rejection', headers: { 'retry-after': '0.001' } } });
      const result = await upscaleImg(2, params.model, options(IMAGE));
      expect(result).toMatchObject({ ok: false, statusCode: status });
      expect(fixture.post).toHaveBeenCalledTimes(1);
    }
    expect(fixture.addHistory).not.toHaveBeenCalled();
  });

  it.each(DIRECTOR_TOOLS.map(item => item.value))('sends %s as one exact Director operation, without generation prompt or seed', async tool => {
    setBridgeWorkbenchPath('/private/never-read-director-source.png');
    const alpha = PNG.sync.read(IMAGE); alpha.data[3] = 0;
    fixture.post.mockResolvedValueOnce(await archive());
    const opts = { ...DEFAULT_AUGMENT_OPTIONS, defry: 2, colorizePrompt: 'blue ceramic teacup', emotion: 'happy' as const, emotionLevel: 3 };
    const execution = options(PNG.sync.write(alpha));
    const result = await augmentImg(tool, opts, execution);
    expect(result.ok).toBe(true); expect(fixture.post).toHaveBeenCalledTimes(1);
    const [url, payload, config] = fixture.post.mock.calls[0];
    expect(url).toMatch(/\/ai\/augment-image$/); expect(payload).toMatchObject({ req_type: tool, width: 64, height: 64, defry: 2 });
    expect(payload.prompt).toBe(tool === 'colorize' ? opts.colorizePrompt : tool === 'emotion' ? 'happy;;3' : undefined);
    expect(payload.seed).toBeUndefined(); expect(payload.parameters).toBeUndefined(); expect(config.maxRedirects).toBe(0);
    expect(PNG.sync.read(Buffer.from(payload.image, 'base64')).data.subarray(0, 4)).toEqual(Buffer.from([255, 255, 255, 255]));
    expect(execution.onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('keeps every returned background-removal candidate, actual pixels and the frozen group', async () => {
    fixture.groups = [{ id: 'old', name: 'Original', createdAt: '2026-09-10' }, { id: 'new', name: 'Later', createdAt: '2026-09-10' }];
    const expected: Buffer[] = [];
    fixture.post.mockImplementationOnce(async () => {
      fixture.generationGroupId = 'new'; fixture.groups[0].name = 'Renamed';
      const zip = new JSZip();
      for (let i = 0; i < 3; i++) { const candidate = PNG.sync.read(IMAGE); candidate.data[0] = 30 + i; const data = PNG.sync.write(candidate); expected.push(data); zip.file(`candidate_${i}.png`, data); }
      return { data: await zip.generateAsync({ type: 'nodebuffer' }) };
    });
    const result = await augmentImg('bg-removal', DEFAULT_AUGMENT_OPTIONS, { ...options(IMAGE), historyGroupId: 'old' });
    expect(result.items).toHaveLength(3); expect(fixture.post).toHaveBeenCalledTimes(1);
    for (let i = 0; i < result.items.length; i++) {
      expect(result.items[i].groupId).toBe('old'); expect(result.items[i].filePath).toContain(`${path.sep}Original${path.sep}`);
      expect(await fs.readFile(result.items[i].filePath)).toEqual(expected[i]);
    }
  });

  it.each(['upscale', 'director'] as const)('cancels only the specified %s request and never calls it again', async mode => {
    fixture.post.mockImplementationOnce((_url, _body, config) => new Promise((_resolve, reject) => config.signal.addEventListener('abort', () => reject({ code: 'ERR_CANCELED' }), { once: true })));
    const controller = new AbortController(); const execution = { ...options(IMAGE), signal: controller.signal };
    const pending = mode === 'upscale' ? upscaleImg(2, params.model, execution) : augmentImg('lineart', DEFAULT_AUGMENT_OPTIONS, execution);
    await waitUntil(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    expect(cancelAllJobs()).toBe(false); expect(fixture.post.mock.calls[0][2].signal.aborted).toBe(false);
    controller.abort(); expect((await pending).failureKind).toBe('cancelled');
    expect(fixture.post).toHaveBeenCalledTimes(1); expect(fixture.addHistory).not.toHaveBeenCalled();
  });

  it('does not save an undecodable upscale response or retry a rejected Director mode', async () => {
    fixture.post.mockResolvedValueOnce({ data: Buffer.from('not an image') });
    expect((await upscaleImg(2, params.model, options(IMAGE))).ok).toBe(false);
    expect(fixture.addHistory).not.toHaveBeenCalled();
    fixture.post.mockReset().mockRejectedValueOnce({ response: { status: 422, data: 'unknown req_type' } });
    expect((await augmentImg('sketch', DEFAULT_AUGMENT_OPTIONS, options(IMAGE)))).toMatchObject({ ok: false, statusCode: 422 });
    expect(fixture.post).toHaveBeenCalledTimes(1);
  });
});

describe('Queue postprocessing image preparation', () => {
  it('fits the actual Director payload to the pixel cap and restores the returned image to source dimensions', async () => {
    const large = new PNG({ width: 2048, height: 1024 }); large.data.fill(255); large.data[0] = 12;
    fixture.post.mockImplementationOnce(async (_url, payload) => {
      expect([payload.width, payload.height]).toEqual([1448, 724]);
      const actual = PNG.sync.read(Buffer.from(payload.image, 'base64'));
      expect([actual.width, actual.height]).toEqual([1448, 724]);
      const zip = new JSZip(); zip.file('processed.png', PNG.sync.write(actual));
      return { data: await zip.generateAsync({ type: 'nodebuffer' }) };
    });
    const result = await augmentImg('lineart', DEFAULT_AUGMENT_OPTIONS, options(PNG.sync.write(large)));
    expect(result.ok).toBe(true); expect(fixture.post).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({ width: 2048, height: 1024 });
    const saved = PNG.sync.read(await fs.readFile(result.items[0].filePath));
    expect([saved.width, saved.height]).toEqual([2048, 1024]); expect(saved.data[0]).toBe(12);
  });
});

describe('Queue provenance is persisted with native history', () => {
  it.each(['upscale', 'director'] as const)('persists explicit seedless %s provenance before addHistory so native re-selection retains it', async mode => {
    fixture.post.mockResolvedValueOnce(await archive());
    const provenance = { jobId: 'post-job', mode, originWorkspaceId: 'source-window', submittedRevision: 7, actualSeed: null };
    const execution = { ...options(IMAGE), provenance };
    const result = mode === 'upscale' ? await upscaleImg(2, params.model, execution) : await augmentImg('lineart', DEFAULT_AUGMENT_OPTIONS, execution);
    expect(result.ok).toBe(true);
    const saved = fixture.addHistory.mock.calls.flatMap(([items]) => items);
    expect(saved).toHaveLength(1); expect(saved[0].actualSeed).toBe(0); expect(saved[0].generationOrigin).toEqual(provenance);
  });
});

describe('inpaint diagnostic capture at the actual execution boundary', () => {
  it('retains the raw reply before blending and sends the same request when diagnostics are disabled', async () => {
    const source = new PNG({ width: 256, height: 256 });
    const mask = new PNG({ width: 256, height: 256 });
    const raw = new PNG({ width: 256, height: 256 });
    for (let i = 0; i < source.data.length; i += 4) {
      source.data.set([180, 20, 20, 255], i);
      raw.data.set([20, 30, 220, 255], i);
      mask.data.set([0, 0, 0, 0], i);
    }
    for (let y = 120; y < 144; y++) for (let x = 120; x < 144; x++) {
      mask.data.set([255, 255, 255, 255], (y * 256 + x) * 4);
      raw.data.set([220, 220, 230, 255], (y * 256 + x) * 4);
    }
    const rawBytes = PNG.sync.write(raw);
    const zip = new JSZip(); zip.file('metadata.json', '{"synthetic":true}'); zip.file('image_0.png', rawBytes);
    fixture.post.mockResolvedValue({ data: await zip.generateAsync({ type: 'nodebuffer' }) });
    const execute = () => inpaintImage(params, 'nai-diffusion-5-full-inpainting', PNG.sync.write(mask).toString('base64'), 1, 0, {
      ...options(PNG.sync.write(source)),
      provenance: { jobId: 'diagnostic-fixture', mode: 'inpaint', originWorkspaceId: 'fixture', submittedRevision: 7, actualSeed: 42 },
    });
    vi.stubEnv('NOVELAI_INPAINT_DIAGNOSTICS', '1');
    const result = await execute();
    expect(result.ok).toBe(true); expect(result.items).toHaveLength(1);
    const diagnosticsRoot = path.join(fixture.outputDir, 'inpaint-diagnostics');
    const entries = await fs.readdir(diagnosticsRoot); expect(entries).toHaveLength(1);
    const dir = path.join(diagnosticsRoot, entries[0]);
    expect(await fs.readFile(path.join(dir, 'raw-0.png'))).toEqual(rawBytes);
    const compositeBytes = await fs.readFile(path.join(dir, 'composite-0.png'));
    expect(compositeBytes).toEqual(await fs.readFile(result.items[0].filePath));
    const composite = PNG.sync.read(compositeBytes);
    expect([...composite.data.subarray(0, 4)]).toEqual([180, 20, 20, 255]);
    const center = (132 * 256 + 132) * 4;
    expect([...composite.data.subarray(center, center + 4)]).toEqual([220, 220, 230, 255]);
    const manifest = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    expect(manifest).toContain('diagnostic-fixture'); expect(manifest).not.toContain('synthetic-test-token');
    expect(await fs.readFile(path.join(dir, 'request-mask.png'))).toEqual(Buffer.from(fixture.post.mock.calls[0][1].parameters.mask, 'base64'));
    expect(await fs.readFile(path.join(dir, 'source.png'))).toEqual(Buffer.from(fixture.post.mock.calls[0][1].parameters.image, 'base64'));
    vi.stubEnv('NOVELAI_INPAINT_DIAGNOSTICS', '0');
    const without = await execute();
    expect(without.ok).toBe(true); expect(await fs.readFile(without.items[0].filePath)).toEqual(compositeBytes);
    expect(fixture.post.mock.calls[1][1]).toEqual(fixture.post.mock.calls[0][1]);
    expect(await fs.readdir(diagnosticsRoot)).toEqual(entries);
    expect(fixture.post).toHaveBeenCalledTimes(2);
    expect(fixture.addHistory.mock.calls.flatMap(([items]) => items)).toHaveLength(2);
  });

  it('does not turn a diagnostic disk failure into a failed or repeated generation', async () => {
    vi.stubEnv('NOVELAI_INPAINT_DIAGNOSTICS', '1');
    await fs.writeFile(path.join(fixture.outputDir, 'inpaint-diagnostics'), 'fixture-blocker');
    fixture.post.mockResolvedValueOnce(await archive());
    const result = await inpaintImage(params, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, options(IMAGE));
    expect(result.ok).toBe(true); expect(result.message).toContain('诊断写入失败');
    expect(fixture.post).toHaveBeenCalledTimes(1); expect(fixture.addHistory).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(result.items[0].filePath)).toEqual(IMAGE);
  });
});


describe('authored character history snapshots at the backend save boundary', () => {
  const authored = [
    { prompt: '  adult gardener, adult gardener, {blue coat}  \n', negativePrompt: ' hat, hat  ', useCoords: true, x: 0, y: 1 },
    { prompt: '  adult gardener, adult gardener, {blue coat}  \n', negativePrompt: '', useCoords: false, x: .25, y: .75 },
    { prompt: '', negativePrompt: '  duplicates, duplicates ', useCoords: false, x: 1, y: 0 },
  ];
  it.each(['t2i', 'i2i', 'enhance'] as const)('saves exact %s input before any await, separate from normalized search text, even with PNG metadata off', async mode => {
    fixture.keepImageMetadata = false;
    const incoming = { vibeImages: [], charCaptions: structuredClone(authored) };
    const { buildPayload } = await import('./nai');
    const expected = buildPayload(params, 42, incoming);
    fixture.post.mockImplementationOnce(async () => {
      incoming.charCaptions[0].prompt = 'later live edit';
      incoming.charCaptions[1].negativePrompt = 'later negative';
      incoming.charCaptions.reverse();
      return archive();
    });
    const execution = { ...options(IMAGE), provenance: { jobId: 'fixture', mode, originWorkspaceId: 'fixture', submittedRevision: 1, actualSeed: 42 } };
    const result = mode === 't2i' ? await generateImage(params, incoming, undefined, execution)
      : await generateI2I(params, { strength: .5, noise: 0, extraNoiseSeed: 42 }, incoming, execution);
    expect(result.ok, result.message).toBe(true);
    expect(result.items[0].characterSnapshot).toEqual({ version: 1, captions: authored });
    expect(fixture.addHistory.mock.calls[0][0][0].characterSnapshot).toEqual({ version: 1, captions: authored });
    expect(result.items[0].characterPrompts).not.toEqual(authored.map(c => c.prompt));
    expect(result.items[0].characterPrompts).toEqual(authored.slice(0, 2).map(c => c.prompt));
    const sent = fixture.post.mock.calls[0][1];
    expect(sent.parameters.v4_prompt).toEqual(expected.parameters.v4_prompt);
    expect(sent.parameters.v4_negative_prompt).toEqual(expected.parameters.v4_negative_prompt);
    expect(sent).not.toHaveProperty('characterSnapshot');
    expect(await fs.readFile(result.items[0].filePath)).toEqual(IMAGE);
  });

  it('records an explicit empty group for t2i without extras and for inpaint, never borrowing canvas characters', async () => {
    for (const mode of ['t2i', 'inpaint']) {
      fixture.post.mockResolvedValueOnce(await archive());
      const result = mode === 't2i' ? await generateImage(params, undefined, undefined, options())
        : await inpaintImage(params, 'nai-diffusion-5-full-inpainting', IMAGE.toString('base64'), 1, 0, options(IMAGE));
      expect(result.ok, result.message).toBe(true);
      expect(result.items[0].characterSnapshot).toEqual({ version: 1, captions: [] });
    }
  });
});

it('keeps raw history characters beyond provider filtering/trimming/model capacity without changing provider construction', async () => {
  const legacy = { ...params, model: 'nai-diffusion-4-full' as const }; delete legacy.promptAssemblyVersion;
  const chars = Array.from({ length: 8 }, (_, i) => ({ prompt: `  adult gardener ${i}, gardener  `, negativePrompt: ' blur, blur ', useCoords: false, x: .25, y: .75 }));
  chars.unshift({ prompt: '', negativePrompt: '', useCoords: false, x: 0, y: 1 });
  fixture.post.mockResolvedValueOnce(await archive());
  const result = await generateImage(legacy, { vibeImages: [], charCaptions: chars }, undefined, options());
  expect(result.ok, result.message).toBe(true);
  expect(result.items[0].characterSnapshot).toEqual({ version: 1, captions: chars });
  expect(result.items[0].characterPrompts).toEqual(chars.slice(1, 7).map(c => c.prompt.trim()));
  expect(fixture.post.mock.calls[0][1].parameters.v4_prompt.caption.char_captions).toHaveLength(6);
});
