import { readCharacterSnapshot } from "../../src/character-snapshot";
import { validateLibraryPayload } from "../library/validation";
import { activeLibrary, activeLibraryPaths } from '../library-runtime';
import { appendLibraryArchive, inspectLibraryArchive, libraryAssetBytes, restoreLibraryArchive } from '../library-archive';
import { openBackupZip, type ReadableBackupZip } from '../data-backup-zip';
import { app, dialog, shell } from "electron";
import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type {
  AppSettings,
  DataBackupCategory,
  DataBackupCategorySummary,
  DataBackupExportRequest,
  DataBackupImportRequest,
  DataBackupImportResult,
  DataBackupInspectResult,
  DataBackupIntegrity,
  DataBackupIntegrityReason,
  DataBackupOperationResult,
  DataBackupStatus,
  HistoryGroup,
  HistoryItem,
  PositivePromptPreset,
  PromptChunk,
  ReferencePreset,
  StylePromptPreset,
  StylePromptPreviewImage,
} from "../../src/types";
import { APP_STORAGE_PREFIX, assertPromptAssemblyVersion, DEFAULT_AUGMENT_OPTIONS, DEFAULT_I2I_PARAMS, DEFAULT_PARAMS } from "../../src/types";
import {
  defaultSettings,
  librarySettings,
  readStore,
  retainKnownSettings,
  writeStore,
  type PersistedData,
  type StoredSettings,
} from "./store";
import {
  ARTIST_FAVORITE_COLLECTIONS,
  loadArtistFavoriteLibrary,
  saveArtistFavoriteCollection,
} from "./artist-favorites";
import {
  listReferencePresets,
  saveReferencePreset,
} from "./reference-presets";
import {
  reconcileStylePromptPreviewImages,
  stylePromptPreviewDirectory,
} from "./style-preset-images";
import { toLocalMediaUrl } from "./local-media-protocol";
import { positivePromptPresetStorageId } from "../../src/positive-prompt-presets";
import { hostError, type HostErrorParams } from "../host-error";
import { errorText, hostDetail, hostMessage, MAX_DETAILS, type HostDetail, type HostMessage } from "../host-message";
import { hostText } from "../host-language";

/**
 * Results the window renders in its language (step 4a): each carries a code, an English message and, where the code
 * has several cases, a reason with params and details (electron/host-message.ts). Integrity reasons keep their code
 * and add reason/params; import warnings stay English strings with warningDetails alongside.
 */
export type BackupIntegrityReason = DataBackupIntegrityReason & { reason?: string; params?: HostErrorParams };
type BackupHostText = Partial<HostMessage> & { integrityReasons?: BackupIntegrityReason[]; warningDetails?: HostDetail[] };
export type BackupOperationResult = DataBackupOperationResult & BackupHostText;
export type BackupInspectResult = DataBackupInspectResult & BackupHostText;
export type BackupImportResult = DataBackupImportResult & BackupHostText;
type BackupIntegrity = DataBackupIntegrity & { reasons: BackupIntegrityReason[] };

/** A malformed or unsupported archive: code backup_invalid_archive with the case as its reason. */
const invalidArchive = (reason: string, message: string, params?: HostErrorParams) => hostError("backup_invalid_archive", message, `backup.${reason}`, params);
const integrityReason = (code: string, message: string, categories: DataBackupCategory[], reason: string, params?: HostErrorParams): BackupIntegrityReason =>
  ({ code, message, categories, reason: `backup.${reason}`, ...(params ? { params } : {}) });
/** "<what failed>: <inner error>", with the inner error as its detail. */
const failure = (code: string, prefix: string, error: unknown, reason?: string, params?: HostErrorParams) =>
  hostMessage(code, `${prefix}: ${errorText(error)}`, reason, { ...params, detail: errorText(error) }, { detail: error });
const reasonDetails = (reasons: BackupIntegrityReason[] | undefined) => (reasons ?? []).slice(0, MAX_DETAILS).map(reason => hostDetail(reason, "backup_integrity_limited", reason.message));

type BackupZipReader=JSZip|ReadableBackupZip;
const FORMAT = "mcp-for-novelai-backup";
const FORMAT_VERSION = 1;
const MAX_JSON_BYTES = 128 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const ALL_CATEGORIES: DataBackupCategory[] = [
  "configuration",
  "apiCredentials",
  "artistLibrary",
  "referencePresets",
  "imageHistory",
  "promptPresets",
  "workspaceData",
];
const LIBRARY_CATEGORIES: DataBackupCategory[] = ["imageHistory", "artistLibrary", "referencePresets", "promptPresets"];
const WITHOUT_CREDENTIALS = ALL_CATEGORIES.filter(category => category !== "apiCredentials");
const API_SETTING_KEYS: Array<keyof StoredSettings> = [
  "apiBaseUrl",
  "imageBaseUrl",
  "allowCustomEndpoint",
  "allowCustomEndpointFallback",
];
/** Exported in data/prompt-presets.json (promptPresets), not in the configuration. */
const PRESET_SETTING_KEYS: Array<keyof StoredSettings> = ["promptTemplates"];
/** Machine-specific paths: a restored configuration never replaces this device's values. */
const DEVICE_PATH_KEYS: Array<keyof StoredSettings> = ["outputDir", "logDir", "backupDir"];

type AssetReference = {
  asset: string;
  sha256: string;
  bytes: number;
  originalName: string;
};

type PortableHistoryItem = Omit<HistoryItem, "filePath" | "fileUrl"> & {
  filePath?: string;
  fileUrl?: string;
  asset?: AssetReference;
};

type PortableReferencePreset = Omit<ReferencePreset, "filePath" | "fileUrl"> & {
  asset?: AssetReference;
};

type PortableStylePreview = Omit<StylePromptPreviewImage, "filePath" | "fileUrl"> & {
  asset?: AssetReference;
};

type PortableStylePreset = Omit<StylePromptPreset, "previewImages"> & {
  previewImages: PortableStylePreview[];
};

type PortablePositivePromptPreset = Omit<PositivePromptPreset, "previewImages"> & {
  previewImages: PortableStylePreview[];
};

type BackupManifest = {
  format: typeof FORMAT;
  version: typeof FORMAT_VERSION;
  createdAt: string;
  source: {
    platform: string;
    appVersion: string;
  };
  categories: DataBackupCategorySummary[];
  warnings?: string[];
  integrity: BackupIntegrity;
};

type BuiltArchive = {
  bytes: Buffer;
  categories: DataBackupCategorySummary[];
  warnings: string[];
  integrity: BackupIntegrity;
};
/** Why an automatic backup left image bytes out (an integrity reason of the archive). */
type ImagesSkipped = { message: string; params: HostErrorParams };

function sanitizeCategories(categories: unknown): DataBackupCategory[] {
  if (!Array.isArray(categories)) return [...ALL_CATEGORIES];
  const selected = new Set(
    categories.filter((value): value is DataBackupCategory =>
      typeof value === "string" && ALL_CATEGORIES.includes(value as DataBackupCategory)),
  );
  return ALL_CATEGORIES.filter((category) => selected.has(category));
}

function sha256(bytes: Uint8Array) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

function safeFileName(value: string, fallback = "image") {
  const parsed = path.parse(String(value ?? ""));
  const base = parsed.name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 150) || fallback;
  const extension = /^\.[a-zA-Z0-9]{1,8}$/.test(parsed.ext) ? parsed.ext.toLowerCase() : ".png";
  return `${base}${extension}`;
}

function safeFolderName(value: string, fallback = "Imported") {
  return String(value ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80) || fallback;
}

async function uniqueDestination(directory: string, requested: string) {
  const safe = safeFileName(requested);
  const parsed = path.parse(safe);
  let candidate = path.join(directory, safe);
  let index = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(directory, `${parsed.name} (${index++})${parsed.ext}`);
    } catch {
      return { filePath: candidate, renamed: index > 1 };
    }
  }
}

async function atomicWrite(filePath: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  try {
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

type Library = NonNullable<ReturnType<typeof activeLibrary>>;
/** Every history record of the library (archived ones too), as the image history category carries them. */
function libraryHistory(library: Library | undefined): HistoryItem[] {
  return library ? library.all("history").map(item => item.payload as HistoryItem) : [];
}
/** The history groups: the library's collections of the 'history' namespace. */
function libraryHistoryGroups(library: Library | undefined): HistoryGroup[] {
  return library ? library.collections("history").map(group => ({ ...group.payload, id: group.id, name: group.name }) as HistoryGroup) : [];
}

function pickSettings(settings: StoredSettings, keys: Array<keyof StoredSettings>) {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = cloneJson(settings[key]);
  return result;
}

function portableConfiguration(settings: StoredSettings) {
  const result = cloneJson(settings) as unknown as Record<string, unknown>;
  for (const key of [...API_SETTING_KEYS, ...PRESET_SETTING_KEYS]) delete result[key];
  return result;
}

async function addAsset(
  zip: JSZip,
  filePath: string | undefined,
  assetByHash: Map<string, AssetReference>,
  includeAssets: boolean,
  onMissing?: () => void,
): Promise<AssetReference | undefined> {
  if (!filePath) return undefined;
  if (!includeAssets) { onMissing?.(); return undefined; }
  let bytes: Buffer;
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ASSET_BYTES) { onMissing?.(); return undefined; }
    bytes = await fs.readFile(filePath);
  } catch {
    onMissing?.(); return undefined;
  }
  const digest = sha256(bytes);
  const existing = assetByHash.get(digest);
  if (existing) return existing;
  const extension = path.extname(filePath).toLowerCase();
  const safeExtension = /^\.[a-z0-9]{1,8}$/.test(extension) ? extension : ".bin";
  const reference: AssetReference = {
    asset: `assets/${digest}${safeExtension}`,
    sha256: digest,
    bytes: bytes.length,
    originalName: safeFileName(path.basename(filePath)),
  };
  // PNG/JPEG/WebP payloads are already compressed. Asking DEFLATE to process
  // hundreds of them again wastes CPU without a meaningful size reduction.
  zip.file(reference.asset, bytes, { binary: true, compression: "STORE" });
  assetByHash.set(digest, reference);
  return reference;
}

async function portableHistory(
  item: HistoryItem,
  zip: JSZip,
  assetByHash: Map<string, AssetReference>,
  includeAssets: boolean,
  onMissing?: () => void,
): Promise<PortableHistoryItem> {
  const { fileUrl: _fileUrl, ...stored } = cloneJson(item);
  return {
    ...stored,
    filePath: "",
    asset: await addAsset(zip, item.filePath, assetByHash, includeAssets, onMissing),
  };
}

async function portableFavorite(
  favorite: unknown,
  zip: JSZip,
  assetByHash: Map<string, AssetReference>,
  includeAssets: boolean,
  onMissing?: () => void,
) {
  const cloned = cloneJson(favorite) as Record<string, unknown>;
  const image = cloned?.image as HistoryItem | undefined;
  if (image?.filePath) cloned.image = await portableHistory(image, zip, assetByHash, includeAssets, onMissing);
  return cloned;
}

