import { startWorkspaceBridge } from "./bridge-host";
import { BridgeError, type BridgeCaller } from "./bridge-server";
import { agentActor as agentOf, createAgentActivity, type AgentActivityRecorder } from "./agent-activity";
import { hostErrorFields, withReason } from "./host-error";
import { queueBridgeError } from "./queue-bridge-error";
import { createDanbooruService } from "./danbooru-service";
import { createTagDictionary } from "./search-tag-dictionary";
import { createGenerationService, GenerationError } from "./generation-service";
import { initializeAssetLibrary } from './library-startup';
import { activeLibrary, activateLibraryTrash, activeLibraryTrash } from './library-runtime';
import { createLibraryTrash, type RecipeReferenceScan } from './library-trash';
import { libraryChangeNotice } from './library/repository';
import { createAssetLibraryService } from './asset-library-service';
import { createHistoryImageReader } from './asset-library-image';
import { createAssetImageExporter } from './asset-image-export';
import { handleAssetImageExport } from './asset-image-export-ipc';
import { createBatchService } from "./batch-service";
import { createQueueRecipeService, QUEUE_METHODS, QUEUE_WORKSPACE } from "./queue-recipe-service";
import { batchFactsOf, type BatchFacts } from "../src/library/image-facts";
import { createCanvasRecipeCapture } from "./canvas-recipe-capture";
import { createMaterialLibraryService } from "./material-library";
import { createImageStudyService } from "./image-studies";
import { buildPromptReview } from "./prompt-review";
import { hasActiveGenerationJobs, reserveQueueGeneration } from "./ipc/job-registry";
import { createManualGeneration, createManualSourceStore } from "./manual-generation";
import { createQueueUiHandler, queueBatchEvent, withoutWindowOnlyFields } from "./queue-ui";
import { registerWorkbenchSync } from "./workbench-sync";
import { readClipboardImageFiles, savePastedImageFiles } from "./ipc/image-clipboard";
import {
  app,
  dialog,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
} from "electron";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { DATA_DIR_ENV, projectDirectories, resolveDataPaths } from "../shared/runtime/data-paths.cjs";
import { dataRootFailureDialog, prepareDataRoot, startupFailureDialog, type StartupStep } from "./startup-failure";
import { buildMcpAccess, temporaryExecutableLocation } from "./mcp-access";
import { mainWindowSize, uiCaptureLoadOptions, uiCaptureRefusal } from "./ui-capture-guard";
import {
  installLocalMediaProtocol,
  localMediaUrlToPath,
  toLocalMediaUrl,
  registerLocalMediaScheme,
} from "./ipc/local-media-protocol";
import {
  augmentImg,
  clearWorkbenchImage,
  generateI2I,
  generateImage,
  inpaintImage,
  loadImageFile,
  loadImageFromPath,
  quoteAnlasCost,
  refreshStoredAccount,
  suggestTags,
  upscaleImg,
  verifyToken,
} from "./ipc/nai";

registerLocalMediaScheme();
import {
  loadMetadataSnapshotFile,
  readMetadataSnapshotFromPath,
  saveMetadataSnapshotFile,
  saveMetadataSnapshotFromPath,
} from "./ipc/metadata-snapshot";
import {
  createReferencePresetGroup,
  deleteReferencePresetGroup,
  deleteReferencePreset,
  exportReferencePresets,
  importReferencePresets,
  prepareReferenceImport,
  commitReferenceImport,
  listReferencePresets,
  moveReferencePresetToGroup,
  readReferencePreset,
  saveReferencePreset,
} from "./ipc/reference-presets";
import { hostText, setInterfaceLanguageSource } from "./host-language";
import { hideWhenActivated, prepareBackgroundApp, revealOnSecondInstance, showMainWindow } from "./window-show";
import {
  copyStylePromptPreviewImages,
  importStylePromptPresetImages,
  reconcileStylePromptPreviewImages,
} from "./ipc/style-preset-images";
import {
  exportDataBackup,
  getDataBackupStatus,
  importDataBackup,
  inspectDataBackup,
  openBackupDirectory,
  runAutomaticBackup,
  selectBackupDirectory,
  setQueueCleanedRecordsBackup,
} from "./ipc/data-backup";
import type {
  AnlasQuoteRequest,
  DataBackupExportRequest,
  DataBackupImportRequest,
  GenerationPreviewEvent,
  MetadataSnapshotPayload,
  StylePromptPreviewImage,
} from "../src/types";
import { APP_NAME } from "../src/types";
import {
  clearToken,
  completeSetup,
  getAccountSummary,
  getSetting,
  getSettings,
  getToken,
  setSetting,
  ensureHistoryGroup,
  getHistoryGroups,
} from "./ipc/store";
import { resolveQueueHistoryGroup } from "./queue-output";
import {
  assignHistoryGroup,
  createGroup,
  deleteHistoryItem,
  exportGroup,
  listHistory,
  listHistoryItems,
  listHistoryDates,
  listHistoryGroups,
  openTarget,
  removeGroup,
  renameGroup,
  renameHistoryItem,
  selectOutputDir,
} from "./ipc/storage";
import { createUpdateChecker, shouldScheduleAutomaticChecks } from "./ipc/update";
import { readLegalDocument, type LegalDocumentKind } from "./legal-documents";
import {
  configureSystemProxyResolver,
  refreshSystemProxy,
} from "./ipc/proxy";
import {
  installGlobalLogging,
  getLogInfo,
  selectLogDir,
  openLogFile,
  openLogDir,
  readRecentLog,
} from "./ipc/logger";

// UI capture (development tool): NAI_UI_CAPTURE_PATH names the screenshot. It runs only on an
// isolated data folder (NOVELAI_DATA_DIR); without one it stops here, before any data folder is
// created or touched (a synchronous write to stderr, then exit code 2).
const uiCaptureRefused = uiCaptureRefusal(process.env);
if (uiCaptureRefused) {
  fs.writeSync(2, uiCaptureRefused);
  process.exit(2);
}
const uiCapturePath = process.env.NAI_UI_CAPTURE_PATH?.trim();
const normalizedUiCapturePath = uiCapturePath?.replaceAll("\\", "/").toLowerCase() ?? "";
// One data root for every run: NOVELAI_DATA_DIR, or <appData>/mcp-for-novelai
// (shared/runtime/data-paths.cjs, which the MCP server uses to find runtime/bridge.json).
// It is Electron's userData; the library, runtime, backups and logs live inside it.
const dataPaths = resolveDataPaths();
app.setName(APP_NAME);
// A data root that cannot be created or written stops the start here with a clear dialog (before anything reads it).
const dataRootFailure = prepareDataRoot(dataPaths);
if (dataRootFailure) {
  const failure = dataRootFailureDialog(dataPaths.root, dataRootFailure, Boolean(process.env[DATA_DIR_ENV]?.trim()));
  dialog.showErrorBox(failure.title, failure.message);
  process.exit(1);
}
app.setPath("userData", dataPaths.root);
// Launching the app while it's already running should focus the existing
// window, not spawn a second process fighting over the same userData store.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let workspaceBridge: Awaited<ReturnType<typeof startWorkspaceBridge>> | undefined;
let queueMethods: Record<string, (args: Record<string, unknown>, caller?: BridgeCaller) => Promise<any>> = {};
// Recent agent calls (client, tool, time; never arguments): <data root>/runtime/agent-activity.json.
let agentActivity: AgentActivityRecorder | undefined;

