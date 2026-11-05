import { isImageExportResult } from '../src/asset-library/image-export';
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { assertLocalCoverIpcSize } from './material-upload-guard';
import { bridgeSafeApi, hostErrorBridgeKey } from '../src/host-errors/bridge';
/**
 * A host refusal as an Error with its code, English message and window reason/params (rendered by src/host-errors).
 * contextBridge keeps only an Error's message, so bridgeSafeApi (below, around the whole API) writes code, reason and
 * params into the message's invisible suffix on the way out; the window reads them with readHostError.
 */
function hostErrorOf(error: any, code: string, message: string) {
  return Object.assign(new Error(typeof error?.message === 'string' && error.message ? error.message : message), { code: typeof error?.code === 'string' ? error.code : code,
    ...(typeof error?.reason === 'string' ? { reason: error.reason } : {}), ...(error?.params && typeof error.params === 'object' ? { params: error.params } : {}) });
}
async function materialCall(method: string, args: Record<string, unknown>) {
  assertLocalCoverIpcSize(method, args);
  const response = await ipcRenderer.invoke('novelai:materials', method, args);
  if (!response?.ok) throw hostErrorOf(response?.error, 'material_failed', 'The material operation did not complete.');
  return response.result;
}
import { createImageSaveTracker, type ImageSaveNotice } from "../src/image-save-feedback";
import type {
  AnlasQuoteRequest,
  AppSettings,
  DataBackupExportRequest,
  DataBackupImportRequest,
  DataBackupImportResult,
  DataBackupInspectResult,
  DataBackupOperationResult,
  DataBackupStatus,
  GenerationPreviewEvent,
  HistoryItemsRequest,
  SettingKey,
  UpdateInfo,
  StylePromptPreviewImage,
  ReferencePresetExportRequest,
  ReferencePresetLibrary,
  ReferencePresetOperationResult,
  ReferencePresetSaveRequest,
  ReferenceImportPreview,
  ReferenceImportCommitRequest,
  ReferenceImportCommitResult,
  MetadataSnapshotPayload,
} from "../src/types";

const imageSaves = createImageSaveTracker();

