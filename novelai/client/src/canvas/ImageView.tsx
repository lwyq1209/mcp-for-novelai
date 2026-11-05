import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import clsx from 'clsx';
import { useUiText } from '../ui/i18n';

export type ViewableImage = { id?: string; fileUrl: string; width: number; height: number };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The image of the stage (moved from the old ZoomableImageStage of App.tsx, step 4b3): fitted to the viewport, wheel
 * zoom 1–8× around the pointer, middle-button pan, and a before/after divider when compare is on. fitSignal resets
 * the zoom when it changes; onZoom reports the zoom so the stage header can show it.
 */
export function ImageView({ image, before, compare, fitSignal, onZoom, alt }: { image: ViewableImage; before?: ViewableImage | null; compare: boolean; fitSignal: number; onZoom?: (zoom: number) => void; alt: string }) {
  const { t } = useUiText();
  const shellRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const dividerRef = useRef<HTMLButtonElement>(null);
  const dragging = useRef(false);
  const dragRect = useRef<DOMRect | null>(null);
  const pending = useRef(50);
  const frame = useRef<number | null>(null);
  const panStart = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [shell, setShell] = useState({ width: 0, height: 0 });
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const comparing = compare && !!before?.fileUrl;
  const size = useMemo(() => {
    const iw = Math.max(1, natural.width || image.width || 1), ih = Math.max(1, natural.height || image.height || 1);
    if (shell.width <= 0 || shell.height <= 0) return undefined;
    let width = shell.width, height = width / (iw / ih);
    if (height > shell.height) { height = shell.height; width = height * (iw / ih); }
    return { width, height };
  }, [image.width, image.height, natural.width, natural.height, shell.width, shell.height]);

  const resetDivider = () => {
    pending.current = 50;
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (clipRef.current) clipRef.current.style.clipPath = 'inset(0 0 0 50%)';
    if (dividerRef.current) dividerRef.current.style.left = '50%';
  };
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); resetDivider(); setNatural({ width: 0, height: 0 }); }, [image.fileUrl, before?.fileUrl]);
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, [fitSignal]);
  useEffect(() => { onZoom?.(zoom); }, [zoom, onZoom]);
  useEffect(() => {
    const element = shellRef.current;
    if (!element) return;
    const update = () => { const rect = element.getBoundingClientRect(); setShell({ width: rect.width, height: rect.height }); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);

  function clampPan(next: { x: number; y: number }, nextZoom: number) {
    if (!size || shell.width <= 0 || shell.height <= 0) return next;
    const baseLeft = (shell.width - size.width) / 2, baseTop = (shell.height - size.height) / 2;
    const w = size.width * nextZoom, h = size.height * nextZoom;
    const cx = (shell.width - w) / 2 - baseLeft, cy = (shell.height - h) / 2 - baseTop;
    return {
      x: clamp(next.x, w > shell.width ? shell.width - baseLeft - w : cx, w > shell.width ? -baseLeft : cx),
      y: clamp(next.y, h > shell.height ? shell.height - baseTop - h : cy, h > shell.height ? -baseTop : cy),
    };
  }
  function moveDivider(clientX: number) {
    const rect = dragRect.current ?? frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    pending.current = clamp(((clientX - rect.left) / Math.max(1, rect.width)) * 100, 0, 100);
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      const position = pending.current;
      if (clipRef.current) clipRef.current.style.clipPath = `inset(0 0 0 ${position}%)`;
      if (dividerRef.current) dividerRef.current.style.left = `${position}%`;
      frame.current = null;
    });
  }
  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = frameRef.current?.getBoundingClientRect();
    const next = clamp(zoom * (event.deltaY < 0 ? 1.16 : 1 / 1.16), 1, 8);
    if (!rect || next === 1) { setZoom(next); setPan({ x: 0, y: 0 }); return; }
    const baseLeft = rect.left - pan.x, baseTop = rect.top - pan.y;
    const ix = clamp((event.clientX - rect.left) / zoom, 0, rect.width / zoom), iy = clamp((event.clientY - rect.top) / zoom, 0, rect.height / zoom);
    setZoom(next);
    setPan(clampPan({ x: event.clientX - baseLeft - ix * next, y: event.clientY - baseTop - iy * next }, next));
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || event.button !== 1 || (event.target as HTMLElement).closest('button')) return;
    event.preventDefault();
    panStart.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!panning || !panStart.current) return;
    const start = panStart.current;
    setPan(clampPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }, zoom));
  }
  function stopPan(event: ReactPointerEvent<HTMLDivElement>) {
    setPanning(false); panStart.current = null;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* already released */ }
  }
  const measured = (element: HTMLImageElement) => { if (element.naturalWidth > 0 && element.naturalHeight > 0) setNatural({ width: element.naturalWidth, height: element.naturalHeight }); };

  return <div ref={shellRef} className={clsx('cv-zoom-shell', zoom > 1 && 'is-zoomed', panning && 'is-panning')} onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopPan} onPointerCancel={stopPan} onAuxClick={event => event.preventDefault()}>
    <div ref={frameRef} className="cv-zoom-frame" data-testid="cv-image" style={{ ...size, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
      {comparing ? <>
        <img className="cv-zoom-img" src={before!.fileUrl} alt={t('cv.img.before')} draggable={false} />
        <div ref={clipRef} className="cv-compare-clip" style={{ clipPath: 'inset(0 0 0 50%)' }}><img className="cv-zoom-img cv-zoom-img--abs" src={image.fileUrl} alt={t('cv.img.after')} draggable={false} onLoad={event => measured(event.currentTarget)} /></div>
        <button ref={dividerRef} type="button" className="cv-compare-divider" style={{ left: '50%' }} aria-label={t('cv.img.divider')} title={t('cv.img.divider')}
          onPointerDown={event => { event.preventDefault(); event.stopPropagation(); dragging.current = true; dragRect.current = frameRef.current?.getBoundingClientRect() ?? null; event.currentTarget.setPointerCapture(event.pointerId); moveDivider(event.clientX); }}
          onPointerMove={event => { if (dragging.current) moveDivider(event.clientX); }}
          onPointerUp={event => { dragging.current = false; dragRect.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={() => { dragging.current = false; dragRect.current = null; }}><span /></button>
      </> : <img className="cv-zoom-img" src={image.fileUrl} alt={alt} draggable={zoom === 1} title={t('cv.img.dragTip')} onLoad={event => measured(event.currentTarget)}
        onDragStart={event => { event.preventDefault(); window.naiDesktop.startImageDrag(image.fileUrl); }} />}
    </div>
  </div>;
}