let disposeBatch: (() => void) | undefined;
// Recently Deleted lists the recipes that use a deleted image as their source; the recipe store exists only after registerIpc.
let recipeReferenceScan: RecipeReferenceScan | undefined;
/** Queue retention: runs a cleaning now (Settings › Queue changed the period). */
let runQueueRetention: (() => void) | undefined;
// The queue's batches for the library window's mode and source filters (set once the batch service exists).
let libraryBatchFacts: (() => BatchFacts) | undefined;
// New-version notice (ipc/update.ts): checks this project's latest GitHub release and only announces it; the
// renderer shows the banner and opens the release page. Automatic checks run only in a packaged app (not from
// source, in test clients or UI capture); "Check now" always works.
const updateChecker = createUpdateChecker({
  currentVersion: app.getVersion(),
  readSettings: () => getSettings(),
  publish: (info) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("app:updateEvent", info);
  },
});

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

// A background test client on macOS runs as an accessory app from before ready, so its launch never activates it
// (window-show.ts); every other start is unchanged.
prepareBackgroundApp(app);
// Should it become active anyway, it hides at once and logs it (window-show.ts).
hideWhenActivated(app);
// A second launch brings the running window to the front, except for a background test client (window-show.ts).
app.on("second-instance", () => revealOnSecondInstance(mainWindow));

/**
 * Right-click context menu for text fields: 剪切 / 复制 / 粘贴 / 全选. Electron
 * ships no default editing menu, so we build one per right-click based on what's
 * available (editable field, current selection, clipboard text).
 */
