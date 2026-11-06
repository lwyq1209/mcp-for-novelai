/**
 * Canvas capture keeps the canvas's own prompt assembly (review rework P2-1, from the review probes
 * assembly.probe / equivalence.probe). A canvas restored from history, an older release or a data backup can still
 * be on the historical prompt assembly (no promptAssemblyVersion, in params or in an independent inpaint recipe);
 * capture must freeze it exactly as read_prompt_review shows it, never upgrade it to assembly version 1. And for every
 * mode, what the queue freezes from a captured canvas recipe equals what the retired canvas submit path froze.
 * The real path: renderer collection (collectPromptReview, as collect_canvas_preparation) → host capture →
 * put_canvas_recipe / preview_canvas_recipe → enqueue_queue_recipes (its frozen snapshot). NovelAI is never called.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', async () => {
  const { PNG } = await import('pngjs');
  const make = (png: any): any => ({ isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => PNG.sync.write(png),
    resize({ width, height }: { width: number; height: number }) { return make(new PNG({ width, height })); } });
  return { app: {}, dialog: {}, nativeImage: { createFromBuffer(buffer: Buffer) { try { return make(PNG.sync.read(Buffer.from(buffer))); } catch { return { isEmpty: () => true }; } } } };
});
import { createQueueRecipeService } from './queue-recipe-service';
import { createCanvasRecipeCapture } from './canvas-recipe-capture';
import { buildPromptReview } from './prompt-review';
import { collectPromptReview } from '../src/workspace/prompt-review';
import { freezeGenerationInput } from '../src/workspace/generation-input';
import { DEFAULT_AUGMENT_OPTIONS, DEFAULT_I2I_PARAMS, DEFAULT_PARAMS } from '../src/types';
import type { GenerationMode } from '../src/workspace/generation-types';
import { runCleanups } from '../src/test-support/temp-dirs';

const png = (width: number, height: number) => { const image = new PNG({ width, height }); for (let i = 0; i < image.data.length; i += 4) image.data.set([i % 255, 40, 90, 255], i); return PNG.sync.write(image).toString('base64'); };
const SOURCE = png(64, 96), MASK = png(64, 96);
const read = async () => ({ mimeType: 'image/png', data: SOURCE });
const withoutAssembly = <T extends Record<string, any>>(params: T) => { const { promptAssemblyVersion: _omitted, ...rest } = params; return rest as T; };
/** A complete canvas state (CreativeState plus the fields the retired submit path read). */
const canvas = (over: Record<string, any> = {}): any => ({
  params: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: '1girl, smile', stylePrompt: 'best quality', negativePrompt: 'lowres', width: 64, height: 64, seed: 5, seedMode: 'fixed', promptAssemblyVersion: 1 },
  charCaptions: [], vibeImages: [], preciseReferences: [], i2iParams: { ...DEFAULT_I2I_PARAMS }, augmentOptions: { ...DEFAULT_AUGMENT_OPTIONS }, modelMode: 'anime',
  inpaintModel: 'nai-diffusion-4-5-full-inpainting', inpaintStrength: 1, inpaintNoise: 0, inpaintPositivePrompt: '', inpaintRecipe: null, i2iSourceMode: 'latest', inpaintSourceMode: 'latest', i2iSizeMode: 'manual',
  enhanceMagnitude: 3, enhanceScale: 1, upscaleScale: 2, directorTool: 'bg-removal', workbenchImage: { filePath: '/canvas/source.png', fileUrl: 'source', width: 64, height: 96 }, i2iOriginalImage: null, inpaintMask: null,
  generationGroupId: 'canvas-save-group', batchCount: 1, ...over,
});
/** The legacy (no marker) canvas of the assembly probe: duplicated tags are folded by the historical assembly only. */
const legacyParams = () => withoutAssembly({ ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: '1girl, smile, 1girl', stylePrompt: 'smile, best quality', negativePrompt: '', width: 64, height: 64, seed: 5, seedMode: 'fixed' });
const legacyRecipe = () => withoutAssembly({ ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'silver brooch, silver brooch', stylePrompt: 'silver brooch', negativePrompt: 'lowres', steps: 24, seed: 9, seedMode: 'fixed' });