function normalizeArtistFavoriteForDesktop(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const favorite = cloneJson(value) as Record<string, unknown>;
  const nested = favorite.recipe && typeof favorite.recipe === "object"
    ? favorite.recipe as Record<string, unknown>
    : undefined;
  if (nested) {
    for (const key of [
      "id",
      "pairId",
      "variant",
      "prompt",
      "basePrompt",
      "artistPrompt",
      "artists",
      "auxiliary",
      "mutations",
      "franchiseStyles",
    ]) {
      if (favorite[key] === undefined && nested[key] !== undefined) favorite[key] = nested[key];
    }
  }

  const id = typeof favorite.id === "string" ? favorite.id.trim() : "";
  if (!id) return null;
  const prompt = String(favorite.artistPrompt ?? favorite.prompt ?? "");
  const weights = new Map<string, number>();
  const pattern = /(-?\d+(?:\.\d+)?)\s*::\s*artist\s*:\s*([^,]+?)\s*::/gi;
  for (const match of prompt.matchAll(pattern)) {
    const name = String(match[2] ?? "").trim();
    const weight = Number(match[1]);
    if (name && Number.isFinite(weight)) weights.set(name.toLowerCase().replace(/\s+/g, "_"), weight);
  }
  favorite.artists = (Array.isArray(favorite.artists) ? favorite.artists : [])
    .map((entry) => {
      if (entry && typeof entry === "object") {
        const artist = entry as Record<string, unknown>;
        const name = typeof artist.name === "string" ? artist.name.trim() : "";
        if (!name) return null;
        const rawWeight = Number(artist.weight);
        return {
          name,
          weight: Number.isFinite(rawWeight)
            ? rawWeight
            : weights.get(name.toLowerCase().replace(/\s+/g, "_")) ?? 1,
        };
      }
      const name = String(entry ?? "").trim();
      if (!name) return null;
      return {
        name,
        weight: weights.get(name.toLowerCase().replace(/\s+/g, "_")) ?? 1,
      };
    })
    .filter(Boolean);
  favorite.id = id;
  favorite.pairId = typeof favorite.pairId === "string" && favorite.pairId.trim()
    ? favorite.pairId
    : id;
  favorite.variant = favorite.variant === "mutated" ? "mutated" : "plain";
  favorite.prompt = String(favorite.prompt ?? favorite.basePrompt ?? prompt);
  favorite.basePrompt = String(favorite.basePrompt ?? favorite.prompt);
  favorite.auxiliary = Array.isArray(favorite.auxiliary) ? favorite.auxiliary : [];
  favorite.mutations = Array.isArray(favorite.mutations) ? favorite.mutations : [];
  favorite.franchiseStyles = Array.isArray(favorite.franchiseStyles) ? favorite.franchiseStyles : [];
  favorite.sequence = Number.isFinite(Number(favorite.sequence)) ? Number(favorite.sequence) : 1;
  favorite.status = ["pending", "generating", "done", "failed"].includes(String(favorite.status))
    ? favorite.status
    : "done";
  favorite.generationSeed ??= favorite.seed;
  favorite.liked = true;
  delete favorite.saving;
  return favorite;
}

/**
 * The cleaned queue records (queue retention, review rework 2026-11): what an old requestKey answers once its batch was
 * cleaned. Every backup carries them as they are (the record file and both anchors, queue-cleaned/ in the archive,
 * whatever categories were chosen); an import adds a backup's records to the ones here and never removes any (damaged
 * ones are restored only when the backup completes them). main.ts registers the queue's store.
 */
export interface QueueCleanedRecordsBackup {
  files(): Promise<Array<{ name: string; data: Buffer }>>;
  restore(files: Array<{ name: string; data: Buffer }>): Promise<{ status: string; added: number }>;
  /** After an import: the library's images are checked against the records (keys they lack are recorded as cleaned). */
  libraryRestored?(): Promise<number>;
}
export const QUEUE_CLEANED_ARCHIVE_FILES = Object.freeze(['cleaned-v1.jsonl', 'anchor-a.json', 'anchor-b.json']);
let queueCleanedRecords: QueueCleanedRecordsBackup | null = null;
export function setQueueCleanedRecordsBackup(value: QueueCleanedRecordsBackup | null) { queueCleanedRecords = value; }

function summary(category: DataBackupCategory, items = 0, bytes = 0): DataBackupCategorySummary {
  return { category, items, bytes };
}

async function buildArchive(
  requestedCategories: DataBackupCategory[],
  workspaceData?: Record<string, string>,
  options: { includeAssets?: boolean; imagesSkipped?: ImagesSkipped } = {},
): Promise<BuiltArchive> {
  const categories = sanitizeCategories(requestedCategories);
  const selected = new Set(categories);
  const zip = new JSZip();
  const data = readStore();
  const includeAssets = options.includeAssets !== false;
  const assetByHash = new Map<string, AssetReference>();
  const summaries: DataBackupCategorySummary[] = [];
  const warnings: string[] = [];
  const portableMissing = new Map<DataBackupCategory,number>();
  const noteMissing = (category:DataBackupCategory) => () => portableMissing.set(category,(portableMissing.get(category)??0)+1);
  const libraryScopeSelected = LIBRARY_CATEGORIES.every(value => selected.has(value));
  let libraryMissing = 0;
  const library = activeLibrary(), libraryPaths = activeLibraryPaths();
  if (library && libraryPaths && libraryScopeSelected) {
    const result = await appendLibraryArchive(zip, { repository: library, ...libraryPaths, assetRoots: [data.settings.outputDir], includeAssets });
    warnings.push(...result.warnings); libraryMissing = result.missing;
  }

  if (selected.has("configuration")) {
    const payload = portableConfiguration(data.settings);
    const generationParams = data.settings.lastGenerationState?.params ?? DEFAULT_PARAMS;
    zip.file("data/configuration.json", JSON.stringify(payload));
    zip.file("data/generation-params.json", JSON.stringify(generationParams));
    summaries.push(summary(
      "configuration",
      Object.keys(payload).length + Object.keys(generationParams).length,
    ));
  }

  if (selected.has("apiCredentials")) {
    const payload = {
      token: data.token ?? "",
      account: data.account ?? null,
      settings: pickSettings(data.settings, API_SETTING_KEYS),
    };
    zip.file("data/api-credentials.json", JSON.stringify(payload));
    // Count the keys actually carried, so archives stay valid when the key list changes between versions.
    summaries.push(summary("apiCredentials", Object.values(payload.settings).filter(value => value !== undefined).length + (data.token ? 1 : 0)));
  }

  if (selected.has("imageHistory")) {
    const items: PortableHistoryItem[] = [];
    for (const item of libraryHistory(library)) {
      items.push(await portableHistory(item, zip, assetByHash, includeAssets, noteMissing("imageHistory")));
    }
    zip.file("data/image-history.json", JSON.stringify({ groups: libraryHistoryGroups(library), items }));
    summaries.push(summary(
      "imageHistory",
      items.length,
      items.reduce((total, item) => total + (item.asset?.bytes ?? 0), 0),
    ));
  }

  if (selected.has("artistLibrary")) {
    const library = await loadArtistFavoriteLibrary(app.getPath("userData"));
    const collections: Record<string, unknown[]> = {};
    for (const collection of ARTIST_FAVORITE_COLLECTIONS) {
      collections[collection] = [];
      for (const favorite of library.collections[collection]) {
        collections[collection].push(await portableFavorite(favorite, zip, assetByHash, includeAssets, noteMissing("artistLibrary")));
      }
    }
    zip.file("data/artist-library.json", JSON.stringify({ ...library, collections }));
    summaries.push(summary(
      "artistLibrary",
      Object.values(collections).reduce((total, items) => total + items.length, 0),
    ));
  }

  if (selected.has("referencePresets")) {
    const library = await listReferencePresets(app.getPath("userData"));
    const presets: PortableReferencePreset[] = [];
    for (const preset of library.presets) {
      const { filePath: _filePath, fileUrl: _fileUrl, ...stored } = cloneJson(preset);
      presets.push({
        ...stored,
        asset: await addAsset(zip, preset.filePath, assetByHash, includeAssets, noteMissing("referencePresets")),
      });
    }
    zip.file("data/reference-presets.json", JSON.stringify({ groups: library.groups, presets }));
    summaries.push(summary(
      "referencePresets",
      presets.length,
      presets.reduce((total, preset) => total + (preset.asset?.bytes ?? 0), 0),
    ));
  }

  if (selected.has("promptPresets")) {
    const presets = librarySettings();
    const styles: PortableStylePreset[] = [];
    for (const preset of presets.stylePromptPresets) {
      const previewImages: PortableStylePreview[] = [];
      for (const preview of preset.previewImages ?? []) {
        const { filePath: _filePath, fileUrl: _fileUrl, ...stored } = cloneJson(preview);
        previewImages.push({
          ...stored,
          asset: await addAsset(zip, preview.filePath, assetByHash, includeAssets, noteMissing("promptPresets")),
        });
      }
      const { previewImages: _previews, ...storedPreset } = cloneJson(preset);
      styles.push({ ...storedPreset, previewImages });
    }
    const positivePrompts: PortablePositivePromptPreset[] = [];
    for (const preset of presets.positivePromptPresets) {
      const previewImages: PortableStylePreview[] = [];
      for (const preview of preset.previewImages ?? []) {
        const { filePath: _filePath, fileUrl: _fileUrl, ...stored } = cloneJson(preview);
        previewImages.push({
          ...stored,
          asset: await addAsset(zip, preview.filePath, assetByHash, includeAssets, noteMissing("promptPresets")),
        });
      }
      const { previewImages: _previews, ...storedPreset } = cloneJson(preset);
      positivePrompts.push({ ...storedPreset, previewImages });
    }
    const payload = {
      promptTemplates: data.settings.promptTemplates ?? [],
      stylePromptPresetGroups: presets.stylePromptPresetGroups,
      stylePromptPresets: styles,
      positivePromptPresets: positivePrompts,
      promptChunks: presets.promptChunks,
    };
    zip.file("data/prompt-presets.json", JSON.stringify(payload));
    summaries.push(summary(
      "promptPresets",
      payload.promptTemplates.length + styles.length + positivePrompts.length + payload.promptChunks.length,
    ));
  }

  if (selected.has("workspaceData")) {
    const owned = Object.fromEntries(
      Object.entries(workspaceData ?? {}).filter(([key, value]) =>
        key.startsWith(APP_STORAGE_PREFIX) && typeof value === "string"),
    );
    zip.file("data/workspace.json", JSON.stringify(owned));
    summaries.push(summary("workspaceData", Object.keys(owned).length));
  }

  // The cleaned queue records go with every backup (they only ever protect: restoring them never resends anything).
  if (queueCleanedRecords) {
    try { for (const file of await queueCleanedRecords.files()) if (QUEUE_CLEANED_ARCHIVE_FILES.includes(file.name)) zip.file(`queue-cleaned/${file.name}`, file.data); }
    catch (error) { warnings.push(`The cleaned queue records could not be read for the backup (${(error as any)?.code ?? 'error'}).`); }
  }
  if(libraryScopeSelected&&library&&libraryPaths){const authoritative=await unifiedCategoryStats(zip,data.settings.promptTemplates?.length??0);for(let index=0;index<summaries.length;index++){const value=authoritative.get(summaries[index].category);if(value)summaries[index]={category:summaries[index].category,...value};}}
  const integrityReasons: BackupIntegrityReason[] = [];
  if (options.imagesSkipped) { integrityReasons.push(integrityReason("auto-images-skipped",options.imagesSkipped.message,[...LIBRARY_CATEGORIES],"auto_images_skipped",options.imagesSkipped.params)); warnings.push(options.imagesSkipped.message); }
  for(const [category,count] of portableMissing){const reason=portableMissingReason(category,count);integrityReasons.push(reason);warnings.push(reason.message);}
  if (libraryScopeSelected && (!library || !libraryPaths)) integrityReasons.push(integrityReason("library-snapshot-unavailable","The material library is not active; the selected material categories have no verifiable complete snapshot.",[...LIBRARY_CATEGORIES],"library_snapshot_inactive"));
  if (libraryMissing) integrityReasons.push(libraryAssetsMissingReason(libraryMissing));
  const integrity: BackupIntegrity = {scope:"selected-categories",complete:integrityReasons.length===0,degraded:integrityReasons.length>0,reasons:integrityReasons};
  const manifest: BackupManifest = {
    format: FORMAT,
    version: FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    source: {
      platform: process.platform,
      appVersion: app.getVersion(),
    },
    categories: summaries,
    warnings,
    integrity,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  return {
    bytes: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      // Level 1 is enough for JSON and avoids a prolonged main-process CPU
      // spike. Image entries above are stored as-is.
      compressionOptions: { level: 1 },
      platform: "UNIX",
    }),
    categories: summaries,
    warnings,
    integrity,
  };
}

