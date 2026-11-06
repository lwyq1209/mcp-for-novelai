// What the window shows of the self-update (update-state.ts): progress, the queue wait, final and retryable failures,
// installations that cannot update themselves, and the first start after an update.
import { describe, expect, it } from 'vitest';
import { UI_STRINGS } from '../ui/strings';
import { updateNoticeNote, updateReasonKey, updateUiState } from './update-state';

describe('the self-update in the window', () => {
  it('offers Update and restart only where the installation can update itself', () => {
    expect(updateUiState({ phase: 'idle', install: { supported: true } })).toMatchObject({ canInstall: true, busy: false, retry: false, note: null, pill: null });
    const unsupported = updateUiState({ phase: 'idle', install: { supported: false, reason: 'translocated' } });
    expect(unsupported.canInstall).toBe(false);
    expect(unsupported.note).toEqual({ key: 'set.ab.unsupported', params: { reason: 'translocated' }, tone: 'neutral' });
    expect(updateUiState(null).canInstall).toBe(false);
  });

  it('shows the download percentage and the steps after it', () => {
    const downloading = updateUiState({ phase: 'downloading', received: 512, total: 2048, install: { supported: true } });
    expect(downloading).toMatchObject({ busy: true, percent: 25, pill: { key: 'top.updateDownloading', params: { percent: '25' } } });
    expect(updateUiState({ phase: 'downloading', received: 10, total: null, install: { supported: true } })).toMatchObject({ percent: null, pill: { key: 'top.updateDownloadingPlain' } });
    expect(updateUiState({ phase: 'verifying', install: { supported: true } }).note?.key).toBe('set.ab.verifying');
    expect(updateUiState({ phase: 'installing', install: { supported: true } })).toMatchObject({ busy: true, pill: { key: 'top.updateRestarting' } });
  });

  it('waits for the queue with Update after the queue', () => {
    expect(updateUiState({ phase: 'ready', queueBusy: true, install: { supported: true } })).toMatchObject({ waitsForQueue: true, canInstall: true, note: { key: 'set.ab.queueBusy' }, pill: { key: 'top.updateWaitQueue' } });
    expect(updateUiState({ phase: 'ready', queueBusy: false, install: { supported: true } }).waitsForQueue).toBe(false);
  });

  it('stops for good when the update cannot be verified, and lets a broken download be tried again', () => {
    const unverified = updateUiState({ phase: 'failed', error: { code: 'verify_failed', message: 'x', retryable: false, reason: 'signature_invalid' }, install: { supported: true } });
    expect(unverified).toMatchObject({ canInstall: false, retry: false, note: { key: 'set.ab.verifyFailed', params: { reason: 'signature_invalid' }, tone: 'danger' }, pill: { key: 'top.updateUnverified' } });
    const broken = updateUiState({ phase: 'failed', error: { code: 'download_failed', message: 'x', retryable: true, reason: 'network' }, install: { supported: true } });
    expect(broken).toMatchObject({ canInstall: true, retry: true, note: { key: 'set.ab.downloadFailed' } });
  });

  it('blocks only the version that failed for good, and never after "no newer version"', () => {
    const failed = { phase: 'failed' as const, version: '0.1.4', error: { code: 'verify_failed' as const, message: 'x', retryable: false, reason: 'signature_invalid' }, install: { supported: true } };
    expect(updateUiState(failed, '0.1.4').canInstall).toBe(false);
    expect(updateUiState(failed, '0.1.5')).toMatchObject({ canInstall: true, note: null, pill: null });
    const none = { phase: 'failed' as const, error: { code: 'no_update' as const, message: 'x', retryable: false }, install: { supported: true } };
    expect(updateUiState(none, '9.9.9').canInstall).toBe(true);
    expect(updateUiState({ ...failed, error: { ...failed.error, code: 'install_unsupported' as const, reason: 'asset_missing' } }, '0.1.4').canInstall).toBe(false);
  });

  it('has a text for every reason code in both languages', () => {
    for (const reason of ['signature_invalid', 'manifest_invalid', 'version_mismatch', 'checksum_mismatch', 'redirect_refused', 'signature_mismatch', 'package_invalid', 'extract_failed', 'network', 'stalled', 'http_status', 'too_large',
      'translocated', 'read_only', 'not_writable', 'per_machine', 'not_installed', 'sandbox_helper', 'not_packaged', 'asset_missing', 'unknown_layout', 'app_running', 'not_movable', 'move_failed', 'launch_failed', 'new_app_exited', 'not_started', 'installer_failed', 'other_instance', 'signature_changed', 'installer_changed', 'missing', 'stopped_waiting', undefined])
      expect(UI_STRINGS[updateReasonKey(reason)], String(reason)).toBeDefined();
  });

  it('says after an update that it worked, or why the old version runs again', () => {
    expect(updateNoticeNote({ kind: 'updated', from: '0.1.3', to: '0.1.4', releaseUrl: 'https://x' })).toEqual({ key: 'set.ab.updatedFrom', params: { from: '0.1.3', version: '0.1.4' }, tone: 'ok' });
    expect(updateNoticeNote({ kind: 'failed', to: '0.1.4', reason: 'new_app_exited', releaseUrl: 'https://x' })).toEqual({ key: 'set.ab.incomplete', params: { version: '0.1.4', reason: 'new_app_exited' }, tone: 'danger' });
    expect(updateNoticeNote(null)).toBeNull();
  });
});
