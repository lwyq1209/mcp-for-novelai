import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { LayoutSection } from './grid-layout';
import clsx from 'clsx';
import type { AssetCollection, AssetDetail, AssetItem } from '../asset-library/types';
import { assetQueryKey, invalidateAssetQueries, useLocalAssetQuery } from '../asset-library/query';
import { hostMessageText } from '../host-errors/compose';
import { useAppStore } from '../store';
import type { HistoryItem } from '../types';
import { Button, Chip, ConfirmDialog as ConfirmDialogLite, Dialog, Dot, Drawer, EmptyState, IconButton, MenuButton, Seg, Spinner, Tag, showToast, type MenuEntry } from '../ui';
import { uiText, useUiText, type UiText } from '../ui/i18n';
import { navigate } from '../shell/route';
import type { CaptureRequest } from '../shell/capture';
import { useQueueView, type QueueMonitor } from '../workspace/queue-monitor';
import type { MaterialComponent } from '../workspace/material-library-types';
import { imageFromAssetDetail, stageImageInput } from '../app/ImageActions';
import { HistoryParametersDialog } from '../canvas/HistoryParametersDialog';
import { applyLibraryItem } from '../asset-library/apply';
import ReferencePresetManager, { ReferenceImportReview } from './ReferencePresets';
import type { ReferenceImportPreview } from '../types';
import { addToCollection, commitDeleteCollection, createCollection, moveToProject, previewDeleteCollection, removeFromCollection, removeFromProjects, renameCollection, restoreListed, setArchived, type LibraryApi } from './api';
import { libraryErrorText } from './errors';
import { useCategoryCounts, useCollections, useItemDetail, useLibraryChanges, useLibraryItems, useMembershipIndex } from './data';
import {
  batchIndex, dayGroups, DEFAULT_VIEW, filterArgs, filtersActive, hasImageFilters, imageAspect, isImageKind, isImageView, isTrayView, itemKey, listRequest,
  neighbour, NO_FILTERS, PRESET_FILTERS, projectGroupId, rangeSelection, refreshSelection, sameView, shortcutsBlocked, viewKey, type ArchivedFilter, type DayGroup, type ImageFilters, type LibraryView, type PresetFilter,
} from './model';
import { localDayKey } from './image-facts';
import { Sidebar } from './Sidebar';
import { Toolbar, type ThumbSize } from './Toolbar';
import { ROW_HEIGHTS, VirtualGrid, type VirtualGridHandle } from './VirtualGrid';
import { ImageDetail, detailImage, type ImageTab } from './ImageDetail';
import { MaterialDetail, hasUnsavedDraft, type NewKind } from './MaterialDetail';
import { SelectionBar } from './SelectionBar';
import { DeleteDialog, NameDialog, type DeletedResult, type DeleteTarget } from './dialogs';
import { CreateDialog } from './CreateDialog';
import { ComboTray, trayMembersOf } from './ComboTray';
import { ImportReader, acceptImportFiles } from './ImportReader';
import { TrashView } from './TrashView';
import { VersionHistory } from './VersionHistory';
import { SearchAll } from './SearchAll';
import { exportLibraryBackup, LIBRARY_BACKUP_MAX_BYTES, parseLibraryBackup, saveJsonFile } from './library-backup';
import { backupImportText, backupParseText, LibraryBackupImport } from './LibraryBackupImport';
import type { MaterialBackup } from '../workspace/material-library-types';
import { versionUse } from './versions';
import { applyReportToCanvas, readReport, reportHasSettings } from './image-meta';
import { fileName, itemTitle } from './present';
import { captureScenario, type LibraryScenario } from './scenarios';
import { useLibraryIntent } from './intent';
import './library.css';

type PageDialog =
  | { type: 'delete'; target: DeleteTarget }
  | { type: 'newCollection'; items?: AssetItem[] }
  | { type: 'renameCollection'; collection: AssetCollection }
  | { type: 'deleteCollection'; collection: AssetCollection; members: number }
  | { type: 'renameProject'; project: AssetCollection }
  | { type: 'deleteProject'; project: AssetCollection; members: number }
  | { type: 'renameItem'; item: AssetItem }
  | { type: 'create'; kind: NewKind };