const cleanups: string[] = [];
afterEach(async () => { await runCleanups(cleanups.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-canvas-assembly-')); cleanups.push(runtimeDir);
  const enqueued: any[] = [];
  // The frozen queue itself is not under test: it records what enqueue_queue_recipes hands it.
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => { enqueued.push(structuredClone(args)); return { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) }; }),
    lookup: vi.fn(() => null), list: vi.fn(() => ({ batches: [] })), read: vi.fn(), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
  const service: any = createQueueRecipeService({ runtimeDir, batch: batch as any, randomSeed: () => 97 });
  let state: any = canvas();
  const capture = createCanvasRecipeCapture({
    // collect_canvas_preparation: the controller reads exactly this collection (adapter.collectPreparation).
    collect: async (args: any) => ({ schemaVersion: 1, workspaceId: 'canvas', revision: 3, mode: args.mode, draftId: null, patched: false, unappliedDraftId: null, preparation: await collectPromptReview(structuredClone(state), args.mode, read) }),
    put: args => service.put_canvas_recipe(args), preview: args => service.preview_canvas_recipe(args), now: () => new Date('2026-11-02T12:00:00.000Z'),
  });
  return {
    service, enqueued,
    setCanvas(next: any) { state = next; },
    /** read_prompt_review of the same canvas (adapter.promptReview → buildPromptReview). */
    review: async (mode: GenerationMode) => buildPromptReview(await collectPromptReview(structuredClone(state), mode, read)),
    capture: (mode: GenerationMode, preview = false) => capture({ workspaceId: 'canvas', expectedRevision: 3, mode, ...(preview ? { preview: true } : {}) }) as Promise<any>,
    /** The recipe as stored (the record's preparation), read back from disk. */
    stored: async (saved: any) => JSON.parse(await fs.readFile(path.join(runtimeDir, 'queue-recipes', `${saved.recipeId}.1.json`), 'utf8')).preparation,
    async freeze(saved: any) {
      await service.enqueue_queue_recipes({ requestKey: `assembly-${randomUUID()}`, items: [{ recipeId: saved.recipeId, recipeRevision: saved.recipeRevision, inputHash: saved.inputHash }] });
      const args = enqueued.at(-1); return args.snapshots?.[0] ?? args.snapshot;
    },
  };
}