function attachEditContextMenu(win: BrowserWindow) {
  win.webContents.on("context-menu", (_event, params) => {
    const { isEditable, editFlags } = params;
    const hasSelection = params.selectionText.trim().length > 0;
    if (!isEditable && !hasSelection) return;
    const template: Electron.MenuItemConstructorOptions[] = [];
    if (isEditable) {
      template.push({ label: hostText("menu.cut"), role: "cut", enabled: editFlags.canCut });
    }
    template.push({ label: hostText("menu.copy"), role: "copy", enabled: editFlags.canCopy });
    if (isEditable) {
      template.push({
        label: hostText("menu.paste"),
        role: "paste",
        enabled: editFlags.canPaste,
      });
    }
    template.push({ type: "separator" }, { label: hostText("menu.selectAll"), role: "selectAll" });
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function createWindow() {
  const iconPath = isDev
    ? path.join(__dirname, "../../public/icon.png")
    : path.join(__dirname, "../../dist/icon.png");

  mainWindow = new BrowserWindow({
    ...mainWindowSize(uiCapturePath),
    minWidth: 1120,
    minHeight: 720,
    show: false,
    frame: false,
    // Dark only (step 4b1): the window background matches the interface, so a start never flashes a light frame.
    backgroundColor: "#0b0a10",
    title: APP_NAME,
    icon: iconPath,
    webPreferences: {
      // Capture mode has no visible window: keep rAF/virtualized lists painting.
      // Otherwise screenshots can falsely show an empty conversation mid-transition.
      offscreen: Boolean(uiCapturePath),
      backgroundThrottling: !uiCapturePath,
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Disable the native spellchecker so prompts (English Danbooru tags)
      // don't get red squiggly underlines.
      spellcheck: false,
    },
  });

  attachEditContextMenu(mainWindow);

  // Defense in depth: the app never needs to navigate this window away from
  // its own bundled UI, or open a second BrowserWindow. External links
  // already go through the dedicated window:openExternal IPC channel (which
  // validates http/https itself) — closing these off means a future XSS or
  // malicious-content bug can't escalate into loading an arbitrary remote
  // page inside the app (with its Electron API surface) or spawning one.
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const current = mainWindow?.webContents.getURL();
    if (current && targetUrl !== current) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // Windows only: the session is ending (log-off / shut-down) and before-quit may not run.
  mainWindow.on("session-end", closeBridgeNow);
  mainWindow.once("ready-to-show", () => {
    // A background dev-tools test client appears without taking the focus (window-show.ts); otherwise show() as before.
    if (!uiCapturePath && mainWindow) showMainWindow(mainWindow);
  });

  if (uiCapturePath) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          // An onboarding capture keeps the first-run guide open; every other capture skips it.
          if (!normalizedUiCapturePath.includes("onboarding")) await mainWindow?.webContents.executeJavaScript(`(() => {
            const skip = [...document.querySelectorAll('button')].find((button) =>
              (button.textContent || '').includes('跳过向导'));
            if (skip) skip.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await new Promise((resolve) => setTimeout(resolve, 450));
          if (normalizedUiCapturePath.includes("/dark/")) {
            await mainWindow?.webContents.executeJavaScript(
              "document.documentElement.classList.add('theme-dark')",
            );
          }
          if (normalizedUiCapturePath.includes("settings-") && normalizedUiCapturePath.includes("-bottom")) {
            const scrollSettingsBottom = () => mainWindow?.webContents.executeJavaScript(`new Promise((resolve) => {
              const startedAt = Date.now();
              const scrollSettings = () => {
                const content = document.querySelector('.settings-content');
                if (content) {
                  const target = content.querySelector('.settings-form')?.lastElementChild;
                  target?.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
                  content.scrollTop = content.scrollHeight;
                  content.getBoundingClientRect();
                  resolve(true);
                  return;
                }
                if (Date.now() - startedAt > 2500) {
                  resolve(false);
                  return;
                }
                setTimeout(scrollSettings, 80);
              };
              scrollSettings();
            })`);
            await scrollSettingsBottom();
            await new Promise((resolve) => setTimeout(resolve, 450));
            await scrollSettingsBottom();
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          const audit = await mainWindow?.webContents.executeJavaScript(`(() => {
            const visible = (element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
            };
            const describe = (element) => ({
              tag: element.tagName.toLowerCase(),
              className: String(element.className || '').slice(0, 180),
              text: String(element.getAttribute('aria-label') || element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
            });
            const hasHorizontalScroller = (element) => {
              let parent = element.parentElement;
              while (parent) {
                if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX)) return true;
                parent = parent.parentElement;
              }
              return false;
            };
            const viewportOverflow = [...document.querySelectorAll('button, input, select, textarea, [role="button"]')]
              .filter(visible)
              .filter((element) => {
                const rect = element.getBoundingClientRect();
                if (rect.bottom <= 0 || rect.top >= innerHeight) return false;
                return !hasHorizontalScroller(element) && (rect.left < -1 || rect.right > innerWidth + 1);
              })
              .map(describe);
            const contentOverflow = [...document.querySelectorAll('button, label, .btn, .menu-action, .tab-bar button')]
              .filter(visible)
              .filter((element) => {
                const style = getComputedStyle(element);
                return element.scrollWidth > element.clientWidth + 2 && !['auto', 'scroll'].includes(style.overflowX);
              })
              .map(describe);
            const iconOverflow = [...document.querySelectorAll('.ui-icon')]
              .filter(visible)
              .flatMap((icon) => {
                const container = icon.closest('.btn-icon, .tab-icon, button');
                if (!container || !visible(container)) return [];
                const ir = icon.getBoundingClientRect();
                const cr = container.getBoundingClientRect();
                return ir.left < cr.left - 1 || ir.right > cr.right + 1 || ir.top < cr.top - 1 || ir.bottom > cr.bottom + 1
                  ? [{ icon: describe(icon), container: describe(container) }]
                  : [];
              });
            const iconMisalignment = [...document.querySelectorAll('button .ui-icon, .btn .ui-icon')]
              .filter(visible)
              .flatMap((icon) => {
                const container = icon.closest('button, .btn');
                if (!container || !visible(container) || !(container.textContent || '').trim()) return [];
                // Large empty-state/drop-zone buttons deliberately stack an
                // icon above multiple text rows; they are not inline controls.
                if (container.getBoundingClientRect().height > 58) return [];
                const ir = icon.getBoundingClientRect();
                const cr = container.getBoundingClientRect();
                const deltaY = Math.abs((ir.top + ir.height / 2) - (cr.top + cr.height / 2));
                return deltaY > 2.5 ? [{ icon: describe(icon), container: describe(container), deltaY: Number(deltaY.toFixed(2)) }] : [];
              });
            const textMisalignment = [...document.querySelectorAll('button, .btn')]
              .filter(visible)
              .flatMap((element) => {
                if (element.getBoundingClientRect().height > 58) return [];
                const style = getComputedStyle(element);
                // Inspector destinations deliberately stack icon and label.
                // Their text is not expected to share the button's vertical
                // midpoint like an inline action.
                if (style.display === 'grid' || style.flexDirection === 'column') return [];
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
                const rects = [];
                let node;
                while ((node = walker.nextNode())) {
                  if (!node.textContent?.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const rect = range.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) rects.push(rect);
                }
                if (!rects.length) return [];
                const top = Math.min(...rects.map((rect) => rect.top));
                const bottom = Math.max(...rects.map((rect) => rect.bottom));
                const cr = element.getBoundingClientRect();
                const deltaY = Math.abs((top + bottom) / 2 - (cr.top + cr.height / 2));
                return deltaY > 3 ? [{ element: describe(element), deltaY: Number(deltaY.toFixed(2)) }] : [];
              });
            const openSelectMenus = [...document.querySelectorAll('.select-menu-popover')]
              .filter(visible)
              .map((element) => ({ ...describe(element), optionCount: element.querySelectorAll('[role="option"]').length }));
            const settingsScroll = [...document.querySelectorAll('.settings-content')]
              .map((element) => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
            return { viewport: { width: innerWidth, height: innerHeight }, viewportOverflow, contentOverflow, iconOverflow, iconMisalignment, textMisalignment, openSelectMenus, settingsScroll };
          })()`);
          const image = await mainWindow?.webContents.capturePage();
          if (image) {
            const target = path.resolve(uiCapturePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, image.toPNG());
            fs.writeFileSync(`${target}.audit.json`, JSON.stringify(audit, null, 2));
          }
        } finally {
          app.quit();
        }
      }, 5000);
    });
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    const captureTheme = normalizedUiCapturePath.includes("/dark/")
      ? "dark"
      : "light";
    const captureTab = [
      ["01-generate", "generate"],
      ["02-inpaint", "inpaint"],
      ["03-upscale", "upscale"],
      ["04-postprocess", "postprocess"],
      ["07-metadata", "metadata"],
      ["08-tools", "tools"],
      ["09-reference-presets", "referencePresets"],
    ].find(([needle]) => normalizedUiCapturePath.includes(needle))?.[1];
    const captureSurface = normalizedUiCapturePath.includes("onboarding")
      ? "onboarding"
      : normalizedUiCapturePath.includes("update-banner")
      ? "updateBanner"
      : normalizedUiCapturePath.includes("opus-inline")
      ? "opusInline"
      : normalizedUiCapturePath.includes("opus-usage")
      ? "opusUsage"
      : normalizedUiCapturePath.includes("reference-modal")
      ? "referenceModal"
      : normalizedUiCapturePath.includes("settings")
        ? "settings"
        : captureTab ?? "referencePresets";
    const captureSettingsSection = [
      "api",
      "mcp",
      "storage",
      "prompt",
      "language",
      "appearance",
      "performance",
      "about",
    ].find((section) => normalizedUiCapturePath.includes(`settings-${section}`));
    void mainWindow.loadFile(
      path.join(__dirname, "../../dist/index.html"),
      uiCaptureLoadOptions(uiCapturePath, { uiCapture: captureSurface, uiTheme: captureTheme, uiSettingsSection: captureSettingsSection ?? "", uiPresetPicker: normalizedUiCapturePath.includes("preset-picker") ? "1" : "0", uiPresetCreate: normalizedUiCapturePath.includes("preset-create") ? "1" : "0", uiStylePresetOpen: normalizedUiCapturePath.includes("style-preset-menu") || normalizedUiCapturePath.includes("style-preset-images") ? "1" : "0", uiStylePresetActions: normalizedUiCapturePath.includes("style-preset-actions") ? "1" : "0", uiStylePresetImages: normalizedUiCapturePath.includes("style-preset-images") ? "1" : "0", uiTokenGuide: normalizedUiCapturePath.includes("token-guide") ? "1" : "0", uiLegal: normalizedUiCapturePath.includes("legal-notices") ? "notices" : normalizedUiCapturePath.includes("legal-license") ? "license" : "" }),
    );
  }
}

function registerIpc() {
  // The main process's own texts (context menu, dialog titles) follow the interface language (step 4c1).
  setInterfaceLanguageSource(() => getSettings().language);
  // Registered after initializeAssetLibrary: the library is open.
  const repository = activeLibrary();
  if (!repository) throw new Error("素材库尚未打开。");
  const legacyMaterialHandlers: Record<string, (args: Record<string, unknown>) => Promise<any>> = {};
  const assetService = createAssetLibraryService({ repository,
    toFileUrl: toLocalMediaUrl, trash: activeLibraryTrash(), batchFacts: () => libraryBatchFacts?.() ?? new Map(),
    material: args => legacyMaterialHandlers.material_library(args),
    study: args => legacyMaterialHandlers.material_studies(args),
  });
  const exportImages = createAssetImageExporter({ repository, chooseDestination: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return undefined;
    const selected = await dialog.showSaveDialog(mainWindow, { title: hostText('dialog.exportImages'), defaultPath: 'selected-images.zip', filters: [{ name: hostText('dialog.zipFiles'), extensions: ['zip'] }] });
    return selected.canceled ? undefined : selected.filePath;
  } });
  ipcMain.handle('novelai:assets:export-images', (event, args) => handleAssetImageExport(event, mainWindow, args, exportImages));
  ipcMain.handle('novelai:assets', async (event, args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: { code: 'forbidden_workspace', message: '只接受当前窗口的素材操作。' } };
    try { return { ok: true, result: await assetService.asset_library(args, { deletedBy: { kind: 'user' }, window: true }) }; }
    // The window renders code/reason/params in its language (host-error.ts); the message is the English fallback.
    catch (error: any) { return { ok: false, error: hostErrorFields(error, 'library_failed', 'The library operation did not complete.') }; }
  });
  // Name what each commit changed so the renderer refreshes only affected views; no changedKinds means unknown (refresh everything).
  repository.subscribe((revision, change) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('novelai:library:change', libraryChangeNotice(revision, change)); });
  ipcMain.handle("novelai:prompt-review", async (event, args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: { code: "forbidden_workspace", message: "只接受当前 NovelAI 窗口的生效输入读取。" } };
    try { return { ok: true, result: await buildPromptReview(args) }; }
    catch { return { ok: false, error: { code: "review_failed", message: "配方自检（生效输入）读取失败，请重新读取当前作品。" } }; }
  });
  const generation = createGenerationService({
    isBusy: hasActiveGenerationJobs,
    reserve: reserveQueueGeneration,
    validateImage(bytes) {
      const image = nativeImage.createFromBuffer(bytes);
      if (image.isEmpty()) throw withReason(new GenerationError('invalid_image', 'The image cannot be decoded.'), 'generation.image_undecodable');
      return image.getSize();
    },
    async quote(mode, snapshot) {
      const quote = await quoteAnlasCost({
        feature: mode === 't2i' ? 'generate' : mode === 'enhance' ? 'i2i' : mode, params: snapshot.params, extras: snapshot.extras,
        batchCount: 1, i2iParams: snapshot.i2i, inpaintModel: snapshot.inpaint?.model,
        inpaintStrength: snapshot.inpaint?.strength, inpaintNoise: 0, maskBase64: snapshot.inpaint?.maskBase64,
        image: snapshot.sourceSummary, upscaleScale: snapshot.upscale?.scale, directorTool: snapshot.director?.tool, account: getAccountSummary(),
      });
      return { source: quote.source ?? 'unavailable', amount: quote.ok && Number.isFinite(quote.amount) ? quote.amount! : null };
    },
    async execute(mode, snapshot, execution) {
      if (mode === 't2i') return generateImage(snapshot.params, snapshot.extras, undefined, execution);
      if (mode === 'i2i' || mode === 'enhance') return generateI2I(snapshot.params, snapshot.i2i!, snapshot.extras, execution);
      if (mode === 'upscale') {
        const result = await upscaleImg(snapshot.upscale!.scale, snapshot.params.model, execution);
        return { ...result, items: result.ok && result.item ? [result.item] : [] };
      }
      if (mode === 'director') return augmentImg(snapshot.director!.tool, snapshot.director!.options, execution);
      const inpaint = snapshot.inpaint!;
      return inpaintImage(snapshot.params, inpaint.model, inpaint.maskBase64, inpaint.strength, 0, execution);
    },
    // Job events let the renderer refresh the history items a queue image saved; they never mark the canvas busy.
    onJob(job) { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('novelai:generation:job', job); },
    // A manual batch (this window's Generate) streams its running image to the canvas and hands each saved image to it.
    onPreview(_job, queue, preview) { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send('nai:generationPreview', { ...preview, requestId: queue.batchId } satisfies GenerationPreviewEvent); },
    onManualSettled({ job, queue, items }) {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed() || !['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status)) return;
      mainWindow.webContents.send('novelai:manual:item', { batchId: queue.batchId, requestKey: queue.requestKey, itemIndex: queue.itemIndex, mode: job.mode, status: job.status, items, actualSeed: job.actualSeed, error: job.error });
    },
  });
  const batch = createBatchService({
    generation, isBusy: hasActiveGenerationJobs, runtimeDir: dataPaths.runtime,
    // Queue safety setting "total queue limit" (null = no limit), read at every enqueue.
    pendingItemLimit: () => getSettings().queueMaxPendingItems,
    // A restart matches an image that was in flight with what the library saved for it (history queueOrigin).
    savedResults: (batchId, itemIndex) => repository.list({ kinds: ['history'], queueBatchId: batchId, includeArchived: true, limit: 500 }).items
      .filter(item => (item.payload as any)?.queueOrigin?.itemIndex === itemIndex)
      .map(item => { const payload = item.payload as any; return { id: item.id, width: Number(payload.width), height: Number(payload.height), model: String(payload.model ?? ''), actualSeed: Number.isSafeInteger(payload.actualSeed) ? payload.actualSeed : null, jobId: typeof payload.generationOrigin?.jobId === 'string' ? payload.generationOrigin.jobId : null }; }),
    // The queue panel follows its batches (status, progress); a batch event never touches the canvas.
    onBatch(job) { const event = queueBatchEvent(job); if (event && mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("novelai:queue:batch", event); },
    // Queue retention removed these ended batches: the queue view drops them.
    onRemoved(batchIds) { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("novelai:queue:removed", { batchIds }); },
  });
  disposeBatch = batch.dispose;
  // The batches list_queue shows (queued recipe batches, manual ones of this run included).
  libraryBatchFacts = () => batchFactsOf(batch.list({ workspaceId: QUEUE_WORKSPACE }).batches.filter(job => job.execution === 'queued' && job.originWorkspaceId === QUEUE_WORKSPACE));
  // Manual generation (step 4a): a Generate click of this window is a manual batch of the shared queue. The source of
  // an image mode is read when the click is made (novelai:manual:capture-source, before the balance refresh and the
  // quote) and handed to that click's enqueue, so a source changed meanwhile does not replace it.
  const manualSources = createManualSourceStore();
  const manual = createManualGeneration({ batch, sources: manualSources });
  const fromWindow = (event: Electron.IpcMainInvokeEvent) => Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id && event.senderFrame === mainWindow.webContents.mainFrame);
  const manualFailure = (error: any) => ({ ok: false as const, error: hostErrorFields(error, 'manual_generation_failed', 'The click was not queued.') });
  ipcMain.handle('novelai:manual:enqueue', async (event, request: unknown) => {
    if (!fromWindow(event)) return { ok: false, error: { code: 'forbidden_workspace', message: 'Only this window can generate here.' } };
    try { return { ok: true, result: await manual.enqueue(request) }; } catch (error) { return manualFailure(error); }
  });
  ipcMain.handle('novelai:manual:capture-source', async (event, request: unknown) => {
    if (!fromWindow(event)) return { ok: false, error: { code: 'forbidden_workspace', message: 'Only this window can generate here.' } };
    try { return { ok: true, result: await manualSources.capture(request && typeof request === 'object' ? (request as { filePath?: unknown }).filePath : undefined) }; }
    catch (error) { return { ok: false as const, error: hostErrorFields(error, 'source_missing', 'The image of this click cannot be read.') }; }
  });
  ipcMain.handle('novelai:manual:lookup', async (event, request: unknown) => {
    if (!fromWindow(event)) return { ok: false, error: { code: 'forbidden_workspace', message: 'Only this window can generate here.' } };
    try { return { ok: true, result: manual.lookup(request) }; } catch (error) { return manualFailure(error); }
  });
  const queue = createQueueRecipeService({ runtimeDir: dataPaths.runtime, batch, generation,
    // Queue safety setting "single enqueue at most", read at every new enqueue.
    enqueueItemLimit: () => getSettings().queueMaxItemsPerEnqueue,
    historyById: id => repository.get('history', id)?.payload as unknown as import('../src/types').HistoryItem ?? null,
    // enqueue output.historyGroup: reuse a same-name (case-insensitive) history group or create it,
    // unless a new group would share an existing group's folder.
    resolveHistoryGroup: name => resolveQueueHistoryGroup(name, getHistoryGroups(), ensureHistoryGroup),
    validateImage: data => { const image = nativeImage.createFromBuffer(data); if (image.isEmpty()) throw withReason(new GenerationError('invalid_image', 'The source image cannot be decoded.'), 'generation.image_undecodable'); return image.getSize(); },
    // Recipe sources stored by history reference are reread here; a separate reader keeps its own two-read budget apart from the asset UI.
    readHistoryOriginal: createHistoryImageReader(repository),
    // Queue retention (Settings › Queue, read at every run): after start, daily, and when the setting changes.
    retention: { auto: true, days: () => getSettings().queueRetentionDays, onRun: run => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("novelai:queue:retention", { ...queue.retentionStatus(), lastRun: run }); } },
    // The cleaned records' second anchor lives outside runtime/ (queue-tombstones.ts), so losing that folder is noticed.
    cleanedAnchorDir: path.join(dataPaths.root, "queue-anchor"),
    // A knowing repair of damaged cleaned records recovers every key the library's images name (history queueOrigin).
    libraryQueueOrigins: () => {
      const origins = new Map<string, { requestKey: string; batchId: string; images: number }>();
      // The library active now (a restore from a backup may have replaced it since start).
      for (const item of (activeLibrary() ?? repository).all('history')) {
        const origin = (item.payload as any)?.queueOrigin;
        if (!origin || typeof origin.requestKey !== 'string' || typeof origin.batchId !== 'string') continue;
        const known = origins.get(origin.requestKey); if (known) known.images++; else origins.set(origin.requestKey, { requestKey: origin.requestKey, batchId: origin.batchId, images: 1 });
      }
      return [...origins.values()];
    },
  });
  runQueueRetention = () => { void queue.runRetention().catch(() => undefined); };
  // Every backup carries the cleaned queue records (both anchors too); an import adds a backup's records (ipc/data-backup.ts).
  const pushRetention = () => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("novelai:queue:retention", queue.retentionStatus()); };
  // The window's warnings follow a restore at once (Settings › Queue, the queue page).
  setQueueCleanedRecordsBackup({ files: () => queue.cleanedRecordFiles(), restore: async files => { try { return await queue.restoreCleanedRecords(files); } finally { pushRetention(); } },
    // A library restored from a backup may name keys these records do not know (recovered as cleaned, never resent).
    libraryRestored: async () => { try { return await queue.libraryRestored(); } finally { pushRetention(); } } });
  // Settings › Queue (window only, never a bridge method): the retention status, how many batches a shorter period would
  // clean now, and the knowing repair of damaged cleaned records (its plan first; it runs only with that plan confirmed).
  ipcMain.handle("novelai:queue:retention", async (event, request: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: { code: "forbidden_workspace", message: "Only this window can read the queue retention." } };
    const args = request && typeof request === "object" && !Array.isArray(request) ? request as Record<string, unknown> : {};
    try {
      if (args.action === "preview") return { ok: true, result: queue.retentionPreview(args.days === null ? null : Number(args.days)) };
      if (args.action === "repairPlan") return { ok: true, result: await queue.repairPlan() };
      if (args.action === "repair") {
        const confirm = args.confirm && typeof args.confirm === "object" ? args.confirm as Record<string, unknown> : {};
        const result = await queue.repairCleanedRecords({ lost: typeof confirm.lost === "number" ? confirm.lost : null, recoverable: Number(confirm.recoverable) });
        pushRetention();
        return { ok: true, result };
      }
      await queue.retentionStatusFresh();
      return { ok: true, result: queue.retentionStatus() };
    } catch (error) { return { ok: false, error: hostErrorFields(error, "queue_retention_failed", "The queue retention could not be read.") }; }
  });
  recipeReferenceScan = targets => queue.sourceReferences(targets);
  queueMethods = Object.fromEntries(QUEUE_METHODS.map(method => [method, async (args: Record<string, unknown>, caller?: BridgeCaller) => {
    // An enqueue through the bridge names its agent on the batch (batch source).
    // What is for the window only (an item error's upstream answer) never goes to the bridge (step 4c1).
    try { return withoutWindowOnlyFields(method === 'enqueue_queue_recipes' && caller ? await queue.enqueue_queue_recipes(args, { source: agentOf(caller) }) : await queue[method](args)); }
    // Same code and message rules as before; the queue's own refusals now also keep their plain JSON details.
    catch (error) { throw queueBridgeError(error); }
  }]));
  // prepare_recipe {canvas}: the renderer collects the canvas state (read only), the recipe store freezes it.
  const captureCanvas = createCanvasRecipeCapture({
    collect: args => workspaceBridge ? workspaceBridge.dispatch("collect_canvas_preparation", args) : Promise.reject(new BridgeError("workspace_not_ready", "客户端画布尚未就绪。", 503)),
    put: args => queue.put_canvas_recipe(args),
    preview: args => queue.preview_canvas_recipe(args),
  });
  queueMethods.capture_canvas_recipe = async args => {
    try { return await captureCanvas(args); }
    catch (error) { throw queueBridgeError(error); }
  };
  // The queue panel of this window: list, pause, resume and cancel through the same host queue methods as MCP.
  const queueUi = createQueueUiHandler(queue);
  ipcMain.handle("novelai:queue:call", async (event, method: unknown, args: unknown) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) return { ok: false, error: { code: "forbidden_workspace", message: "只接受当前 NovelAI 窗口的队列操作。" } };
    return queueUi(method, args);
  });
  // Danbooru tag search, single-tag samples and covers of the material library.
  const danbooru = createDanbooruService({ dictionary: createTagDictionary(dataPaths.runtime) });
  const materials = createMaterialLibraryService({
    repository,
    directory: dataPaths.library,
    tags: {
      search: args => danbooru.tags(args),
      // The MCP tag modules (novelai/src/tag-details.mjs and what it imports), bundled into the
      // client build. Loaded lazily, so a catalogue outage cannot delay generation service
      // startup or take the generator's reservation.
      details: async args => loadTagDetails().queryTagDetails(args),
    }, gallery: danbooru,
  });
  const studies = createImageStudyService({ directory: dataPaths.studies, repository });
  app.once('before-quit', () => studies.dispose());
  const materialMethods: Record<string, (args: Record<string, unknown>, caller?: BridgeCaller) => Promise<any>> = { ...materials.methods, material_studies: args => studies.material_studies(args) };
  Object.assign(legacyMaterialHandlers, materialMethods);
  // A deletion through the bridge is the agent's; through this window (novelai:materials, novelai:assets) the user's.
  materialMethods.asset_library = (args, caller) => assetService.asset_library(args, { deletedBy: caller ? agentOf(caller) : { kind: 'user' } });
  Object.assign(queueMethods, Object.fromEntries(Object.entries(materialMethods).map(([method, call]) => [method, async (args: Record<string, unknown>, caller?: BridgeCaller) => {
    try { return await call(args, caller); }
    catch (error: any) { throw new BridgeError(/^[a-z_]+$/.test(error?.code ?? '') ? error.code : 'material_failed', error instanceof Error ? error.message : '素材操作未完成。'); }
  }])));
  ipcMain.handle('novelai:materials', async (event, method: string, args: Record<string, unknown>) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame || !Object.hasOwn(materialMethods, method)) return { ok: false, error: { code: 'forbidden_workspace', message: '只接受当前窗口的素材操作。' } };
    try { return { ok: true, result: await materialMethods[method](args) }; }
    catch (error: any) { return { ok: false, error: hostErrorFields(error, 'material_failed', 'The material operation did not complete.') }; }
  });
  ipcMain.handle("nai:hasToken", async () => {
    const summary = getAccountSummary();
    if (!summary.hasToken) return summary;
    return refreshStoredAccount();
  });
  // Local-only summary (token presence + last cached balance), no network. Used
  // at boot so a slow/blocked NovelAI connection can't delay app startup; the
  // renderer refreshes the live balance via nai:hasToken after the first frame.
  ipcMain.handle("nai:accountCached", () => getAccountSummary());
  // The saved token, or "" when there is none (never undefined: the window treats the value as text).
  ipcMain.handle("nai:storedToken", () => getToken() ?? "");
  ipcMain.handle("nai:verify", (_event, token: string) => verifyToken(token));
  ipcMain.handle("nai:clearToken", () => {
    clearToken();
    return { ok: true };
  });
  ipcMain.handle("nai:quoteAnlas", (_event, request: AnlasQuoteRequest) =>
    quoteAnlasCost(request),
  );
  ipcMain.handle("imageInput:readClipboard", () => readClipboardImageFiles());
  ipcMain.handle("imageInput:save", (_event, images: unknown) => savePastedImageFiles(images));
  ipcMain.handle("nai:loadImage", () => loadImageFile());
  ipcMain.handle("nai:loadImageFromPath", (_event, filePath: string) =>
    loadImageFromPath(filePath),
  );
  ipcMain.handle("metadata:saveSnapshot", (_event, payload: MetadataSnapshotPayload) =>
    saveMetadataSnapshotFile(app.getPath("userData"), payload),
  );
  ipcMain.handle("metadata:saveSnapshotFromPath", (_event, filePath: string) =>
    saveMetadataSnapshotFromPath(app.getPath("userData"), filePath),
  );
  ipcMain.handle("metadata:readSnapshotFromPath", (_event, filePath: string) =>
    readMetadataSnapshotFromPath(app.getPath("userData"), filePath),
  );
  ipcMain.handle("metadata:loadSnapshot", () =>
    loadMetadataSnapshotFile(app.getPath("userData")),
  );
  ipcMain.handle("nai:clearWorkbenchImage", () => clearWorkbenchImage());
  ipcMain.handle("nai:suggestTags", (_event, model: string, prompt: string) =>
    suggestTags(model, prompt),
  );

  ipcMain.handle(
    "storage:getHistory",
    (_event, date?: string, groupId?: string) => listHistory(date, groupId),
  );
  ipcMain.handle("storage:getHistoryItems", (_event, request) => listHistoryItems(request));
  ipcMain.handle("storage:getHistoryDates", () => listHistoryDates());
  ipcMain.handle("storage:getHistoryGroups", () => listHistoryGroups());
  ipcMain.handle("storage:createGroup", (_event, name: string) =>
    createGroup(name),
  );
  ipcMain.handle("storage:renameGroup", (_event, id: string, name: string) =>
    renameGroup(id, name),
  );
  ipcMain.handle("storage:deleteGroup", (_event, id: string) =>
    removeGroup(id),
  );
  ipcMain.handle("storage:exportGroup", (_event, groupId: string) =>
    exportGroup(groupId),
  );
  ipcMain.handle(
    "storage:setHistoryGroup",
    (_event, id: string, groupId?: string) => assignHistoryGroup(id, groupId),
  );
  ipcMain.handle("storage:delete", (_event, id: string) =>
    deleteHistoryItem(id),
  );
  ipcMain.handle("storage:renameItem", (_event, id: string, name: string) =>
    renameHistoryItem(id, name),
  );
  ipcMain.handle("storage:open", (_event, targetPath: string) =>
    openTarget(targetPath),
  );

  ipcMain.handle("storage:selectDir", () => selectOutputDir());

  // Native drag-out: drag a generated/history image straight to the desktop,
  // Explorer, Photoshop, a chat window, etc. as a real PNG file. Uses the saved
  // file on disk. Some Windows chat clients reject a drag source whose original
  // file is still being indexed/written or whose path has non-shell-friendly
  // segments, so expose a stable ASCII-named temp copy for the OLE drag session.
  ipcMain.on("image:startDrag", (event, filePathOrUrl: string) => {
    try {
      if (!filePathOrUrl) return;
      const sourcePath = localMediaUrlToPath(filePathOrUrl)
        ?? (filePathOrUrl.startsWith("file://") ? fileURLToPath(filePathOrUrl) : filePathOrUrl);
      const resolvedSource = path.resolve(sourcePath);
      if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isFile()) return;
      const dragDirectory = path.join(app.getPath("temp"), "mcp-for-novelai-drag");
      fs.mkdirSync(dragDirectory, { recursive: true });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(dragDirectory)) {
        const candidate = path.join(dragDirectory, name);
        try { if (fs.statSync(candidate).mtimeMs < cutoff) fs.rmSync(candidate, { force: true }); } catch { /* best effort */ }
      }
      const extension = path.extname(resolvedSource).toLowerCase() || ".png";
      const dragPath = path.join(dragDirectory, `mcp-for-novelai-image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
      fs.copyFileSync(resolvedSource, dragPath);
      const icon = nativeImage.createFromPath(dragPath);
      if (icon.isEmpty()) return; // startDrag throws on an empty icon
      event.sender.startDrag({
        file: dragPath,
        icon: icon.resize({ height: 96 }),
      });
    } catch (error) {
      console.warn("[image:startDrag] failed", error);
    }
  });

  ipcMain.handle("log:getInfo", () => getLogInfo());
  ipcMain.handle("log:selectDir", () => selectLogDir());
  ipcMain.handle("log:openFile", () => openLogFile());
  ipcMain.handle("log:openDir", () => openLogDir());
  ipcMain.handle("log:read", () => readRecentLog());

  ipcMain.handle("settings:get", (_event, key) => getSetting(key));
  ipcMain.handle("settings:set", async (_event, key, value) => {
    const saved = setSetting(key, value);
    if (key === "queueRetentionDays") runQueueRetention?.();
    if ([
      "proxyMode",
      "proxyUrl",
      "apiBaseUrl",
    ].includes(String(key))) {
      await refreshSystemProxy();
    }
    return saved;
  });
  ipcMain.handle("settings:getAll", () => getSettings());
  ipcMain.handle(
    "stylePreset:importImages",
    (_event, presetId: string, availableSlots: number, dialogTitle?: string) =>
      importStylePromptPresetImages(presetId, availableSlots, dialogTitle),
  );
  ipcMain.handle(
    "stylePreset:importImagePaths",
    (_event, sourcePaths: string[], presetId: string, availableSlots: number) =>
      copyStylePromptPreviewImages(sourcePaths, presetId, availableSlots),
  );
  ipcMain.handle(
    "stylePreset:reconcileImages",
    (_event, presetId: string, knownImages: StylePromptPreviewImage[]) =>
      reconcileStylePromptPreviewImages(presetId, knownImages),
  );
  ipcMain.handle("referencePreset:list", () => listReferencePresets());
  ipcMain.handle("referencePreset:save", (_event, request) =>
    saveReferencePreset(request),
  );
  ipcMain.handle("referencePreset:read", (_event, presetId: string) =>
    readReferencePreset(presetId),
  );
  ipcMain.handle("referencePreset:delete", (_event, presetId: string) =>
    deleteReferencePreset(presetId),
  );
  ipcMain.handle("referencePreset:createGroup", (_event, name: string) =>
    createReferencePresetGroup(name),
  );
  ipcMain.handle("referencePreset:deleteGroup", (_event, name: string) =>
    deleteReferencePresetGroup(name),
  );
  ipcMain.handle(
    "referencePreset:moveToGroup",
    (_event, presetId: string, group: string) =>
      moveReferencePresetToGroup(presetId, group),
  );
  ipcMain.handle("referencePreset:import", () => importReferencePresets());
  ipcMain.handle("referencePreset:prepareImport", () => prepareReferenceImport());
  ipcMain.handle("referencePreset:commitImport", (_event, request) => commitReferenceImport(request));
  ipcMain.handle("referencePreset:export", (_event, request) =>
    exportReferencePresets(request),
  );
  ipcMain.handle("dataBackup:export", (_event, request: DataBackupExportRequest) =>
    exportDataBackup(request),
  );
  ipcMain.handle("dataBackup:inspect", () => inspectDataBackup());
  ipcMain.handle("dataBackup:import", (_event, request: DataBackupImportRequest) =>
    importDataBackup(request),
  );
  ipcMain.handle("dataBackup:status", () => getDataBackupStatus());
  ipcMain.handle("dataBackup:runAutomatic", (_event, workspaceData?: Record<string, string>) =>
    runAutomaticBackup(workspaceData),
  );
  ipcMain.handle("dataBackup:selectDirectory", () => selectBackupDirectory());
  ipcMain.handle("dataBackup:openDirectory", () => openBackupDirectory());
  ipcMain.handle("settings:isFirstRun", () => !getSettings().hasOnboarded);
  ipcMain.handle("settings:completeSetup", () => {
    completeSetup();
    return { ok: true };
  });

  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());
  ipcMain.handle("window:openExternal", (_event, url: string) => {
    // Only ever hand http(s) URLs to the OS — never file:, javascript:, or other
    // schemes that a crafted link in the renderer could abuse.
    let parsed: URL;
    try {
      parsed = new URL(String(url));
    } catch {
      return { ok: false };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return { ok: false };
    void shell.openExternal(parsed.toString());
    return { ok: true };
  });
  // Settings › About "Check now": always asks GitHub, whatever the automatic-check setting says.
  ipcMain.handle("app:checkUpdate", () => updateChecker.check("manual"));
  ipcMain.handle("app:updateStatus", () => updateChecker.status());
  ipcMain.handle("app:mcpAccess", () => mcpAccessInfo());
  // Settings › MCP access and the guide: recent agent calls (client, tool, time) and the clients seen.
  ipcMain.handle("novelai:agent:activity", async event => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id) return { recent: [], clients: [] };
    return agentActivity ? agentActivity.read() : { recent: [], clients: [] };
  });
  // Settings › About: the LICENSE and THIRD_PARTY_NOTICES.md shipped with this app.
  ipcMain.handle("app:legalDocument", (_event, kind: LegalDocumentKind) =>
    readLegalDocument(kind, { packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }));
}

