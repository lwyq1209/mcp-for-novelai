import { CREDENTIAL_PREFIX, CredentialVault, SENSITIVE_SETTING_KEYS } from "./credential-vault";
import { normalizeSavedLanguage, systemLanguages } from "./app-language";
import { activeLibrary, activeLibraryPaths } from '../library-runtime';
import { hostError } from "../host-error";
import { validateGeneratedHistoryPayload, validateLibraryPayload } from '../library/validation';
import type { LibraryRepository } from '../library/repository';
import { assertSafeDataDirectory, PROTECTED_DIRECTORY_KEYS } from "./data-directory-guard";
import { app, safeStorage } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { toLocalMediaUrl } from "./local-media-protocol";
import { servablePreviewImages } from "./style-preset-images";
import type { AccountSummary, AppSettings, HistoryGroup, HistoryItem, HistoryItemsRequest, HistoryItemsSnapshot, SettingKey } from "../../src/types";
import { CREDENTIAL_FORMAT_ISSUE_SUFFIX } from "../../src/types";
import { installedAppDir } from "./app-mode";
import { normalizeHistoryGroupName } from '../queue-output';
import { defaultOutputDirectory, SETTINGS_FILE_NAME } from "../../shared/runtime/data-paths.cjs";
import { QUEUE_ENQUEUE_ITEMS, QUEUE_PENDING_ITEMS, QUEUE_RETENTION_DAYS, normalizeQueueEnqueueItems, normalizeQueuePendingItems, normalizeQueueRetentionDays, queueSettingError } from "../../src/queue-limits";

/** The settings that come from the library (getSettings includes them); settings.json does not hold them. */
export const LIBRARY_SETTING_KEYS = ["stylePromptPresets", "stylePromptPresetGroups", "positivePromptPresets", "promptChunks"] as const;
export type LibrarySettingKey = typeof LIBRARY_SETTING_KEYS[number];
/** The settings settings.json holds: every setting except the library read models and the runtime credentialIssues. */
export type StoredSettings = Omit<AppSettings, LibrarySettingKey | "credentialIssues">;

/**
 * settings.json: the token, the account summary and the settings, nothing else. The library (history, history
 * groups, presets, favorites and every other material) is library.sqlite. Any other top-level field or unknown
 * setting in the file is ignored when it is read and is not written back.
 */
export interface PersistedData {
  token?: string;
  account?: Omit<AccountSummary, "hasToken">;
  settings: StoredSettings;
}

let cache: PersistedData | null = null;
/** Whether the next successful write also checks the two backup generations for a plaintext token (see
 * scrubPlaintextTokenBackups): once per process, and again after a read found a plaintext token. */
let plaintextScrubPending = true;

