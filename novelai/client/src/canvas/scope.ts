import { useCallback } from 'react';
import { useAppStore } from '../store';
import type { GenerateParams } from '../types';

/**
 * Which recipe a section edits (the old PromptAndParams paramsScope): base = the canvas's parameters (Txt2Img,
 * Img2Img, Enhance and the shared fields of the legacy inpaint); inpaint = the separate inpaint recipe, when it exists.
 */
export type RecipeScope = 'base' | 'inpaint';

/** The recipe of a scope and its setter (the old useScopedParams, unchanged). */
export function useRecipe(scope: RecipeScope) {
  const base = useAppStore(state => state.params);
  const recipe = useAppStore(state => state.inpaintRecipe);
  const setParam = useCallback(<K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => {
    const state = useAppStore.getState();
    if (scope === 'inpaint') state.setInpaintRecipeParam(key, value);
    else state.setParam(key, value);
  }, [scope]);
  return { params: scope === 'inpaint' && recipe ? recipe : base, setParam };
}

/**
 * The old setLockedAwareParam: a text field of a scope. In the base recipe a locked Style or negative prompt also
 * updates its saved copy; the separate inpaint recipe has no locks.
 */
export function setPromptField(scope: RecipeScope, key: 'stylePrompt' | 'positivePrompt' | 'negativePrompt', value: string) {
  const state = useAppStore.getState();
  if (scope === 'inpaint') { state.setInpaintRecipeParam(key, value); return; }
  state.setParam(key, value);
  if (key === 'stylePrompt' && state.settings?.lockStylePrompt) void window.naiDesktop.setSetting('savedStylePrompt', value);
  else if (key === 'negativePrompt' && state.settings?.lockNegativePrompt) void window.naiDesktop.setSetting('savedNegativePrompt', value);
}

/** An override of the positive prompt (legacy inpaint: its own positive prompt beside the shared base fields). */
export interface PositiveOverride { value: string; onChange(next: string): void }
