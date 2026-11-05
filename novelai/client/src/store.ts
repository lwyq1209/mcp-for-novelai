import { plainErrorMessage, stripHostErrorSuffixes } from "./host-errors/bridge";
import { readCharacterSnapshot, snapshotCharacters } from "./character-snapshot";
import type { MetadataRestoreOptions } from "./metadata-selection";
import { create } from "zustand";
import type {
  AccountSummary,
  AnlasQuoteRequest,
  AnlasQuoteResult,
  AppLanguage,
  AppSettings,
  AugmentOptions,
  CharCaption,
  CharCaptionItem,
  DirectorTool,
  GenerateExtras,
  GenerateParams,
  GenerationPreviewEvent,
  HistoryGroup,
  HistoryItem,
  I2IParams,
  ImageToImageSizeMode,
  ImportedParams,
  InpaintBrushShape,
  LastGenerationState,
  NAIInpaintModel,
  UpdateInfo,
  UpdateNotice,
  UpdateProgressInfo,
  UpscaleScale,
  VibeTransferImage,
  PreciseReferenceImage,
  WorkingImage,
} from "./types";
import { assertPromptAssemblyVersion, InvalidPromptAssemblyVersionError, baseModelForInpaint, DEFAULT_AUGMENT_OPTIONS, DEFAULT_I2I_PARAMS, DEFAULT_PARAMS, DIRECTOR_TOOLS, EMOTION_OPTIONS, isNAIV5Model, maxNAICharacterPrompts, NAI_INPAINT_MODELS, normalizeGenerateParams, normalizeInheritedGenerateParams } from "./types";
import { normalizeAppLanguage } from "./i18n";
// The copy of the older dialogs, read directly (src/ui/i18n imports this store).
import { LEGACY_STRINGS } from "./ui/legacy.strings";
import { isBatchTerminal, type BatchJob } from "./workspace/batch-types";
import { imagesAhead, newManualRequestKey, type ManualEnqueueReply, type ManualGenerationRequest, type ManualItemEvent, type ManualMode } from "./workspace/manual-batches";
import { windowQueueMonitor } from "./workspace/queue-monitor";
import { hostErrorText } from "./host-errors";
import { adaptiveNAIImageSize } from "./nai-dimensions";
import { normalizeInpaintBrushSize } from "./inpaint-brush";
import { compactRemoteErrorText } from "./error-message";
import { restorableActiveTab, type ActiveTab } from "./app/navigation";
import { HISTORY_ITEMS_LIMIT, mergeHistorySnapshot } from "./history-sync";

type PromptTab = "positive" | "negative";
type BrushMode = "paint" | "erase";

// Workspace column widths (left operations rail / right history rail) — persisted
// in localStorage so the layout is identical on next launch. Center fills the rest.
// The left column of the rebuilt canvas (step 4b3): 384 px by default (352 below 1360 px, canvas.css), at least 320 px
// so its controls stay usable at 1280×720. A stored width equal to the default means "the default".
export const WS_LEFT_DEFAULT = 384;
const WS_RIGHT_DEFAULT = 340;
export const WS_LEFT_MIN = 320;
export const WS_LEFT_MAX = 560;
const WS_RIGHT_MIN = 220;
const WS_RIGHT_MAX = 480;
// Every async workbench load gets a revision. Starting a newer load, clearing
// the workbench, deleting its selected history item, or starting generation
// invalidates older responses so stale metadata cannot overwrite live prompts.
let workbenchLoadRevision = 0;
// Gallery queries share an ordering boundary; changing a filter never selects
// an artwork, and a late response must not restore an older filter/list pair.
let historyLoadRevision = 0;
let historyGroupWrite: Promise<unknown> = Promise.resolve();
// The latest full history read still in flight. An incremental update waits
// for it: that read may predate the change and must not overwrite the patch.
let activeHistoryLoad: Promise<unknown> | null = null;
function trackHistoryLoad<T>(load: Promise<T>): Promise<T> {
  activeHistoryLoad = load;
  const settle = () => { if (activeHistoryLoad === load) activeHistoryLoad = null; };
  load.then(settle, settle);
  return load;
}
// Counts full history loads that applied their list, so an incremental read
// superseded by a full load can tell whether that load actually replaced it.
let historyLoadedSerial = 0;
// Incremental history reads run one at a time; identities that change while
// one runs are read again by the next round. Identities of a failed read stay
// in `failed` and join every later round until one succeeds (review P3-1):
// a single host read failure must not leave those items stale.
const historyItemsQueue: { ids: Set<string>; failed: Set<string>; waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>; running: boolean } = { ids: new Set(), failed: new Set(), waiters: [], running: false };
// Invalidates a slow post-generation balance refresh as soon as a newer run or
// cancellation starts, so stale bookkeeping can never overwrite newer UI.
let generationSettlementRevision = 0;
const storeIpcListenerOwner = {};
const storeIpcListenerRegistryKey = "__novelaiStoreIpcListeners";

type StoreIpcListenerRegistry = {
  owner: object;
  removeGenerationPreview?: () => void;
  removeUpdateEvent?: () => void;
  removeUpdateProgress?: () => void;
  removeManualBatch?: () => void;
  removeManualItem?: () => void;
};

function readWsWidth(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

const STORE_TEXT: Record<AppLanguage, Record<string, string>> = {
  "zh-CN": {
    "status.ready": "就绪",
    "status.apiConfigured": "API 已配置",
    "status.needApiToken": "请先设置 API Token",
    "status.imageLoaded": "已加载图片：{width}×{height}",
    "status.imageLoadFailed": "加载图片失败",
    "status.workbenchCleared": "已清除工作台图片",
    "status.missingPrompt": "缺少提示词",
    "status.preparing": "正在准备生成（读取余额与报价）…",
    "status.paused": "已暂停（{done}/{total}），点击继续",
    "status.batchInterval": "等待 {seconds} 秒后生成第 {current}/{total} 张…",
    "status.generatingProgress": "正在生成 {current}/{total}（成功 {done}，失败 {failed}，等待 {waiting}）...",
    "status.historySelected": "已选择历史图片：{date}",
    "status.needImage": "缺少图片",
    "status.needOriginal": "缺少原图",
    "status.needMask": "缺少蒙版",
    "toast.needApiToken": "请先在设置中配置 API Token。",
    "toast.imageLoaded": "已加载：{width}×{height}",
    "toast.needPrompt": "请输入正面提示词。",
    "toast.needReference": "请先加载参考图片。",
    "toast.needOriginal": "请先加载原图。",
    "toast.needMask": "请先用画笔标记要重绘的区域。",
    "toast.needLoadedImage": "请先加载图片。",
    "toast.paramsLoadedSeed": "已载入参数，种子固定为 {seed}",
    "toast.paramsLoaded": "已载入参数",
    "toast.renameFailed": "重命名失败",
    "toast.renamed": "已重命名图片",
    "group.created": "已创建分组：{name}",
    "group.nameRequired": "分组名称不能为空",
    "group.renamed": "已重命名分组：{name}",
    "group.deleted": "已删除分组（图片已转为未分组）",
    "group.packing": "正在打包分组...",
    "error.unknown": "未知错误",
    "error.requestFailed": "请求失败，请稍后重试。",
    "boot.settingsFailed": "读取设置失败，请重试。",
    "boot.invalidParams": "保存的生成参数无效，未加载也未授权生成：{detail}",
    "boot.invalidAssembly": "提示词装配版本无效（只接受 1）",
    "inpaint.recipeUnsupported": "单独的重绘设置不支持氛围 / 精确参考和 Furry，没有出图。",
    "inpaint.recipeModelMismatch": "单独设置的模型与重绘模型不一致，请重新选择重绘模型。没有出图。",
    "history.paramsInvalid": "历史参数无效，未应用：{detail}",
    "error.generationFailed": "图片生成失败：{detail}",
    "quote.readFailedTry": "{action}读不到报价，仍会尝试。",
    "quote.insufficient": "{action}预计需要 {amount} Anlas，余额只有 {balance} Anlas；仍会尝试，余额不足时会失败。",
    "quote.deduct": "{action}将在执行前扣除 {amount} Anlas。",
    "action.batchGenerate": "批量生成 {count} 张",
    "action.generateImage": "生成图片",
    "action.i2i": "图生图",
    "action.inpaint": "局部重绘",
    "action.upscale": "云端超分 {scale}x",
    "action.postprocess": "后期处理",
    "generate.doneFailed": "完成：成功 {done} 张，失败 {failed} 张{spent}；最后一次错误：{error}",
    "generate.batchDone": "批量生成完成，共 {done} 张{spent}。",
    "generate.singleDone": "生成完成，已保存 1 张图片{spent}。",
    "generate.spent": "，实扣 {spent} Anlas",
    "generate.spentPending": "，实扣统计更新中",
    "generate.spentFailed": "，实扣读取失败",
    "generate.spentUnknown": "，实扣无法精确统计",
    "i2i.progress": "正在图生图 {current}/{total}（成功 {done}，失败 {failed}）...",
    "i2i.doneFailed": "图生图完成：成功 {done} 张，失败 {failed} 张{spent}；最后一次错误：{error}",
    "i2i.batchDone": "批量图生图完成，共 {done} 张{spent}。",
    "i2i.singleDone": "图生图完成，已保存 1 张图片{spent}。",
    "manual.queued": "已加入队列，前面还有 {ahead} 张。",
    "manual.starting": "已加入队列，马上开始生成…",
    "manual.enqueueFailed": "未加入队列：{message}",
    "manual.enqueueUnknown": "没能确认这次点击是否已加入队列；没有自动重发。请先看看队列，再决定是否重新生成。",
    "manual.waiting": "排在队列里，前面还有 {ahead} 张…",
    "manual.cancelling": "正在取消这一批：正在生成的那一张已中止；如果请求已经发出，可能已扣费，图片不会保存。",
    "manual.cancelled": "已取消这一批：成功 {done} 张{spent}。",
    "manual.stoppedNote": "正在生成的那一张已中止；如果请求已经发出，可能已扣费，图片不会保存。",
    "manual.unknownNote": "另有 {count} 张结果未知：请求可能已发出并扣费，没有自动重发；请先核对历史。",
    "manual.doneUnknown": "完成：成功 {done} 张{spent}。另有 {count} 张结果未知：请求可能已发出并扣费，没有自动重发；请先核对历史。",
    "manual.allUnknown": "{count} 张结果未知{spent}：请求可能已发出并扣费，没有自动重发；请先核对历史。",
    "manual.nothingToStop": "没有正在排队或生成的手动批次。",
    "manual.controlFailed": "队列操作未完成：{message}",
  },
  "en-US": {
    "status.ready": "Ready",
    "status.apiConfigured": "API configured",
    "status.needApiToken": "Set API Token first",
    "status.imageLoaded": "Loaded image: {width}×{height}",
    "status.imageLoadFailed": "Failed to load image",
    "status.workbenchCleared": "Workbench image cleared",
    "status.missingPrompt": "Missing prompt",
    "status.preparing": "Preparing generation (checking balance and quote)…",
    "status.paused": "Paused ({done}/{total}); click Continue",
    "status.batchInterval": "Waiting {seconds}s before image {current}/{total}…",
    "status.generatingProgress": "Generating {current}/{total} (success {done}, failed {failed}, waiting {waiting})...",
    "status.historySelected": "Selected history image: {date}",
    "status.needImage": "Missing image",
    "status.needOriginal": "Missing source image",
    "status.needMask": "Missing mask",
    "toast.needApiToken": "Configure API Token in Settings first.",
    "toast.imageLoaded": "Loaded: {width}×{height}",
    "toast.needPrompt": "Enter a positive prompt.",
    "toast.needReference": "Load a reference image first.",
    "toast.needOriginal": "Load the source image first.",
    "toast.needMask": "Mark the repaint area with the brush first.",
    "toast.needLoadedImage": "Load an image first.",
    "toast.paramsLoadedSeed": "Settings loaded; the seed is fixed at {seed}",
    "toast.paramsLoaded": "Parameters loaded",
    "toast.renameFailed": "Rename failed",
    "toast.renamed": "Image renamed",
    "group.created": "Created group: {name}",
    "group.nameRequired": "Group name cannot be empty",
    "group.renamed": "Renamed group: {name}",
    "group.deleted": "Group deleted; images moved to Ungrouped",
    "group.packing": "Packaging group...",
    "error.unknown": "Unknown error",
    "error.requestFailed": "Request failed. Please try again later.",
    "boot.settingsFailed": "Reading the settings failed; try again.",
    "boot.invalidParams": "The saved generation settings are invalid; they were not loaded and nothing may generate with them: {detail}",
    "boot.invalidAssembly": "the prompt assembly version is invalid (only 1 is accepted)",
    "inpaint.recipeUnsupported": "Separate inpaint settings don’t support Vibe / Precise references or Furry; nothing was generated.",
    "inpaint.recipeModelMismatch": "The separate settings don’t match the inpaint model; choose the inpaint model again. Nothing was generated.",
    "history.paramsInvalid": "The history settings are invalid and were not applied: {detail}",
    "error.generationFailed": "Image generation failed: {detail}",
    "quote.readFailedTry": "No cost quote for {action}; trying anyway.",
    "quote.insufficient": "{action} is estimated at {amount} Anlas but the balance is {balance} Anlas; it will try anyway and fails if the balance runs short.",
    "quote.deduct": "{action} will deduct {amount} Anlas before execution.",
    "action.batchGenerate": "Batch generate {count} images",
    "action.generateImage": "Generate image",
    "action.i2i": "Img2img",
    "action.inpaint": "Inpaint",
    "action.upscale": "Cloud upscale {scale}x",
    "action.postprocess": "Post-process",
    "generate.doneFailed": "Done: {done} success, {failed} failed{spent}; last error: {error}",
    "generate.batchDone": "Batch generation complete: {done} images{spent}.",
    "generate.singleDone": "Generation complete; saved 1 image{spent}.",
    "generate.spent": ", spent {spent} Anlas",
    "generate.spentPending": ", actual cost updating",
    "generate.spentFailed": ", actual cost unavailable",
    "generate.spentUnknown": ", actual cost not known exactly",
    "i2i.progress": "Running img2img {current}/{total} ({done} succeeded, {failed} failed)...",
    "i2i.doneFailed": "Img2img complete: {done} succeeded, {failed} failed{spent}; last error: {error}",
    "i2i.batchDone": "Batch img2img complete: {done} images{spent}.",
    "i2i.singleDone": "Img2img complete; saved 1 image{spent}.",
    "manual.queued": "Added to the queue; {ahead} ahead.",
    "manual.starting": "Added to the queue; starting now…",
    "manual.enqueueFailed": "Not queued: {message}",
    "manual.enqueueUnknown": "Could not confirm whether this click was queued; nothing was resent. Check the queue before generating again.",
    "manual.waiting": "Waiting in the queue; {ahead} ahead…",
    "manual.cancelling": "Cancelling this batch: the image being generated was stopped; if its request was already sent it may have been charged, and the image is not saved.",
    "manual.cancelled": "Batch cancelled: {done} succeeded{spent}.",
    "manual.stoppedNote": "The image being generated was stopped; if its request was already sent it may have been charged, and the image is not saved.",
    "manual.unknownNote": "{count} more with an unknown outcome: the request may have been sent and charged; nothing was resent. Check the history first.",
    "manual.doneUnknown": "Done: {done} succeeded{spent}. {count} more with an unknown outcome: the request may have been sent and charged; nothing was resent. Check the history first.",
    "manual.allUnknown": "{count} with an unknown outcome{spent}: the request may have been sent and charged; nothing was resent. Check the history first.",
    "manual.nothingToStop": "No manual batch is waiting or generating.",
    "manual.controlFailed": "The queue did not complete this: {message}",
  },
};

function storeText(settings: AppSettings | null | undefined, key: string) {
  const language = normalizeAppLanguage(settings?.language);
  return STORE_TEXT[language][key] ?? STORE_TEXT["en-US"][key] ?? STORE_TEXT["zh-CN"][key] ?? key;
}

function storeFormat(settings: AppSettings | null | undefined, key: string, values: Record<string, unknown>) {
  return storeText(settings, key).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ""));
}

