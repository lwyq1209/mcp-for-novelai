/**
 * Review rework (P3-4): host errors the window showed in English in a Chinese interface. Each case runs the real
 * host code that refuses, takes the error as an IPC reply carries it (hostErrorFields) and renders it in both
 * interface languages: the Chinese text comes from the catalog (by reason or code), never the English message.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {} }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
import { DEFAULT_AUGMENT_OPTIONS, DEFAULT_PARAMS } from '../src/types';
import { hostErrorText } from '../src/host-errors';
import { hostErrorFields } from './host-error';
import { parseManualRequest } from './manual-generation';
import { createGenerationService } from './generation-service';
import { inspectLibraryArchive } from './library-archive';
import { openBackupZip } from './data-backup-zip';
import { runCleanups } from '../src/test-support/temp-dirs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups(cleanups.splice(0)));
const cjk = /[\u4e00-\u9fff]/;
const SOURCE_ID = '0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a01';
const click = (extra: Record<string, unknown> = {}) => ({ requestKey: 'manual-0123456789', mode: 't2i', count: 1, intervalSeconds: 0, params: { ...DEFAULT_PARAMS, positivePrompt: 'a mug' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, ...extra });
const png = (width: number, height: number) => { const image = new PNG({ width, height }); image.data.fill(200); return PNG.sync.write(image); };

async function rendered(run: () => unknown) {
  let caught: unknown = null;
  try { await run(); } catch (error) { caught = error; }
  expect(caught, 'the host refused').not.toBeNull();
  const fields = hostErrorFields(caught, 'x_fallback', 'fallback');
  return { fields, zh: hostErrorText(fields, 'zh-CN'), en: hostErrorText(fields, 'en-US') };
}

describe('host errors a Chinese window showed in English (review P3-4)', () => {
  const manualCases: Array<[string, Record<string, unknown>, string]> = [
    ['a click of 1000 images', click({ count: 1000 }), '一次手动生成为 1–999 张。'],
    ['a request key not of a click', click({ requestKey: 'x' }), '手动生成需要自己的请求键（manual-…）。'],
    ['upscale ×3', click({ mode: 'upscale', upscale: { scale: 3 }, sourceId: SOURCE_ID }), '超分倍数只能是 2× 或 4×。'],
    ['an unknown Director tool', click({ mode: 'director', director: { tool: 'paint', options: {} }, sourceId: SOURCE_ID }), '未知的后期工具。'],
    ['an unknown mode', click({ mode: 'enhance' }), '未知的手动生成模式。'],
    ['a pause of two hours', click({ intervalSeconds: 7200 }), '两张之间的间隔为 0–3600 秒。'],
  ];
  it.each(manualCases)('a click: %s', async (_label, request, zh) => {
    const text = await rendered(() => parseManualRequest(request));
    expect(text.zh).toBe(zh);
    expect(text.en).toBe(text.fields.message);
  });

  const service = () => createGenerationService({ validateImage: value => { const image = PNG.sync.read(value); return { width: image.width, height: image.height }; }, execute: async () => ({ ok: false, message: 'unused', items: [] }) });
  const queue = { batchId: 'batch-1', requestKey: 'manual-0123456789', itemIndex: 0 };
  const submission = (snapshot: Record<string, unknown>, mode = 't2i', extra: Record<string, unknown> = {}) => ({ workspaceId: 'recipe-queue', expectedRevision: 0, requestKey: `child-${Math.random()}`, mode, queue, manual: true, snapshot: { params: { ...DEFAULT_PARAMS, positivePrompt: 'a mug', seed: 3, seedMode: 'fixed' }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, ...snapshot }, ...extra });
  it('an image of an unknown model, an inpaint strength of 2, an upscale past 4096 and an unknown Director tool', async () => {
    const model = await rendered(() => service().submit(submission({ params: { ...DEFAULT_PARAMS, positivePrompt: 'a mug', model: 'no-such-model' } })));
    expect(model.zh).toBe('生成模型无效。');
    const inpaint = await rendered(() => service().submit(submission({ inpaint: { model: 'nai-diffusion-4-5-full-inpainting', strength: 2, maskBase64: png(64, 64).toString('base64') } }, 'inpaint', { manualSource: { bytes: png(64, 64), mimeType: 'image/png' } })));
    expect(inpaint.zh).toBe('重绘模型或重绘强度无效。');
    // A 1024×256 source upscaled 4× would be 4096×1024 … a 2048×256 one 8192×1024 (wider than 4096).
    const upscale = await rendered(() => service().submit(submission({ upscale: { scale: 4 } }, 'upscale', { manualSource: { bytes: png(2048, 256), mimeType: 'image/png' } })));
    expect(upscale.fields).toMatchObject({ code: 'invalid_configuration', reason: 'generation.upscale_too_large', params: { max: 4096 } });
    expect(upscale.zh).toMatch(/^放大后尺寸将达到 \d+×\d+，超过允许的最大尺寸 4096×4096，未发出请求。/);
    const director = await rendered(() => service().submit(submission({ director: { tool: 'paint', options: DEFAULT_AUGMENT_OPTIONS } }, 'director', { manualSource: { bytes: png(64, 64), mimeType: 'image/png' } })));
    expect(director.zh).toBe('未知的后期工具。');
  });

  it('a material archive whose manifest is not JSON, and a backup that is not a ZIP', async () => {
    const zip = new JSZip(); zip.file('library/manifest.json', 'not json');
    const archive = await rendered(() => inspectLibraryArchive(zip));
    expect(archive.fields).toMatchObject({ code: 'library_archive_invalid', reason: 'library_archive.manifest_invalid' });
    expect(archive.zh).toBe('素材归档清单无效。');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-window-text-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'backup.zip'); await fs.writeFile(file, 'plain text, not a zip');
    const backup = await rendered(() => openBackupZip(file));
    expect(backup.fields).toMatchObject({ code: 'backup_invalid_archive', reason: 'backup_zip.not_zip' });
    expect(backup.zh).toBe('这个文件不是可读取的备份 ZIP。');
    for (const text of [archive, backup]) { expect(text.zh).toMatch(cjk); expect(text.en).not.toMatch(cjk); }
  });
});
