import clsx from 'clsx';
import type { AssetItem } from '../asset-library/types';
import { assetQueryKey, useLocalAssetQuery } from '../asset-library/query';
import { Button, EmptyState, Spinner } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { libraryErrorText } from './errors';
import { CATEGORY_KINDS, LIBRARY_CATEGORIES, isImageKind, type ArchivedFilter, type LibraryCategory } from './model';
import { cardExcerpt, fileName, itemTitle } from './present';
import { Thumb } from './Thumb';

/** Items shown per category; the group header gives the whole count and opens the category. */
export const SEARCH_ALL_PER_GROUP = 12;
const TITLES: Record<LibraryCategory, 'side.history' | 'side.imports' | 'side.tags' | 'side.combos' | 'side.notes' | 'side.presets' | 'side.artists'> = {
  history: 'side.history', imports: 'side.imports', tags: 'side.tags', combos: 'side.combos', notes: 'side.notes', presets: 'side.presets', artists: 'side.artists',
};
type Page = { items: AssetItem[]; total: number };

/** The ui-list request of one category's group (the same request as the category's own view, one short page). */
export function searchAllRequest(category: LibraryCategory, query: string, archived: ArchivedFilter) {
  const images = category === 'history' || category === 'imports';
  return { action: 'ui-list', kinds: [...CATEGORY_KINDS[category]], query: query.trim(), archived, sortBy: images ? 'createdAt' : 'updatedAt', sortDirection: 'desc', limit: SEARCH_ALL_PER_GROUP };
}

export interface SearchAllProps {
  api: LibraryApi;
  query: string;
  archived: ArchivedFilter;
  /** Opens the item in its category (its drawer). */
  onOpen(item: AssetItem, category: LibraryCategory): void;
  /** Opens the category with the same search. */
  onShowAll(category: LibraryCategory): void;
}

/**
 * 在全部类别中搜 (prototype 01–02 search drop-down, step 4c1): every category searched with the same text as its own
 * view would (the host's ui-list per category: history by image name and prompt tags, the others by their content),
 * results grouped by category, each with its whole count; an item opens in its category.
 */
export function SearchAll({ api, query, archived, onOpen, onShowAll }: SearchAllProps) {
  const { t, lang } = useUiText();
  // One read per category (a fixed list, so the hooks keep their order).
  const groups = LIBRARY_CATEGORIES.map(category => {
    const request = searchAllRequest(category, query, archived);
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const read = useLocalAssetQuery<Page>(assetQueryKey(api, 'ui-search-all', request), () => api.assetLibrary(request), !!query.trim());
    return { category, read };
  });
  const pending = groups.some(group => group.read.isPending);
  const found = groups.filter(group => (group.read.data?.total ?? 0) > 0);
  const total = found.reduce((sum, group) => sum + (group.read.data?.total ?? 0), 0);
  return <div className="lib-all" data-testid="library-search-all" aria-busy={pending || undefined}>
    <div className="lib-head"><h1>{t('all.title', { q: query.trim() })}</h1>
      <span className="ui-muted ui-num" data-testid="library-search-all-count">{pending && !found.length ? t('c.loading') : t('lib.count.items', { n: total })}</span></div>
    {groups.filter(group => group.read.error).map(group => <p key={group.category} className="lib-error" role="alert">{t(TITLES[group.category])} · {libraryErrorText(group.read.error, t, lang)}</p>)}
    {!pending && !found.length && !groups.some(group => group.read.error) && <EmptyState icon="search" title={t('empty.search.t')} body={t('all.none')} />}
    {found.map(({ category, read }) => {
      const page = read.data!;
      return <section key={category} className="lib-all-group" data-testid={`search-all-${category}`} data-total={page.total}>
        <div className="lib-all-h">
          <h2>{t(TITLES[category])}</h2><span className="ui-faint ui-num">{t('lib.count.items', { n: page.total })}</span>
          <Button size="sm" variant="ghost" iconAfter="right" onClick={() => onShowAll(category)} data-testid={`search-all-more-${category}`}>{t('all.showAll', { n: page.total })}</Button>
        </div>
        <div className={clsx('lib-all-items', page.items.some(item => isImageKind(item.kind)) && 'is-images')}>
          {page.items.map(item => <ResultItem key={`${item.kind}:${item.id}`} api={api} item={item} t={t} onOpen={() => onOpen(item, category)} />)}
        </div>
      </section>;
    })}
    {pending && found.length > 0 && <p className="lib-wait" role="status"><Spinner size={14} /> {t('c.loading')}</p>}
  </div>;
}

function ResultItem({ api, item, t, onOpen }: { api: LibraryApi; item: AssetItem; t: UiText; onOpen(): void }) {
  const title = item.kind === 'study' ? fileName(item) : itemTitle(item);
  if (isImageKind(item.kind)) return <button type="button" className="lib-all-img" onClick={onOpen} title={title} aria-label={t('tile.open', { name: title })} data-testid={`search-all-item-${item.id}`}>
    <Thumb api={api} item={item} alt="" />
  </button>;
  const excerpt = cardExcerpt(item, t);
  return <button type="button" className="lib-all-card" onClick={onOpen} aria-label={t('tile.open', { name: title })} data-testid={`search-all-item-${item.id}`}>
    {item.preview && <Thumb api={api} item={item} alt="" icon={item.kind === 'tag' ? 'tag' : 'image'} />}
    <span className="lib-all-card-tx"><b className={clsx(item.kind === 'tag' && 'ui-mono')}>{title}</b>{excerpt.text && <span className="ui-faint">{excerpt.text}</span>}</span>
  </button>;
}