function storePath() {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

// --- At-rest encryption for credentials -------------------------------------
// The NovelAI token and the third-party AI keys are encrypted with Electron's
// safeStorage (OS keychain / DPAPI) before being written to disk. The in-memory
// cache always holds plaintext; only the JSON file holds ciphertext. A plaintext
// credential in the file is not this version's format: it reads as empty and is
// reported in credentialIssues (credential-vault.ts), and the next write drops it.
const credentialVault = new CredentialVault(safeStorage);

/** zh-CN or en-US is kept; any other saved value follows the system language (app-language.ts). */
function normalizeLanguage(value: unknown): AppSettings["language"] {
  return normalizeSavedLanguage(value, () => systemLanguages(app));
}

function encryptForDisk(data: PersistedData): PersistedData {
  const clone: PersistedData = { ...data, settings: { ...data.settings } };
  clone.token = credentialVault.encode("token", clone.token) as string;
  delete (clone.settings as Partial<AppSettings>).credentialIssues;
  const settings = clone.settings as unknown as Record<string, unknown>;
  for (const key of SENSITIVE_SETTING_KEYS) {
    settings[key] = credentialVault.encode(key, settings[key]);
  }
  return clone;
}

function decryptFromDisk(raw: Partial<PersistedData>): Partial<PersistedData> {
  credentialVault.reset();
  const clone: Partial<PersistedData> = { ...raw };
  if (typeof clone.token === "string") clone.token = credentialVault.decode("token", clone.token) as string;
  if (clone.settings) {
    clone.settings = { ...clone.settings };
    const settings = clone.settings as unknown as Record<string, unknown>;
    for (const key of SENSITIVE_SETTING_KEYS) {
      const current = settings[key];
      if (typeof current === "string") settings[key] = credentialVault.decode(key, current);
    }
  }
  return clone;
}

// Generated images are user data, not application files. Keeping them beside an
// installed EXE loses them when installing another version replaces the
// application directory. The default is the OS Pictures folder (<Pictures>/MCP for
// NovelAI) for every build; an isolated run (NOVELAI_DATA_DIR set) uses <data root>/output
// instead, so development and test runs never write into the real Pictures folder.
// A saved outputDir setting always wins.
function defaultOutputDir(): string {
  return defaultOutputDirectory(app.getPath("pictures"));
}

export function defaultSettings(): StoredSettings {
  return {
    hasOnboarded: false,
    language: "zh-CN",
    outputDir: defaultOutputDir(),
    logDir: "",
    apiBaseUrl: "https://api.novelai.net",
    imageBaseUrl: "https://image.novelai.net",
    allowCustomEndpoint: false,
    allowCustomEndpointFallback: false,
    proxyMode: "auto",
    proxyUrl: "",
    proxyForNai: true,
    proxyForUpdate: true,
    autoCheckUpdates: true,
    ignoredUpdateVersion: "",
    theme: "light",
    reduceMotion: false,
    autoComplete: true,
    weightHighlight: true,
    promptRandomizer: true,
    superDrop: true,
    streamPreviewEnabled: true,
    showFloatingToolbar: true,
    historyJumpAfterGenerate: true,
    historyRetentionDays: 30,
    loggingEnabled: true,
    keepImageMetadata: true,
    autoBackupEnabled: true,
    autoBackupIntervalHours: 24,
    autoBackupRetentionCount: 7,
    autoBackupIncludeImages: false,
    backupDir: "",
    activeHistoryGroupId: "",
    generationGroupId: "",
    modelMode: "anime" as const,
    lockStylePrompt: false,
    lockNegativePrompt: false,
    savedStylePrompt: "",
    savedNegativePrompt: "",
    imageNameTemplate: "{date}_{seq}_{model}",
    promptTemplates: [],
    lastGenerationState: null,
    persistGenerateParams: true,
    persistI2IParams: true,
    persistInpaintParams: true,
    persistUpscaleParams: true,
    persistDirectorParams: true,
    queueMaxItemsPerEnqueue: QUEUE_ENQUEUE_ITEMS.default,
    queueMaxPendingItems: QUEUE_PENDING_ITEMS.default,
    queueRetentionDays: QUEUE_RETENTION_DAYS.default,
  };
}

/** Keep only settings this version knows. Any other key (including an encrypted
 * credential) is dropped when a settings file is loaded or a backed-up
 * configuration is imported, so nothing reads, re-encrypts or exports it again. */
export function retainKnownSettings(rawSettings: Record<string, unknown>, defaults: StoredSettings = defaultSettings()): Partial<StoredSettings> {
  const known = new Set<string>(Object.keys(defaults));
  return Object.fromEntries(Object.entries(rawSettings).filter(([key]) => known.has(key))) as Partial<StoredSettings>;
}

function normalize(raw: Partial<PersistedData> | null): PersistedData {
  // Only token, account and the known settings are read: any other field (also library arrays an earlier
  // development build kept in this file) is ignored and is dropped by the next write.
  const defaults = defaultSettings();
  const rawSettings = retainKnownSettings((raw?.settings ?? {}) as Record<string, unknown>, defaults);
  const settings = { ...defaults, ...rawSettings };
  settings.language = normalizeLanguage(rawSettings.language);
  settings.queueMaxItemsPerEnqueue = normalizeQueueEnqueueItems(settings.queueMaxItemsPerEnqueue);
  settings.queueMaxPendingItems = normalizeQueuePendingItems(settings.queueMaxPendingItems);
  settings.queueRetentionDays = normalizeQueueRetentionDays(settings.queueRetentionDays);
  settings.autoCheckUpdates = settings.autoCheckUpdates !== false;
  settings.ignoredUpdateVersion = typeof settings.ignoredUpdateVersion === "string" ? settings.ignoredUpdateVersion.trim().slice(0, 64) : "";
  // Without custom endpoints the official hosts are used.
  if (!settings.allowCustomEndpoint) {
    settings.apiBaseUrl = defaults.apiBaseUrl;
    settings.imageBaseUrl = defaults.imageBaseUrl;
  }
  return {
    token: typeof raw?.token === "string" ? raw.token : undefined,
    account: raw?.account && typeof raw.account === "object" ? raw.account : undefined,
    settings,
  };
}

/** Exactly what settings.json holds: the token, the account summary and the known settings. */
function persistedShape(data: PersistedData): PersistedData {
  return { token: data.token, account: data.account, settings: retainKnownSettings(data.settings as unknown as Record<string, unknown>) as StoredSettings };
}

// Write to a temp file in the same directory, fsync it, then rename over the
// target. Rename onto an existing path is atomic on both POSIX and Windows
// (NTFS), so a crash/power-loss can never leave the live store half-written —
// readers either see the old complete file or the new complete file.
export function atomicWriteFileSync(file: string, data: string) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data, "utf8");
  const fd = fs.openSync(tmp, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// Keep the last two known-good snapshots BEFORE overwriting `file`, so even a
// logically-bad write still has a recovery path beyond "reset to defaults."
// Best-effort: backup rotation must never block an actual save.
export function rotateBackupsSync(file: string) {
  try {
    const bak1 = `${file}.bak`;
    const bak2 = `${file}.bak2`;
    // Rotation used to copy the complete JSON store twice for every history
    // mutation.  On a large library that blocked Electron's main thread long
    // enough for a single delete to feel frozen.  Renaming the previous
    // snapshot and hard-linking the current immutable file preserves the same
    // two recovery generations while reducing the common path to metadata-only
    // filesystem operations.  Filesystems without hard-link support retain the
    // old copy fallback.
    if (fs.existsSync(bak2)) fs.unlinkSync(bak2);
    if (fs.existsSync(bak1)) fs.renameSync(bak1, bak2);
    if (fs.existsSync(file)) {
      try {
        fs.linkSync(file, bak1);
      } catch {
        fs.copyFileSync(file, bak1);
      }
    }
  } catch {
    // best-effort
  }
}

// Reads `file`, parsing with `parse`. If that fails (missing, corrupt, torn
// write), tries `${file}.bak` then `${file}.bak2` in turn before giving up.
// A successful backup recovery is written back to `file` (atomically) so
// future reads/writes build on it instead of leaving it stranded as a backup.
export function readWithBackupRecoverySync<T>(
  file: string,
  parse: (raw: string) => T,
  serialize: (value: T) => string,
): { value: T; recoveredFrom: string | null } | null {
  for (const candidate of [file, `${file}.bak`, `${file}.bak2`]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const value = parse(fs.readFileSync(candidate, "utf8"));
      if (candidate !== file) {
        try {
          atomicWriteFileSync(file, serialize(value));
        } catch {
          // recovered in memory even if writing the repair back out fails
        }
      }
      return { value, recoveredFrom: candidate === file ? null : candidate };
    } catch {
      continue;
    }
  }
  return null;
}

