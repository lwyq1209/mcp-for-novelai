import { useAppStore } from '../store';
import { supportsNAIModelMode, type GenerateParams, type ModelMode, type NaiDesktopApi, type StylePromptPreset } from '../types';
import { stylePresetApplication } from '../style-preset';
import type { RecipeScope } from './scope';

/** How a Style preset is applied on the canvas, as the user last chose (two settings). */
export interface StylePresetApplyOptions { withParams: boolean; allowText: boolean }
export const stylePresetApplyOptions = (settings: { stylePresetApplyParams?: boolean; stylePresetAllowText?: boolean } | null | undefined): StylePresetApplyOptions =>
  ({ withParams: settings?.stylePresetApplyParams === true, allowText: settings?.stylePresetAllowText === true });

type Store = Pick<ReturnType<typeof useAppStore.getState>, 'settings' | 'inpaintRecipe' | 'setParam' | 'setInpaintRecipeParam'>;

/**
 * Applies a Style preset to the recipe of a scope (issue #1), from the canvas's own picker and from the library: its
 * style (enabled artists, then its prompt) replaces the Style; its negative text replaces the negative prompt when
 * the preset has any that takes effect (a preset without negative text leaves the negative prompt alone); with
 * `withParams` its recommended sampling settings are set too. The size, the prompt, the characters and the seed are
 * never touched. In the base recipe a locked Style or negative prompt also updates its saved copy, as any edit of it
 * does (a failure there is thrown before anything is changed). The separate inpaint recipe follows the inpaint model, so a recommended model is not applied there.
 * Returns what was written, for the message.
 */
export async function applyStylePresetToCanvas(preset: Pick<StylePromptPreset, 'prompt' | 'artists' | 'negativePrompt' | 'textNegativePrompt' | 'params'>, scope: RecipeScope, options: StylePresetApplyOptions,
  store: Store = useAppStore.getState(), api: Pick<NaiDesktopApi, 'setSetting'> = window.naiDesktop) {
  const application = stylePresetApplication(preset, options), inpaint = scope === 'inpaint' && !!store.inpaintRecipe;
  const write = <K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => { if (inpaint) store.setInpaintRecipeParam(key, value); else store.setParam(key, value); };
  // A locked field's saved copy is written first: when that fails, nothing of the recipe has changed.
  if (!inpaint && store.settings?.lockStylePrompt) await api.setSetting('savedStylePrompt', application.stylePrompt);
  if (!inpaint && store.settings?.lockNegativePrompt && application.negativePrompt !== undefined) await api.setSetting('savedNegativePrompt', application.negativePrompt);
  write('stylePrompt', application.stylePrompt);
  if (application.negativePrompt !== undefined) write('negativePrompt', application.negativePrompt);
  const params: (keyof GenerateParams)[] = [];
  for (const [key, value] of Object.entries(application.params) as [keyof GenerateParams, never][]) {
    if (key === 'model') {
      if (inpaint) continue;
      // A model of the other family (anime / furry) switches the family too, as choosing it by hand would.
      const mode: ModelMode = store.settings?.modelMode ?? 'anime';
      if (!supportsNAIModelMode(value, mode)) {
        const next: ModelMode = mode === 'anime' ? 'furry' : 'anime';
        if (!supportsNAIModelMode(value, next)) continue;
        await api.setSetting('modelMode', next);
      }
    }
    write(key, value);
    params.push(key);
  }
  return { negative: application.negativePrompt !== undefined, params };
}
