import clsx from 'clsx';
import { Icon, Seg, TextInput } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { selectCreativeMode } from '../../app/workbench-navigation';
import { DIRECTOR_TOOLS, EMOTION_OPTIONS, MAX_NAI_DIRECTOR_INPUT_PIXELS, MAX_NAI_UPSCALE_INPUT_PIXELS, MAX_NAI_UPSCALE_OUTPUT_DIMENSION, supportsNAIMaxEnhance, type DirectorTool, type EmotionValue, type GenerateParams, type UpscaleScale } from '../../types';
import { adaptiveNAIImageSize, maxEnhanceInputSize, maxEnhanceOutputSize, NAI_MAX_PIXEL_AREA, resolveNAIEnhanceOutputSize } from '../../nai-dimensions';
import { Labeled, Section, Select, SliderField } from '../controls';
import { useDraftGroups } from '../draft-model';
import { DraftBadge } from '../DraftBadge';
import { SourceCard } from './source';

/** The old fitSizeWithinPixels of App.tsx (the size a post tool's input is shrunk to), unchanged. */
export function fitSizeWithinPixels(width: number, height: number, maxPixels: number) {
  const pixels = width * height;
  if (!width || !height || pixels <= maxPixels) return { width, height, resized: false };
  const ratio = Math.sqrt(maxPixels / pixels);
  return { width: Math.max(1, Math.floor(width * ratio)), height: Math.max(1, Math.floor(height * ratio)), resized: true };
}

/**
 * Enhance, as the old EnhancePanel ran it (unchanged): the output size and the conservative strength and noise of the
 * magnitude are set for this click only, generateI2I freezes them into the manual batch, and the previous size,
 * strength, noise and size mode come back right after.
 */
export async function runEnhance() {
  const state = useAppStore.getState();
  const { workbenchImage, params, i2iParams, i2iSizeMode, enhanceMagnitude: magnitude, enhanceScale } = state;
  if (!workbenchImage) return;
  const target = enhanceRequestSize(workbenchImage, enhanceScale, params);
  if (!target) return;
  const previous = { width: params.width, height: params.height, strength: i2iParams.strength, noise: i2iParams.noise, sizeMode: i2iSizeMode };
  state.setI2ISizeMode('custom');
  state.applyParams({ width: target.width, height: target.height });
  // Official Enhance is prompt-aware, but conservative defaults must keep the source pose/composition.
  state.setI2IParam('strength', Math.min(0.48, 0.10 + magnitude * 0.034));
  state.setI2IParam('noise', Math.min(0.22, 0.018 + magnitude * 0.014));
  try {
    await state.generateI2I({ enhance: { max: enhanceScale === 'max' } });
  } finally {
    const after = useAppStore.getState();
    after.applyParams({ width: previous.width, height: previous.height });
    after.setI2IParam('strength', previous.strength);
    after.setI2IParam('noise', previous.noise);
    after.setI2ISizeMode(previous.sizeMode);
  }
}

/**
 * The size an enhance click sends (null: refused). 1×/2×: the output size (2× over the pixel limit is refused, as
 * before); Max✨: the source at its own size, 64-aligned and under the Max input limit (generation-postprocess.ts).
 */
export function enhanceRequestSize(source: { width: number; height: number }, scale: 1 | 2 | 'max', params: GenerateParams) {
  if (scale === 'max') return supportsNAIMaxEnhance(params.model) ? maxEnhanceInputSize(source.width, source.height) : null;
  const requested = resolveNAIEnhanceOutputSize(source.width, source.height, scale, params);
  if (scale > 1 && requested.exceedsLimit) return null;
  return adaptiveNAIImageSize(source.width * scale, source.height * scale, params);
}

/** The enhance output size and its limit (the old panel's computation; Max✨: about 2× of its input). */
export function useEnhanceTarget() {
  const { t } = useUiText();
  const source = useAppStore(state => state.workbenchImage);
  const params = useAppStore(state => state.params);
  const scale = useAppStore(state => state.enhanceScale);
  if (scale === 'max') {
    const available = supportsNAIMaxEnhance(params.model);
    const input = source && available ? maxEnhanceInputSize(source.width, source.height) : null;
    const target = input ? maxEnhanceOutputSize(input.width, input.height) : null;
    return { source, target, input, max: true, tooLarge: !available, reason: available ? '' : t('cv.pp.maxV5') };
  }
  const requested = source ? resolveNAIEnhanceOutputSize(source.width, source.height, scale, params) : null;
  const tooLarge = Boolean(scale > 1 && requested?.exceedsLimit);
  const target = source && requested ? tooLarge ? requested : adaptiveNAIImageSize(source.width * scale, source.height * scale, params) : null;
  const reason = tooLarge && target ? t('cv.pp.enhanceLimit', { size: `${target.width}×${target.height}`, pixels: (target.width * target.height).toLocaleString(), limit: NAI_MAX_PIXEL_AREA.toLocaleString() }) : '';
  return { source, target, input: null, max: false, tooLarge, reason };
}

