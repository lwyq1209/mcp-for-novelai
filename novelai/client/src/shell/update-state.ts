// What the top bar and Settings › About show of the self-update (pure): the main process reports UpdateProgressInfo
// (electron/update/updater.ts); this turns it into the label, the buttons and the note to show.
import type { UpdateNotice, UpdateProgressInfo } from '../types';
import type { UiStringKey } from '../ui/strings';

export type UpdateTone = 'ok' | 'accent' | 'danger' | 'neutral';
export interface UpdateNote { key: UiStringKey; params: Record<string, string>; tone: UpdateTone }
export interface UpdateUiState {
  /** Something is under way (checking, downloading, verifying, preparing, restarting). */
  busy: boolean;
  /** 0–100 while downloading with a known size, else null. */
  percent: number | null;
  /** "Update and restart" is offered (this installation can update itself and nothing has failed for good). */
  canInstall: boolean;
  /** The install button waits for the queue (shown as "Update after the queue", not clickable). */
  waitsForQueue: boolean;
  /** The failure can be tried again (the button then says Try again). */
  retry: boolean;
  /** The top bar's pill label while something is under way or failed (null: the plain "Update x"). */
  pill: { key: UiStringKey; params: Record<string, string> } | null;
  /** The line under the row in Settings › About. */
  note: UpdateNote | null;
  /** Download progress for Settings › About (bytes). */
  received: number | null;
  total: number | null;
}

const KNOWN_REASONS = new Set(['signature_invalid', 'manifest_invalid', 'version_mismatch', 'checksum_mismatch', 'redirect_refused', 'signature_mismatch', 'package_invalid', 'extract_failed',
  'network', 'stalled', 'http_status', 'too_large', 'translocated', 'read_only', 'not_writable', 'per_machine', 'not_installed', 'sandbox_helper', 'not_packaged', 'asset_missing', 'unknown_layout',
  'app_running', 'not_movable', 'move_failed', 'launch_failed', 'new_app_exited', 'not_started', 'installer_failed', 'other_instance', 'signature_changed', 'installer_changed', 'missing']);

/** The key of a reason code (set.upd.<code>); unknown codes say the helper stopped part-way. */
export function updateReasonKey(reason: string | undefined): UiStringKey {
  return (reason && KNOWN_REASONS.has(reason) ? `set.upd.${reason}` : 'set.upd.other') as UiStringKey;
}

/**
 * `availableVersion`: the newer version the window offers now. A failure that stops for good (could not be verified, no
 * file for this system) holds for the version it happened with; a check that finds another version offers it again,
 * and "no newer version" never blocks a later one.
 */
export function updateUiState(progress: UpdateProgressInfo | null, availableVersion?: string): UpdateUiState {
  const phase = progress?.phase ?? 'idle';
  const supported = progress?.install?.supported === true;
  const busy = ['checking', 'downloading', 'verifying', 'preparing', 'installing'].includes(phase);
  const total = typeof progress?.total === 'number' && progress.total > 0 ? progress.total : null;
  const received = typeof progress?.received === 'number' ? progress.received : null;
  const percent = phase === 'downloading' && total && received !== null ? Math.max(0, Math.min(100, Math.floor((received / total) * 100))) : null;
  const stale = phase === 'failed' && Boolean(availableVersion) && progress?.version !== availableVersion;
  const error = phase === 'failed' && !stale ? progress?.error : undefined;
  const finalFailure = error?.code === 'verify_failed' || error?.code === 'install_unsupported';
  const unsupportedReason = progress?.install && !supported ? progress.install.reason : undefined;
  const waitsForQueue = phase === 'ready' && progress?.queueBusy === true;
  let note: UpdateNote | null = null;
  let pill: UpdateUiState['pill'] = null;
  if (phase === 'checking') { note = { key: 'set.ab.checkingRelease', params: {}, tone: 'neutral' }; pill = { key: 'top.updateChecking', params: {} }; }
  else if (phase === 'downloading') {
    note = total && received !== null ? { key: 'set.ab.downloading', params: { received: String(received), total: String(total) }, tone: 'neutral' } : { key: 'set.ab.downloadingUnknown', params: { received: String(received ?? 0) }, tone: 'neutral' };
    pill = percent !== null ? { key: 'top.updateDownloading', params: { percent: String(percent) } } : { key: 'top.updateDownloadingPlain', params: {} };
  }
  else if (phase === 'verifying') { note = { key: 'set.ab.verifying', params: {}, tone: 'neutral' }; pill = { key: 'top.updateVerifying', params: {} }; }
  else if (phase === 'preparing') { note = { key: 'set.ab.preparing', params: {}, tone: 'neutral' }; pill = { key: 'top.updateVerifying', params: {} }; }
  else if (phase === 'installing') { note = { key: 'set.ab.installing', params: {}, tone: 'accent' }; pill = { key: 'top.updateRestarting', params: {} }; }
  else if (waitsForQueue) { note = { key: 'set.ab.queueBusy', params: {}, tone: 'accent' }; pill = { key: 'top.updateWaitQueue', params: {} }; }
  else if (error) {
    const reason = error.reason ?? '';
    if (error.code === 'verify_failed') { note = { key: 'set.ab.verifyFailed', params: { reason }, tone: 'danger' }; pill = { key: 'top.updateUnverified', params: {} }; }
    else if (error.code === 'install_unsupported') note = { key: 'set.ab.unsupported', params: { reason }, tone: 'danger' };
    else if (error.code === 'download_failed') { note = { key: 'set.ab.downloadFailed', params: { reason }, tone: 'danger' }; pill = { key: 'top.updateFailed', params: {} }; }
    else if (error.code === 'check_failed') { note = { key: 'set.ab.checkFailed', params: { reason: error.message }, tone: 'danger' }; pill = { key: 'top.updateFailed', params: {} }; }
    else if (error.code === 'no_update') note = { key: 'set.ab.noUpdate', params: {}, tone: 'neutral' };
    else if (error.code === 'install_failed') { note = { key: 'set.ab.installFailed', params: { reason: error.message }, tone: 'danger' }; pill = { key: 'top.updateFailed', params: {} }; }
  }
  else if (unsupportedReason) note = { key: 'set.ab.unsupported', params: { reason: unsupportedReason }, tone: 'neutral' };
  return {
    busy, percent, waitsForQueue, received, total, pill, note,
    canInstall: supported && !finalFailure,
    retry: Boolean(error) && !finalFailure && error?.retryable === true,
  };
}

/** A note's reason param is a code (set.upd.<code>) for these keys; the others carry plain text. */
export const NOTE_WITH_REASON_CODE: ReadonlySet<UiStringKey> = new Set<UiStringKey>(['set.ab.verifyFailed', 'set.ab.unsupported', 'set.ab.downloadFailed', 'set.ab.incomplete']);

/** The line of the first start after an update (Settings › About and the top bar). */
export function updateNoticeNote(notice: UpdateNotice | null): UpdateNote | null {
  if (!notice) return null;
  if (notice.kind === 'updated') return { key: 'set.ab.updatedFrom', params: { from: notice.from, version: notice.to }, tone: 'ok' };
  return { key: 'set.ab.incomplete', params: { version: notice.to, reason: notice.reason }, tone: 'danger' };
}