/** A copy of the settings data (top level and settings); writeStore commits a changed copy. */
export function readStore(): PersistedData {
  if (cache) return { ...cache, settings: { ...cache.settings } };

  const file = storePath();
  const recovered = readWithBackupRecoverySync<PersistedData>(
    file,
    (raw) => normalize(decryptFromDisk(JSON.parse(raw) as Partial<PersistedData>)),
    (value) => JSON.stringify(encryptForDisk(value), null, 2),
  );
  if (recovered) {
    if (recovered.recoveredFrom) {
      console.warn(`[store] primary store was unreadable; recovered from ${path.basename(recovered.recoveredFrom)}.`);
    }
    cache = recovered.value;
    if (credentialVault.issues().some(issue => issue.endsWith(CREDENTIAL_FORMAT_ISSUE_SUFFIX))) plaintextScrubPending = true;
    return { ...cache, settings: { ...cache.settings } };
  }

  // Neither the primary file nor either backup was readable. If the primary
  // file exists it's corrupt (not just missing) — back it up before resetting
  // to defaults so it isn't silently lost.
  try {
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
  } catch {
    // ignore backup failure
  }
  writeStore(normalize(null));
  return { ...cache!, settings: { ...cache!.settings } };
}

export function writeStore(next: PersistedData) {
  const stored = persistedShape(next);
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  rotateBackupsSync(file);
  atomicWriteFileSync(file, JSON.stringify(encryptForDisk(stored), null, 2));
  cache = stored; // commit cache only after persistence succeeds
  if (plaintextScrubPending) {
    try { scrubPlaintextTokenBackups(file); plaintextScrubPending = false; }
    catch (error) { console.warn(`[store] could not clear a plaintext token from the settings backups; retried on the next save: ${error instanceof Error ? error.message : String(error)}`); }
  }
}