function configuredBackupDirectory(settings = readStore().settings) {
  const configured = String(settings.backupDir ?? "").trim();
  return configured ? path.resolve(configured) : path.join(app.getPath("userData"), "backups");
}

function stampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

const portableMissingReason = (category: DataBackupCategory, count: number) =>
  integrityReason(`portable-assets-missing:${category}`, `${count} linked file(s) of ${category} are unavailable and were not written to the archive.`, [category], "portable_assets_missing", { category, count });
const libraryAssetsMissingReason = (count: number) =>
  integrityReason("library-assets-missing", `${count} original(s) or preview(s) of the material library are unavailable and were not written to the archive.`, [...LIBRARY_CATEGORIES], "library_assets_missing", { count });

async function saveBuiltArchive(filePath: string, built: BuiltArchive) {
  await atomicWrite(filePath, built.bytes);
  const limitations = built.integrity.reasons.slice(0, 3);
  const text = built.integrity.complete
    ? hostMessage("backup_exported", "The backup of the selected categories was created completely.", "backup.exported_complete")
    : hostMessage("backup_exported", `The backup of the selected categories was created with ${built.integrity.reasons.length} limitation(s): ${limitations.map(reason => reason.message).join("; ")}`, "backup.exported_limited", { count: built.integrity.reasons.length }, { limitations: reasonDetails(limitations) });
  return {
    ok: true,
    ...text,
    path: filePath,
    categories: built.categories,
    complete: built.integrity.complete,
    degraded: built.integrity.degraded,
    integrityReasons: built.integrity.reasons,
    warnings: built.warnings,
  } satisfies BackupOperationResult;
}

async function createInternalBackup(
  prefix: "auto" | "before-import" | "manual",
  workspaceData?: Record<string, string>,
  categories = ALL_CATEGORIES,
  options: { includeAssets?: boolean; imagesSkipped?: ImagesSkipped } = {},
) {
  const directory = configuredBackupDirectory();
  await fs.mkdir(directory, { recursive: true });
  const safeCategories = prefix === "manual" ? categories : categories.filter(category=>category!=="apiCredentials");
  const built = await buildArchive(safeCategories, workspaceData, options);
  return saveBuiltArchive(
    path.join(directory, `${prefix}-${stampForFile()}.naisbackup`),
    built,
  );
}

