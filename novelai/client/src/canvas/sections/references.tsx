import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Icon, Seg, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { supportsNAIPreciseReference, supportsNAIVibeTransfer, type PreciseReferenceType } from '../../types';
import { ReferencePresetQuickSaveDialog, type QuickPresetSource } from '../ReferenceQuickSave';
import { HeadAction, Section, SliderField } from '../controls';
import { useDraftGroups } from '../draft-model';
import { DraftBadge } from '../DraftBadge';
import { showStepToast } from '../guarded-undo';
import { ReferencePresetPicker } from '../LibraryPicker';

/** The three official precise-reference sizes (the old dialog's recommendPreciseSize, unchanged). */
const PRECISE_SIZES = [{ width: 1024, height: 1536 }, { width: 1472, height: 1472 }, { width: 1536, height: 1024 }];
export function recommendPreciseSize(w?: number, h?: number) {
  if (!w || !h) return null;
  const aspect = w / h;
  const target = PRECISE_SIZES.reduce((best, c) => Math.abs(c.width / c.height - aspect) < Math.abs(best.width / best.height - aspect) ? c : best, PRECISE_SIZES[0]);
  const exact = w === target.width && h === target.height;
  const scale = Math.min(target.width / w, target.height / h);
  const padPercent = Math.round((1 - (Math.round(w * scale) * Math.round(h * scale)) / (target.width * target.height)) * 100);
  return { target, exact, padPercent };
}

const TYPE_OPTIONS: Array<{ value: PreciseReferenceType; key: 'cv.refs.type.character' | 'cv.refs.type.style' | 'cv.refs.type.both' }> = [
  { value: 'character', key: 'cv.refs.type.character' }, { value: 'style', key: 'cv.refs.type.style' }, { value: 'character&style', key: 'cv.refs.type.both' },
];

/**
 * Vibe and Precise references, edited in place (prototype 13; it replaces the old reference dialog): add from a file,
 * tune each one, save one as a reference preset, open the reference presets. The images and values the store keeps
 * are those of the old dialog (same defaults: information 1, strength 1; Precise as character, fidelity 1).
 */
