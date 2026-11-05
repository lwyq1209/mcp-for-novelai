import { beginLibraryFileOperation } from '../library-file-operations';
import { createHash } from 'node:crypto';
import { activeLibrary } from '../library-runtime';
import { app, dialog } from "electron";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { toLocalMediaUrl } from "./local-media-protocol";
import JSZip from "jszip";
import { REFERENCE_PRESET_FORMAT, ReferenceImportService, type ReferenceImportCommitResultText, type ReferenceImportPreviewText } from './reference-preset-import';
import { hostError } from '../host-error';
import { hostDetail, hostMessage, type HostMessage } from '../host-message';
import type {
  PreciseReferenceType,
  ReferencePreset,
  ReferencePresetExportRequest,
  ReferencePresetLibrary,
  ReferencePresetOperationResult,
  ReferencePresetSaveRequest,
  ReferenceImportCommitRequest,
} from "../../src/types";
import { hostText } from "../host-language";

/** Results the window renders in its language (step 4a): failures and the export receipt carry a code, an English message and params. */
export type ReferencePresetResult = ReferencePresetOperationResult & Partial<HostMessage>;
const refused = (code: string, message: string, params?: Record<string, string | number>): ReferencePresetResult => ({ ok: false, ...hostMessage(code, message, undefined, params) });

const ARCHIVE_VERSION = 1;
const MAX_PRESETS = 5000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** The preset records are library items (reference_preset) and their groups the 'reference' collections; the
 * images are files in <data root>/reference-presets. */
function rootDirectory(userDataRoot = app.getPath("userData")) {
  return path.join(userDataRoot, "reference-presets");
}

function requireLibrary(userDataRoot?: string) {
  const repo = activeLibrary(userDataRoot);
  if (!repo) throw hostError("library_unavailable", "The material library is not open.", "reference_preset.library_not_open");
  return repo;
}

