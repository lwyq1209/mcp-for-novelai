import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Checkbox, Dialog, Icon, Seg, TextInput, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { relatedTags } from '../../related-tags';
import { localizedTagLabel } from '../../prompt-data';
import { splitPromptTags, parseWeightedTag, formatMultiplier, setTagLevelInPrompt } from '../../prompt-weight';
import { normalizePrompt, DEFAULT_NORMALIZE_OPTIONS, NORMALIZE_LABELS, type NormalizeOptions } from '../../prompt-normalize';
import { DEFAULT_MODEL_FOR_MODE, NAI_MODELS, supportsNAIModelMode, type GenerateParams, type ModelMode, type PromptTemplate } from '../../types';
import { naiEffortOf, supportsNAIEffort, type NAIEffort } from '../../nai-effort';
import { PromptTextarea } from '../PromptTextarea';
import { HeadAction, Section, Select, optionLabel } from '../controls';
import { StylePresetPicker } from './style-presets';
import { setPromptField, useRecipe, type PositiveOverride, type RecipeScope } from '../scope';
import { useDraftGroups, type DraftGroup } from '../draft-model';
import { DraftBadge } from '../DraftBadge';
import { PromptLibraryPicker } from '../LibraryPicker';

/** Writes a setting and reloads the settings (as the old panel did for the model family, locks and completion). */
async function writeSetting(key: string, value: unknown) {
  await window.naiDesktop.setSetting(key as never, value as never);
  await useAppStore.getState().refreshSettings();
}

/** Model: the family switch (anime / Furry, which on V4 and later adds fur dataset) and the model of that family. */
export function ModelSection() {
  const { t, language } = useUiText();
  const model = useAppStore(state => state.params.model);
  const modelMode: ModelMode = useAppStore(state => state.settings?.modelMode ?? 'anime');
  const setParam = useAppStore(state => state.setParam);
  const options = NAI_MODELS.filter(item => supportsNAIModelMode(item.value, modelMode)).map(item => {
    const label = optionLabel(language, item.value, item.label);
    return { value: item.value as GenerateParams['model'], label: label.name, hint: label.hint };
  });
  // The old panel's switchModelMode, unchanged: a modern model stays when it serves the new family.
  async function switchFamily(mode: ModelMode) {
    if (mode === modelMode) return;
    await writeSetting('modelMode', mode);
    if (!supportsNAIModelMode(useAppStore.getState().params.model, mode)) setParam('model', DEFAULT_MODEL_FOR_MODE[mode]);
    showToast({ message: t(mode === 'furry' ? 'cv.family.furryDone' : 'cv.family.animeDone') });
  }
  const marked = useDraftGroups().has('model');
  return <Section title={t('cv.model')} testId="cv-model" changed={marked} badge={marked ? <DraftBadge /> : undefined} actions={<Seg<ModelMode> size="sm" label={t('cv.family')} value={modelMode} onChange={value => void switchFamily(value)} options={[
    { value: 'anime', label: t('cv.family.anime') }, { value: 'furry', label: t('cv.family.furry') },
  ]} />}>
    <Select<GenerateParams['model']> label={t('cv.model')} value={model} options={options} onChange={value => setParam('model', value)} testId="cv-model-select" />
    <EffortToggle executionModel={model} />
  </Section>;
}

/**
 * V5 Full's Effort toggle (official 2026-10-08, src/nai-effort.ts): High is the full model, Medium the distilled one
 * with fixed steps, sampler and UC. Shown only for an execution model that has it (V5 Full, V5 Full inpainting);
 * scope picks the recipe it sets (the separate inpaint recipe, or the shared base parameters).
 */
export function EffortToggle({ executionModel, scope = 'base' }: { executionModel: string; scope?: RecipeScope }) {
  const { t } = useUiText();
  const { params, setParam } = useRecipe(scope);
  if (!supportsNAIEffort(executionModel)) return null;
  const effort = naiEffortOf(params, executionModel);
  return <div className="cv-switch-row" data-testid="cv-effort" title={t('cv.effort.tip')}>
    <div className="cv-grow"><b>{t('cv.effort')}</b><small className="ui-faint">{t(effort === 'medium' ? 'cv.effort.fixed' : 'cv.effort.hint')}</small></div>
    <Seg<NAIEffort> size="sm" label={t('cv.effort')} value={effort} onChange={value => setParam('effort', value === 'medium' ? 'medium' : 'high')} options={[
      { value: 'high', label: t('cv.effort.high') }, { value: 'medium', label: t('cv.effort.medium') },
    ]} />
  </div>;
}

