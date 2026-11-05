import { useRef, useState } from 'react';
import clsx from 'clsx';
import { Icon, Seg, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { hostErrorText } from '../../host-errors';
import { droppedImagePath, hasDraggedFiles } from '../../drag-drop';
import { stageImageInput, type ActionImage } from '../../app/ImageActions';
import type { GenerationSourceMode } from '../../workspace/source-selection';
import { NumberField, Section, SliderField } from '../controls';
import { HistorySourcePicker } from '../LibraryPicker';

/** The file name of an image without its folder and extension. */
export const imageName = (filePath?: string) => (filePath ?? '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? '';
/** The name of a prepared working copy is its id (a UUID): not worth showing. */
export const shownName = (filePath?: string) => { const name = imageName(filePath); return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(name) ? '' : name; };

/** Stages an image as the source of a mode through the canvas's source draft (as every old entry did). */
export function useStageSource(mode: GenerationSourceMode) {
  const { language } = useUiText();
  const [busy, setBusy] = useState(false);
  const stage = (image: ActionImage | File) => {
    setBusy(true);
    void stageImageInput(image, mode).catch(error => showToast({ message: hostErrorText(error, language), tone: 'danger' })).finally(() => setBusy(false));
  };
  return { busy, stage };
}

/**
 * The source image of an image mode (prototype 16's 源图 card): replace it from a file or by dropping one, use the
 * canvas's current image, or remove it. Staging goes through the canvas's source draft (stageImageInput), as before.
 */
export function SourceCard({ mode }: { mode: GenerationSourceMode }) {
  const { t } = useUiText();
  const source = useAppStore(state => state.workbenchImage);
  const current = useAppStore(state => state.currentImage);
  const clear = useAppStore(state => state.clearWorkbenchImage);
  const { busy, stage } = useStageSource(mode);
  const input = useRef<HTMLInputElement>(null);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const [over, setOver] = useState(false);
  const [picker, setPicker] = useState(false);
  const canUseCurrent = !!current?.filePath && current.filePath !== source?.filePath;
  return <div className={clsx('cv-src', over && 'is-over', !source && 'is-empty')} data-testid="cv-source" data-image-paste="drop" tabIndex={0}
    onDragOver={event => { if (!hasDraggedFiles(event.dataTransfer)) return; event.preventDefault(); setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={event => {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault(); setOver(false);
      void droppedImagePath(event.dataTransfer).then(filePath => { if (filePath) stage({ filePath }); });
    }}>
    <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) stage(file); }} />
    {source ? <>
      <img src={source.fileUrl} alt={t('cv.src')} />
      <div className="cv-src-tx"><b title={source.filePath}>{shownName(source.filePath) || t('cv.src')}</b><span className="ui-faint ui-num">{source.width} × {source.height}</span></div>
      <div className="cv-src-acts">
        <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => input.current?.click()} data-testid="cv-source-replace">{busy ? t('cv.src.preparing') : t('cv.src.replace')}</button>
        <button type="button" className="cv-iconbtn" aria-label={t('cv.src.clear')} title={t('cv.src.clear')} onClick={() => void clear()}><Icon name="x" size={14} /></button>
      </div>
    </> : <>
      <span className="cv-src-empty ui-faint"><Icon name="upload" size={16} />{t('cv.src.empty')}</span>
      <button type="button" className="ui-btn ui-btn--sm" disabled={busy} onClick={() => input.current?.click()} data-testid="cv-source-pick">{busy ? t('cv.src.preparing') : t('cv.src.pick')}</button>
    </>}
    <div className="cv-src-more">
      {canUseCurrent && <button type="button" className="cv-link cv-src-current" disabled={busy} onClick={() => stage(current!)} data-testid="cv-source-current">{t('cv.src.useCurrent')}</button>}
      <button ref={libraryButton} type="button" className="cv-link" disabled={busy} aria-expanded={picker} onClick={() => setPicker(open => !open)} data-testid="cv-source-library"><Icon name="library" size={13} />{t('cv.lib.srcBtn')}</button>
    </div>
    <HistorySourcePicker open={picker} anchor={libraryButton} onClose={() => setPicker(false)} mode={mode} />
  </div>;
}

/** Img2Img: the source card, where the next image starts from, strength and the extra noise seed (the old Img2Img panel). */
export function I2ISourceSection() {
  const { t } = useUiText();
  const i2iParams = useAppStore(state => state.i2iParams);
  const setI2IParam = useAppStore(state => state.setI2IParam);
  const sourceMode = useAppStore(state => state.i2iSourceMode);
  const setSourceMode = useAppStore(state => state.setI2ISourceMode);
  return <Section testId="cv-i2i-source" title={t('cv.src')}>
    <SourceCard mode="i2i" />
    <div className="cv-pf">
      <div className="cv-pf-l"><span title={t('cv.src.nextHint')}>{t('cv.src.next')}</span></div>
      <Seg<'original' | 'latest'> full size="sm" label={t('cv.src.next')} value={sourceMode} onChange={setSourceMode} options={[{ value: 'original', label: t('cv.src.original') }, { value: 'latest', label: t('cv.src.latest') }]} />
    </div>
    <SliderField label={t('cv.i2i.strength')} value={i2iParams.strength} min={0} max={1} step={0.01} onChange={value => setI2IParam('strength', value)} testId="cv-i2i-strength" />
    <div className="cv-pf"><div className="cv-pf-l"><span>{t('cv.i2i.noiseSeed')}</span></div>
      <NumberField label={t('cv.i2i.noiseSeed')} value={i2iParams.extraNoiseSeed} min={0} normalize={value => Math.max(0, value)} onCommit={value => setI2IParam('extraNoiseSeed', value)} />
    </div>
  </Section>;
}
