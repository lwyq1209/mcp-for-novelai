import { useState } from 'react';
import clsx from 'clsx';
import { Button, ConfirmDialog, Disclosure, Icon, MenuButton, Seg, Toggle, showToast, type MenuEntry } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import {
  DEFAULT_PARAMS, MAX_NAI_SEED, NAI_SAMPLERS, NAI_UC_PRESETS, isNAIV4PlusModel, isNAIV5Model, supportsNAINoiseScheduleControl, supportsNAIVariety,
  type GenerateParams, type QualityPreset,
} from '../../types';
import { adaptiveNAIImageSize, maxNAIDimensionFor, NAI_DIMENSION_STEP, NAI_MIN_DIMENSION, snapNAIDimensionWithinArea } from '../../nai-dimensions';
import { Labeled, NumberField, Section, Select, SliderField, optionLabel } from '../controls';
import { useRecipe, type RecipeScope } from '../scope';
import { useDraftGroups, useDraftValue } from '../draft-model';
import { DraftBadge } from '../DraftBadge';

/** The three sizes of the prototype, then the other sizes of the old size list. */
const MAIN_SIZES = [
  { key: 'cv.size.portrait', width: 832, height: 1216 }, { key: 'cv.size.landscape', width: 1216, height: 832 }, { key: 'cv.size.square', width: 1024, height: 1024 },
] as const;
const MORE_SIZES: Array<[number, number]> = [[1024, 1536], [1536, 1024], [1472, 1472], [1088, 1920], [1920, 1088], [512, 768], [768, 512], [640, 640]];

/**
 * Size, steps, guidance, sampler, seed, quality tags, UC preset and the advanced settings (prototype 13; the old
 * advanced dialog is folded in under 高级). Every control writes the same store fields with the same limits as the old
 * panel and dialog; imageToImage adds the old output-size mode of Img2Img.
 */