/** The lock of the Style or the negative prompt (the old toggleLock): saving the text keeps it over resets and templates. */
export function useFieldLock(which: 'style' | 'neg') {
  const { t } = useUiText();
  const locked = useAppStore(state => (which === 'style' ? state.settings?.lockStylePrompt : state.settings?.lockNegativePrompt) ?? false);
  async function toggle() {
    const state = useAppStore.getState();
    const next = !locked;
    if (next) await window.naiDesktop.setSetting(which === 'style' ? 'savedStylePrompt' : 'savedNegativePrompt', which === 'style' ? state.params.stylePrompt : state.params.negativePrompt);
    await writeSetting(which === 'style' ? 'lockStylePrompt' : 'lockNegativePrompt', next);
    showToast({ message: t(next ? 'cv.lockedDone' : 'cv.unlockedDone') });
  }
  return { locked, toggle };
}

/** Reads a prompt field of a scope now (the library picker's undo checks it; legacy: the inpaint positive prompt). */
export function fieldReader(scope: RecipeScope, field: 'positive' | 'negative', legacy = false) {
  return () => {
    const state = useAppStore.getState();
    const recipe = scope === 'inpaint' && state.inpaintRecipe ? state.inpaintRecipe : state.params;
    if (field === 'positive') return legacy ? state.inpaintPositivePrompt : recipe.positivePrompt;
    return recipe.negativePrompt;
  };
}

/**
 * Positive / negative prompt with completion, the preset and chunk controls, templates, weights, tidy-up and counts.
 * scope picks the recipe (the separate inpaint recipe has no locks); positive overrides the positive prompt (legacy
 * inpaint's own prompt beside the shared base fields), as the old PromptAndParams promptOverride did.
 */
