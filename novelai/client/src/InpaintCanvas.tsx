import { plainErrorMessage } from './host-errors/bridge';
import { stageImageInput } from './app/ImageActions';
import { useShellRoute } from './shell/route';
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Icon } from "./ui";
import { uiLangOf, uiText, useUiText } from "./ui/i18n";
import { droppedImagePath, hasDraggedFiles } from "./drag-drop";
import {
  INPAINT_BRUSH_DIRECT_MAX,
  INPAINT_BRUSH_SLIDER_MAX,
  INPAINT_BRUSH_SLIDER_MIN,
  INPAINT_MASK_GRID_SIZE,
  inpaintBrushSliderValue,
  rasterizeInpaintGridSegment,
  type InpaintBrushPoint,
} from "./inpaint-brush";
import {
  buildBinaryInpaintMask,
  buildInpaintMaskPreview,
  countMaskCells,
  invertMaskPixels,
} from "./inpaint-mask";
import { useAppStore } from "./store";
import { createMaskRestoreGate } from "./workspace/mask-restore";
import { decodeWorkspaceImage } from "./workspace/adapter";
import { canHandleInpaintKeyboard } from './app/canvas-keyboard-guard';

function clampZoom(value: number) {
  return Math.min(8, Math.max(1, value));
}

function recolorMaskCanvas(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  color: string,
) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  const packed = Number.parseInt(match?.[1] ?? "ffffff", 16);
  const red = (packed >> 16) & 255;
  const green = (packed >> 8) & 255;
  const blue = packed & 255;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < image.data.length; index += 4) {
    if (image.data[index + 3] === 0) continue;
    image.data[index] = red;
    image.data[index + 1] = green;
    image.data[index + 2] = blue;
  }
  ctx.putImageData(image, 0, 0);
}

/** The mask display colours: the old palette's seven in its order (a saved colour stays selectable). */
const MASK_COLORS = ["#ffffff", "#000000", "#ef4444", "#7c3aed", "#06b6d4", "#22c55e", "#f59e0b"];

/**
 * Inpaint's stage (step 4b3, prototype 16): the source with the mask drawn over it, and the floating mask tool bar
 * (brush, eraser, size, invert, clear, colour; shape, opacity and the mask preview under more). The drawing, the
 * 8×8-cell brush, the mask export, undo/redo, zoom, pan and compare are the old InpaintCanvas, unchanged.
 */
