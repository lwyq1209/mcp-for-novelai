import { memo, useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { batchSourceLabel } from '../agent-clients';
import type { LibraryApi } from '../library/api';
import { Button, Dot, Icon, Progress, Seg, Tag } from '../ui';
import { formatTime, formatWhen, type UiLang, type UiText } from '../ui/i18n';
import { batchSourceOf } from '../workspace/batch-types';
import { HistoryThumb } from './HistoryThumb';
import {
  STATUS_TEXT, STATUS_TONE, batchCounts, batchFlags, batchTitle, finishedImages, modeIcon, modeLabelKey, progressTone,
  type QueueBatch, type QueueFilter, type QueueListModel,
} from './model';

const GROUP_TEXT = { active: 'q.g.active', waiting: 'q.g.waiting', ended: 'q.g.ended' } as const;

/** Enqueue time: the time today, else 昨天 22:10 / Nov 1 (formatWhen). */
export function enqueuedText(value: string, lang: UiLang, now: Date = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return today ? formatTime(date) : formatWhen(date, lang, now);
}

export interface QueueListProps {
  api: LibraryApi;
  list: QueueListModel;
  filter: QueueFilter;
  onFilter(next: QueueFilter): void;
  selectedId: string | null;
  onSelect(batchId: string): void;
  onMore(): void;
  stats: { running: number; waiting: number; doneToday: number };
  t: UiText;
  lang: UiLang;
  /** Shown above the list when a refresh failed after the first read. */
  notice?: ReactNode;
  /** While the shown batch is not the running one: the batch that runs now or next, offered at the top of the list. */
  next?: { batch: QueueBatch; shownEnded: boolean } | null;
}

/** The left column: title, counts, filter, and the batches grouped 进行中 / 等待中 / 已结束. */
export function QueueList({ api, list, filter, onFilter, selectedId, onSelect, onMore, stats, t, lang, notice, next = null }: QueueListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  // The selected card stays in view (also when it was chosen by default or by a capture scene far down the list).
  useEffect(() => {
    const root = scroller.current;
    if (!root || !selectedId) return;
    const card = Array.from(root.querySelectorAll<HTMLElement>('[data-testid^="queue-batch-"]')).find(node => node.dataset.testid === `queue-batch-${selectedId}`);
    card?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);
  return <aside className="qp-list" aria-label={t('q.list')}>
    <div className="qp-list-head">
      <h1>{t('q.title')}</h1>
      <p className="qp-stats">{t('q.summary', { a: stats.running, b: stats.waiting, c: stats.doneToday })}</p>
      <Seg full label={t('q.filter')} value={filter} onChange={onFilter}
        options={[{ value: 'all', label: t('q.f.all') }, { value: 'open', label: t('q.f.open') }, { value: 'ended', label: t('q.f.ended') }]} />
    </div>
    {next && <button type="button" className="qp-next" onClick={() => onSelect(next.batch.batchId)} data-testid="queue-next-active" data-batch={next.batch.batchId}
      aria-label={t('q.next.open', { name: batchTitle(next.batch, t) })}>
      <Dot tone={next.batch.status === 'running' ? 'agent' : 'neutral'} live={next.batch.status === 'running'} />
      <span className="qp-next-text">
        <span className="qp-next-k">{next.shownEnded ? <>{t('q.next.ended')}<span className="qp-sep" aria-hidden="true">·</span></> : null}{t(next.batch.status === 'running' ? 'q.next.running' : 'q.next.waiting')}</span>
        <b>{batchTitle(next.batch, t)}</b>
      </span>
      <Icon name="right" size={14} />
    </button>}
    <div className="qp-list-scroll" ref={scroller}>
      {notice}
      {list.sections.map(section => <section key={section.group} className="qp-group" aria-labelledby={`qp-group-${section.group}`}>
        <h2 id={`qp-group-${section.group}`} className="qp-group-h">{t(GROUP_TEXT[section.group])}</h2>
        {section.batches.map(batch => <BatchCard key={batch.batchId} api={api} batch={batch} selected={batch.batchId === selectedId} onSelect={onSelect} t={t} lang={lang} />)}
      </section>)}
      {list.hiddenEnded > 0 && <div className="qp-more"><Button size="sm" variant="ghost" onClick={onMore} data-testid="queue-more">{t('q.more', { n: list.hiddenEnded })}</Button></div>}
      {!list.sections.length && <p className="qp-list-empty">{t('q.filterEmpty')}</p>}
    </div>
  </aside>;
}

/** Status tag of a batch: running pulses. */
export function StatusTag({ batch, t }: { batch: QueueBatch; t: UiText }) {
  const tone = STATUS_TONE[batch.status] ?? 'neutral';
  return <Tag tone={tone} className="qp-status">
    {batch.status === 'running' && <Dot tone="agent" live />}
    {t(STATUS_TEXT[batch.status] ?? 'q.s.queued')}
  </Tag>;
}

/** Source of a batch: the agent's name (cyan) or 手动 · 本次运行 (neutral). */
export const sourceLabel = (batch: QueueBatch, t: UiText) => batchSourceLabel(batch.source, t('q.src.manualRun'));
export const isAgentBatch = (batch: QueueBatch) => batchSourceOf(batch).kind === 'agent';

export const BatchCard = memo(function BatchCard({ api, batch, selected, onSelect, t, lang }: { api: LibraryApi; batch: QueueBatch; selected: boolean; onSelect(batchId: string): void; t: UiText; lang: UiLang }) {
  const counts = batchCounts(batch);
  const flags = batchFlags(batch);
  const images = finishedImages(batch, 3);
  const title = batchTitle(batch, t);
  return <button type="button" className={clsx('qp-card', selected && 'is-on')} aria-pressed={selected} onClick={() => onSelect(batch.batchId)}
    data-testid={`queue-batch-${batch.batchId}`} data-status={batch.status}>
    <span className={clsx('qp-stack', !images.length && 'is-empty')} aria-hidden="true">
      {images.length
        ? images.slice().reverse().map(id => <span key={id} className="qp-stack-img"><HistoryThumb api={api} historyId={id} icon={modeIcon(batch.mode)} failedTitle={t('q.item.thumbFailed')} /></span>)
        : <Icon name={modeIcon(batch.mode)} size={20} />}
    </span>
    <span className="qp-card-body">
      <span className="qp-card-top"><b title={title}>{title}</b><StatusTag batch={batch} t={t} /></span>
      <span className="qp-card-meta">
        <Tag tone={isAgentBatch(batch) ? 'agent' : 'neutral'}>{sourceLabel(batch, t)}</Tag>
        <span>{t(modeLabelKey(batch.mode))}</span>
        <span className="qp-sep" aria-hidden="true">·</span>
        <span>{enqueuedText(batch.createdAt, lang)}</span>
      </span>
      <span className="qp-card-progress">
        <Progress value={batch.count ? counts.succeeded / batch.count : 0} tone={progressTone(batch)} label={t('q.progressLabel', { done: counts.succeeded, total: batch.count })} />
        <span className="qp-num">{t('q.progress', { done: counts.succeeded, total: batch.count })}</span>
        {flags.map(flag => <span key={flag} className={clsx('qp-flag', `qp-flag--${flag}`)} title={t(flag === 'unknown' ? 'q.flag.unknown' : 'q.flag.failed')}>
          <Icon name={flag === 'unknown' ? 'alert' : 'x'} size={13} title={t(flag === 'unknown' ? 'q.flag.unknown' : 'q.flag.failed')} />
        </span>)}
      </span>
    </span>
  </button>;
});
