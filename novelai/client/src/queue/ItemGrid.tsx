import { memo } from 'react';
import clsx from 'clsx';
import { hostErrorText } from '../host-errors';
import { upstreamText } from './upstream';
import type { LibraryApi } from '../library/api';
import { openInLibrary } from '../library/intent';
import { Icon, Spinner } from '../ui';
import type { UiText } from '../ui/i18n';
import type { AppLanguage } from '../types';
import type { BatchItem } from '../workspace/batch-types';
import { HistoryThumb } from './HistoryThumb';
import { ITEM_TEXT, batchProjectId, finishedImages, modeIcon, type QueueBatch } from './model';

export interface ItemGridProps { api: LibraryApi; batch: QueueBatch; t: UiText; language: AppLanguage }

/**
 * The images of one batch, one fixed-size cell per item (up to 999 for a manual batch). Cells are single elements
 * where they can be (the number is drawn by CSS from data-n), skip layout off screen (content-visibility) and read
 * their thumbnail only near the viewport, so a large batch stays cheap.
 */
export function ItemGrid({ api, batch, t, language }: ItemGridProps) {
  const projectId = batchProjectId(batch);
  const hasImages = finishedImages(batch, 1).length > 0 || batch.items.some(item => item.status === 'unknown');
  const openAll = () => openInLibrary({ view: projectId ? { type: 'project', id: `history:${projectId}` } : { type: 'category', category: 'history' } });
  return <section className="qp-items" aria-labelledby={`qp-items-${batch.batchId}`}>
    <div className="qp-items-h">
      <h3 id={`qp-items-${batch.batchId}`}>{t('q.items')}</h3>
      {hasImages && <button type="button" className="qp-link" onClick={openAll} data-testid={`queue-open-all-${batch.batchId}`}>
        <Icon name="image" size={14} />{projectId ? t('q.openAll') : t('q.openHistory')}
      </button>}
    </div>
    <div className="qp-grid" role="list">
      {batch.items.map(item => <ItemCell key={item.index} api={api} batchId={batch.batchId} mode={batch.mode} item={item} t={t} language={language} />)}
    </div>
  </section>;
}

interface CellProps { api: LibraryApi; batchId: string; mode: string; item: BatchItem; t: UiText; language: AppLanguage }

export const ItemCell = memo(function ItemCell({ api, batchId, mode, item, t, language }: CellProps) {
  const n = item.index + 1;
  const common = { 'data-testid': `queue-item-${batchId}-${item.index}`, 'data-status': item.status, 'data-n': n, role: 'listitem' } as const;
  const reason = item.error ? [hostErrorText(item.error, language), upstreamText(item.error, t, language)].filter(Boolean).join(' · ') : '';
  if (item.status === 'succeeded') {
    const historyId = Array.isArray(item.results) ? item.results.find(result => typeof result?.id === 'string' && result.id)?.id : undefined;
    const label = t('q.item.succeeded', { index: n });
    if (!historyId) return <div {...common} className="qp-cell is-done" title={label}><Icon name="check" size={14} className="qp-cell-ok" /></div>;
    return <div {...common} className="qp-cell is-done">
      <button type="button" className="qp-cell-open" aria-label={label} title={label} onClick={() => openInLibrary({ open: { kind: 'history', id: historyId } })}>
        <HistoryThumb api={api} historyId={historyId} icon={modeIcon(mode)} failedTitle={t('q.item.thumbFailed')} />
      </button>
      <span className="qp-cell-ok" aria-hidden="true"><Icon name="check" size={12} /></span>
    </div>;
  }
  if (item.status === 'running' || item.status === 'submitting') {
    return <div {...common} className="qp-cell is-running">
      <i className="qp-shimmer" aria-hidden="true" />
      <span className="qp-cell-lbl"><Spinner size={18} />{t(ITEM_TEXT[item.status])}</span>
    </div>;
  }
  if (item.status === 'failed') {
    return <div {...common} className="qp-cell is-failed" title={reason || undefined}><Icon name="x" size={16} /><span>{t('q.item.failed')}</span></div>;
  }
  if (item.status === 'unknown') {
    const title = reason ? `${t('q.item.unknownTip')} · ${reason}` : t('q.item.unknownTip');
    return <div {...common} className="qp-cell is-unknown" title={title}><Icon name="alert" size={18} /><span>{t('q.item.unknown')}</span></div>;
  }
  return <div {...common} className={clsx('qp-cell', item.status === 'pending' ? 'is-pending' : 'is-off')} title={reason || undefined}>{t(ITEM_TEXT[item.status])}</div>;
});

