import { useEffect, useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { BrandMark, Dot, Icon, IconButton, MenuButton, Tooltip, type IconName } from '../ui';
import { formatNumber, useUiText, type UiLang } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import { useAppStore } from '../store';
import { getWorkspaceRuntime, subscribeWorkspaceRuntime } from '../workspace/runtime';
import type { WorkspaceController } from '../workspace/controller';
import { isBatchTerminal, type BatchJob } from '../workspace/batch-types';
import { queueRunning, useQueueView, type QueueMonitor } from '../workspace/queue-monitor';
import type { ShellPage, ShellRoute } from './route';
import { WindowControls } from './WindowControls';
import { updateUiState } from './update-state';

/**
 * What the top bar shows of the shared queue (manual and agent batches alike): whether something is unfinished,
 * whether it is generating, and the progress of the current batch (the running one, else the oldest unfinished).
 */
export function queueSummary(batches: readonly BatchJob[]) {
  const active = batches.filter(batch => !isBatchTerminal(batch.status));
  const current = active.find(batch => ['running', 'pausing', 'cancelling'].includes(batch.status)) ?? active.at(-1);
  const done = current ? current.items.filter(item => ['succeeded', 'failed', 'unknown', 'cancelled', 'skipped'].includes(item.status)).length : 0;
  return { active: active.length, running: queueRunning(batches), done, total: current?.count ?? 0 };
}

const noController = () => () => {};
const emptyView = () => null;
/** True while the canvas holds a draft an agent sent (not a source the window staged itself). */
export function useAgentDraftPending() {
  const controller = useSyncExternalStore(subscribeWorkspaceRuntime, getWorkspaceRuntime, () => null) as WorkspaceController | null;
  const view = useSyncExternalStore(controller ? controller.subscribe : noController, controller ? controller.getView : emptyView, emptyView);
  return !!view?.draft && view.draft.origin !== 'client';
}

const NAV: Array<{ page: ShellPage; icon: IconName; label: UiStringKey }> = [
  { page: 'library', icon: 'library', label: 'nav.library' },
  { page: 'canvas', icon: 'canvas', label: 'nav.canvas' },
  { page: 'queue', icon: 'queue', label: 'nav.queue' },
];

export interface TopBarProps {
  route: ShellRoute;
  onNavigate(route: ShellRoute): void;
  onOpenAccount(): void;
  monitor: QueueMonitor | null;
  /** Capture runs never ask the host for the account or write settings. */
  capture?: boolean;
}

export function TopBar({ route, onNavigate, onOpenAccount, monitor, capture = false }: TopBarProps) {
  const { t, lang } = useUiText();
  const account = useAppStore(state => state.account);
  const refreshAccount = useAppStore(state => state.refreshAccount);
  const refreshSettings = useAppStore(state => state.refreshSettings);
  const updateInfo = useAppStore(state => state.updateInfo);
  const updateProgress = useAppStore(state => state.updateProgress);
  const updateNotice = useAppStore(state => state.updateNotice);
  const update = updateUiState(updateProgress);
  const queue = queueSummary(useQueueView(monitor).batches);
  const draftPending = useAgentDraftPending();

  // Opus balances refresh every minute while the window is visible (moved from the old title bar).
  useEffect(() => {
    if (capture || !account.hasToken || account.tierLevel !== 3) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshAccount(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [capture, account.hasToken, account.tierLevel, refreshAccount]);

  const setLanguage = async (next: UiLang) => {
    if (next === lang) return;
    const code = next === 'zh' ? 'zh-CN' : 'en-US';
    if (capture) { useAppStore.setState(state => ({ settings: state.settings ? { ...state.settings, language: code } : state.settings })); return; }
    await window.naiDesktop.setSetting('language', code);
    await refreshSettings();
  };

  const anlas = typeof account.anlasBalance === 'number' ? formatNumber(account.anlasBalance, lang) : '—';
  return <header className="ui-scope as-topbar">
    <div className="as-brand"><BrandMark size={18} /><span>{t('app.name')}</span></div>
    <nav className="as-nav" aria-label={t('nav.main')}>
      {NAV.map(item => {
        const current = route === item.page;
        const button = <button key={item.page} type="button" className={clsx('as-nav-item', current && 'is-on')} aria-current={current ? 'page' : undefined} onClick={() => onNavigate(item.page)}>
          <Icon name={item.icon} size={16} />
          <span>{t(item.label)}</span>
          {item.page === 'canvas' && draftPending && <i className="as-nav-badge" aria-label={t('top.draftTip')} />}
          {item.page === 'queue' && queue.active > 0 && <span className="as-live-pill" data-testid="queue-live"><Dot tone="agent" live={queue.running} />{t('top.queueProgress', { done: queue.done, total: queue.total })}</span>}
        </button>;
        // The wrapper stays in place whether or not a hint shows (no remount of the button when batches come and go). On
        // the queue page itself the hint would only cover the batch title below it (review rework 4b2).
        if (item.page === 'queue') return <Tooltip key={item.page} content={t(queue.running ? 'top.queueRunning' : 'top.queueWaiting')} placement="bottom" disabled={queue.active === 0 || current}>{button}</Tooltip>;
        if (item.page === 'canvas') return <Tooltip key={item.page} content={t('top.draftTip')} placement="bottom" disabled={!draftPending}>{button}</Tooltip>;
        return button;
      })}
    </nav>
    <div className="as-top-right">
      {updateNotice && !updateInfo?.hasUpdate && <MenuButton label={t(updateNotice.kind === 'updated' ? 'top.updated' : 'top.updateIncomplete', { version: updateNotice.to })} placement="bottom-end" entries={[
        { id: 'notes', icon: 'external', label: t('top.updatedNotes'), onSelect: () => { void window.naiDesktop.openExternal(updateNotice.releaseUrl); } },
        { id: 'details', icon: 'info', label: t('top.updateDetails'), onSelect: () => onNavigate('settings') },
        { id: 'dismiss', icon: 'check', label: t('top.updatedDismiss'), onSelect: () => useAppStore.getState().dismissUpdateNotice() },
      ]}>{trigger => <button type="button" className="as-update-pill" data-testid="update-notice-pill" {...trigger}><Icon name={updateNotice.kind === 'updated' ? 'check' : 'alert'} size={14} />{t(updateNotice.kind === 'updated' ? 'top.updated' : 'top.updateIncomplete', { version: updateNotice.to })}</button>}</MenuButton>}
      {updateInfo?.hasUpdate && updateInfo.latestVersion && <MenuButton label={t('top.updateMenu')} placement="bottom-end" entries={[
        ...(update.canInstall && !update.busy ? [{ id: 'install', icon: (update.retry ? 'refresh' : 'download') as 'refresh' | 'download', label: t(update.waitsForQueue ? 'top.updateWaitQueue' : update.retry ? 'top.updateRetry' : 'top.updateInstall'), disabled: update.waitsForQueue, onSelect: () => { void useAppStore.getState().startUpdate().catch(() => undefined); } }] : []),
        ...((update.busy && updateProgress?.phase !== 'installing') || update.waitsForQueue ? [{ id: 'cancel', icon: 'x' as const, label: t('top.updateCancel'), onSelect: () => { void useAppStore.getState().cancelUpdate().catch(() => undefined); } }] : []),
        ...(update.note && (updateProgress?.phase === 'failed' || update.waitsForQueue) ? [{ id: 'details', icon: 'info' as const, label: t('top.updateDetails'), onSelect: () => onNavigate('settings') }] : []),
        { id: 'download', icon: 'external', label: t('top.updateDownload'), onSelect: () => { if (updateInfo.releaseUrl) void window.naiDesktop.openExternal(updateInfo.releaseUrl); } },
        { id: 'later', icon: 'clock', label: t('top.updateLater'), onSelect: () => useAppStore.getState().dismissUpdate() },
        { id: 'ignore', icon: 'x', label: t('top.updateIgnore'), onSelect: () => { void useAppStore.getState().ignoreUpdate(updateInfo.latestVersion!).catch(() => undefined); } },
      ]}>{trigger => <button type="button" className="as-update-pill" data-testid="update-pill" {...trigger}><Icon name={update.busy ? 'download' : updateProgress?.phase === 'failed' ? 'alert' : 'sparkle'} size={14} />{update.pill ? t(update.pill.key, update.pill.params) : t('top.update', { version: updateInfo.latestVersion! })}</button>}</MenuButton>}
      <Tooltip placement="bottom" content={account.hasToken ? `${t('top.anlasTip', { tier: account.tierName ?? 'NovelAI', n: anlas })}${account.stale ? ` · ${t('top.anlasStale')}` : ''}` : t('top.notConnectedTip')}>
        <button type="button" className={clsx('as-anlas', !account.hasToken && 'is-off', account.stale && 'is-stale')} onClick={onOpenAccount}>
          <Icon name="bolt" size={14} />
          {account.hasToken ? <><b className="ui-num">{anlas}</b><span>Anlas</span></> : <span>{t('top.notConnected')}</span>}
        </button>
      </Tooltip>
      {/* Two plain toggle buttons (Tab reaches both; the pressed one is the current language). */}
      <div className="as-langsw" role="group" aria-label={t('top.lang')}>
        {(['zh', 'en'] as const).map(value => <button key={value} type="button" aria-pressed={lang === value} className={clsx(lang === value && 'is-on')} onClick={() => void setLanguage(value)} lang={value === 'zh' ? 'zh-CN' : 'en'}>{t(value === 'zh' ? 'top.langZh' : 'top.langEn')}</button>)}
      </div>
      <IconButton icon="settings" label={t('nav.settings')} active={route === 'settings'} onClick={() => onNavigate('settings')} />
      <WindowControls />
    </div>
  </header>;
}