/**
 * A plaintext token is not this version's format: it is read as no token and the write that drops it from the
 * settings file also clears it from the two backup generations (.bak, .bak2), which rotation filled with the old
 * file. A backup that parses keeps every other field and only gets an empty token, so it still serves recovery. A
 * backup that does not parse (it cannot serve recovery) is deleted only when its text still shows a token value
 * without the encryption prefix; otherwise it is left alone. Encrypted tokens are left as they are. `.corrupt-*`
 * copies (kept when no generation was readable) are not touched.
 */
export function scrubPlaintextTokenBackups(file: string) {
  const plaintextTokenText = new RegExp(`"token"\\s*:\\s*"(?!${CREDENTIAL_PREFIX})[^"]`);
  for (const backup of [`${file}.bak`, `${file}.bak2`]) {
    let text: string;
    try { text = fs.readFileSync(backup, "utf8"); } catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    let value: any;
    try { value = JSON.parse(text); } catch { if (plaintextTokenText.test(text)) fs.rmSync(backup, { force: true }); continue; }
    if (value && typeof value === "object" && !Array.isArray(value) && typeof value.token === "string" && value.token && !value.token.startsWith(CREDENTIAL_PREFIX))
      atomicWriteFileSync(backup, JSON.stringify({ ...value, token: "" }, null, 2));
  }
}

/** The active library, which every history and material operation of this module requires. */
function library(): LibraryRepository {
  const repo = activeLibrary();
  if (!repo) throw hostError("library_unavailable", "The material library is not open.", "history.library_not_open");
  return repo;
}

/**
 * The library read models getSettings() includes: the style presets, positive presets and prompt chunks (unarchived,
 * in their saved order) and the names of the style preset groups. Without an open library they are empty.
 */
export function librarySettings(): Pick<AppSettings, LibrarySettingKey> {
  const repo = activeLibrary();
  if (!repo) return { stylePromptPresets: [], stylePromptPresetGroups: [], positivePromptPresets: [], promptChunks: [] };
  const saved = (kind: "style_preset" | "positive_preset" | "prompt_chunk") => repo.all(kind).filter(item => !item.archived)
    .sort((a, b) => (a.source.position ?? Number.MAX_SAFE_INTEGER) - (b.source.position ?? Number.MAX_SAFE_INTEGER)).map(item => item.payload) as any[];
  return { stylePromptPresets: saved("style_preset"), positivePromptPresets: saved("positive_preset"), promptChunks: saved("prompt_chunk"), stylePromptPresetGroups: repo.collections("style").map(group => group.name) };
}

export function getSettings(): AppSettings {
  const settings = cache ? cache.settings : readStore().settings;
  return { ...settings, ...librarySettings(), credentialIssues: credentialVault.issues() };
}

