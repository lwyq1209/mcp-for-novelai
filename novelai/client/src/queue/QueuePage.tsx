import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hostErrorText } from '../host-errors';
import { Button, EmptyState, Icon, Spinner } from '../ui';
import { useUiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { useQueueView, type QueueAction, type QueueMonitor, type QueueMonitorView } from '../workspace/queue-monitor';
import { isBatchTerminal } from '../workspace/batch-types';
import type { LibraryApi } from '../library/api';
import type { CaptureRequest } from '../shell/capture';
import { openSettingsSection } from '../shell/route';
import { BatchDetail } from './BatchDetail';
import { useQueueRetention } from './retention';
import { QueueList } from './QueueList';
import {
  CAPTURE_SELECTION, QUEUE_ENDED_WINDOW, batchCounts, batchGroup, captureShowsEmpty, etaMinutes, nextActiveBatch, queueList, queueStats, selectedBatchId, trackCompletion,
  type CompletionTrack, type QueueBatch, type QueueFilter,
} from './model';
import './queue.css';

export interface QueuePageProps {
  /** The window's queue monitor (capture runs: one over the sample batches); null without a queue bridge. */
  monitor: QueueMonitor | null;
  /** The library host API: thumbnails of finished images (asset_library read/thumbnail). */
  api: LibraryApi;
  /** The page is shown (hidden pages stay mounted). */
  active: boolean;
  capture?: CaptureRequest | null;
}

/**
 * Follows each batch's finished count while the page is mounted, so the time left comes only from images this window
 * saw finish (model.ts trackCompletion / etaMinutes); nothing is guessed.
 */
function useCompletionTracks(batches: readonly QueueBatch[]) {
  const tracks = useRef(new Map<string, CompletionTrack>());
  const [, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let changed = false;
    const seen = new Set<string>();
    for (const batch of batches) {
      seen.add(batch.batchId);
      const previous = tracks.current.get(batch.batchId);
      const next = trackCompletion(previous, batchCounts(batch).ended, now);
      if (next !== previous) { tracks.current.set(batch.batchId, next); changed = true; }
    }
    for (const id of [...tracks.current.keys()]) if (!seen.has(id)) tracks.current.delete(id);
    if (changed) setTick(value => value + 1);
  }, [batches]);
  return tracks.current;
}

const UNAVAILABLE: QueueMonitorView = { loaded: false, batches: [], error: 'The queue is not available in this window.', failure: { code: 'queue_unavailable', message: 'The queue is not available in this window.' } };

/** The queue page (step 4b2, prototype 17–19): batches on the left, the selected batch on the right. */
export function QueuePage({ monitor, api, active, capture = null }: QueuePageProps) {
  const view = useQueueView(monitor);
  const hasToken = useAppStore(state => state.account.hasToken);
  const captureEmpty = captureShowsEmpty(capture);
  // Without a queue bridge (older preload) there is nothing to read: say so instead of loading forever.
  const shown: QueueMonitorView = !monitor ? UNAVAILABLE : captureEmpty ? { ...view, batches: [] } : view;
  return <QueueView view={shown} hasToken={hasToken} api={api} capture={capture}
    onAction={(action, batchId) => monitor ? monitor[action](batchId) : Promise.reject(new Error('The queue is not available in this window.'))}
    onRefresh={monitor ? () => monitor.refresh() : undefined} active={active} />;
}

export interface QueueViewProps {
  view: QueueMonitorView;
  hasToken: boolean;
  api: LibraryApi;
  active: boolean;
  capture?: CaptureRequest | null;
  onAction(action: QueueAction, batchId: string): Promise<unknown>;
  onRefresh?: () => Promise<unknown>;
  /** Tests: the batch selected first. */
  initialSelected?: string | null;
}