export function EnhanceSettings() {
  const { t } = useUiText();
  const magnitude = useAppStore(state => state.enhanceMagnitude);
  const scale = useAppStore(state => state.enhanceScale);
  const prompt = useAppStore(state => state.params.positivePrompt);
  const v5 = useAppStore(state => supportsNAIMaxEnhance(state.params.model));
  const { source, target, input, max, reason } = useEnhanceTarget();
  const marked = useDraftGroups().has('enhance');
  return <>
    <Section testId="cv-pp-source" title={t('cv.src')}><SourceCard mode="enhance" /></Section>
    <Section testId="cv-pp-enhance" title={t('cv.post.enhance')} changed={marked} badge={marked ? <DraftBadge /> : undefined}>
      <SliderField label={t('cv.pp.magnitude')} value={magnitude} min={1} max={10} step={1} normalize={value => Math.min(10, Math.max(1, Math.round(value)))} onChange={value => useAppStore.setState({ enhanceMagnitude: value })} testId="cv-pp-magnitude" />
      <small className="cv-hint ui-faint">{t('cv.pp.magnitudeTip')}</small>
      <Labeled label={t('cv.pp.scale')}>
        <Seg<'1' | '2' | 'max'> full size="sm" label={t('cv.pp.scale')} value={String(scale) as '1' | '2' | 'max'} onChange={value => useAppStore.setState({ enhanceScale: value === 'max' ? 'max' : Number(value) as 1 | 2 })} options={[
          { value: '1', label: t('cv.pp.keep') }, { value: '2', label: t('cv.pp.double') },
          { value: 'max', label: t('cv.pp.max'), disabled: !v5 && scale !== 'max', title: v5 ? t('cv.pp.maxNote') : t('cv.pp.maxV5') },
        ]} />
      </Labeled>
      {reason && (!source || !target) && <p className="cv-note cv-note--warn" data-testid="cv-pp-size">{reason}</p>}
      {source && target && <p className={clsx('cv-note', reason && 'cv-note--warn')} data-testid="cv-pp-size">{reason || (max
        ? input?.resized ? t('cv.pp.outMaxResized', { from: `${source.width}×${source.height}`, mid: `${input.width}×${input.height}`, to: `${target.width}×${target.height}` })
          : t('cv.pp.outMax', { from: `${source.width}×${source.height}`, to: `${target.width}×${target.height}` })
        : t('cv.pp.out', { from: `${source.width}×${source.height}`, to: `${target.width}×${target.height}` }))}</p>}
      {max && !reason && <small className="cv-hint cv-hint--warn" data-testid="cv-pp-max-note">{t('cv.pp.maxNote')}</small>}
    </Section>
    <Section testId="cv-pp-prompt" title={t('cv.prompt')}>
      <small className="ui-faint">{t('cv.pp.usesPrompt')}</small>
      <p className="cv-prompt-peek ui-mono">{prompt.trim() || t('cv.pp.noPrompt')}</p>
      <button type="button" className="cv-link" onClick={() => selectCreativeMode('t2i')}>{t('cv.pp.editPrompt')} →</button>
    </Section>
  </>;
}

/** The upscale output size and its limit (the old panel's computation). */
export function useUpscaleTarget() {
  const { t } = useUiText();
  const source = useAppStore(state => state.workbenchImage);
  const scale = useAppStore(state => state.upscaleScale);
  const prepared = source ? fitSizeWithinPixels(source.width, source.height, MAX_NAI_UPSCALE_INPUT_PIXELS) : null;
  const output = prepared ? { width: prepared.width * scale, height: prepared.height * scale } : null;
  const tooLarge = Boolean(output && (output.width > MAX_NAI_UPSCALE_OUTPUT_DIMENSION || output.height > MAX_NAI_UPSCALE_OUTPUT_DIMENSION));
  const reason = tooLarge && output ? t('cv.pp.upscaleLimit', { output: `${output.width}×${output.height}`, limit: `${MAX_NAI_UPSCALE_OUTPUT_DIMENSION}×${MAX_NAI_UPSCALE_OUTPUT_DIMENSION}` }) : '';
  return { source, scale, prepared, output, tooLarge, reason };
}