/**
 * The settings the renderer reads (settings:getAll): getSettings() with the preview images of the style and prompt
 * presets made servable in this process (servablePreviewImages), so their pictures show after a restart too.
 */
export function rendererSettings(): AppSettings {
  const settings = getSettings();
  const userDataRoot = activeLibraryPaths()?.userDataRoot;
  if (!userDataRoot) return settings;
  const serve = <T extends { id: string; previewImages?: unknown }>(presets: T[], prefix: string) => presets.map(preset => Array.isArray(preset.previewImages) && preset.previewImages.length ? { ...preset, previewImages: servablePreviewImages(`${prefix}${String(preset.id).trim()}`, preset.previewImages, userDataRoot) } : preset);
  return { ...settings, stylePromptPresets: serve(settings.stylePromptPresets ?? [], ""), positivePromptPresets: serve(settings.positivePromptPresets ?? [], "positive-prompt-") };
}

export function getSetting<K extends SettingKey>(key: K): AppSettings[K] {
  return getSettings()[key];
}

export function setSetting<K extends SettingKey>(key: K, value: AppSettings[K]): AppSettings[K] {
  if ((LIBRARY_SETTING_KEYS as readonly string[]).includes(String(key))) throw hostError('invalid_argument', 'Style presets, prompt presets and snippets are kept in the library; save them through its versioned save.', 'settings.library_kept');
  if (key === "outputDir" && (typeof value !== "string" || !value.trim())) throw hostError('invalid_argument', 'Choose an image folder; it cannot be empty.', 'settings.output_empty');
  if (key === "queueMaxItemsPerEnqueue" || key === "queueMaxPendingItems" || key === "queueRetentionDays") {
    const refusal = queueSettingError(key, value);
    if (refusal) throw new Error(refusal);
  }
  if ((PROTECTED_DIRECTORY_KEYS as readonly string[]).includes(key) && typeof value === "string") {
    assertSafeDataDirectory(value, installedAppDir());
  }
  const data = readStore();
  if ((SENSITIVE_SETTING_KEYS as readonly string[]).includes(key)) credentialVault.forget(key);
  data.settings = {
    ...data.settings,
    [key]: key === "language" ? normalizeLanguage(value) : value,
  };
  writeStore(data);
  return (data.settings as Partial<AppSettings>)[key] as AppSettings[K];
}

export function completeSetup() {
  setSetting("hasOnboarded", true);
}

export function getToken() {
  return readStore().token;
}

export function setToken(token: string) {
  const data = readStore();
  credentialVault.forget("token");
  data.token = token;
  writeStore(data);
}

export function clearToken() {
  const data = readStore();
  credentialVault.forget("token");
  delete data.token;
  delete data.account;
  writeStore(data);
}

export function getAccountSummary(): AccountSummary {
  const data = readStore();
  return { hasToken: Boolean(data.token), ...(data.account ?? {}) };
}

export function setAccountSummary(account: Omit<AccountSummary, "hasToken">) {
  const data = readStore();
  // V5 Opus allowance is live telemetry. Persisting its minute-by-minute value
  // would rewrite and fsync the entire history store on every poll. Keep only
  // stable account fields on disk; the live response is returned directly to
  // the renderer and refreshed again after startup.
  const { opusUsage: _usage, opusUsageUpdatedAt: _usageAt, ...stableAccount } = account;
  if (JSON.stringify(data.account ?? {}) === JSON.stringify(stableAccount)) return;
  data.account = stableAccount;
  writeStore(data);
}

/**
 * Generation saves its new history records here: the one place a saved history record is checked against the complete
 * generation parameters (every other library write keeps a stored record's parameters as they are). The generation
 * functions check the same record before they send the request (ipc/nai.ts refuseUnsavableHistory), so a record that
 * fails here is not expected. If one does, its image has already been generated (and paid for) and saved, and a queue
 * item names it: it is saved all the same when it is a valid stored record, and returned with the reason so the caller
 * can log it. Only a record that is not even a valid stored record is refused (nothing is written).
 */
