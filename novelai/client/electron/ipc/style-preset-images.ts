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