export async function exportDataBackup(
  request: DataBackupExportRequest,
): Promise<BackupOperationResult> {
  const categories = sanitizeCategories(request.categories);
  if (!categories.length) return { ok: false, ...hostMessage("backup_no_categories", "Select at least one category of data.") };
  if (request.destination === "automatic") {
    return createInternalBackup("auto", request.workspaceData, categories.filter(category=>category!=="apiCredentials"));
  }
  if (categories.includes("apiCredentials") && request.confirmApiCredentialsExport !== true) return {ok:false,...hostMessage("backup_credentials_confirmation_required","Manually exporting the API token and third-party keys needs a separate second confirmation.")};
  if (request.destination === "internal") {
    return createInternalBackup("manual", request.workspaceData, categories);
  }
  const result = await dialog.showSaveDialog({
    title: hostText("dialog.exportBackup"),
    defaultPath: path.join(
      app.getPath("documents"),
      `MCP-for-NovelAI-${stampForFile()}.naisbackup`,
    ),
    filters: [{ name: hostText("dialog.backupFiles"), extensions: ["naisbackup"] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, cancelled: true, ...hostMessage("backup_cancelled", "The export was cancelled.", "backup.export_cancelled") };
  }
  try {
    return await saveBuiltArchive(
      result.filePath,
      await buildArchive(categories, request.workspaceData),
    );
  } catch (error: any) {
    return { ok: false, ...failure("backup_export_failed", "The export failed", error) };
  }
}

async function loadArchive(filePath: string) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw invalidArchive("file_empty", "The backup file is empty.");
  const zip=await openBackupZip(filePath);
  try{
  const manifestEntry = zip.file("manifest.json");
  if (!manifestEntry) throw invalidArchive("manifest_missing", "The backup manifest is missing.");
  const manifestText = await manifestEntry.async("string");
  if (Buffer.byteLength(manifestText) > MAX_JSON_BYTES) throw invalidArchive("manifest_too_large", "The backup manifest is too large.");
  const manifest = JSON.parse(manifestText) as BackupManifest;
  if (manifest.format !== FORMAT || manifest.version !== FORMAT_VERSION) throw invalidArchive("format_unsupported", "The backup format or version is not supported.");
  if (!Array.isArray(manifest.categories) || manifest.categories.length > ALL_CATEGORIES.length) throw invalidArchive("categories_invalid", "The backup category list is invalid.");
  const seen = new Set<DataBackupCategory>();
  for (const item of manifest.categories) {
    if (!item || typeof item !== "object" || !ALL_CATEGORIES.includes(item.category) || seen.has(item.category) || !Number.isSafeInteger(item.items) || item.items < 0 || !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw invalidArchive("categories_invalid", "The backup category list is invalid.");
    seen.add(item.category);
  }
  if (manifest.warnings !== undefined && (!Array.isArray(manifest.warnings) || manifest.warnings.length > 10000 || manifest.warnings.some(value=>typeof value!=="string"))) throw invalidArchive("warnings_invalid", "The backup warning list is invalid.");
  validatePersistedIntegrity(manifest.integrity);
  await validateArchiveCarriers(zip,manifest,manifest.categories.map(item=>item.category));
  const integrity = await assessArchiveIntegrity(zip,manifest,manifest.categories.map(item=>item.category));
  return { zip, manifest, integrity };
  }catch(error){await zip.close();throw error;}
}

function validatePersistedIntegrity(value: DataBackupIntegrity) {
  if (!value || typeof value !== "object" || value.scope !== "selected-categories" || typeof value.complete !== "boolean" || typeof value.degraded !== "boolean" || value.complete === value.degraded || !Array.isArray(value.reasons) || value.reasons.length > 1000) throw invalidArchive("integrity_invalid", "The backup integrity record is invalid.");
  for (const reason of value.reasons) if (!reason || typeof reason !== "object" || typeof reason.code !== "string" || !reason.code || typeof reason.message !== "string" || !reason.message || !Array.isArray(reason.categories) || !reason.categories.length || reason.categories.some(category=>!ALL_CATEGORIES.includes(category))) throw invalidArchive("integrity_reason_invalid", "A backup integrity reason is invalid.");
  if (value.complete !== (value.reasons.length===0)) throw invalidArchive("integrity_inconsistent", "The backup integrity verdict does not match its reasons.");
}

async function unifiedCategoryStats(zip:BackupZipReader,promptTemplates:number){
  const manifest=await readJsonEntry<any>(zip,'library/manifest.json',null);if(!manifest||!Array.isArray(manifest?.snapshot?.items)||!Array.isArray(manifest.files))throw invalidArchive('library_manifest_invalid', 'The material library manifest of the archive is invalid.');
  const heads=new Map<string,any>();for(const item of manifest.snapshot.items){const key=JSON.stringify([item?.kind,item?.id]),old=heads.get(key);if(!old||Number(item?.revision)>Number(old?.revision))heads.set(key,item);}
  const files=new Map<string,number>();for(const file of manifest.files)if(typeof file?.sourcePath==='string')files.set(file.sourcePath,typeof file.sha256==='string'&&Number.isSafeInteger(file.byteLength)?file.byteLength:0);
  const bytes=(file:unknown)=>typeof file==='string'?(files.get(file)??0):0,values=[...heads.values()];
  const histories=values.filter(item=>item.kind==='history'),artists=values.filter(item=>item.kind==='artist_favorite'),references=values.filter(item=>item.kind==='reference_preset'),prompts=values.filter(item=>['style_preset','positive_preset','prompt_chunk'].includes(item.kind));
  return new Map<DataBackupCategory,{items:number;bytes:number}>([
    ['imageHistory',{items:histories.length,bytes:histories.reduce((sum,item)=>sum+bytes(item.payload?.filePath),0)}],
    ['artistLibrary',{items:artists.length,bytes:0}],
    ['referencePresets',{items:references.length,bytes:references.reduce((sum,item)=>sum+bytes(item.payload?.filePath),0)}],
    ['promptPresets',{items:prompts.length+promptTemplates,bytes:0}],
  ]);
}

async function validateArchiveCarriers(zip:BackupZipReader,manifest:BackupManifest,requested:DataBackupCategory[]){
  const selected=new Set(sanitizeCategories(requested)),summaries=new Map(manifest.categories.map(item=>[item.category,item]));
  const unified=LIBRARY_CATEGORIES.every(category=>selected.has(category))&&!!zip.file('library/manifest.json'),authoritative=unified?await unifiedCategoryStats(zip,0):null;
  const record=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
  const payload=async(name:string)=>{const entry=zip.file(name);if(!entry||entry.dir)throw invalidArchive('carrier_missing', `A category the archive declares is missing ${name}.`, { name });const value=await readJsonEntry<any>(zip,name,null);if(!record(value))throw invalidArchive('carrier_invalid', `The top-level structure of ${name} is invalid.`, { name });return value;};
  const arrays=(value:any,names:string[],required=true)=>{for(const name of names)if(value[name]!==undefined&&!Array.isArray(value[name])||required&&value[name]===undefined)throw invalidArchive('carrier_array_invalid', `The ${name} array of an archive category is invalid.`, { name });};
  const assetBytes=(value:any)=>validAssetReference(value)?value.bytes:0;
  const check=(category:DataBackupCategory,items:number,bytes:number)=>{const promised=summaries.get(category);if(!promised||promised.items!==items||promised.bytes!==bytes)throw invalidArchive('count_mismatch', `The manifest counts of ${category} do not match the data the archive carries.`, { category });};
  if(selected.has('configuration')){const value=await payload('data/configuration.json');const params=await payload('data/generation-params.json');check('configuration',Object.keys(value).length+Object.keys(params).length,0);}
  if(selected.has('apiCredentials')){const value=await payload('data/api-credentials.json');if(value.token!==undefined&&typeof value.token!=='string'||value.account!==undefined&&value.account!==null&&!record(value.account)||!record(value.settings))throw invalidArchive('credentials_invalid', 'The API credentials structure is invalid.');check('apiCredentials',Object.keys(value.settings??{}).length+(value.token?1:0),0);}
  if(selected.has('imageHistory')){if(!unified){const value=await payload('data/image-history.json');arrays(value,['groups','items']);check('imageHistory',(value.items??[]).length,(value.items??[]).reduce((sum:number,item:any)=>sum+assetBytes(item?.asset),0));}else{const value=authoritative!.get('imageHistory')!;check('imageHistory',value.items,value.bytes);}}
  if(selected.has('artistLibrary')){if(!unified){const value=await payload('data/artist-library.json');if(!record(value.collections))throw invalidArchive('artist_collections_invalid', 'The artist favorite collections structure is invalid.');let items=0;for(const entries of Object.values(value.collections))if(!Array.isArray(entries))throw invalidArchive('artist_collection_array_invalid', 'An artist favorite collection array is invalid.');else items+=entries.length;check('artistLibrary',items,0);}else{const value=authoritative!.get('artistLibrary')!;check('artistLibrary',value.items,value.bytes);}}
  if(selected.has('referencePresets')){if(!unified){const value=await payload('data/reference-presets.json');arrays(value,['groups','presets']);check('referencePresets',(value.presets??[]).length,(value.presets??[]).reduce((sum:number,item:any)=>sum+assetBytes(item?.asset),0));}else{const value=authoritative!.get('referencePresets')!;check('referencePresets',value.items,value.bytes);}}
  if(selected.has('promptPresets')){const value=await payload('data/prompt-presets.json');if(unified){arrays(value,['promptTemplates'],true);for(const name of ['stylePromptPresetGroups','stylePromptPresets','positivePromptPresets','promptChunks'])if(value[name]!==undefined&&!Array.isArray(value[name]))throw invalidArchive('carrier_array_invalid', `The ${name} array of an archive category is invalid.`, { name });const stats=authoritative!.get('promptPresets')!;check('promptPresets',value.promptTemplates.length+stats.items,stats.bytes);}else{arrays(value,['promptTemplates','stylePromptPresetGroups','stylePromptPresets','positivePromptPresets','promptChunks']);check('promptPresets',(value.promptTemplates?.length??0)+(value.stylePromptPresets?.length??0)+(value.positivePromptPresets?.length??0)+(value.promptChunks?.length??0),0);}}
  if(selected.has('workspaceData')){const value=await payload('data/workspace.json');if(Object.values(value).some(entry=>typeof entry!=='string'))throw invalidArchive('workspace_invalid', 'The workspace data structure is invalid.');check('workspaceData',Object.keys(value).length,0);}
}

async function assessArchiveIntegrity(zip: BackupZipReader, manifest: BackupManifest, requested: DataBackupCategory[]): Promise<BackupIntegrity> {
  const scope = new Set(sanitizeCategories(requested));
  const fullLibraryScope = LIBRARY_CATEGORIES.every(category=>scope.has(category));
  const reasons = new Map<string,BackupIntegrityReason>();
  const libraryOnly = new Set(["library-snapshot-unavailable","library-assets-missing"]);
  const add = (reason:BackupIntegrityReason) => {if(!fullLibraryScope&&libraryOnly.has(reason.code))return;const categories=reason.categories.filter(category=>scope.has(category));if(categories.length)reasons.set(reason.code,{...reason,categories});};
  for (const reason of manifest.integrity.reasons) add(reason);
  for(const [category,count] of await inspectPortableAssets(zip,scope))add(portableMissingReason(category,count));
  if (fullLibraryScope) {
    const library = await inspectLibraryArchive(zip);
    if (!library.present) add(integrityReason("library-snapshot-unavailable","The selected material categories have no material library snapshot; their versions cannot be proven complete.",[...LIBRARY_CATEGORIES],"library_snapshot_missing"));
    if (library.missing) add(libraryAssetsMissingReason(library.missing));
  }
  const values=[...reasons.values()];
  return {scope:"selected-categories",complete:values.length===0,degraded:values.length>0,reasons:values};
}

async function readJsonEntry<T>(zip: BackupZipReader, entryName: string, fallback: T): Promise<T> {
  const entry = zip.file(entryName);
  if (!entry) return fallback;
  const text = await entry.async("string");
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw invalidArchive('entry_too_large', `${entryName} is too large.`, { name: entryName });
  return JSON.parse(text) as T;
}

export async function inspectDataBackup(): Promise<BackupInspectResult> {
  const result = await dialog.showOpenDialog({
    title: hostText("dialog.chooseBackup"),
    properties: ["openFile"],
    filters: [
      { name: hostText("dialog.backupFiles"), extensions: ["naisbackup", "zip"] },
    ],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, cancelled: true, categories: [], ...hostMessage("backup_cancelled", "The import was cancelled.", "backup.import_cancelled") };
  }
  try {
    const { manifest, integrity, zip } = await loadArchive(result.filePaths[0]);
    await zip.close();
    return {
      ok: true,
      path: result.filePaths[0],
      formatVersion: manifest.version,
      createdAt: manifest.createdAt,
      sourcePlatform: manifest.source?.platform,
      appVersion: manifest.source?.appVersion,
      categories: manifest.categories,
      requiresConfigurationConfirmation: manifest.categories.some((item) =>
        item.category === "configuration" || item.category === "apiCredentials"),
      complete:integrity.complete,degraded:integrity.degraded,integrityReasons:integrity.reasons,warnings:[...(manifest.warnings??[])],
    };
  } catch (error: any) {
    return { ok: false, categories: [], ...failure("backup_read_failed", "Could not read the backup", error) };
  }
}

function validAssetReference(value: unknown): value is AssetReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<AssetReference>;
  return typeof ref.asset === "string"
    && /^assets\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(ref.asset)
    && !ref.asset.includes("..")
    && typeof ref.sha256 === "string"
    && /^[a-f0-9]{64}$/.test(ref.sha256)
    && Number.isFinite(ref.bytes)
    && Number(ref.bytes) > 0
    && Number(ref.bytes) <= MAX_ASSET_BYTES;
}

async function backupEntryBuffer(entry:any):Promise<Buffer>{const value=await entry.async('nodebuffer');return Buffer.isBuffer(value)?value:Buffer.from(value as ArrayBuffer);}

async function readAsset(zip: BackupZipReader, value: unknown) {
  if (!validAssetReference(value)) return null;
  const entry = zip.file(value.asset);
  if (!entry) return null;
  const bytes=await backupEntryBuffer(entry);
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.length !== value.bytes || sha256(bytes) !== value.sha256) {
    throw invalidArchive('asset_checksum_failed', `Asset size or checksum check failed: ${value.originalName || value.asset}`, { name: value.originalName || value.asset });
  }
  return { bytes, reference: value };
}

async function inspectPortableAssets(zip:BackupZipReader,scope:Set<DataBackupCategory>){
  const missing=new Map<DataBackupCategory,number>(),object=(value:any)=>value&&typeof value==='object'&&!Array.isArray(value);
  const check=async(category:DataBackupCategory,expected:boolean,reference:unknown)=>{if(!expected||!scope.has(category))return;if(!await readAsset(zip,reference))missing.set(category,(missing.get(category)??0)+1);};
  if(scope.has('imageHistory')){const payload=await readJsonEntry<any>(zip,'data/image-history.json',{});for(const item of Array.isArray(payload?.items)?payload.items:[])await check('imageHistory',object(item),item?.asset);}
  if(scope.has('referencePresets')){const payload=await readJsonEntry<any>(zip,'data/reference-presets.json',{});for(const preset of Array.isArray(payload?.presets)?payload.presets:[])await check('referencePresets',object(preset),preset?.asset);}
  if(scope.has('promptPresets')){const payload=await readJsonEntry<any>(zip,'data/prompt-presets.json',{});for(const preset of [...(Array.isArray(payload?.stylePromptPresets)?payload.stylePromptPresets:[]),...(Array.isArray(payload?.positivePromptPresets)?payload.positivePromptPresets:[])])for(const preview of Array.isArray(preset?.previewImages)?preset.previewImages:[])await check('promptPresets',object(preview),preview?.asset);}
  if(scope.has('artistLibrary')){const payload=await readJsonEntry<any>(zip,'data/artist-library.json',{});if(object(payload?.collections))for(const values of Object.values(payload.collections))for(const favorite of Array.isArray(values)?values:[])await check('artistLibrary',object((favorite as any)?.image),(favorite as any)?.image?.asset);}
  return missing;
}

async function historyHashIndex(items: HistoryItem[]) {
  const index = new Map<string, HistoryItem>();
  for (const item of items) {
    const digest = await sha256File(item.filePath);
    if (digest && !index.has(digest)) index.set(digest, item);
  }
  return index;
}

function mergeGroups(existing: HistoryGroup[], incoming: HistoryGroup[]) {
  const groups = [...existing];
  const byId = new Map(groups.map((group) => [group.id, group]));
  const byName = new Map(groups.map((group) => [group.name.trim().toLocaleLowerCase(), group]));
  const idMap = new Map<string, string>();
  for (const raw of incoming) {
    if (!raw || typeof raw.name !== "string" || !raw.name.trim()) continue;
    const name = raw.name.trim().slice(0, 120);
    const matched = byName.get(name.toLocaleLowerCase());
    if (matched) {
      idMap.set(raw.id, matched.id);
      continue;
    }
    let id = typeof raw.id === "string" && raw.id && !byId.has(raw.id) ? raw.id : randomUUID();
    if (byId.has(id)) id = randomUUID();
    const group: HistoryGroup = {
      id,
      name,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    };
    groups.push(group);
    byId.set(id, group);
    byName.set(name.toLocaleLowerCase(), group);
    idMap.set(raw.id, id);
  }
  return { groups, idMap };
}