function useDebounced<T>(value: T, ms: number) {
  const [current, setCurrent] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setCurrent(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return current;
}

const VIEW_TITLES = { history: 'side.history', imports: 'side.imports', tags: 'side.tags', combos: 'side.combos', notes: 'side.notes', presets: 'side.presets', artists: 'side.artists' } as const;
const EMPTY_KEYS = { history: 'history', imports: 'imports', tags: 'tags', combos: 'combos', notes: 'notes', presets: 'presets', artists: 'artists' } as const;
/** A card row's height before it is measured (grid-layout.ts): a cover card, an imported image or a text card. */
function cardEstimate(item: AssetItem): (columnWidth: number) => number {
  const cover = item.kind === 'tag' || item.kind === 'study' || item.kind === 'artist_favorite' || !!item.preview;
  return width => cover ? width * (item.kind === 'study' ? 4 / 3 : 0.75) + 66 : 140;
}
/** Near the end of what is loaded, the drawer's → loads the next page. */
const ARROW_LOOKAHEAD = 12;

export interface LibraryPageProps { api: LibraryApi; active: boolean; monitor: QueueMonitor | null; capture?: CaptureRequest | null; /** Capture runs: the sample image the 导入图片 reading scenario opens. */ sampleImport?: () => Promise<File> }

/**
 * The library page (step 4b1, prototype 01–12): sidebar, toolbar, the images by day or the cards of the other kinds,
 * the detail drawer, multiple selection with its bar, the delete and empty-archived confirmations (effects from the
 * host's preview first), projects, imports with their settings read first, the combo tray and Recently deleted.
 */
export function LibraryPage({ api, active, monitor, capture = null, sampleImport }: LibraryPageProps) {
  const { t, lang } = useUiText();
  useLibraryChanges(api);
  const scenario = useMemo<LibraryScenario | null>(() => capture ? captureScenario(capture.page) : null, [capture]);
  const [view, setViewState] = useState<LibraryView>(scenario?.view ?? DEFAULT_VIEW);
  const [search, setSearch] = useState('');
  const query = useDebounced(search, 250);
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>('exclude');
  const [filters, setFilters] = useState<ImageFilters>(NO_FILTERS);
  const [presetFilter, setPresetFilter] = useState<PresetFilter>('all');
  // Step 4c1: 在全部类别中搜 (results grouped by category), and prompt tag filters of history images (all / any).
  const [scopeAll, setScopeAll] = useState(false);
  const [historyTags, setHistoryTags] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<'all' | 'any'>('all');
  useEffect(() => { if (!search.trim()) setScopeAll(false); }, [search]);
  const [size, setSize] = useState<ThumbSize>('m');
  const [selecting, setSelecting] = useState(!!scenario?.selected);
  const [selected, setSelected] = useState<ReadonlyMap<string, AssetItem>>(new Map());
  const anchor = useRef<string | null>(null);
  const [open, setOpen] = useState<{ kind: AssetItem['kind']; id: string } | null>(scenario?.open ?? null);
  const [tab, setTab] = useState<ImageTab>(scenario?.tab ?? 'prompt');
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<PageDialog | null>(scenario?.dialog === 'archived' ? { type: 'delete', target: { kind: 'archived' } } : null);
  const [tray, setTray] = useState<MaterialComponent[]>([]);
  const [importFiles, setImportFiles] = useState<File[] | null>(null);
  const [referenceManager, setReferenceManager] = useState(false);
  const [referenceImport, setReferenceImport] = useState<ReferenceImportPreview | null>(null);
  const [paramsItem, setParamsItem] = useState<HistoryItem | null>(null);
  // 版本历史 of the item the drawer shows (its kind:id; closed when the drawer shows another item).
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  const paramsBefore = useRef<unknown>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const grid = useRef<VirtualGridHandle | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const backupInput = useRef<HTMLInputElement | null>(null);
  const [backup, setBackup] = useState<MaterialBackup | null>(null);

  const counts = useCategoryCounts(api, active);
  const collections = useCollections(api, active);
  const memberships = useMembershipIndex(api, collections.user, active);
  const queue = useQueueView(monitor);
  const batches = useMemo(() => batchIndex(queue.batches), [queue.batches]);
  // The filters go to the host (ui-list); a date range is fixed for the day it was set on (local midnight).
  const today = localDayKey(new Date().toISOString());
  const searchAll = scopeAll && !!query.trim() && view.type !== 'trash';
  const tagFilters = hasImageFilters(view) && historyTags.length ? historyTags : null;
  const request = useMemo(() => view.type === 'trash' || searchAll ? null : {
    ...listRequest(view, { query, archived: archivedFilter, presetFilter, filters: filterArgs(filters) }), ...(isImageView(view) ? { summary: true } : {}),
    ...(tagFilters ? { historyTags: tagFilters, historyTagMatch: tagMatch } : {}),
  }, [view, query, archivedFilter, presetFilter, filters, today, searchAll, tagFilters, tagMatch]);
  const listKey = useMemo(() => JSON.stringify(request), [request]);
  const list = useLibraryItems(api, request, active);
  // A filtered result: image filters, or only archived items (the header says it is a filter's result).
  const filtering = (hasImageFilters(view) && (filtersActive(filters) || !!tagFilters)) || archivedFilter === 'only';
  const visible = list.items;
  const choices = useMemo(() => ({ models: list.summary?.models ?? [], agents: list.summary?.agents ?? [], months: list.summary?.months ?? [] }), [list.summary]);
  const order = useMemo(() => visible.map(itemKey), [visible]);
  const byKey = useMemo(() => new Map(visible.map(item => [itemKey(item), item])), [visible]);
  const detailQuery = useItemDetail(api, open, active);
  const listItem = open ? list.items.find(item => item.kind === open.kind && item.id === open.id) : undefined;
  const detail = detailQuery.data && open && detailQuery.data.item.kind === open.kind && detailQuery.data.item.id === open.id ? detailQuery.data : undefined;

  // The selection follows the saved state: an item that changed (moved to a project, renamed, archived) is kept with
  // its current revision, so a later delete or archive does not send an old snapshot.
  useEffect(() => { setSelected(current => refreshSelection(current, list.items)); }, [list.items]);

  // Scrolling near the end of what is loaded loads the next page (the grid asks).
  const loadMore = useRef(list.loadMore);
  loadMore.current = list.loadMore;
  const onNearEnd = useCallback(() => { if (active) loadMore.current(); }, [active]);

  // The grid keeps each list's place itself (VirtualGrid): another section opens at its own last place, or the top.
  const setView = useCallback((next: LibraryView) => {
    setScopeAll(false);
    if (sameView(next, view)) return;
    setViewState(next); setSelected(new Map()); setSelecting(false); setOpen(null); setEditing(false); anchor.current = null;
    setReferenceManager(false); if (!isTrayView(next)) setTray([]);
  }, [view]);

  // Another page asked to show a view or an item (the queue page's finished images, step 4b2).
  const intent = useLibraryIntent(state => state.intent);
  const intentSeen = useRef(0);
  useEffect(() => {
    if (!intent || intent.seq === intentSeen.current) return;
    intentSeen.current = intent.seq;
    setView(intent.view ?? DEFAULT_VIEW);
    if (intent.open) { setOpen(intent.open); setTab('prompt'); }
  }, [intent, setView]);

  // Capture scenarios: a selection, a dialog or a menu that is open in the prototype's screenshot.
  useEffect(() => {
    if (!scenario || !list.items.length) return;
    if (scenario.selected && !selected.size) setSelected(new Map(list.items.filter(item => scenario.selected!.includes(item.id)).map(item => [itemKey(item), item])));
    if (scenario.tray && !tray.length) setTray(list.items.filter(item => scenario.tray!.includes(item.id)).flatMap(trayMembersOf));
    if (scenario.dialog === 'delete' && !dialog) setDialog({ type: 'delete', target: { kind: 'items', items: list.items.filter(item => scenario.selected?.includes(item.id)) } });
    if (scenario.click) { const timer = setTimeout(() => document.querySelector<HTMLElement>(`[data-capture="${scenario.click}"]`)?.click(), 700); return () => clearTimeout(timer); }
  }, [scenario, list.items.length]);
  // Host-backed large-library captures: load pages up to the middle image of the history, show it (and open it).
  const middleShown = useRef(false);
  useEffect(() => {
    if (!scenario?.hostMiddle || middleShown.current || !list.total) return;
    const middle = Math.floor(list.total / 2), item = list.items[middle];
    if (!item) { if (!list.loadingMore && list.hasMore) list.loadMore(); return; }
    middleShown.current = true;
    requestAnimationFrame(() => { grid.current?.reveal(itemKey(item)); if (scenario.hostMiddle === 'open') setOpen({ kind: item.kind, id: item.id }); });
  }, [scenario, list.items.length, list.total, list.loadingMore, list.hasMore]);
  useEffect(() => {
    if (!scenario?.importFile || !sampleImport) return;
    let live = true;
    void sampleImport().then(file => { if (live) setImportFiles([file]); });
    return () => { live = false; };
  }, [scenario]);

  // Keyboard: ⌘K search, Esc leaves selection then closes the drawer, ← → in the drawer.
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Not while a dialog, menu, the settings dialog or the first-run guide is open over the page.
      if (shortcutsBlocked(document)) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); searchRef.current?.focus(); return; }
      const typing = event.target instanceof HTMLElement && !!event.target.closest('input,textarea,select,[contenteditable="true"]');
      if (event.key === 'Escape' && !typing) { if (selecting) { setSelecting(false); setSelected(new Map()); } else if (open) closeDrawer(); return; }
      if (!typing && open && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { const next = neighbour(order, `${open.kind}:${open.id}`, event.key === 'ArrowRight' ? 1 : -1); if (next) openKey(next); else if (event.key === 'ArrowRight' && list.hasMore) loadMore.current(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, selecting, open, order, list.hasMore]);

  // Closing the drawer (Esc, its close button) puts the focus on the tile of the image or card it showed (after ← →
  // that is the one the grid marks as active), else the tile that opened it.
  const opener = useRef<string | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // The grid renders only the rows near the view: it scrolls the tile into view first, then focuses it.
  const focusTile = (key: string | null) => !!key && !!grid.current?.focus(key);
  const closeDrawer = () => {
    const shown = open ? `${open.kind}:${open.id}` : null, first = opener.current;
    setOpen(null); setEditing(false);
    requestAnimationFrame(() => { if (!focusTile(shown)) focusTile(first); });
  };
  const openKey = (key: string) => {
    const index = order.indexOf(key), item = visible[index];
    if (!item) return;
    setOpen({ kind: item.kind, id: item.id }); setEditing(false);
    if (index >= order.length - ARROW_LOOKAHEAD && list.hasMore) loadMore.current();
  };
  const onOpen = useCallback((item: AssetItem) => { setOpen({ kind: item.kind, id: item.id }); setEditing(false); anchor.current = itemKey(item); opener.current = itemKey(item); }, []);
  const onSelect = useCallback((item: AssetItem, mode: 'toggle' | 'range') => {
    setSelecting(true);
    const key = itemKey(item);
    setSelected(current => {
      const next = new Map(current);
      if (mode === 'range') { for (const value of rangeSelection(order, anchor.current, key)) { const found = byKey.get(value); if (found) next.set(value, found); } }
      else if (next.has(key)) next.delete(key); else next.set(key, item);
      return next;
    });
    anchor.current = key;
  }, [order, byKey]);

  const fail = (failure: unknown) => showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' });
  const run = async (work: () => Promise<unknown>) => { try { await work(); } catch (failure) { fail(failure); } };
  const addToTray = useCallback((item: AssetItem) => { setTray(current => [...current, ...trayMembersOf(item)]); showToast({ message: t('tray.added'), tone: 'ok', durationMs: 1800 }); }, [t]);

  // ── Collections ──────────────────────────────────────────────────────────
  const inCollection = (item: AssetItem, collectionId: string) => (memberships.get(itemKey(item)) ?? []).includes(collectionId);
  const collectEntries = (items: AssetItem[], memberOf?: (collectionId: string) => boolean): MenuEntry[] => [
    ...(collections.user.length ? collections.user.map(collection => {
      const checked = items.length > 0 && items.every(item => memberOf ? memberOf(collection.id) : inCollection(item, collection.id));
      return { id: collection.id, icon: 'collection' as const, label: collection.name, checked, onSelect: () => void run(async () => {
        if (checked) await removeFromCollection(api, items, collection.id); else await addToCollection(api, items, collection.id);
        if (!checked) showToast({ message: t('sel.collected', { name: collection.name }), tone: 'ok' });
      }) };
    }) : [{ kind: 'heading' as const, id: 'none', label: t('d.collect.none') }]),
    { kind: 'separator', id: 'sep' },
    { id: 'new', icon: 'plus', label: t('d.collect.new'), onSelect: () => setDialog({ type: 'newCollection', items }) },
  ];
  const tileCollectEntries = useCallback((item: AssetItem) => collectEntries([item]), [collections.user, memberships]);
  const collectionMenu = (collection: AssetCollection): MenuEntry[] => [
    { id: 'rename', icon: 'edit', label: t('c.rename'), onSelect: () => setDialog({ type: 'renameCollection', collection }) },
    { id: 'delete', icon: 'trash', danger: true, label: t('coll.delete'), onSelect: () => setDialog({ type: 'deleteCollection', collection, members: collections.counts[collection.id] ?? 0 }) },
  ];
  const projectMenu = (project: AssetCollection): MenuEntry[] => [
    { id: 'rename', icon: 'edit', label: t('proj.rename'), onSelect: () => setDialog({ type: 'renameProject', project }) },
    { id: 'export', icon: 'download', label: t('proj.export'), onSelect: () => void run(async () => {
      // The outcome replaces the "exporting" toast in place (one toast, not two).
      const key = `project-export:${project.id}`;
      showToast({ message: lang => uiText(lang, 'proj.exporting'), key, durationMs: 0 });
      try {
        const result = await api.exportHistoryGroup?.(projectGroupId(project.id));
        showToast({ message: hostMessageText(result, lang), tone: (result as { ok?: boolean } | undefined)?.ok === false ? 'danger' : 'ok', key });
      } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger', key }); }
    }) },
    { kind: 'separator', id: 'sep' },
    { id: 'delete', icon: 'trash', danger: true, label: t('proj.delete'), onSelect: () => setDialog({ type: 'deleteProject', project, members: collections.counts[project.id] ?? 0 }) },
  ];

  // ── Using an image on the canvas ─────────────────────────────────────────
  const reuseEntries = (current: AssetDetail): MenuEntry[] => {
    const item = current.item;
    const stage = (mode: 'i2i' | 'inpaint' | 'enhance' | 'upscale' | 'director') => () => void run(async () => {
      const image = imageFromAssetDetail(current);
      if (!image) return;
      navigate('canvas');
      await stageImageInput(image, mode);
    });
    const recipe: MenuEntry = item.kind === 'history'
      ? { id: 'recipe', icon: 'canvas', label: t('d.reuse.recipe'), hint: t('d.reuse.recipeHint'), disabled: !item.payload?.params, onSelect: () => { paramsBefore.current = useAppStore.getState().params; setParamsItem(item.payload as HistoryItem); } }
      : { id: 'recipe', icon: 'canvas', label: t('d.reuse.recipe'), hint: t('d.reuse.recipeHint'), onSelect: () => void run(async () => {
        const image = detailImage(current); if (!image) return;
        const report = readReport(await (await fetch(image.url)).arrayBuffer());
        if (!reportHasSettings(report)) { showToast({ message: t('imp.read.none') }); return; }
        applyReportToCanvas(report); navigate('canvas'); showToast({ message: t('d.applied'), tone: 'ok' });
      }) };
    return [recipe,
      { id: 'i2i', icon: 'image', label: t('d.reuse.i2i'), onSelect: stage('i2i') },
      { id: 'inpaint', icon: 'brush', label: t('d.reuse.inpaint'), onSelect: stage('inpaint') },
      { kind: 'separator', id: 'sep' },
      { id: 'enhance', icon: 'wand', label: t('d.reuse.enhance'), onSelect: stage('enhance') },
      { id: 'upscale', icon: 'fit', label: t('d.reuse.upscale'), onSelect: stage('upscale') },
      { id: 'director', icon: 'sparkle', label: t('d.reuse.director'), onSelect: stage('director') },
    ];
  };
  const useOnCanvas = (item: AssetItem) => void run(async () => {
    await applyLibraryItem(item, 'base', useAppStore.getState(), window.naiDesktop, { field: 'positive' });
    navigate('canvas'); showToast({ message: t('pre.usedOnCanvas'), tone: 'ok' });
  });
  // 版本历史 › 用这一版: what the drawer's main action does, with that version's saved content.
  const projectNames = useMemo(() => new Map(collections.projects.map(value => [value.id, value.name])), [collections.projects]);
  const useVersion = async (item: AssetItem) => {
    const use = versionUse(item.kind);
    if (use === 'tray') {
      setVersionsOf(null);
      if (!isTrayView(view)) setView({ type: 'category', category: item.kind === 'tag' ? 'tags' : 'combos' });
      setTray(current => [...current, ...trayMembersOf(item)]);
      showToast({ message: t('ver.used', { n: item.revision }), tone: 'ok' });
      return;
    }
    if (use !== 'canvas') return;
    try {
      await applyLibraryItem(item, 'base', useAppStore.getState(), window.naiDesktop, { field: 'positive' });
      setVersionsOf(null); navigate('canvas'); showToast({ message: t('ver.used', { n: item.revision }), tone: 'ok' });
    } catch (failure) { fail(failure); }
  };

  // ── Selection actions ────────────────────────────────────────────────────
  const selection = [...selected.values()];
  const visibleKeys = useMemo(() => new Set(order), [order]);
  const outside = selection.filter(item => !visibleKeys.has(itemKey(item))).length;
  const allVisibleSelected = visible.length > 0 && visible.every(item => selected.has(itemKey(item)));
  const selectionImages = selection.filter(item => isImageKind(item.kind));
  const exportImages = (items: AssetItem[]) => void run(async () => {
    if (!api.exportAssetImages) return;
    if (items.length > 100) { showToast({ message: t('sel.exportTooMany'), tone: 'warn' }); return; }
    const result = await api.exportAssetImages({ items: items.map(item => ({ kind: item.kind, id: item.id, revision: item.revision })), stripMetadata: false });
    if (result.status === 'cancelled') showToast({ message: t('sel.exportCancelled') });
    else if (result.status === 'saved') showToast({ message: result.failed + result.skipped ? t('sel.exportPartial', { n: result.success, m: result.failed + result.skipped }) : t('sel.exported', { n: result.success }), tone: 'ok' });
    else showToast({ message: t('c.failed'), tone: 'danger' });
  });
  const projectEntries: MenuEntry[] = [
    ...collections.projects.map(project => ({ id: project.id, icon: 'group' as const, label: project.name, onSelect: () => void run(async () => { await moveToProject(api, selectionImages.filter(item => item.kind === 'history'), project.id); showToast({ message: t('sel.moved', { name: project.name }), tone: 'ok' }); }) })),
    { kind: 'separator', id: 'sep' },
    { id: 'none', icon: 'x', label: t('sel.noProject'), onSelect: () => void run(async () => { await removeFromProjects(api, selectionImages); showToast({ message: t('sel.removedFromProject'), tone: 'ok' }); }) },
  ];
  const allArchived = selection.length > 0 && selection.every(item => item.archived);
  // Undo restores every entry the deletion created (500 per request); the toast says what it could not name.
  const deletedToast = ({ summary, trashIds, unnamed }: DeletedResult, onUndone?: (restored: number) => void) => {
    const undo = () => void run(async () => {
      const result = await restoreListed(api, trashIds);
      onUndone?.(result.restored);
      showToast({ message: unnamed > 0 ? t('del.undonePartial', { n: result.restored, m: unnamed }) : result.gone > 0 ? t('del.undoneGone', { n: result.restored, m: result.gone }) : t('del.undone'), tone: unnamed || result.gone ? 'warn' : 'ok' });
    });
    // Long-lived (8 s, with Undo): its text follows a language switch (step 4c1).
    showToast({ message: lang => summary.count === 1 ? uiText(lang, 'del.done') : uiText(lang, 'del.doneMany', { n: summary.count }), tone: 'ok', durationMs: 8000, ...(trashIds.length ? { action: { label: lang => uiText(lang, 'c.undo'), onClick: undo } } : {}) });
  };
  const onDeleted = (result: DeletedResult) => {
    setDialog(null); setSelected(new Map()); setSelecting(false);
    if (open && dialog?.type === 'delete' && dialog.target.kind === 'items' && dialog.target.items.some(item => item.kind === open.kind && item.id === open.id)) setOpen(null);
    deletedToast(result);
  };

  // ── View heading, actions and content ────────────────────────────────────
  const collection = view.type === 'collection' ? collections.user.find(value => value.id === view.id) : undefined;
  const project = view.type === 'project' ? collections.projects.find(value => value.id === view.id) : undefined;
  const title = view.type === 'collection' ? t('lib.title.collection', { name: collection?.name ?? '' }) : view.type === 'project' ? t('lib.title.project', { name: project?.name ?? '' }) : view.type === 'category' ? t(VIEW_TITLES[view.category]) : t('tr.title');
  const freshCount = filtering ? t('lib.count.filtered', { n: list.total })
    : isImageView(view) && view.type !== 'collection' ? t('lib.count.images', { n: list.total }) : t('lib.count.items', { n: list.total });
  // While another list of the same section loads (new filter or search) the header keeps the last count instead of a
  // passing "0"; another section shows 正在读取… until its count is known.
  const lastCount = useRef<{ view: string; text: string } | null>(null);
  if (!list.loading) lastCount.current = { view: viewKey(view), text: freshCount };
  const countText = list.loading ? (lastCount.current?.view === viewKey(view) ? lastCount.current.text : t('c.loading')) : freshCount;
  // 历史成图 header (prototype 01; 4b1 left it out): how many of the images came from agents (the host's source filter).
  const plainHistory = view.type === 'category' && view.category === 'history' && !query.trim() && !filtering && !searchAll;
  const agentImages = useLocalAssetQuery<{ total: number }>(assetQueryKey(api, 'ui-agent-count', archivedFilter),
    () => api.assetLibrary({ action: 'ui-list', kinds: ['history'], archived: archivedFilter, source: 'agent', limit: 1 }), active && plainHistory).data?.total ?? 0;
  const selectedMaterials = selection.filter(item => item.kind === 'tag' || item.kind === 'combo' || item.kind === 'note');
  const moreEntries: MenuEntry[] = [
    ...(project ? [...projectMenu(project), { kind: 'separator' as const, id: 'sep-p' }] : []),
    ...(collection ? [...collectionMenu(collection), { kind: 'separator' as const, id: 'sep-c' }] : []),
    ...(view.type === 'category' && view.category === 'presets' ? [
      { id: 'manage', icon: 'image' as const, label: t('pre.manageReferences'), onSelect: () => setReferenceManager(true) },
      { id: 'export-nairp', icon: 'download' as const, label: t('pre.exportNairp'), onSelect: () => void run(async () => { const result = await window.naiDesktop.exportReferencePresets(); showToast({ message: result.ok ? t('pre.exported') : hostMessageText(result, lang), tone: result.ok ? 'ok' : 'danger' }); }) },
      { kind: 'separator' as const, id: 'sep-r' }] : []),
    // 素材 JSON (step 4c1): tags, combos and notes with their local covers, the same file Settings › Storage reads.
    ...(view.type === 'category' && (view.category === 'tags' || view.category === 'combos' || view.category === 'notes') ? [
      { id: 'mj-export', icon: 'download' as const, label: selectedMaterials.length ? t('mj.exportSel', { n: selectedMaterials.length }) : t('mj.export'), onSelect: () => void exportMaterials() },
      { id: 'mj-import', icon: 'upload' as const, label: t('mj.import'), onSelect: () => backupInput.current?.click() },
      { kind: 'separator' as const, id: 'sep-mj' }] : []),
    { id: 'archived', icon: 'archive', label: t('lib.m.clearArchived'), onSelect: () => setDialog({ type: 'delete', target: { kind: 'archived' } }) },
    { id: 'refresh', icon: 'refresh', label: t('lib.m.refresh'), onSelect: () => void invalidateAssetQueries() },
  ];
  const exportMaterials = () => run(async () => {
    const { data, coversLeftOut } = await exportLibraryBackup(api, selectedMaterials.length ? selectedMaterials.map(item => item.id) : undefined);
    saveJsonFile(data, 'novelai-material-library.json');
    showToast({ message: [t('mj.exported', { n: data.entries.length }), coversLeftOut ? t('set.st.libCoversOut', { n: coversLeftOut }) : ''].filter(Boolean).join(' · '), tone: 'ok' });
  });
  const chooseBackup = async (chosen: File) => {
    if (chosen.size > LIBRARY_BACKUP_MAX_BYTES) { showToast({ message: t('set.st.libTooBig'), tone: 'danger' }); return; }
    const parsed = parseLibraryBackup(await chosen.text());
    if (!parsed.ok) showToast({ message: backupParseText(parsed, t), tone: 'danger' }); else setBackup(parsed.data);
  };
  const importNairp = () => void run(async () => {
    const result = await window.naiDesktop.prepareReferenceImport();
    if (result.ok && result.importId) setReferenceImport(result);
    else if (!result.canceled) showToast({ message: hostMessageText(result, lang), tone: 'danger' });
  });
  const categoryActions: ReactNode = view.type !== 'category' ? null
    : view.category === 'imports' ? <Button variant="primary" icon="upload" onClick={() => fileInput.current?.click()}>{t('imp.choose')}</Button>
    : view.category === 'tags' ? <Button variant="primary" icon="plus" onClick={() => setDialog({ type: 'create', kind: 'tag' })}>{t('tag.add')}</Button>
    : view.category === 'combos' ? <Button variant="primary" icon="plus" onClick={() => setDialog({ type: 'create', kind: 'combo' })}>{t('combo.new')}</Button>
    : view.category === 'notes' ? <Button variant="primary" icon="plus" onClick={() => setDialog({ type: 'create', kind: 'note' })}>{t('note.new')}</Button>
    : view.category === 'presets' ? <>
      <Button icon="upload" onClick={importNairp}>{t('pre.importNairp')}</Button>
      <MenuButton label={t('pre.new')} placement="bottom-end" entries={[
        { id: 'style', icon: 'preset', label: t('edit.newStyle'), onSelect: () => setDialog({ type: 'create', kind: 'style_preset' }) },
        { id: 'positive', icon: 'preset', label: t('edit.newPositive'), onSelect: () => setDialog({ type: 'create', kind: 'positive_preset' }) },
        { id: 'chunk', icon: 'preset', label: t('edit.newChunk'), onSelect: () => setDialog({ type: 'create', kind: 'prompt_chunk' }) },
        { id: 'reference', icon: 'image', label: t('pre.manageReferences'), onSelect: () => setReferenceManager(true) },
      ]}>{trigger => <Button {...trigger} variant="primary" icon="plus">{t('pre.new')}</Button>}</MenuButton>
    </> : null;
  const onFiles = (files: File[]) => {
    const { accepted, refused } = acceptImportFiles(files, t);
    for (const message of refused) showToast({ message, tone: 'warn' });
    if (accepted.length) setImportFiles(accepted);
  };

  const emptyState = () => {
    if (query || filtering) return <EmptyState icon="search" title={t('empty.search.t')} body={t('empty.search.d')} action={filtering ? <Button size="sm" onClick={() => { setFilters(NO_FILTERS); setArchivedFilter('exclude'); setHistoryTags([]); }}>{t('lib.f.clear')}</Button> : undefined} />;
    if (view.type === 'collection') return <EmptyState icon="collection" title={t('empty.collection.t')} body={t('empty.collection.d')} />;
    if (view.type === 'project') return <EmptyState icon="group" title={t('empty.project.t')} body={t('empty.project.d', { name: project?.name ?? '' })} />;
    if (view.type === 'category') { const key = EMPTY_KEYS[view.category]; return <EmptyState icon={view.category === 'history' ? 'history' : view.category === 'imports' ? 'imported' : view.category === 'tags' ? 'tag' : view.category === 'combos' ? 'combo' : view.category === 'notes' ? 'note' : view.category === 'presets' ? 'preset' : 'palette'} title={t(`empty.${key}.t`)} body={t(`empty.${key}.d`)} />; }
    return null;
  };

  const imageView = isImageView(view);
  const imports = view.type === 'category' && view.category === 'imports';
  const images = useMemo(() => imports ? [] : visible.filter(item => isImageKind(item.kind)), [visible, imports]);
  const others = useMemo(() => imports ? visible : visible.filter(item => !isImageKind(item.kind)), [visible, imports]);
  const activeKey = open ? `${open.kind}:${open.id}` : null;
  // The grid's sections: images by day (day counts from the host's summary), then the cards of the other kinds.
  const headings = view.type !== 'collection' || !others.length;
  const days = list.summary?.days;
  const sections = useMemo<LayoutSection[]>(() => {
    const out: LayoutSection[] = [];
    if (images.length) {
      const groups: DayGroup[] = view.type === 'collection' && others.length ? [{ key: 'all', day: 'all', label: '', items: images }] : dayGroups(images, lang);
      // The host counts the whole day; a day split over two groups (mixed time zones) counts what each group holds.
      out.push({ type: 'days', headings, groups: groups.map(group => ({ key: group.key, label: group.label, count: group.split ? group.items.length : days?.get(group.day) ?? group.items.length, items: group.items.map(item => ({ key: itemKey(item), aspect: imageAspect(item) })) })) });
    }
    if (others.length || imports) {
      if (images.length) out.push({ type: 'heading', key: 'other', label: t('lib.otherKinds') });
      out.push({ type: 'cards', items: others.map(item => ({ key: itemKey(item), estimate: cardEstimate(item) })), ...(imports ? { lead: 240 } : {}) });
    }
    return out;
  }, [images, others, imports, headings, days, lang, today, view.type]);
  const gridItems = useMemo(() => [...images, ...others], [images, others]);
  const selectedKeys = useMemo(() => new Set(selected.keys()), [selected]);
  const dropZone = imports ? <div className="lib-card lib-drop" onDragOver={event => { event.preventDefault(); event.currentTarget.classList.add('is-over'); }} onDragLeave={event => event.currentTarget.classList.remove('is-over')}
    onDrop={event => { event.preventDefault(); event.currentTarget.classList.remove('is-over'); onFiles([...event.dataTransfer.files]); }}>
    <IconButton icon="upload" label={t('imp.choose')} onClick={() => fileInput.current?.click()} />
    <b>{t('imp.drop')}</b><span className="ui-faint">{t('imp.formats')}</span>
    <Button size="sm" onClick={() => fileInput.current?.click()}>{t('imp.choose')}</Button>
  </div> : null;

  let content: ReactNode;
  if (searchAll) content = <SearchAll api={api} query={query} archived={archivedFilter}
    onOpen={(item, category) => { setView({ type: 'category', category }); setOpen({ kind: item.kind, id: item.id }); setEditing(false); opener.current = null; }}
    onShowAll={category => setView({ type: 'category', category })} />;
  else if (list.loading && !list.items.length) content = <p className="lib-wait" role="status"><Spinner size={16} /> {t('c.loading')}</p>;
  else if (list.error && !list.items.length) content = <p className="lib-error" role="alert">{t('lib.loadFailed')} · {libraryErrorText(list.error, t, lang)} <Button size="sm" variant="ghost" onClick={list.refetch}>{t('c.retry')}</Button></p>;
  else if (!visible.length && !imports) content = emptyState();
  else content = <>
    <VirtualGrid handle={grid} api={api} scrollRef={scrollRef} sections={sections} items={gridItems} rowHeight={ROW_HEIGHTS[size]} listKey={listKey}
      selected={selectedKeys} selecting={selecting} activeKey={activeKey} memberships={memberships} batches={batches}
      onOpen={onOpen} onSelect={onSelect} collectEntries={tileCollectEntries} onAddToTray={isTrayView(view) ? addToTray : undefined} lead={dropZone}
      hasMore={list.hasMore} onNearEnd={onNearEnd} />
    {!visible.length && imports && !list.loading && <EmptyState icon="imported" title={t('empty.imports.t')} body={t('empty.imports.d')} />}
  </>;

  const shownItem = detail?.item ?? listItem;
  const drawerTitle = shownItem ? (shownItem.kind === 'study' ? fileName(shownItem) : itemTitle(shownItem)) : '';
  const drawerMenu: MenuEntry[] = shownItem ? [
    ...((shownItem.kind === 'history' || shownItem.kind === 'study') ? [{ id: 'rename', icon: 'edit' as const, label: t('d.m.rename'), onSelect: () => setDialog({ type: 'renameItem', item: shownItem }) }] : []),
    ...(detail && detailImage(detail)?.filePath && api.openInExplorer ? [{ id: 'reveal', icon: 'folder' as const, label: t('d.m.reveal'), onSelect: () => void api.openInExplorer!(detailImage(detail)!.filePath!) }] : []),
    { id: 'versions', icon: 'history', label: t('d.m.versions'), disabled: !detail, onSelect: () => setVersionsOf(itemKey(shownItem)) },
    { id: 'archive', icon: 'archive', label: shownItem.archived ? t('d.m.unarchive') : t('d.m.archive'), onSelect: () => void run(async () => { await setArchived(api, [shownItem], !shownItem.archived); showToast({ message: shownItem.archived ? t('d.unarchived') : t('d.archived'), tone: 'ok' }); }) },
    { kind: 'separator', id: 'sep' },
    { id: 'delete', icon: 'trash', danger: true, label: t('d.delete'), onSelect: () => setDialog({ type: 'delete', target: { kind: 'items', items: [shownItem] } }) },
  ] : [];
  const userMemberOf = (collectionId: string) => !!detail?.memberships?.some(value => value.namespace === 'user' && `user:${value.collectionId}` === collectionId);
  const drawer = open && <Drawer className="lib-drawer" title={<>{drawerTitle}{shownItem && hasUnsavedDraft(shownItem) && <Tag tone="warn">{t('edit.unsaved')}</Tag>}</>} label={t('d.label')} closeLabel={t('c.close')} onClose={closeDrawer}
    actions={shownItem && <MenuButton label={t('d.m.menu')} entries={drawerMenu} placement="bottom-end">{trigger => <IconButton {...trigger} icon="more" label={t('d.m.menu')} />}</MenuButton>}>
    {!detail ? (detailQuery.error ? <p className="lib-sect lib-error" role="alert">{t('d.gone')}</p> : <p className="lib-sect lib-wait" role="status"><Spinner size={16} /> {t('c.loading')}</p>)
      : isImageKind(detail.item.kind) ? <ImageDetail api={api} detail={detail} batches={batches} projects={collections.projects} collections={collections.user} tab={tab} onTab={setTab}
        onPrev={neighbour(order, activeKey!, -1) ? () => openKey(neighbour(order, activeKey!, -1)!) : undefined} onNext={neighbour(order, activeKey!, 1) ? () => openKey(neighbour(order, activeKey!, 1)!) : undefined}
        reuseEntries={reuseEntries(detail)} collectEntries={collectEntries([detail.item], userMemberOf)} collected={!!detail.memberships?.some(value => value.namespace === 'user')}
        onExport={() => exportImages([detail.item])} onDelete={() => setDialog({ type: 'delete', target: { kind: 'items', items: [detail.item] } })} onOpenQueue={() => navigate('queue')} />
      : <MaterialDetail api={api} detail={detail} onAddToTray={isTrayView(view) || detail.item.kind === 'tag' || detail.item.kind === 'combo' ? item => { if (!isTrayView(view)) setView({ type: 'category', category: item.kind === 'tag' ? 'tags' : 'combos' }); addToTray(item); } : undefined}
        onUseOnCanvas={useOnCanvas} onDelete={() => setDialog({ type: 'delete', target: { kind: 'items', items: [detail.item] } })} editing={editing} onEditing={setEditing} />}
  </Drawer>;

  return <div ref={pageRef} className="ui-scope lib" data-size={size} data-testid="library-page">
    <Sidebar view={view} onView={setView} counts={counts} collections={collections.user} projects={collections.projects} memberCounts={collections.counts}
      onNewCollection={() => setDialog({ type: 'newCollection' })} collectionMenu={collectionMenu} projectMenu={projectMenu} />
    {view.type === 'trash' ? <div className="lib-main"><TrashView api={api} active={active} initialSelected={scenario?.trashSelected} initialPurge={scenario?.dialog === 'purge'} initialEmpty={scenario?.trashEmpty} /></div>
      : referenceManager ? <div className="lib-main lib-legacy"><div className="lib-legacy-head"><Button size="sm" variant="ghost" icon="left" onClick={() => setReferenceManager(false)}>{t('c.back')}</Button><h1>{t('pre.manageReferences')}</h1></div><div className="lib-legacy-body"><ReferencePresetManager /></div></div>
      : <div className="lib-main" onDragOver={imports ? event => event.preventDefault() : undefined} onDrop={imports ? event => { event.preventDefault(); onFiles([...event.dataTransfer.files]); } : undefined}>
        <Toolbar api={api} search={search} onSearch={setSearch} searchRef={searchRef} archived={archivedFilter} onArchived={setArchivedFilter}
          scopeAll={searchAll} onScopeAll={setScopeAll} onAddTag={hasImageFilters(view) ? tag => setHistoryTags(current => current.some(value => value.toLowerCase() === tag.toLowerCase()) ? current : [...current, tag].slice(0, 30)) : undefined}
          filters={hasImageFilters(view) ? filters : undefined} onFilters={setFilters} choices={choices} importedSource={view.type === 'collection'} compact={!!open}
          size={imageView && !imports ? size : undefined} onSize={setSize} selecting={selecting} onToggleSelecting={() => { setSelecting(value => !value); setSelected(new Map()); }}
          actions={categoryActions} moreEntries={moreEntries} />
        {tagFilters && !searchAll && <div className="lib-tagchips" role="group" aria-label={t('lib.tags.label')} data-testid="library-tag-filters">
          {tagFilters.map(tag => <Chip key={tag} active icon="tag" aria-label={t('lib.tags.remove', { tag })} onClick={() => setHistoryTags(current => current.filter(value => value !== tag))} data-testid={`library-tag-${tag}`}><span className="ui-mono">{tag}</span> ×</Chip>)}
          {tagFilters.length > 1 && <Seg<'all' | 'any'> size="sm" label={t('lib.tags.label')} value={tagMatch} onChange={setTagMatch} options={[{ value: 'all', label: t('lib.tags.all') }, { value: 'any', label: t('lib.tags.any') }]} />}
          <Button size="sm" variant="ghost" onClick={() => setHistoryTags([])}>{t('lib.tags.clear')}</Button>
        </div>}
        <div className="lib-scroll" ref={scrollRef}>
          {!searchAll && <div className="lib-head"><h1>{title}</h1><span className={clsx('ui-muted ui-num', list.loading && 'is-pending')} aria-busy={list.loading || undefined} data-testid="library-count">{countText}</span>
            {plainHistory && agentImages > 0 && !list.loading && <span className="ui-muted ui-num lib-head-agent" data-testid="library-agent-count"><Dot tone="agent" />{t('lib.count.agent', { n: agentImages })}</span>}</div>}
          {view.type === 'category' && view.category === 'presets' && <div className="lib-subchips" role="group" aria-label={t('pre.filter')}>{PRESET_FILTERS.map(value => <button key={value} type="button" className={clsx('ui-chip', presetFilter === value && 'ui-chip--on')} aria-pressed={presetFilter === value} onClick={() => setPresetFilter(value)}>{t(value === 'all' ? 'pre.all' : `pre.kind.${value}`)}</button>)}</div>}
          {content}
          {list.loadingMore && <p className="lib-wait" role="status"><Spinner size={14} /> {t('lib.loadingMore')}</p>}
        </div>
        {selecting && <SelectionBar count={selection.length} outside={outside} allSelected={allVisibleSelected} loaded={list.hasMore ? visible.length : undefined} onAll={() => setSelected(current => allVisibleSelected ? new Map() : new Map([...current, ...visible.map(item => [itemKey(item), item] as const)]))}
          collectEntries={collectEntries(selection)} projectEntries={selectionImages.some(item => item.kind === 'history') ? projectEntries : undefined} onExport={selectionImages.length ? () => exportImages(selectionImages) : undefined}
          archived={allArchived} onArchive={() => void run(async () => { await setArchived(api, selection, !allArchived); showToast({ message: allArchived ? t('sel.unarchived', { n: selection.length }) : t('sel.archived', { n: selection.length }), tone: 'ok' }); setSelected(new Map()); })}
          onDelete={() => setDialog({ type: 'delete', target: { kind: 'items', items: selection, outside } })} onDone={() => { setSelecting(false); setSelected(new Map()); }} />}
        {!selecting && isTrayView(view) && tray.length > 0 && <ComboTray api={api} members={tray} onChange={setTray} onApplied={() => navigate('canvas')} />}
      </div>}
    {view.type !== 'trash' && !referenceManager && drawer}
    <input ref={fileInput} type="file" hidden multiple accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" aria-label={t('imp.choose')} onChange={event => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) onFiles(files); }} />
    {dialog && <PageDialogs api={api} dialog={dialog} t={t} onClose={() => setDialog(null)} onDeleted={onDeleted} onPartial={deletedToast} onView={setView} currentView={view}
      onOpenItem={item => { setDialog(null); setOpen(item); }} />}
    {importFiles && <ImportReader api={api} files={importFiles} onClose={() => setImportFiles(null)} onReused={() => { setImportFiles(null); navigate('canvas'); }} />}
    {paramsItem && <HistoryParametersDialog item={paramsItem} onClose={() => { setParamsItem(null); if (useAppStore.getState().params !== paramsBefore.current) { navigate('canvas'); showToast({ message: t('d.applied'), tone: 'ok' }); } }} />}
    {detail && versionsOf === itemKey(detail.item) && <VersionHistory api={api} current={detail.item} projects={projectNames} onClose={() => setVersionsOf(null)} onUse={useVersion} />}
    <input ref={backupInput} type="file" hidden accept="application/json,.json" aria-label={t('mj.import')} data-testid="library-backup-file"
      onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) void chooseBackup(chosen); }} />
    {backup && <LibraryBackupImport api={api} data={backup} onClose={() => setBackup(null)}
      onDone={result => { setBackup(null); showToast({ message: backupImportText(result, t, lang === 'zh' ? 'zh-CN' : 'en-US'), tone: result.error ? 'warn' : 'ok', durationMs: 8000 }); }} />}
    {referenceImport && <ReferenceImportReview preview={referenceImport} onClose={() => setReferenceImport(null)} onCommitted={async () => { await invalidateAssetQueries(); }} />}
  </div>;
}