// Every function the window gets passes its errors through bridgeSafeError (src/host-errors/bridge.ts).
contextBridge.exposeInMainWorld("naiDesktop", bridgeSafeApi({
  // The window decodes an error's structure only from a suffix written with this launch's key (host-errors/bridge.ts).
  hostErrorKey: hostErrorBridgeKey(),
  exportAssetImages: async (args: import('../src/asset-library/image-export').ImageExportRequest): Promise<import('../src/asset-library/image-export').ImageExportResult> => {
    const response = await ipcRenderer.invoke('novelai:assets:export-images', args);
    if (!response?.ok || !isImageExportResult(response.result) || response.result.stripMetadata !== args.stripMetadata) throw hostErrorOf(response?.error, 'image_export_failed', 'The export result is unknown; check the destination file. Nothing is retried automatically.');
    return response.result;
  },
  assetLibrary: async (args: Record<string, unknown>) => {
    const response = await ipcRenderer.invoke('novelai:assets', args);
    if (!response?.ok) throw hostErrorOf(response?.error, 'library_unavailable', 'The library is unavailable.');
    return response.result;
  },
  onAssetLibraryChange: (callback: (change: { revision: number; changedKinds?: string[]; ids?: string[] }) => void) => {
    const listener = (_event: unknown, change: { revision: number; changedKinds?: string[]; ids?: string[] }) => callback(change);
    ipcRenderer.on('novelai:library:change', listener);
    return () => ipcRenderer.removeListener('novelai:library:change', listener);
  },
  materialLibrary: (args: Record<string, unknown>) => materialCall('material_library', args),
  materialTags: (args: Record<string, unknown>) => materialCall('material_tags', args),
  materialSamples: (args: Record<string, unknown>) => materialCall('material_samples', args),
  materialStudies: (args: Record<string, unknown>) => materialCall('material_studies', args),
  workspacePromptReview: (args: import("../src/workspace/prompt-review").PromptReviewPreparation) => ipcRenderer.invoke("novelai:prompt-review", args),
  // Host job events (the recipe queue's images): the renderer only refreshes the saved history items.
  onGenerationJob: (callback: (job: import("../src/workspace/generation-types").GenerationJob) => void) => {
    const listener = (_event: unknown, job: import("../src/workspace/generation-types").GenerationJob) => callback(job);
    ipcRenderer.on("novelai:generation:job", listener);
    return () => ipcRenderer.removeListener("novelai:generation:job", listener);
  },
  // The queue panel: the host recipe queue's own list/pause/resume/cancel, and its batch events.
  queueCall: (method: string, args: Record<string, unknown>) => ipcRenderer.invoke("novelai:queue:call", method, args),
  onQueueBatch: (callback: (batch: import("../src/workspace/batch-types").BatchJob) => void) => {
    const listener = (_event: unknown, batch: import("../src/workspace/batch-types").BatchJob) => callback(batch);
    ipcRenderer.on("novelai:queue:batch", listener);
    return () => ipcRenderer.removeListener("novelai:queue:batch", listener);
  },
  // Queue retention: batches the cleaning removed, the retention status and its runs (Settings › Queue).
  onQueueRemoved: (callback: (event: { batchIds: string[] }) => void) => {
    const listener = (_event: unknown, value: { batchIds: string[] }) => callback(value);
    ipcRenderer.on("novelai:queue:removed", listener);
    return () => ipcRenderer.removeListener("novelai:queue:removed", listener);
  },
  queueRetention: (request?: import("../src/types").QueueRetentionRequest) => ipcRenderer.invoke("novelai:queue:retention", request),
  onQueueRetention: (callback: (status: import("../src/types").QueueRetentionStatus) => void) => {
    const listener = (_event: unknown, status: import("../src/types").QueueRetentionStatus) => callback(status);
    ipcRenderer.on("novelai:queue:retention", listener);
    return () => ipcRenderer.removeListener("novelai:queue:retention", listener);
  },
  // Recent agent calls (client, tool, time; never arguments) and their changes.
  agentActivity: (): Promise<import("../src/agent-clients").AgentActivity> => ipcRenderer.invoke("novelai:agent:activity"),
  onAgentActivity: (callback: (activity: import("../src/agent-clients").AgentActivity) => void) => {
    const listener = (_event: unknown, activity: import("../src/agent-clients").AgentActivity) => callback(activity);
    ipcRenderer.on("novelai:agent:activity", listener);
    return () => ipcRenderer.removeListener("novelai:agent:activity", listener);
  },
  onWorkspaceRequest: (callback: (request: import("../src/workspace/protocol").WorkspaceRequest) => void) => {
    const listener = (_event: unknown, request: import("../src/workspace/protocol").WorkspaceRequest) => callback(request);
    ipcRenderer.on("novelai:bridge:request", listener);
    return () => ipcRenderer.removeListener("novelai:bridge:request", listener);
  },
  replyWorkspace: (response: import("../src/workspace/protocol").WorkspaceResponse) => ipcRenderer.send("novelai:bridge:response", response),
  workspaceReady: (workspaceId?: string) => ipcRenderer.send("novelai:bridge:ready", { workspaceId }),
  commitWorkbench: (filePath: string | null): { ok: boolean; message?: string } => ipcRenderer.sendSync("novelai:bridge:commit-workbench", filePath),
  onImageSaveFeedback: (callback: (notices: ImageSaveNotice[]) => void) => imageSaves.subscribe(callback),
  dismissImageSaveFeedback: (id: number) => imageSaves.dismiss(id),
  platform: process.platform,
  exportDataBackup: (request: DataBackupExportRequest): Promise<DataBackupOperationResult> =>
    ipcRenderer.invoke("dataBackup:export", request),
  inspectDataBackup: (): Promise<DataBackupInspectResult> =>
    ipcRenderer.invoke("dataBackup:inspect"),
  importDataBackup: (request: DataBackupImportRequest): Promise<DataBackupImportResult> =>
    ipcRenderer.invoke("dataBackup:import", request),
  getDataBackupStatus: (): Promise<DataBackupStatus> =>
    ipcRenderer.invoke("dataBackup:status"),
  runAutomaticBackup: (workspaceData?: Record<string, string>): Promise<DataBackupOperationResult> =>
    ipcRenderer.invoke("dataBackup:runAutomatic", workspaceData),
  selectBackupDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke("dataBackup:selectDirectory"),
  openBackupDirectory: (): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke("dataBackup:openDirectory"),
  hasToken: () => ipcRenderer.invoke("nai:hasToken"),
  accountCached: () => ipcRenderer.invoke("nai:accountCached"),
  storedToken: async (): Promise<string> => { const value = await ipcRenderer.invoke("nai:storedToken"); return typeof value === "string" ? value : ""; },
  verifyToken: (token: string) => ipcRenderer.invoke("nai:verify", token),
  clearToken: () => ipcRenderer.invoke("nai:clearToken"),
  quoteAnlas: (request: AnlasQuoteRequest) =>
    ipcRenderer.invoke("nai:quoteAnlas", request),
  // Manual generation (step 4a): a Generate click freezes the canvas into a manual batch of the shared queue.
  manualEnqueue: (request: import("../src/workspace/manual-batches").ManualGenerationRequest) => ipcRenderer.invoke("novelai:manual:enqueue", request),
  manualLookup: (requestKey: string) => ipcRenderer.invoke("novelai:manual:lookup", { requestKey }),
  manualCaptureSource: (filePath: string) => ipcRenderer.invoke("novelai:manual:capture-source", { filePath }),
  onManualItem: (callback: (event: import("../src/workspace/manual-batches").ManualItemEvent) => void) => {
    const listener = (_event: unknown, payload: import("../src/workspace/manual-batches").ManualItemEvent) => callback(payload);
    ipcRenderer.on("novelai:manual:item", listener);
    return () => ipcRenderer.removeListener("novelai:manual:item", listener);
  },
  onGenerationPreview: (callback: (event: GenerationPreviewEvent) => void) => {
    const listener = (_event: unknown, payload: GenerationPreviewEvent) => callback(payload);
    ipcRenderer.on("nai:generationPreview", listener);
    return () => ipcRenderer.removeListener("nai:generationPreview", listener);
  },
  suggestTags: (model: string, prompt: string) =>
    ipcRenderer.invoke("nai:suggestTags", model, prompt),
  readClipboardImageFiles: () => ipcRenderer.invoke("imageInput:readClipboard"),
  savePastedImageFiles: (images: Array<{name:string;bytes:Uint8Array}>) => ipcRenderer.invoke("imageInput:save", images),
  loadImage: () => ipcRenderer.invoke("nai:loadImage"),
  loadImageFromPath: (filePath: string) =>
    ipcRenderer.invoke("nai:loadImageFromPath", filePath),
  saveMetadataSnapshot: (payload: MetadataSnapshotPayload) =>
    ipcRenderer.invoke("metadata:saveSnapshot", payload),
  saveMetadataSnapshotFromPath: (filePath: string) =>
    ipcRenderer.invoke("metadata:saveSnapshotFromPath", filePath),
  readMetadataSnapshotFromPath: (filePath: string) =>
    ipcRenderer.invoke("metadata:readSnapshotFromPath", filePath),
  loadMetadataSnapshot: () => ipcRenderer.invoke("metadata:loadSnapshot"),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  clearWorkbenchImage: () => ipcRenderer.invoke("nai:clearWorkbenchImage"),

  getHistory: (date?: string, groupId?: string) =>
    ipcRenderer.invoke("storage:getHistory", date, groupId),
  getHistoryItems: (request: HistoryItemsRequest) => ipcRenderer.invoke("storage:getHistoryItems", request),
  getHistoryDates: () => ipcRenderer.invoke("storage:getHistoryDates"),
  getHistoryGroups: () => ipcRenderer.invoke("storage:getHistoryGroups"),
  createHistoryGroup: (name: string) =>
    ipcRenderer.invoke("storage:createGroup", name),
  renameHistoryGroup: (id: string, name: string) =>
    ipcRenderer.invoke("storage:renameGroup", id, name),
  deleteHistoryGroup: (id: string) =>
    ipcRenderer.invoke("storage:deleteGroup", id),
  exportHistoryGroup: (groupId: string) =>
    imageSaves.run(`group:${groupId}`, "archive", () => ipcRenderer.invoke("storage:exportGroup", groupId)),
  setHistoryGroup: (id: string, groupId?: string) =>
    ipcRenderer.invoke("storage:setHistoryGroup", id, groupId),
  deleteHistory: (id: string) => ipcRenderer.invoke("storage:delete", id),
  renameHistoryItem: (id: string, name: string) =>
    ipcRenderer.invoke("storage:renameItem", id, name),
  openInExplorer: (targetPath: string) =>
    ipcRenderer.invoke("storage:open", targetPath),
  selectOutputDir: () => ipcRenderer.invoke("storage:selectDir"),
  startImageDrag: (filePath: string) =>
    ipcRenderer.send("image:startDrag", filePath),

  getSetting: <K extends SettingKey>(key: K) =>
    ipcRenderer.invoke("settings:get", key),
  setSetting: <K extends SettingKey>(key: K, value: AppSettings[K]) =>
    ipcRenderer.invoke("settings:set", key, value),
  getSettings: () => ipcRenderer.invoke("settings:getAll"),
  importStylePromptPresetImages: (
    presetId: string,
    availableSlots: number,
    dialogTitle?: string,
  ): Promise<StylePromptPreviewImage[]> =>
    ipcRenderer.invoke(
      "stylePreset:importImages",
      presetId,
      availableSlots,
      dialogTitle,
    ),
  importStylePromptPresetImagePaths: (
    sourcePaths: string[],
    presetId: string,
    availableSlots: number,
  ): Promise<StylePromptPreviewImage[]> =>
    ipcRenderer.invoke(
      "stylePreset:importImagePaths",
      sourcePaths,
      presetId,
      availableSlots,
    ),
  reconcileStylePromptPresetImages: (
    presetId: string,
    knownImages: StylePromptPreviewImage[],
  ): Promise<StylePromptPreviewImage[]> =>
    ipcRenderer.invoke("stylePreset:reconcileImages", presetId, knownImages),
  listReferencePresets: (): Promise<ReferencePresetLibrary> =>
    ipcRenderer.invoke("referencePreset:list"),
  saveReferencePreset: (
    request: ReferencePresetSaveRequest,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:save", request),
  readReferencePreset: (
    presetId: string,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:read", presetId),
  deleteReferencePreset: (
    presetId: string,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:delete", presetId),
  createReferencePresetGroup: (
    name: string,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:createGroup", name),
  deleteReferencePresetGroup: (
    name: string,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:deleteGroup", name),
  moveReferencePresetToGroup: (
    presetId: string,
    group: string,
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:moveToGroup", presetId, group),
  importReferencePresets: (): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:import"),
  prepareReferenceImport: (): Promise<ReferenceImportPreview> => ipcRenderer.invoke('referencePreset:prepareImport'),
  commitReferenceImport: (request: ReferenceImportCommitRequest): Promise<ReferenceImportCommitResult> => ipcRenderer.invoke('referencePreset:commitImport', request),
  exportReferencePresets: (
    request: ReferencePresetExportRequest = {},
  ): Promise<ReferencePresetOperationResult> =>
    ipcRenderer.invoke("referencePreset:export", request),
  isFirstRun: () => ipcRenderer.invoke("settings:isFirstRun"),
  completeSetup: () => ipcRenderer.invoke("settings:completeSetup"),

  checkUpdate: (): Promise<UpdateInfo> => ipcRenderer.invoke("app:checkUpdate"),
  getUpdateStatus: (): Promise<UpdateInfo | null> => ipcRenderer.invoke("app:updateStatus"),
  readLegalDocument: (kind: "license" | "notices"): Promise<string> => ipcRenderer.invoke("app:legalDocument", kind),
  mcpAccess: (): Promise<import("../src/types").McpAccessInfo> => ipcRenderer.invoke("app:mcpAccess"),
  onUpdateEvent: (callback: (info: UpdateInfo) => void) => {
    const listener = (_event: unknown, payload: UpdateInfo) =>
      callback(payload);
    ipcRenderer.on("app:updateEvent", listener);
    return () => ipcRenderer.removeListener("app:updateEvent", listener);
  },
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  openExternal: (url: string) => ipcRenderer.invoke("window:openExternal", url),
  getLogInfo: () =>
    ipcRenderer.invoke("log:getInfo") as Promise<{
      path: string;
      dir: string;
      exists: boolean;
      sizeBytes: number;
    }>,
  selectLogDir: () =>
    ipcRenderer.invoke("log:selectDir") as Promise<string | null>,
  openLogFile: () =>
    ipcRenderer.invoke("log:openFile") as Promise<{
      ok: boolean;
      message?: string;
    }>,
  openLogDir: () =>
    ipcRenderer.invoke("log:openDir") as Promise<{
      ok: boolean;
      message?: string;
    }>,
  readLog: () => ipcRenderer.invoke("log:read") as Promise<string>,
}));