function cleanText(value: unknown, max = 120) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanLocalizedMap(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const allowed = new Set(["zh-CN", "zh-TW", "ja-JP", "ko-KR", "en-US"]);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key]) => allowed.has(key))
    .map(([key, item]) => [key, cleanText(item, 160)] as const)
    .filter(([, item]) => Boolean(item));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function numberIn(value: unknown, fallback: number, min = 0, max = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function cleanExtension(value: unknown) {
  const raw = String(value ?? "").toLowerCase();
  const extension = raw.startsWith(".") ? raw : `.${raw}`;
  return SUPPORTED_EXTENSIONS.has(extension) ? extension : ".png";
}

function publicPreset(preset: Omit<ReferencePreset, "fileUrl">): ReferencePreset {
  return { ...preset, fileUrl: toLocalMediaUrl(preset.filePath) };
}

function serializablePreset(preset: ReferencePreset | Omit<ReferencePreset, "fileUrl">) {
  const { fileUrl: _fileUrl, ...stored } = preset as ReferencePreset;
  return stored;
}

export function normalizePreset(raw: Record<string, unknown>, filePath: string) {
  const kind = raw.kind === "precise" ? "precise" : "vibe";
  const preciseType: PreciseReferenceType =
    raw.preciseType === "style" || raw.preciseType === "character&style"
      ? raw.preciseType
      : "character";
  const name = cleanText(raw.name);
  if (!name) return null;
  return publicPreset({
    id: cleanText(raw.id, 96) || randomUUID(),
    name,
    group: cleanText(raw.group),
    kind,
    filePath,
    createdAt: cleanText(raw.createdAt, 64) || new Date().toISOString(),
    infoExtracted: numberIn(raw.infoExtracted, 1),
    strength: numberIn(raw.strength, 1),
    preciseType,
    fidelity: numberIn(raw.fidelity, 1),
    informationExtracted: numberIn(raw.informationExtracted, 1),
    width: Math.max(0, Math.floor(Number(raw.width) || 0)),
    height: Math.max(0, Math.floor(Number(raw.height) || 0)),
    sourceId: cleanText(raw.sourceId, 180) || undefined,
    sourceNames: cleanLocalizedMap(raw.sourceNames),
    sourceGameNames: cleanLocalizedMap(raw.sourceGameNames),
    sourceGameId: cleanText(raw.sourceGameId, 120) || undefined,
    sourceCategory: cleanText(raw.sourceCategory, 80) || undefined,
  } satisfies Omit<ReferencePreset, "fileUrl">);
}

export async function listReferencePresets(
  userDataRoot?: string,
): Promise<ReferencePresetLibrary> {
  const repo = requireLibrary(userDataRoot);
  return { groups: repo.collections('reference').map(value => value.name), presets: repo.all('reference_preset').sort((a,b) => (a.source.position ?? Number.MAX_SAFE_INTEGER) - (b.source.position ?? Number.MAX_SAFE_INTEGER)).filter(item => !item.archived).map(item => ({ ...publicPreset(item.payload as unknown as ReferencePreset), assetRevision: item.revision })) };
}

export async function saveReferencePreset(
  request: ReferencePresetSaveRequest,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const name = cleanText(request.name);
  if (!name) return refused("reference_preset_name_required", "Enter a preset name.");
  const base64 = String(request.base64 ?? "").replace(/^data:[^,]+,/, "");
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return refused("reference_preset_image_invalid", "The reference image data is invalid.");
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    return refused("reference_preset_image_size", "The reference image is empty or larger than 50 MB.", { limitMb: 50 });
  }
  const library = await listReferencePresets(userDataRoot);
  if (library.presets.length >= MAX_PRESETS) {
    return refused("reference_preset_limit_reached", "The number of presets has reached its limit.", { limit: MAX_PRESETS });
  }
  const id = randomUUID();
  const root = rootDirectory(userDataRoot);
  await fs.mkdir(root, { recursive: true });
  const filePath = path.join(root, `${id}${cleanExtension(request.extension)}`);
  const preset = normalizePreset(
    {
      ...request,
      id,
      name,
      group: cleanText(request.group),
      createdAt: new Date().toISOString(),
    },
    filePath,
  );
  if (!preset) {
    return refused("reference_preset_invalid", "The preset parameters are invalid.");
  }
  const groups = preset.group
    ? [...new Set([...library.groups, preset.group])]
    : library.groups;
  const next = { groups, presets: [...library.presets, preset] };
  try {
    const repo = requireLibrary(userDataRoot);
    const operation = beginLibraryFileOperation(repo, 'create', { kind: 'reference_preset', id, item: preset, target: filePath, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    await fs.writeFile(filePath, bytes, { flag: "wx" });
    repo.transaction(() => { repo.put('reference_preset', id, preset, { expectedRevision: 0 }); repo.completeFileOperation(operation); });
  } catch {
    await fs.rm(filePath, { force: true });
    return refused("reference_preset_save_failed", "The preset could not be saved; no group was created.");
  }
  return { ok: true, preset, library: next };
}

export async function readReferencePreset(
  presetId: string,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const library = await listReferencePresets(userDataRoot);
  const preset = library.presets.find((item) => item.id === presetId);
  if (!preset) return refused("reference_preset_not_found", "The reference preset was not found.");
  try {
    return {
      ok: true,
      preset,
      base64: (await fs.readFile(preset.filePath)).toString("base64"),
    };
  } catch {
    return refused("reference_preset_image_missing", "The preset image does not exist; import it again.");
  }
}

export async function deleteReferencePreset(
  presetId: string,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const presets = await listReferencePresets(userDataRoot);
  if (!presets.presets.some((item) => item.id === presetId)) return { ok: true, library: presets };
  // Archived, not removed: the preset keeps its versions and its image (Recently Deleted removes for good).
  const repo = requireLibrary(userDataRoot), current = repo.get('reference_preset', presetId)!;
  repo.put('reference_preset', presetId, current.payload, { expectedRevision: current.revision, archived: true });
  return { ok: true, library: await listReferencePresets(userDataRoot) };
}

export async function createReferencePresetGroup(
  value: string,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const name = cleanText(value);
  if (!name) return refused("reference_preset_group_name_required", "Enter a group name.");
  requireLibrary(userDataRoot).putCollection({ namespace: 'reference', id: name, name, payload: {} });
  return { ok: true, library: await listReferencePresets(userDataRoot) };
}

export async function deleteReferencePresetGroup(
  value: string,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const name = cleanText(value);
  if (!name) return refused("reference_preset_group_required", "Choose the group to delete.");
  const repo = requireLibrary(userDataRoot);
  repo.transaction(() => { for (const item of repo.all('reference_preset')) if (item.payload.group === name) repo.put('reference_preset', item.id, { ...item.payload, group: '' }, { expectedRevision: item.revision }); repo.deleteCollection('reference', name); });
  return { ok: true, library: await listReferencePresets(userDataRoot) };
}

export async function moveReferencePresetToGroup(
  presetId: string,
  value: string,
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const repo = requireLibrary(userDataRoot), item = repo.get('reference_preset', presetId);
  if (!item) return refused('reference_preset_not_found', 'The reference preset was not found.');
  repo.put('reference_preset', presetId, { ...item.payload, group: cleanText(value) }, { expectedRevision: item.revision });
  const presets = await listReferencePresets(userDataRoot);
  return { ok: true, library: presets, preset: presets.presets.find(item => item.id === presetId) };
}

export async function exportReferencePresets(
  request: ReferencePresetExportRequest = {},
  userDataRoot?: string,
): Promise<ReferencePresetResult> {
  const library = await listReferencePresets(userDataRoot);
  const presets = request.presetId
    ? library.presets.filter((item) => item.id === request.presetId)
    : request.group !== undefined
      ? library.presets.filter((item) => item.group === request.group)
      : library.presets;
  if (!presets.length) return refused("reference_preset_export_empty", "There are no presets to export.");
  const result = await dialog.showSaveDialog({
    title: hostText("dialog.exportReferences"),
    defaultPath: `${request.presetId ? presets[0].name : request.group || "reference-presets"}.nairp`,
    filters: [{ name: hostText("dialog.referenceFiles"), extensions: ["nairp"] }],
  });
  if (result.canceled || !result.filePath) return refused("reference_preset_export_cancelled", "The export was cancelled.");
  const zip = new JSZip();
  const manifestPresets: Record<string, unknown>[] = [];
  for (let index = 0; index < presets.length; index++) {
    const preset = presets[index];
    const extension = cleanExtension(path.extname(preset.filePath));
    const asset = `images/${index + 1}${extension}`;
    const bytes = await fs.readFile(preset.filePath);
    zip.file(asset, bytes);
    manifestPresets.push({
      ...serializablePreset(preset),
      id: requireLibrary(userDataRoot).get('reference_preset', preset.id)?.source.legacyId ?? preset.id,
      filePath: "",
      asset,
    });
  }
  zip.file(
    "manifest.json",
    JSON.stringify({
      format: REFERENCE_PRESET_FORMAT,
      version: ARCHIVE_VERSION,
      groups: library.groups,
      presets: manifestPresets,
    }),
  );
  await fs.writeFile(
    result.filePath,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
  return { ok: true, ...hostMessage("reference_preset_exported", `Exported ${presets.length} preset(s).`, undefined, { count: presets.length }), path: result.filePath, count: presets.length };
}

export async function importReferencePresets(
  _userDataRoot?: string,
): Promise<ReferencePresetResult> {
  return refused('reference_preset_import_preview_required', 'Use "Import presets" to preview the differences first, then confirm the import.');
}

const importServices = new WeakMap<NonNullable<ReturnType<typeof activeLibrary>>, ReferenceImportService>();
function referenceImportService(userDataRoot = app.getPath('userData')) {
  const repo = activeLibrary(userDataRoot);
  if (!repo) throw hostError('library_unavailable', 'The material library is not ready; the import cannot be previewed.', 'reference_preset.import_library_not_ready');
  let service = importServices.get(repo);
  if (!service) { service = new ReferenceImportService(repo, rootDirectory(userDataRoot), normalizePreset); importServices.set(repo, service); }
  return service;
}

export async function prepareReferenceImport(userDataRoot?: string): Promise<ReferenceImportPreviewText> {
  const result = await dialog.showOpenDialog({
    title: hostText("dialog.chooseReferences"),
    properties: ["openFile"],
    filters: [{ name: hostText("dialog.referenceFiles"), extensions: ["nairp", "zip"] }],
  });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true, ...hostMessage("reference_import_cancelled", "The import was cancelled.") };
  try {
    return await referenceImportService(userDataRoot).prepare(result.filePaths[0]);
  } catch (error) {
    return { ok: false, ...hostDetail(error, 'reference_import_preview_failed', 'The preset package could not be previewed.') };
  }
}

export async function commitReferenceImport(request: ReferenceImportCommitRequest, userDataRoot?: string): Promise<ReferenceImportCommitResultText> {
  try { return await referenceImportService(userDataRoot).commit(request); }
  catch (error) { return { ok: false, ...hostDetail(error, 'reference_import_failed', 'The import did not complete.'), imported: 0, skipped: 0, failed: 0, entries: [] }; }
}
