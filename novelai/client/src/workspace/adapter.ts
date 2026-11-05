import { useAppStore, persistWorkspaceState } from "../store";
import { createWorkspaceController } from "./controller";
import { WorkspaceError } from "./protocol";
import { imageBase64, imageMime, pickCreativeState, type EditablePatch } from "./state";
import { canonicalizeWorkspaceMask } from "./mask-format";
import type { IpcResponse } from "./danbooru-types";
import type { WorkingImage } from "../types";
import { prepareGenerationSourceSelection } from "./source-selection";
import { collectPromptReview } from "./prompt-review";
import { observeGenerationJobs } from "./job-observer";

/** Custom Error properties are discarded by Electron's contextBridge. Rebuild
 * the typed error only after its plain-data envelope reaches the renderer. */
export async function unwrapIpcResponse<T>(request: Promise<IpcResponse<T>>): Promise<T> {
  const response = await request;
  if (!response || typeof response !== "object" || typeof response.ok !== "boolean") throw new WorkspaceError("invalid_response", "IPC 响应格式无效。");
  if (response.ok) return response.result;
  if (!response.error || typeof response.error.code !== "string" || !response.error.code || typeof response.error.message !== "string") throw new WorkspaceError("invalid_response", "IPC 错误响应格式无效。");
  throw new WorkspaceError(response.error.code, response.error.message);
}

export function decodeWorkspaceImage(data: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) reject(new WorkspaceError("invalid_image", "Image dimensions are invalid or exceed 64 megapixels."));
      else resolve(image);
    };
    image.onerror = () => reject(new WorkspaceError("invalid_image", "Image bytes could not be decoded."));
    image.src = `data:${imageMime(data)};base64,${data}`;
  });
}

async function validateImages(patch: EditablePatch, workbench = useAppStore.getState().workbenchImage) {
  for (const image of [...(patch.vibeImages ?? []), ...(patch.preciseReferences ?? [])]) await decodeWorkspaceImage(image.base64);
  if (patch.inpaintMask) {
    const image = await decodeWorkspaceImage(patch.inpaintMask);
    if (!workbench || image.naturalWidth !== workbench.width || image.naturalHeight !== workbench.height) throw new WorkspaceError("invalid_mask", "Mask dimensions must exactly match the workbench source image.");
    if (imageMime(patch.inpaintMask) !== "image/png") throw new WorkspaceError("invalid_mask", "Masks must be lossless PNG images.");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new WorkspaceError("invalid_mask", "Cannot decode mask pixels.");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const canonical = canonicalizeWorkspaceMask(pixels.data, canvas.width, canvas.height);
    if (canonical.changed) {
      pixels.data.set(canonical.rgba);
      context.putImageData(pixels, 0, 0);
      patch.inpaintMask = canvas.toDataURL("image/png").split(",")[1];
    }
  }
}

// The browser document, kept distinct from local names.
function documentForCanvas() { return globalThis.document; }

/** Prepare an immutable PNG without changing the main-process workbench. The
 * final apply/undo commits it synchronously with the source-selection draft. */
export async function prepareGenerationSourceWorkingCopy(data: string): Promise<WorkingImage> {
  const image = await decodeWorkspaceImage(data);
  let png = data;
  if (imageMime(data) !== "image/png") {
    const canvas = documentForCanvas().createElement("canvas");
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new WorkspaceError("invalid_image", "Cannot prepare selected source image.");
    context.drawImage(image, 0, 0);
    png = canvas.toDataURL("image/png").split(",")[1];
  }
  const paths = await window.naiDesktop.savePastedImageFiles([{ name: `source-${crypto.randomUUID()}.png`, bytes: Uint8Array.from(atob(png), (character) => character.charCodeAt(0)) }]);
  if (paths.length !== 1 || !paths[0]) throw new WorkspaceError("source_prepare_failed", "The selected source image could not be saved.");
  return { filePath: paths[0], fileUrl: `data:image/png;base64,${png}`, width: image.naturalWidth, height: image.naturalHeight };
}