// The step a failed start stopped in, for its error dialog (startup-failure.ts).
let startupStep: StartupStep = "startup";
app.whenReady().then(async () => {
  await installLocalMediaProtocol();
  startupStep = "library";
  // A new data root gets a new empty library here (library-startup.ts).
  await initializeAssetLibrary({ userDataRoot: dataPaths.root, libraryDirectory: dataPaths.library });
  // Recently Deleted (<data root>/trash): finish or roll back what an interruption left before anything is served.
  const trash = createLibraryTrash({ repository: activeLibrary()!, userDataRoot: dataPaths.root, libraryDirectory: dataPaths.library,
    managedRoots: () => [getSetting("outputDir")], toFileUrl: toLocalMediaUrl,
    recipeReferences: targets => recipeReferenceScan ? recipeReferenceScan(targets) : Promise.reject(new Error('The recipe store is not ready.')) });
  await trash.recover();
  activateLibraryTrash(trash);
  startupStep = "startup";
  ensureDefaultInboxes();
  installGlobalLogging();
  configureSystemProxyResolver((url) => session.defaultSession.resolveProxy(url));
  await refreshSystemProxy();
  const proxyRefreshTimer = setInterval(() => {
    void refreshSystemProxy();
  }, 30_000);
  proxyRefreshTimer.unref();
  registerIpc();
  // Restored workbench inputs are admitted only from <data root>/image-inputs (pasted and prepared
  // source copies, ipc/image-clipboard.ts); the bridge publishes <data root>/runtime/bridge.json.
  registerWorkbenchSync(() => mainWindow, dataPaths.imageInputs);
  agentActivity = createAgentActivity({ runtimeDir: dataPaths.runtime,
    onChange: activity => { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send("novelai:agent:activity", activity); } });
  startupStep = "bridge";
  workspaceBridge = await startWorkspaceBridge(() => mainWindow, dataPaths.runtime, queueMethods, (method, caller) => agentActivity?.record(method, caller));
  startupStep = "startup";
  // Expired entries are purged now and every few hours while the app runs.
  trash.startAutoPurge();
  createWindow();
  if (shouldScheduleAutomaticChecks({ packaged: app.isPackaged, uiCapture: Boolean(uiCapturePath) })) updateChecker.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  const failure = startupFailureDialog(startupStep, error, dataPaths.runtime);
  dialog.showErrorBox(failure.title, failure.message);
  app.quit();
});

