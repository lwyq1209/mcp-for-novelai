import { plainErrorMessage } from '../host-errors/bridge';
import type { AssetDetail } from '../asset-library/types';
import { useAppStore } from '../store';
import { getWorkspaceRuntime } from '../workspace/runtime';
import { imageBase64, imageMime } from '../workspace/state';
import type { GenerationSourceMode } from '../workspace/source-selection';
import { WorkspaceError } from '../workspace/protocol';
import { showToast } from '../ui';
import { uiLangOf, uiText } from '../ui/i18n';
import { metadataSnapshotToFile } from '../metadata-snapshot';
import { creativeMode } from './workbench-navigation';

export type ActionImage = { id?: string; name?: string; filePath?: string; fileUrl?: string; width?: number; height?: number };
export function imageFromAssetDetail(detail: AssetDetail): ActionImage | null {
  const payload = detail.item.payload;
  const asset = detail.assets.find(value => value.role === 'original') ?? detail.assets.find(value => value.fileUrl || value.filePath);
  if (!asset) return null;
  return { id: detail.item.id, name: detail.item.name, filePath: asset.filePath, fileUrl: asset.fileUrl, ...(detail.item.kind === 'history' ? { width: payload.width, height: payload.height } : {}) };
}
/** A refusal with the reason the window renders in its language (src/host-errors/library.ts; step 4c1). */
const imageRefused = (reason: string, message: string) => Object.assign(new Error(message), { code: 'invalid_source', reason });
export async function readActionImage(image: ActionImage | File): Promise<File> {
  if (image instanceof File) return image;
  if (image.filePath) {
    const result = await window.naiDesktop.readMetadataSnapshotFromPath(image.filePath);
    if (!result.ok || !result.snapshot) throw imageRefused('library.image_unreadable_file', 'The original cannot be read; check that the file is still where it was.');
    return metadataSnapshotToFile(result.snapshot);
  }
  if (!image.fileUrl) throw imageRefused('library.image_none', 'This record has no image to read.');
  const response = await fetch(image.fileUrl);
  if (!response.ok) throw imageRefused('library.image_read_failed', 'Reading the image failed.');
  return new File([await response.blob()], image.name || 'source.png');
}
export async function actionImageBytes(image: ActionImage | File) {
  const file = await readActionImage(image);
  if (file.size > 20 * 1024 * 1024) throw imageRefused('library.image_too_large', 'The image is larger than 20 MiB; choose a smaller one.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const data = imageBase64(btoa(binary), '输入图片');
  return { data, mimeType: imageMime(data) };
}
export function currentInputMode(): GenerationSourceMode {
  const mode = creativeMode(useAppStore.getState());
  return mode && mode !== 't2i' ? mode : 'i2i';
}
/**
 * Uses an image as the source of a mode (step 4b3): the canvas stages it as a source draft (stageClientSource, which
 * prepares the working copy without touching the canvas) and applies that draft at once, as the user's own explicit
 * choice; a toast offers to undo it (undo_edit). The old review dialog of this step is gone. A refusal is thrown as an
 * Error whose message is already in the interface language.
 */
export async function stageImageInput(image: ActionImage | File, mode = currentInputMode()) {
  const lang = uiLangOf(useAppStore.getState().settings?.language);
  const text = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText(lang, key, params);
  const controller = getWorkspaceRuntime();
  if (!controller) throw new Error(text('cv.src.notReady'));
  const name = image instanceof File ? image.name : image.name || image.filePath?.split(/[\\/]/).pop() || 'source';
  let draft: Awaited<ReturnType<typeof controller.stageClientSource>>;
  try {
    draft = await controller.stageClientSource({ id: image instanceof File ? crypto.randomUUID() : image.id || crypto.randomUUID(), role: 'workbenchImage', mimeType: 'image/png' }, mode, () => actionImageBytes(image), name);
  } catch (error) { throw new Error(sourceErrorText(error, lang)); }
  if (!draft) return;
  try {
    await controller.execute('apply_edit', { workspaceId: controller.getView().workspaceId, expectedRevision: controller.getView().revision, draftId: draft.draftId });
  } catch (error) {
    // Never leave this window's own staged source behind (it would block the next one); a newer draft stays.
    if (controller.getView().draft?.draftId === draft.draftId) controller.discardDraft();
    throw new Error(sourceErrorText(error, lang));
  }
  const modeName = text(`cv.mode.of.${mode}` as never);
  showToast({ message: text(draft.generationSource?.clearedMask ? 'cv.src.doneMask' : 'cv.src.done', { mode: modeName }), tone: 'ok', durationMs: 6000, action: { label: text('cv.draft.undo'), onClick: () => {
    const view = controller.getView();
    // Only this source's own step: when something else was applied after it (an agent draft), undo would undo that.
    if (view.lastApplied?.draftId !== draft.draftId) { showToast({ message: text('cv.undo.notLast'), tone: 'warn' }); return; }
    if (!view.undoAvailable) { showToast({ message: text('cv.draft.undoGone'), tone: 'warn' }); return; }
    void controller.execute('undo_edit', { workspaceId: view.workspaceId, expectedRevision: view.revision })
      .then(() => showToast({ message: text('cv.src.undone') }))
      .catch(() => showToast({ message: text('cv.draft.undoGone'), tone: 'warn' }));
  } } });
}

/** A refusal of staging or applying a source, in the interface language (codes of the workspace controller). */
export function sourceErrorText(error: unknown, lang: ReturnType<typeof uiLangOf>): string {
  const code = error instanceof WorkspaceError ? error.code : (error as { code?: unknown } | null)?.code;
  const text = (key: Parameters<typeof uiText>[1]) => uiText(lang, key);
  if (code === 'unapplied_draft') return text('cv.src.draftFirst');
  if (code === 'workspace_busy') return text('cv.src.busy');
  if (code === 'conflict') return text('cv.src.changed');
  if (code === 'unavailable' || code === 'workspace_unavailable') return text('cv.src.notReady');
  if (code === 'invalid_source') return text('cv.src.unreadable');
  if (/20 MiB/.test(plainErrorMessage(error, ''))) return text('cv.src.tooLarge');
  return text('cv.src.unreadable');
}
