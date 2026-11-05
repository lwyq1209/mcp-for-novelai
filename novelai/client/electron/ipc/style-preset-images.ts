import { app, dialog } from "electron";
import { activeLibrary } from '../library-runtime';
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { toLocalMediaUrl } from "./local-media-protocol";
import type { StylePromptPreviewImage } from "../../src/types";

const MAX_PREVIEW_IMAGES = 3;
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function safePresetId(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
}

export function stylePromptPreviewDirectory(
  presetId: string,
  userDataRoot = app.getPath("userData"),
) {
  const safeId = safePresetId(presetId);
  if (!safeId) throw new Error("Invalid style preset id.");
  return path.join(userDataRoot, "style-prompt-previews", safeId);
}

function library(userDataRoot: string) {
  const repo = activeLibrary(userDataRoot);
  if (!repo) throw new Error("素材库尚未打开。");
  return repo;
}

/** Stages copied preview images as library assets of their preset until the preset saves them (previewImages). */
function stagePreviewImages(
  presetId: string,
  images: StylePromptPreviewImage[],
  userDataRoot: string,
) {
  const repo = library(userDataRoot);
  repo.transaction(() => { for (const image of images) repo.putAsset({ id: `preview:${image.id}`, payload: { ...image, stagedForPreset: presetId } }); });
}

/**
 * The preview images of a style or positive preset (storage id "positive-prompt-<id>" for a positive preset): the
 * given images, or else the ones its saved library record names, each with its renderer URL rebuilt from its path.
 */
export function reconcileStylePromptPreviewImages(
  presetId: string,
  knownImages?: StylePromptPreviewImage[],
  userDataRoot = app.getPath("userData"),
): StylePromptPreviewImage[] {
  const repo = library(userDataRoot);
  const positive = presetId.startsWith('positive-prompt-');
  const id = positive ? presetId.slice('positive-prompt-'.length) : presetId;
  const saved = repo.get(positive ? 'positive_preset' : 'style_preset', id)?.payload.previewImages ?? [];
  return (knownImages ?? saved).map((image: StylePromptPreviewImage) => ({ ...image, fileUrl: toLocalMediaUrl(image.filePath) }));
}

const samePath = (left: string, right: string) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

/**
 * A preset's saved preview images for the renderer (settings:getAll), each made servable in this process: a saved
 * fileUrl is valid only in the run that made it (nai-local serves only paths this process exposed), so after a
 * restart the Style and prompt preset hover previews stayed broken until the preset's image dialog was opened. Only
 * an image whose file is a regular file (not a symbolic link) with an image extension directly in this preset's own
 * preview folder gets its URL rebuilt and served; any other entry keeps its saved URL and is not exposed.
 * `storageId` is the folder id: the style preset's id, or "positive-prompt-<id>" for a prompt preset.
 */
export function servablePreviewImages<T>(storageId: string, images: T, userDataRoot: string): T {
  if (!Array.isArray(images) || !images.length) return images;
  let directory: string;
  try {
    // The preset's own folder, itself a real folder (lstat: a symbolic link to elsewhere is not one).
    const planned = stylePromptPreviewDirectory(storageId, userDataRoot);
    if (!fs.lstatSync(planned).isDirectory()) return images;
    directory = fs.realpathSync(planned);
  } catch { return images; }
  return images.map(image => {
    const filePath = image && typeof image === "object" ? (image as { filePath?: unknown }).filePath : undefined;
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || !SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return image;
    try {
      if (!fs.lstatSync(filePath).isFile()) return image;
      const real = fs.realpathSync(filePath);
      if (!samePath(path.dirname(real), directory) || !fs.statSync(real).isFile()) return image;
      return { ...image, fileUrl: toLocalMediaUrl(real) };
    } catch {
      return image;
    }
  }) as T;
}

export function copyStylePromptPreviewImages(
  sourcePaths: string[],
  presetId: string,
  availableSlots: number,
  userDataRoot = app.getPath("userData"),
): StylePromptPreviewImage[] {
  const directory = stylePromptPreviewDirectory(presetId, userDataRoot);
  fs.mkdirSync(directory, { recursive: true });
  const existing = reconcileStylePromptPreviewImages(presetId, undefined, userDataRoot);
  const count = Math.max(
    0,
    Math.min(MAX_PREVIEW_IMAGES - existing.length, Math.floor(availableSlots)),
  );
  if (count === 0) return [];
  const copied: StylePromptPreviewImage[] = [];
  for (const sourcePath of sourcePaths.slice(0, count)) {
    const extension = path.extname(sourcePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension) || !fs.existsSync(sourcePath)) continue;
    const id = randomUUID();
    const filePath = path.join(directory, `${id}${extension}`);
    fs.copyFileSync(sourcePath, filePath, fs.constants.COPYFILE_EXCL);
    copied.push({
      id,
      name: path.basename(sourcePath),
      filePath,
      fileUrl: toLocalMediaUrl(filePath),
      createdAt: new Date().toISOString(),
    });
  }
  stagePreviewImages(presetId, [...existing, ...copied], userDataRoot);
  return copied;
}

export async function importStylePromptPresetImages(
  presetId: string,
  availableSlots: number,
  dialogTitle = "Images",
) {
  const count = Math.max(0, Math.min(MAX_PREVIEW_IMAGES, Math.floor(availableSlots)));
  if (count === 0) return [];
  const result = await dialog.showOpenDialog({
    title: dialogTitle,
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: dialogTitle, extensions: ["png", "jpg", "jpeg", "webp"] },
    ],
  });
  if (result.canceled) return [];
  return copyStylePromptPreviewImages(result.filePaths, presetId, count);
}