export function createRendererWorkspace() {
  const api = window.naiDesktop;
  const controller = createWorkspaceController({
    promptReview: typeof api.workspacePromptReview === "function" ? async (state, mode) => unwrapIpcResponse(api.workspacePromptReview(await collectPromptReview(state, mode, readGenerationSource))) : undefined,
    collectPreparation: (state, mode) => collectPromptReview(state, mode, readGenerationSource),
    read: () => pickCreativeState(useAppStore.getState()),
    subscribe: (listener) => useAppStore.subscribe(listener),
    validateImages,
    prepareGenerationSource: (source, asset, mode, current) => prepareGenerationSourceSelection(source, asset, mode, current, prepareGenerationSourceWorkingCopy),
    readActivity: () => {
      const state = useAppStore.getState();
      return {
        // Manual generation is a manual batch of the shared queue (step 4a): this window's unfinished clicks.
        isGenerating: state.isGenerating, activeGenerationRunId: state.activeGenerationRunId,
        phase: state.generationPhase,
        manualBatches: state.manualBatches.map(({ batchId, mode, count, status, done, failed }) => ({ batchId, mode, count, status, done, failed })),
        galleryFilter: { selectedDate: state.selectedDate, selectedGroupId: state.selectedGroupId },
        maskEditing: Boolean(document.querySelector('[data-mask-drawing="true"]')),
        lockedInputs: { stylePrompt: state.settings?.lockStylePrompt ?? false, negativePrompt: state.settings?.lockNegativePrompt ?? false },
      };
    },
    apply: (patch, restore) => {
      const current = useAppStore.getState();
      // A queued or running batch (manual or agent) never blocks a draft: its inputs were frozen when it was queued.
      if (document.querySelector('[data-mask-drawing="true"]')) throw new WorkspaceError("workspace_busy", "Finish the mask stroke before applying a bridge edit.");
      if (patch.params && ((current.settings?.lockStylePrompt && patch.params.stylePrompt !== current.params.stylePrompt) || (current.settings?.lockNegativePrompt && patch.params.negativePrompt !== current.params.negativePrompt))) throw new WorkspaceError("input_locked", "Unlock the affected prompt in the manual interface before changing it.");
      if (restore) {
        const result = window.naiDesktop.commitWorkbench(patch.workbenchImage?.filePath ?? null);
        if (!result.ok) throw new WorkspaceError("restore_failed", result.message ?? "Cannot synchronize restored workbench input.");
      }
      const { modelMode, ...changes } = patch;
      const hasMask = Object.prototype.hasOwnProperty.call(changes, "inpaintMask");
      useAppStore.setState({
        ...changes,
        ...(modelMode && current.settings ? { settings: { ...current.settings, modelMode: modelMode as "anime" | "furry" } } : {}),
        ...(hasMask ? { maskRevision: current.maskRevision + 1 } : {}),
      });
      persistWorkspaceState();
      if (modelMode && modelMode !== current.settings?.modelMode) void window.naiDesktop.setSetting("modelMode", modelMode as "anime" | "furry");
    },
  });
  // Images the recipe queue saves appear in the history list; the canvas, its parameters and its busy state stay as they are.
  const stopObserving = typeof api.onGenerationJob === "function"
    ? observeGenerationJobs(listener => api.onGenerationJob(listener), historyIds => useAppStore.getState().refreshHistoryItems(historyIds))
    : () => {};
  return { ...controller, dispose: () => { stopObserving(); controller.dispose(); } };
}

async function readGenerationSource(source: WorkingImage) {
  const response = await fetch(source.fileUrl);
  if (!response.ok) throw new WorkspaceError("invalid_image", "Cannot read the selected source image.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new WorkspaceError("invalid_image", "Generation source must be an image of at most 20 MiB.");
  let binary = "";
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const data = imageBase64(btoa(binary), "generation source");
  const image = await decodeWorkspaceImage(data);
  if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) throw new WorkspaceError("invalid_image", "Selected image bytes no longer match its displayed dimensions. Select the image again.");
  return { mimeType: imageMime(data), data };
}