/**
 * A refusal of applying history parameters (step 4c1): English message, and the copy key the parameters dialog
 * renders in the interface language (src/ui/legacy.strings.ts).
 */
function historyApplyRefusal(uiKey: "hp.generating" | "hp.tooManyChars" | "hp.postprocess") {
  return Object.assign(new Error(LEGACY_STRINGS[uiKey][1]), { uiKey });
}

/** A stored-state error in the interface language: by its copy key (a character snapshot), the assembly marker by its own text. */
function storedStateErrorText(settings: AppSettings | null | undefined, error: unknown): string {
  const uiKey = (error as { uiKey?: unknown } | null)?.uiKey;
  const pair = typeof uiKey === "string" && Object.hasOwn(LEGACY_STRINGS, uiKey) ? LEGACY_STRINGS[uiKey as keyof typeof LEGACY_STRINGS] : null;
  if (pair) return pair[normalizeAppLanguage(settings?.language) === "zh-CN" ? 0 : 1];
  if (error instanceof InvalidPromptAssemblyVersionError) return storeText(settings, "boot.invalidAssembly");
  return plainErrorMessage(error);
}

function compactStoreError(
  settings: AppSettings | null | undefined,
  error: unknown,
  fallback = storeText(settings, "error.requestFailed"),
) {
  return compactRemoteErrorText(error, {
    fallback,
    maxLength: 360,
    language: settings?.language,
  });
}

/**
 * One Generate click of this window, as a manual batch of the shared queue (step 4a). Kept until the batch ends; its
 * options say how a saved image is shown on the canvas (as the window's manual generation always showed it).
 */
export interface ManualBatchTrack {
  batchId: string;
  requestKey: string;
  mode: ManualMode;
  count: number;
  status: BatchJob["status"];
  done: number;
  /** Images that ended without success: failed, or with an unknown outcome (those also counted in unknown). */
  failed: number;
  /** Images whose outcome is unknown: the request may have been sent and charged. */
  unknown: number;
  activeIndex: number | null;
  lastError: string;
  /** The balance when the batch started right away; null when other images ran first (no exact spend then). */
  anlasBefore: number | null;
  options: { compareBefore?: WorkingImage | null; comparisonSurface?: CanvasSurface; loadWorkbench?: boolean };
}

/** queued: this window's click waits in the shared queue behind other images. */
export type GenerationPhase = "idle" | "preparing" | "queued" | "requesting" | "streaming" | "saving";

export type CanvasSurface =
  | "generate:t2i"
  | "generate:i2i"
  | "generate:enhance"
  | "inpaint"
  | "postprocess:upscale"
  | "postprocess:director";

interface AppState {
  bootDone: boolean;
  // Set only when a critical boot read (settings) fails outright — lets the
  // splash screen show a retry instead of spinning forever with no feedback.
  bootError: string | null;
  showOnboarding: boolean;
  showSettings: boolean;
  activeTab: ActiveTab;
  promptTab: PromptTab;
  /** Workspace rail widths (px); center fills the rest. Persisted to localStorage. */
  wsLeftWidth: number;
  wsRightWidth: number;
  params: GenerateParams;
  settings: AppSettings | null;
  account: AccountSummary;
  history: HistoryItem[];
  historyDates: string[];
  historyGroups: HistoryGroup[];
  selectedDate: string;
  selectedGroupId: string;
  generationGroupId: string;
  currentImage: HistoryItem | null;
  workbenchImage: WorkingImage | null;
  /** First image explicitly loaded by the user for the current img2img session. */
  i2iOriginalImage: WorkingImage | null;
  /** Choose whether the next redraw starts from the original or the latest result. */
  i2iSourceMode: "original" | "latest";
  /** Choose whether the next inpaint run starts from the original or latest result. */
  inpaintSourceMode: "original" | "latest";
  comparisonBeforeImage: WorkingImage | null;
  /** The exact tool surface that owns comparisonBeforeImage. Comparisons stay
   * cached while navigating, but render only when this surface is active. */
  comparisonSurface: CanvasSurface | null;
  activeCanvasSurface: CanvasSurface;
  generateMode: "t2i" | "i2i" | "enhance";
  postprocessMode: "upscale" | "director";
  enhanceMagnitude: number;
  enhanceScale: 1 | 2;
  i2iParams: I2IParams;
  i2iSizeMode: ImageToImageSizeMode;
  inpaintModel: NAIInpaintModel;
  inpaintStrength: number;
  inpaintNoise: number;
  /** Independent from params.positivePrompt — inpaint must not inherit the
   * main generate/i2i prompt automatically. */
  inpaintPositivePrompt: string;
  /** Complete independent edit recipe; base params and characters stay intact. */
  inpaintRecipe: GenerateParams | null;
  brushSize: number;
  brushOpacity: number;
  brushColor: string;
  brushMode: BrushMode;
  brushShape: InpaintBrushShape;
  inpaintMask: string | null;
  maskRevision: number;
  upscaleScale: UpscaleScale;
  directorTool: DirectorTool;
  augmentOptions: AugmentOptions;
  vibeImages: VibeTransferImage[];
  preciseReferences: PreciseReferenceImage[];
  charCaptions: CharCaption[];
  batchCount: number;
  batchIntervalSeconds: number;
  /** An image of this window's manual batches is being generated (or the batch waits between its images). */
  isGenerating: boolean;
  /** The manual batch that runs now (stream preview frames carry its batchId). */
  activeGenerationRunId: string | null;
  generationPreview: GenerationPreviewEvent | null;
  /** Explicit UI phase. Keeping this separate from localized status text avoids
   * rendering the balance/quote preflight as if image sampling had started. */
  generationPhase: GenerationPhase;
  /** This window's unfinished manual batches (its Generate clicks in the shared queue), oldest first. */
  manualBatches: ManualBatchTrack[];
  /** A click is being quoted and queued; a second click waits for it. */
  manualPreparing: boolean;
  currentAnlasSpent: number | null;
  lastAnlasSpent: number | null;
  statusText: string;
  lastError: string;
  toast: string;
  /**
   * When set with a toast: the toast replaces the one shown under the same key instead of stacking (a placeholder
   * then its result, e.g. 实扣统计更新中 then 实扣 N Anlas). Cleared with the toast.
   */
  toastKey: string;
  /** Latest new-version check result from the main process; the banner shows while it is available. */
  updateInfo: UpdateInfo | null;
  /** The self-update ("Update and restart") as the main process reports it; null before the first read. */
  updateProgress: UpdateProgressInfo | null;
  /** This start is the first one after an update: it worked, or the old version runs again. Cleared when dismissed. */
  updateNotice: UpdateNotice | null;

  load: () => Promise<void>;
  setShowOnboarding: (value: boolean) => void;
  setShowSettings: (value: boolean) => void;
  setActiveTab: (tab: ActiveTab) => void;
  setActiveCanvasSurface: (surface: CanvasSurface) => void;
  setGenerateMode: (mode: "t2i" | "i2i" | "enhance") => void;
  setPostprocessMode: (mode: "upscale" | "director") => void;
  setPromptTab: (tab: PromptTab) => void;
  setWsWidth: (edge: "left" | "right", px: number) => void;
  saveWsWidths: () => void;
  resetWsWidths: () => void;
  setParam: <K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => void;
  applyParams: (patch: Partial<GenerateParams>) => void;
  /** Internal history recovery lane; the only lane allowed to use undefined as a legacy marker-clear sentinel. */
  applyHistoricalParams: (patch: Partial<GenerateParams>, captions?: CharCaptionItem[]) => void;
  restoreImportedMetadata: (
    patch: ImportedParams,
    captions: CharCaptionItem[],
    options?: MetadataRestoreOptions,
  ) => void;
  /** Manual check (Settings › About): asks GitHub now and returns the result. */
  checkUpdate: () => Promise<UpdateInfo>;
  /** "Later": hides the banner until a later check announces a release again. */
  dismissUpdate: () => void;
  /** "Skip this version": remembered in ignoredUpdateVersion; automatic checks no longer announce it. */
  ignoreUpdate: (version: string) => Promise<void>;
  /** "Update and restart": starts the update, or installs a ready one. */
  startUpdate: () => Promise<UpdateProgressInfo | null>;
  cancelUpdate: () => Promise<void>;
  dismissUpdateNotice: () => void;
  setSelectedDate: (date: string) => Promise<void>;
  setSelectedGroupId: (groupId: string) => Promise<void>;
  setGenerationGroupId: (groupId: string) => Promise<void>;
  createGenerationGroup: (name: string) => Promise<void>;
  createHistoryGroup: (name: string) => Promise<void>;
  renameHistoryGroup: (id: string, name: string) => Promise<void>;
  deleteHistoryGroup: (id: string) => Promise<void>;
  exportHistoryGroup: (groupId: string) => Promise<void>;
  setHistoryItemGroup: (id: string, groupId?: string) => Promise<void>;
  refreshHistory: (date?: string) => Promise<void>;
  /** Re-reads only these history items and the view order (null: full refresh). Same result as refreshHistory() for the current view. */
  refreshHistoryItems: (ids: readonly string[] | null) => Promise<void>;
  /** After saving an image: patch it into the current date's list, or load its date like refreshHistory(item.date). */
  refreshHistoryAfterSave: (item: Pick<HistoryItem, "id" | "date">) => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshAccount: () => Promise<AccountSummary>;
  loadWorkbenchImage: () => Promise<void>;
  loadWorkbenchFromPath: (
    filePath: string,
    options?: { silent?: boolean; restoreMetadata?: boolean },
  ) => Promise<void>;
  clearWorkbenchImage: () => Promise<void>;
  setI2IParam: <K extends keyof I2IParams>(key: K, value: I2IParams[K]) => void;
  setI2ISizeMode: (mode: ImageToImageSizeMode) => void;
  setI2ISourceMode: (mode: "original" | "latest") => void;
  setInpaintSourceMode: (mode: "original" | "latest") => Promise<void>;
  setInpaintModel: (model: NAIInpaintModel) => void;
  setInpaintStrength: (value: number) => void;
  setInpaintNoise: (value: number) => void;
  setInpaintPositivePrompt: (value: string) => void;
  setInpaintRecipe: (patch: Partial<GenerateParams> | null) => void;
  setInpaintRecipeParam: <K extends keyof GenerateParams>(key: K, value: GenerateParams[K]) => void;
  setBrushSize: (size: number) => void;
  setBrushOpacity: (opacity: number) => void;
  setBrushColor: (color: string) => void;
  setBrushMode: (mode: BrushMode) => void;
  setBrushShape: (shape: InpaintBrushShape) => void;
  setInpaintMask: (mask: string | null) => void;
  clearInpaintMask: () => void;
  setUpscaleScale: (scale: UpscaleScale) => void;
  setDirectorTool: (tool: DirectorTool) => void;
  setAugmentOption: <K extends keyof AugmentOptions>(key: K, value: AugmentOptions[K]) => void;
  // Vibe Transfer / Precise Reference
  addVibeImage: (image: VibeTransferImage) => void;
  removeVibeImage: (id: string) => void;
  updateVibeImage: (id: string, patch: Partial<Pick<VibeTransferImage, "infoExtracted" | "strength">>) => void;
  clearVibeImages: () => void;
  addPreciseReference: (image: PreciseReferenceImage) => void;
  removePreciseReference: (id: string) => void;
  updatePreciseReference: (id: string, patch: Partial<Pick<PreciseReferenceImage, "type" | "strength" | "fidelity" | "informationExtracted">>) => void;
  clearPreciseReferences: () => void;
  // Character Prompt
  addCharCaption: () => void;
  removeCharCaption: (id: string) => void;
  updateCharCaption: (id: string, patch: Partial<Omit<CharCaption, "id">>) => void;
  clearCharCaptions: () => void;
  // Batch
  setBatchCount: (count: number) => void;
  setBatchIntervalSeconds: (seconds: number) => void;
  setToast: (message: string) => void;
  clearImageComparison: () => void;
  // Core actions
  generate: () => Promise<void>;
  generateI2I: () => Promise<void>;
  inpaint: () => Promise<void>;
  upscaleCurrentImage: () => Promise<void>;
  runDirectorTool: () => Promise<void>;
  /** Cancels this window's current manual batch (the running one, else the oldest waiting). */
  cancel: () => Promise<void>;
  /** Pauses or resumes this window's current manual batch in the shared queue. */
  togglePause: () => Promise<void>;
  selectImage: (item: HistoryItem) => void;
  variationFromImage: (item: HistoryItem) => void;
  deleteHistory: (id: string) => Promise<boolean>;
  renameHistoryItem: (id: string, name: string) => Promise<void>;
  clearToast: () => void;
}

