import { readCharacterSnapshot } from './character-snapshot';
import { plainErrorMessage } from './host-errors/bridge';
import Ajv, { type AnySchema } from 'ajv';
import contracts from './generated/library-contracts.json';
import { maxNAICharacterPrompts, normalizeGenerateParams, type CharCaptionItem, type CharCaption, type GenerateParams, type HistoryItem } from './types';
import { historyRecoveryIsBusy, useAppStore } from './store';
import { uiLangOf, uiText, type UiLang, type UiParams } from './ui/i18n';
import type { UiStringKey } from './ui/strings';

/** The label of each saved field, as a key of LEGACY_STRINGS (rendered in the interface language). */
export const HISTORY_PARAMETER_LABELS: Record<keyof GenerateParams, UiStringKey> = {
  model: 'hp.f.model', stylePrompt: 'hp.f.stylePrompt', positivePrompt: 'hp.f.positivePrompt', negativePrompt: 'hp.f.negativePrompt',
  width: 'hp.f.width', height: 'hp.f.height', steps: 'hp.f.steps', cfgScale: 'hp.f.cfgScale', cfgRescale: 'hp.f.cfgRescale',
  sampler: 'hp.f.sampler', noiseSchedule: 'hp.f.noiseSchedule', seed: 'hp.f.seed', seedMode: 'hp.f.seedMode',
  ucPreset: 'hp.f.ucPreset', qualityPreset: 'hp.f.qualityPreset', qualityToggle: 'hp.f.qualityToggle',
  transparentBackground: 'hp.f.transparentBackground', smea: 'hp.f.smea', smeaDyn: 'hp.f.smeaDyn', variety: 'hp.f.variety',
  fileNamePrefix: 'hp.f.fileNamePrefix', preservePromptText: 'hp.f.preservePromptText', promptAssemblyVersion: 'hp.f.promptAssemblyVersion', metadataReplay: 'hp.f.metadataReplay',
};
/** A text of this dialog: a copy key with its params, rendered when shown so a language switch re-renders it. */
export type HistoryText = { key: UiStringKey; params?: UiParams };
/** An error with the copy key it renders with; its message is the English text. */
export type HistoryParameterError = Error & { uiKey: UiStringKey; uiParams?: UiParams };
export const historyText = (lang: UiLang, text: HistoryText) => uiText(lang, text.key, text.params);
export const historyTextList = (lang: UiLang, texts: readonly HistoryText[]) => texts.map(text => historyText(lang, text)).join(lang === 'zh' ? '、' : ', ');
const historyError = (text: HistoryText): HistoryParameterError => Object.assign(new Error(historyText('en', text)), { uiKey: text.key, ...(text.params ? { uiParams: text.params } : {}) });
const labelOf = (key: string): HistoryText => {
  const label = (HISTORY_PARAMETER_LABELS as Record<string, UiStringKey | undefined>)[key];
  return label ? { key: label } : { key: 'hp.raw', params: { text: key } };
};
const textOfError = (error: unknown): HistoryText => {
  const { uiKey, uiParams } = (error ?? {}) as { uiKey?: UiStringKey; uiParams?: UiParams };
  return uiKey ? { key: uiKey, ...(uiParams ? { params: uiParams } : {}) } : { key: 'hp.raw', params: { text: plainErrorMessage(error) } };
};
// The complete parameters a new generation saves: its required fields are the ones an older record may lack.
const schema = contracts.schemas.generatedHistoryPayload.properties.params;
const ajv = new Ajv({ strict: false });
const validators = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, ajv.compile(value as AnySchema)]));
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const validSeed = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
type Field = { key: keyof GenerateParams; label: HistoryText; saved: unknown; applied: unknown };
export interface HistoryParameterPlan {
  patch: Partial<GenerateParams>;
  fields: Field[];
  missing: HistoryText[];
  invalid: HistoryText[];
  actualSeed: number | null;
  /** null = nothing blocks applying. */
  blocked: HistoryText | null;
  modeNotice: HistoryText;
  baseline: string;
  /** undefined = legacy unknown; [] = explicitly no characters. */
  characters?: CharCaptionItem[];
  characterBaseline: string;
  characterTarget: string | undefined;
}