export function UpscaleSettings() {
  const { t } = useUiText();
  const setScale = useAppStore(state => state.setUpscaleScale);
  const { source, scale, prepared, output, reason } = useUpscaleTarget();
  const marked = useDraftGroups().has('upscale');
  const option = (value: UpscaleScale) => {
    const size = prepared ? `${prepared.width * value}×${prepared.height * value}` : '';
    return <button key={value} type="button" className={clsx('cv-size', scale === value && 'is-on')} aria-pressed={scale === value} data-testid={`cv-pp-upscale-${value}`} onClick={() => setScale(value)}><b>{value}×</b>{size ? <span className="ui-num">{size}</span> : null}</button>;
  };
  return <>
    <Section testId="cv-pp-source" title={t('cv.src')}><SourceCard mode="upscale" /></Section>
    <Section testId="cv-pp-upscale" title={t('cv.post.upscale')} changed={marked} badge={marked ? <DraftBadge /> : undefined}>
      <div className="cv-sizes" role="group" aria-label={t('cv.pp.scale')}>{option(2)}{option(4)}</div>
      {source && output && <p className={clsx('cv-note', reason && 'cv-note--warn')} data-testid="cv-pp-size">{reason || (prepared?.resized
        ? t('cv.pp.outResized', { from: `${source.width}×${source.height}`, mid: `${prepared.width}×${prepared.height}`, to: `${output.width}×${output.height}` })
        : t('cv.pp.out', { from: `${source.width}×${source.height}`, to: `${output.width}×${output.height}` }))}</p>}
      {prepared?.resized && <small className="cv-hint ui-faint">{t('cv.pp.resizedHint')}</small>}
    </Section>
  </>;
}

const TOOL_ICON: Record<DirectorTool, Parameters<typeof Icon>[0]['name']> = {
  'bg-removal': 'layers', lineart: 'edit', sketch: 'brush', colorize: 'palette', emotion: 'user', declutter: 'wand',
};

export function DirectorSettings() {
  const { t } = useUiText();
  const source = useAppStore(state => state.workbenchImage);
  const tool = useAppStore(state => state.directorTool);
  const setTool = useAppStore(state => state.setDirectorTool);
  const options = useAppStore(state => state.augmentOptions);
  const setOption = useAppStore(state => state.setAugmentOption);
  const prepared = source ? fitSizeWithinPixels(source.width, source.height, MAX_NAI_DIRECTOR_INPUT_PIXELS) : null;
  const marked = useDraftGroups().has('director');
  return <>
    <Section testId="cv-pp-source" title={t('cv.src')}><SourceCard mode="director" /></Section>
    <Section testId="cv-pp-director" title={t('cv.pp.tool')} changed={marked} badge={marked ? <DraftBadge /> : undefined}>
      <div className="cv-tools" role="radiogroup" aria-label={t('cv.pp.tool')}>
        {DIRECTOR_TOOLS.map(item => <button key={item.value} type="button" role="radio" aria-checked={tool === item.value} className={clsx('cv-tool', tool === item.value && 'is-on')} data-testid={`cv-pp-tool-${item.value}`} onClick={() => setTool(item.value)}>
          <Icon name={TOOL_ICON[item.value]} size={16} /><b>{t(`cv.pp.tool.${item.value}` as never)}</b>
        </button>)}
      </div>
      {tool === 'colorize' && <Labeled label={t('cv.pp.colorize')}><TextInput value={options.colorizePrompt} placeholder={t('cv.pp.colorizePlaceholder')} aria-label={t('cv.pp.colorize')} data-testid="cv-pp-colorize" onChange={event => setOption('colorizePrompt', event.target.value)} /></Labeled>}
      {tool === 'emotion' && <>
        <Labeled label={t('cv.pp.emotion')}><Select<EmotionValue> label={t('cv.pp.emotion')} value={options.emotion} onChange={value => setOption('emotion', value)} options={EMOTION_OPTIONS.map(item => ({ value: item.value, label: t(`cv.pp.emotion.${item.value}` as never) }))} /></Labeled>
        <SliderField label={t('cv.pp.emotionLevel')} value={options.emotionLevel} min={0} max={5} step={1} normalize={value => Math.min(5, Math.max(0, Math.round(value)))} onChange={value => setOption('emotionLevel', value)} />
      </>}
      <SliderField label={t('cv.pp.defry')} value={options.defry} min={0} max={5} step={1} normalize={value => Math.min(5, Math.max(0, Math.round(value)))} onChange={value => setOption('defry', value)} testId="cv-pp-defry" />
      {source && prepared?.resized && <p className="cv-note" data-testid="cv-pp-size">{t('cv.pp.protect', { prepared: `${prepared.width}×${prepared.height}` })}</p>}
    </Section>
  </>;
}