export function InpaintCanvas() {
  const workbenchImage = useAppStore((state) => state.workbenchImage);
  const currentImage = useAppStore((state) => state.currentImage);
  const comparisonBeforeImage = useAppStore((state) => state.comparisonBeforeImage);
  const comparisonSurface = useAppStore((state) => state.comparisonSurface);
  const brushSize = useAppStore((state) => state.brushSize);
  const setBrushSize = useAppStore((state) => state.setBrushSize);
  const brushOpacity = useAppStore((state) => state.brushOpacity);
  const setBrushOpacity = useAppStore((state) => state.setBrushOpacity);
  const brushColor = useAppStore((state) => state.brushColor);
  const setBrushColor = useAppStore((state) => state.setBrushColor);
  const clearInpaintMask = useAppStore((state) => state.clearInpaintMask);
  const brushMode = useAppStore((state) => state.brushMode);
  const setBrushMode = useAppStore((state) => state.setBrushMode);
  const brushShape = useAppStore((state) => state.brushShape);
  const setBrushShape = useAppStore((state) => state.setBrushShape);
  const maskRevision = useAppStore((state) => state.maskRevision);
  const setInpaintMask = useAppStore((state) => state.setInpaintMask);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const compareClipRef = useRef<HTMLDivElement>(null);
  const compareDividerRef = useRef<HTMLButtonElement>(null);
  const compareDraggingRef = useRef(false);
  const compareRectRef = useRef<DOMRect | null>(null);
  const pendingComparePositionRef = useRef(50);
  const compareAnimationFrameRef = useRef<number | null>(null);
  const drawingRef = useRef(false);
  const maskRestoreGate = useRef(createMaskRestoreGate());
  const maskRestorePending = useRef(false);
  const drawingPointerRef = useRef<number | null>(null);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const panningRef = useRef(false);
  const panPointerRef = useRef<number | null>(null);
  const panStartRef = useRef({ clientX: 0, clientY: 0, x: 0, y: 0 });
  const spaceHeldRef = useRef(false);
  const historyRef = useRef<ImageData[]>([]);
  const redoRef = useRef<ImageData[]>([]);
  const roundStampCacheRef = useRef(new Map<string, HTMLCanvasElement>());
  const [cursor, setCursor] = useState({ x: 0, y: 0, size: brushSize, visible: false });
  const [previewMaskUrl, setPreviewMaskUrl] = useState("");
  const [showExportPreview, setShowExportPreview] = useState(false);
  const [historyCount, setHistoryCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);
  const [stageZoom, setStageZoom] = useState(1);
  const [stagePan, setStagePan] = useState({ x: 0, y: 0 });
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [compareEnabled, setCompareEnabled] = useState(Boolean(comparisonBeforeImage));
  const [dropOver, setDropOver] = useState(false);
  const [brushSizeDraft, setBrushSizeDraft] = useState(String(brushSize));
  const [cells, setCells] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const brushFootprintCells = brushShape === "round"
    ? 2 * Math.round(brushSize / 2) + 1
    : brushSize;
  const brushPixelSize = brushFootprintCells * INPAINT_MASK_GRID_SIZE;
  const sliderBrushSize = inpaintBrushSliderValue(brushSize);
  const canCompare = Boolean(
    comparisonSurface === "inpaint" &&
    comparisonBeforeImage?.fileUrl &&
    currentImage?.fileUrl,
  );
  const { t } = useUiText();

  useEffect(() => setBrushSizeDraft(String(brushSize)), [brushSize]);

  useEffect(() => {
    if (!canvasRef.current || !workbenchImage) return;
    const canvas = canvasRef.current;
    canvas.width = workbenchImage.width || 1;
    canvas.height = workbenchImage.height || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    historyRef.current = [];
    redoRef.current = [];
    setHistoryCount(0);
    setRedoCount(0);
    setPreviewMaskUrl("");
    setShowExportPreview(false);
    setCells(0);
    const savedMask = useAppStore.getState().inpaintMask;
    let currentRestore = true;
    maskRestoreGate.current.cancel();
    maskRestorePending.current = Boolean(savedMask);
    if (savedMask) {
      void maskRestoreGate.current.restore(
        () => decodeWorkspaceImage(savedMask),
        () => {
          const current = useAppStore.getState();
          return !drawingRef.current && current.inpaintMask === savedMask && current.maskRevision === maskRevision && current.workbenchImage === workbenchImage;
        },
        (image) => {
          ctx.drawImage(image, 0, 0);
          recolorMaskCanvas(canvas, ctx, useAppStore.getState().brushColor);
          setPreviewMaskUrl(canvas.toDataURL("image/png"));
          setCells(countMaskCells(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height));
        },
      ).catch(() => {
        useAppStore.getState().setToast(uiText(uiLangOf(useAppStore.getState().settings?.language), "cv.mask.restoreFailed"));
      }).finally(() => { if (currentRestore) maskRestorePending.current = false; });
    }
    return () => { currentRestore = false; maskRestoreGate.current.cancel(); maskRestorePending.current = false; };
  }, [workbenchImage, maskRevision, setInpaintMask]);

  useEffect(() => {
    setStageZoom(1);
    setStagePan({ x: 0, y: 0 });
  }, [workbenchImage?.fileUrl]);

  useEffect(() => {
    pendingComparePositionRef.current = 50;
    if (compareAnimationFrameRef.current !== null) {
      cancelAnimationFrame(compareAnimationFrameRef.current);
      compareAnimationFrameRef.current = null;
    }
    if (compareClipRef.current) compareClipRef.current.style.clipPath = "inset(0 0 0 50%)";
    if (compareDividerRef.current) compareDividerRef.current.style.left = "50%";
    setCompareEnabled(canCompare);
  }, [canCompare, comparisonBeforeImage?.fileUrl, currentImage?.fileUrl]);

  useEffect(() => () => {
    if (compareAnimationFrameRef.current !== null) {
      cancelAnimationFrame(compareAnimationFrameRef.current);
    }
  }, []);

  const exportMask = useCallback(() => {
    if (maskRestorePending.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const source = ctx.getImageData(0, 0, w, h);
    const { rgba, any } = buildBinaryInpaintMask(source.data, w, h);
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = w;
    maskCanvas.height = h;
    const maskCtx = maskCanvas.getContext("2d");
    if (!maskCtx) return;
    if (!any) {
      setInpaintMask(null);
      setPreviewMaskUrl("");
      setShowExportPreview(false);
      setCells(0);
      return;
    }
    setCells(countMaskCells(rgba, w, h));
    const binaryImage = maskCtx.createImageData(w, h);
    binaryImage.data.set(rgba);
    maskCtx.putImageData(binaryImage, 0, 0);
    const dataUrl = maskCanvas.toDataURL("image/png");
    setInpaintMask(dataUrl.split(",")[1] ?? null);
    const previewImage = maskCtx.createImageData(w, h);
    previewImage.data.set(buildInpaintMaskPreview(rgba, w, h, brushColor));
    maskCtx.putImageData(previewImage, 0, 0);
    setPreviewMaskUrl(maskCanvas.toDataURL("image/png"));
  }, [brushColor, setInpaintMask]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    recolorMaskCanvas(canvas, ctx, brushColor);
    exportMask();
  }, [brushColor, exportMask]);

  const getPoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
    };
  }, []);

  const updateCursor = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const stageRect = stageRef.current?.getBoundingClientRect() ?? rect;
      const displayScale = rect.width / Math.max(1, canvas.width);
      setCursor({
        x: clientX - stageRect.left,
        y: clientY - stageRect.top,
        size: Math.max(2, brushPixelSize * displayScale),
        visible: true,
      });
    },
    [brushPixelSize],
  );

  const drawSamples = useCallback(
    (events: ArrayLike<Pick<PointerEvent, "clientX" | "clientY">>) => {
      if (!drawingRef.current) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      setShowExportPreview(false);
      ctx.globalCompositeOperation = brushMode === "paint" ? "source-over" : "destination-out";
      ctx.fillStyle = brushMode === "paint" ? brushColor : "#ffffff";
      ctx.imageSmoothingEnabled = false;
      const exactSize = brushSize * INPAINT_MASK_GRID_SIZE;
      const stampColor = brushMode === "paint" ? brushColor : "#ffffff";
      const roundStamp = () => {
        const radius = Math.round(brushSize / 2);
        const diameter = radius * 2 + 1;
        const key = `${diameter}-${stampColor}`;
        const cached = roundStampCacheRef.current.get(key);
        if (cached) return cached;
        const stamp = document.createElement("canvas");
        stamp.width = diameter;
        stamp.height = diameter;
        const stampContext = stamp.getContext("2d");
        if (!stampContext) return stamp;
        stampContext.fillStyle = stampColor;
        for (let deltaY = -radius; deltaY <= radius; deltaY += 1) {
          for (let deltaX = -radius; deltaX <= radius; deltaX += 1) {
            const x = Math.abs(deltaX);
            const y = Math.abs(deltaY);
            const edgeDistance = Math.min(
              Math.hypot(x + 0.5, y + 0.5),
              Math.hypot(x - 0.5, y - 0.5),
            );
            if (edgeDistance <= radius) {
              stampContext.fillRect(deltaX + radius, deltaY + radius, 1, 1);
            }
          }
        }
        if (roundStampCacheRef.current.size >= 24) roundStampCacheRef.current.clear();
        roundStampCacheRef.current.set(key, stamp);
        return stamp;
      };
      const stamp = (point: InpaintBrushPoint) => {
        if (brushShape === "square") {
          ctx.fillRect(
            Math.round(point.x - brushSize / 2) * INPAINT_MASK_GRID_SIZE,
            Math.round(point.y - brushSize / 2) * INPAINT_MASK_GRID_SIZE,
            exactSize,
            exactSize,
          );
          return;
        }
        const radius = Math.round(brushSize / 2);
        const diameter = radius * 2 + 1;
        ctx.drawImage(
          roundStamp(),
          (Math.floor(point.x) - radius) * INPAINT_MASK_GRID_SIZE,
          (Math.floor(point.y) - radius) * INPAINT_MASK_GRID_SIZE,
          diameter * INPAINT_MASK_GRID_SIZE,
          diameter * INPAINT_MASK_GRID_SIZE,
        );
      };
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const sourcePoint = getPoint(event.clientX, event.clientY);
        if (!sourcePoint) continue;
        if (
          sourcePoint.x < 0 ||
          sourcePoint.y < 0 ||
          sourcePoint.x >= canvas.width ||
          sourcePoint.y >= canvas.height
        ) {
          lastPointRef.current = null;
          continue;
        }
        const point = {
          x: sourcePoint.x / INPAINT_MASK_GRID_SIZE,
          y: sourcePoint.y / INPAINT_MASK_GRID_SIZE,
        };
        const last = lastPointRef.current;
        if (last) {
          for (const sample of rasterizeInpaintGridSegment(last, point)) stamp(sample);
        } else {
          stamp({ x: Math.round(point.x), y: Math.round(point.y) });
        }
        lastPointRef.current = point;
      }
    },
    [brushColor, brushMode, brushShape, brushSize, getPoint],
  );

  // Called once at the start of each new stroke: snapshot the canvas so we can
  // undo back to it, and drop any redo states (a fresh stroke forks history).
  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (historyRef.current.length > 40) historyRef.current.shift();
    setHistoryCount(historyRef.current.length);
    redoRef.current = [];
    setRedoCount(0);
  }, []);

  const undoLastStroke = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const previous = historyRef.current.pop();
    if (!canvas || !ctx || !previous) return;
    redoRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    setRedoCount(redoRef.current.length);
    ctx.putImageData(previous, 0, 0);
    recolorMaskCanvas(canvas, ctx, brushColor);
    setHistoryCount(historyRef.current.length);
    setShowExportPreview(false);
    exportMask();
  }, [brushColor, exportMask]);

  const redoNextStroke = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const next = redoRef.current.pop();
    if (!canvas || !ctx || !next) return;
    historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    setHistoryCount(historyRef.current.length);
    ctx.putImageData(next, 0, 0);
    recolorMaskCanvas(canvas, ctx, brushColor);
    setRedoCount(redoRef.current.length);
    setShowExportPreview(false);
    exportMask();
  }, [brushColor, exportMask]);

  // Invert (new in step 4b3, prototype 16): every pixel the mask selects becomes unselected and every other one
  // selected, as one undoable stroke; the result is exported like any stroke.
  const invertMask = useCallback(() => {
    if (maskRestorePending.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    pushHistory();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    invertMaskPixels(image.data, brushColor);
    ctx.putImageData(image, 0, 0);
    setShowExportPreview(false);
    exportMask();
  }, [brushColor, exportMask, pushHistory]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
    const keyDown = (event: KeyboardEvent) => {
      if (!canHandleInpaintKeyboard({ activeTab: useAppStore.getState().activeTab, canvasShown: useShellRoute.getState().page === 'canvas', modalOpen: !!document.querySelector('[role="dialog"][aria-modal="true"], dialog[open], :popover-open'), defaultPrevented: event.defaultPrevented, isComposing: event.isComposing })) return;
      if (event.code === "Space" && !isEditable(event.target)) {
        event.preventDefault();
        spaceHeldRef.current = true;
        setSpaceHeld(true);
        return;
      }
      if (isEditable(event.target)) return;
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoNextStroke();
        else undoLastStroke();
      } else if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        redoNextStroke();
      } else if (key === "b") {
        setBrushMode("paint");
      } else if (key === "e") {
        setBrushMode("erase");
      } else if (event.key === "[") {
        event.preventDefault();
        setBrushSize(brushSize - (brushShape === "round" ? 2 : 1));
      } else if (event.key === "]") {
        event.preventDefault();
        setBrushSize(brushSize + (brushShape === "round" ? 2 : 1));
      }
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    const blur = () => {
      spaceHeldRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [brushShape, brushSize, redoNextStroke, setBrushMode, setBrushSize, undoLastStroke]);

  const finishPointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
      if (panPointerRef.current === event.pointerId) {
        panningRef.current = false;
        panPointerRef.current = null;
        setIsPanning(false);
      }
      if (drawingPointerRef.current === event.pointerId) {
        if (!cancelled) {
          const native = event.nativeEvent;
          const samples = native.getCoalescedEvents?.() ?? [native];
          drawSamples(samples);
        }
        drawingRef.current = false;
        delete event.currentTarget.dataset.maskDrawing;
        drawingPointerRef.current = null;
        lastPointRef.current = null;
        exportMask();
      }
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [drawSamples, exportMask],
  );

  const imageZoomStyle = { transform: `translate(${stagePan.x}px, ${stagePan.y}px) scale(${stageZoom})` };
  const canvasZoomStyle = {
    transform: `translate(-50%, -50%) translate(${stagePan.x}px, ${stagePan.y}px) scale(${stageZoom})`,
  };
  function handleStageWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const rect = canvasRef.current?.getBoundingClientRect();
    const next = clampZoom(stageZoom * (event.deltaY < 0 ? 1.16 : 1 / 1.16));
    if (!rect || next === 1) {
      setStageZoom(next);
      setStagePan({ x: 0, y: 0 });
      return;
    }
    const baseLeft = rect.left - stagePan.x;
    const baseTop = rect.top - stagePan.y;
    const imageX = Math.min(rect.width / stageZoom, Math.max(0, (event.clientX - rect.left) / stageZoom));
    const imageY = Math.min(rect.height / stageZoom, Math.max(0, (event.clientY - rect.top) / stageZoom));
    setStageZoom(next);
    setStagePan({
      x: event.clientX - baseLeft - imageX * next,
      y: event.clientY - baseTop - imageY * next,
    });
  }

  function updateComparePosition(clientX: number) {
    const rect = compareRectRef.current ?? canvasRef.current?.getBoundingClientRect() ?? stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = ((clientX - rect.left) / Math.max(1, rect.width)) * 100;
    pendingComparePositionRef.current = Math.min(100, Math.max(0, next));
    if (compareAnimationFrameRef.current !== null) return;
    compareAnimationFrameRef.current = requestAnimationFrame(() => {
      const position = pendingComparePositionRef.current;
      if (compareClipRef.current) {
        compareClipRef.current.style.clipPath = `inset(0 0 0 ${position}%)`;
      }
      if (compareDividerRef.current) {
        compareDividerRef.current.style.left = `${position}%`;
      }
      compareAnimationFrameRef.current = null;
    });
  }

  function beginCompareDragging(event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    compareDraggingRef.current = true;
    compareRectRef.current = canvasRef.current?.getBoundingClientRect() ?? stageRef.current?.getBoundingClientRect() ?? null;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateComparePosition(event.clientX);
  }

  function moveCompareDivider(event: React.PointerEvent<HTMLButtonElement>) {
    if (compareDraggingRef.current) updateComparePosition(event.clientX);
  }

  function stopCompareDragging(event: React.PointerEvent<HTMLButtonElement>) {
    compareDraggingRef.current = false;
    compareRectRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleImageDragOver(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDropOver(true);
  }

  async function handleImageDrop(event: React.DragEvent<HTMLElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setDropOver(false);
    const filePath = await droppedImagePath(event.dataTransfer);
    if (filePath) void stageImageInput({ filePath }, "inpaint").catch(error => useAppStore.getState().setToast(plainErrorMessage(error)));
  }

  const dropProps = {
    onDragOver: handleImageDragOver,
    onDragLeave: () => setDropOver(false),
    onDrop: handleImageDrop,
  };
  if (!workbenchImage) {
    return (
      <div className="cv-ip cv-ip--empty" data-testid="cv-inpaint-stage" {...dropProps}>
        {dropOver && <div className="cv-drop"><span>{t("cv.drop")}</span></div>}
        <div className="cv-empty">
          <span className="cv-empty-mark"><Icon name="brush" size={22} /></span>
          <b>{t("cv.ip.empty")}</b>
          <span className="ui-muted">{t("cv.ip.emptyHint")}</span>
        </div>
      </div>
    );
  }

  const minimumSize = brushShape === "round" ? 2 : 1;
  const tool = (on: boolean) => clsx("cv-tbtn", on && "is-on");
  return (
    <div className="cv-ip" data-testid="cv-inpaint-stage" {...dropProps}>
      {dropOver && <div className="cv-drop"><span>{t("cv.drop")}</span></div>}
      <div className="cv-floattools" role="toolbar" aria-label={t("cv.ip.brush")} data-testid="cv-mask-tools">
        <button type="button" className={tool(brushMode === "paint")} aria-pressed={brushMode === "paint"} title={`${t("cv.ip.brush")} · B`} onClick={() => setBrushMode("paint")} data-testid="cv-tool-brush">
          <Icon name="brush" size={15} /><span className="cv-tb-label">{t("cv.ip.brush")}</span>
        </button>
        <button type="button" className={tool(brushMode === "erase")} aria-pressed={brushMode === "erase"} title={`${t("cv.ip.eraser")} · E`} onClick={() => setBrushMode("erase")} data-testid="cv-tool-eraser">
          <Icon name="eraser" size={15} /><span className="cv-tb-label">{t("cv.ip.eraser")}</span>
        </button>
        <span className="cv-tb-sep" />
        <div className="cv-tb-size" title={t("cv.ip.sizeCells")}>
          <span className="cv-tb-label">{t("cv.ip.size")}</span>
          <input
            className="cv-range"
            type="range"
            min={INPAINT_BRUSH_SLIDER_MIN}
            max={INPAINT_BRUSH_SLIDER_MAX}
            step={1}
            value={sliderBrushSize}
            aria-label={t("cv.ip.sizeCells")}
            style={{ ["--cv-fill" as string]: `${((sliderBrushSize - INPAINT_BRUSH_SLIDER_MIN) / Math.max(1, INPAINT_BRUSH_SLIDER_MAX - INPAINT_BRUSH_SLIDER_MIN)) * 100}%` }}
            onChange={(event) => setBrushSize(Number(event.currentTarget.value))}
          />
          <input
            className="ui-input cv-num cv-tb-num ui-num"
            type="number"
            min={minimumSize}
            max={INPAINT_BRUSH_DIRECT_MAX}
            step={1}
            value={brushSizeDraft}
            aria-label={t("cv.ip.sizeCells")}
            onChange={(event) => setBrushSizeDraft(event.currentTarget.value)}
            onBlur={() => {
              const fallback = brushSize;
              const parsed = Number(brushSizeDraft);
              const next = Number.isFinite(parsed)
                ? Math.max(minimumSize, Math.min(INPAINT_BRUSH_DIRECT_MAX, Math.round(parsed)))
                : fallback;
              setBrushSizeDraft(String(next));
              setBrushSize(next);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setBrushSizeDraft(String(brushSize));
                event.currentTarget.blur();
              }
            }}
          />
        </div>
        <span className="cv-tb-sep" />
        <button type="button" className="cv-tbtn" title={t("cv.ip.invert")} onClick={invertMask} data-testid="cv-tool-invert">
          <Icon name="invert" size={15} /><span className="cv-tb-label">{t("cv.ip.invert")}</span>
        </button>
        <button type="button" className="cv-tbtn" title={t("cv.ip.clear")} onClick={clearInpaintMask} disabled={!previewMaskUrl && historyCount === 0} data-testid="cv-tool-clear">
          <Icon name="trash" size={15} /><span className="cv-tb-label">{t("cv.ip.clear")}</span>
        </button>
        <span className="cv-tb-sep" />
        <div className="cv-tb-colors" role="radiogroup" aria-label={t("cv.ip.colors")}>
          {MASK_COLORS.map((color) => (
            <button key={color} type="button" role="radio" aria-checked={brushColor === color} className={clsx(brushColor === color && "is-on")} style={{ background: color }}
              aria-label={t("cv.ip.color", { c: color })} title={color} onClick={() => setBrushColor(color)} />
          ))}
        </div>
        <span className="cv-tb-sep" />
        <button type="button" className="cv-tbtn cv-tbtn--icon" disabled={historyCount === 0} onClick={undoLastStroke} title={`${t("cv.ip.undo")} · Ctrl/⌘ Z`} aria-label={t("cv.ip.undo")}>
          <Icon name="undo" size={15} />
        </button>
        <button type="button" className="cv-tbtn cv-tbtn--icon cv-redo" disabled={redoCount === 0} onClick={redoNextStroke} title={`${t("cv.ip.redo")} · Ctrl/⌘ Shift Z`} aria-label={t("cv.ip.redo")}>
          <Icon name="undo" size={15} />
        </button>
        {canCompare ? (
          <button type="button" className={clsx("cv-tbtn cv-tbtn--icon", compareEnabled && "is-on")} aria-pressed={compareEnabled} onClick={() => setCompareEnabled((value) => !value)} title={t("cv.ip.compare")} aria-label={t("cv.ip.compare")}>
            <Icon name="compare" size={15} />
          </button>
        ) : null}
        <div className="cv-tb-more">
          <button type="button" className={clsx("cv-tbtn cv-tbtn--icon", moreOpen && "is-on")} aria-expanded={moreOpen} aria-label={t("cv.ip.more")} title={t("cv.ip.more")} onClick={() => setMoreOpen((value) => !value)}>
            <Icon name="more" size={15} />
          </button>
          {moreOpen && (
            <div className="cv-tb-pop" role="group" aria-label={t("cv.ip.more")}>
              <div className="cv-pf-l"><span>{t("cv.ip.shape")}</span></div>
              <div className="ui-seg ui-seg--full ui-seg--sm" role="radiogroup" aria-label={t("cv.ip.shape")}>
                <button type="button" role="radio" aria-checked={brushShape === "round"} className={clsx("ui-seg__item", brushShape === "round" && "ui-seg__item--on")} onClick={() => setBrushShape("round")}>{t("cv.ip.round")}</button>
                <button type="button" role="radio" aria-checked={brushShape === "square"} className={clsx("ui-seg__item", brushShape === "square" && "ui-seg__item--on")} onClick={() => setBrushShape("square")}>{t("cv.ip.square")}</button>
              </div>
              <div className="cv-pf-l"><span>{t("cv.ip.opacity")}</span><b className="ui-num">{Math.round(brushOpacity * 100)}%</b></div>
              <input className="cv-range" type="range" min={0.05} max={1} step={0.01} value={brushOpacity} aria-label={t("cv.ip.opacity")}
                style={{ ["--cv-fill" as string]: `${((brushOpacity - 0.05) / 0.95) * 100}%` }} onChange={(event) => setBrushOpacity(Number(event.currentTarget.value))} />
              <button type="button" className={clsx("cv-tbtn", showExportPreview && "is-on")} disabled={!previewMaskUrl} aria-pressed={showExportPreview} onClick={() => setShowExportPreview((value) => !value)}>
                <Icon name="eye" size={15} /><span>{t("cv.ip.preview")}</span>
              </button>
            </div>
          )}
        </div>
        {(stageZoom !== 1 || stagePan.x !== 0 || stagePan.y !== 0) && (
          <button type="button" className="cv-tbtn" onClick={() => { setStageZoom(1); setStagePan({ x: 0, y: 0 }); }} title={t("cv.ip.fit")} aria-label={t("cv.ip.fit")}>
            <Icon name="fit" size={15} /><span className="ui-num">{Math.round(stageZoom * 100)}%</span>
          </button>
        )}
      </div>
      <div className="inpaint-stage" ref={stageRef} onWheel={handleStageWheel}>
        <img
          className="inpaint-base-img"
          src={compareEnabled && canCompare ? comparisonBeforeImage!.fileUrl : workbenchImage.fileUrl}
          alt={compareEnabled && canCompare ? t("cv.ip.before") : t("cv.ip.base")}
          draggable={false}
          style={imageZoomStyle}
        />
        {compareEnabled && canCompare ? (
          <>
            <div ref={compareClipRef} className="inpaint-compare-after-clip" style={{ clipPath: "inset(0 0 0 50%)" }}>
              <img
                className="inpaint-compare-img"
                src={currentImage!.fileUrl}
                alt={t("cv.ip.after")}
                draggable={false}
                style={imageZoomStyle}
              />
            </div>
            <button
              ref={compareDividerRef}
              type="button"
              className="compare-divider inpaint-compare-divider"
              style={{ left: "50%" }}
              onPointerDown={beginCompareDragging}
              onPointerMove={moveCompareDivider}
              onPointerUp={stopCompareDragging}
              onPointerCancel={stopCompareDragging}
              aria-label={t("cv.ip.divider")}
              title={t("cv.ip.divider")}
            >
              <span />
            </button>
          </>
        ) : null}
        <canvas
          ref={canvasRef}
          className="inpaint-mask-canvas"
          style={{
            opacity: showExportPreview || (compareEnabled && canCompare) ? 0 : brushOpacity,
            pointerEvents: compareEnabled && canCompare ? "none" : undefined,
            cursor: isPanning ? "grabbing" : spaceHeld ? "grab" : "none",
            ...canvasZoomStyle,
          }}
          onPointerDown={(event) => {
            if (maskRestorePending.current) return;
            if (event.button === 1 || spaceHeldRef.current) {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              panningRef.current = true;
              panPointerRef.current = event.pointerId;
              panStartRef.current = {
                clientX: event.clientX,
                clientY: event.clientY,
                x: stagePan.x,
                y: stagePan.y,
              };
              setIsPanning(true);
              setCursor((current) => ({ ...current, visible: false }));
              return;
            }
            if (event.pointerType === "mouse" && event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            updateCursor(event.clientX, event.clientY);
            pushHistory();
            drawingRef.current = true;
            event.currentTarget.dataset.maskDrawing = "true";
            drawingPointerRef.current = event.pointerId;
            lastPointRef.current = null;
            drawSamples([event.nativeEvent]);
          }}
          onPointerMove={(event) => {
            if (panPointerRef.current === event.pointerId && panningRef.current) {
              const start = panStartRef.current;
              setStagePan({
                x: start.x + event.clientX - start.clientX,
                y: start.y + event.clientY - start.clientY,
              });
              return;
            }
            updateCursor(event.clientX, event.clientY);
            if (drawingPointerRef.current !== event.pointerId) return;
            const native = event.nativeEvent;
            drawSamples(native.getCoalescedEvents?.() ?? [native]);
          }}
          onPointerEnter={(event) => updateCursor(event.clientX, event.clientY)}
          onPointerUp={(event) => finishPointer(event)}
          onPointerCancel={(event) => finishPointer(event, true)}
          onPointerLeave={() => {
            setCursor((current) => ({ ...current, visible: false }));
          }}
        />
        {showExportPreview && previewMaskUrl ? (
          <img className="inpaint-export-preview" src={previewMaskUrl} alt={t("cv.ip.maskAlt")} draggable={false} style={canvasZoomStyle} />
        ) : null}
        <div
          className="inpaint-cursor soft"
          style={{
            left: cursor.x,
            top: cursor.y,
            width: cursor.size,
            height: cursor.size,
            borderRadius: brushShape === "round" ? "999px" : "3px",
            borderColor: brushColor,
            opacity: cursor.visible && !showExportPreview && !spaceHeld && !isPanning ? 1 : 0,
          }}
        />
      </div>
      <div className="cv-ip-hint" data-testid="cv-mask-cells" data-cells={cells} title={t("cv.ip.keys")}>
        {t("cv.ip.hint")} · {t("cv.ip.cells", { n: cells })}
      </div>
    </div>
  );
}
