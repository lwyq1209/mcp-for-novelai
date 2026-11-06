import { useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { useUiText } from '../ui/i18n';
import { useAppStore, WS_LEFT_DEFAULT, WS_LEFT_MAX, WS_LEFT_MIN } from '../store';
import { ModeSwitch, useCanvasMode } from './ModeSwitch';
import { GenerateBar } from './GenerateBar';
import { Stage } from './Stage';
import { DraftLayer } from './DraftReview';
import { ModelSection, PromptSection, StyleSection } from './sections/prompt';
import { CharactersSection } from './sections/characters';
import { ReferencesSection } from './sections/references';
import { ParamsSection } from './sections/params';
import { OutputSection } from './sections/output';
import { I2ISourceSection } from './sections/source';
import { InpaintSettings, useInpaintBlock } from './sections/inpaint';
import { DirectorSettings, EnhanceSettings, UpscaleSettings, runEnhance, useEnhanceTarget, useUpscaleTarget } from './sections/post';
import './canvas.css';

export interface CanvasPageProps {
  /** The viewport of Inpaint (its canvas and mask tools). */
  inpaintStage?: ReactNode;
}

/**
 * The canvas page (step 4b3, prototype 13–16): the left column (mode switch, the mode's settings, the generate bar)
 * and the stage with the agent draft banner and review. Every mode reads and writes the same store fields and runs the
 * same manual path as before (the store's generate / generateI2I / inpaint / upscaleCurrentImage / runDirectorTool).
 */
export function CanvasPage({ inpaintStage }: CanvasPageProps) {
  const { t } = useUiText();
  const mode = useCanvasMode();
  const width = useAppStore(state => state.wsLeftWidth);
  const left = useRef<HTMLElement>(null);
  // The default width stays the stylesheet's (384, or 352 in a narrower window); a width the user dragged to is kept.
  const style = width !== WS_LEFT_DEFAULT ? { '--cv-left-w': `${width}px` } as CSSProperties : undefined;
  return <div className="ui-scope cv-page" data-testid="canvas-page" data-mode={mode} style={style}>
    <aside ref={left} className="cv-left" aria-label={t('cv.left')} data-testid="cv-left">
      <ModeSwitch />
      <div className="cv-scroll" data-testid="cv-scroll">
        {mode === 't2i' || mode === 'i2i' ? <>
          {mode === 'i2i' && <I2ISourceSection />}
          <ModelSection />
          <PromptSection />
          <StyleSection />
          <CharactersSection />
          <ReferencesSection />
          <ParamsSection imageToImage={mode === 'i2i'} />
          <OutputSection />
        </> : mode === 'inpaint' ? <InpaintSettings />
          : mode === 'enhance' ? <EnhanceSettings />
          : mode === 'upscale' ? <UpscaleSettings />
          : <DirectorSettings />}
      </div>
      <ModeGenerateBar mode={mode} />
    </aside>
    <LeftResizer column={left} />
    <Stage inpaintStage={inpaintStage} overlay={<DraftLayer />} />
  </div>;
}

/**
 * The divider at the left column's right edge (the old workspace resizer): drag to resize, double-click to reset, arrow
 * keys by 16 px. The width is kept between WS_LEFT_MIN and WS_LEFT_MAX (and at most 45% of the window, canvas.css);
 * 设置 › 画布 › 恢复默认宽度 resets it too.
 */
function LeftResizer({ column }: { column: RefObject<HTMLElement | null> }) {
  const { t } = useUiText();
  const width = useAppStore(state => state.wsLeftWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const store = useAppStore.getState;
  // The drag follows the pointer on the window (so it does not depend on pointer capture) until the button is released.
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { x: event.clientX, width: column.current?.getBoundingClientRect().width ?? width };
    const move = (moved: PointerEvent) => { if (drag.current) store().setWsWidth('left', drag.current.width + moved.clientX - drag.current.x); };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
      if (!drag.current) return;
      drag.current = null;
      store().saveWsWidths();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  };
  return <div className="cv-resizer" role="separator" aria-orientation="vertical" aria-label={t('cv.resize')} title={t('cv.resize')} tabIndex={0} data-testid="cv-resizer"
    aria-valuemin={WS_LEFT_MIN} aria-valuemax={WS_LEFT_MAX} aria-valuenow={Math.round(column.current?.getBoundingClientRect().width ?? width)}
    onPointerDown={startDrag}
    onDoubleClick={() => store().resetWsWidths()}
    onKeyDown={event => {
      const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
      if (!step) return;
      event.preventDefault();
      store().setWsWidth('left', (column.current?.getBoundingClientRect().width ?? width) + step);
      store().saveWsWidths();
    }} />;
}

/** The generate bar of a mode: its quote feature (Enhance quotes as Img2Img, as before), label, run and refusals. */
function ModeGenerateBar({ mode }: { mode: ReturnType<typeof useCanvasMode> }) {
  const { t } = useUiText();
  const store = useAppStore;
  const inpaintBlock = useInpaintBlock();
  const enhance = useEnhanceTarget();
  const upscale = useUpscaleTarget();
  const enhanceScale = useAppStore(state => state.enhanceScale);
  const enhanceMagnitude = useAppStore(state => state.enhanceMagnitude);
  const hasSource = useAppStore(state => !!state.workbenchImage);
  const noSource = hasSource ? '' : t('cv.gen.noImage');
  if (mode === 't2i') return <GenerateBar feature="generate" onRun={() => void store.getState().generate()} />;
  if (mode === 'i2i') return <GenerateBar feature="i2i" onRun={() => void store.getState().generateI2I()} />;
  if (mode === 'inpaint') return <GenerateBar feature="inpaint" showCount={false} label={t('cv.ip.run')} onRun={() => void store.getState().inpaint()} disabled={!!inpaintBlock} disabledReason={inpaintBlock} />;
  if (mode === 'enhance') return <GenerateBar feature="i2i" label={enhanceScale === 'max' ? t('cv.pp.run.enhanceMax') : t('cv.pp.run.enhance', { scale: String(enhanceScale) })} onRun={() => void runEnhance()} disabled={enhance.tooLarge || !hasSource} disabledReason={enhance.reason || noSource}
    quoteOverride={{ enhance: true, ...(enhance.max && enhance.input ? { max: { width: enhance.input.width, height: enhance.input.height, strength: Math.min(0.48, 0.10 + enhanceMagnitude * 0.034) } } : {}) }} />;
  if (mode === 'upscale') return <GenerateBar feature="upscale" showCount={false} label={t('cv.pp.run.upscale', { scale: String(upscale.scale) })} onRun={() => void store.getState().upscaleCurrentImage()} disabled={upscale.tooLarge || !hasSource} disabledReason={upscale.reason || noSource} />;
  return <GenerateBar feature="director" showCount={false} label={t('cv.pp.run.director')} onRun={() => void store.getState().runDirectorTool()} disabled={!hasSource} disabledReason={noSource} />;
}
