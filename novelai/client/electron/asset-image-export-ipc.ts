import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ImageExportResult } from '../src/asset-library/image-export';
/** Dedicated desktop IPC, deliberately absent from public tool/HTTP registries. */
export async function handleAssetImageExport(event: Pick<IpcMainInvokeEvent,'sender'|'senderFrame'>, window: BrowserWindow | null, args: unknown, run: (args: unknown) => Promise<ImageExportResult>) {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { code: 'forbidden_workspace', message: 'Image exports are accepted only from the current main window.', reason: 'library.export_window_only' } };
  try { return { ok: true, result: await run(args) }; }
  // The window shows reason in its language (src/host-errors/library.ts); the message is the English fallback.
  catch { return { ok: false, error: { code: 'export_failed', message: 'The export request is invalid or an export is already running. Nothing is retried automatically.', reason: 'library.export_refused' } }; }
}