function dateFolder(value: unknown) {
  const date = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : new Date().toISOString().slice(0, 10);
}

function safeHistoryShape(raw: PortableHistoryItem): Omit<HistoryItem, "id" | "filePath" | "fileUrl" | "groupId"> {
  return {
    date: dateFolder(raw.date),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    params: raw.params && typeof raw.params === "object" ? raw.params : cloneJson(DEFAULT_PARAMS),
    actualSeed: Number.isFinite(Number(raw.actualSeed)) ? Number(raw.actualSeed) : 0,
    model: String(raw.model ?? "unknown"),
    width: Math.max(0, Math.trunc(Number(raw.width) || 0)),
    height: Math.max(0, Math.trunc(Number(raw.height) || 0)),
    feature: typeof raw.feature === "string" ? raw.feature : undefined,
    ...(Object.hasOwn(raw, "characterSnapshot") ? { characterSnapshot: readCharacterSnapshot(raw.characterSnapshot) } : {}),
    ...(Array.isArray(raw.characterPrompts) ? { characterPrompts: [...raw.characterPrompts] } : {}),
  };
}

/**
 * A per-category import (without the unified library archive) and Recently Deleted: identities in Recently Deleted are never imported again
 * (like the unified library archive, they count as existing and are reported), and the image files this import wrote
 * for records it had not saved yet are removed again if it stops.
 */
interface LegacyImportGuard {
  trashed: Record<'history' | 'artist_favorite' | 'style_preset' | 'positive_preset' | 'prompt_chunk', Set<string>>;
  /** How many records were skipped because their identity is in Recently Deleted. */
  inTrash: number;
  /** Files this import created, in the order written. */
  written: string[];
  /** Folders this import created ({ top: first new folder, leaf }), removed again on an abort if empty. */
  folders: Array<{ top: string; leaf: string }>;
}
function legacyImportGuard(library: ReturnType<typeof activeLibrary>): LegacyImportGuard {
  const ids = (kind: 'history' | 'artist_favorite' | 'style_preset' | 'positive_preset' | 'prompt_chunk') => library?.trashedIds(kind) ?? new Set<string>();
  return { trashed: { history: ids('history'), artist_favorite: ids('artist_favorite'), style_preset: ids('style_preset'), positive_preset: ids('positive_preset'), prompt_chunk: ids('prompt_chunk') }, inTrash: 0, written: [], folders: [] };
}
/**
 * The first folder `fs.mkdir(folder, { recursive: true })` created, as a plain absolute path, or undefined. On Windows
 * Node returns it in its long-path form (\\?\C:\…, \\?\UNC\server\share\…), which never equals the folder asked for.
 */
export function createdFolderPath(created: string | undefined) {
  if (!created) return undefined;
  if (created.startsWith("\\\\?\\UNC\\")) return path.resolve(`\\\\${created.slice(8)}`);
  if (created.startsWith("\\\\?\\")) return path.resolve(created.slice(4));
  return path.resolve(created);
}
const sameOrInside = (folder: string, top: string) => { const relative = path.relative(top, folder); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); };
/** Removes files an aborted import wrote and nothing in the library uses, then the folders it created that are empty now. */
async function removeUnsavedImports(library: ReturnType<typeof activeLibrary>, guard: LegacyImportGuard) {
  if (!library || !guard.written.length) return 0;
  const owners = library.fileOwners(guard.written);
  let removed = 0;
  for (const file of guard.written) {
    if (owners.get(file)?.size) continue;
    try { await fs.unlink(file); removed += 1; } catch { /* already gone or not removable; nothing else is touched */ }
  }
  // Never above the first folder the import created: the output folder and its parents stay, also when empty.
  for (const { top, leaf } of [...guard.folders].reverse()) {
    for (let folder = path.resolve(leaf); sameOrInside(folder, top); folder = path.dirname(folder)) {
      try { await fs.rmdir(folder); } catch { break; /* not empty (something else is there) or gone */ }
      if (folder === top || path.dirname(folder) === folder) break;
    }
  }
  return removed;
}
const inTrashNotice = (count: number) => hostMessage("backup_warning", `${count} item(s) are in Recently Deleted and were not imported from the backup; restore them from Recently Deleted when needed.`, "backup.in_trash", { count });

/**
 * What a per-category import (without the unified library archive) adds to the library: it starts as the library's
 * current records, the restore functions add to it, and commitStagedLibrary writes what was added or changed in one
 * transaction once every selected category has been read. An import never removes or archives anything.
 */
interface StagedLibrary {
  history: HistoryItem[];
  historyGroups: HistoryGroup[];
  stylePromptPresets: StylePromptPreset[];
  stylePromptPresetGroups: string[];
  positivePromptPresets: PositivePromptPreset[];
  promptChunks: PromptChunk[];
}
function stagedLibrary(library: Library): StagedLibrary {
  return cloneJson({ history: libraryHistory(library), historyGroups: libraryHistoryGroups(library), ...librarySettings() });
}
const STAGED_KIND_NAMES = { history: "history record", style_preset: "style preset", positive_preset: "positive prompt preset", prompt_chunk: "prompt chunk" } as const;
type StagedKind = keyof typeof STAGED_KIND_NAMES;
/** Refuses a record the import would write that is not a valid stored record, naming it and the field. */
function checkImportedRecord(kind: StagedKind, value: unknown) {
  try { validateLibraryPayload(kind, value); }
  catch (error) {
    const id = value && typeof value === "object" ? JSON.stringify((value as { id?: unknown }).id) ?? "(none)" : "(none)";
    throw hostError("backup_invalid_record", `The ${STAGED_KIND_NAMES[kind]} ${id} in the backup is not a valid material record; no material was written: ${errorText(error)}`, `backup.invalid_record.${kind}`, { id, detail: errorText(error) });
  }
}
function commitStagedLibrary(library: Library, staged: StagedLibrary) {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  // What the import adds or changes: every one of these records is checked before the first write.
  const writes: Array<{ kind: StagedKind; value: { id: string }; revision: number }> = [];
  for (const [kind, values] of [["history", staged.history], ["style_preset", staged.stylePromptPresets], ["positive_preset", staged.positivePromptPresets], ["prompt_chunk", staged.promptChunks]] as Array<[StagedKind, Array<{ id: string }>]>) {
    // A list read before an item went to Recently Deleted must not bring it back.
    const deleted = library.trashedIds(kind);
    for (const value of values) {
      if (deleted.has(value.id)) continue;
      // An identity the library cannot hold is no current item: the record is new (and its check names the field).
      let old: ReturnType<Library["get"]> = null;
      try { old = library.get(kind, value.id); } catch { old = null; }
      if (old && same(old.payload, value)) continue;
      writes.push({ kind, value, revision: old?.revision ?? 0 });
    }
  }
  for (const write of writes) checkImportedRecord(write.kind, write.value);
  // Announced as an unknown change: the same import also replaces settings the renderer re-reads on a library change.
  library.transaction(() => {
    for (const group of staged.historyGroups) {
      const old = library.collections("history").find(value => value.id === group.id);
      if (!old || old.name !== group.name || !same(old.payload, group)) library.putCollection({ namespace: "history", id: group.id, name: group.name, payload: group });
    }
    for (const write of writes) library.put(write.kind, write.value.id, write.value, { expectedRevision: write.revision });
    for (const name of staged.stylePromptPresetGroups) if (!library.collections("style").some(old => old.name === name)) library.putCollection({ namespace: "style", id: name, name, payload: {} });
  }, { unknownChange: true });
}

async function restoreHistoryItem(
  zip: ReadableBackupZip,
  raw: PortableHistoryItem,
  state: {
    library: StagedLibrary;
    outputDir: string;
    groupIdMap: Map<string, string>;
    historyByHash: Map<string, HistoryItem>;
    historyBySourceId: Map<string, HistoryItem>;
    importedIds: Set<string>;
    imported: { count: number; skipped: number; renamed: number };
    guard: LegacyImportGuard;
  },
  /** A top-level history record (not the image inside a favorite): in Recently Deleted it is skipped. */
  topLevel = false,
) {
  if (topLevel && typeof raw.id === "string" && state.guard.trashed.history.has(raw.id)) {
    state.imported.skipped += 1;
    state.guard.inTrash += 1;
    return null;
  }
  const asset = await readAsset(zip, raw.asset);
  if (!asset) {
    state.imported.skipped += 1;
    return null;
  }
  const duplicate = state.historyByHash.get(asset.reference.sha256);
  if (duplicate) {
    state.imported.skipped += 1;
    if (typeof raw.id === "string") state.historyBySourceId.set(raw.id, duplicate);
    return duplicate;
  }
  const groupId = raw.groupId ? state.groupIdMap.get(raw.groupId) : undefined;
  const group = groupId ? state.library.historyGroups.find((item) => item.id === groupId) : undefined;
  const folder = group
    ? path.join(state.outputDir, dateFolder(raw.date), safeFolderName(group.name, "group"))
    : path.join(state.outputDir, dateFolder(raw.date));
  const createdFolder = createdFolderPath(await fs.mkdir(folder, { recursive: true }));
  if (createdFolder) state.guard.folders.push({ top: createdFolder, leaf: folder });
  const destination = await uniqueDestination(folder, asset.reference.originalName);
  await atomicWrite(destination.filePath, asset.bytes);
  state.guard.written.push(destination.filePath);
  if (destination.renamed) state.imported.renamed += 1;
  let id = typeof raw.id === "string" && raw.id && !state.importedIds.has(raw.id)
    ? raw.id
    : randomUUID();
  if (state.importedIds.has(id)) id = randomUUID();
  state.importedIds.add(id);
  const item: HistoryItem = {
    id,
    filePath: destination.filePath,
    fileUrl: toLocalMediaUrl(destination.filePath),
    groupId,
    ...safeHistoryShape(raw),
  };
  state.library.history.push(item);
  state.historyByHash.set(asset.reference.sha256, item);
  if (typeof raw.id === "string") state.historyBySourceId.set(raw.id, item);
  state.imported.count += 1;
  return item;
}

function uniqueLabel(existing: Set<string>, requested: string) {
  const base = String(requested ?? "").trim().slice(0, 120) || "Imported";
  let candidate = base;
  let index = 1;
  while (existing.has(candidate.toLocaleLowerCase())) candidate = `${base} (${index++})`;
  existing.add(candidate.toLocaleLowerCase());
  return { value: candidate, renamed: candidate !== base };
}

