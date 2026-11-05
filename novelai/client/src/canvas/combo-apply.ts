import { useAppStore } from '../store';
import { appendMaterialText, replaceMaterialStyle } from '../workspace/material-library-ui';
import type { MaterialComponent } from '../workspace/material-library-types';
import { setPromptField } from './scope';

/**
 * Applying a combo (or the library's combo tray) by the use of its members: the rules of the old composer's
 * applySelection (52baf0c workspace/MaterialLibrary.tsx), restored in the step 4b3 review rework.
 *  - Style members replace the Style as a whole (materialPrompt); without Style members the Style stays byte for byte.
 *  - Base members are appended to the positive prompt (appendMaterialText: trailing comma removed, joined by ", ").
 *  - Character members are appended to the character the user chose.
 *  - The negative prompt is never touched. Weights read w::text :: and Danbooru artists get artist: (materialPrompt).
 * Scopes: base (Txt2Img, Img2Img, Enhance, the library page), legacyInpaint (Inpaint without a separate recipe: its
 * positive prompt is the inpaint positive prompt the canvas shows, decided by the main session; Style is the shared
 * base Style; its request sends no characters), inpaint (the separate inpaint recipe, no lock, no characters).
 */
export type ComboScope = 'base' | 'legacyInpaint' | 'inpaint';
export type ComboRefusal = 'cv.combo.noChars' | 'cv.combo.pickChar' | 'cv.combo.noCharsInpaint' | 'cv.combo.noCharsLegacy' | 'cv.combo.noRecipe' | 'cv.combo.styleLocked' | 'cv.combo.badWeight' | 'cv.combo.empty';
/** The fields a combo can change; character is the chosen character's prompt (null: none chosen). */
export interface ComboFields { style: string; positive: string; character: string | null }
export type ComboPlan =
  | { ok: false; refusal: ComboRefusal }
  | { ok: true; before: ComboFields; after: ComboFields; style: boolean; positive: boolean; character: boolean };

type State = ReturnType<typeof useAppStore.getState>;

/** The current values of the fields a combo of this scope can change. */
export function readComboFields(scope: ComboScope, characterId: string | null | undefined, state: State = useAppStore.getState()): ComboFields {
  const recipe = scope === 'inpaint' ? state.inpaintRecipe : state.params;
  const character = characterId ? state.charCaptions.find(caption => caption.id === characterId) : undefined;
  return {
    style: recipe?.stylePrompt ?? '',
    positive: scope === 'legacyInpaint' ? state.inpaintPositivePrompt : recipe?.positivePrompt ?? '',
    character: character ? character.prompt : null,
  };
}

/** What applying these members would change, or why it is refused (checks in the old composer's order). */
export function planCombo(members: readonly MaterialComponent[], scope: ComboScope, characterId: string | null | undefined, state: State = useAppStore.getState()): ComboPlan {
  if (!members.length) return { ok: false, refusal: 'cv.combo.empty' };
  const hasCharacters = members.some(member => member.target === 'character');
  if (hasCharacters) {
    if (scope === 'inpaint') return { ok: false, refusal: 'cv.combo.noCharsInpaint' };
    if (scope === 'legacyInpaint') return { ok: false, refusal: 'cv.combo.noCharsLegacy' };
    if (!state.charCaptions.length) return { ok: false, refusal: 'cv.combo.noChars' };
    if (!characterId || !state.charCaptions.some(caption => caption.id === characterId)) return { ok: false, refusal: 'cv.combo.pickChar' };
  }
  if (scope === 'inpaint' && !state.inpaintRecipe) return { ok: false, refusal: 'cv.combo.noRecipe' };
  const hasStyle = members.some(member => member.target === 'style');
  if (hasStyle && scope !== 'inpaint' && state.settings?.lockStylePrompt) return { ok: false, refusal: 'cv.combo.styleLocked' };
  const before = readComboFields(scope, hasCharacters ? characterId : null, state);
  let after: ComboFields;
  try {
    after = {
      style: replaceMaterialStyle(before.style, members),
      positive: appendMaterialText(before.positive, members, 'base'),
      character: before.character === null ? null : appendMaterialText(before.character, members, 'character'),
    };
  } catch { return { ok: false, refusal: 'cv.combo.badWeight' }; }
  return { ok: true, before, after, style: after.style !== before.style, positive: after.positive !== before.positive, character: after.character !== before.character };
}

/** Writes the fields that differ from now (the Style through the lock-aware setter, as every Style edit). */
export function writeComboFields(scope: ComboScope, characterId: string | null | undefined, fields: ComboFields, state: State = useAppStore.getState()) {
  const now = readComboFields(scope, characterId, state);
  if (fields.style !== now.style) {
    if (scope === 'inpaint') state.setInpaintRecipeParam('stylePrompt', fields.style); else setPromptField('base', 'stylePrompt', fields.style);
  }
  if (fields.positive !== now.positive) {
    if (scope === 'inpaint') state.setInpaintRecipeParam('positivePrompt', fields.positive);
    else if (scope === 'legacyInpaint') state.setInpaintPositivePrompt(fields.positive);
    else setPromptField('base', 'positivePrompt', fields.positive);
  }
  if (characterId && fields.character !== null && fields.character !== now.character) state.updateCharCaption(characterId, { prompt: fields.character });
}
