import { useAppStore } from '../store';
import { supportsNAICharacterPrompts, supportsNAIPreciseReference, supportsNAIVibeTransfer, type GenerateParams, type HistoryItem, type NaiDesktopApi } from '../types';
import { appendPromptChunk } from '../prompt-chunks';
import type { AssetItem } from './types';

/** Which prompt field an item goes into when it is used on the canvas. */
export type MaterialApplicationTarget = { field?: 'style' | 'positive' | 'negative' | 'character' | 'reference'; characterId?: string };

type Scope = 'base' | 'inpaint';
function promptTarget(target?: MaterialApplicationTarget) {
  const field = target?.field ?? 'positive';
  return ['positive', 'negative', 'character'].includes(field) ? field as 'positive' | 'negative' | 'character' : null;
}

export function assetApplicationLabel(item: AssetItem, scope: Scope, target?: MaterialApplicationTarget) {
  if (item.archived) return '';
  const prefix = scope === 'inpaint' ? '重绘' : '基础';
  if (item.kind === 'style_preset') return `替换${prefix}风格`;
  if (item.kind === 'positive_preset' || item.kind === 'prompt_chunk') {
    const field = promptTarget(target);
    if (!field || (field === 'character' && scope === 'inpaint')) return '';
    const destination = field === 'character' ? `${prefix}角色正文` : `${prefix}${field === 'negative' ? '负面' : '正文'}`;
    return item.kind === 'prompt_chunk' ? `追加片段到${destination}` : `替换${destination}`;
  }
  if (scope === 'base') {
    if (item.kind === 'artist_favorite') return '应用收藏配方';
    if (item.kind === 'reference_preset') return '加入基础参考图';
  }
  // Browsing history belongs to the independent material preview. Explicit
  // image operations are provided by the shared ImageActions component.
  return '';
}

/**
 * The Txt2Img settings an artist pick applies: its image's parameters with the pick's base prompt, its artist recipe
 * as Style, its model and its seed fixed. null when the pick has no complete recipe (no image with parameters).
 */
export function artistFavoriteRecipe(payload: AssetItem['payload'] | null | undefined): Partial<GenerateParams> | null {
  const image = payload?.image as HistoryItem | undefined;
  if (!image?.params) return null;
  return { ...image.params, positivePrompt: payload!.basePrompt, stylePrompt: payload!.prompt, seedMode: 'fixed', seed: payload!.generationSeed ?? image.actualSeed ?? image.params.seed, model: (payload!.generationModel ?? image.model) as GenerateParams['model'] };
}

/**
 * A refusal of applyLibraryItem: an English message with a reason the window renders in its language (catalog:
 * src/host-errors/library.ts, library.apply_*; step 4c1).
 */
const refused = (reason: string, message: string, params?: Record<string, string>) => Object.assign(new Error(message), { code: 'apply_refused', reason, ...(params ? { params } : {}) });

/** Existing store actions remain responsible for recipe/reference behavior. */
export async function applyLibraryItem(item: AssetItem, scope: Scope, store: ReturnType<typeof useAppStore.getState>, api: Pick<NaiDesktopApi, 'readReferencePreset' | 'setSetting'>, target?: MaterialApplicationTarget) {
  if (scope === 'inpaint' && target?.field === 'character' && ['positive_preset','prompt_chunk'].includes(item.kind)) throw refused('library.apply_inpaint_no_character', 'The separate inpaint settings have no character field; the base characters were not changed. Pick the inpaint prompt instead.');
  if (!assetApplicationLabel(item, scope, target)) throw refused('library.apply_no_entry', 'Use this item from its own place on the canvas.');
  const payload = item.payload;
  if (item.kind === 'reference_preset') {
    const supported = (model: string) => payload.kind === 'vibe' ? supportsNAIVibeTransfer(model) : supportsNAIPreciseReference(model);
    const ensureSupported = (model: string) => { if (!supported(model)) throw payload.kind === 'vibe' ? refused('library.apply_model_no_vibe', 'The current model does not support Vibe Transfer; choose a model that does first.') : refused('library.apply_model_no_precise', 'The current model does not support precise references; choose a model that does first.'); };
    ensureSupported(store.params.model);
    const live = useAppStore.getState() === store;
    const result = await api.readReferencePreset(item.id);
    // The host's own refusal (code/reason/params) when it gave one, else this one.
    if (!result.ok || !result.preset || !result.base64) throw (result as { reason?: unknown }).reason || (result as { code?: unknown }).code ? Object.assign(new Error(result.message || 'The reference image could not be read.'), result) : refused('library.apply_reference_unreadable', 'The reference image could not be read.');
    // The reader supplies bytes only. Authored parameters come from the
    // selected immutable material version, never the latest preset object.
    if (payload.filePath !== result.preset.filePath) throw refused('library.apply_reference_changed', 'The image this version recorded has changed and the current one is not used in its place; check the item first.');
    const current = live ? useAppStore.getState() : store;
    ensureSupported(current.params.model);
    const id = crypto.randomUUID(), previewUrl = result.preset.fileUrl;
    if (payload.kind === 'vibe') current.addVibeImage({ id, previewUrl, base64: result.base64, infoExtracted: payload.infoExtracted, strength: payload.strength });
    else current.addPreciseReference({ id, previewUrl, base64: result.base64, type: payload.preciseType, strength: payload.strength, fidelity: payload.fidelity, informationExtracted: 1, srcWidth: payload.width, srcHeight: payload.height });
    return '已加入基础参考图，采用所选素材版本的参数，尚未生成。';
  }
  if (item.kind === 'artist_favorite') {
    const recipe = artistFavoriteRecipe(payload);
    if (!recipe) throw refused('library.apply_no_recipe', 'This pick has no complete recipe (an image with its settings).');
    store.applyParams(recipe);
    return '已应用收藏配方与固定种子，尚未生成。';
  }
  const recipe = scope === 'inpaint' ? store.inpaintRecipe : store.params;
  if (!recipe) throw refused('library.apply_no_inpaint_recipe', 'Turn on separate inpaint settings first.');
  const field = item.kind === 'style_preset' ? 'style' : promptTarget(target);
  if (field === 'character') {
    if (!supportsNAICharacterPrompts(recipe.model)) throw refused('library.apply_model_no_characters', 'The current model does not support character prompts; choose a model that does first.');
    const character = store.charCaptions.find(value => value.id === target?.characterId);
    if (!character) throw refused('library.apply_character_gone', 'The character chosen before is no longer there; choose it again.');
    const text = item.kind === 'prompt_chunk' ? appendPromptChunk(character.prompt, payload.content) : payload.prompt;
    store.updateCharCaption(character.id, { prompt: text });
  } else {
    const key = field === 'style' ? 'stylePrompt' : field === 'negative' ? 'negativePrompt' : 'positivePrompt';
    const text = item.kind === 'prompt_chunk' ? appendPromptChunk(recipe[key], payload.content) : payload.prompt;
    // The existing Style preset picker also updates the saved locked text.
    if (scope === 'base' && key === 'stylePrompt' && store.settings?.lockStylePrompt) await api.setSetting('savedStylePrompt', text);
    if (scope === 'inpaint') store.setInpaintRecipeParam(key, text);
    else store.setParam(key, text);
  }
  return `${assetApplicationLabel(item, scope, target)}完成，尚未生成。`;
}