describe('canvas capture keeps the canvas prompt assembly', () => {
  it('t2i without promptAssemblyVersion: the captured final prompt is read_prompt_review\'s, and the recipe stays on the historical assembly', async () => {
    const h = await setup(); h.setCanvas(canvas({ params: legacyParams(), workbenchImage: null }));
    const review = await h.review('t2i');
    expect(review.authored.params).not.toHaveProperty('promptAssemblyVersion');
    const saved = await h.capture('t2i'), preview = await h.capture('t2i', true);
    for (const value of [saved, preview]) {
      expect(value.snapshot.reviewInput.effective.request.input).toBe(review.effective!.request.input);
      expect(value.snapshot.reviewInput.effective).toEqual(review.effective);
    }
    // The historical assembly folds the repeated tags; version 1 would have sent "smile, best quality, 1girl, smile, 1girl, …".
    expect(review.effective!.request.input).toMatch(/^smile, best quality, 1girl, /);
    expect(review.effective!.request.input).not.toContain('1girl, smile, 1girl');
    expect(saved.snapshot.reviewInput.authored.params).not.toHaveProperty('promptAssemblyVersion');
    expect((await h.stored(saved)).authored.params).not.toHaveProperty('promptAssemblyVersion');
    expect((await h.freeze(saved)).params).not.toHaveProperty('promptAssemblyVersion');
    expect(saved.inputHash).toBe(preview.inputHash);
  });

  it('inpaint without promptAssemblyVersion (legacy recipe, and an independent recipe beside version-1 params) keeps it absent where the canvas has none', async () => {
    const h = await setup();
    const cases = [
      { name: 'legacy inpaint, legacy params', state: canvas({ params: legacyParams(), inpaintMask: MASK, inpaintPositivePrompt: 'red coat, red coat' }), params: false, recipe: null },
      { name: 'independent legacy recipe beside version-1 params', state: canvas({ inpaintMask: MASK, inpaintRecipe: legacyRecipe() }), params: true, recipe: false },
      { name: 'independent version-1 recipe beside legacy params', state: canvas({ params: legacyParams(), inpaintMask: MASK, inpaintRecipe: { ...legacyRecipe(), promptAssemblyVersion: 1 } }), params: false, recipe: true },
    ];
    for (const item of cases) {
      h.setCanvas(item.state);
      const review = await h.review('inpaint'), saved = await h.capture('inpaint'), preview = await h.capture('inpaint', true);
      expect(review.readiness.status, item.name).toBe('ready');
      for (const value of [saved, preview]) {
        expect(value.snapshot.reviewInput.effective.request.input, item.name).toBe(review.effective!.request.input);
        expect(value.snapshot.reviewInput.effective, item.name).toEqual(review.effective);
      }
      const stored = await h.stored(saved);
      expect(Object.hasOwn(stored.authored.params, 'promptAssemblyVersion'), item.name).toBe(item.params);
      if (item.recipe === null) expect(stored.authored.inpaintRecipe, item.name).toBeNull();
      else expect(Object.hasOwn(stored.authored.inpaintRecipe, 'promptAssemblyVersion'), item.name).toBe(item.recipe);
      const frozen = await h.freeze(saved);
      expect(Object.hasOwn(frozen.params, 'promptAssemblyVersion'), item.name).toBe(item.recipe ?? item.params);
    }
  });

  it('a plain new recipe (prepare_recipe fields, put_queue_recipe) still starts on assembly version 1', async () => {
    const h = await setup();
    const saved = await h.service.put_queue_recipe({ preparation: { mode: 't2i', authored: { params: { positivePrompt: '1girl, smile, 1girl', stylePrompt: 'smile', seed: 5, seedMode: 'fixed', width: 64, height: 64 } }, assets: [] } });
    expect(saved.snapshot.reviewInput.authored.params.promptAssemblyVersion).toBe(1);
    const preview = await h.service.preview_queue_recipe({ preparation: { mode: 'inpaint', authored: { params: { positivePrompt: 'coat', seed: 5, seedMode: 'fixed' }, inpaintRecipe: withoutAssembly({ ...DEFAULT_PARAMS, model: 'nai-diffusion-5-full', positivePrompt: 'coat, coat', seed: 5, seedMode: 'fixed' }) }, assets: [{ role: 'source', mimeType: 'image/png', data: SOURCE }, { role: 'mask', mimeType: 'image/png', data: MASK }] } });
    expect(preview.snapshot.reviewInput.authored.inpaintRecipe.promptAssemblyVersion).toBe(1);
  });
});

/** A V5 Full canvas on Medium effort whose stored steps, sampler, CFG rescale, UC preset and negatives Medium replaces. */
const mediumCanvas = (over: Record<string, any> = {}) => canvas({
  params: { ...canvas().params, model: 'nai-diffusion-5-full', effort: 'medium', steps: 28, sampler: 'k_dpmpp_2m', cfgRescale: 0.2, ucPreset: 2, noiseSchedule: 'karras' },
  charCaptions: [{ id: 'c1', prompt: 'girl A', negativePrompt: 'hat', useCoords: false, x: 0.5, y: 0.5 }], ...over,
});