function requireToken(set: (state: Partial<AppState>) => void, hasToken: boolean, settings?: AppSettings | null) {
  if (hasToken) return true;
  set({ showSettings: true, statusText: storeText(settings, "status.needApiToken"), toast: storeText(settings, "toast.needApiToken") });
  return false;
}

type CompletedImageBridge = {
  previewUrl: string;
  sourceUrl: string;
};

// The stream already decoded the final pixels, while the freshly-saved local
// URL still needs one disk read/decode. Keep those decoded pixels in both the
// canvas and the first history card until Chromium has the durable URL ready;
// otherwise <img> visibly falls back to the previous picture for a few frames.
const completedImageBridges = new Map<string, CompletedImageBridge>();

function withCompletedImageBridge(item: HistoryItem): HistoryItem {
  const bridge = completedImageBridges.get(item.id);
  return bridge ? { ...item, fileUrl: bridge.previewUrl } : item;
}

function preloadCompletedImage(sourceUrl: string): Promise<void> {
  if (!sourceUrl || typeof globalThis.Image !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const image = new globalThis.Image();
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      resolve();
    };
    image.onload = () => {
      if (typeof image.decode === "function") {
        void image.decode().then(finish, finish);
      } else {
        finish();
      }
    };
    image.onerror = finish;
    image.src = sourceUrl;
    timeoutId = globalThis.setTimeout(finish, 4_000);
  });
}

function showCompletedImage(
  set: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  item: HistoryItem,
  options: { compareBefore?: WorkingImage | null; comparisonSurface?: CanvasSurface; loadWorkbench?: boolean } = {},
) {
  const preview = get().generationPreview;
  const canBridge = Boolean(
    preview?.imageDataUrl
      && preview.progress >= 1
      && item.fileUrl
      && preview.imageDataUrl !== item.fileUrl,
  );
  if (canBridge && preview) {
    completedImageBridges.set(item.id, {
      previewUrl: preview.imageDataUrl,
      sourceUrl: item.fileUrl,
    });
  }
  const visibleItem = withCompletedImageBridge(item);
  set((state) => {
    const selectedGroup = state.selectedGroupId;
    const matchesGroup = !selectedGroup
      || (selectedGroup === "__ungrouped" ? !item.groupId : item.groupId === selectedGroup);
    const sameDateVisible = state.history.filter((candidate) => {
      if (candidate.date !== item.date) return false;
      if (!selectedGroup) return true;
      if (selectedGroup === "__ungrouped") return !candidate.groupId;
      return candidate.groupId === selectedGroup;
    });
    return {
      currentImage: visibleItem,
      comparisonBeforeImage: options.compareBefore ?? null,
      comparisonSurface: options.compareBefore ? options.comparisonSurface ?? state.activeCanvasSurface : null,
      selectedDate: item.date,
      historyDates: [item.date, ...state.historyDates.filter((date) => date !== item.date)].sort((a, b) => b.localeCompare(a)),
      history: matchesGroup
        ? [visibleItem, ...sameDateVisible.filter((candidate) => candidate.id !== item.id)]
        : sameDateVisible,
    };
  });
  if (canBridge) {
    void preloadCompletedImage(item.fileUrl).then(() => {
      const bridge = completedImageBridges.get(item.id);
      if (!bridge || bridge.sourceUrl !== item.fileUrl) return;
      completedImageBridges.delete(item.id);
      set((state) => ({
        currentImage: state.currentImage?.id === item.id
          ? { ...state.currentImage, filePath: item.filePath, fileUrl: item.fileUrl }
          : state.currentImage,
        history: state.history.map((candidate) => candidate.id === item.id
          ? { ...candidate, filePath: item.filePath, fileUrl: item.fileUrl }
          : candidate),
      }));
    });
  }
}


function buildExtras(state: AppState): GenerateExtras {
  return {
    vibeImages: state.vibeImages.map(({ base64, infoExtracted, strength }) => ({
      base64,
      infoExtracted,
      strength,
    })),
    preciseReferences: state.preciseReferences.map(({ base64, type, strength, fidelity, informationExtracted }) => ({
      base64,
      type,
      strength,
      fidelity,
      informationExtracted,
    })),
    charCaptions: state.charCaptions.map(({ prompt, negativePrompt, useCoords, x, y }) => ({
      prompt,
      negativePrompt,
      useCoords,
      x,
      y,
    })),
    historyGroupId: state.generationGroupId,
    modelMode: state.settings?.modelMode ?? "anime",
  };
}

function imageGenerationFailureMessage(settings: AppSettings | null | undefined, message?: string) {
  const detail = compactStoreError(settings, message, storeText(settings, "error.unknown"));
  // A message that already says what failed (the catalog's generation failure, or a refused charge) is shown as it is.
  return detail.includes("图片生成失败") || detail.includes("Image generation failed") || detail.startsWith("余额或订阅不足") || detail.startsWith("Not enough Anlas or subscription")
    ? detail
    : storeFormat(settings, "error.generationFailed", { detail });
}

function anlasSpent(before?: number, after?: number) {
  if (typeof before !== "number" || typeof after !== "number") return null;
  return Math.max(0, before - after);
}


async function ensureAnlasBeforeRun(
  set: (state: Partial<AppState>) => void,
  request: AnlasQuoteRequest,
  actionLabel: string,
  settings?: AppSettings | null,
): Promise<AnlasQuoteResult | null> {
  const quote = await window.naiDesktop.quoteAnlas(request);
  if (!quote.ok || typeof quote.amount !== "number") {
    const fallbackMessage = storeFormat(settings, "quote.readFailedTry", { action: actionLabel });
    const message = compactStoreError(settings, quote.message, fallbackMessage);
    set({ statusText: fallbackMessage, toast: message, lastError: "" });
    return {
      ok: true,
      amount: 0,
      source: "unavailable",
      balance: request.account?.anlasBalance,
      insufficient: false,
      message,
      details: quote.details,
    };
  }
  if (quote.insufficient) {
    const balance = quote.balance ?? storeText(settings, "error.unknown");
    const message = storeFormat(settings, "quote.insufficient", { action: actionLabel, amount: quote.amount, balance });
    set({ statusText: message, toast: message, lastError: "" });
    return quote;
  }
  set({ statusText: storeFormat(settings, "quote.deduct", { action: actionLabel, amount: quote.amount }), lastError: "" });
  return quote;
}


async function drainHistoryItems(
  set: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
) {
  historyItemsQueue.running = true;
  try {
    while (historyItemsQueue.ids.size) {
      for (const id of historyItemsQueue.failed) historyItemsQueue.ids.add(id);
      const ids = [...historyItemsQueue.ids];
      historyItemsQueue.ids.clear();
      const waiters = historyItemsQueue.waiters.splice(0);
      try {
        await applyHistoryItems(set, get, ids);
        for (const id of ids) historyItemsQueue.failed.delete(id);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        for (const id of ids) historyItemsQueue.failed.add(id);
        for (const waiter of waiters) waiter.reject(error);
      }
    }
  } finally {
    historyItemsQueue.running = false;
  }
}

// Patches changed history items into the current view (2026-11-01). The
// result equals refreshHistory() for the same view: the host returns the
// view's complete order plus the changed payloads, unchanged visible items
// keep their objects, and anything the view needs but the list lacks is read
// as well (or the whole view is reloaded). Ordering against full loads uses
// historyLoadRevision: a full load already in flight is awaited and then
// patched; a full load started meanwhile reads after this change and wins,
// unless it fails or applies nothing, in which case this read runs again.
async function applyHistoryItems(
  set: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  ids: string[],
) {
  const api = window.naiDesktop;
  if (ids.length > HISTORY_ITEMS_LIMIT || typeof api.getHistoryItems !== "function") return get().refreshHistory();
  for (let attempt = 0; attempt < 3; attempt++) {
    while (activeHistoryLoad) await activeHistoryLoad.catch(() => undefined);
    const revision = historyLoadRevision, loaded = historyLoadedSerial, { selectedDate, selectedGroupId } = get();
    const view = { date: selectedDate || undefined, groupId: selectedGroupId || undefined };
    const superseded = () => revision !== historyLoadRevision;
    // A newer full load owns the list only once it has applied one.
    const replacedByFullLoad = async () => {
      while (activeHistoryLoad) await activeHistoryLoad.catch(() => undefined);
      return historyLoadedSerial !== loaded;
    };
    const moved = () => get().selectedDate !== selectedDate || get().selectedGroupId !== selectedGroupId;
    const [snapshot, dates, groups] = await Promise.all([
      api.getHistoryItems({ ids, ...view }),
      api.getHistoryDates(),
      api.getHistoryGroups(),
    ]);
    if (superseded()) { if (await replacedByFullLoad()) return; continue; }
    if (moved()) continue;
    let merged = mergeHistorySnapshot(get().history, ids, snapshot, withCompletedImageBridge);
    if (merged.missing.length) {
      if (merged.missing.length > HISTORY_ITEMS_LIMIT) return get().refreshHistory();
      const extra = await api.getHistoryItems({ ids: merged.missing, ...view, order: false });
      if (superseded()) { if (await replacedByFullLoad()) return; continue; }
      if (moved()) continue;
      merged = mergeHistorySnapshot(get().history, [...ids, ...merged.missing], { order: snapshot.order, items: [...snapshot.items, ...extra.items] }, withCompletedImageBridge);
      if (merged.missing.length) return get().refreshHistory();
    }
    set({ history: merged.history, historyDates: dates, historyGroups: groups });
    return;
  }
  return get().refreshHistory();
}


