import { memo, type CSSProperties, type MouseEvent } from 'react';
import clsx from 'clsx';
import type { AssetItem } from '../asset-library/types';
import { Checkbox, Icon, IconButton, MenuButton, Tag, type MenuEntry } from '../ui';
import { formatTime, type useUiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { Thumb } from './Thumb';
import { imageAspect, imageCreatedAt, imageSource, itemKey } from './model';
import { itemTitle } from './present';

export interface TileHandlers {
  onOpen(item: AssetItem): void;
  /** A click that selects: shift extends from the last one, meta/ctrl toggles and starts selecting. */
  onSelect(item: AssetItem, mode: 'toggle' | 'range'): void;
  collectEntries(item: AssetItem): MenuEntry[];
}

/**
 * One image of the grid (VirtualGrid.tsx renders the rows): the picture keeps its aspect ratio in a justified row.
 * The agent dot and the collection star always show; the selection box, the collect button and the time/size line
 * appear on hover (user decision 9). index: its place in the view's order (data-index).
 */
export type TileProps = TileHandlers & { api: LibraryApi; item: AssetItem; index: number; selected: boolean; selecting: boolean; active: boolean; favorited: boolean; source: ReturnType<typeof imageSource>; t: ReturnType<typeof useUiText>['t'];
  /** Its place in the grid (grid-layout.ts): a tile keeps its element when the layout changes, so focus and picture stay. */
  x: number; y: number; w: number; h: number };
export const ImageTile = memo(function ImageTile({ api, item, index, selected, selecting, active, favorited, source, t, onOpen, onSelect, collectEntries, x, y, w, h }: TileProps) {
  const title = itemTitle(item);
  const width = Number(item.payload?.width), height = Number(item.payload?.height);
  const click = (event: MouseEvent) => {
    if (event.shiftKey) { event.preventDefault(); onSelect(item, 'range'); return; }
    if (selecting || event.metaKey || event.ctrlKey) { event.preventDefault(); onSelect(item, 'toggle'); return; }
    onOpen(item);
  };
  return <div className={clsx('lib-tile', selected && 'is-sel', active && 'is-active')} style={{ '--ar': imageAspect(item), transform: `translate(${x}px, ${y}px)`, width: w, height: h } as CSSProperties} data-testid={`tile-${item.id}`} data-key={itemKey(item)} data-index={index}>
    <button type="button" className="lib-tile-open" aria-label={t('tile.open', { name: title })} aria-pressed={selecting ? selected : undefined} onClick={click}>
      <Thumb api={api} item={item} alt="" />
    </button>
    <span className="lib-tile-ov" aria-hidden="true" />
    <span className="lib-tile-tl"><Checkbox variant="overlay" checked={selected} label={t('tile.select')} onChange={() => onSelect(item, 'toggle')} /></span>
    {!selecting && <span className="lib-tile-tr">
      <MenuButton label={t('tile.collect')} placement="bottom-end" entries={collectEntries(item)}>{trigger => <IconButton {...trigger} tone="overlay" size="sm" icon={favorited ? 'starFill' : 'star'} label={t('tile.collect')} />}</MenuButton>
    </span>}
    <span className="lib-tile-bl" aria-hidden="true">
      <span>{formatTime(imageCreatedAt(item))}</span>
      {width > 0 && height > 0 && <span className="ui-num">{width}×{height}</span>}
      {source.kind === 'agent' && <span className="lib-tile-agent">{source.label}</span>}
    </span>
    {source.kind === 'agent' && <i className="lib-tile-src" title={t('tile.fromAgent', { name: source.label })} aria-label={t('tile.fromAgent', { name: source.label })} />}
    {favorited && <span className="lib-tile-fav" title={t('tile.collected')}><Icon name="starFill" size={14} /></span>}
    {item.archived && <span className="lib-tile-arch"><Tag>{t('lib.archivedBadge')}</Tag></span>}
  </div>;
});