/** Fields the canvas freeze has and the queue deliberately does not take over (user decisions, 2026-11-02). */
const comparable = (snapshot: any) => { const copy = structuredClone(snapshot); delete copy.extras?.historyGroupId; delete copy.batchCount; return copy; };
const modes: Array<[string, GenerationMode, () => any]> = [
  ['t2i, version 1', 't2i', () => canvas({ workbenchImage: null })],
  ['t2i, historical assembly', 't2i', () => canvas({ params: legacyParams(), workbenchImage: null })],
  ['t2i, characters with and without coordinates, ucPreset 2, no quality, random seed', 't2i', () => canvas({ params: { ...canvas().params, ucPreset: 2, qualityPreset: 'none', qualityToggle: false, seedMode: 'random' }, charCaptions: [{ id: 'c1', prompt: 'girl A', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.7 }, { id: 'c2', prompt: 'girl B', negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 }] })],
  ['i2i, adaptive size', 'i2i', () => canvas({ i2iSizeMode: 'adaptive', i2iParams: { strength: 0.4, noise: 0.1, extraNoiseSeed: 9 } })],
  ['i2i, original source, historical assembly', 'i2i', () => canvas({ params: legacyParams(), i2iSourceMode: 'original', i2iOriginalImage: { filePath: '/canvas/original.png', fileUrl: 'original', width: 64, height: 96 } })],
  ['enhance', 'enhance', () => canvas({ enhanceMagnitude: 4, enhanceScale: 1, i2iParams: { strength: 0.5, noise: 0, extraNoiseSeed: 11 } })],
  ['upscale', 'upscale', () => canvas()],
  ['director colorize', 'director', () => canvas({ directorTool: 'colorize', augmentOptions: { defry: 2, colorizePrompt: 'blue', emotion: 'happy', emotionLevel: 0 } })],
  ['inpaint, legacy recipe', 'inpaint', () => canvas({ inpaintMask: MASK, inpaintPositivePrompt: 'red coat', inpaintStrength: 0.7 })],
  ['inpaint, legacy recipe, historical assembly', 'inpaint', () => canvas({ params: legacyParams(), inpaintMask: MASK, inpaintPositivePrompt: 'red coat, red coat' })],
  ['inpaint, independent version-1 recipe', 'inpaint', () => canvas({ inpaintMask: MASK, inpaintRecipe: { ...DEFAULT_PARAMS, model: 'nai-diffusion-4-5-full', positivePrompt: 'silver brooch', steps: 24, seed: 9, seedMode: 'fixed' } })],
  ['inpaint, independent recipe, historical assembly', 'inpaint', () => canvas({ inpaintMask: MASK, inpaintRecipe: legacyRecipe() })],
  ['t2i, V5 Full Medium effort', 't2i', () => mediumCanvas({ workbenchImage: null })],
  ['i2i, V5 Full Medium effort', 'i2i', () => mediumCanvas()],
  ['inpaint, legacy recipe, V5 Full Medium effort', 'inpaint', () => mediumCanvas({ inpaintMask: MASK, inpaintPositivePrompt: 'red coat', inpaintModel: 'nai-diffusion-5-full-inpainting', charCaptions: [] })],
  ['inpaint, independent recipe, V5 Full Medium effort', 'inpaint', () => canvas({ inpaintMask: MASK, inpaintModel: 'nai-diffusion-5-full-inpainting', inpaintRecipe: { ...DEFAULT_PARAMS, model: 'nai-diffusion-5-full', effort: 'medium', positivePrompt: 'silver brooch', negativePrompt: 'lowres', steps: 24, seed: 9, seedMode: 'fixed' } })],
  ['enhance, Max✨ (runs High)', 'enhance', () => mediumCanvas({ enhanceScale: 'max', charCaptions: [] })],
];

