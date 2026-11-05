import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, IconButton, MenuButton, Tooltip, UiPortal, showToast, type MenuEntry } from '../ui';
import { useUiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { hostErrorText } from '../host-errors';
import { droppedImagePath, hasDraggedFiles } from '../drag-drop';
import { readActionImage, stageImageInput, type ActionImage } from '../app/ImageActions';
import { ImportReader } from '../library/ImportReader';
import type { LibraryApi } from '../library/api';
import { CollectPicker } from './CollectPicker';
import { HistoryParametersDialog } from './HistoryParametersDialog';
import { openInLibrary } from '../library/intent';
import { navigate } from '../shell/route';
import type { GenerationSourceMode } from '../workspace/source-selection';
import type { GenerationPreviewEvent, HistoryItem } from '../types';
import { ImageView } from './ImageView';
import { imageName, shownName } from './sections/source';
import { useCanvasMode, isPostMode } from './ModeSwitch';
import { DraftUndoChip } from './DraftReview';

const FILM_LIMIT = 24;

/** Whether the shown history image was made with the settings on the left (the old WorkbenchContext rule). */
function useMatch(shown: HistoryItem | null) {
  const recipe = useAppStore(state => state.activeTab === 'inpaint' && state.inpaintRecipe ? state.inpaintRecipe : state.params);
  if (!shown?.params) return null;
  return Object.entries(shown.params).every(([key, value]) => JSON.stringify(value) === JSON.stringify(recipe[key as keyof typeof recipe]));
}

/**
 * The stage of the canvas (prototype 13–16): the header (current image, whether it matches the settings, the shared
 * canvas note, compare, fit, full screen, image actions), the viewport with the image or the running generation, and
 * the strip of this canvas's recent images with the batches it has in the queue. inpaintStage replaces the viewport
 * in Inpaint (its own canvas and tool bar); headerExtra sits at the right of the header.
 */
export function Stage({ inpaintStage, overlay }: { inpaintStage?: ReactNode; overlay?: ReactNode }) {
  const { t, language } = useUiText();
  const mode = useCanvasMode();
  const currentImage = useAppStore(state => state.currentImage);
  const workbenchImage = useAppStore(state => state.workbenchImage);
  const comparisonBefore = useAppStore(state => state.comparisonBeforeImage);
  const comparisonSurface = useAppStore(state => state.comparisonSurface);
  const activeSurface = useAppStore(state => state.activeCanvasSurface);
  const activeTab = useAppStore(state => state.activeTab);
  const superDrop = useAppStore(state => state.settings?.superDrop ?? false);
  const inpaint = mode === 'inpaint';
  const imageMode = mode === 'i2i' || mode === 'enhance' || isPostMode(mode);
  // The old ImageCanvas: with no current image, an image mode shows its source.
  const sourcePreview = !inpaint && !currentImage && imageMode ? workbenchImage : null;
  const comparisonHere = (activeTab === 'generate' && comparisonSurface?.startsWith('generate:')) || (activeTab === 'postprocess' && comparisonSurface?.startsWith('postprocess:'));
  const before = !inpaint && comparisonHere && comparisonSurface === activeSurface ? comparisonBefore : null;
  const shownHistory = inpaint ? null : currentImage;
  const match = useMatch(shownHistory);
  const [compare, setCompare] = useState(true);
  const [fitSignal, setFitSignal] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [paramsItem, setParamsItem] = useState<HistoryItem | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const [readFiles, setReadFiles] = useState<File[] | null>(null);
  const [collecting, setCollecting] = useState(false);
  const moreAnchor = useRef<HTMLSpanElement>(null);
  // While an image is generated the image can not become a source (as before): with 用最新结果 the result would
  // replace the source just chosen.
  const generating = useAppStore(state => state.isGenerating);
  const onZoom = useCallback((value: number) => setZoom(value), []);
  // Inpaint's canvas stays mounted once shown (its stroke history and size survive a mode switch, as before).
  const [inpaintVisited, setInpaintVisited] = useState(inpaint);
  useEffect(() => { if (inpaint) setInpaintVisited(true); }, [inpaint]);
  useEffect(() => { setCompare(true); }, [before?.fileUrl]);
  const shown = inpaint ? workbenchImage : currentImage ?? sourcePreview;
  const name = shown ? (shownHistory ? imageName(shown.filePath) : shownName(shown.filePath)) : '';
  const dropEnabled = superDrop || activeTab === 'generate' || activeTab === 'postprocess';

  const stage = (image: ActionImage, target: GenerationSourceMode) => () => void stageImageInput(image, target).catch(error => showToast({ message: hostErrorText(error, language), tone: 'danger' }));
  const actionImage: ActionImage | null = shown ? { id: shownHistory?.id, filePath: shown.filePath, fileUrl: shown.fileUrl, width: shown.width, height: shown.height, name } : null;
  const busyHint = generating ? t('cv.img.busy') : undefined;
  // 图片原数据 (the old image actions'): the image goes to the library's reader (导入图片, user decision 4).
  const readMetadata = (image: ActionImage) => () => void readActionImage(image).then(file => setReadFiles([file]))
    .catch(error => showToast({ message: t('cv.img.readFailed', { reason: hostErrorText(error, language) }), tone: 'danger' }));
  const entries: MenuEntry[] = actionImage ? [
    { id: 'i2i', icon: 'image', label: t('cv.img.i2i'), hint: busyHint, disabled: generating, onSelect: stage(actionImage, 'i2i') },
    { id: 'inpaint', icon: 'brush', label: t('cv.img.inpaint'), hint: busyHint, disabled: generating, onSelect: stage(actionImage, 'inpaint') },
    { kind: 'separator', id: 'sep1' },
    { id: 'enhance', icon: 'wand', label: t('cv.img.enhance'), disabled: generating, onSelect: stage(actionImage, 'enhance') },
    { id: 'upscale', icon: 'fit', label: t('cv.img.upscale'), disabled: generating, onSelect: stage(actionImage, 'upscale') },
    { id: 'director', icon: 'sparkle', label: t('cv.img.director'), disabled: generating, onSelect: stage(actionImage, 'director') },
    { kind: 'separator', id: 'sep2' },
    ...(shownHistory?.params ? [{ id: 'params', icon: 'restore' as const, label: t('cv.img.params'), onSelect: () => setParamsItem(shownHistory) }] : []),
    { id: 'meta', icon: 'imported', label: t('cv.img.meta'), onSelect: readMetadata(actionImage) },
    ...(shownHistory ? [{ id: 'collect', icon: 'collection' as const, label: t('cv.img.collect'), onSelect: () => setCollecting(true) }] : []),
    ...(shownHistory ? [{ id: 'lib', icon: 'library' as const, label: t('cv.img.showLib'), onSelect: () => openInLibrary({ open: { kind: 'history', id: shownHistory.id } }) }] : []),
    ...(shown?.filePath ? [{ id: 'folder', icon: 'folder' as const, label: t('cv.img.folder'), onSelect: () => void window.naiDesktop.openInExplorer(shown.filePath) }] : []),
  ] : [];

  return <section className="cv-stage" data-testid="cv-stage">
    <div className="cv-stage-head">
      <div className="cv-cur">
        <span className="ui-muted">{sourcePreview || inpaint ? t('cv.currentSource') : t('cv.current')}</span>
        <b title={shown?.filePath} data-testid="cv-current-name">{name || (shown ? `${shown.width} × ${shown.height}` : t('cv.noImage'))}</b>
        {match !== null && <span className={clsx('ui-tag', match ? 'ui-tag--ok' : 'ui-tag--warn')} data-testid="cv-match">{t(match ? 'cv.matches' : 'cv.changed')}</span>}
      </div>
      <DraftUndoChip />
      <Tooltip content={t('cv.sharedTip')} placement="bottom"><span className="cv-shared" tabIndex={0}><Icon name="agent" size={13} />{t('cv.shared')}<Icon name="info" size={13} /></span></Tooltip>
      {!inpaint && <>
        {before && <IconButton icon="compare" label={t("cv.img.compare")} active={compare} onClick={() => setCompare(value => !value)} />}
        {zoom > 1 && <span className="cv-zoom ui-num ui-faint">{t('cv.img.zoom', { n: Math.round(zoom * 100) })}</span>}
        <IconButton icon="fit" label={t('cv.img.fit')} disabled={zoom === 1} onClick={() => setFitSignal(value => value + 1)} />
        <IconButton icon="expand" label={t('cv.img.full')} disabled={!shown} onClick={() => setFull(true)} />
      </>}
      <span ref={moreAnchor} className="cv-more-anchor"><MenuButton entries={entries} label={t('cv.img.more')} placement="bottom-end" minWidth={220}>{trigger => <IconButton {...trigger} icon="more" label={t('cv.img.more')} disabled={!actionImage} />}</MenuButton></span>
    </div>
    {overlay}
    <div className="cv-vhost">
    <div className={clsx('cv-viewport', dropOver && 'is-over', inpaint && 'is-hidden')} aria-hidden={inpaint || undefined} inert={inpaint} data-image-paste="drop" tabIndex={-1}
      onDragOver={event => { if (!dropEnabled || !hasDraggedFiles(event.dataTransfer)) return; event.preventDefault(); setDropOver(true); }}
      onDragLeave={() => setDropOver(false)}
      onDrop={event => {
        event.preventDefault(); setDropOver(false);
        if (!dropEnabled) return;
        void droppedImagePath(event.dataTransfer).then(filePath => { if (filePath) void stageImageInput({ filePath }).catch(error => showToast({ message: hostErrorText(error, language), tone: 'danger' })); });
      }}>
      {dropOver && <div className="cv-drop"><span>{t('cv.drop')}</span></div>}
      {!inpaint && <GenerationOverlay />}
      {!inpaint && (shown ? <ImageView image={shown} before={currentImage ? before : null} compare={compare} fitSignal={fitSignal} onZoom={onZoom} alt={t('cv.img.alt')} /> : <EmptyStage post={isPostMode(mode) || mode === 'i2i'} />)}
    </div>
    {inpaintVisited && <div className={clsx('cv-viewport cv-viewport--inpaint', !inpaint && 'is-hidden')} aria-hidden={!inpaint || undefined} inert={!inpaint}>{inpaintStage}</div>}
    </div>
    <FilmStrip />
    {full && shown && <FullScreen src={shown.fileUrl} alt={name} onClose={() => setFull(false)} />}
    {paramsItem && <HistoryParametersDialog item={paramsItem} onClose={() => setParamsItem(null)} />}
    {readFiles && <ImportReader api={window.naiDesktop as unknown as LibraryApi} files={readFiles} importable={false} onClose={() => setReadFiles(null)} onReused={() => setReadFiles(null)} />}
    {collecting && shownHistory && <CollectPicker open anchor={moreAnchor} onClose={() => setCollecting(false)} historyId={shownHistory.id} />}
  </section>;
}

function EmptyStage({ post }: { post: boolean }) {
  const { t } = useUiText();
  const isGenerating = useAppStore(state => state.isGenerating);
  if (isGenerating) return null;
  return <div className="cv-empty" data-testid="cv-empty">
    <span className="cv-empty-mark"><Icon name="sparkle" size={22} /></span>
    <b>{post ? t('cv.empty.post') : t('cv.empty.title')}</b>
    <span className="ui-muted">{t('cv.empty.hint')}</span>
  </div>;
}

/** The running manual generation over the viewport: its stream preview, or the phase it is in (the old overlay). */
function GenerationOverlay() {
  const { t } = useUiText();
  const isGenerating = useAppStore(state => state.isGenerating);
  const preview = useAppStore(state => state.generationPreview);
  const phase = useAppStore(state => state.generationPhase);
  const currentImage = useAppStore(state => state.currentImage);
  const [handoff, setHandoff] = useState<GenerationPreviewEvent | null>(null);
  const [leaving, setLeaving] = useState(false);
  const streamComplete = phase === 'saving' || (preview?.progress ?? 0) >= 1;
  const visible = isGenerating ? preview : handoff;
  // The old ImageCanvas handoff: the final stream frame stays until the saved image is decoded, then fades.
  useEffect(() => {
    if (isGenerating) {
      if (preview?.imageDataUrl && streamComplete) { setHandoff(preview); setLeaving(false); }
      else if (phase === 'preparing' || phase === 'requesting') { setHandoff(null); setLeaving(false); }
      return;
    }
    if (!handoff?.imageDataUrl) return;
    if (currentImage?.fileUrl !== handoff.imageDataUrl) { setHandoff(null); setLeaving(false); return; }
    let first = 0, second = 0, finish = 0;
    first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(() => { setLeaving(true); finish = window.setTimeout(() => { setHandoff(null); setLeaving(false); }, 180); }); });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); window.clearTimeout(finish); };
  }, [phase, preview, handoff, isGenerating, streamComplete]);
  const waiting = phase === 'preparing' ? ['cv.wait.preparing', 'cv.wait.preparingHint'] as const
    : phase === 'queued' ? ['cv.wait.queued', 'cv.wait.queuedHint'] as const
    : phase === 'requesting' ? ['cv.wait.requesting', 'cv.wait.requestingHint'] as const
    : phase === 'saving' ? ['cv.wait.saving', 'cv.wait.savingHint'] as const
    : ['cv.wait.generating', 'cv.wait.generatingHint'] as const;
  if (!isGenerating && !handoff) return null;
  const complete = !isGenerating || streamComplete;
  return <div className={clsx('cv-gen', visible?.imageDataUrl ? 'has-preview' : 'is-waiting', !isGenerating && 'is-completing', leaving && 'is-leaving')} aria-live="polite" data-testid="cv-generating">
    {visible?.imageDataUrl ? <>
      <img className="cv-gen-frame" src={visible.imageDataUrl} alt={t('cv.wait.generating')} />
      <div className="cv-gen-status">
        <b>{complete ? t('cv.wait.saving') : t('cv.wait.streaming', { cur: String(visible.currentStep ?? 0), total: String(visible.totalSteps ?? 0), pct: String(Math.round(visible.progress * 100)) })}</b>
        <span className="cv-gen-track"><i style={{ width: `${Math.round(visible.progress * 100)}%` }} /></span>
      </div>
    </> : <div className="cv-gen-wait"><span className="cv-spinner" /><div><b>{t(waiting[0])}</b><small className="ui-muted">{t(waiting[1])}</small></div></div>}
  </div>;
}