export function ParamsSection({ imageToImage = false, scope = 'base', lockSizeToSource = false }: { imageToImage?: boolean; scope?: RecipeScope; lockSizeToSource?: boolean }) {
  const { t, language } = useUiText();
  const { params, setParam } = useRecipe(scope);
  const groups = useDraftGroups();
  const inpaintRecipe = scope === 'inpaint';
  const marked = inpaintRecipe ? groups.has('inpaintParams') : groups.has('size') || groups.has('seed') || groups.has('params');
  const draftWidth = useDraftValue(inpaintRecipe ? 'inpaintRecipe.width' : 'params.width') as number | undefined;
  const draftHeight = useDraftValue(inpaintRecipe ? 'inpaintRecipe.height' : 'params.height') as number | undefined;
  const draftSeed = useDraftValue(inpaintRecipe ? 'inpaintRecipe.seed' : 'params.seed') as number | undefined;
  const draftSeedMode = useDraftValue(inpaintRecipe ? 'inpaintRecipe.seedMode' : 'params.seedMode') as string | undefined;
  const seedMarked = draftSeed !== undefined || draftSeedMode !== undefined;
  const targetW = draftWidth ?? params.width, targetH = draftHeight ?? params.height;
  const sizeMarked = draftWidth !== undefined || draftHeight !== undefined;
  const workbenchImage = useAppStore(state => state.workbenchImage);
  const sizeMode = useAppStore(state => state.i2iSizeMode);
  const setSizeMode = useAppStore(state => state.setI2ISizeMode);
  const [resetOpen, setResetOpen] = useState(false);
  const i2iSized = imageToImage && !!workbenchImage;
  const adaptive = i2iSized && sizeMode === 'adaptive';
  const adaptiveSize = workbenchImage ? adaptiveNAIImageSize(workbenchImage.width, workbenchImage.height, params) : null;
  const custom = () => { if (imageToImage) setSizeMode('custom'); };
  const setSize = (width: number, height: number) => { custom(); setParam('width', width); setParam('height', height); };
  const isSize = (width: number, height: number) => !adaptive && params.width === width && params.height === height;
  const v5 = isNAIV5Model(params.model);
  const quality: QualityPreset = !v5 && params.qualityPreset === 'light' ? 'standard' : params.qualityPreset;
  const moreEntries: MenuEntry[] = MORE_SIZES.map(([width, height]) => ({ id: `${width}x${height}`, label: `${width} × ${height}`, checked: isSize(width, height), onSelect: () => setSize(width, height) }));
  const samplerOptions = NAI_SAMPLERS.map(item => { const label = optionLabel(language, item.value, item.label); return { value: item.value as GenerateParams['sampler'], label: label.name, hint: label.hint }; });
  const ucOptions = NAI_UC_PRESETS.map(item => { const label = optionLabel(language, item.value, item.label); return { value: item.value as GenerateParams['ucPreset'], label: label.name, hint: label.hint }; });
  const noiseOptions = (['native', 'karras', 'exponential'] as const).map(value => ({ value, label: optionLabel(language, value, value[0].toUpperCase() + value.slice(1)).name }));
  const resetParams = () => {
    // The old advanced dialog's reset, unchanged: every default except a locked Style or negative prompt (base), or
    // except the model (the separate inpaint recipe follows the inpaint model).
    const state = useAppStore.getState();
    for (const [key, value] of Object.entries(DEFAULT_PARAMS) as [keyof GenerateParams, any][]) {
      if (inpaintRecipe && key === 'model') continue;
      if (!inpaintRecipe && key === 'stylePrompt' && state.settings?.lockStylePrompt) continue;
      if (!inpaintRecipe && key === 'negativePrompt' && state.settings?.lockNegativePrompt) continue;
      setParam(key, value);
    }
    setResetOpen(false);
    showToast({ message: t('cv.resetDone') });
  };

  const source = useAppStore(state => state.workbenchImage);
  return <Section testId="cv-params" title={t('cv.params')} changed={marked} badge={marked ? <DraftBadge /> : undefined}>
    {i2iSized && <div className="cv-i2i-size">
      <Labeled label={t('cv.i2i.sizeMode')} value={adaptive && adaptiveSize ? t('cv.i2i.adaptiveSize', { source: `${workbenchImage!.width}×${workbenchImage!.height}`, output: `${adaptiveSize.width}×${adaptiveSize.height}` }) : undefined}>
        <Seg<'adaptive' | 'custom'> full size="sm" label={t('cv.i2i.sizeMode')} value={sizeMode} onChange={setSizeMode} options={[{ value: 'adaptive', label: t('cv.i2i.adaptive') }, { value: 'custom', label: t('cv.i2i.custom') }]} />
      </Labeled>
    </div>}
    {lockSizeToSource ? source && <div className="cv-note" data-testid="cv-size-locked"><Icon name="image" size={14} /><span>{t('cv.size.locked', { size: `${source.width}×${source.height}` })}</span></div> : <>
    <div className={clsx('cv-sizes', sizeMarked && 'is-marked')} role="group" aria-label={t('cv.size')}>
      {MAIN_SIZES.map(size => {
        const target = sizeMarked && targetW === size.width && targetH === size.height;
        return <button key={size.key} type="button" className={clsx('cv-size', isSize(size.width, size.height) && 'is-on', target && 'is-draft')} aria-pressed={isSize(size.width, size.height)} data-testid={`cv-size-${size.width}x${size.height}`} onClick={() => setSize(size.width, size.height)}>
          <b>{t(size.key)}</b><span className="ui-num">{size.width}×{size.height}</span>{target ? <i className="cv-draft-dot">{t('cv.draft.badge')}</i> : null}
        </button>;
      })}
    </div>
    {sizeMarked && !MAIN_SIZES.some(size => size.width === targetW && size.height === targetH) && <p className="cv-draft-line ui-num">{t('cv.draft.badge')} → {targetW}×{targetH}</p>}
    <div className="cv-size-row">
      <NumberField label={t('cv.size.width')} value={params.width} min={NAI_MIN_DIMENSION} max={maxNAIDimensionFor(params.height)} step={NAI_DIMENSION_STEP} normalize={value => snapNAIDimensionWithinArea(value, params.height, params.width)} onCommit={value => { custom(); setParam('width', value); }} />
      <span className="ui-faint">×</span>
      <NumberField label={t('cv.size.height')} value={params.height} min={NAI_MIN_DIMENSION} max={maxNAIDimensionFor(params.width)} step={NAI_DIMENSION_STEP} normalize={value => snapNAIDimensionWithinArea(value, params.width, params.height)} onCommit={value => { custom(); setParam('height', value); }} />
      <MenuButton entries={moreEntries} label={t('cv.size.more')} placement="bottom-end">{trigger => <button {...trigger} type="button" className="cv-hact" title={t('cv.size.hint')}>{t('cv.size.more')}<Icon name="down" size={12} /></button>}</MenuButton>
    </div>
    </>}
    <div className="cv-pgrid">
      <SliderField label={t('cv.steps')} value={params.steps} min={1} max={50} step={1} normalize={value => Math.min(50, Math.max(1, Math.round(value)))} onChange={value => setParam('steps', value)} testId="cv-steps" />
      <SliderField label={t('cv.cfg')} value={params.cfgScale} min={1} max={10} step={0.1} normalize={value => Math.min(10, Math.max(1, value))} onChange={value => setParam('cfgScale', Math.min(10, Math.max(1, value)))} format={value => value.toFixed(1)} testId="cv-cfg" />
      <Labeled label={t('cv.sampler')}><Select<GenerateParams['sampler']> label={t('cv.sampler')} value={params.sampler} options={samplerOptions} onChange={value => setParam('sampler', value)} /></Labeled>
      <Labeled label={t('cv.uc')}><Select<GenerateParams['ucPreset']> label={t('cv.uc')} value={params.ucPreset} options={ucOptions} onChange={value => setParam('ucPreset', value)} placement="bottom-end" /></Labeled>
    </div>
    <div className={clsx('cv-seed', seedMarked && 'is-marked')} data-testid="cv-seed">
      <div className="cv-pf-l"><span>{t('cv.seed')}{seedMarked ? <em className="cv-draft-line"> {t('cv.draft.badge')} → {(draftSeedMode ?? params.seedMode) === 'random' ? t('cv.seed.random') : String(draftSeed ?? params.seed)}</em> : null}</span>
        <Seg<'random' | 'fixed'> size="sm" label={t('cv.seed.mode')} value={params.seedMode} onChange={value => setParam('seedMode', value)} options={[{ value: 'random', label: t('cv.seed.random') }, { value: 'fixed', label: t('cv.seed.fixed') }]} />
      </div>
      {params.seedMode === 'fixed'
        ? <div className="cv-row"><NumberField label={t('cv.seed.value')} value={params.seed} min={0} max={MAX_NAI_SEED} normalize={value => Math.min(MAX_NAI_SEED, Math.max(0, value))} onCommit={value => setParam('seed', value)} className="cv-grow" />
          <button type="button" className="cv-iconbtn cv-iconbtn--box" aria-label={t('cv.seed.reroll')} title={t('cv.seed.reroll')} onClick={() => setParam('seed', Math.floor(Math.random() * MAX_NAI_SEED) + 1)}><Icon name="dice" size={15} /></button></div>
        : <p className="cv-hint ui-faint">{t('cv.seed.randomTip')}</p>}
    </div>
    <div className="cv-quality">
      <div className="cv-pf-l"><span title={t('cv.quality.tip')}>{t('cv.quality')}</span>
        {v5 && <label className="cv-inline-toggle" title={t('cv.transparentTip')}><span>{t('cv.transparent')}</span><Toggle checked={params.transparentBackground} label={t('cv.transparent')} onChange={value => setParam('transparentBackground', value)} /></label>}
      </div>
      <Seg<QualityPreset> full size="sm" label={t('cv.quality')} value={quality} onChange={value => setParam('qualityPreset', value)} options={[
        { value: 'standard', label: t('cv.quality.standard') }, { value: 'light', label: t('cv.quality.light'), disabled: !v5, title: v5 ? undefined : t('cv.quality.lightV5') }, { value: 'none', label: t('cv.quality.none') },
      ]} />
    </div>
    <Disclosure summary={t('cv.adv')} className="cv-adv">
      <div className="cv-pgrid">
        <Labeled label={t('cv.cfgRescale')}><NumberField label={t('cv.cfgRescale')} value={params.cfgRescale} min={0} max={1} step={0.01} normalize={value => Math.min(1, Math.max(0, value))} onCommit={value => setParam('cfgRescale', value)} /></Labeled>
        {supportsNAINoiseScheduleControl(params.model) && <Labeled label={t('cv.noise')}><Select<string> label={t('cv.noise')} value={params.noiseSchedule} options={noiseOptions} onChange={value => setParam('noiseSchedule', value)} placement="bottom-end" /></Labeled>}
      </div>
      {supportsNAIVariety(params.model) && <label className="cv-inline-toggle cv-inline-toggle--row"><span>{t('cv.variety')}</span><Toggle checked={params.variety} label={t('cv.variety')} onChange={value => setParam('variety', value)} /></label>}
      {!isNAIV4PlusModel(params.model) && <>
        <label className="cv-inline-toggle cv-inline-toggle--row" title={t('cv.smeaTip')}><span>{t('cv.smea')}</span><Toggle checked={params.smea} label={t('cv.smea')} onChange={value => setParam('smea', value)} /></label>
        <label className="cv-inline-toggle cv-inline-toggle--row" title={t('cv.smeaTip')}><span>{t('cv.smeaDyn')}</span><Toggle checked={params.smeaDyn} label={t('cv.smeaDyn')} onChange={value => setParam('smeaDyn', value)} /></label>
      </>}
      <AssemblyStatus scope={scope} />
      <Button size="sm" variant="ghost" icon="restore" title={t('cv.resetTip')} onClick={() => setResetOpen(true)}>{t('cv.reset')}</Button>
    </Disclosure>
    <ConfirmDialog open={resetOpen} title={t('cv.reset')} description={t('cv.resetTip')} confirmLabel={t('cv.reset')} cancelLabel={t('c.cancel')} onConfirm={resetParams} onCancel={() => setResetOpen(false)} />
  </Section>;
}

