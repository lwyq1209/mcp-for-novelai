import { dialog, shell } from "electron";
import fs from "fs/promises";
import path from "path";
import JSZip from "jszip";
import type { HistoryItem, HistoryItemsRequest } from "../../src/types";
import { toLocalMediaUrl } from "./local-media-protocol";
import { activeLibrary, activeLibraryTrash } from '../library-runtime';
import { beginLibraryFileOperation, fileReferencedElsewhere } from '../library-file-operations';
import { hostMessage } from '../host-message';

/** Failures and receipts the window renders in its language (step 4a): a code, an English message and params. */
const refused = (code: string, message: string, reason?: string, params?: Record<string, string | number>, details?: Record<string, unknown>) => ({ ok: false as const, ...hostMessage(code, message, reason, params, details) });
import {
  createHistoryGroup,
  deleteHistoryGroup,
  getHistory,
  getHistoryItems,
  getHistoryDates,
  getHistoryGroups,
  getSetting,
  renameHistoryGroup,
  setHistoryGroup,
  setSetting,
  updateHistoryItem,
} from "./store";
import { hostText } from "../host-language";

/** Sanitize a string for safe use inside a filename. */
function safeName(value: string) {
  return (value || "").replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "_").slice(0, 80);
}

/** Render a filename from the user template + a history item. */
function formatImageName(template: string, item: HistoryItem, seq: number): string {
  const created = new Date(item.createdAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(created.getHours())}${pad(created.getMinutes())}${pad(created.getSeconds())}`;
  const tokens: Record<string, string> = {
    date: item.date,
    time,
    seq: String(seq + 1).padStart(3, "0"),
    seed: String(item.actualSeed ?? 0),
    model: safeName(item.model),
  };
  let name = (template && template.trim()) || "{date}_{seq}_{model}";
  name = name.replace(/\{(\w+)\}/g, (_m, key: string) => tokens[key] ?? "");
  name = safeName(name);
  return name || `image_${seq + 1}`;
}

export function renameGroup(id: string, name: string) {
  return renameHistoryGroup(id, name);
}

export function removeGroup(id: string) {
  return deleteHistoryGroup(id);
}

/** Bundle all images in a group into a ZIP at a user-chosen location. */
export async function exportGroup(groupId: string) {
  // Pack in ascending file-name order (1, 2, 10…) — history is stored newest-first,
  // which would otherwise zip the images in descending order.
  const items = [...getHistory(undefined, groupId || undefined)].sort((a, b) =>
    path.basename(a.filePath).localeCompare(path.basename(b.filePath), "zh-CN", { numeric: true }),
  );
  if (items.length === 0) return refused("history_export_empty", "This group has no images to export.");

  const groups = getHistoryGroups();
  const groupName =
    groupId === "__ungrouped"
      ? hostText("name.ungrouped")
      : groups.find((g) => g.id === groupId)?.name ?? hostText("name.all");
  const result = await dialog.showSaveDialog({
    title: hostText("dialog.exportGroup"),
    defaultPath: `${safeName(groupName)}.zip`,
    filters: [{ name: hostText("dialog.zipFiles"), extensions: ["zip"] }],
  });
  if (result.canceled || !result.filePath) return { ...refused("history_export_cancelled", "The export was cancelled."), cancelled: true };

  const template = getSetting("imageNameTemplate");
  const zip = new JSZip();
  const used = new Set<string>();
  let added = 0;
  for (let i = 0; i < items.length; i++) {
    try {
      const buf = await fs.readFile(items[i].filePath);
      const ext = path.extname(items[i].filePath) || ".png";
      let base = formatImageName(template, items[i], i);
      let name = `${base}${ext}`;
      let dup = 1;
      while (used.has(name)) name = `${base}_${dup++}${ext}`;
      used.add(name);
      zip.file(name, buf);
      added++;
    } catch {
      // Skip images whose file was deleted/moved.
    }
  }
  if (added === 0) return refused("history_export_files_missing", "The image files of the group no longer exist.");

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await fs.writeFile(result.filePath, content);
  return { ok: true, count: added, failed: items.length - added, ...hostMessage("history_exported", `Exported ${added} image(s).`, undefined, { count: added }), path: result.filePath };
}

export function listHistory(date?: string, groupId?: string) {
  return getHistory(date, groupId);
}

export function listHistoryItems(request: HistoryItemsRequest) {
  return getHistoryItems(request);
}

export function listHistoryDates() {
  return getHistoryDates();
}

export function listHistoryGroups() {
  return getHistoryGroups();
}

export function createGroup(name: string) {
  return createHistoryGroup(name);
}

export function assignHistoryGroup(id: string, groupId?: string) {
  return setHistoryGroup(id, groupId);
}

/**
 * Rename a saved image from the history panel: rename the file on disk (keeping
 * its extension, in the same folder, avoiding collisions) and update the index.
 */
export async function renameHistoryItem(id: string, rawName: string): Promise<{ ok: boolean; message?: string; code?: string; reason?: string; params?: Record<string, string | number>; item?: HistoryItem }> {
  const items = getHistory();
  const item = items.find((it) => it.id === id);
  if (!item) return refused("history_item_not_found", "The image record was not found.");
  const cleaned = safeName(rawName);
  if (!cleaned) return refused("history_name_required", "The file name cannot be empty.");
  const dir = path.dirname(item.filePath);
  const ext = path.extname(item.filePath) || ".png";
  let target = path.join(dir, `${cleaned}${ext}`);
  if (path.resolve(target) === path.resolve(item.filePath)) {
    return { ok: true, item }; // unchanged
  }
  // Avoid clobbering an existing file.
  let n = 1;
  while (true) {
    try {
      await fs.access(target);
      target = path.join(dir, `${cleaned}-${n++}${ext}`);
    } catch {
      break;
    }
  }
  const repo = activeLibrary();
  if (!repo) return refused('library_unavailable', 'The material library is not open.', 'history.library_not_open');
  if (fileReferencedElsewhere(repo, 'history', id, item.filePath)) return refused('history_file_referenced', 'This image is still referenced by other materials; its original file cannot be renamed for now.');
  const operation = beginLibraryFileOperation(repo, 'rename', { kind: 'history', id, original: item.filePath, target, fileUrl: toLocalMediaUrl(target) });
  try {
    await fs.rename(item.filePath, target);
  } catch (e: any) {
    return refused("history_rename_failed", `Rename failed: ${e?.message ?? "unknown error"}`, undefined, { detail: e?.message ?? "unknown error" });
  }
  const updated = updateHistoryItem(id, { filePath: target, fileUrl: toLocalMediaUrl(target) });
  repo.completeFileOperation(operation);
  return { ok: true, item: updated ?? { ...item, filePath: target, fileUrl: toLocalMediaUrl(target) } };
}

export async function deleteHistoryItem(id: string) {
  const repo = activeLibrary();
  if (!repo) return refused('library_unavailable', 'The material library is not open; the history record was kept.', 'history.library_not_open_kept');
  // The history panel's delete goes to Recently Deleted (library-trash.ts): the record and its original move to the
  // app's trash folder for 30 days and can be restored; a referenced image is deleted too (its references are listed).
  const item = repo.get('history', id); if (!item) return { ok: true };
  const trash = activeLibraryTrash();
  if (!trash) return refused('library_unavailable', 'The Recently Deleted service is not ready; the history record was kept.', 'history.trash_unavailable');
  try {
    const receipt = await trash.deleteItems([{ kind: 'history', id, expectedRevision: item.revision }], { deletedBy: { kind: 'user' } });
    return { ok: true, trashId: (receipt.deleted[0] as { trashId?: string } | undefined)?.trashId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Say what actually happened: the record may already be in Recently Deleted when the error came after that.
    const entry = repo.get('history', id) ? null : repo.trashEntryFor('history', id);
    if (entry) return { ok: true, trashId: entry.trashId, ...hostMessage('history_trash_pending', 'Moved to Recently Deleted; files not yet moved are completed at the next start.') };
    if (repo.get('history', id)) return refused('history_delete_failed', `The delete did not complete; the history record and image are still there: ${reason}`, undefined, { detail: reason }, { detail: error });
    return refused('history_delete_unknown', `The delete outcome is unknown; refresh the history to check: ${reason}`, undefined, { detail: reason }, { detail: error });
  }
}

export async function openTarget(targetPath: string) {
  if (!targetPath) return { ok: false };
  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      await shell.openPath(targetPath);
    } else {
      shell.showItemInFolder(targetPath);
    }
    return { ok: true };
  } catch {
    const fallback = path.dirname(targetPath);
    await shell.openPath(fallback);
    return { ok: true };
  }
}

export async function selectOutputDir() {
  const result = await dialog.showOpenDialog({
    title: hostText("dialog.outputFolder"),
    properties: ["openDirectory", "createDirectory"],
    defaultPath: getSetting("outputDir"),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const selected = result.filePaths[0];
  setSetting("outputDir", selected);
  return selected;
}