export function PromptSection({ scope = 'base', positive: override, draftGroup = 'prompt', effortModel }: { scope?: RecipeScope; positive?: PositiveOverride; draftGroup?: DraftGroup | DraftGroup[]; effortModel?: string } = {}) {
  const { t, language } = useUiText();
  const tab = useAppStore(state => state.promptTab);
  const setTab = useAppStore(state => state.setPromptTab);
  const { params } = useRecipe(scope);
  const positive = override ? override.value : params.positivePrompt;
  const negative = params.negativePrompt;
  const model = params.model;
  // Medium effort sends no negative prompt; the field stays editable for High (src/nai-effort.ts).
  const medium = naiEffortOf(params, effortModel ?? model) === 'medium';
  const drafted = useDraftGroups();
  const marked = (Array.isArray(draftGroup) ? draftGroup : [draftGroup]).some(group => drafted.has(group));
  const autoComplete = useAppStore(state => state.settings?.autoComplete ?? true);
  const negLock = useFieldLock('neg');
  const lockable = scope === 'base';
  const setPositive = (next: string) => { if (override) override.onChange(next); else setPromptField(scope, 'positivePrompt', next); };
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  // The two head entries open one picker (prototype 13: 预设 · 素材库): on the prompt presets, or on the tags.
  const libraryButton = useRef<HTMLButtonElement>(null), presetsButton = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState<'' | 'presets' | 'library'>('');
  // The picker keeps its key when it closes (step 4c1): its own dialogs opened from it (a prompt preset's images,
  // 保存当前为正文预设) outlive the popover; a different picker (presets / library) or tab still starts fresh.
  const lastPicker = useRef(picker);
  if (picker) lastPicker.current = picker;
  const isPositive = tab === 'positive';
  const value = isPositive ? positive : negative;
  const key = isPositive ? 'positivePrompt' : 'negativePrompt';
  const setValue = (next: string) => { if (isPositive) setPositive(next); else setPromptField(scope, key, next); };
  const weightTags = useMemo(() => splitPromptTags(value).map(segment => parseWeightedTag(segment)), [value]);
  const related = useMemo(() => relatedTags(positive, 8), [positive]);
  const tagCount = useMemo(() => value.trim().split(',').filter(part => part.trim().length > 0).length, [value]);
  const charCount = useMemo(() => Array.from(value).length, [value]);

  async function toggleAutoComplete() {
    const next = !autoComplete;
    await writeSetting('autoComplete', next);
    showToast({ message: t(next ? 'cv.ac.onDone' : 'cv.ac.offDone') });
  }
  // The old applyTemplate, unchanged: prefix, current prompt, suffix joined by ", "; the template's negative prompt
  // replaces the negative one unless the base one is locked (the separate inpaint recipe has no lock).
  function applyTemplate(template: PromptTemplate) {
    const state = useAppStore.getState();
    const parts = [template.prefix.trim(), positive.trim(), template.suffix.trim()].filter(Boolean);
    setPositive(parts.join(', '));
    if (template.negativePrompt.trim() && (scope === 'inpaint' || !(state.settings?.lockNegativePrompt ?? false))) {
      if (scope === 'inpaint') state.setInpaintRecipeParam('negativePrompt', template.negativePrompt.trim());
      else state.setParam('negativePrompt', template.negativePrompt.trim());
    }
    showToast({ message: t('cv.templateDone', { name: template.name }) });
  }
  function appendChip(tag: string) {
    const current = value.trim();
    setValue(current ? `${current.replace(/\s*,?\s*$/, '')}, ${tag}, ` : `${tag}, `);
  }

  return <Section testId="cv-prompt" title={t('cv.prompt')} changed={marked} badge={marked ? <DraftBadge /> : undefined} actions={<>
    {!isPositive && lockable && <HeadAction icon={negLock.locked ? 'lock' : 'unlock'} pressed={negLock.locked} title={t('cv.lockTip')} onClick={() => void negLock.toggle()}>{t(negLock.locked ? 'cv.unlock' : 'cv.lock')}</HeadAction>}
    <HeadAction buttonRef={presetsButton} icon="preset" pressed={picker === 'presets'} title={t('cv.presetsTip')} onClick={() => setPicker(open => open === 'presets' ? '' : 'presets')} testId="cv-prompt-presets">{t('cv.presets')}</HeadAction>
    <HeadAction buttonRef={libraryButton} icon="library" pressed={picker === 'library'} title={t('cv.fromLibTip')} onClick={() => setPicker(open => open === 'library' ? '' : 'library')} testId="cv-prompt-library">{t('cv.fromLib')}</HeadAction>
  </>}>
    <Seg<'positive' | 'negative'> full label={t('cv.tab.label')} value={tab} onChange={setTab} options={[
      { value: 'positive', label: t('cv.tab.pos') }, { value: 'negative', label: <>{t('cv.tab.neg')}{lockable && negLock.locked ? <Icon name="lock" size={12} /> : null}</> },
    ]} />
    <div className="cv-pbox">
      <PromptTextarea value={value} onChange={setValue} model={model} enabled={autoComplete} rows={5} testId={isPositive ? 'cv-positive' : 'cv-negative'}
        ariaLabel={t(isPositive ? 'cv.tab.pos' : 'cv.tab.neg')} placeholder={t(isPositive ? 'cv.posPlaceholder' : 'cv.negPlaceholder')} className="cv-prompt-text" />
      <div className="cv-pfoot">
        <button type="button" className="cv-hact" onClick={() => setTidyOpen(true)} disabled={!value.trim()}><Icon name="wand" size={13} />{t('cv.tidy')}</button>
        <button type="button" className={clsx('cv-hact', weightsOpen && 'is-on')} aria-pressed={weightsOpen} title={t('cv.weightsTip')} onClick={() => setWeightsOpen(open => !open)} disabled={weightTags.length === 0}><Icon name="filter" size={13} />{t('cv.weights')}</button>
        <button type="button" className={clsx('cv-hact', autoComplete && 'is-on')} aria-pressed={autoComplete} title={t('cv.ac.tip')} onClick={() => void toggleAutoComplete()}>{t(autoComplete ? 'cv.ac.on' : 'cv.ac.off')}</button>
        <span className="cv-count ui-faint" title={t('cv.wildcard')}>{t('cv.counts', { n: tagCount, c: charCount })}</span>
      </div>
    </div>
    {medium && !isPositive && <p className="cv-note cv-note--warn" data-testid="cv-effort-neg">{t('cv.effort.negIgnored')}</p>}
    {weightsOpen && weightTags.length > 0 && <div className="cv-weights" data-testid="cv-weights">
      {weightTags.map((tag, index) => <div key={`${tag.core}-${index}`} className={clsx('cv-weight', tag.level > 0 && 'is-up', tag.level < 0 && 'is-down')}>
        <button type="button" aria-label={t('cv.weightDown', { tag: tag.core })} onClick={() => setValue(setTagLevelInPrompt(value, index, tag.level - 1))}><Icon name="minus" size={12} /></button>
        <span title={tag.raw}>{tag.core || t('cv.emptyTag')}{tag.level !== 0 && <em>{formatMultiplier(tag.level)}</em>}</span>
        <button type="button" aria-label={t('cv.weightUp', { tag: tag.core })} onClick={() => setValue(setTagLevelInPrompt(value, index, tag.level + 1))}><Icon name="plus" size={12} /></button>
      </div>)}
    </div>}
    {related.length > 0 && <div className="cv-related">
      <button type="button" className="cv-related-head" aria-expanded={relatedOpen} onClick={() => setRelatedOpen(open => !open)}><Icon name={relatedOpen ? 'down' : 'right'} size={13} />{t('cv.related')}</button>
      {relatedOpen && <div className="cv-chips">{related.map(item => <button key={item.tag} type="button" className="cv-chip" aria-label={t('cv.relatedAdd', { tag: item.tag })} title={`${item.tag}: ${localizedTagLabel(item.tag, item.zh, language)}`} onClick={() => appendChip(item.tag)}>
        <span>{item.tag}</span><small>{localizedTagLabel(item.tag, item.zh, language)}</small>
      </button>)}</div>}
    </div>}
    <PromptLibraryPicker key={`${lastPicker.current}-${tab}`} open={!!picker} anchor={picker === 'presets' ? presetsButton : libraryButton} onClose={() => setPicker('')} initialTab={picker === 'presets' ? 'presets' : 'tags'}
      field={isPositive ? 'positive' : 'negative'} scope={scope} comboScope={scope === 'inpaint' ? 'inpaint' : override ? 'legacyInpaint' : 'base'}
      value={value} read={fieldReader(scope, isPositive ? 'positive' : 'negative', !!override)} onChange={setValue} onTemplate={isPositive ? applyTemplate : undefined} />
    <TidyDialog open={tidyOpen} value={value} onClose={() => setTidyOpen(false)} onApply={next => { setValue(next); setTidyOpen(false); showToast({ message: t('cv.tidy.done') }); }} />
  </Section>;
}