async function refreshAfterImageInBackground(
  set: (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void,
  get: () => AppState,
  item: HistoryItem,
  options: { compareBefore?: WorkingImage | null; comparisonSurface?: CanvasSurface; loadWorkbench?: boolean } = {},
) {
  if (!get().generationPreview?.imageDataUrl && item.fileUrl) {
    // With streaming disabled there is no decoded final frame to bridge the
    // canvas. Keep the saving overlay mounted until the durable local image is
    // decoded, then reveal canvas/history/idle controls in one paint.
    set({ generationPhase: "saving" });
    await preloadCompletedImage(item.fileUrl);
  }
  showCompletedImage(set, get, item, options);
  // Disk reconciliation can finish later, and account balance is fetched only
  // once after the whole run rather than once per image.
  void get().refreshHistoryAfterSave(item).catch(() => undefined);
  if (options.loadWorkbench) {
    void get().loadWorkbenchFromPath(item.filePath, { silent: true }).catch(() => undefined);
  }
}

// ── Manual generation in the shared queue (step 4a) ──────────────────────────
// A Generate click of this window freezes the canvas into one manual batch of the host's shared queue. It starts at
// once when the queue is idle and waits behind the images already there otherwise; the host reports its progress
// (batch events), streams the running image (nai:generationPreview, requestId = batchId) and hands every saved image
// back (novelai:manual:item), which is shown on the canvas as the window's manual generation always showed it.

/** The latest state of every manual batch the host reported, also before this window knows its click's batchId. */
const latestManualBatches = new Map<string, BatchJob>();
/** Saved images that arrived before the enqueue reply named their batch. */
const pendingManualItems = new Map<string, ManualItemEvent[]>();
/** Per batch, the images still being shown: the batch's end waits for them (the saving overlay stays until decoded). */
const manualItemWork = new Map<string, Promise<void>>();
/** Manual batches this window saw end: a list read older than that end never adopts one again (step 4b3c). */
const endedManualBatches = new Map<string, true>();
/** Batches whose end is being settled (a repeated end event is ignored). */
const finishingManualBatches = new Set<string>();
/** Bounded memory of batches and images this window has not tracked (yet): the oldest go first. */
const remember = <T,>(map: Map<string, T>, key: string, value: T) => { map.delete(key); map.set(key, value); while (map.size > 100) map.delete(map.keys().next().value!); };
/** Whether next is a later state of the batch than current: an ended batch never goes back; otherwise the host's
 * updatedAt, which rises with every event of a batch, orders them. */
const laterBatch = (next: BatchJob, current?: BatchJob) => {
  if (!current) return true;
  if (isBatchTerminal(current.status) !== isBatchTerminal(next.status)) return isBatchTerminal(next.status);
  return !(typeof next.updatedAt === "string" && typeof current.updatedAt === "string" && next.updatedAt < current.updatedAt);
};
const settledCount = (batch: Pick<BatchJob, "items">, statuses: string[]) => batch.items.filter(item => statuses.includes(item.status)).length;
type StoreSet = (state: Partial<AppState> | ((state: AppState) => Partial<AppState>)) => void;

function queueAheadOf(batchId?: string): number | null {
  const view = windowQueueMonitor()?.getView();
  return view?.loaded ? imagesAhead(view.batches, batchId) : null;
}

function manualProgressText(settings: AppSettings | null | undefined, track: ManualBatchTrack, batch: BatchJob) {
  const current = Math.min(track.count, track.done + track.failed + 1);
  if (batch.activeIndex === null && batch.status === "running" && batch.intervalSeconds > 0)
    return storeFormat(settings, "status.batchInterval", { seconds: batch.intervalSeconds, current, total: track.count });
  return track.mode === "i2i"
    ? storeFormat(settings, "i2i.progress", { current, total: track.count, done: track.done, failed: track.failed - track.unknown })
    : storeFormat(settings, "status.generatingProgress", { current, total: track.count, done: track.done, failed: track.failed - track.unknown, waiting: 0 });
}

/** A host batch event (or the enqueue reply) of one of this window's manual batches. */
function applyManualBatch(set: StoreSet, get: () => AppState, batch: BatchJob) {
  if (!batch || typeof batch.batchId !== "string") return;
  if (!laterBatch(batch, latestManualBatches.get(batch.batchId))) return;
  remember(latestManualBatches, batch.batchId, batch);
  const track = get().manualBatches.find(value => value.batchId === batch.batchId);
  // Not (yet) this window's: the enqueue reply may still be on its way; it picks up this state then.
  if (!track) return;
  const done = settledCount(batch, ["succeeded"]), failed = settledCount(batch, ["failed", "unknown"]), unknown = settledCount(batch, ["unknown"]);
  const startedItem = batch.activeIndex !== null && (get().activeGenerationRunId !== batch.batchId || track.activeIndex !== batch.activeIndex);
  const next: ManualBatchTrack = { ...track, status: batch.status, done, failed, unknown, activeIndex: batch.activeIndex };
  set(state => ({ manualBatches: state.manualBatches.map(value => value.batchId === batch.batchId ? next : value) }));
  const settings = get().settings;
  if (isBatchTerminal(batch.status)) { if (!finishingManualBatches.has(batch.batchId)) { finishingManualBatches.add(batch.batchId); void finishManualBatch(set, get, next, batch).finally(() => finishingManualBatches.delete(batch.batchId)); } return; }
  if (["running", "pausing", "cancelling"].includes(batch.status)) {
    set({
      isGenerating: true, activeGenerationRunId: batch.batchId,
      ...(startedItem ? { generationPreview: null, generationPhase: "requesting" as const } : {}),
      statusText: batch.status === "cancelling" ? storeText(settings, "manual.cancelling") : manualProgressText(settings, next, batch),
    });
    return;
  }
  // Waiting (queued) or paused: this batch does not run now.
  const wasRunning = get().activeGenerationRunId === batch.batchId;
  if (wasRunning) set({ isGenerating: false, activeGenerationRunId: null, generationPreview: null });
  if (get().activeGenerationRunId) return;
  if (batch.status === "paused") { set({ generationPhase: "idle", statusText: storeFormat(settings, "status.paused", { done: done + failed, total: next.count }) }); return; }
  const ahead = queueAheadOf(batch.batchId);
  set({ generationPhase: "queued", ...(ahead !== null ? { statusText: storeFormat(settings, "manual.waiting", { ahead }) } : {}) });
}

/** One settled image of a manual batch: a saved one goes to the canvas (and a t2i seed back to the field), as before. */
function applyManualItem(set: StoreSet, get: () => AppState, event: ManualItemEvent): Promise<void> {
  if (!event || typeof event.batchId !== "string") return Promise.resolve();
  const track = get().manualBatches.find(value => value.batchId === event.batchId);
  if (!track && !(latestManualBatches.has(event.batchId) && isBatchTerminal(latestManualBatches.get(event.batchId)!.status))) {
    // The enqueue reply has not named this batch yet: show the image once it does (or the batch ends).
    remember(pendingManualItems, event.batchId, [...(pendingManualItems.get(event.batchId) ?? []), event]);
    return Promise.resolve();
  }
  // Images of one batch are shown in order; the batch's end waits for them.
  const work = (manualItemWork.get(event.batchId) ?? Promise.resolve()).then(() => showManualItem(set, get, event, track?.options ?? {})).catch(() => undefined);
  manualItemWork.set(event.batchId, work);
  return work;
}

async function showManualItem(set: StoreSet, get: () => AppState, event: ManualItemEvent, options: ManualBatchTrack["options"]) {
  const item = event.items?.[0];
  if (event.status === "succeeded" && item) {
    // A t2i image hands its actual seed back to the seed field, as the manual generation did after every image.
    if (event.mode === "t2i") set({ params: { ...get().params, seed: event.actualSeed ?? item.actualSeed } });
    await refreshAfterImageInBackground(set, get, item, options);
    return;
  }
  // A failed image names the last error of the summary; an unknown one is reported apart (it may have been charged).
  if (event.status !== "failed") return;
  const message = compactStoreError(get().settings, event.error ? hostErrorText(event.error, get().settings?.language) : undefined, storeText(get().settings, "error.unknown"));
  set(state => ({ manualBatches: state.manualBatches.map(value => value.batchId === event.batchId ? { ...value, lastError: message } : value) }));
}

async function flushPendingManualItems(set: StoreSet, get: () => AppState, batchId: string) {
  const waiting = pendingManualItems.get(batchId) ?? [];
  pendingManualItems.delete(batchId);
  for (const event of waiting) await applyManualItem(set, get, event);
}

/** The batch ended: the final message (with the actual spend when the batch ran right away), as before. */
async function finishManualBatch(set: StoreSet, get: () => AppState, track: ManualBatchTrack, batch: BatchJob) {
  // The last image is shown (and decoded) before the run ends, as the manual generation always did.
  await manualItemWork.get(batch.batchId);
  manualItemWork.delete(batch.batchId);
  latestManualBatches.delete(batch.batchId);
  remember(endedManualBatches, batch.batchId, true);
  track = get().manualBatches.find(value => value.batchId === batch.batchId) ?? track;
  const settlementRevision = ++generationSettlementRevision;
  set(state => {
    const manualBatches = state.manualBatches.filter(value => value.batchId !== batch.batchId);
    const running = state.activeGenerationRunId === batch.batchId;
    return { manualBatches, ...(running ? { isGenerating: false, activeGenerationRunId: null, generationPreview: null } : {}),
      ...(running || !state.activeGenerationRunId ? { generationPhase: manualBatches.length ? "queued" as const : "idle" as const } : {}), currentAnlasSpent: null };
  });
  const settings = get().settings, cancelled = batch.status === "cancelled";
  const itemError = [...batch.items].reverse().find(item => item.status === "failed" && item.error?.message)?.error;
  // Unknown outcomes are counted apart from failures: their request may have been sent and charged.
  const unknown = track.unknown, done = track.done, failed = track.failed - unknown;
  const lastError = track.lastError || (itemError ? compactStoreError(settings, hostErrorText(itemError, settings?.language)) : "") || (failed > 0 && batch.error ? hostErrorText(batch.error, settings?.language) : "");
  const unknownNote = unknown > 0 ? ` ${storeFormat(settings, "manual.unknownNote", { count: unknown })}` : "";
  const prefix = track.mode === "i2i" ? "i2i" : "generate";
  // An image cancelled while it ran (its request may have been sent) was aborted: it is not saved, and may be charged.
  const stoppedInFlight = batch.items.some(item => item.status === "cancelled" && item.jobId !== null);
  const finalMessage = (spentText: string) => cancelled
    ? `${storeFormat(settings, "manual.cancelled", { done, spent: spentText })}${stoppedInFlight ? ` ${storeText(settings, "manual.stoppedNote")}` : ""}${unknownNote}`
    : failed > 0 && done === 0
      ? `${imageGenerationFailureMessage(settings, lastError)}${unknownNote}`
      : failed > 0
        ? `${storeFormat(settings, `${prefix}.doneFailed`, { done, failed, spent: spentText, error: lastError || storeText(settings, "error.unknown") })}${unknownNote}`
        : unknown > 0
          ? storeFormat(settings, done > 0 ? "manual.doneUnknown" : "manual.allUnknown", { done, count: unknown, spent: spentText })
          : done > 1
          ? storeFormat(settings, `${prefix}.batchDone`, { done, spent: spentText })
          : storeFormat(settings, `${prefix}.singleDone`, { spent: spentText });
  const pending = finalMessage(storeText(settings, "generate.spentPending"));
  // The settled message replaces this placeholder in place (one toast per batch, not two).
  const toastKey = `manual-settled:${batch.batchId}`;
  set({ lastError: cancelled ? "" : failed > 0 ? lastError : "", statusText: pending, toast: pending, toastKey, lastAnlasSpent: null });
  try {
    const account = await window.naiDesktop.hasToken();
    if (generationSettlementRevision !== settlementRevision) return;
    const spent = track.anlasBefore === null ? null : anlasSpent(track.anlasBefore, account.anlasBalance);
    // No balance from right before the batch (adopted after a reload, or it waited behind other batches): its spend is
    // not known exactly, which is not a failed read (step 4c1).
    const message = finalMessage(spent != null ? storeFormat(get().settings, "generate.spent", { spent }) : storeText(get().settings, track.anlasBefore === null ? "generate.spentUnknown" : "generate.spentFailed"));
    set({ account, lastAnlasSpent: spent, statusText: message, toast: message, toastKey });
  } catch { /* The balance settles on the next refresh. */ }
}

interface ManualClick {
  quote: (account: AccountSummary) => AnlasQuoteRequest;
  actionLabel: string;
  request: Omit<ManualGenerationRequest, "requestKey" | "sourceId">;
  options: ManualBatchTrack["options"];
  /** Image modes: the file of the image the click uses (the one the canvas compares with), read at the click. */
  sourcePath?: string;
}

/**
 * One Generate click: refresh the balance and quote as before, then freeze it into a manual batch under one new
 * requestKey. An enqueue whose reply is lost is looked up once with that same key; it is never resent.
 */
async function queueManualClick(set: StoreSet, get: () => AppState, click: ManualClick) {
  if (get().manualPreparing) return;
  const settings = get().settings;
  set({ manualPreparing: true, lastError: "", ...(get().manualBatches.length ? {} : { generationPhase: "preparing" as const }), statusText: storeText(settings, "status.preparing") });
  const idle = () => { if (!get().manualBatches.length && !get().activeGenerationRunId) set({ generationPhase: "idle" }); };
  try {
    // The image of an image mode is read now, before any network round trip (balance, quote): a source changed
    // meanwhile, by the user or an agent, does not replace the one this click shows and compares with.
    let sourceId: string | undefined;
    if (click.sourcePath !== undefined) {
      let captured: Awaited<ReturnType<typeof window.naiDesktop.manualCaptureSource>> | null = null;
      try { captured = await window.naiDesktop.manualCaptureSource(click.sourcePath); } catch { captured = null; }
      if (!captured?.ok) {
        const message = storeFormat(settings, "manual.enqueueFailed", { message: captured && !captured.ok ? hostErrorText(captured.error, settings?.language) : storeText(settings, "status.imageLoadFailed") });
        set({ statusText: message, toast: message, lastError: message }); idle(); return;
      }
      sourceId = captured.result.sourceId;
    }
    let account: AccountSummary;
    try { account = await get().refreshAccount(); }
    catch (error) { const message = compactStoreError(settings, error); set({ statusText: message, toast: message, lastError: message }); idle(); return; }
    const quote = await ensureAnlasBeforeRun(set, click.quote(account), click.actionLabel, settings);
    if (!quote) { idle(); return; }
    const requestKey = newManualRequestKey();
    let reply: ManualEnqueueReply | null = null, refusal: string | null = null;
    try {
      const response = await window.naiDesktop.manualEnqueue({ requestKey, ...click.request, ...(sourceId ? { sourceId } : {}) });
      if (response.ok) reply = response.result; else refusal = storeFormat(settings, "manual.enqueueFailed", { message: compactStoreError(settings, hostErrorText(response.error, settings?.language)) });
    } catch {
      // The reply was lost: the same click is looked up once, never resent under another key.
      try { const found = await window.naiDesktop.manualLookup(requestKey); if (found.ok && found.result.batch) reply = found.result as ManualEnqueueReply; } catch { /* still unknown */ }
      if (!reply) refusal = storeText(settings, "manual.enqueueUnknown");
    }
    if (!reply) { set({ statusText: refusal!, toast: refusal!, lastError: refusal! }); idle(); return; }
    const batch = laterBatch(reply.batch, latestManualBatches.get(reply.batch.batchId)) ? reply.batch : latestManualBatches.get(reply.batch.batchId)!;
    const track: ManualBatchTrack = { batchId: batch.batchId, requestKey, mode: click.request.mode, count: batch.count, status: "queued", done: 0, failed: 0, unknown: 0, activeIndex: null, lastError: "",
      anlasBefore: reply.ahead === 0 && typeof account.anlasBalance === "number" ? account.anlasBalance : null, options: click.options };
    set(state => ({ manualBatches: [...state.manualBatches.filter(value => value.batchId !== batch.batchId), track], comparisonBeforeImage: null, currentAnlasSpent: null, lastAnlasSpent: null,
      statusText: reply!.ahead > 0 ? storeFormat(settings, "manual.queued", { ahead: reply!.ahead }) : storeText(settings, "manual.starting") }));
    // Images that arrived before this reply are shown first; then the latest batch state (an end waits for them).
    void flushPendingManualItems(set, get, batch.batchId);
    latestManualBatches.delete(batch.batchId);
    applyManualBatch(set, get, batch);
  } catch (error) {
    const message = compactStoreError(settings, error); set({ statusText: message, toast: message, lastError: message }); idle();
  } finally { set({ manualPreparing: false }); }
}

/**
 * After a reload of the window (4a P3-5, fixed in step 4b3c): the host still runs the manual batches the window
 * started before (there is one window, and a manual batch is only ever this window's). The new window adopts the
 * unfinished ones from list_queue, so Stop and Pause act on them and their next images come back to the canvas.
 * The spend of an adopted batch is not known exactly (its balance before was in the old window): it reads as unknown.
 * What the old click compared with (its source image) is gone with the old window; the canvas shows the images.
 */
export async function adoptManualBatches(set: StoreSet, get: () => AppState): Promise<number> {
  let response: Awaited<ReturnType<typeof window.naiDesktop.queueCall>> | null = null;
  try { response = typeof window.naiDesktop?.queueCall === "function" ? await window.naiDesktop.queueCall("list_queue", {}) : null; } catch { response = null; }
  if (!response?.ok) return 0;
  const listed = ((response.result as { batches?: BatchJob[] } | undefined)?.batches ?? []);
  let adopted = 0;
  for (const listedBatch of listed) {
    if (listedBatch?.source?.kind !== "manual" || isBatchTerminal(listedBatch.status) || endedManualBatches.has(listedBatch.batchId)) continue;
    if (get().manualBatches.some(value => value.batchId === listedBatch.batchId)) continue;
    const known = latestManualBatches.get(listedBatch.batchId);
    const batch = laterBatch(listedBatch, known) ? listedBatch : known!;
    if (isBatchTerminal(batch.status)) continue;
    const state = get(), mode = batch.mode as ManualBatchTrack["mode"];
    const options: ManualBatchTrack["options"] = mode === "i2i" ? { comparisonSurface: state.activeCanvasSurface, loadWorkbench: state.i2iSourceMode === "latest" }
      : mode === "inpaint" ? { comparisonSurface: "inpaint", loadWorkbench: state.inpaintSourceMode === "latest" }
      : mode === "upscale" ? { comparisonSurface: "postprocess:upscale" } : mode === "director" ? { comparisonSurface: "postprocess:director" } : {};
    const track: ManualBatchTrack = { batchId: batch.batchId, requestKey: batch.requestKey, mode, count: batch.count, status: "queued", done: 0, failed: 0, unknown: 0, activeIndex: null, lastError: "", anlasBefore: null, options };
    set(current => ({ manualBatches: [...current.manualBatches.filter(value => value.batchId !== batch.batchId), track] }));
    adopted += 1;
    void flushPendingManualItems(set, get, batch.batchId);
    latestManualBatches.delete(batch.batchId);
    applyManualBatch(set, get, batch);
  }
  return adopted;
}

/** The manual batch Pause/Stop acts on: the running one, else the oldest unfinished one of this window. */
function currentManualBatch(state: AppState) {
  return state.manualBatches.find(value => value.batchId === state.activeGenerationRunId) ?? state.manualBatches[0] ?? null;
}

async function controlManualBatch(set: StoreSet, get: () => AppState, action: "pause" | "resume" | "cancel") {
  const current = currentManualBatch(get());
  if (!current) { set({ toast: storeText(get().settings, "manual.nothingToStop") }); return; }
  const method = action === "pause" ? "pause_queue" : action === "resume" ? "resume_queue" : "cancel_queue";
  try {
    const response = await window.naiDesktop.queueCall(method, { batchId: current.batchId });
    if (!response?.ok) throw Object.assign(new Error(hostErrorText(response && !response.ok ? response.error : undefined, get().settings?.language)), { rendered: true });
    // A batch whose image is running reports cancelling (and says that image was stopped); one that waited ends at once.
    applyManualBatch(set, get, response.result as BatchJob);
  } catch (error) {
    const message = storeFormat(get().settings, "manual.controlFailed", { message: compactStoreError(get().settings, error) });
    set({ toast: message, statusText: message });
  }
}



const PERSISTED_INPAINT_MODELS = new Set<string>(NAI_INPAINT_MODELS.map((item) => item.value));
const PERSISTED_DIRECTOR_TOOLS = new Set<string>(DIRECTOR_TOOLS.map((item) => item.value));
const PERSISTED_EMOTIONS = new Set<string>(EMOTION_OPTIONS.map((item) => item.value));

function persistedNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function normalizeBatchIntervalSeconds(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(3600, Math.round(parsed))) : 0;
}


