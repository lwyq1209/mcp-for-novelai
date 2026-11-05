import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
import { recipeHash, validateRecipeResult } from '../src/recipe-queue.mjs';

// Independent expectations from the official table checked 2026-09-11.
// https://docs.novelai.net/en/image/undesiredcontent/
const heavy = 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';
const light = 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::';
const human = `${heavy}, @_@, mismatched pupils, glowing eyes, bad anatomy`;
const officialV5 = [heavy, light, human, ''];
const oldFull = [heavy, 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page', human, ''];
const oldCurated = [
  'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
  'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page',
  '',
];
let directory, buildPayload, buildPromptReview, DEFAULT_PARAMS, NAI_UC_PRESETS, parseImportedParams, parseNovelAICharCaptions;
before(async () => {
  directory = await mkdtemp(resolve(tmpdir(), 'nai-uc-presets-'));
  const electron = resolve(directory, 'electron.mjs'), axios = resolve(directory, 'axios.mjs');
  await writeFile(electron, `const forbidden = () => { throw new Error('UC fixture cannot access native UI or account paths'); };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};
export const nativeImage = { createFromBuffer: forbidden, createFromPath: forbidden };`);
  await writeFile(axios, `const forbidden = () => { throw new Error('UC fixture cannot access network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { electron, axios } });
  ({ buildPayload } = await jiti.import(fileURLToPath(new URL('../client/electron/ipc/nai.ts', import.meta.url))));
  ({ buildPromptReview } = await jiti.import(fileURLToPath(new URL('../client/electron/prompt-review.ts', import.meta.url))));
  ({ DEFAULT_PARAMS, NAI_UC_PRESETS } = await jiti.import(fileURLToPath(new URL('../client/src/types.ts', import.meta.url))));
  ({ parseImportedParams, parseNovelAICharCaptions } = await jiti.import(fileURLToPath(new URL('../client/src/png-meta.ts', import.meta.url))));
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
function params(model, ucPreset, patch = {}) {
  return { ...DEFAULT_PARAMS, model, ucPreset, positivePrompt: 'still life, teacup', negativePrompt: '', stylePrompt: '',
    qualityPreset: 'none', qualityToggle: false, preservePromptText: true, seedMode: 'fixed', seed: 42,
    width: 768, height: 512, steps: 28, ...patch };
}
const character = { prompt: 'adult librarian', negativePrompt: 'jewelry', useCoords: true, x: .3, y: .6 };
const extras = captions => ({ vibeImages: [], preciseReferences: [], charCaptions: captions });
function assertUC(request, expected, preset) {
  assert.equal(request.parameters.uc, expected);
  assert.equal(request.parameters.negative_prompt, expected);
  assert.equal(request.parameters.v4_negative_prompt.caption.base_caption, expected);
  assert.equal(request.parameters.ucPreset, preset); assert.equal(request.parameters.uc_preset, preset);
}
/** The recipe identity the host queue stores and checks (queue-recipe-service inputHash; MCP validateRecipeResult). */
function inputHash(reviewInput) {
  const { assets, ...input } = reviewInput;
  return recipeHash({ ...input, assets: assets.map(({ data: _data, ...asset }) => asset) });
}
/** A host read_queue_recipe reply: an identity saved with `savedHash` and the snapshot the current builder produces. */
function storedRecipe(snapshot, savedHash) {
  const recipeId = randomUUID();
  return { recipeId, recipeRevision: 1, inputHash: savedHash, snapshot: { ...snapshot, workspaceId: `recipe:${recipeId}`, revision: 1, draftId: null } };
}
async function preview(model, preset, patch = {}, captions = []) {
  const authored = { params: params(model, preset, patch), charCaptions: captions };
  const before = structuredClone(authored);
  const reviewInput = await buildPromptReview({ mode: 't2i', authored, assets: [] });
  assert.equal(reviewInput.readiness.status, 'ready'); assert.deepEqual(authored, before);
  return { schemaVersion: 1, workspaceId: 'uc-fixture', revision: 1, draftId: 'uc-draft', mode: 't2i', reviewInput };
}

test('V5 Full/Curated actual review builder uses the current official presets and stable numeric choices', async () => {
  assert.deepEqual(NAI_UC_PRESETS.map(preset => preset.value), [0, 1, 2, 3]);
  assert.equal(DEFAULT_PARAMS.ucPreset, 2);
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    for (const [preset, expected] of officialV5.entries()) {
      const snapshot = await preview(model, preset);
      assertUC(snapshot.reviewInput.effective.request, expected, preset);
      assert.equal(snapshot.reviewInput.authored.params.negativePrompt, '');
      assert.equal(snapshot.reviewInput.authored.params.ucPreset, preset);
      assertUC(buildPayload(params(`${model}-inpainting`, preset), 42), expected, preset);
    }
  }
});

test('V4.5 Full/Curated retain their existing four preset meanings including inpainting', async () => {
  for (const [model, table] of [['nai-diffusion-4-5-full', oldFull], ['nai-diffusion-4-5-curated', oldCurated]]) {
    for (const [preset, expected] of table.entries()) {
      assertUC((await preview(model, preset)).reviewInput.effective.request, expected, preset);
      assertUC(buildPayload(params(`${model}-inpainting`, preset), 42), expected, preset);
    }
  }
});

test('preset plus custom UC preserves existing merge modes and never adds global UC to character captions', async () => {
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    for (const preservePromptText of [false, true]) {
      const input = params(model, 1, { negativePrompt: 'jewelry, lowres', preservePromptText });
      if (!preservePromptText) delete input.promptAssemblyVersion;
      const before = structuredClone(input);
      const request = buildPayload(input, 42, extras([character]));
      const expected = preservePromptText ? `jewelry, lowres, ${light}` : `jewelry, ${light}`;
      assertUC(request, expected, 1);
      assert.deepEqual(request.parameters.v4_negative_prompt.caption.char_captions, [{ char_caption: 'jewelry', centers: [{ x: .3, y: .6 }] }]);
      assert.deepEqual(input, before);
      const reviewInput = await buildPromptReview({mode:'t2i',authored:{params:input,charCaptions:[character]},assets:[]});
      assertUC(reviewInput.effective.request, expected, 1);
      assert.equal(reviewInput.authored.params.negativePrompt, 'jewelry, lowres');
      assert.deepEqual(reviewInput.effective.request.parameters.v4_negative_prompt, request.parameters.v4_negative_prompt);
    }
    const versioned = params(model, 1, { negativePrompt: 'jewelry, lowres', preservePromptText: false });
    assertUC(buildPayload(versioned, 42, extras([character])), `jewelry, lowres, ${light}`, 1);
  }
});

test('prompt assembly version is part of the recipe identity even when the rendered text happens to match', async () => {
  const versionedParams = params('nai-diffusion-5-full', 3, { preservePromptText: false, positivePrompt: 'still life, teacup' });
  const legacyParams = structuredClone(versionedParams); delete legacyParams.promptAssemblyVersion;
  const make = async authoredParams => ({ schemaVersion: 1, workspaceId: 'assembly-fixture', revision: 1, draftId: null, mode: 't2i', reviewInput: await buildPromptReview({mode:'t2i',authored:{params:authoredParams,charCaptions:[]},assets:[]}) });
  const versioned = await make(versionedParams), legacy = await make(legacyParams);
  assert.equal(versioned.reviewInput.effective.request.input, legacy.reviewInput.effective.request.input);
  assert.notEqual(inputHash(versioned.reviewInput), inputHash(legacy.reviewInput));
  assert.throws(() => validateRecipeResult(storedRecipe(versioned, inputHash(legacy.reviewInput))), /input hash does not match/);
  assert.doesNotThrow(() => validateRecipeResult(storedRecipe(versioned, inputHash(versioned.reviewInput))));
});

test('None retains custom and per-character UC, including fully empty negatives', async () => {
  for (const model of ['nai-diffusion-5-full', 'nai-diffusion-5-curated']) {
    for (const custom of ['', 'jewelry']) {
      const snapshot = await preview(model, 3, { negativePrompt: custom }, [character]);
      assertUC(snapshot.reviewInput.effective.request, custom, 3);
      assert.equal(snapshot.reviewInput.effective.request.parameters.v4_negative_prompt.caption.char_captions[0].char_caption, 'jewelry');
    }
    const request = (await preview(model, 3)).reviewInput.effective.request;
    assertUC(request, '', 3); assert.deepEqual(request.parameters.v4_negative_prompt.caption.char_captions, []);
  }
});

test('existing PNG full-text import keeps None, old UC text, character UC and metadata replay unchanged', async () => {
  for (const [model, characterUC] of [['nai-diffusion-5-full', 'jewelry'], ['nai-diffusion-5-curated', 'jewelry'], ['nai-diffusion-5-full', ''], ['nai-diffusion-5-curated', '']]) {
    const originalUC = `jewelry, ${model.endsWith('curated') ? oldCurated[1] : oldFull[1]}, jewelry`;
    const meta = { Software: 'NovelAI', Source: model, Comment: JSON.stringify({ model, seed: 42,
      uc_preset: 1, quality_boost: true, skip_cfg_below_sigma: .15,
      v4_prompt: { caption: { base_caption: 'adult librarian, reading', char_captions: [{ char_caption: 'adult librarian', centers: [{ x: .3, y: .6 }] }] }, use_coords: true, use_order: false },
      v4_negative_prompt: { caption: { base_caption: originalUC, char_captions: [{ char_caption: characterUC, centers: [{ x: .3, y: .6 }] }] }, use_coords: true, use_order: true, legacy_uc: true },
    }) };
    const imported = parseImportedParams(meta), captions = parseNovelAICharCaptions(meta);
    assert.equal(imported.ucPreset, 3); assert.equal(imported.preservePromptText, true);
    const snapshot = await preview(model, 3, imported, captions);
    const request = snapshot.reviewInput.effective.request;
    assertUC(request, originalUC, 3);
    assert.equal(request.parameters.quality_boost, true); assert.equal(request.parameters.skip_cfg_below_sigma, .15);
    assert.equal(request.parameters.v4_prompt.use_order, false);
    assert.equal(request.parameters.v4_negative_prompt.use_order, true); assert.equal(request.parameters.v4_negative_prompt.legacy_uc, true);
    assert.equal(request.parameters.v4_negative_prompt.caption.char_captions[0].char_caption, characterUC);
    assert.equal(snapshot.reviewInput.authored.params.metadataReplay.keepEmptyNegativeCharacters, true);
    assert.deepEqual(snapshot.reviewInput.authored.params.metadataReplay, imported.metadataReplay);
  }
});

test('changing preset through the real builder changes the recipe identity without changing saved custom UC', async () => {
  const before = await preview('nai-diffusion-5-full', 1, { negativePrompt: 'jewelry' });
  const current = await preview('nai-diffusion-5-full', 3, { negativePrompt: 'jewelry' });
  assert.notEqual(inputHash(before.reviewInput), inputHash(current.reviewInput));
  // An identity saved before the change no longer matches what the builder produces now.
  assert.throws(() => validateRecipeResult(storedRecipe(current, inputHash(before.reviewInput))), /input hash does not match/);
  assert.equal(current.reviewInput.authored.params.negativePrompt, 'jewelry');
});

test('corrected V5 effective UC changes the identity of an old aliased build even when the authored preset ID is unchanged', async () => {
  for (const [model, preset] of [['nai-diffusion-5-full', 1], ['nai-diffusion-5-curated', 0], ['nai-diffusion-5-curated', 1], ['nai-diffusion-5-curated', 2]]) {
    const current = await preview(model, preset, { negativePrompt: 'jewelry' });
    // Reconstruct only the old alias output using the unchanged V4.5 builder.
    const legacy = await preview(model.replace('diffusion-5-', 'diffusion-4-5-'), preset, { negativePrompt: 'jewelry' });
    const old = structuredClone(current), previousUC = legacy.reviewInput.effective.request.parameters.uc;
    old.reviewInput.effective.request.parameters.uc = previousUC;
    old.reviewInput.effective.request.parameters.negative_prompt = previousUC;
    old.reviewInput.effective.request.parameters.v4_negative_prompt.caption.base_caption = previousUC;
    assert.deepEqual(old.reviewInput.authored, current.reviewInput.authored);
    assert.notEqual(inputHash(old.reviewInput), inputHash(current.reviewInput));
    assert.throws(() => validateRecipeResult(storedRecipe(current, inputHash(old.reviewInput))), /input hash does not match/);
  }
});