async function restoreArtistLibrary(
  zip: ReadableBackupZip,
  payload: { collections?: Record<string, unknown[]> },
  storeState: Parameters<typeof restoreHistoryItem>[2],
  counters: { count: number; skipped: number; renamed: number },
) {
  const existing = await loadArtistFavoriteLibrary(app.getPath("userData"));
  for (const collection of ARTIST_FAVORITE_COLLECTIONS) {
    const current = [...existing.collections[collection]] as Array<Record<string, unknown>>;
    const ids = new Set(current.map((item) => String(item?.id ?? "")).filter(Boolean));
    for (const rawValue of payload.collections?.[collection] ?? []) {
      const favorite = normalizeArtistFavoriteForDesktop(rawValue);
      const incomingId = favorite?.id as string | undefined;
      if (!favorite || !incomingId || ids.has(incomingId)) {
        counters.skipped += 1;
        continue;
      }
      if (storeState.guard.trashed.artist_favorite.has(`${collection}:${incomingId}`)) {
        counters.skipped += 1;
        storeState.guard.inTrash += 1;
        continue;
      }
      const image = favorite.image as PortableHistoryItem | undefined;
      if (image?.asset) favorite.image = await restoreHistoryItem(zip, image, storeState) ?? undefined;
      current.push(favorite);
      ids.add(incomingId);
      counters.count += 1;
    }
    await saveArtistFavoriteCollection(app.getPath("userData"), collection, current);
  }
}

async function restoreReferencePresets(
  zip: ReadableBackupZip,
  payload: { groups?: string[]; presets?: PortableReferencePreset[] },
  counters: { count: number; skipped: number; renamed: number },
) {
  const existing = await listReferencePresets(app.getPath("userData"));
  const hashes = new Set<string>();
  for (const preset of existing.presets) {
    const digest = await sha256File(preset.filePath);
    if (digest) hashes.add(digest);
  }
  const names = new Set(existing.presets.map((preset) => preset.name.toLocaleLowerCase()));
  for (const raw of Array.isArray(payload.presets) ? payload.presets : []) {
    const asset = await readAsset(zip, raw.asset);
    if (!asset || hashes.has(asset.reference.sha256)) {
      counters.skipped += 1;
      continue;
    }
    const name = uniqueLabel(names, raw.name);
    if (name.renamed) counters.renamed += 1;
    const result = await saveReferencePreset({
      name: name.value,
      group: typeof raw.group === "string" ? raw.group : "",
      kind: raw.kind === "precise" ? "precise" : "vibe",
      base64: asset.bytes.toString("base64"),
      extension: path.extname(asset.reference.originalName),
      infoExtracted: raw.infoExtracted,
      strength: raw.strength,
      preciseType: raw.preciseType,
      fidelity: raw.fidelity,
      informationExtracted: raw.informationExtracted,
      width: raw.width,
      height: raw.height,
      sourceId: raw.sourceId,
      sourceNames: raw.sourceNames,
      sourceGameNames: raw.sourceGameNames,
      sourceGameId: raw.sourceGameId,
      sourceCategory: raw.sourceCategory,
    }, app.getPath("userData"));
    if (result.ok) {
      hashes.add(asset.reference.sha256);
      counters.count += 1;
    } else {
      counters.skipped += 1;
    }
  }
}

async function restoreStylePreviews(
  zip: ReadableBackupZip,
  presetId: string,
  existing: StylePromptPreviewImage[],
  incoming: PortableStylePreview[],
  counters: { count: number; skipped: number; renamed: number },
  guard?: LegacyImportGuard,
) {
  const previews = reconcileStylePromptPreviewImages(presetId, existing, app.getPath("userData"));
  const hashes = new Set<string>();
  for (const preview of previews) {
    const digest = await sha256File(preview.filePath);
    if (digest) hashes.add(digest);
  }
  const directory = stylePromptPreviewDirectory(presetId, app.getPath("userData"));
  const createdFolder = createdFolderPath(await fs.mkdir(directory, { recursive: true }));
  if (createdFolder) guard?.folders.push({ top: createdFolder, leaf: directory });
  for (const raw of incoming) {
    if (previews.length >= 3) break;
    const asset = await readAsset(zip, raw.asset);
    if (!asset || hashes.has(asset.reference.sha256)) {
      counters.skipped += 1;
      continue;
    }
    const extension = path.extname(asset.reference.originalName).toLowerCase() || ".png";
    const id = randomUUID();
    const filePath = path.join(directory, `${id}${extension}`);
    await atomicWrite(filePath, asset.bytes);
    guard?.written.push(filePath);
    previews.push({
      id,
      name: safeFileName(raw.name || asset.reference.originalName),
      filePath,
      fileUrl: toLocalMediaUrl(filePath),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    });
    hashes.add(asset.reference.sha256);
    counters.count += 1;
  }
  return reconcileStylePromptPreviewImages(presetId, previews, app.getPath("userData"));
}

async function restorePromptPresets(
  zip: ReadableBackupZip,
  payload: {
    promptTemplates?: AppSettings["promptTemplates"];
    stylePromptPresetGroups?: string[];
    stylePromptPresets?: PortableStylePreset[];
    positivePromptPresets?: PortablePositivePromptPreset[];
    promptChunks?: PromptChunk[];
  },
  settings: StoredSettings,
  /** The library records to add presets to; null when only the prompt templates are restored (the unified archive restores the presets). */
  library: StagedLibrary | null,
  counters: { count: number; skipped: number; renamed: number },
  guard?: LegacyImportGuard,
) {
  /** A preset or chunk whose identity is in Recently Deleted is not imported again. */
  const inTrash = (kind: 'style_preset' | 'positive_preset' | 'prompt_chunk', id: unknown) => {
    if (!guard || typeof id !== "string" || !guard.trashed[kind].has(id)) return false;
    counters.skipped += 1; guard.inTrash += 1; return true;
  };
  const promptTemplates = [...(settings.promptTemplates ?? [])];
  const promptIdentity = new Set(promptTemplates.map((item) =>
    [item.name, item.prefix, item.suffix, item.negativePrompt].join("\u241f")));
  const promptNames = new Set(promptTemplates.map((item) => item.name.toLocaleLowerCase()));
  const promptIds = new Set(promptTemplates.map((item) => item.id));
  for (const raw of payload.promptTemplates ?? []) {
    const identity = [raw.name, raw.prefix, raw.suffix, raw.negativePrompt].join("\u241f");
    const existingBySourceId = raw.id
      ? promptTemplates.find((item) =>
          item.id === raw.id
          && item.prefix === raw.prefix
          && item.suffix === raw.suffix
          && item.negativePrompt === raw.negativePrompt)
      : undefined;
    if (promptIdentity.has(identity) || existingBySourceId) {
      counters.skipped += 1;
      continue;
    }
    const name = uniqueLabel(promptNames, raw.name);
    if (name.renamed) counters.renamed += 1;
    const id = raw.id && !promptIds.has(raw.id) ? raw.id : randomUUID();
    promptIds.add(id);
    promptIdentity.add(identity);
    promptTemplates.push({ ...cloneJson(raw), id, name: name.value });
    counters.count += 1;
  }

  settings.promptTemplates = promptTemplates;
  if (!library) return;

  const styles = [...library.stylePromptPresets];
  const styleNames = new Set(styles.map((item) => item.name.toLocaleLowerCase()));
  const styleIds = new Set(styles.map((item) => item.id));
  for (const raw of payload.stylePromptPresets ?? []) {
    if (!raw || typeof raw.name !== "string" || typeof raw.prompt !== "string") continue;
    let target = styles.find((item) =>
      item.prompt === raw.prompt
      && (item.name === raw.name || (Boolean(raw.id) && item.id === raw.id)));
    if (!target && inTrash('style_preset', raw.id)) continue;
    if (!target) {
      const name = uniqueLabel(styleNames, raw.name);
      if (name.renamed) counters.renamed += 1;
      const id = raw.id && !styleIds.has(raw.id) ? raw.id : randomUUID();
      styleIds.add(id);
      target = {
        id,
        name: name.value,
        prompt: raw.prompt,
        group: String(raw.group || "Default"),
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        previewImages: [],
      };
      // Checked before its preview files are written (commitStagedLibrary checks the whole record again).
      checkImportedRecord("style_preset", target);
      styles.push(target);
      counters.count += 1;
    }
    target.previewImages = await restoreStylePreviews(
      zip,
      target.id,
      target.previewImages ?? [],
      Array.isArray(raw.previewImages) ? raw.previewImages : [],
      counters,
      guard,
    );
  }
  library.stylePromptPresets = styles;
  library.stylePromptPresetGroups = Array.from(new Set([
    "Default",
    ...library.stylePromptPresetGroups,
    ...(payload.stylePromptPresetGroups ?? []).filter((value) => typeof value === "string" && value.trim()),
    ...styles.map((item) => item.group).filter(Boolean),
  ]));

  const positivePrompts = [...library.positivePromptPresets];
  const positiveNames = new Set(positivePrompts.map((item) => item.name.toLocaleLowerCase()));
  const positiveIds = new Set(positivePrompts.map((item) => item.id));
  for (const raw of payload.positivePromptPresets ?? []) {
    if (!raw || typeof raw.name !== "string" || typeof raw.prompt !== "string" || !raw.prompt.trim()) {
      continue;
    }
    let target = positivePrompts.find((item) =>
      item.prompt === raw.prompt
      && (item.name === raw.name || (Boolean(raw.id) && item.id === raw.id)));
    if (!target && inTrash('positive_preset', raw.id)) continue;
    if (!target) {
      const name = uniqueLabel(positiveNames, raw.name);
      if (name.renamed) counters.renamed += 1;
      const id = raw.id && !positiveIds.has(raw.id) ? raw.id : randomUUID();
      positiveIds.add(id);
      target = {
        id,
        name: name.value,
        prompt: raw.prompt,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        previewImages: [],
      };
      // Checked before its preview files are written (commitStagedLibrary checks the whole record again).
      checkImportedRecord("positive_preset", target);
      positivePrompts.push(target);
      counters.count += 1;
    }
    target.previewImages = await restoreStylePreviews(
      zip,
      positivePromptPresetStorageId(target.id),
      target.previewImages ?? [],
      Array.isArray(raw.previewImages) ? raw.previewImages : [],
      counters,
      guard,
    );
  }
  library.positivePromptPresets = positivePrompts;

  const promptChunks = [...library.promptChunks];
  const promptChunkNames = new Set(promptChunks.map((item) => item.name.toLocaleLowerCase()));
  const promptChunkIds = new Set(promptChunks.map((item) => item.id));
  for (const raw of payload.promptChunks ?? []) {
    if (!raw || typeof raw.name !== "string" || typeof raw.content !== "string" || !raw.content.trim()) continue;
    if (promptChunks.some((item) => item.name === raw.name && item.content === raw.content)) {
      counters.skipped += 1;
      continue;
    }
    if (inTrash('prompt_chunk', raw.id)) continue;
    const name = uniqueLabel(promptChunkNames, raw.name.trim() || raw.content.trim().slice(0, 18));
    if (name.renamed) counters.renamed += 1;
    const id = raw.id && !promptChunkIds.has(raw.id) ? raw.id : randomUUID();
    promptChunkIds.add(id);
    promptChunks.push({
      id,
      name: name.value,
      content: raw.content.trim(),
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    });
    counters.count += 1;
  }
  library.promptChunks = promptChunks;
}

