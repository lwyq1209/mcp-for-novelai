import { useState } from 'react';
import { ConfirmDialog, Seg, Toggle, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { baseModelForInpaint, NAI_INPAINT_MODELS, type NAIInpaintModel } from '../../types';
import { HeadAction, Labeled, Section, Select, SliderField, optionLabel } from '../controls';
import { useDraftGroups } from '../draft-model';
import { DraftBadge } from '../DraftBadge';
import { PromptSection, StyleSection } from './prompt';
import { ParamsSection } from './params';
import { SourceCard } from './source';

/** Why a click on 重绘 would be refused before any request (the store's own checks, shown before the click). */
export function useInpaintBlock(): string {
  const { t } = useUiText();
  const recipe = useAppStore(state => state.inpaintRecipe);
  const inpaintModel = useAppStore(state => state.inpaintModel);
  const refs = useAppStore(state => state.vibeImages.length + state.preciseReferences.length);
  const furry = useAppStore(state => state.settings?.modelMode === 'furry');
  const source = useAppStore(state => state.workbenchImage);
  const mask = useAppStore(state => state.inpaintMask);
  if (recipe && (refs > 0 || furry)) return t('cv.ip.noRefs');
  if (recipe && recipe.model !== baseModelForInpaint(inpaintModel)) return t('cv.ip.modelMismatch');
  if (!source) return t('cv.gen.noImage');
  if (!mask) return t('cv.ip.needMask');
  return '';
}

/**
 * Inpaint's left column (prototype 16): the source and where the next image starts from, the inpaint model (with
 * NovelAI's defaults), the strength, and the separate inpaint settings switch (the old "independent inpaint recipe":
 * off keeps only the positive prompt separate and shares the rest with Txt2Img). The brush, its size, colour and
 * opacity are on the stage's mask tool bar. The prompt, Style and settings sections edit the recipe in use.
 */
export function InpaintSettings() {
  const { t, language } = useUiText();
  const sourceMode = useAppStore(state => state.inpaintSourceMode);
  const setSourceMode = useAppStore(state => state.setInpaintSourceMode);
  const model = useAppStore(state => state.inpaintModel);
  const setModel = useAppStore(state => state.setInpaintModel);
  const strength = useAppStore(state => state.inpaintStrength);
  const setStrength = useAppStore(state => state.setInpaintStrength);
  const recipe = useAppStore(state => state.inpaintRecipe);
  const setRecipe = useAppStore(state => state.setInpaintRecipe);
  const positive = useAppStore(state => state.inpaintPositivePrompt);
  const setPositive = useAppStore(state => state.setInpaintPositivePrompt);
  const groups = useDraftGroups();
  const [dropOpen, setDropOpen] = useState(false);
  const block = useInpaintBlock();
  const options = NAI_INPAINT_MODELS.map(item => { const label = optionLabel(language, item.value, item.label); return { value: item.value as NAIInpaintModel, label: label.name, hint: label.hint }; });
  // The old 恢复官网默认, unchanged.
  const restoreDefaults = () => {
    const state = useAppStore.getState();
    state.setInpaintModel('nai-diffusion-5-full-inpainting');
    state.setInpaintStrength(1);
    state.setBrushSize(4);
    state.setBrushOpacity(0.55);
    state.setBrushColor('#ffffff');
    state.setBrushMode('paint');
    state.setBrushShape('round');
    showToast({ message: t('cv.ip.defaultsDone') });
  };
  const hint = strength < 0.6 ? 'cv.ip.strengthLow' : strength > 0.9 ? 'cv.ip.strengthFull' : 'cv.ip.strengthHigh';
  const scope = recipe ? 'inpaint' : 'base';
  const settingsMarked = groups.has('inpaint');
  return <>
    <Section testId="cv-ip-source" title={t('cv.src')} changed={groups.has('source') || groups.has('mask')} badge={groups.has('source') || groups.has('mask') ? <DraftBadge /> : undefined}>
      <SourceCard mode="inpaint" />
      <Labeled label={t('cv.src.next')}>
        <Seg<'original' | 'latest'> full size="sm" label={t('cv.src.next')} value={sourceMode} onChange={value => void setSourceMode(value)} options={[{ value: 'original', label: t('cv.src.original') }, { value: 'latest', label: t('cv.src.latest') }]} />
      </Labeled>
    </Section>
    <Section testId="cv-ip-model" title={t('cv.ip.model')} changed={settingsMarked} badge={settingsMarked ? <DraftBadge /> : undefined} actions={<HeadAction icon="restore" title={t('cv.ip.defaultsTip')} onClick={restoreDefaults}>{t('cv.ip.defaults')}</HeadAction>}>
      <Select<NAIInpaintModel> label={t('cv.ip.model')} value={model} options={options} onChange={setModel} testId="cv-ip-model-select" />
      <SliderField label={t('cv.ip.strength')} value={strength} min={0.1} max={1} step={0.01} normalize={value => Math.min(1, Math.max(0.1, value))} onChange={setStrength} testId="cv-ip-strength" />
      <small className={strength < 0.6 ? 'cv-hint cv-hint--warn' : 'cv-hint ui-faint'}>{t(hint)}</small>
    </Section>
    <Section testId="cv-ip-separate">
      <div className="cv-switch-row">
        <div className="cv-grow"><b>{t('cv.ip.separate')}</b><small className="ui-faint">{t(recipe ? 'cv.ip.separateOn' : 'cv.ip.separateOff')}</small></div>
        <Toggle checked={!!recipe} label={t('cv.ip.separate')} onChange={on => { if (on) setRecipe({}); else setDropOpen(true); }} />
      </div>
      {block === t('cv.ip.noRefs') && <p className="cv-note cv-note--warn">{block}</p>}
    </Section>
    <PromptSection key={scope} scope={scope} positive={recipe ? undefined : { value: positive, onChange: setPositive }} draftGroup={recipe ? 'inpaintPrompt' : ['inpaintPrompt', 'prompt']} />
    <StyleSection key={`style-${scope}`} scope={scope} />
    <ParamsSection key={`params-${scope}`} scope={scope} lockSizeToSource />
    <ConfirmDialog open={dropOpen} title={t('cv.ip.separateDrop')} description={t('cv.ip.separateDropBody')} confirmLabel={t('cv.ip.separateDropOk')} cancelLabel={t('c.cancel')}
      onConfirm={() => { setRecipe(null); setDropOpen(false); }} onCancel={() => setDropOpen(false)} />
  </>;
}