export function ReferencesSection() {
  const { t } = useUiText();
  const vibes = useAppStore(state => state.vibeImages);
  const precise = useAppStore(state => state.preciseReferences);
  const model = useAppStore(state => state.params.model);
  const store = useAppStore.getState;
  const vibeOk = supportsNAIVibeTransfer(model), preciseOk = supportsNAIPreciseReference(model);
  const vibeInput = useRef<HTMLInputElement>(null), preciseInput = useRef<HTMLInputElement>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const presetsButton = useRef<HTMLButtonElement>(null);
  const [quickSave, setQuickSave] = useState<QuickPresetSource | null>(null);
  const count = vibes.length + precise.length;
  const marked = useDraftGroups().has('refs');
  const toV45 = () => store().setParam('model', model.includes('curated') ? 'nai-diffusion-4-5-curated' : 'nai-diffusion-4-5-full');

  function readVibe(file: File) {
    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      store().addVibeImage({ id: crypto.randomUUID(), previewUrl: dataUrl, base64: dataUrl.split(',')[1] ?? '', infoExtracted: 1, strength: 1 });
    };
    reader.readAsDataURL(file);
  }
  function readPrecise(file: File) {
    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const probe = new Image();
      probe.onload = () => store().addPreciseReference({ id: crypto.randomUUID(), previewUrl: dataUrl, base64: dataUrl.split(',')[1] ?? '', type: 'character', strength: 1, fidelity: 1, informationExtracted: 1, srcWidth: probe.naturalWidth, srcHeight: probe.naturalHeight });
      probe.onerror = () => showToast({ message: t('cv.refs.readFailed'), tone: 'warn' });
      probe.src = dataUrl;
    };
    reader.onerror = () => showToast({ message: t('cv.refs.readFailed'), tone: 'warn' });
    reader.readAsDataURL(file);
  }
  // 清空 (the old dialog's 全部清除), undone from its toast while there are still no references.
  const clearAll = () => {
    const state = store(), before = { vibeImages: state.vibeImages, preciseReferences: state.preciseReferences };
    state.clearVibeImages(); state.clearPreciseReferences();
    showStepToast(t, t('cv.refs.cleared'), { read: () => ({ vibeImages: store().vibeImages, preciseReferences: store().preciseReferences }), after: { vibeImages: [], preciseReferences: [] }, restore: () => useAppStore.setState(before) });
  };
  const fileInput = (ref: typeof vibeInput, read: (file: File) => void, testId: string, disabled: boolean) => <input ref={ref} type="file" hidden disabled={disabled} accept="image/png,image/jpeg,image/webp" data-testid={testId}
    onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) read(file); }} />;

  return <Section testId="cv-references" title={t('cv.refs')} changed={marked} badge={<><span className="cv-sh-n ui-faint">{count ? t('cv.refs.count', { n: count }) : t('cv.refs.none')}</span>{marked ? <DraftBadge /> : null}</>}
    actions={<>
      {count > 0 && <HeadAction icon="trash" onClick={clearAll} title={t('cv.refs.clearTip')} testId="cv-ref-clear">{t('cv.refs.clear')}</HeadAction>}
      <HeadAction buttonRef={presetsButton} icon="preset" pressed={presetsOpen} onClick={() => setPresetsOpen(open => !open)} testId="cv-ref-presets">{t('cv.refs.presets')}</HeadAction>
    </>}>
    {vibes.map(image => <div key={image.id} className="cv-ref" data-testid="cv-vibe">
      <img src={image.previewUrl} alt={t('cv.refs.thumb')} />
      <div className="cv-ref-body">
        <div className="cv-ref-title"><span className="ui-tag ui-tag--accent">{t('cv.refs.vibe')}</span>{!vibeOk && <span className="cv-ref-warn">{t('cv.refs.vibeNo')}</span>}</div>
        <SliderField label={t('cv.refs.info')} value={image.infoExtracted} min={0} max={1} step={0.01} onChange={value => store().updateVibeImage(image.id, { infoExtracted: value })} />
        <SliderField label={t('cv.refs.strength')} value={image.strength} min={0} max={1} step={0.01} onChange={value => store().updateVibeImage(image.id, { strength: value })} />
      </div>
      <div className="cv-ref-acts">
        <button type="button" className="cv-iconbtn" aria-label={t('cv.refs.save')} title={t('cv.refs.save')} onClick={() => setQuickSave({ kind: 'vibe', previewUrl: image.previewUrl, base64: image.base64, infoExtracted: image.infoExtracted, strength: image.strength })}><Icon name="star" size={14} /></button>
        <button type="button" className="cv-iconbtn" aria-label={t('cv.refs.remove')} title={t('cv.refs.remove')} onClick={() => store().removeVibeImage(image.id)}><Icon name="x" size={14} /></button>
      </div>
    </div>)}
    {precise.map(image => {
      const fit = recommendPreciseSize(image.srcWidth, image.srcHeight);
      return <div key={image.id} className="cv-ref" data-testid="cv-precise">
        <img src={image.previewUrl} alt={t('cv.refs.thumb')} />
        <div className="cv-ref-body">
          <div className="cv-ref-title"><span className="ui-tag ui-tag--accent">{t('cv.refs.precise')}</span>{!preciseOk && <span className="cv-ref-warn">{t('cv.refs.preciseNo')}</span>}</div>
          <Seg<PreciseReferenceType> full size="sm" label={t('cv.refs.type')} value={image.type} onChange={type => store().updatePreciseReference(image.id, { type })} options={TYPE_OPTIONS.map(option => ({ value: option.value, label: t(option.key) }))} />
          <SliderField label={t('cv.refs.strength')} value={image.strength} min={0} max={1} step={0.01} onChange={value => store().updatePreciseReference(image.id, { strength: value })} />
          <SliderField label={t('cv.refs.fidelity')} value={image.fidelity} min={0} max={1} step={0.01} onChange={value => store().updatePreciseReference(image.id, { fidelity: value })} />
          {fit && <small className={clsx('cv-ref-size', fit.exact && 'is-ok')}>{fit.exact
            ? t('cv.refs.fits', { source: `${image.srcWidth}×${image.srcHeight}` })
            : t('cv.refs.padded', { source: `${image.srcWidth}×${image.srcHeight}`, target: `${fit.target.width}×${fit.target.height}`, pad: String(fit.padPercent) })}</small>}
        </div>
        <div className="cv-ref-acts">
          <button type="button" className="cv-iconbtn" aria-label={t('cv.refs.save')} title={t('cv.refs.save')} onClick={() => setQuickSave({ kind: 'precise', previewUrl: image.previewUrl, base64: image.base64, preciseType: image.type, strength: image.strength, fidelity: image.fidelity, informationExtracted: image.informationExtracted ?? 1, width: image.srcWidth, height: image.srcHeight })}><Icon name="star" size={14} /></button>
          <button type="button" className="cv-iconbtn" aria-label={t('cv.refs.remove')} title={t('cv.refs.remove')} onClick={() => store().removePreciseReference(image.id)}><Icon name="x" size={14} /></button>
        </div>
      </div>;
    })}
    {/* Each button with its own file input in one area: click one, then paste (image-paste.tsx picks that input). */}
    <div className="cv-row">
      <span className="cv-grow cv-ref-add" data-image-input-area>
        <button type="button" className="ui-btn ui-btn--sm" disabled={!vibeOk} title={vibeOk ? undefined : t('cv.refs.vibeNo')} onClick={() => vibeInput.current?.click()} data-testid="cv-add-vibe"><Icon name="plus" size={13} />{t('cv.refs.vibe')}</button>
        {fileInput(vibeInput, readVibe, 'cv-vibe-file', !vibeOk)}
      </span>
      <span className="cv-grow cv-ref-add" data-image-input-area>
        <button type="button" className="ui-btn ui-btn--sm" disabled={!preciseOk} title={preciseOk ? undefined : t('cv.refs.preciseNo')} onClick={() => preciseInput.current?.click()} data-testid="cv-add-precise"><Icon name="plus" size={13} />{t('cv.refs.precise')}</button>
        {fileInput(preciseInput, readPrecise, 'cv-precise-file', !preciseOk)}
      </span>
    </div>
    {!preciseOk && <div className="cv-ref-hint ui-faint"><span>{t('cv.refs.preciseNo')}</span><button type="button" className="cv-link" onClick={toV45}>{t('cv.refs.toV45')}</button></div>}
    <ReferencePresetPicker open={presetsOpen} anchor={presetsButton} onClose={() => setPresetsOpen(false)} />
    {quickSave && <ReferencePresetQuickSaveDialog source={quickSave} onClose={() => setQuickSave(null)} />}
  </Section>;
}