function defaultImportedGenerationState(): NonNullable<AppSettings["lastGenerationState"]> {
  return {
    params: cloneJson(DEFAULT_PARAMS),
    batchCount: 1,
    i2iParams: cloneJson(DEFAULT_I2I_PARAMS),
    inpaintModel: "nai-diffusion-5-full-inpainting" as const,
    inpaintStrength: 1,
    inpaintNoise: 0,
    inpaintPositivePrompt: "",
    brushSize: 4,
    brushOpacity: 0.55,
    brushColor: "#ffffff",
    brushShape: "round" as const,
    brushSizeUnit: "grid8" as const,
    upscaleScale: 4 as const,
    directorTool: "bg-removal" as const,
    augmentOptions: cloneJson(DEFAULT_AUGMENT_OPTIONS),
  };
}

function mergedImportedGenerationState(
  configured: AppSettings["lastGenerationState"],
  current: AppSettings["lastGenerationState"],
  incomingParams: Record<string, unknown> | null | undefined,
): AppSettings["lastGenerationState"] {
  if (!incomingParams || typeof incomingParams !== "object" || Array.isArray(incomingParams)) return configured;
  const previous = configured ?? current ?? defaultImportedGenerationState();
  const restoredParams = {
    ...cloneJson(DEFAULT_PARAMS),
    ...cloneJson(incomingParams),
  } as typeof previous.params;
  if (!Object.hasOwn(incomingParams, "promptAssemblyVersion")) delete restoredParams.promptAssemblyVersion;
  return { ...previous, params: restoredParams };
}

function assertImportedGenerationState(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const state = value as { params?: unknown; inpaintRecipe?: unknown; charCaptions?: unknown };
  if (Object.hasOwn(state, "charCaptions")) readCharacterSnapshot({ version: 1, captions: state.charCaptions });
  assertPromptAssemblyVersion(state.params);
  if (state.inpaintRecipe !== null && state.inpaintRecipe !== undefined) {
    assertPromptAssemblyVersion(state.inpaintRecipe);
  }
}

export async function importDataBackup(
  request: DataBackupImportRequest,
): Promise<BackupImportResult> {
  const categories = sanitizeCategories(request.categories);
  const requiresConfirmation = categories.includes("configuration") || categories.includes("apiCredentials");
  if (requiresConfirmation && request.confirmConfigurationOverwrite !== true) {
    return {
      ok: false,
      ...hostMessage("backup_configuration_confirmation_required", "Configuration and API data need a second confirmation before they are overwritten."),
      imported: 0,
      skipped: 0,
      renamed: 0,
    };
  }
  if (!categories.length) {
    return { ok: false, ...hostMessage("backup_no_categories", "Select at least one category of data."), imported: 0, skipped: 0, renamed: 0 };
  }

  let archive: Awaited<ReturnType<typeof loadArchive>>;
  try {
    archive = await loadArchive(request.path);
  } catch (error: any) {
    return { ok: false, ...failure("backup_read_failed", "Could not read the backup", error), imported: 0, skipped: 0, renamed: 0 };
  }
  try{
  const availableCategories=new Set(archive.manifest.categories.map(item=>item.category));
  if(categories.some(category=>!availableCategories.has(category)))return{ok:false,...hostMessage("backup_category_unavailable","A selected import category is not in the archive manifest."),imported:0,skipped:0,renamed:0};
  let importIntegrity: BackupIntegrity;
  try { importIntegrity=await assessArchiveIntegrity(archive.zip,archive.manifest,categories); }
  catch(error:any){return{ok:false,...failure("backup_integrity_check_failed","Could not verify the backup integrity",error),imported:0,skipped:0,renamed:0};}
  if(importIntegrity.degraded&&request.confirmDegradedImport!==true)return{ok:false,...hostMessage("backup_degraded_confirmation_required",`The selected import scope has limitations; confirm the degraded import explicitly: ${importIntegrity.reasons.map(reason=>reason.message).join('; ')}`,undefined,{count:importIntegrity.reasons.length},{reasons:reasonDetails(importIntegrity.reasons)}),imported:0,skipped:0,renamed:0,complete:false,degraded:true,integrityReasons:importIntegrity.reasons};

  // Import is never allowed to be the first destructive operation. A complete
  // rescue archive is committed first; if it cannot be created, nothing else
  // is touched and the user keeps their current data exactly as-is.
  let rescue: BackupOperationResult;
  try {
    rescue = await createInternalBackup("before-import", request.currentWorkspaceData, WITHOUT_CREDENTIALS);
  } catch (error: any) {
    return {
      ok: false,
      ...failure("backup_rescue_failed", "The safety backup before the import failed; the import was stopped", error),
      imported: 0,
      skipped: 0,
      renamed: 0,
    };
  }
  if(rescue.ok!==true||rescue.complete!==true)return{ok:false,...hostMessage("backup_rescue_incomplete",`The safety backup before the import is incomplete; the import was stopped and the backup kept for inspection: ${rescue.integrityReasons?.map(reason=>reason.message).join('; ')||rescue.message}`,undefined,undefined,{reasons:rescue.integrityReasons?.length?reasonDetails(rescue.integrityReasons):[hostDetail(rescue,"backup_rescue_failed",rescue.message)]}),imported:0,skipped:0,renamed:0,rescueBackupPath:rescue.path,complete:false,degraded:true,integrityReasons:rescue.integrityReasons};

  const selected = new Set(categories);
  const counters = { count: 0, skipped: 0, renamed: 0 };
  const warnings: string[] = [], warningDetails: HostDetail[] = [];
  const warn = (value: HostDetail) => { if (warnings.includes(value.message)) return; warnings.push(value.message); warningDetails.push(hostDetail(value)); };
  const library = activeLibrary(), libraryPaths = activeLibraryPaths();
  const restoreUnified = !!(library && libraryPaths && archive.zip.file('library/manifest.json') && ['imageHistory','artistLibrary','referencePresets','promptPresets'].every(value => selected.has(value as DataBackupCategory)));
  const guard = legacyImportGuard(library);
  let saved = false;
  try {
    const current = readStore();
    const next = cloneJson(current);
    const outputDir = current.settings.outputDir;
    // A per-category import adds library records through this staged copy (written by commitStagedLibrary below).
    if (!restoreUnified && !library && LIBRARY_CATEGORIES.some(category => selected.has(category))) throw hostError("library_unavailable", "The material library is not open; the material categories were not imported.", "backup.library_not_open");
    const staged = !restoreUnified && library ? stagedLibrary(library) : null;
    let preparedConfiguration: {
      incoming: Record<string, unknown>;
      incomingParams: Record<string, unknown> | null | undefined;
    } | null = null;
    if (selected.has("configuration")) {
      const rawIncoming = await readJsonEntry<Record<string, unknown> | null>(
        archive.zip,
        "data/configuration.json",
        null,
      );
      if (!rawIncoming || typeof rawIncoming !== "object" || Array.isArray(rawIncoming)) {
        throw invalidArchive("configuration_missing", "The backup has no valid application configuration; nothing was overwritten.");
      }
      // Settings of removed features in older archives are dropped, as on loading a settings file.
      const incoming = retainKnownSettings(rawIncoming) as Record<string, unknown>;
      const incomingParams = await readJsonEntry<Record<string, unknown> | null>(
        archive.zip,
        "data/generation-params.json",
        null,
      );
      const configuredSettings = {
        ...defaultSettings(),
        ...incoming,
      } as AppSettings;
      const finalGenerationState = mergedImportedGenerationState(
        configuredSettings.lastGenerationState,
        current.settings.lastGenerationState,
        incomingParams,
      );
      assertImportedGenerationState(finalGenerationState);
      preparedConfiguration = { incoming, incomingParams };
    }
    const portableHistoryPayload = await readJsonEntry<{
      groups?: HistoryGroup[];
      items?: PortableHistoryItem[];
    }>(archive.zip, "data/image-history.json", {});
    const artistPayload = await readJsonEntry<{ collections?: Record<string, unknown[]> }>(
      archive.zip,
      "data/artist-library.json",
      {},
    );

    // Preflight every selected portable history record (also a favorite's image), with its character snapshot, before
    // any image publication: each must become a valid stored record (its file path is not known yet).
    if (!restoreUnified) {
      const incomingHistory = selected.has("imageHistory") ? [...(portableHistoryPayload.items ?? [])] : [];
      if (selected.has("artistLibrary")) for (const collection of Object.values(artistPayload.collections ?? {})) {
        for (const favorite of collection) {
          const image = (favorite as { image?: PortableHistoryItem })?.image;
          if (image) incomingHistory.push(image);
        }
      }
      for (const item of incomingHistory) {
        if (Object.hasOwn(item, "characterSnapshot")) readCharacterSnapshot(item.characterSnapshot);
        checkImportedRecord("history", { id: typeof item.id === "string" && item.id ? item.id : "preflight", filePath: "", fileUrl: "", ...safeHistoryShape(item) });
      }
    }

    const incomingGroups = !restoreUnified && selected.has("imageHistory")
      ? portableHistoryPayload.groups ?? []
      : [];
    // Artist favorites carry their own HistoryItem and group id. Add missing
    // groups only when the full image-history category supplied group names;
    // artist-only restores safely fall back to the ungrouped date folder.
    const mergedGroups = mergeGroups(staged?.historyGroups ?? [], incomingGroups);
    if (staged) staged.historyGroups = mergedGroups.groups;
    const storeState = staged && {
      library: staged,
      outputDir,
      groupIdMap: mergedGroups.idMap,
      historyByHash: await historyHashIndex(staged.history),
      historyBySourceId: new Map<string, HistoryItem>(),
      // History ids in Recently Deleted are taken too: an older backup copy is imported under a new id, never as the deleted item.
      // A favorite's image whose history id is in Recently Deleted is imported under a new id (the favorite needs it).
      importedIds: new Set([...staged.history.map((item) => item.id), ...guard.trashed.history]),
      imported: counters,
      guard,
    };

    if (storeState && selected.has("imageHistory")) {
      for (const item of portableHistoryPayload.items ?? []) {
        await restoreHistoryItem(archive.zip, item, storeState, true);
      }
    }

    if (storeState && selected.has("artistLibrary")) {
      await restoreArtistLibrary(archive.zip, artistPayload, storeState, counters);
    }

    if (!restoreUnified && selected.has("referencePresets")) {
      const payload = await readJsonEntry<{
        groups?: string[];
        presets?: PortableReferencePreset[];
      }>(archive.zip, "data/reference-presets.json", {});
      await restoreReferencePresets(archive.zip, payload, counters);
    }

    if (!restoreUnified && selected.has("promptPresets")) {
      const payload = await readJsonEntry<{
        promptTemplates?: AppSettings["promptTemplates"];
        stylePromptPresetGroups?: string[];
        stylePromptPresets?: PortableStylePreset[];
        positivePromptPresets?: PortablePositivePromptPreset[];
        promptChunks?: PromptChunk[];
      }>(archive.zip, "data/prompt-presets.json", {});
      await restorePromptPresets(archive.zip, payload, next.settings, staged, counters, guard);
    }
    if (guard.inTrash) warn(inTrashNotice(guard.inTrash));

    if (selected.has("configuration")) {
      const { incoming, incomingParams } = preparedConfiguration!;
      const devicePaths = pickSettings(current.settings, DEVICE_PATH_KEYS);
      const preservedPresets = pickSettings(next.settings, PRESET_SETTING_KEYS);
      const preservedApis = pickSettings(next.settings, API_SETTING_KEYS);
      next.settings = {
        ...defaultSettings(),
        ...incoming,
        ...devicePaths,
        ...preservedPresets,
        ...preservedApis,
      } as StoredSettings;
      if (incomingParams && typeof incomingParams === "object" && !Array.isArray(incomingParams)) {
        next.settings.lastGenerationState = mergedImportedGenerationState(
          next.settings.lastGenerationState,
          current.settings.lastGenerationState,
          incomingParams,
        );
        counters.count += Object.keys(incomingParams).length;
      }
      counters.count += Object.keys(incoming).length;
    }

    if (selected.has("apiCredentials")) {
      const incoming = await readJsonEntry<{
        token?: string;
        account?: PersistedData["account"];
        settings?: Partial<AppSettings>;
      } | null>(archive.zip, "data/api-credentials.json", null);
      if (!incoming || typeof incoming !== "object") {
        throw invalidArchive("credentials_missing", "The backup has no valid API and sensitive data; nothing was overwritten.");
      }
      for (const key of API_SETTING_KEYS) {
        if (incoming.settings && key in incoming.settings) {
          (next.settings as unknown as Record<string, unknown>)[key] = cloneJson(incoming.settings[key]);
          counters.count += 1;
        }
      }
      if (typeof incoming.token === "string") next.token = incoming.token;
      if (incoming.account && typeof incoming.account === "object") next.account = incoming.account;
    }

    if (restoreUnified) {
      // Prompt templates are still ordinary settings and are intentionally outside the SQL material kinds.
      const promptPayload = await readJsonEntry<{ promptTemplates?: AppSettings['promptTemplates'] }>(archive.zip,'data/prompt-presets.json',{});
      await restorePromptPresets(archive.zip,{promptTemplates:promptPayload.promptTemplates},next.settings,null,counters);
      const restored = await restoreLibraryArchive(archive.zip, { repository: library!, ...libraryPaths!, assetRoots: [outputDir], toFileUrl: toLocalMediaUrl });
      counters.count += restored.imported; counters.skipped += restored.conflicts;
      for (const warning of restored.warningDetails) warn(warning);
    }
    if (staged) commitStagedLibrary(library!, staged);
    writeStore(next);
    saved = true;

    const workspaceData = selected.has("workspaceData")
      ? await readJsonEntry<Record<string, string>>(archive.zip, "data/workspace.json", {})
      : undefined;
    // The backup's cleaned queue records are added to the ones here (never removing any); a failure here is reported,
    // it does not undo the import.
    let queueRecords: { status: string; added: number; recoveredFromLibrary?: number } | undefined;
    if (queueCleanedRecords) {
      const files: Array<{ name: string; data: Buffer }> = [];
      for (const name of QUEUE_CLEANED_ARCHIVE_FILES) { const entry = archive.zip.file(`queue-cleaned/${name}`); if (entry && !entry.dir) files.push({ name, data: await entry.async('nodebuffer') }); }
      if (files.length) {
        try { queueRecords = await queueCleanedRecords.restore(files); }
        catch (error) { queueRecords = { status: 'failed', added: 0 }; warnings.push(`The backup's cleaned queue records could not be added (${(error as any)?.code ?? 'error'}).`); }
      }
      // Then the library's images are checked against the records (review rework 2): agent keys they name that have no
      // receipt, record or batch here are recorded as cleaned, so they are never sent again.
      if (restoreUnified && queueCleanedRecords.libraryRestored) {
        try { const recovered = await queueCleanedRecords.libraryRestored(); queueRecords = { ...(queueRecords ?? { status: 'unchanged', added: 0 }), recoveredFromLibrary: recovered } as typeof queueRecords; }
        catch (error) { warnings.push(`The restored library could not be checked against the cleaned queue records (${(error as any)?.code ?? 'error'}).`); }
      }
    }
    return {
      ok: true,
      ...hostMessage("backup_imported", `${importIntegrity.degraded ? "Degraded import complete" : "Import complete"}: ${counters.count} added, ${counters.skipped} skipped, ${counters.renamed} renamed.${warnings.length ? ` ${warnings.join(" ")}` : ""}`,
        `backup.imported${importIntegrity.degraded ? "_degraded" : ""}${warnings.length ? "_warnings" : ""}`, { imported: counters.count, skipped: counters.skipped, renamed: counters.renamed }, warnings.length ? { warnings: warningDetails } : undefined),
      imported: counters.count,
      skipped: counters.skipped,
      renamed: counters.renamed,
      workspaceData,
      ...(queueRecords ? { queueRecords } : {}),
      rescueBackupPath: rescue.path,
      warnings, warningDetails,
      complete:importIntegrity.complete,degraded:importIntegrity.degraded,integrityReasons:importIntegrity.reasons,
    };
  } catch (error: any) {
    // Image files written for records that were never saved would be orphans: remove those that nothing uses.
    const removed = saved ? 0 : await removeUnsavedImports(library, guard);
    return {
      ok: false,
      ...failure("backup_import_aborted", `Import aborted; the safety backup of the current data was kept${removed ? `, and the ${removed} image file(s) written but not saved by this import were deleted` : ""}`, error, removed ? "backup.import_aborted_removed" : "backup.import_aborted", removed ? { removed } : undefined),
      imported: counters.count,
      skipped: counters.skipped,
      renamed: counters.renamed,
      rescueBackupPath: rescue.path,
    };
  }
  }finally{await archive.zip.close();}
}