export function addHistory(items: HistoryItem[]): Array<{ id: string; reason: string }> {
  const relaxed: Array<{ id: string; reason: string }> = [];
  for (const item of items) {
    try { validateGeneratedHistoryPayload(item); }
    catch (error) {
      validateLibraryPayload("history", item);
      relaxed.push({ id: item.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const repo = library();
  // The selected history group is a view filter, not a save destination.
  // Callers that own a destination set groupId explicitly on their history items.
  repo.transaction(() => { for (const item of items) { const old = repo.get('history', item.id); repo.put('history', item.id, item, { expectedRevision: old?.revision ?? 0 }); } });
  return relaxed;
}

function matchesHistoryView(item: HistoryItem, date?: unknown, groupId?: unknown): boolean {
  if (date && item.date !== date) return false;
  if (!groupId) return true;
  if (groupId === "__ungrouped") return !item.groupId;
  return item.groupId === groupId;
}

// Rebuild the renderer URL from the authoritative path of every record.
function withLocalMediaUrl(item: HistoryItem): HistoryItem {
  return item.filePath ? { ...item, fileUrl: toLocalMediaUrl(item.filePath) } : item;
}

/** The library filters in SQL only values it can compare exactly like matchesHistoryView; anything else (non-string IPC input) keeps the JS filter. */
function sqlHistoryView(date?: unknown, groupId?: unknown): { date?: string; groupId?: string } | null {
  if ((date && typeof date !== "string") || (groupId && typeof groupId !== "string")) return null;
  return { ...(date ? { date: date as string } : {}), ...(groupId ? { groupId: groupId as string } : {}) };
}

export function getHistory(date?: string, groupId?: string): HistoryItem[] {
  const repo = library();
  const view = sqlHistoryView(date, groupId);
  // Only matching unarchived rows are decoded (2026-11-01); order stays updated_at DESC, kind, id.
  if (view) return repo.historyItems(view).map(item => withLocalMediaUrl(item.payload as unknown as HistoryItem));
  const history = repo.all('history').filter(item => !item.archived).map(item => item.payload as unknown as HistoryItem);
  return history.filter((item) => matchesHistoryView(item, date, groupId)).map(withLocalMediaUrl);
}

export function getHistoryDates(): string[] {
  return library().historyDates();
}

/** Same bound as the renderer's HISTORY_ITEMS_LIMIT and the repository's LIBRARY_CHANGE_ID_LIMIT. */
export const HISTORY_ITEMS_LIMIT = 500;

/** Incremental history read: the named items plus the view order, without decoding the rest. */
export function getHistoryItems(request: HistoryItemsRequest): HistoryItemsSnapshot {
  if (!request || typeof request !== "object" || !Array.isArray(request.ids) || request.ids.length > HISTORY_ITEMS_LIMIT || request.ids.some(id => typeof id !== "string")) throw new Error("历史增量读取参数无效。");
  const ids = [...new Set(request.ids)], { date, groupId } = request, withOrder = request.order !== false;
  const repo = library(), view = sqlHistoryView(date, groupId);
  if (view) {
    const entries = repo.historyEntries(ids, view), found = new Map(entries.map(entry => [entry.id, entry]));
    return {
      items: ids.flatMap(id => { const entry = found.get(id); return entry?.item ? [withLocalMediaUrl(entry.item.payload as unknown as HistoryItem)] : []; }),
      removed: ids.filter(id => { const entry = found.get(id); return !entry || entry.archived; }),
      ...(withOrder ? { order: repo.historyOrder(view) } : {}),
    };
  }
  const visible = getHistory(date, groupId), byId = new Map(visible.map(item => [item.id, item]));
  const existing = new Set(repo.historyEntries(ids).filter(entry => !entry.archived).map(entry => entry.id));
  return {
    items: ids.flatMap(id => byId.has(id) ? [byId.get(id)!] : []),
    removed: ids.filter(id => !existing.has(id)),
    ...(withOrder ? { order: visible.map(item => item.id) } : {}),
  };
}

export function updateHistoryItem(id: string, patch: Partial<HistoryItem>): HistoryItem | null {
  const repo = library(), old = repo.get('history', id);
  if (!old) return null;
  return repo.put('history', id, { ...old.payload, ...patch }, { expectedRevision: old.revision }).payload as unknown as HistoryItem;
}

// History groups are the library's collections of the 'history' namespace: the collection id and name, and the
// group record ({ id, name, createdAt }) as its payload.
function historyGroupsOf(repo: LibraryRepository): HistoryGroup[] {
  return repo.collections('history').map(group => ({ ...group.payload, id: group.id, name: group.name })) as HistoryGroup[];
}
function saveHistoryGroup(repo: LibraryRepository, group: HistoryGroup) {
  repo.putCollection({ namespace: 'history', id: group.id, name: group.name, payload: group });
}

export function getHistoryGroups(): HistoryGroup[] {
  return historyGroupsOf(library());
}

export function ensureHistoryGroup(name: string, preferredId?: string): HistoryGroup {
  // One normalization shared with the queue's group matching (queue-output.ts).
  const normalizedName = normalizeHistoryGroupName(name) || "未命名分组";
  const repo = library();
  return repo.transaction(() => {
    const groups = historyGroupsOf(repo);
    const preferred = preferredId ? groups.find((group) => group.id === preferredId) : undefined;
    if (preferred) {
      if (preferred.name === normalizedName) return preferred;
      const updated = { ...preferred, name: normalizedName };
      saveHistoryGroup(repo, updated);
      return updated;
    }
    const existing = groups.find((group) => group.name.toLowerCase() === normalizedName.toLowerCase());
    if (existing) return existing;
    const created = { id: crypto.randomUUID(), name: normalizedName, createdAt: new Date().toISOString() };
    saveHistoryGroup(repo, created);
    return created;
  });
}

export function createHistoryGroup(name: string): HistoryGroup[] {
  const trimmed = name.trim(), repo = library();
  if (!trimmed) return historyGroupsOf(repo);
  return repo.transaction(() => {
    if (!historyGroupsOf(repo).some((group) => group.name.toLowerCase() === trimmed.toLowerCase())) {
      saveHistoryGroup(repo, { id: crypto.randomUUID(), name: trimmed, createdAt: new Date().toISOString() });
    }
    return historyGroupsOf(repo);
  });
}

export function renameHistoryGroup(id: string, name: string): HistoryGroup[] {
  const trimmed = name.trim(), repo = library();
  if (!trimmed) return historyGroupsOf(repo);
  return repo.transaction(() => {
    const group = historyGroupsOf(repo).find((value) => value.id === id);
    if (group && group.name !== trimmed) saveHistoryGroup(repo, { ...group, name: trimmed });
    return historyGroupsOf(repo);
  });
}

export function deleteHistoryGroup(id: string): HistoryGroup[] {
  const repo = library();
  const groups = repo.transaction(() => {
    // Items in the deleted group fall back to ungrouped (images are kept).
    for (const item of repo.all('history')) {
      if (item.payload.groupId !== id) continue;
      const { groupId: _groupId, ...payload } = item.payload;
      repo.put('history', item.id, payload, { expectedRevision: item.revision });
    }
    repo.deleteCollection('history', id);
    return historyGroupsOf(repo);
  });
  const data = readStore();
  if (data.settings.activeHistoryGroupId === id || data.settings.generationGroupId === id) {
    data.settings = {
      ...data.settings,
      ...(data.settings.activeHistoryGroupId === id ? { activeHistoryGroupId: "" } : {}),
      ...(data.settings.generationGroupId === id ? { generationGroupId: "" } : {}),
    };
    writeStore(data);
  }
  return groups;
}

export function setHistoryGroup(id: string, groupId?: string) {
  const repo = library();
  const normalized = groupId && groupId !== "__ungrouped" ? groupId : undefined;
  repo.transaction(() => {
    const item = repo.get('history', id);
    if (!item || item.payload.groupId === normalized) return;
    const { groupId: _groupId, ...payload } = item.payload;
    repo.put('history', id, normalized === undefined ? payload : { ...payload, groupId: normalized }, { expectedRevision: item.revision });
  });
  return { ok: true };
}
