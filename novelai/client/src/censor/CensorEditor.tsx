import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import type { AssetDetail, AssetItem } from '../asset-library/types';
import { Button, Icon, IconButton, Seg, Spinner, UiPortal, showToast, type IconName } from '../ui';
import { uiText, useUiText } from '../ui/i18n';
import { SliderField } from '../canvas/controls';
import type { LibraryApi } from '../library/api';
import { libraryErrorText } from '../library/errors';
import { fileName, itemTitle } from '../library/present';
import { Thumb } from '../library/Thumb';
import { WindowControls } from '../shell/WindowControls';
import { censoredExportStem } from './export-types';
import {
  addStroke, blurSizeOf, brushSizeOf, CENSOR_RANGES, CENSOR_STYLES, CENSOR_TOOLS, clearStrokes, hasCensoring, loadCensorSettings, mosaicSizeOf, recallHistory, redoStroke,
  rememberHistory, saveCensorSettings, standardMosaicSize, undoStroke, type CensorHistory, type CensorSettings, type CensorStroke, type CensorStyle, type CensorTool,
} from './model';
import { buildLayer, canvasOf, CensorImageError, composeOverlay, contextOf, drawStroke, loadBase, paintMask, renderCensored, type CensorImageFailure } from './render';
import './censor.css';

export interface CensorEditorProps {
  api: LibraryApi;
  /** The images to censor and export, in order (history images and imported images). */
  items: readonly AssetItem[];
  onClose(): void;
}

const keyOf = (item: Pick<AssetItem, 'kind' | 'id'>) => `${item.kind}:${item.id}`;
const TOOL_ICONS: Record<CensorTool, IconName> = { brush: 'brush', lasso: 'lasso', eraser: 'eraser' };
const TOOL_KEYS: Record<string, CensorTool> = { b: 'brush', l: 'lasso', e: 'eraser' };
const MAX_SCALE = 32;
const STAGE_PADDING = 28;

/** The original of a library image (the same file the detail drawer shows). */
async function originalUrl(api: LibraryApi, item: Pick<AssetItem, 'kind' | 'id'>): Promise<string> {
  const detail = await api.assetLibrary({ action: 'ui-read', kind: item.kind, id: item.id }) as AssetDetail;
  const assets = detail?.assets ?? [];
  const url = (assets.find(asset => asset.role === 'original' && asset.fileUrl) ?? assets.find(asset => asset.fileUrl))?.fileUrl ?? detail?.item?.payload?.fileUrl;
  if (typeof url !== 'string' || !url) throw new CensorImageError('unreadable');
  return url;
}

type View = { scale: number; x: number; y: number };
type Gesture = { type: 'pan'; pointer: number; fromX: number; fromY: number; x: number; y: number } | { type: 'draw'; pointer: number };

/**
 * Censor and export (for posting): the image full size, a brush, a lasso and an eraser to mark what to cover, the
 * covering shown as it will be saved (mosaic, blur or a flat colour), then a JPG without any metadata. The library's
 * original is only read. Several images are censored one after another and exported together.
 */
export function CensorEditor(props: CensorEditorProps) {
  // The surface mounts once the overlay root exists, so its effects always find its elements.
  return props.items.length ? <UiPortal><CensorSurface {...props} /></UiPortal> : null;
}