/** Without NOVELAI_PROJECT_ROOT the MCP server reads inbox files from <data root>/workspace;
 * create its two inbox folders so they are ready to receive files. Best effort. */
function ensureDefaultInboxes() {
  const folders = projectDirectories(dataPaths.workspace);
  for (const folder of [folders.materialInbox, folders.studyInbox]) {
    try { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); }
    catch (error) { console.warn("[workspace] inbox folder unavailable", error); }
  }
}

/** Settings → MCP access, computed for this run: a packaged app runs resources/mcp/novelai-mcp.mjs with its own
 * executable; a development run uses the client's dist-mcp build and the development Electron. */
function mcpAccessInfo() {
  const bundle = app.isPackaged ? path.join(process.resourcesPath, "mcp", "novelai-mcp.mjs") : path.join(app.getAppPath(), "dist-mcp", "novelai-mcp.mjs");
  const source = app.isPackaged ? null : path.resolve(app.getAppPath(), "..", "src", "mcp.mjs");
  const inboxes = projectDirectories(dataPaths.workspace);
  return buildMcpAccess({
    platform: process.platform, packaged: app.isPackaged, executable: process.execPath, bundle, bundleExists: fs.existsSync(bundle),
    sourceEntry: source && fs.existsSync(source) ? source : null, dataRoot: dataPaths.root, customDataRoot: Boolean(process.env[DATA_DIR_ENV]?.trim()),
    workspaceRoot: dataPaths.workspace, materialInbox: inboxes.materialInbox, studyInbox: inboxes.studyInbox,
    temporaryLocation: app.isPackaged && temporaryExecutableLocation(process.platform, process.execPath, process.env),
    bridgeReady: Boolean(workspaceBridge),
  });
}