/** The old PromptNormalizeModal: the same options and normalizePrompt, with a preview of the result. */
function TidyDialog({ open, value, onClose, onApply }: { open: boolean; value: string; onClose(): void; onApply(next: string): void }) {
  const { t } = useUiText();
  const [options, setOptions] = useState<NormalizeOptions>(DEFAULT_NORMALIZE_OPTIONS);
  const preview = useMemo(() => normalizePrompt(value, options), [value, options]);
  return <Dialog open={open} onClose={onClose} title={t('cv.tidy.title')} width={560} footer={<>
    <Button onClick={onClose}>{t('c.cancel')}</Button>
    <Button variant="primary" disabled={!preview.trim()} onClick={() => onApply(preview)}>{t('cv.tidy.apply')}</Button>
  </>}>
    <div className="cv-tidy">
      <div className="cv-tidy-opts">{NORMALIZE_LABELS.map(({ key }) => <label key={key} className="cv-check"><Checkbox checked={options[key]} label={t(`cv.tidy.${key}` as never)} onChange={next => setOptions(current => ({ ...current, [key]: next }))} /><span>{t(`cv.tidy.${key}` as never)}</span></label>)}</div>
      <div className="cv-tidy-prev"><small className="ui-faint">{t('cv.tidy.preview')}</small><div className="cv-tidy-box ui-mono">{preview || t('cv.tidy.empty')}</div></div>
    </div>
  </Dialog>;
}

/** Style: one line with its lock; presets open a picker with the saved Style presets and their preview images. */
export function StyleSection({ scope = 'base' }: { scope?: RecipeScope } = {}) {
  const { t } = useUiText();
  const { params } = useRecipe(scope);
  const style = params.stylePrompt;
  const lock = useFieldLock('style');
  const lockable = scope === 'base';
  const marked = useDraftGroups().has(scope === 'inpaint' ? 'inpaintStyle' : 'style');
  const presetsButton = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  return <Section testId="cv-style" title={t('cv.style')} changed={marked} badge={marked ? <DraftBadge /> : undefined} actions={<HeadAction buttonRef={presetsButton} icon="preset" pressed={pickerOpen} onClick={() => setPickerOpen(open => !open)}>{t('cv.presets')}</HeadAction>}>
    <div className="cv-stylebox">
      <TextInput className="cv-style-input ui-mono" value={style} aria-label={t('cv.style')} placeholder={t('cv.stylePlaceholder')} data-testid="cv-style-input" onChange={event => setPromptField(scope, 'stylePrompt', event.target.value)} />
      {lockable && <button type="button" className={clsx('cv-iconbtn', lock.locked && 'is-on')} aria-pressed={lock.locked} aria-label={t(lock.locked ? 'cv.unlock' : 'cv.lock')} title={t('cv.lockTip')} onClick={() => void lock.toggle()}><Icon name={lock.locked ? 'lock' : 'unlock'} size={14} /></button>}
    </div>
    <StylePresetPicker scope={scope} open={pickerOpen} anchor={presetsButton} onClose={() => setPickerOpen(false)} />
  </Section>;
}