function CensorSurface({ api, items, onClose }: CensorEditorProps) {
  const { t, lang } = useUiText();
  const [index, setIndex] = useState(0);
  const item = items[Math.min(index, items.length - 1)];
  const key = keyOf(item);
  const [settings, setSettings] = useState<CensorSettings>(() => loadCensorSettings());
  const [tool, setTool] = useState<CensorTool>('brush');
  const [history, setHistory] = useState<CensorHistory>(() => recallHistory(key));
  const [image, setImage] = useState<{ key: string; width: number; height: number } | null>(null);
  const [failure, setFailure] = useState<CensorImageFailure | null>(null);
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [peek, setPeek] = useState(false);
  const [panning, setPanning] = useState(false);
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [, refreshMarks] = useReducer((value: number) => value + 1, 0);

  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const committedRef = useRef<HTMLCanvasElement | null>(null);
  const activeRef = useRef<CensorStroke | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef<number | null>(null);
  const spaceRef = useRef(false);
  const viewRef = useRef(view); viewRef.current = view;
  const historyRef = useRef(history); historyRef.current = history;
  const featherRef = useRef(settings.feather); featherRef.current = settings.feather;
  const busyRef = useRef(false); busyRef.current = !!busy;

  const ready = !!image && image.key === key;
  const width = ready ? image.width : 0, height = ready ? image.height : 0;
  const mosaic = mosaicSizeOf(settings, width, height), blur = blurSizeOf(settings, width, height), brush = brushSizeOf(settings, width, height);
  const standard = standardMosaicSize(width, height);

  const update = (patch: Partial<CensorSettings>) => setSettings(current => { const next = { ...current, ...patch }; saveCensorSettings(next); return next; });
  const commit = (next: CensorHistory) => { if (next === historyRef.current) return; historyRef.current = next; setHistory(next); rememberHistory(key, next); refreshMarks(); };

  // ── Drawing ────────────────────────────────────────────────────────────────
  const redraw = useCallback(() => {
    frameRef.current = null;
    const mask = maskRef.current, committed = committedRef.current, layer = layerRef.current, overlay = overlayRef.current;
    if (!mask || !committed || !layer || !overlay) return;
    const context = contextOf(mask);
    context.globalCompositeOperation = 'copy';
    context.drawImage(committed, 0, 0);
    context.globalCompositeOperation = 'source-over';
    if (activeRef.current) drawStroke(context, activeRef.current, mask.width, mask.height);
    composeOverlay(overlay, mask, layer, featherRef.current);
  }, []);
  const schedule = () => { if (frameRef.current === null) frameRef.current = requestAnimationFrame(redraw); };
  useEffect(() => () => { if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); }, []);

  // The image: read once per image, drawn on white at its own size.
  useEffect(() => {
    let live = true;
    setImage(null); setFailure(null);
    activeRef.current = null; gestureRef.current = null;
    void (async () => {
      const loaded = await loadBase(await originalUrl(api, item));
      const base = baseRef.current, overlay = overlayRef.current;
      if (!live || !base || !overlay) return;
      base.width = overlay.width = loaded.width; base.height = overlay.height = loaded.height;
      contextOf(base).drawImage(loaded, 0, 0);
      maskRef.current = canvasOf(loaded.width, loaded.height);
      committedRef.current = canvasOf(loaded.width, loaded.height);
      layerRef.current = null;
      setImage({ key, width: loaded.width, height: loaded.height });
    })().catch(error => { if (live) setFailure(error instanceof CensorImageError ? error.failure : 'unreadable'); });
    return () => { live = false; };
  }, [key]);

  // The censored layer follows the way of censoring; the mask follows the strokes.
  useEffect(() => {
    if (!ready || !baseRef.current) return;
    layerRef.current = buildLayer(baseRef.current, settings);
    redraw();
  }, [ready, image, settings.style, mosaic, blur]);
  useEffect(() => {
    if (!ready || !committedRef.current) return;
    paintMask(committedRef.current, history.strokes);
    redraw();
  }, [ready, image, history.strokes]);
  useEffect(() => { if (ready) redraw(); }, [settings.feather]);

  // ── View (zoom, pan) ───────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const node = viewportRef.current;
    if (!node || !width || !height) return;
    const rect = node.getBoundingClientRect();
    const scale = Math.min(4, Math.max(0.01, Math.min((rect.width - STAGE_PADDING * 2) / width, (rect.height - STAGE_PADDING * 2) / height)));
    setFitScale(scale);
    setView({ scale, x: (rect.width - width * scale) / 2, y: (rect.height - height * scale) / 2 });
  }, [width, height]);
  useLayoutEffect(() => { fit(); }, [fit]);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver !== 'function') return;
    let first = true;
    const observer = new ResizeObserver(() => { if (first) first = false; else fit(); });
    observer.observe(node);
    return () => observer.disconnect();
  }, [fit]);
  const zoomAt = useCallback((clientX: number, clientY: number, factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    setView(current => {
      const scale = Math.min(MAX_SCALE, Math.max(fitScale / 2, current.scale * factor)), ratio = scale / current.scale;
      const px = clientX - rect.left, py = clientY - rect.top;
      return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, [fitScale]);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    // A wheel listener React adds is passive; zooming must keep the page from scrolling.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const step = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
      zoomAt(event.clientX, event.clientY, Math.min(1.35, Math.max(0.74, Math.exp(-step * (event.ctrlKey ? 0.01 : 0.0015)))));
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  const imagePoint = (event: { clientX: number; clientY: number }): [number, number] => {
    const rect = viewportRef.current!.getBoundingClientRect(), current = viewRef.current;
    return [(event.clientX - rect.left - current.x) / current.scale, (event.clientY - rect.top - current.y) / current.scale];
  };
  const moveCursor = (event: { clientX: number; clientY: number }, shown: boolean) => {
    const node = cursorRef.current, rect = viewportRef.current?.getBoundingClientRect();
    if (!node || !rect) return;
    node.style.transform = `translate(${event.clientX - rect.left}px, ${event.clientY - rect.top}px)`;
    node.style.opacity = shown ? '1' : '0';
  };
  const extend = (stroke: CensorStroke, x: number, y: number) => {
    const points = stroke.points, lastX = points[points.length - 2], lastY = points[points.length - 1];
    if (Math.hypot(x - lastX, y - lastY) >= 0.75) points.push(x, y);
  };
  const finishStroke = () => {
    const stroke = activeRef.current;
    activeRef.current = null;
    if (!stroke || !committedRef.current) return;
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    if (stroke.tool === 'lasso' && stroke.points.length < 6) { redraw(); return; }
    // Drawn on the kept mask at once (the same drawing the replay does), so the stroke never blinks.
    drawStroke(contextOf(committedRef.current), stroke, committedRef.current.width, committedRef.current.height);
    redraw();
    commit(addStroke(historyRef.current, stroke));
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (busyRef.current || gestureRef.current) return;
    rootRef.current?.focus({ preventScroll: true });
    if (event.button === 1 || event.button === 2 || (event.button === 0 && spaceRef.current)) {
      event.preventDefault();
      gestureRef.current = { type: 'pan', pointer: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: viewRef.current.x, y: viewRef.current.y };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPanning(true);
      moveCursor(event, false);
      return;
    }
    if (event.button !== 0 || !ready) return;
    event.preventDefault();
    const [x, y] = imagePoint(event);
    activeRef.current = { tool, size: brush, points: [x, y] };
    gestureRef.current = { type: 'draw', pointer: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    schedule();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    moveCursor(event, gesture?.type !== 'pan' && !spaceRef.current);
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (gesture.type === 'pan') { setView(current => ({ ...current, x: gesture.x + event.clientX - gesture.fromX, y: gesture.y + event.clientY - gesture.fromY })); return; }
    const stroke = activeRef.current;
    if (!stroke) return;
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event.nativeEvent]) extend(stroke, ...imagePoint(sample));
    schedule();
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (gesture.type === 'pan') setPanning(false);
    else finishStroke();
  };

  // ── Images ─────────────────────────────────────────────────────────────────
  const select = (next: number) => {
    if (busy || next === index || next < 0 || next >= items.length) return;
    setIndex(next);
    const recalled = recallHistory(keyOf(items[next]));
    historyRef.current = recalled; setHistory(recalled);
  };

  // ── Export ─────────────────────────────────────────────────────────────────
  const exportAll = async () => {
    if (busy || !api.exportCensoredImage) return;
    const total = items.length;
    setBusy({ done: 0, total });
    try {
      const begun = await api.exportCensoredImage({ action: 'begin', count: total, name: censoredExportStem(fileName(items[0]) || itemTitle(items[0])) });
      if (begun.status !== 'ready') return;
      let failed = 0;
      for (const [position, entry] of items.entries()) {
        try {
          const pixels = renderCensored(await loadBase(await originalUrl(api, entry)), recallHistory(keyOf(entry)).strokes, settings);
          await api.exportCensoredImage({ action: 'write', session: begun.session, name: censoredExportStem(fileName(entry) || itemTitle(entry)), width: pixels.width, height: pixels.height,
            pixels: new Uint8Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), quality: settings.quality });
        } catch { failed++; }
        setBusy({ done: position + 1, total });
      }
      const done = await api.exportCensoredImage({ action: 'finish', session: begun.session });
      const written = done.status === 'done' ? done.written : total - failed, reveal = done.status === 'done' ? done.reveal : null;
      if (!written) { showToast({ message: t('cz.exportFailed'), tone: 'danger' }); return; }
      showToast({
        message: language => failed ? uiText(language, 'cz.exportedPartial', { n: written, m: failed }) : uiText(language, 'cz.exported', { n: written }), tone: failed ? 'warn' : 'ok', durationMs: 9000,
        action: reveal && api.openInExplorer ? { label: language => uiText(language, 'cz.reveal'), onClick: () => void api.openInExplorer!(reveal) } : undefined,
      });
      if (!failed) onClose();
    } catch (error) {
      showToast({ message: `${t('cz.exportFailed')} · ${libraryErrorText(error, t, lang)}`, tone: 'danger' });
    } finally { setBusy(null); }
  };

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = event => {
    if (event.isComposing) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = !!target?.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]');
    if (event.key === ' ') {
      if (typing) return;
      // Space pans; it must not press the button that still has the focus.
      event.preventDefault();
      if (event.type === 'keydown' && !spaceRef.current) { spaceRef.current = true; rootRef.current?.setAttribute('data-space', 'true'); if (cursorRef.current) cursorRef.current.style.opacity = '0'; }
      if (event.type === 'keyup') { spaceRef.current = false; rootRef.current?.removeAttribute('data-space'); }
      return;
    }
    if (event.type !== 'keydown') return;
    if (event.key === 'Escape') {
      if (typing) return;
      event.preventDefault(); event.stopPropagation();
      if (!busyRef.current) onClose();
      return;
    }
    if (busyRef.current) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (!gestureRef.current) commit(event.shiftKey ? redoStroke(historyRef.current) : undoStroke(historyRef.current)); return; }
    if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); if (!gestureRef.current) commit(redoStroke(historyRef.current)); return; }
    if (mod || event.altKey || typing) return;
    const picked = TOOL_KEYS[event.key.toLowerCase()];
    if (picked) { setTool(picked); return; }
    if (event.key === '[' || event.key === ']') update({ brushSize: Math.min(CENSOR_RANGES.brush.max, Math.max(CENSOR_RANGES.brush.min, Math.round(brush * (event.key === ']' ? 1.15 : 1 / 1.15)) + (event.key === ']' ? 1 : -1))) });
    if (event.key === '0') fit();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listener); window.addEventListener('keyup', listener);
    const blur = () => { spaceRef.current = false; rootRef.current?.removeAttribute('data-space'); };
    window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', listener); window.removeEventListener('keyup', listener); window.removeEventListener('blur', blur); };
  }, []);
  // The focus comes in when the editor opens, stays inside it, and goes back where it was when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const trapFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !rootRef.current) return;
    const list = [...rootRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!list.length) { event.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], current = document.activeElement;
    if (event.shiftKey && (current === first || current === rootRef.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
  };

  const covered = hasCensoring(history);
  const many = items.length > 1;
  const cursorSize = tool === 'lasso' ? 0 : brush * view.scale;
  return (
    <div ref={rootRef} className="cz" role="dialog" aria-modal="true" aria-label={t('cz.title')} tabIndex={-1} onKeyDown={trapFocus} data-testid="censor-editor" data-tool={tool} data-panning={panning || undefined} aria-busy={!!busy || undefined}>
      <div className="cz-head">
          <span className="cz-title"><Icon name="mosaic" size={16} />{t('cz.title')}</span>
          <span className="cz-name ui-mono" title={fileName(item)}>{fileName(item) || itemTitle(item)}</span>
          {ready && <span className="ui-muted ui-num">{width}×{height}</span>}
          <span className="cz-grow" />
          {many && <span className="cz-pager">
            <IconButton size="sm" icon="left" label={t('cz.prev')} disabled={index === 0 || !!busy} onClick={() => select(index - 1)} />
            <span className="ui-num" data-testid="censor-count">{t('cz.count', { n: index + 1, m: items.length })}</span>
            <IconButton size="sm" icon="right" label={t('cz.next')} disabled={index >= items.length - 1 || !!busy} onClick={() => select(index + 1)} />
          </span>}
          <Button size="sm" variant="ghost" icon="fit" onClick={fit} title={t('cz.fit')} data-testid="censor-fit"><span className="ui-num">{t('cz.zoom', { n: Math.round(view.scale * 100) })}</span></Button>
          <IconButton icon="x" label={t('cz.close')} disabled={!!busy} onClick={onClose} data-testid="censor-close" />
          <WindowControls />
      </div>
      <div className="cz-body">
      <div className="cz-main">
        <div ref={viewportRef} className="cz-viewport" aria-label={t('cz.stage')} data-testid="censor-stage"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          onPointerLeave={event => moveCursor(event, false)} onContextMenu={event => event.preventDefault()}>
          <div className="cz-content" style={{ width: width || undefined, height: height || undefined, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: ready ? 'visible' : 'hidden' }} data-pixelated={view.scale >= 3 || undefined}>
            <canvas ref={baseRef} className="cz-canvas" />
            <canvas ref={overlayRef} className="cz-canvas" style={{ visibility: peek ? 'hidden' : 'visible' }} data-testid="censor-overlay" />
          </div>
          <div ref={cursorRef} className="cz-cursor" aria-hidden="true" style={{ width: cursorSize, height: cursorSize, marginLeft: -cursorSize / 2, marginTop: -cursorSize / 2, display: ready && cursorSize ? 'block' : 'none' }} />
          {!ready && !failure && <p className="cz-state" role="status"><Spinner size={16} /> {t('cz.loading')}</p>}
          {failure && <p className="cz-state is-error" role="alert"><Icon name="alert" size={16} /> {t(failure === 'too_large' ? 'cz.tooLarge' : 'cz.unreadable')}</p>}
        </div>
        {many && <div className="cz-strip" role="listbox" aria-label={t('cz.strip')} aria-orientation="horizontal">
          {items.map((entry, position) => {
            const marked = hasCensoring(position === index ? history : recallHistory(keyOf(entry)));
            return <button key={keyOf(entry)} type="button" role="option" aria-selected={position === index} className={clsx('cz-strip-item', position === index && 'is-on')} disabled={!!busy}
              aria-label={t(marked ? 'cz.stripItemCovered' : 'cz.stripItem', { n: position + 1 })} onClick={() => select(position)} data-testid={`censor-strip-${position}`}>
              <Thumb api={api} item={entry as AssetItem} />
              {marked && <span className="cz-strip-mark" aria-hidden="true"><Icon name="mosaic" size={11} /></span>}
            </button>;
          })}
        </div>}
        <p className="cz-help ui-faint">{t('cz.help')}</p>
      </div>
      <aside className="cz-side">
        <div className="cz-side-scroll">
          <section className="cz-sec">
            <h3>{t('cz.tool')}</h3>
            <Seg<CensorTool> full label={t('cz.tool')} value={tool} onChange={setTool} options={CENSOR_TOOLS.map(value => ({ value, icon: TOOL_ICONS[value], label: t(`cz.tool.${value}`), title: `${t(`cz.tool.${value}`)} · ${value[0].toUpperCase()}` }))} />
            {tool !== 'lasso' && <SliderField label={t('cz.brushSize')} value={brush} min={CENSOR_RANGES.brush.min} max={Math.min(CENSOR_RANGES.brush.max, 300)} step={1} testId="censor-brush"
              normalize={next => Math.min(CENSOR_RANGES.brush.max, Math.max(CENSOR_RANGES.brush.min, Math.round(next)))} format={value => t('cz.px', { n: value })} onChange={next => update({ brushSize: next })} />}
            <div className="cz-row">
              <Button size="sm" icon="undo" disabled={!history.strokes.length || !!busy} onClick={() => commit(undoStroke(history))} title={`${t('cz.undo')} · ⌘/Ctrl Z`} data-testid="censor-undo">{t('cz.undo')}</Button>
              <Button size="sm" icon="redo" disabled={!history.redo.length || !!busy} onClick={() => commit(redoStroke(history))} title={`${t('cz.redo')} · ⌘/Ctrl Shift Z`} data-testid="censor-redo">{t('cz.redo')}</Button>
              <Button size="sm" icon="trash" disabled={!covered || !!busy} onClick={() => commit(clearStrokes(history))} data-testid="censor-clear">{t('cz.clear')}</Button>
            </div>
          </section>
          <section className="cz-sec">
            <h3>{t('cz.style')}</h3>
            <Seg<CensorStyle> full label={t('cz.style')} value={settings.style} onChange={style => update({ style })} options={CENSOR_STYLES.map(value => ({ value, label: t(`cz.style.${value}`) }))} />
            {settings.style === 'mosaic' && <>
              <SliderField label={t('cz.mosaicSize')} value={mosaic} min={CENSOR_RANGES.mosaic.min} max={CENSOR_RANGES.mosaic.max} step={1} testId="censor-mosaic" format={value => t('cz.px', { n: value })} onChange={next => update({ mosaicSize: next })} />
              {ready && <p className={clsx('cz-hint', mosaic < standard && 'is-warn')} data-testid="censor-mosaic-hint">
                {t('cz.mosaicHint', { n: standard })}{mosaic < standard && ` ${t('cz.mosaicFine')}`}
                {settings.mosaicSize !== null && mosaic !== standard && <> <button type="button" className="lib-link" onClick={() => update({ mosaicSize: null })}>{t('cz.mosaicReset', { n: standard })}</button></>}
              </p>}
            </>}
            {settings.style === 'blur' && <SliderField label={t('cz.blurSize')} value={blur} min={CENSOR_RANGES.blur.min} max={CENSOR_RANGES.blur.max} step={1} testId="censor-blur" format={value => t('cz.px', { n: value })} onChange={next => update({ blurSize: next })} />}
            <SliderField label={t('cz.feather')} value={settings.feather} min={CENSOR_RANGES.feather.min} max={CENSOR_RANGES.feather.max} step={1} testId="censor-feather" format={value => t('cz.px', { n: value })} onChange={next => update({ feather: next })} />
            <Button size="sm" variant="ghost" icon="eye" block disabled={!covered} onPointerDown={() => setPeek(true)} onPointerUp={() => setPeek(false)} onPointerLeave={() => setPeek(false)} onPointerCancel={() => setPeek(false)}
              onKeyDown={event => { if (event.key === 'Enter') setPeek(true); }} onKeyUp={() => setPeek(false)} onBlur={() => setPeek(false)} data-testid="censor-peek">{t('cz.peek')}</Button>
          </section>
          <section className="cz-sec">
            <h3>{t('cz.output')}</h3>
            <SliderField label={t('cz.quality')} value={settings.quality} min={CENSOR_RANGES.quality.min} max={CENSOR_RANGES.quality.max} step={1} testId="censor-quality" onChange={next => update({ quality: next })} />
            <p className="cz-hint">{t('cz.note')}</p>
            {ready && !covered && <p className="cz-hint" data-testid="censor-uncovered">{t('cz.uncovered')}</p>}
          </section>
        </div>
        <div className="cz-foot">
          {busy && <p className="cz-progress ui-num" role="status" data-testid="censor-progress"><Spinner size={14} /> {t('cz.exporting', { n: Math.min(busy.total, busy.done + 1), m: busy.total })}</p>}
          <div className="cz-row">
            <Button onClick={onClose} disabled={!!busy} data-testid="censor-cancel">{t('cz.cancel')}</Button>
            <Button variant="primary" icon="download" busy={!!busy} disabled={(!many && !ready) || !api.exportCensoredImage} onClick={() => void exportAll()} data-testid="censor-export">{many ? t('cz.exportAll', { n: items.length }) : t('cz.export')}</Button>
          </div>
        </div>
      </aside>
      </div>
    </div>
  );
}