describe('captured canvas recipes freeze what the retired canvas submit froze', () => {
  it.each(modes)('%s', async (_name, mode, state) => {
    const h = await setup(); h.setCanvas(state());
    const retired = await freezeGenerationInput(structuredClone(state()), mode, read);
    const saved = await h.capture(mode);
    expect(saved.snapshot.reviewInput.readiness.status).toBe('ready');
    const frozen = await h.freeze(saved);
    // A random canvas seed is drawn at enqueue (randomSeed 97 here); the frozen recipe itself keeps the random policy.
    expect(comparable(frozen)).toEqual(comparable(retired));
    // And its final prompt is the one read_prompt_review shows for the same canvas.
    const review = await h.review(mode);
    if (review.effective?.request?.input !== undefined) expect(saved.snapshot.reviewInput.effective.request.input).toBe(review.effective.request.input);
    expect(saved.snapshot.reviewInput.effective).toEqual(review.effective);
  });
});

describe('canvas capture of V5 Full Effort and Enhance Max✨ (read_prompt_review and prepare_recipe {canvas} agree)', () => {
  it('a Medium canvas is captured as the Medium request: model id, fixed values, Heavy UC, no negatives', async () => {
    const h = await setup(); h.setCanvas(mediumCanvas({ workbenchImage: null }));
    const review = await h.review('t2i'), saved = await h.capture('t2i');
    expect(saved.snapshot.reviewInput.effective).toEqual(review.effective);
    const request = saved.snapshot.reviewInput.effective.request;
    expect(request.model).toBe('nai-diffusion-5-full-medium');
    expect(request.parameters).toMatchObject({ steps: 14, sampler: 'k_euler_ancestral', cfg_rescale: 0, ucPreset: 0, tag_hint_uc_preset: 2 });
    expect(request.parameters.uc).toMatch(/^nsfw, lowres, artistic error, /);
    expect(request.parameters.v4_negative_prompt.caption.char_captions).toEqual([]);
    // The canvas keeps its own values (they come back on High); the frozen queue input carries what runs.
    expect(saved.snapshot.reviewInput.authored.params).toMatchObject({ effort: 'medium', steps: 28, sampler: 'k_dpmpp_2m' });
    expect((await h.freeze(saved)).params).toMatchObject({ effort: 'medium', steps: 14, sampler: 'k_euler_ancestral', cfgRescale: 0, ucPreset: 0, negativePrompt: '' });
  });

  it('inpaint follows the inpainting model; Medium on V4.5 is listed as unused', async () => {
    const h = await setup();
    h.setCanvas(mediumCanvas({ inpaintMask: MASK, inpaintPositivePrompt: 'red coat', inpaintModel: 'nai-diffusion-5-full-inpainting', charCaptions: [] }));
    expect((await h.capture('inpaint')).snapshot.reviewInput.effective.request.model).toBe('nai-diffusion-5-full-medium-inpainting');
    h.setCanvas(mediumCanvas({ params: { ...mediumCanvas().params, model: 'nai-diffusion-4-5-full' }, workbenchImage: null }));
    const review = await h.review('t2i');
    expect(review.effective!.request.model).toBe('nai-diffusion-4-5-full');
    expect(review.effective!.request.parameters.steps).toBe(28);
    expect(review.unusedInputs).toContain('params.effort');
  });

  it('Enhance Max✨: upscaled_enhance with the source at its own (64-aligned) size, and the expected result size', async () => {
    const h = await setup(); h.setCanvas(mediumCanvas({ enhanceScale: 'max', charCaptions: [], workbenchImage: { filePath: '/canvas/source.png', fileUrl: 'source', width: 64, height: 96 } }));
    const saved = await h.capture('enhance');
    const effective = saved.snapshot.reviewInput.effective;
    expect(effective.request.model).toBe('nai-diffusion-5-full');
    expect(effective.request.parameters).toMatchObject({ upscaled_enhance: true, width: 64, height: 128, steps: 28 });
    expect(effective.sampling.processing).toEqual({ inputWidth: 64, inputHeight: 128, outputWidth: 128, outputHeight: 256, resizedInput: true, alphaFlattened: false, upscaledEnhance: true });
    expect(saved.snapshot.reviewInput.unusedInputs).toContain('params.effort');
  });
});