function normalizedBrushColor(value: unknown, fallback = "#ffffff") {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : fallback;
}

function normalizedLastToolState(last: LastGenerationState, state: AppState) {
  const i2i = last.i2iParams ?? state.i2iParams;
  const augment = last.augmentOptions ?? state.augmentOptions;
  const brushShape: InpaintBrushShape =
    last.brushShape === "round" || last.brushShape === "square"
      ? last.brushShape
      : state.brushShape;
  const restoredBrushSize = last.brushSizeUnit === "grid8"
    ? persistedNumber(last.brushSize, state.brushSize, 1, 500)
    : Number.isFinite(Number(last.brushSize))
      ? Math.round(persistedNumber(last.brushSize, state.brushSize * 8, 1, 128) / 8)
      : state.brushSize;
  return {
    i2iParams: {
      strength: persistedNumber(i2i.strength, DEFAULT_I2I_PARAMS.strength, 0, 1),
      noise: persistedNumber(i2i.noise, DEFAULT_I2I_PARAMS.noise, 0, 0.99),
      extraNoiseSeed: Math.round(
        persistedNumber(i2i.extraNoiseSeed, DEFAULT_I2I_PARAMS.extraNoiseSeed, 0, 2_147_483_647),
      ),
    },
    inpaintModel: (PERSISTED_INPAINT_MODELS.has(String(last.inpaintModel))
      ? last.inpaintModel
      : state.inpaintModel) as NAIInpaintModel,
    inpaintStrength: persistedNumber(last.inpaintStrength, state.inpaintStrength, 0, 1),
    inpaintNoise: persistedNumber(last.inpaintNoise, state.inpaintNoise, 0, 0.99),
    inpaintPositivePrompt:
      typeof last.inpaintPositivePrompt === "string" ? last.inpaintPositivePrompt : "",
    inpaintRecipe: last.inpaintRecipe && typeof last.inpaintRecipe === "object" && !Array.isArray(last.inpaintRecipe)
      ? normalizeGenerateParams(last.inpaintRecipe)
      : null,
    brushSize: normalizeInpaintBrushSize(restoredBrushSize, brushShape),
    brushOpacity: persistedNumber(last.brushOpacity, state.brushOpacity, 0.05, 1),
    brushColor: normalizedBrushColor(last.brushColor, state.brushColor),
    brushShape,
    upscaleScale: (last.upscaleScale === 2 || last.upscaleScale === 4
      ? last.upscaleScale
      : state.upscaleScale) as UpscaleScale,
    directorTool: (PERSISTED_DIRECTOR_TOOLS.has(String(last.directorTool))
      ? last.directorTool
      : state.directorTool) as DirectorTool,
    augmentOptions: {
      defry: persistedNumber(augment.defry, DEFAULT_AUGMENT_OPTIONS.defry, 0, 5),
      colorizePrompt:
        typeof augment.colorizePrompt === "string" ? augment.colorizePrompt : "",
      emotion: (PERSISTED_EMOTIONS.has(String(augment.emotion))
        ? augment.emotion
        : DEFAULT_AUGMENT_OPTIONS.emotion) as AugmentOptions["emotion"],
      emotionLevel: persistedNumber(
        augment.emotionLevel,
        DEFAULT_AUGMENT_OPTIONS.emotionLevel,
        0,
        5,
      ),
    },
  };
}

/** Restoring history parameters is refused while a generation is running. */
export function historyRecoveryIsBusy(state: Pick<AppState, "isGenerating">): boolean {
  return state.isGenerating;
}

function buildLastGenerationState(state: AppState): LastGenerationState {
  return {
    // positivePrompt is included so it survives a restart/crash, matching the
    // mobile client (which already persists the full params unconditionally).
    params: normalizeGenerateParams(state.params),
    charCaptions: snapshotCharacters(state.charCaptions).captions,
    batchCount: state.batchCount,
    batchIntervalSeconds: state.batchIntervalSeconds,
    i2iParams: state.i2iParams,
    inpaintModel: state.inpaintModel,
    inpaintStrength: state.inpaintStrength,
    inpaintNoise: state.inpaintNoise,
    inpaintPositivePrompt: state.inpaintPositivePrompt,
    inpaintRecipe: state.inpaintRecipe ? normalizeGenerateParams(state.inpaintRecipe) : null,
    brushSize: state.brushSize,
    brushOpacity: state.brushOpacity,
    brushColor: state.brushColor,
    brushShape: state.brushShape,
    brushSizeUnit: "grid8",
    upscaleScale: state.upscaleScale,
    directorTool: state.directorTool,
    augmentOptions: state.augmentOptions,
  };
}

function persistGenerationState(get: () => AppState) {
  const state = get();
  if (!state.settings) return;
  void window.naiDesktop.setSetting("lastGenerationState", buildLastGenerationState(state));
}

/** Persist the same recipe fields after a single workspace bridge Store transaction. */
export function persistWorkspaceState() {
  persistGenerationState(useAppStore.getState);
}

