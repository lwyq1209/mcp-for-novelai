import type { ReactNode, RefObject } from 'react';
import { Button, Chip, IconButton, MenuButton, Seg, type MenuEntry } from '../ui';
import type { LibraryApi } from './api';
import { SearchBox } from './SearchBox';
import { useUiText, type UiText } from '../ui/i18n';
import { DATE_FILTERS, GENERATION_MODES, filtersActive, type ArchivedFilter, type DateFilter, type ImageFilters } from './model';
import { modelName } from './present';

export type ThumbSize = 's' | 'm' | 'l';

export interface ToolbarProps {
  api: LibraryApi;
  search: string;
  /** Searching all categories (step 4c1): the drop-down offers it; while on, a chip says so and turns it off. */
  scopeAll?: boolean;
  onScopeAll?(on: boolean): void;
  /** History views: filter by a saved prompt tag picked in the drop-down (step 4c1). */
  onAddTag?(tag: string): void;
  onSearch(text: string): void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Archived items: not shown, shown with the others, or only them (the host list's archived filter). */
  archived: ArchivedFilter;
  onArchived(value: ArchivedFilter): void;
  /** Generation history views: the mode / model / date / source filters. */
  filters?: ImageFilters;
  onFilters?(filters: ImageFilters): void;
  /** The view's models, agents and months (the host's list summary). */
  choices?: { models: string[]; agents: string[]; months?: Array<{ month: string; count: number }> };
  /** Collections: imported images can be picked as a source. */
  importedSource?: boolean;
  /** With the drawer open the filters fold into one 筛选 chip (prototype 02). */
  compact: boolean;
  size?: ThumbSize;
  onSize?(size: ThumbSize): void;
  selecting?: boolean;
  onToggleSelecting?(): void;
  actions?: ReactNode;
  moreEntries: MenuEntry[];
}

function modeLabel(t: UiText, mode: string) { return t(`mode.${mode}` as 'mode.t2i'); }
function monthLabel(t: UiText, lang: string, month: string) {
  const [year, index] = month.split('-').map(Number);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return t('lib.date.month', { year: String(year), month: lang === 'zh' ? String(index) : names[index - 1] ?? String(index) });
}
function dateLabel(t: UiText, lang: string, date: string) { return date.startsWith('month:') ? monthLabel(t, lang, date.slice('month:'.length)) : t(`lib.date.${date}` as 'lib.date.today'); }
function sourceLabel(t: UiText, source: string) { return source === 'agent' ? t('lib.src.agent') : source === 'manual' ? t('lib.src.manual') : source === 'imported' ? t('lib.src.imported') : source.slice('agent:'.length); }
const ARCHIVED: readonly ArchivedFilter[] = ['exclude', 'include', 'only'];

/** The search box, the filter chips (or one 筛选 chip), thumbnail size, 选择, the view's own actions and ⋯. */
export function Toolbar({ api, search, scopeAll = false, onScopeAll, onAddTag, onSearch, searchRef, archived, onArchived, filters: shownFilters, onFilters, choices, importedSource, compact, size, onSize, selecting, onToggleSelecting, actions, moreEntries }: ToolbarProps) {
  // Searching all categories shows no image filters (they belong to one view); the archived choice applies to all.
  const filters = scopeAll ? undefined : shownFilters;
  const { t, lang } = useUiText();
  const set = (patch: Partial<ImageFilters>) => filters && onFilters?.({ ...filters, ...patch });
  const any = (current: string, patch: Partial<ImageFilters>): MenuEntry => ({ id: 'any', label: t('lib.f.any'), checked: !current, onSelect: () => set(patch) });
  const modeEntries: MenuEntry[] = filters ? [any(filters.mode, { mode: '' }), ...GENERATION_MODES.map(mode => ({ id: mode, label: modeLabel(t, mode), checked: filters.mode === mode, onSelect: () => set({ mode }) }))] : [];
  const modelEntries: MenuEntry[] = filters ? [any(filters.model, { model: '' }), ...(choices?.models ?? []).map(model => ({ id: model, label: modelName(model), checked: filters.model === model, onSelect: () => set({ model }) }))] : [];
  // The last days, then the months of the view (newest first, with their image counts).
  const months = choices?.months ?? [];
  const selectedMonth = filters?.date.startsWith('month:') ? filters.date.slice('month:'.length) : '';
  const dateEntries: MenuEntry[] = filters ? [any(filters.date, { date: '' }), ...DATE_FILTERS.map(date => ({ id: date, label: dateLabel(t, lang, date), checked: filters.date === date, onSelect: () => set({ date }) })),
    ...(months.length || selectedMonth ? [{ kind: 'heading' as const, id: 'months', label: t('lib.date.months') }] : []),
    ...(selectedMonth && !months.some(value => value.month === selectedMonth) ? [{ month: selectedMonth, count: 0 }] : []).concat(months).map(value => ({ id: `month:${value.month}`, label: value.count ? t('lib.date.monthCount', { label: monthLabel(t, lang, value.month), n: value.count }) : monthLabel(t, lang, value.month),
      checked: filters.date === `month:${value.month}`, onSelect: () => set({ date: `month:${value.month}` as DateFilter }) }))] : [];
  const sourceEntries: MenuEntry[] = filters ? [any(filters.source, { source: '' }), { id: 'agent', label: t('lib.src.agent'), checked: filters.source === 'agent', onSelect: () => set({ source: 'agent' }) },
    ...(choices?.agents ?? []).map(agent => ({ id: `agent:${agent}`, label: agent, checked: filters.source === `agent:${agent}`, onSelect: () => set({ source: `agent:${agent}` }) })),
    { id: 'manual', label: t('lib.src.manual'), checked: filters.source === 'manual', onSelect: () => set({ source: 'manual' }) },
    ...(importedSource ? [{ id: 'imported', label: t('lib.src.imported'), checked: filters.source === 'imported', onSelect: () => set({ source: 'imported' }) }] : [])] : [];
  const chip = (label: string, value: string, shown: string, entries: MenuEntry[]) => <MenuButton key={label} label={label} entries={entries}>{trigger => <Chip {...trigger} caret active={!!value}>{value ? `${label} · ${shown}` : label}</Chip>}</MenuButton>;
  const archivedEntries: MenuEntry[] = ARCHIVED.map(value => ({ id: `arch-${value}`, label: t(`lib.f.arch.${value}`), checked: archived === value, onSelect: () => onArchived(value) }));
  const archivedChip = <MenuButton label={t('lib.f.arch')} entries={archivedEntries}>{trigger => <Chip {...trigger} caret active={archived !== 'exclude'}>{archived === 'exclude' ? t('lib.f.arch') : `${t('lib.f.arch')} · ${t(`lib.f.arch.${archived}`)}`}</Chip>}</MenuButton>;
  const activeCount = filters ? [filters.mode, filters.model, filters.date, filters.source].filter(Boolean).length + (archived !== 'exclude' ? 1 : 0) : 0;
  const folded: MenuEntry[] = filters ? [
    { kind: 'heading', id: 'h-mode', label: t('lib.f.mode') }, ...modeEntries.map(entry => ({ ...entry, id: `mode-${entry.id}`, keepOpen: true })),
    { kind: 'heading', id: 'h-model', label: t('lib.f.model') }, ...modelEntries.map(entry => ({ ...entry, id: `model-${entry.id}`, keepOpen: true })),
    { kind: 'heading', id: 'h-date', label: t('lib.f.date') }, ...dateEntries.map(entry => ({ ...entry, id: `date-${entry.id}`, keepOpen: true })),
    { kind: 'heading', id: 'h-source', label: t('lib.f.source') }, ...sourceEntries.map(entry => ({ ...entry, id: `source-${entry.id}`, keepOpen: true })),
    { kind: 'heading', id: 'h-arch', label: t('lib.f.arch') }, ...archivedEntries.map(entry => ({ ...entry, keepOpen: true })),
    ...(filtersActive(filters) || archived !== 'exclude' ? [{ kind: 'separator' as const, id: 's1' }, { id: 'clear', icon: 'x' as const, label: t('lib.f.clear'), onSelect: () => { onFilters?.({ mode: '', model: '', date: '', source: '' }); onArchived('exclude'); } }] : []),
  ] as MenuEntry[] : [];
  return <div className="lib-toolbar" role="toolbar" aria-label={t('lib.label')}>
    <SearchBox api={api} value={search} onChange={onSearch} placeholder={t('lib.search')} inputRef={searchRef} onSearchAll={onScopeAll && !scopeAll ? () => onScopeAll(true) : undefined} onAddTag={scopeAll ? undefined : onAddTag} />
    {scopeAll && onScopeAll && <Chip active icon="search" onClick={() => onScopeAll(false)} title={t('lib.searchAllOff')} data-testid="lib-scope-all">{t('lib.searchAllOn')} ×</Chip>}
    {filters && !compact && <>
      {chip(t('lib.f.mode'), filters.mode, filters.mode ? modeLabel(t, filters.mode) : '', modeEntries)}
      {chip(t('lib.f.model'), filters.model, filters.model ? modelName(filters.model) : '', modelEntries)}
      {chip(t('lib.f.date'), filters.date, filters.date ? dateLabel(t, lang, filters.date) : '', dateEntries)}
      {chip(t('lib.f.source'), filters.source, filters.source ? sourceLabel(t, filters.source) : '', sourceEntries)}
      {archivedChip}
    </>}
    {filters && compact && <MenuButton label={t('lib.f.filters')} entries={folded}>{trigger => <Chip {...trigger} icon="filter" caret active={activeCount > 0}>{activeCount > 0 ? `${t('lib.f.filters')} · ${activeCount}` : t('lib.f.filters')}</Chip>}</MenuButton>}
    {!filters && archivedChip}
    <div className="lib-toolbar-gap" />
    {size && onSize && <Seg<ThumbSize> label={t('lib.size')} value={size} onChange={onSize} options={[
      { value: 's', icon: 'gridS', ariaLabel: t('lib.size.s'), title: t('lib.size.s') }, { value: 'm', icon: 'grid', ariaLabel: t('lib.size.m'), title: t('lib.size.m') }, { value: 'l', icon: 'gridL', ariaLabel: t('lib.size.l'), title: t('lib.size.l') },
    ]} />}
    {onToggleSelecting && <Button icon="selectbox" variant={selecting ? 'primary' : 'default'} aria-pressed={!!selecting} onClick={onToggleSelecting}>{t('lib.select')}</Button>}
    {actions}
    <MenuButton label={t('lib.more')} entries={moreEntries} placement="bottom-end">{trigger => <IconButton {...trigger} icon="more" label={t('lib.more')} />}</MenuButton>
  </div>;
}