/** Legacy rows stay sparse: absent fields never acquire invented historical values. */
export function planHistoryParameters(item: HistoryItem, current: GenerateParams, currentCharacters: CharCaption[] = useAppStore.getState().charCaptions): HistoryParameterPlan {
  const saved = item.params && typeof item.params === 'object' ? item.params : {} as Partial<GenerateParams>;
  const patch: Partial<GenerateParams> = {}, missing: HistoryText[] = [], invalid: HistoryText[] = [];
  const mode = item.generationOrigin?.mode ?? item.feature;
  const postprocess = item.generationOrigin?.actualSeed === null || mode === 'upscale' || mode === 'director' || /^(upscale|director)(-|$)/i.test(item.model);
  for (const [key, validate] of Object.entries(validators)) {
    if (!own(saved, key)) { if (schema.required.includes(key)) missing.push(labelOf(key)); continue; }
    const value = saved[key as keyof GenerateParams];
    if (validate(value)) Object.assign(patch, { [key]: structuredClone(value) });
    else invalid.push(labelOf(key));
  }
  const actualSeed = !postprocess && validSeed(item.actualSeed) ? item.actualSeed : null;
  if (actualSeed !== null) {
    patch.seed = actualSeed; patch.seedMode = 'fixed';
    for (const label of [HISTORY_PARAMETER_LABELS.seed, HISTORY_PARAMETER_LABELS.seedMode]) {
      const index = missing.findIndex(text => text.key === label); if (index >= 0) missing.splice(index, 1);
    }
  }
  else {
    // params.seed can be merely the seed before randomization. Never call it the actual seed.
    delete patch.seed; delete patch.seedMode;
    missing.push({ key: 'hp.f.actualSeed' });
  }
  // These optional flags are overrides, not ordinary fields. Absence means the
  // saved author parameters had no override; do not borrow another PNG's flags.
  if (!own(saved, 'metadataReplay')) patch.metadataReplay = undefined;
  if (!own(saved, 'preservePromptText')) patch.preservePromptText = false;
  if (!own(saved, 'promptAssemblyVersion')) patch.promptAssemblyVersion = undefined;
  if (!own(saved, 'qualityPreset') && typeof patch.qualityToggle === 'boolean') {
    patch.qualityPreset = patch.qualityToggle ? current.qualityPreset === 'none' ? 'standard' : current.qualityPreset : 'none';
    const index = missing.findIndex(text => text.key === HISTORY_PARAMETER_LABELS.qualityPreset); if (index >= 0) missing.splice(index, 1);
  }
  const normalized = normalizeGenerateParams({ ...current, ...patch });
  let characters: CharCaptionItem[] | undefined, characterError: HistoryText | null = null;
  if (own(item, 'characterSnapshot')) {
    try {
      characters = readCharacterSnapshot(item.characterSnapshot).captions;
      if (characters.length > maxNAICharacterPrompts(normalized.model)) characterError = { key: 'hp.tooManyChars' };
    } catch (error) { characterError = textOfError(error); }
  }
  const fields = (Object.keys(patch) as Array<keyof GenerateParams>).map(key => ({
    key, label: labelOf(key), saved: saved[key], applied: normalized[key],
  }));
  const applicable = fields.filter(field => own(saved, field.key) && !['seed', 'seedMode'].includes(field.key));
  const invalidAssembly = own(saved, 'promptAssemblyVersion') && saved.promptAssemblyVersion !== 1;
  return {
    patch, fields, missing: missing.filter((text, index) => missing.findIndex(other => same(other, text)) === index), invalid, actualSeed,
    blocked: characterError ?? (invalidAssembly ? { key: 'hp.badAssembly' } : postprocess ? { key: 'hp.postprocess' } : !applicable.length ? { key: 'hp.nothing' } : null),
    modeNotice: { key: mode === 'inpaint' ? 'hp.mode.inpaint' : mode === 'i2i' || mode === 'enhance' ? 'hp.mode.source' : mode === 't2i' ? 'hp.mode.t2i' : 'hp.mode.unknown' },
    baseline: JSON.stringify(current), characters, characterBaseline: JSON.stringify(currentCharacters), characterTarget: JSON.stringify(characters),
  };
}

export function historyPlanIsStale(plan: HistoryParameterPlan, current: GenerateParams, characters: CharCaption[] = useAppStore.getState().charCaptions) {
  return plan.baseline !== JSON.stringify(current) || plan.characterBaseline !== JSON.stringify(characters);
}

/** Applying params deliberately uses no file/metadata/asset lookup and never generates. */
export async function applyHistoryParameters(plan: HistoryParameterPlan): Promise<string> {
  const state = useAppStore.getState();
  if (plan.blocked) throw historyError(plan.blocked);
  if (historyRecoveryIsBusy(state)) throw historyError({ key: 'hp.generating' });
  if (historyPlanIsStale(plan, state.params)) throw historyError({ key: 'hp.changedParams' });
  const next = normalizeGenerateParams({ ...state.params, ...plan.patch });
  if (!plan.fields.every(field => same(next[field.key], field.applied))) throw historyError({ key: 'hp.changedPlan' });
  if (plan.characterTarget !== JSON.stringify(plan.characters)) throw historyError({ key: 'hp.changedChars' });
  const characters = plan.characters === undefined ? undefined : readCharacterSnapshot({ version: 1, captions: plan.characters }).captions;
  if (characters && characters.length > maxNAICharacterPrompts(next.model)) throw historyError({ key: 'hp.tooManyChars' });
  state.applyHistoricalParams(plan.patch, characters);
  state.setActiveTab('generate');
  // The notice goes into the status line and toast as text, in the language at the moment of applying.
  const lang = uiLangOf(state.settings?.language);
  let notice = uiText(lang, 'hp.done', { chars: characters === undefined ? uiText(lang, 'hp.doneLegacyChars') : uiText(lang, 'hp.doneChars', { n: characters.length }) });
  if (state.settings?.lockStylePrompt && own(plan.patch, 'stylePrompt')) {
    useAppStore.setState({ settings: { ...useAppStore.getState().settings!, savedStylePrompt: next.stylePrompt } });
    try { await window.naiDesktop.setSetting('savedStylePrompt', next.stylePrompt); }
    catch { notice += ` ${uiText(lang, 'hp.styleLockFailed')}`; }
  }
  useAppStore.setState({ statusText: notice, toast: notice });
  return notice;
}