type TagDetailsModule = { queryTagDetails(args: Record<string, unknown>): Promise<unknown> };
let tagDetailsModule: TagDetailsModule | undefined;
/** dist-electron/vendor/tag-details.cjs, written by scripts/build-electron.mjs. */
function loadTagDetails(): TagDetailsModule {
  return tagDetailsModule ??= require(path.join(__dirname, "..", "vendor", "tag-details.cjs")) as TagDetailsModule;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Bridge cleanup comes first and each step is isolated: a throwing step must not leave a
// stale bridge.json behind (close() removes it synchronously before its first await).
function closeBridgeNow() { try { void workspaceBridge?.close(); } catch (error) { console.warn("[bridge] close failed", error); } }
app.on("before-quit", () => {
  closeBridgeNow();
  updateChecker.stop();
  activeLibraryTrash()?.stop();
  try { disposeBatch?.(); } catch (error) { console.warn("[quit] batch dispose failed", error); }
  try { void agentActivity?.flush(); } catch (error) { console.warn("[quit] agent activity flush failed", error); }
  try { activeLibrary()?.close(); } catch (error) { console.warn("[quit] library close failed", error); }
});
// Paths that skip before-quit: plain process exit and Windows log-off / shut-down.
process.once("exit", closeBridgeNow);