/**
 * The old adoptPromptAssemblyV1: switches a recipe to the literal joining (promptAssemblyVersion 1) and nothing else;
 * the store persists it as every parameter. false when the scope has no recipe (inpaint without its separate one).
 */
export function adoptPromptAssemblyV1(scope: RecipeScope): boolean {
  const state = useAppStore.getState();
  if (scope === 'inpaint') {
    if (!state.inpaintRecipe) return false;
    state.setInpaintRecipeParam('promptAssemblyVersion', 1);
    return true;
  }
  state.setParam('promptAssemblyVersion', 1);
  return true;
}

/** The old PromptAssemblyControl: how the prompt fields are joined, and the switch to the literal joining. */
function AssemblyStatus({ scope }: { scope: RecipeScope }) {
  const { t } = useUiText();
  const { params } = useRecipe(scope);
  const literal = params.promptAssemblyVersion === 1;
  // The literal joining (v1) says so in a line, as the old status did.
  if (literal) return <div className="cv-asm-v1 ui-faint" data-prompt-assembly="v1">{t('cv.asm.v1')}</div>;
  const strict = params.preservePromptText === true;
  return <div className="cv-note" data-prompt-assembly={strict ? 'strict' : 'legacy'}>
    <span>{t(strict ? 'cv.asm.strict' : 'cv.asm.legacy')}</span>
    <Button size="sm" onClick={() => adoptPromptAssemblyV1(scope)}>{t('cv.asm.adopt')}</Button>
    <small className="ui-faint">{t(strict ? 'cv.asm.strictHint' : 'cv.asm.adoptHint')}</small>
  </div>;
}
