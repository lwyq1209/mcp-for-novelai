import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { assetQueryKey, useLocalAssetQuery } from '../asset-library/query';
import { Icon, SearchInput, Spinner } from '../ui';
import { useUiText } from '../ui/i18n';
import type { LibraryApi } from './api';

type Suggestions = { tags: Array<{ tag: string; sources: string[]; count: number }> };

export interface SearchBoxProps {
  api: LibraryApi;
  value: string;
  onChange(text: string): void;
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  /** 在全部类别中搜 (step 4c1): offered while text is typed and the view is not already searching everything. */
  onSearchAll?(): void;
  /** History views: the saved prompt tags matching the text, to filter by one exactly (step 4c1). */
  onAddTag?(tag: string): void;
}

function useDebounced<T>(value: T, ms: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return current;
}

/**
 * The library's search box (⌘K) with its drop-down (prototype 01–02, step 4c1): while text is typed it offers to search
 * all categories, and in history views the saved prompt tags that contain the text (the host's history tag index, with
 * their image counts) to filter by. ↓ moves into the list, ↑ ↓ through it, Esc closes it.
 */
export function SearchBox({ api, value, onChange, inputRef, placeholder, onSearchAll, onAddTag }: SearchBoxProps) {
  const { t } = useUiText();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const text = value.trim();
  const lookup = useDebounced(text, 180);
  const suggestions = useLocalAssetQuery<Suggestions>(assetQueryKey(api, 'history-tag-suggestions', lookup),
    () => api.assetLibrary({ action: 'tag-suggestions', query: lookup, limit: 8 }), open && !!onAddTag && !!lookup && lookup === text);
  const shown = open && !!text && (!!onSearchAll || !!onAddTag);
  const options = () => [...(box.current?.querySelectorAll<HTMLButtonElement>('.lib-search-opt') ?? [])];
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && shown) { event.preventDefault(); setOpen(false); inputRef.current?.focus(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = options(); if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    event.preventDefault();
    if (at < 0) { if (event.key === 'ArrowDown') list[0].focus(); return; }
    const next = at + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) inputRef.current?.focus(); else list[Math.min(next, list.length - 1)].focus();
  };
  return <div ref={box} className="lib-searchbox" onFocus={() => setOpen(true)} onKeyDown={move}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <SearchInput className="lib-search" value={value} onChange={next => { onChange(next); setOpen(true); }} placeholder={placeholder} label={t('lib.searchShort')} shortcut="⌘K" clearLabel={t('lib.clearSearch')} inputRef={inputRef} />
    {shown && <div className="lib-search-pop" role="group" aria-label={t('lib.searchPop')} data-testid="lib-search-pop">
      {onSearchAll && <button type="button" className="lib-search-opt" onClick={() => { onSearchAll(); setOpen(false); }} data-testid="lib-search-all">
        <Icon name="search" size={14} /><span>{t('lib.searchAll', { q: text })}</span></button>}
      {onAddTag && <>
        <div className="lib-search-h">{t('lib.tags.h')}</div>
        {!suggestions.data && (suggestions.isFetching || lookup !== text) && <p className="lib-search-note" role="status"><Spinner size={12} /> {t('c.loading')}</p>}
        {suggestions.error && <p className="lib-search-note">{t('lib.tags.failed')}</p>}
        {suggestions.data?.tags.map(tag => <button key={tag.tag} type="button" className="lib-search-opt" aria-label={t('lib.tags.add', { tag: tag.tag })}
          onClick={() => { onAddTag(tag.tag); onChange(''); setOpen(false); inputRef.current?.focus(); }} data-testid={`lib-tag-suggest-${tag.tag}`}>
          <Icon name="tag" size={14} /><span className="ui-mono">{tag.tag}</span><span className="ui-faint ui-num">{t('lib.tags.count', { n: tag.count })}</span>
        </button>)}
        {suggestions.data && !suggestions.data.tags.length && <p className="lib-search-note">{t('lib.tags.none')}</p>}
      </>}
    </div>}
  </div>;
}