/** The page body over a monitor view (rendered on its own in tests). */
export function QueueView({ view, hasToken, api, active, capture = null, onAction, onRefresh, initialSelected = null }: QueueViewProps) {
  const { t, lang, language } = useUiText();
  const batches = view.batches as QueueBatch[];
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [endedLimit, setEndedLimit] = useState(QUEUE_ENDED_WINDOW);
  const [wanted, setWanted] = useState<string | null>(() => initialSelected ?? (capture ? CAPTURE_SELECTION[capture.page] ?? null : null));
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => { if (capture) setWanted(CAPTURE_SELECTION[capture.page] ?? null); }, [capture?.page]);
  const select = useCallback((batchId: string) => setWanted(batchId), []);

  const refresh = useCallback(() => {
    if (!onRefresh) return;
    setRefreshing(true);
    void onRefresh().catch(() => undefined).finally(() => setRefreshing(false));
  }, [onRefresh]);
  // Each time the page is shown: one fresh list (the monitor follows host events by itself).
  useEffect(() => { if (active && onRefresh) void onRefresh().catch(() => undefined); }, [active]);

  const tracks = useCompletionTracks(batches);
  const list = useMemo(() => queueList(batches, filter, endedLimit), [batches, filter, endedLimit]);
  const stats = useMemo(() => queueStats(batches), [batches]);
  const selectedId = selectedBatchId(batches, wanted);
  const selected = batches.find(batch => batch.batchId === selectedId) ?? null;
  // What is shown stays shown (review rework 4b2 P1): the default is pinned as soon as it appears, so a batch that ends
  // keeps its detail (now ended) instead of the detail moving to the next batch under the pointer.
  useEffect(() => { if (selectedId && selectedId !== wanted) setWanted(selectedId); }, [selectedId, wanted]);
  // The page chose the shown batch by itself (first default, or the pinned one is no longer listed): its buttons settle.
  const pageChosen = selectedId !== null && selectedId !== wanted;
  const next = useMemo(() => nextActiveBatch(batches, selectedId), [batches, selectedId]);

  // The cleaned-batch records are damaged: agents' lookups and enqueues without a receipt are refused until restored.
  const [retention] = useQueueRetention(!capture);
  const recordsBar = retention?.records?.state === 'broken' && <div className="qp-banner" role="alert" data-testid="queue-records-broken">
    <Icon name="alert" size={16} className="qp-note-ic" /><span>{t('q.recordsBroken')}</span>
    <Button size="sm" variant="primary" onClick={() => openSettingsSection('queue')} data-testid="queue-records-open">{t('q.recordsOpen')}</Button>
  </div>;
  const tokenBar = !hasToken && <div className="qp-banner" role="status" data-testid="queue-no-token">
    <Icon name="key" size={16} className="qp-note-ic" /><span>{t('q.noToken')}</span>
    <Button size="sm" variant="primary" onClick={() => openSettingsSection('account')}>{t('q.openSettings')}</Button>
  </div>;
  const failureText = view.error ? hostErrorText(view.failure ?? view.error, language, view.error) : '';

  let body;
  if (!view.loaded && !view.error) {
    body = <div className="qp-center" role="status" data-testid="queue-loading"><Spinner size={20} />{t('q.loading')}</div>;
  } else if (!view.loaded && view.error) {
    body = <div className="qp-center" data-testid="queue-read-failed">
      <EmptyState icon="alert" title={t('q.readFailed')} body={failureText}
        action={onRefresh && <Button onClick={refresh} busy={refreshing} icon="refresh" data-testid="queue-retry">{t('c.retry')}</Button>} />
    </div>;
  } else if (!batches.length) {
    body = <div className="qp-center" data-testid="queue-empty">
      <EmptyState icon="queue" title={t('q.empty.t')} body={t('q.empty.d')} />
      {view.error && <p role="alert" className="qp-inline-error">{failureText}{onRefresh && <Button size="sm" variant="ghost" onClick={refresh} busy={refreshing}>{t('c.retry')}</Button>}</p>}
    </div>;
  } else {
    const notice = view.error ? <p role="alert" className="qp-inline-error" data-testid="queue-refresh-failed">
      <Icon name="alert" size={14} />{failureText}{onRefresh && <Button size="sm" variant="ghost" onClick={refresh} busy={refreshing}>{t('c.retry')}</Button>}
    </p> : null;
    body = <div className="qp-cols">
      <QueueList api={api} list={list} filter={filter} onFilter={setFilter} selectedId={selectedId} onSelect={select}
        onMore={() => setEndedLimit(limit => limit + QUEUE_ENDED_WINDOW * 2)} stats={stats} t={t} lang={lang} notice={notice}
        next={next && selected && batchGroup(selected.status) !== 'active' ? { batch: next, shownEnded: isBatchTerminal(selected.status) } : null} />
      {selected && <BatchDetail key={selected.batchId} api={api} batch={selected} hasToken={hasToken} eta={etaMinutes(selected, tracks.get(selected.batchId))}
        onAction={onAction} t={t} lang={lang} language={language} settleOnMount={pageChosen} projectPending={(view.unlisted ?? []).includes(selected.batchId)} />}
    </div>;
  }
  return <div className="ui-scope qp-page" data-testid="queue-page">
    {recordsBar}
    {tokenBar}
    {body}
  </div>;
}
