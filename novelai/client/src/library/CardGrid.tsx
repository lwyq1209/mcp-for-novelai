import { memo, type MouseEvent } from 'react';
import clsx from 'clsx';
import type { AssetItem } from '../asset-library/types';
import { Checkbox, Icon, IconButton, Tag } from '../ui';
import type { UiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { Thumb } from './Thumb';
import { itemKey } from './model';
import { cardExcerpt, fileName, itemTitle, KIND_ICONS, tagTarget } from './present';

export interface CardHandlers {
  onOpen(item: AssetItem): void;
  onSelect(item: AssetItem, mode: 'toggle' | 'range'): void;
  /** Tags and combos: the ＋ that puts them on the combo tray. */
  onAddToTray?(item: AssetItem): void;
}

/** One card of tags, combos, notes, presets, artist picks and imported images (prototype 09–11); VirtualGrid.tsx renders the rows. */
export type CardProps = { api: LibraryApi; item: AssetItem; index: number; t: UiText; selected: boolean; selecting: boolean; active: boolean } & CardHandlers;
export const Card = memo(function Card({ api, item, index, t, selected, selecting, active, onOpen, onSelect, onAddToTray }: CardProps) {
  const title = item.kind === 'study' ? fileName(item) : itemTitle(item);
  const { text, meta } = cardExcerpt(item, t);
  const cover = item.kind === 'tag' || item.kind === 'study' || item.kind === 'artist_favorite' || !!item.preview;
  const kindTag = item.kind === 'style_preset' || item.kind === 'positive_preset' || item.kind === 'prompt_chunk' || item.kind === 'reference_preset' ? t(`pre.kind.${item.kind}`) : item.kind === 'tag' ? tagTarget(item, t) : '';
  const study = item.kind === 'study' ? item.payload?.study : null;
  const click = (event: MouseEvent) => {
    if (event.shiftKey) { event.preventDefault(); onSelect(item, 'range'); return; }
    if (selecting || event.metaKey || event.ctrlKey) { event.preventDefault(); onSelect(item, 'toggle'); return; }
    onOpen(item);
  };
  return <div className={clsx('lib-card', `lib-card--${item.kind}`, selected && 'is-sel', active && 'is-active', !cover && 'is-text')} data-testid={`card-${item.id}`} data-key={itemKey(item)} data-index={index}>
    <button type="button" className="lib-card-open" aria-label={t('tile.open', { name: title })} aria-pressed={selecting ? selected : undefined} onClick={click}>
      {cover && <span className={clsx('lib-card-cv', item.kind === 'study' && 'is-tall')}><Thumb api={api} item={item} icon={KIND_ICONS[item.kind]} /></span>}
      <span className="lib-card-body">
        <span className="lib-card-title"><b className={clsx(item.kind === 'tag' && 'ui-mono')}>{title}</b>{kindTag && (!cover || (item.kind !== 'tag' && item.kind !== 'study')) && <Tag>{kindTag}</Tag>}</span>
        {item.kind === 'study' ? <span className="lib-card-meta"><span className="ui-num">{study?.width}×{study?.height}</span>{study?.metadataStatus === 'generation' && <Tag tone="accent">{t('imp.badge')}</Tag>}</span>
          : item.kind === 'tag' ? <span className="lib-card-meta">{kindTag && <Tag>{kindTag}</Tag>}<span className="ui-num">{meta}</span></span>
          : <>{text && <span className={clsx('lib-card-text', item.kind !== 'note' && 'ui-mono')}>{text}</span>}{meta && <span className="lib-card-meta"><span>{meta}</span></span>}</>}
        {item.archived && <span className="lib-card-meta"><Tag>{t('lib.archivedBadge')}</Tag></span>}
      </span>
    </button>
    <span className="lib-card-check"><Checkbox variant="overlay" checked={selected} label={t('tile.select')} onChange={() => onSelect(item, 'toggle')} /></span>
    {onAddToTray && !selecting && !item.archived && (item.kind === 'tag' || item.kind === 'combo') && <span className="lib-card-add"><IconButton tone="overlay" size="sm" icon="plus" label={t('tile.addToTray')} onClick={() => onAddToTray(item)} /></span>}
    {!cover && item.kind === 'note' && <span className="lib-card-kind" aria-hidden="true"><Icon name="note" size={14} /></span>}
  </div>;
});