/** This canvas's recent images: manual images of the shown day (agent images go to the queue and the library). */
function FilmStrip() {
  const { t } = useUiText();
  const history = useAppStore(state => state.history);
  const currentId = useAppStore(state => state.currentImage?.id);
  const manual = useAppStore(state => state.manualBatches.length);
  const recent = history.filter(item => !item.generationOrigin).slice(0, FILM_LIMIT);
  const show = (item: HistoryItem) => useAppStore.setState({ currentImage: item, comparisonBeforeImage: null, comparisonSurface: null });
  return <div className="cv-film" data-testid="cv-film">
    <div className="cv-film-l ui-faint">{t('cv.film')}</div>
    <div className="cv-film-strip">
      {recent.length ? recent.map(item => <button key={item.id} type="button" className={clsx('cv-film-item', item.id === currentId && 'is-on', item.width > item.height && 'is-land')} aria-label={t('cv.film.open', { name: imageName(item.filePath) })} aria-pressed={item.id === currentId} onClick={() => show(item)}>
        <img src={item.fileUrl} alt="" loading="lazy" decoding="async" />
      </button>) : <span className="ui-faint cv-film-none">{t('cv.film.none')}</span>}
    </div>
    {manual > 0 && <button type="button" className="ui-chip cv-qchip" onClick={() => navigate('queue')} data-testid="cv-queue-chip"><span className="cv-dot is-live" />{t('cv.queueFromCanvas', { n: manual })}<Icon name="right" size={12} /></button>}
  </div>;
}

function FullScreen({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const { t } = useUiText();
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);
  return <UiPortal><div className="cv-full" role="dialog" aria-modal="true" aria-label={t('cv.img.full')} onClick={onClose}>
    <img src={src} alt={alt} onClick={event => event.stopPropagation()} />
    <IconButton className="cv-full-close" icon="x" label={t('cv.img.close')} onClick={onClose} />
  </div></UiPortal>;
}