async function automaticBackupFiles(directory: string) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.startsWith("auto-") && entry.name.endsWith(".naisbackup"))
      .map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        const stat = await fs.stat(filePath);
        return { path: filePath, createdAt: stat.mtime, bytes: stat.size };
      }));
    return files.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
  } catch {
    return [];
  }
}

export async function getDataBackupStatus(): Promise<DataBackupStatus> {
  const settings = readStore().settings;
  const directory = configuredBackupDirectory(settings);
  const files = await automaticBackupFiles(directory);
  const intervalHours = Math.max(1, Math.min(24 * 30, Math.trunc(Number(settings.autoBackupIntervalHours) || 24)));
  const retentionCount = Math.max(1, Math.min(100, Math.trunc(Number(settings.autoBackupRetentionCount) || 7)));
  const latest = files[0];
  const due = !latest || Date.now() - latest.createdAt.getTime() >= intervalHours * 60 * 60 * 1000;
  return {
    directory,
    automaticEnabled: settings.autoBackupEnabled !== false,
    intervalHours,
    retentionCount,
    latestPath: latest?.path,
    latestCreatedAt: latest?.createdAt.toISOString(),
    backupCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    due,
  };
}

// The whole backup ZIP is built in memory by JSZip without ZIP64, and image bytes can be stored
// twice (library blobs plus the portable history carrier). Above this many distinct library
// image bytes an automatic backup leaves image bytes out instead of risking the host.
const AUTO_BACKUP_IMAGE_LIMIT = 1024 * 1024 * 1024;

export async function runAutomaticBackup(
  workspaceData?: Record<string, string>,
  options: { imageByteLimit?: number } = {},
): Promise<BackupOperationResult> {
  const settings = readStore().settings;
  const status = await getDataBackupStatus();
  if (!settings.autoBackupEnabled) return { ok: true, ...hostMessage("backup_auto_disabled", "Automatic backup is off.") };
  if (!status.due) return { ok: true, ...hostMessage("backup_auto_not_due", "The automatic backup is not due yet."), path: status.latestPath };
  // Metadata and grouping remain protected in lightweight mode; only the
  // large binary payloads are omitted. Manual export continues to include all
  // checked assets by default.
  let includeAssets = settings.autoBackupIncludeImages === true, imagesSkipped: ImagesSkipped | undefined;
  const library = activeLibrary(), libraryPaths = activeLibraryPaths(), limit = options.imageByteLimit ?? AUTO_BACKUP_IMAGE_LIMIT;
  if (includeAssets && library && libraryPaths) {
    const bytes = await libraryAssetBytes({ repository: library, libraryDirectory: libraryPaths.libraryDirectory });
    if (bytes > limit) {
      includeAssets = false;
      const gib = (value: number) => (value / 1024 / 1024 / 1024).toFixed(2);
      imagesSkipped = { message: `The material library images total about ${gib(bytes)} GiB, more than the ${gib(limit)} GiB an automatic backup can safely write; this automatic backup left out image bytes. Metadata and groups are saved as usual.`, params: { size: gib(bytes), limit: gib(limit) } };
    }
  }
  const result = await createInternalBackup("auto", workspaceData, ALL_CATEGORIES, { includeAssets, imagesSkipped });
  // Rotate only after the new backup reads back: with a retention of 1 an unreadable new file
  // would otherwise replace the only good one.
  if (result.path) {
    try { const loaded = await loadArchive(result.path); await loaded.zip.close(); }
    catch (error) {
      const removed = await fs.rm(result.path, { force: true }).then(() => true, () => false);
      const file = path.basename(result.path), detail = errorText(error);
      throw hostError("backup_auto_readback_failed", `The automatic backup could not be read back after writing (${detail}); ${removed ? "the new backup was deleted" : `the new backup could not be deleted, delete ${file} manually`}. Older backups are kept.`,
        removed ? "backup.auto_readback_failed_removed" : "backup.auto_readback_failed_kept", { detail, file });
    }
  }
  const files = await automaticBackupFiles(configuredBackupDirectory(settings));
  const retention = Math.max(1, Math.min(100, Math.trunc(Number(settings.autoBackupRetentionCount) || 7)));
  for (const obsolete of files.slice(retention)) {
    await fs.rm(obsolete.path, { force: true }).catch(() => undefined);
  }
  return result;
}

export async function selectBackupDirectory() {
  const result = await dialog.showOpenDialog({
    title: hostText("dialog.backupFolder"),
    properties: ["openDirectory", "createDirectory"],
    defaultPath: configuredBackupDirectory(),
  });
  return result.canceled || !result.filePaths[0] ? null : result.filePaths[0];
}

export async function openBackupDirectory() {
  const directory = configuredBackupDirectory();
  await fs.mkdir(directory, { recursive: true });
  const message = await shell.openPath(directory);
  return message ? { ok: false, ...hostMessage("backup_open_directory_failed", `Could not open the backup directory: ${message}`, undefined, { detail: message }) } : { ok: true };
}

