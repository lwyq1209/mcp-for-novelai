/**
 * Pure helpers of the settings page (step 4b2): proxy presets, number commits, the update-check result, the log line,
 * the backup confirmation stages and the Opus allowance. No store, no host calls, no copy (the sections render the
 * keys these return).
 */
import type { AppSettings, DataBackupCategory, OpusGenerationUsage, UpdateInfo } from '../../types';
import type { UiStringKey } from '../../ui/strings';
import { CREDENTIAL_FORMAT_ISSUE_SUFFIX } from '../../types';

// ── Proxy ────────────────────────────────────────────────────────────────────
export type ProxyMode = AppSettings['proxyMode'];
/** The five proxy modes, in the order the control shows them (automatic first: the default). */
export const PROXY_MODES: readonly ProxyMode[] = ['auto', 'http', 'socks', 'custom', 'direct'];
export const DEFAULT_PROXY_MODE: ProxyMode = 'auto';
export const DEFAULT_HTTP_PROXY = 'http://127.0.0.1:7890';
export const DEFAULT_SOCKS_PROXY = 'socks5://127.0.0.1:10808';

/** The preset a saved mode and address stand for (an unknown mode is read from the address, as the old control did). */
export function proxyPresetFor(mode: unknown, value: string): ProxyMode {
  if ((PROXY_MODES as readonly unknown[]).includes(mode)) return mode as ProxyMode;
  const normalized = value.trim().toLowerCase().replace(/\/$/, '');
  if (!normalized) return 'direct';
  if (normalized === DEFAULT_HTTP_PROXY) return 'http';
  if (normalized === DEFAULT_SOCKS_PROXY) return 'socks';
  return 'custom';
}

/** The address saved with a preset: none for auto and direct, the fixed local address for http and socks. */
export function proxyUrlFor(preset: ProxyMode, custom: string): string {
  if (preset === 'http') return DEFAULT_HTTP_PROXY;
  if (preset === 'socks') return DEFAULT_SOCKS_PROXY;
  if (preset === 'custom') return custom;
  return '';
}

/** What the "current" line says for a preset. */
export function proxyCurrent(preset: ProxyMode, url: string): { key: UiStringKey; url?: string } {
  if (preset === 'auto') return { key: 'set.net.currentAuto' };
  if (preset === 'direct') return { key: 'set.net.currentDirect' };
  return url.trim() ? { key: 'set.net.currentProxy', url: url.trim() } : { key: 'set.net.currentEmpty' };
}

// ── Numbers ──────────────────────────────────────────────────────────────────
/** A typed number rounded and clamped into [min, max], or null when the text is not a number (the field reverts). */
export function commitNumber(text: string, min: number, max: number): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ── Credentials ──────────────────────────────────────────────────────────────
/** Which credential problems the settings report: ciphertext that did not unlock here, or a plaintext token not used. */
export function credentialIssueKinds(issues: readonly string[] | undefined) {
  const list = issues ?? [];
  return { locked: list.some(issue => !issue.endsWith(CREDENTIAL_FORMAT_ISSUE_SUFFIX)), unsupported: list.some(issue => issue.endsWith(CREDENTIAL_FORMAT_ISSUE_SUFFIX)) };
}

// ── Opus allowance ───────────────────────────────────────────────────────────
/** About 17.3 normal V5 images per percent of the Opus allowance (the figure the old usage dialog used). */
const IMAGES_PER_PERCENT = 17.3;
export function opusAllowance(usage: OpusGenerationUsage | undefined) {
  if (!usage) return null;
  const remaining = Math.round(Math.min(100, Math.max(0, usage.isNegative ? 0 : usage.percent)) * 10) / 10;
  const refill = usage.timeUntilNextPercent > 0 ? Math.round((86_400 / usage.timeUntilNextPercent) * 10) / 10 : null;
  return {
    remaining,
    images: Math.round(IMAGES_PER_PERCENT * remaining),
    refill,
    refillImages: refill === null ? null : Math.round(IMAGES_PER_PERCENT * refill),
    empty: usage.isNegative,
  };
}

// ── Update check ─────────────────────────────────────────────────────────────
export interface UpdateMessage { key: UiStringKey; params: Record<string, string>; tone: 'ok' | 'accent' | 'danger' }
/** The line a manual check shows: up to date, a newer version, or why the check failed. */
export function updateCheckMessage(result: UpdateInfo | null, failure = ''): UpdateMessage | null {
  if (!result) return null;
  if (result.status === 'available' || (result.status === 'ignored' && result.latestVersion)) return { key: 'set.ab.available', params: { version: result.latestVersion ?? '' }, tone: 'accent' };
  if (result.status === 'failed') return { key: 'set.ab.failed', params: { reason: result.error || failure }, tone: 'danger' };
  return { key: 'set.ab.current', params: { version: result.currentVersion }, tone: 'ok' };
}

// ── Logs ─────────────────────────────────────────────────────────────────────
/** The "current log" line: the path with the size, or with "no log yet". */
export function logInfoLine(info: { path: string; exists: boolean; sizeBytes: number } | null): { key: UiStringKey; path: string; bytes: number } | null {
  if (!info) return null;
  return info.exists ? { key: 'set.st.logCurrent', path: info.path, bytes: Math.max(0, info.sizeBytes) } : { key: 'set.st.logCurrentEmpty', path: info.path, bytes: 0 };
}

// ── Folders ──────────────────────────────────────────────────────────────────
/** "Show in Finder" on macOS, "open in folder" elsewhere. */
export const openFolderKey = (platform: string | undefined): UiStringKey => /^(darwin|mac)/i.test(platform ?? '') ? 'set.openFinder' : 'set.openFolder';

// ── Backups ──────────────────────────────────────────────────────────────────
export const BACKUP_CATEGORIES: readonly DataBackupCategory[] = ['configuration', 'apiCredentials', 'artistLibrary', 'referencePresets', 'imageHistory', 'promptPresets', 'workspaceData'];
/** The confirmations of a backup: 1 merge, 2 overwrite settings, 3 export credentials, 4 incomplete archive. */
export type ConfirmStage = 0 | 1 | 2 | 3 | 4;
/** Restoring these replaces current settings (a second confirmation). */
export const overwritesSettings = (selection: Iterable<DataBackupCategory>) => { const set = new Set(selection); return set.has('configuration') || set.has('apiCredentials'); };
/** After a confirmation of a restore: the next one, or run. Stage 4 (incomplete) leads to 1, 1 to 2 when settings are replaced. */
export function importStageAfter(stage: ConfirmStage, selection: Iterable<DataBackupCategory>): 1 | 2 | 'run' {
  if (stage === 4) return 1;
  if (stage === 1 && overwritesSettings(selection)) return 2;
  return 'run';
}