function PageDialogs({ api, dialog, t, onClose, onDeleted, onPartial, onView, currentView, onOpenItem }: { api: LibraryApi; dialog: PageDialog; t: UiText; onClose(): void; onDeleted(result: DeletedResult): void; onPartial(result: DeletedResult, onUndone: (restored: number) => void): void; onView(view: LibraryView): void; currentView: LibraryView; onOpenItem(item: { kind: AssetItem['kind']; id: string }): void }) {
  const { lang } = useUiText();
  const [busy, setBusy] = useState(false);
  const store = useAppStore.getState;
  switch (dialog.type) {
    case 'delete': return <DeleteDialog api={api} target={dialog.target} onClose={onClose} onDeleted={onDeleted} onPartial={onPartial} />;
    case 'create': return <CreateDialog api={api} kind={dialog.kind} onClose={onClose} onCreated={onOpenItem} />;
    case 'newCollection': return <NameDialog title={t('coll.createTitle')} label={t('coll.namePlaceholder')} confirmLabel={t('c.create')} onClose={onClose} onSubmit={async name => {
      const result = await createCollection(api, name);
      if (dialog.items?.length) await addToCollection(api, dialog.items, result.collection.id);
      showToast({ message: dialog.items?.length ? t('sel.collected', { name }) : t('coll.created', { name }), tone: 'ok' }); onClose();
    }} />;
    case 'renameCollection': return <NameDialog title={t('coll.renameTitle')} label={t('coll.namePlaceholder')} initial={dialog.collection.name} confirmLabel={t('c.save')} onClose={onClose} onSubmit={async name => { await renameCollection(api, dialog.collection.id, name); onClose(); }} />;
    case 'renameProject': return <NameDialog title={t('proj.renameTitle')} label={t('c.name')} hint={t('proj.renameHint')} initial={dialog.project.name} confirmLabel={t('c.save')} onClose={onClose} onSubmit={async name => {
      const groups = await api.renameHistoryGroup!(projectGroupId(dialog.project.id), name);
      useAppStore.setState({ historyGroups: groups }); await invalidateAssetQueries();
      showToast({ message: t('proj.renamed', { name }), tone: 'ok' }); onClose();
    }} />;
    case 'renameItem': return <NameDialog title={t('d.renameTitle')} label={t('c.name')} hint={dialog.item.kind === 'history' ? t('d.renameHint') : undefined} initial={dialog.item.kind === 'study' ? fileName(dialog.item) : itemTitle(dialog.item)} confirmLabel={t('c.save')} onClose={onClose} onSubmit={async name => {
      if (dialog.item.kind === 'history') { const result = await api.renameHistoryItem!(dialog.item.id, name); if (!result.ok) throw Object.assign(new Error(result.message || t('c.failed')), result); }
      else await api.assetLibrary({ action: 'mutate', command: 'update', items: [{ kind: dialog.item.kind, id: dialog.item.id, expectedRevision: dialog.item.revision }], patch: { name } });
      await invalidateAssetQueries(); showToast({ message: t('d.renamed'), tone: 'ok' }); onClose();
    }} />;
    case 'deleteProject': return <ConfirmProjectDelete api={api} t={t} dialog={dialog} busy={busy} onClose={onClose} onConfirm={async () => {
      setBusy(true);
      try {
        const id = projectGroupId(dialog.project.id), groups = await api.deleteHistoryGroup!(id);
        const state = store(); const generationGroupId = state.generationGroupId === id ? '' : state.generationGroupId;
        useAppStore.setState({ historyGroups: groups, selectedGroupId: state.selectedGroupId === id ? '' : state.selectedGroupId, generationGroupId, settings: state.settings ? { ...state.settings, generationGroupId } : state.settings });
        await invalidateAssetQueries();
        if (currentView.type === 'project' && currentView.id === dialog.project.id) onView({ type: 'category', category: 'history' });
        showToast({ message: t('proj.deleted'), tone: 'ok' }); onClose();
      } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); setBusy(false); }
    }} />;
    case 'deleteCollection': return <ConfirmCollectionDelete api={api} t={t} dialog={dialog} onClose={onClose} onDone={trashId => {
      if (currentView.type === 'collection' && currentView.id === dialog.collection.id) onView({ type: 'category', category: 'history' });
      showToast({ message: lang => uiText(lang, 'coll.deleted'), tone: 'ok', durationMs: 8000, ...(trashId ? { action: { label: lang => uiText(lang, 'c.undo'), onClick: () => { void restoreListed(api, [trashId]).then(() => showToast({ message: t('del.undone'), tone: 'ok' })).catch(failure => showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' })); } } } : {}) });
      onClose();
    }} />;
  }
}

/**
 * Deleting a project only dissolves it (its images stay and leave the project); the project itself does not go to
 * Recently deleted. The image count is read from the host when the dialog opens.
 */
function ConfirmProjectDelete({ api, t, dialog, busy, onClose, onConfirm }: { api: LibraryApi; t: UiText; dialog: { project: AssetCollection; members: number }; busy: boolean; onClose(): void; onConfirm(): void }) {
  const [members, setMembers] = useState<number | null | 'unknown'>(null);
  useEffect(() => {
    let live = true;
    api.assetLibrary({ action: 'list', collectionId: dialog.project.id, kinds: ['history'], includeArchived: true, limit: 1 })
      .then((list: { total?: number }) => { if (live) setMembers(Number.isSafeInteger(list?.total) ? Number(list.total) : 'unknown'); }, () => { if (live) setMembers('unknown'); });
    return () => { live = false; };
  }, []);
  return <ConfirmDialogLite open tone="danger" icon="group" busy={busy || members === null} title={t('proj.deleteTitle', { name: dialog.project.name })}
    description={members === null ? t('proj.counting') : members === 'unknown' ? t('proj.deleteBodyNoCount') : t('proj.deleteBody', { n: members })} confirmLabel={t('proj.deleteConfirm')} cancelLabel={t('c.cancel')} onCancel={onClose} onConfirm={onConfirm} />;
}

/** The collection's member count comes from the host's preview (it moves to Recently deleted; its items stay); no preview, no delete. */
function ConfirmCollectionDelete({ api, t, dialog, onClose, onDone }: { api: LibraryApi; t: UiText; dialog: { collection: AssetCollection; members: number }; onClose(): void; onDone(trashId?: string): void }) {
  const { lang } = useUiText();
  const [members, setMembers] = useState<number | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let live = true;
    setMembers(null); setFailed('');
    previewDeleteCollection(api, dialog.collection.id).then(result => {
      if (!live) return;
      const value = result.collections?.[0]?.members;
      if (Number.isSafeInteger(value)) setMembers(Number(value)); else setFailed(t('coll.previewFailed'));
    }, failure => { if (live) setFailed(`${t('coll.previewFailed')} ${libraryErrorText(failure, t, lang)}`); });
    return () => { live = false; };
  }, [attempt]);
  const confirm = async () => {
    if (members === null || busy) return;
    setBusy(true);
    try { const result = await commitDeleteCollection(api, dialog.collection.id); onDone(result.collections?.[0]?.trashId); }
    catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); setBusy(false); }
  };
  return <Dialog open onClose={onClose} busy={busy} tone="danger" icon="collection" title={t('coll.deleteTitle', { name: dialog.collection.name })} initialFocusRef={cancelRef}
    description={members === null ? undefined : t('coll.deleteBody', { n: members })}
    footer={<><Button ref={cancelRef} onClick={onClose} disabled={busy}>{t('c.cancel')}</Button><Button variant="danger" icon="trash" busy={busy} disabled={members === null} onClick={() => void confirm()}>{t('c.delete')}</Button></>}>
    {members === null && !failed && <p className="lib-del-wait" role="status"><Spinner size={16} />{t('del.checking')}</p>}
    {failed && <div className="lib-error" role="alert"><p>{failed}</p><Button size="sm" variant="ghost" icon="refresh" onClick={() => setAttempt(value => value + 1)}>{t('c.retry')}</Button></div>}
  </Dialog>;
}