export const useAppStore = create<AppState>((set, get) => ({
  bootDone: false,
  bootError: null,
  showOnboarding: false,
  showSettings: false,
  activeTab: "generate",
  promptTab: "positive",
  wsLeftWidth: readWsWidth("mcp-for-novelai.ws.left", WS_LEFT_DEFAULT),
  wsRightWidth: readWsWidth("mcp-for-novelai.ws.right", WS_RIGHT_DEFAULT),
  params: { ...DEFAULT_PARAMS },
  settings: null,
  account: { hasToken: false },
  history: [],
  historyDates: [],
  historyGroups: [],
  selectedDate: "",
  selectedGroupId: "",
  generationGroupId: "",
  currentImage: null,
  workbenchImage: null,
  i2iOriginalImage: null,
  i2iSourceMode: "original",
  inpaintSourceMode: "original",
  comparisonBeforeImage: null,
  comparisonSurface: null,
  activeCanvasSurface: "generate:t2i",
  generateMode: "t2i",
  postprocessMode: "upscale",
  enhanceMagnitude: 3,
  enhanceScale: 1,
  i2iParams: { ...DEFAULT_I2I_PARAMS },
  i2iSizeMode: "adaptive",
  inpaintModel: "nai-diffusion-5-full-inpainting",
  inpaintStrength: 1,
  inpaintNoise: 0,
  inpaintPositivePrompt: "",
  inpaintRecipe: null,
  brushSize: 4,
  brushOpacity: 0.55,
  brushColor: "#ffffff",
  brushMode: "paint",
  brushShape: "round",
  inpaintMask: null,
  maskRevision: 0,
  upscaleScale: 4,
  directorTool: "bg-removal",
  augmentOptions: { ...DEFAULT_AUGMENT_OPTIONS },
  vibeImages: [],
  preciseReferences: [],
  charCaptions: [],
    batchCount: 1,
    batchIntervalSeconds: 0,
  isGenerating: false,
  activeGenerationRunId: null,
  generationPreview: null,
  generationPhase: "idle",
  manualBatches: [],
  manualPreparing: false,
  currentAnlasSpent: null,
  lastAnlasSpent: null,
  statusText: storeText(null, "status.ready"),
  lastError: "",
  toast: "",
  toastKey: "",
  updateInfo: null,
  updateProgress: null,
  updateNotice: null,

  async load() {
    const listenerHost = window as typeof window & Record<string, unknown>;
    const listenerRegistry = listenerHost[storeIpcListenerRegistryKey] as StoreIpcListenerRegistry | undefined;
    if (listenerRegistry?.owner !== storeIpcListenerOwner) {
      listenerRegistry?.removeGenerationPreview?.();
      listenerRegistry?.removeUpdateEvent?.();
      listenerRegistry?.removeUpdateProgress?.();
      listenerRegistry?.removeManualBatch?.();
      listenerRegistry?.removeManualItem?.();
      const removeGenerationPreview = window.naiDesktop.onGenerationPreview((event) => {
        const state = get();
        if (
          state.isGenerating &&
          state.activeGenerationRunId === event.requestId
        ) {
          set({
            generationPreview: event,
            generationPhase: event.progress >= 1 ? "saving" : "streaming",
          });
        }
      });
      const removeUpdateEvent = window.naiDesktop.onUpdateEvent((info) => set({ updateInfo: info }));
      const removeUpdateProgress = typeof window.naiDesktop.onUpdateProgress === "function"
        ? window.naiDesktop.onUpdateProgress((progress) => set({ updateProgress: progress }))
        : undefined;
      // This window's manual batches: their progress from the queue's batch events, their saved images for the canvas.
      const removeManualBatch = typeof window.naiDesktop.onQueueBatch === "function"
        ? window.naiDesktop.onQueueBatch((batch) => { if (batch?.source?.kind === "manual") applyManualBatch(set, get, batch); })
        : undefined;
      const removeManualItem = typeof window.naiDesktop.onManualItem === "function"
        ? window.naiDesktop.onManualItem((event) => { void applyManualItem(set, get, event); })
        : undefined;
      // A check that finished before this listener existed is read once; a newer published result wins.
      void Promise.resolve(window.naiDesktop.getUpdateStatus?.())
        .then((info) => { if (info && !get().updateInfo) set({ updateInfo: info }); })
        .catch(() => undefined);
      void Promise.resolve(window.naiDesktop.getUpdateProgress?.())
        .then((progress) => { if (progress && !get().updateProgress) set({ updateProgress: progress }); })
        .catch(() => undefined);
      void Promise.resolve(window.naiDesktop.getUpdateNotice?.())
        .then((notice) => { if (notice) set({ updateNotice: notice }); })
        .catch(() => undefined);
      listenerHost[storeIpcListenerRegistryKey] = {
        owner: storeIpcListenerOwner,
        removeGenerationPreview: typeof removeGenerationPreview === "function" ? removeGenerationPreview : undefined,
        removeUpdateEvent: typeof removeUpdateEvent === "function" ? removeUpdateEvent : undefined,
        removeUpdateProgress: typeof removeUpdateProgress === "function" ? removeUpdateProgress : undefined,
        removeManualBatch: typeof removeManualBatch === "function" ? removeManualBatch : undefined,
        removeManualItem: typeof removeManualItem === "function" ? removeManualItem : undefined,
      } satisfies StoreIpcListenerRegistry;
    }

    // Settings drive almost everything below (language, persisted params, lock
    // state) — there's no safe fallback to fake, so a failure here surfaces a
    // retriable error instead of the other reads' fire-and-forget defaults.
    let settings: AppSettings;
    try {
      settings = await window.naiDesktop.getSettings();
    } catch (error: any) {
      set({ bootError: plainErrorMessage(error, "") || storeText(null, "boot.settingsFailed") });
      return;
    }
    set({ bootError: null });

    // Each of these can independently fail (e.g. history/dates hit a removed
    // network drive) without blocking boot — a single Promise.all would let
    // any one rejection permanently strand the splash screen with bootDone
    // never set. Each gets a safe default instead.
    const [accountResult, firstRunResult, datesResult, groupsResult] = await Promise.allSettled([
      window.naiDesktop.accountCached(),
      window.naiDesktop.isFirstRun(),
      window.naiDesktop.getHistoryDates(),
      window.naiDesktop.getHistoryGroups(),
    ]);
    const account: AccountSummary = accountResult.status === "fulfilled" ? accountResult.value : { hasToken: false };
    const firstRun = firstRunResult.status === "fulfilled" ? firstRunResult.value : false;
    const dates = datesResult.status === "fulfilled" ? datesResult.value : [];
    const groups = groupsResult.status === "fulfilled" ? groupsResult.value : [];

    const selectedDate = dates[0] ?? "";
    const selectedGroupId = settings.activeHistoryGroupId ?? "";
    const generationGroupId = groups.some((group) => group.id === settings.generationGroupId)
      ? settings.generationGroupId
      : "";
    let history: HistoryItem[] = [];
    try {
      history = await trackHistoryLoad(window.naiDesktop.getHistory(selectedDate || undefined, selectedGroupId || undefined));
    } catch {
      /* history list will catch up on the next natural refresh */
    }
    const last = settings.lastGenerationState;
    if (last) {
      try {
        if (settings.persistGenerateParams) {
          assertPromptAssemblyVersion(last.params);
          if (Object.hasOwn(last, "charCaptions")) readCharacterSnapshot({ version: 1, captions: last.charCaptions });
        }
        if (settings.persistInpaintParams && last.inpaintRecipe) assertPromptAssemblyVersion(last.inpaintRecipe);
      } catch (error) {
        set({
          // In the language of the settings just read (step 4c1): a snapshot error by its copy key, the assembly marker by its own text.
          bootError: storeFormat(settings, "boot.invalidParams", { detail: storedStateErrorText(settings, error) }),
          settings,
        });
        return;
      }
      const repairedTools = normalizedLastToolState(last, get());
      set((state) => ({
        params: settings.persistGenerateParams ? normalizeInheritedGenerateParams(last.params, state.params) : state.params,
        charCaptions: settings.persistGenerateParams && Object.hasOwn(last, "charCaptions")
          ? readCharacterSnapshot({ version: 1, captions: last.charCaptions }).captions.map(caption => ({ ...caption, id: crypto.randomUUID() }))
          : state.charCaptions,
        batchCount: settings.persistGenerateParams
          ? Math.max(1, Math.min(999, last.batchCount ?? state.batchCount))
          : state.batchCount,
        batchIntervalSeconds: settings.persistGenerateParams
          ? normalizeBatchIntervalSeconds(last.batchIntervalSeconds ?? state.batchIntervalSeconds)
          : state.batchIntervalSeconds,
        i2iParams: settings.persistI2IParams ? repairedTools.i2iParams : state.i2iParams,
        inpaintModel: settings.persistInpaintParams ? repairedTools.inpaintModel : state.inpaintModel,
        inpaintStrength: settings.persistInpaintParams
          ? repairedTools.inpaintStrength
          : state.inpaintStrength,
        inpaintNoise: settings.persistInpaintParams ? repairedTools.inpaintNoise : state.inpaintNoise,
        inpaintPositivePrompt: settings.persistInpaintParams
          ? repairedTools.inpaintPositivePrompt
          : state.inpaintPositivePrompt,
        inpaintRecipe: settings.persistInpaintParams ? repairedTools.inpaintRecipe : state.inpaintRecipe,
        brushSize: settings.persistInpaintParams ? repairedTools.brushSize : state.brushSize,
        brushOpacity: settings.persistInpaintParams ? repairedTools.brushOpacity : state.brushOpacity,
        brushColor: settings.persistInpaintParams ? repairedTools.brushColor : state.brushColor,
        brushShape: settings.persistInpaintParams ? repairedTools.brushShape : state.brushShape,
        upscaleScale: settings.persistUpscaleParams ? repairedTools.upscaleScale : state.upscaleScale,
        directorTool: settings.persistDirectorParams ? repairedTools.directorTool : state.directorTool,
        augmentOptions: settings.persistDirectorParams
          ? repairedTools.augmentOptions
          : state.augmentOptions,
      }));
    }
    // Locks only protect fields from template/reset overwrites; persistence uses lastGenerationState.
    const restored: Partial<GenerateParams> = {};
    if (settings.lockStylePrompt) restored.stylePrompt = settings.savedStylePrompt ?? "";
    if (settings.lockNegativePrompt) restored.negativePrompt = settings.savedNegativePrompt ?? "";
    set((state) => ({ params: { ...state.params, ...restored } }));
    set({
      bootDone: true,
      settings,
      account,
      // Never let a refresh-triggered load() (e.g. the onboarding output-dir
      // step toggling a setting) close an onboarding wizard that's open: keep
      // it visible if it already is, otherwise drive it from firstRun.
      showOnboarding: firstRun || get().showOnboarding,
      historyDates: dates,
      historyGroups: groups,
      selectedDate,
      selectedGroupId,
      generationGroupId,
      history,
      currentImage: history[0] ?? null,
      statusText: account.hasToken ? storeText(settings, "status.apiConfigured") : storeText(settings, "status.needApiToken"),
    });
    // Refresh the live balance off the boot path so a slow network never delays
    // the first frame (refreshAccount swallows network errors → cached/stale).
    if (account.hasToken) void get().refreshAccount();
    // A reloaded window takes over the manual batches it started before the reload (step 4b3c).
    void adoptManualBatches(set, get);
  },

  setShowOnboarding(value) {
    set({ showOnboarding: value });
  },

  setShowSettings(value) {
    set({ showSettings: value });
  },

  setActiveTab(requested) {
    // A page id this version does not know opens the generate page instead of a blank screen.
    const tab = restorableActiveTab(requested);
    set((state) => ({ activeTab: tab,
      ...(tab === "generate" ? { activeCanvasSurface: `generate:${state.generateMode}` as CanvasSurface }
        : tab === "inpaint" ? { activeCanvasSurface: "inpaint" as const }
        : tab === "postprocess" ? { activeCanvasSurface: `postprocess:${state.postprocessMode}` as CanvasSurface } : {}),
    }));
  },

  setPromptTab(tab) {
    set({ promptTab: tab });
  },

  setWsWidth(edge, px) {
    const clamped =
      edge === "left"
        ? Math.round(Math.max(WS_LEFT_MIN, Math.min(WS_LEFT_MAX, px)))
        : Math.round(Math.max(WS_RIGHT_MIN, Math.min(WS_RIGHT_MAX, px)));
    set(edge === "left" ? { wsLeftWidth: clamped } : { wsRightWidth: clamped });
  },
  saveWsWidths() {
    const { wsLeftWidth, wsRightWidth } = get();
    try {
      localStorage.setItem("mcp-for-novelai.ws.left", String(wsLeftWidth));
      localStorage.setItem("mcp-for-novelai.ws.right", String(wsRightWidth));
    } catch {
      /* ignore persistence failure */
    }
  },
  resetWsWidths() {
    set({ wsLeftWidth: WS_LEFT_DEFAULT, wsRightWidth: WS_RIGHT_DEFAULT });
    try {
      localStorage.setItem("mcp-for-novelai.ws.left", String(WS_LEFT_DEFAULT));
      localStorage.setItem("mcp-for-novelai.ws.right", String(WS_RIGHT_DEFAULT));
    } catch {
      /* ignore persistence failure */
    }
  },

  setParam(key, value) {
    if (key === "promptAssemblyVersion") assertPromptAssemblyVersion({ promptAssemblyVersion: value });
    set((state) => {
      const next = { ...state.params, [key]: value } as GenerateParams;
      if (key === "qualityPreset") {
        next.qualityToggle = value !== "none";
      } else if (key === "qualityToggle") {
        next.qualityPreset = value
          ? state.params.qualityPreset === "none"
            ? "standard"
            : state.params.qualityPreset
          : "none";
      } else if (key === "model" && !isNAIV5Model(String(value))) {
        if (next.qualityPreset === "light") next.qualityPreset = "standard";
        next.qualityToggle = next.qualityPreset !== "none";
        next.transparentBackground = false;
      }
      return { params: next };
    });
    persistGenerationState(get);
  },

  setActiveCanvasSurface(surface) {
    set({ activeCanvasSurface: surface });
  },

  setGenerateMode(mode) {
    set((state) => ({ generateMode: mode, ...(state.activeTab === "generate" ? { activeCanvasSurface: `generate:${mode}` as CanvasSurface } : {}) }));
  },

  setPostprocessMode(mode) {
    set((state) => ({ postprocessMode: mode, ...(state.activeTab === "postprocess" ? { activeCanvasSurface: `postprocess:${mode}` as CanvasSurface } : {}) }));
  },

  applyParams(patch) {
    assertPromptAssemblyVersion(patch);
    set((state) => ({ params: normalizeGenerateParams({ ...state.params, ...patch }) }));
    persistGenerationState(get);
  },

  applyHistoricalParams(patch, captions) {
    if (historyRecoveryIsBusy(get())) throw historyApplyRefusal("hp.generating");
    assertPromptAssemblyVersion(patch, { allowUndefinedClear: true });
    const params = normalizeGenerateParams({ ...get().params, ...patch });
    // Validate everything before the single observable recipe transaction.
    const restored = captions === undefined ? undefined : snapshotCharacters(captions).captions;
    if (restored && restored.length > maxNAICharacterPrompts(params.model)) throw historyApplyRefusal("hp.tooManyChars");
    set({ params, ...(restored ? { charCaptions: restored.map(caption => ({ ...caption, id: crypto.randomUUID() })) } : {}) });
    persistGenerationState(get);
  },

  restoreImportedMetadata(patch, captions, options) {
    assertPromptAssemblyVersion(patch);
    const restoredCaptions: CharCaption[] = captions
      .slice(0, maxNAICharacterPrompts(patch.model ?? get().params.model))
      .map((caption) => ({
      ...caption,
      id: crypto.randomUUID(),
      }));
    set((state) => ({
      params: normalizeGenerateParams({ ...state.params, ...patch }),
      charCaptions:
        options?.restoreCharacters === false || (options?.restoreCharacters !== true && options?.preserveMissing && restoredCaptions.length === 0)
          ? state.charCaptions
          : restoredCaptions,
      // Exact restore can start clean, while generation-workbench imports use
      // preserveMissing so fields absent from the image keep their current value.
      vibeImages: options?.resetReferences || !options?.preserveMissing ? [] : state.vibeImages,
      preciseReferences: options?.resetReferences || !options?.preserveMissing ? [] : state.preciseReferences,
      settings: options?.modelMode && state.settings ? { ...state.settings, modelMode: options.modelMode } : state.settings,
    }));
    if (options?.modelMode) void window.naiDesktop.setSetting("modelMode", options.modelMode).catch(() => undefined);
    persistGenerationState(get);
  },

  async checkUpdate() {
    const info = await window.naiDesktop.checkUpdate();
    // A failed manual check is shown where it was asked for; it does not change the banner.
    if (info.status === "available" || info.status === "current" || info.status === "ignored") set({ updateInfo: info });
    return info;
  },

  dismissUpdate() {
    set({ updateInfo: null });
  },

  async ignoreUpdate(version) {
    const ignoredUpdateVersion = await window.naiDesktop.setSetting("ignoredUpdateVersion", version);
    set((state) => ({
      settings: state.settings ? { ...state.settings, ignoredUpdateVersion } : state.settings,
      updateInfo: state.updateInfo ? { ...state.updateInfo, status: "ignored", hasUpdate: false } : null,
    }));
  },

  async startUpdate() {
    if (typeof window.naiDesktop.startUpdate !== "function") return null;
    const progress = await window.naiDesktop.startUpdate();
    set({ updateProgress: progress });
    return progress;
  },

  async cancelUpdate() {
    if (typeof window.naiDesktop.cancelUpdate !== "function") return;
    set({ updateProgress: await window.naiDesktop.cancelUpdate() });
  },

  dismissUpdateNotice() {
    set({ updateNotice: null });
  },

  async setSelectedDate(date) {
    const revision = ++historyLoadRevision, groupId = get().selectedGroupId;
    set({ selectedDate: date, history: [] });
    const history = await trackHistoryLoad(window.naiDesktop.getHistory(date || undefined, groupId || undefined));
    if (revision === historyLoadRevision) { set({ history: history.map(withCompletedImageBridge) }); historyLoadedSerial++; }
  },

  async setSelectedGroupId(groupId) {
    const revision = ++historyLoadRevision, selectedDate = get().selectedDate;
    set({ selectedGroupId: groupId, history: [] });
    // Persist preferences in order too: an older, slower write must not win on
    // the next launch. Superseded writes that have not begun can be skipped.
    const persist = historyGroupWrite.catch(() => undefined).then(() => {
      if (get().selectedGroupId === groupId) return window.naiDesktop.setSetting("activeHistoryGroupId", groupId);
    });
    historyGroupWrite = persist;
    const load = trackHistoryLoad(window.naiDesktop.getHistory(selectedDate || undefined, groupId || undefined).then(history => {
      if (revision === historyLoadRevision) { set({ history: history.map(withCompletedImageBridge) }); historyLoadedSerial++; }
    }));
    await Promise.all([persist, load]);
  },

  async setGenerationGroupId(groupId) {
    const normalized = get().historyGroups.some((group) => group.id === groupId) ? groupId : "";
    await window.naiDesktop.setSetting("generationGroupId", normalized);
    set((state) => ({
      generationGroupId: normalized,
      settings: state.settings ? { ...state.settings, generationGroupId: normalized } : state.settings,
    }));
  },

  async createGenerationGroup(name) {
    const trimmed = name.trim();
    if (!trimmed) {
      set({ toast: storeText(get().settings, "group.nameRequired") });
      return;
    }
    const groups = await window.naiDesktop.createHistoryGroup(trimmed);
    const group = groups.find((item) => item.name.toLowerCase() === trimmed.toLowerCase());
    if (!group) return;
    await window.naiDesktop.setSetting("generationGroupId", group.id);
    set((state) => ({
      historyGroups: groups,
      generationGroupId: group.id,
      settings: state.settings ? { ...state.settings, generationGroupId: group.id } : state.settings,
      toast: storeFormat(state.settings, "group.created", { name: group.name }),
    }));
  },

  async createHistoryGroup(name) {
    const groups = await window.naiDesktop.createHistoryGroup(name);
    const settings = get().settings;
    set({
      historyGroups: groups,
      toast: name.trim()
        ? storeFormat(settings, "group.created", { name: name.trim() })
        : storeText(settings, "group.nameRequired"),
    });
  },

  async renameHistoryGroup(id, name) {
    if (!name.trim()) return;
    const groups = await window.naiDesktop.renameHistoryGroup(id, name);
    set({ historyGroups: groups, toast: storeFormat(get().settings, "group.renamed", { name: name.trim() }) });
  },

  async deleteHistoryGroup(id) {
    const groups = await window.naiDesktop.deleteHistoryGroup(id);
    const selectedGroupId = get().selectedGroupId === id ? "" : get().selectedGroupId;
    const generationGroupId = get().generationGroupId === id ? "" : get().generationGroupId;
    set((state) => ({
      historyGroups: groups,
      selectedGroupId,
      generationGroupId,
      settings: state.settings ? { ...state.settings, generationGroupId } : state.settings,
    }));
    await get().refreshHistory();
    set({ toast: storeText(get().settings, "group.deleted") });
  },

  async exportHistoryGroup(groupId) {
    // The outcome replaces the "packing" toast in place.
    const toastKey = `group-export:${groupId}`;
    set({ toast: storeText(get().settings, "group.packing"), toastKey });
    const result = await window.naiDesktop.exportHistoryGroup(groupId);
    // The host names the outcome by code and params (step 4a); it is shown in the interface language.
    set({ toast: hostErrorText(result, get().settings?.language), toastKey });
  },

  async setHistoryItemGroup(id, groupId) {
    const previous = get().history.find((item) => item.id === id);
    set((state) => ({
      history: state.history.map((item) =>
        item.id === id ? { ...item, groupId: groupId || undefined } : item,
      ),
      currentImage: state.currentImage?.id === id
        ? { ...state.currentImage, groupId: groupId || undefined }
        : state.currentImage,
    }));
    try {
      await window.naiDesktop.setHistoryGroup(id, groupId || undefined);
    } catch (error: any) {
      if (previous) {
        set((state) => ({
          history: state.history.map((item) => item.id === id ? previous : item),
          currentImage: state.currentImage?.id === id ? previous : state.currentImage,
          toast: plainErrorMessage(error),
        }));
      }
    }
  },

  async refreshHistory(date) {
    const revision = ++historyLoadRevision, selectedDate = date ?? get().selectedDate, selectedGroupId = get().selectedGroupId;
    await trackHistoryLoad((async () => {
      const [dates, groups] = await Promise.all([
        window.naiDesktop.getHistoryDates(),
        window.naiDesktop.getHistoryGroups(),
      ]);
      if (revision !== historyLoadRevision) return;
      const history = (await window.naiDesktop.getHistory(selectedDate || undefined, selectedGroupId || undefined))
        .map(withCompletedImageBridge);
      if (revision === historyLoadRevision) { set({ historyDates: dates, historyGroups: groups, selectedDate, history }); historyLoadedSerial++; }
    })());
  },

  refreshHistoryItems(ids) {
    if (ids === null || ids.length > HISTORY_ITEMS_LIMIT || typeof window.naiDesktop.getHistoryItems !== "function") return get().refreshHistory();
    if (!ids.length) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      for (const id of ids) historyItemsQueue.ids.add(id);
      historyItemsQueue.waiters.push({ resolve, reject });
      if (!historyItemsQueue.running) void drainHistoryItems(set, get);
    });
  },

  refreshHistoryAfterSave(item) {
    return get().selectedDate === item.date ? get().refreshHistoryItems([item.id]) : get().refreshHistory(item.date);
  },

  async refreshSettings() {
    const settings = await window.naiDesktop.getSettings();
    set({ settings });
  },

  async refreshAccount() {
    const account = await window.naiDesktop.hasToken();
    const settings = get().settings;
    set({ account, statusText: account.hasToken ? storeText(settings, "status.apiConfigured") : storeText(settings, "status.needApiToken") });
    return account;
  },

  async loadWorkbenchImage() {
    const loadRevision = ++workbenchLoadRevision;
    const result = await window.naiDesktop.loadImage();
    if (loadRevision !== workbenchLoadRevision) return;
    if (result.ok && result.image) {
      set({
        workbenchImage: result.image,
        i2iOriginalImage: result.image,
        comparisonBeforeImage: null,
        inpaintMask: null,
        maskRevision: get().maskRevision + 1,
        statusText: storeFormat(get().settings, "status.imageLoaded", { width: result.image.width, height: result.image.height }),
      });
    } else if (result.message) {
      set({ toast: compactStoreError(get().settings, hostErrorText(result, get().settings?.language)), statusText: storeText(get().settings, "status.imageLoadFailed") });
    }
  },

  async loadWorkbenchFromPath(filePath, options) {
    const loadRevision = ++workbenchLoadRevision;
    let result;
    try {
      result = await window.naiDesktop.loadImageFromPath(filePath);
    } catch (error: any) {
      if (loadRevision !== workbenchLoadRevision) return;
      const message = compactStoreError(
        get().settings,
        error?.message,
        storeText(get().settings, "status.imageLoadFailed"),
      );
      set({ toast: message, statusText: message });
      return;
    }
    if (loadRevision !== workbenchLoadRevision) return;
    if (result.ok && result.image) {
      // History metadata may update prompts. Never let a delayed selection do
      // that after generation has begun; the paid request already owns a fixed
      // parameter snapshot and the editor must keep the user's current prompt.
      if (options?.silent || get().isGenerating) {
        set({
          workbenchImage: result.image,
          inpaintMask: null,
          maskRevision: get().maskRevision + 1,
        });
        return;
      }
      const restoreMetadata =
        options?.restoreMetadata === true &&
        get().activeTab === "generate" &&
        result.metadata;
      set({
        workbenchImage: result.image,
        i2iOriginalImage: result.image,
        comparisonBeforeImage: null,
        inpaintMask: null,
        maskRevision: get().maskRevision + 1,
        statusText: storeFormat(get().settings, "status.imageLoaded", { width: result.image.width, height: result.image.height }),
        toast: storeFormat(get().settings, "toast.imageLoaded", { width: result.image.width, height: result.image.height }),
      });
      if (restoreMetadata) {
        get().restoreImportedMetadata(
          restoreMetadata.imported,
          restoreMetadata.characterCaptions,
          { preserveMissing: true },
        );
        const seed = restoreMetadata.imported.seed ?? 0;
        set({
          toast: seed > 0
            ? storeFormat(get().settings, "toast.paramsLoadedSeed", { seed })
            : storeText(get().settings, "toast.paramsLoaded"),
        });
      }
    } else if (result.message) {
      set({ toast: compactStoreError(get().settings, hostErrorText(result, get().settings?.language)), statusText: storeText(get().settings, "status.imageLoadFailed") });
    }
  },

  async clearWorkbenchImage() {
    const loadRevision = ++workbenchLoadRevision;
    await window.naiDesktop.clearWorkbenchImage();
    if (loadRevision !== workbenchLoadRevision) return;
    set({
      workbenchImage: null,
      i2iOriginalImage: null,
      comparisonBeforeImage: null,
      inpaintMask: null,
      maskRevision: get().maskRevision + 1,
      statusText: storeText(get().settings, "status.workbenchCleared"),
    });
  },

  setI2IParam(key, value) {
    set((state) => ({ i2iParams: { ...state.i2iParams, [key]: value } }));
    persistGenerationState(get);
  },

  setI2ISizeMode(mode) {
    set({ i2iSizeMode: mode });
  },

  setI2ISourceMode(mode) {
    set({ i2iSourceMode: mode });
  },

  async setInpaintSourceMode(mode) {
    const state = get();
    const latestResult = state.comparisonBeforeImage ? state.currentImage : null;
    const target = mode === "original"
      ? state.i2iOriginalImage ?? state.workbenchImage
      : latestResult ?? state.workbenchImage;
    if (!target || target.filePath === state.workbenchImage?.filePath) {
      set({ inpaintSourceMode: mode });
      return;
    }
    let result;
    try {
      result = await window.naiDesktop.loadImageFromPath(target.filePath);
    } catch (error: any) {
      const message = compactStoreError(
        state.settings,
        error?.message,
        storeText(state.settings, "status.imageLoadFailed"),
      );
      set({ toast: message, statusText: message });
      return;
    }
    if (!result.ok || !result.image) {
      const message = compactStoreError(
        state.settings,
        result.message ? hostErrorText(result, state.settings?.language) : undefined,
        storeText(state.settings, "status.imageLoadFailed"),
      );
      set({ toast: message, statusText: message });
      return;
    }
    set((current) => ({
      inpaintSourceMode: mode,
      workbenchImage: result.image!,
      inpaintMask: null,
      maskRevision: current.maskRevision + 1,
    }));
  },

  setInpaintModel(model) {
    const baseModel = baseModelForInpaint(model);
    set((state) => ({
      inpaintModel: model,
      inpaintRecipe: state.inpaintRecipe
        ? normalizeGenerateParams({ ...state.inpaintRecipe, model: baseModel })
        : null,
    }));
    persistGenerationState(get);
  },

  setInpaintStrength(value) {
    set({ inpaintStrength: Math.max(0, Math.min(1, value)) });
    persistGenerationState(get);
  },

  setInpaintNoise(value) {
    set({ inpaintNoise: Math.max(0, Math.min(0.99, value)) });
    persistGenerationState(get);
  },

  setInpaintPositivePrompt(value) {
    set({ inpaintPositivePrompt: value });
    persistGenerationState(get);
  },

  setInpaintRecipe(patch) {
    if (patch !== null) assertPromptAssemblyVersion(patch);
    set((state) => ({
      inpaintRecipe: patch === null ? null : normalizeGenerateParams(structuredClone({
        ...(state.inpaintRecipe ?? { ...state.params, positivePrompt: state.inpaintPositivePrompt }),
        ...patch,
        model: baseModelForInpaint(state.inpaintModel),
      })),
    }));
    persistGenerationState(get);
  },

  setInpaintRecipeParam(key, value) {
    // A late UI callback after disabling the recipe must not recreate it or edit base state.
    if (key === "promptAssemblyVersion") assertPromptAssemblyVersion({ promptAssemblyVersion: value });
    // The model is controlled only through setInpaintModel, including during reset.
    if (!get().inpaintRecipe || key === "model") return;
    set((state) => {
      if (!state.inpaintRecipe) return state;
      const next = { ...state.inpaintRecipe, [key]: value } as GenerateParams;
      if (key === "qualityPreset") next.qualityToggle = value !== "none";
      else if (key === "qualityToggle") next.qualityPreset = value
        ? state.inpaintRecipe.qualityPreset === "none" ? "standard" : state.inpaintRecipe.qualityPreset
        : "none";
      return { inpaintRecipe: normalizeGenerateParams(next) };
    });
    persistGenerationState(get);
  },

  setBrushSize(size) {
    set((state) => ({
      brushSize: normalizeInpaintBrushSize(size, state.brushShape),
    }));
    persistGenerationState(get);
  },

  setBrushOpacity(opacity) {
    set({ brushOpacity: Math.max(0.05, Math.min(1, opacity)) });
    persistGenerationState(get);
  },

  setBrushColor(color) {
    set((state) => ({ brushColor: normalizedBrushColor(color, state.brushColor) }));
    persistGenerationState(get);
  },

  setBrushMode(mode) {
    set({ brushMode: mode });
  },

  setBrushShape(shape) {
    set((state) => ({
      brushShape: shape,
      brushSize: normalizeInpaintBrushSize(state.brushSize, shape),
    }));
    persistGenerationState(get);
  },

  setInpaintMask(mask) {
    set({ inpaintMask: mask });
  },

  clearInpaintMask() {
    set({ inpaintMask: null, maskRevision: get().maskRevision + 1 });
  },

  setUpscaleScale(scale) {
    set({ upscaleScale: scale });
    persistGenerationState(get);
  },

  setDirectorTool(tool) {
    set({ directorTool: tool });
    persistGenerationState(get);
  },

  setAugmentOption(key, value) {
    set((state) => ({ augmentOptions: { ...state.augmentOptions, [key]: value } }));
    persistGenerationState(get);
  },

  // ── Vibe Transfer / Precise Reference ──────────────────────────────────────
  addVibeImage(image) {
    set((state) => ({ vibeImages: [...state.vibeImages, image] }));
  },

  removeVibeImage(id) {
    set((state) => ({ vibeImages: state.vibeImages.filter((v) => v.id !== id) }));
  },

  updateVibeImage(id, patch) {
    set((state) => ({
      vibeImages: state.vibeImages.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    }));
  },

  clearVibeImages() {
    set({ vibeImages: [] });
  },

  addPreciseReference(image) {
    set((state) => ({ preciseReferences: [...state.preciseReferences, image] }));
  },

  removePreciseReference(id) {
    set((state) => ({ preciseReferences: state.preciseReferences.filter((v) => v.id !== id) }));
  },

  updatePreciseReference(id, patch) {
    set((state) => ({
      preciseReferences: state.preciseReferences.map((v) => (v.id === id ? { ...v, ...patch } : v)),
    }));
  },

  clearPreciseReferences() {
    set({ preciseReferences: [] });
  },

  // ── Character Prompt ───────────────────────────────────────────────────────
  addCharCaption() {
    if (get().charCaptions.length >= maxNAICharacterPrompts(get().params.model)) return;
    const id = crypto.randomUUID();
    set((state) => ({
      charCaptions: [
        ...state.charCaptions,
        {
          id,
          prompt: "",
          negativePrompt: "",
          useCoords: state.charCaptions.some((caption) => caption.useCoords),
          x: 0.5,
          y: 0.5,
        },
      ],
    }));
    persistGenerationState(get);
  },

  removeCharCaption(id) {
    set((state) => ({ charCaptions: state.charCaptions.filter((c) => c.id !== id) }));
    persistGenerationState(get);
  },

  updateCharCaption(id, patch) {
    set((state) => ({
      charCaptions: state.charCaptions.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
    persistGenerationState(get);
  },

  clearCharCaptions() {
    set({ charCaptions: [] });
    persistGenerationState(get);
  },

  // ── Batch ──────────────────────────────────────────────────────────────────
  setBatchCount(count) {
    set({ batchCount: Math.max(1, Math.min(999, count)) });
    persistGenerationState(get);
  },

  setBatchIntervalSeconds(seconds) {
    set({ batchIntervalSeconds: normalizeBatchIntervalSeconds(seconds) });
    persistGenerationState(get);
  },

  setToast(message) {
    // Callers pass caught error messages; their invisible structure suffix (host-errors/bridge.ts) is not kept.
    set({ toast: typeof message === "string" ? stripHostErrorSuffixes(message) : message, toastKey: "" });
  },

  clearImageComparison() {
    set({ comparisonBeforeImage: null, comparisonSurface: null });
  },

  // ── Generation ─────────────────────────────────────────────────────────────
  // Every click freezes its inputs into a manual batch of the shared queue (queueManualClick); the button stays
  // available while it waits or runs, so a further click queues another batch behind it.
  async generate() {
    const state = get();
    if (!requireToken(set, state.account.hasToken, state.settings)) return;
    if (!state.params.positivePrompt.trim()) {
      set({ toast: storeText(state.settings, "toast.needPrompt"), statusText: storeText(state.settings, "status.missingPrompt") });
      return;
    }
    const count = Math.max(1, state.batchCount);
    const intervalSeconds = count > 1 ? normalizeBatchIntervalSeconds(state.batchIntervalSeconds) : 0;
    const params = { ...state.params };
    const extras = buildExtras(state);
    // A history image selected just before Generate may still be decoding and carrying embedded parameters.
    // Invalidate that stale load before this click's parameters are frozen.
    workbenchLoadRevision += 1;
    await queueManualClick(set, get, {
      quote: (account) => ({ feature: "generate", params, extras, batchCount: count, account }),
      actionLabel: count > 1 ? storeFormat(state.settings, "action.batchGenerate", { count }) : storeText(state.settings, "action.generateImage"),
      request: { mode: "t2i", count, intervalSeconds, params, extras },
      options: {},
    });
  },

  async generateI2I() {
    const state = get();
    if (!requireToken(set, state.account.hasToken, state.settings)) return;
    if (!state.workbenchImage) {
      set({ toast: storeText(state.settings, "toast.needReference"), statusText: storeText(state.settings, "status.needImage") });
      return;
    }
    if (!state.params.positivePrompt.trim()) {
      set({ toast: storeText(state.settings, "toast.needPrompt"), statusText: storeText(state.settings, "status.missingPrompt") });
      return;
    }
    const count = Math.max(1, state.batchCount);
    const intervalSeconds = count > 1 ? normalizeBatchIntervalSeconds(state.batchIntervalSeconds) : 0;
    const sourceImage = state.i2iSourceMode === "original"
      ? state.i2iOriginalImage ?? state.workbenchImage
      : state.workbenchImage;
    const extras = buildExtras(state);
    const i2i = { ...state.i2iParams };
    const outputSize = state.i2iSizeMode === "adaptive"
      ? adaptiveNAIImageSize(sourceImage.width, sourceImage.height, state.params)
      : { width: state.params.width, height: state.params.height };
    const params: GenerateParams = { ...state.params, ...outputSize };
    workbenchLoadRevision += 1;
    // Every image of this click starts from the image of the click (its source is frozen with it).
    await queueManualClick(set, get, {
      quote: (account) => ({ feature: "i2i", params, extras, batchCount: count, i2iParams: i2i, account }),
      actionLabel: count > 1 ? storeFormat(state.settings, "action.batchGenerate", { count }) : storeText(state.settings, "action.i2i"),
      request: { mode: "i2i", count, intervalSeconds, params, extras, i2i },
      options: { compareBefore: sourceImage, comparisonSurface: state.activeCanvasSurface, loadWorkbench: state.i2iSourceMode === "latest" },
      sourcePath: sourceImage.filePath,
    });
  },

  async inpaint() {
    const state = get();
    if (!requireToken(set, state.account.hasToken, state.settings)) return;
    if (state.inpaintRecipe && (state.vibeImages.length || state.preciseReferences.length || state.settings?.modelMode === "furry")) {
      const message = storeText(state.settings, "inpaint.recipeUnsupported");
      set({ toast: message, statusText: message });
      return;
    }
    if (state.inpaintRecipe && state.inpaintRecipe.model !== baseModelForInpaint(state.inpaintModel)) {
      const message = storeText(state.settings, "inpaint.recipeModelMismatch");
      set({ toast: message, statusText: message });
      return;
    }
    if (!state.workbenchImage) {
      set({ toast: storeText(state.settings, "toast.needOriginal"), statusText: storeText(state.settings, "status.needOriginal") });
      return;
    }
    if (!state.inpaintMask) {
      set({ toast: storeText(state.settings, "toast.needMask"), statusText: storeText(state.settings, "status.needMask") });
      return;
    }
    // The host freezes the chosen source of this click (read at the click, the image the canvas compares with).
    const sourceImage = state.inpaintSourceMode === "original"
      ? state.i2iOriginalImage ?? state.workbenchImage
      : state.workbenchImage;
    // Independent mode uses its own full recipe; legacy mode only overrides positive text. Output dimensions are
    // always locked to the source; the host may pad a non-64-multiple source and crops it back before saving.
    const params: GenerateParams = {
      ...(state.inpaintRecipe ?? { ...state.params, positivePrompt: state.inpaintPositivePrompt }),
      width: sourceImage.width,
      height: sourceImage.height,
    };
    const mask = state.inpaintMask;
    workbenchLoadRevision += 1;
    await queueManualClick(set, get, {
      quote: (account) => ({ feature: "inpaint", params, inpaintModel: state.inpaintModel, inpaintStrength: state.inpaintStrength, inpaintNoise: 0, maskBase64: mask, image: { width: sourceImage.width, height: sourceImage.height }, account }),
      actionLabel: storeText(state.settings, "action.inpaint"),
      request: { mode: "inpaint", count: 1, intervalSeconds: 0, params, extras: { vibeImages: [], preciseReferences: [], charCaptions: [], historyGroupId: state.generationGroupId }, inpaint: { model: state.inpaintModel, strength: state.inpaintStrength, maskBase64: mask } },
      options: { compareBefore: sourceImage, comparisonSurface: "inpaint", loadWorkbench: state.inpaintSourceMode === "latest" },
      sourcePath: sourceImage.filePath,
    });
  },

  async upscaleCurrentImage() {
    const state = get();
    if (!requireToken(set, state.account.hasToken, state.settings)) return;
    if (!state.workbenchImage) {
      set({ toast: storeText(state.settings, "toast.needLoadedImage"), statusText: storeText(state.settings, "status.needImage") });
      return;
    }
    const source = state.workbenchImage;
    workbenchLoadRevision += 1;
    await queueManualClick(set, get, {
      quote: (account) => ({ feature: "upscale", upscaleScale: state.upscaleScale, image: { width: source.width, height: source.height }, account }),
      actionLabel: storeFormat(state.settings, "action.upscale", { scale: state.upscaleScale }),
      request: { mode: "upscale", count: 1, intervalSeconds: 0, params: { ...state.params }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [], historyGroupId: state.generationGroupId }, upscale: { scale: state.upscaleScale } },
      options: { compareBefore: source, comparisonSurface: "postprocess:upscale" },
      sourcePath: source.filePath,
    });
  },

  async runDirectorTool() {
    const state = get();
    if (!requireToken(set, state.account.hasToken, state.settings)) return;
    if (!state.workbenchImage) {
      set({ toast: storeText(state.settings, "toast.needLoadedImage"), statusText: storeText(state.settings, "status.needImage") });
      return;
    }
    const source = state.workbenchImage;
    workbenchLoadRevision += 1;
    await queueManualClick(set, get, {
      quote: (account) => ({ feature: "director", directorTool: state.directorTool, image: { width: source.width, height: source.height }, account }),
      actionLabel: storeText(state.settings, "action.postprocess"),
      request: { mode: "director", count: 1, intervalSeconds: 0, params: { ...state.params }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [], historyGroupId: state.generationGroupId }, director: { tool: state.directorTool, options: { ...state.augmentOptions } } },
      options: { compareBefore: source, comparisonSurface: "postprocess:director" },
      sourcePath: source.filePath,
    });
  },

  async cancel() {
    // Stop = cancel this window's current manual batch in the queue. The running image's request is aborted locally:
    // if it was already sent it may have been charged, and no image of it is saved.
    await controlManualBatch(set, get, "cancel");
  },

  async togglePause() {
    const current = currentManualBatch(get());
    if (!current) return;
    await controlManualBatch(set, get, current.status === "paused" ? "resume" : "pause");
  },

  selectImage(item) {
    set(state => ({ currentImage: item, comparisonBeforeImage: null, activeTab: "generate", activeCanvasSurface: `generate:${state.generateMode}`, statusText: storeFormat(state.settings, "status.historySelected", { date: item.date }) }));
    // A history thumbnail is always a preview-only action. Embedded PNG
    // metadata must never replace the user's current prompt or generation
    // parameters implicitly; explicit parameter/variation actions own that job.
    // In particular, do not load the workbench: it owns actual generation
    // source bytes and Mask. Selecting that source is a separate explicit action.
  },

  variationFromImage(item) {
    // Load this image's exact params and LOCK its seed, then jump to generate so
    // the user can tweak one tag and reroll a variation on the same seed.
    const seed = item.actualSeed ?? item.params?.seed ?? 0;
    try {
      if (historyRecoveryIsBusy(get())) throw historyApplyRefusal("hp.generating");
      assertPromptAssemblyVersion(item.params);
      const mode = item.generationOrigin?.mode ?? item.feature;
      if (item.generationOrigin?.actualSeed === null || mode === 'upscale' || mode === 'director' || /^(upscale|director)(-|$)/i.test(item.model)) {
        throw historyApplyRefusal("hp.postprocess");
      }
      const params = normalizeInheritedGenerateParams({ ...item.params, seed, seedMode: 'fixed' }, get().params);
      const captions = Object.hasOwn(item, "characterSnapshot") ? readCharacterSnapshot(item.characterSnapshot).captions : undefined;
      if (captions && captions.length > maxNAICharacterPrompts(params.model)) throw historyApplyRefusal("hp.tooManyChars");
      // This immediate action has no asynchronous confirmation; preflight both
      // inputs before the single recipe transaction, just like dialog recovery.
      set((state) => ({
        params,
        ...(captions ? { charCaptions: captions.map(caption => ({ ...caption, id: crypto.randomUUID() })) } : {}),
        activeTab: "generate",
        currentImage: item,
        comparisonBeforeImage: null,
        toast: seed > 0
          ? storeFormat(state.settings, "toast.paramsLoadedSeed", { seed })
          : storeText(state.settings, "toast.paramsLoaded"),
      }));
      persistGenerationState(get);
    } catch (error) {
      const message = storeFormat(get().settings, "history.paramsInvalid", { detail: storedStateErrorText(get().settings, error) });
      set({ toast: message, statusText: message });
    }
  },

  async deleteHistory(id) {
    const previousHistory = get().history;
    const removedIndex = previousHistory.findIndex((item) => item.id === id);
    const removedItem = removedIndex >= 0 ? previousHistory[removedIndex] : undefined;
    const previousCurrent = get().currentImage;
    const previousComparison = get().comparisonBeforeImage;
    const nextHistory = previousHistory.filter((item) => item.id !== id);
    const deletingCurrent = previousCurrent?.id === id;
    if (deletingCurrent) workbenchLoadRevision += 1;
    set({
      history: nextHistory,
      // Do not swap an arbitrary old thumbnail into the canvas underneath an
      // active generating overlay. It looked like the running request had
      // changed to the deleted record. The successful result will become the
      // current image naturally; a failed run leaves an honest empty canvas.
      currentImage: deletingCurrent
        ? get().isGenerating
          ? null
          : nextHistory[0] ?? null
        : previousCurrent,
      comparisonBeforeImage: deletingCurrent ? null : get().comparisonBeforeImage,
    });
    try {
      const result = await window.naiDesktop.deleteHistory(id);
      // The host's reason (step 4a), in the interface language; the record was kept or the outcome is uncertain.
      if (!result?.ok) throw new Error(hostErrorText(result, get().settings?.language, "Delete failed"));
      return true;
    } catch (error: any) {
      // Reinsert only this item. Restoring the complete previous array here
      // races with a second concurrent deletion and can resurrect images that
      // were successfully removed after this request started.
      set((state) => {
        const history = !removedItem || state.history.some((item) => item.id === id)
          ? state.history
          : [
              ...state.history.slice(0, Math.min(removedIndex, state.history.length)),
              removedItem,
              ...state.history.slice(Math.min(removedIndex, state.history.length)),
            ];
        return {
          history,
          currentImage: previousCurrent?.id === id ? previousCurrent : state.currentImage,
          comparisonBeforeImage: previousCurrent?.id === id ? previousComparison : state.comparisonBeforeImage,
          toast: compactStoreError(state.settings, error),
        };
      });
      return false;
    }
  },

  async renameHistoryItem(id, name) {
    const res = await window.naiDesktop.renameHistoryItem(id, name);
    if (!res.ok) {
      set({ toast: hostErrorText(res, get().settings?.language, storeText(get().settings, "toast.renameFailed")) });
      return;
    }
    await get().refreshHistory();
    const current = get().currentImage;
    if (current?.id === id && res.item) set({ currentImage: res.item });
    set({ toast: storeText(get().settings, "toast.renamed") });
  },

  clearToast() {
    set({ toast: "", toastKey: "" });
  },
}));
