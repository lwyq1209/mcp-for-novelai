import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref, type RefObject } from 'react';
import clsx from 'clsx';
import type { AssetItem } from '../asset-library/types';
import type { MenuEntry } from '../ui';
import { formatNumber, useUiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { Card } from './CardGrid';
import { ImageTile } from './ImageGrid';
import { anchorAt, anchorTop, blocksIn, HEADING_HEIGHT, layoutGrid, revealTop, type GridAnchor, type GridLayout, type LayoutSection } from './grid-layout';
import { imageSource, itemKey, type BatchIndex, type MembershipIndex } from './model';

/** Row heights of the three thumbnail sizes (library.css --lib-row-h). */
export const ROW_HEIGHTS = { s: 150, m: 212, l: 300 } as const;

export interface VirtualGridHandle {
  /** Scrolls the least needed to show the item (it is rendered then); false when the grid has no such item. */
  reveal(key: string): boolean;
  /** Shows the item and moves the keyboard focus to it (its open button), once it is rendered. */
  focus(key: string): boolean;
}

export interface VirtualGridProps {
  api: LibraryApi;
  /** The scroll container the grid lives in (it may hold other content above the grid). */
  scrollRef: RefObject<HTMLDivElement | null>;
  sections: readonly LayoutSection[];
  /** The items of the sections, in their flat order (images first, then cards). */
  items: readonly AssetItem[];
  rowHeight: number;
  /** The list the grid shows (view, search and filters): a new one starts at its saved place, else at the top. */
  listKey: string;
  selected: ReadonlySet<string>;
  selecting: boolean;
  activeKey: string | null;
  memberships: MembershipIndex;
  batches: BatchIndex;
  onOpen(item: AssetItem): void;
  onSelect(item: AssetItem, mode: 'toggle' | 'range'): void;
  collectEntries(item: AssetItem): MenuEntry[];
  onAddToTray?(item: AssetItem): void;
  /** The first card cell of a cards section that has one (the drop zone of imports). */
  lead?: ReactNode;
  /** Called when the view comes near the end of what is loaded (and more can load). */
  onNearEnd?(): void;
  hasMore?: boolean;
  handle?: Ref<VirtualGridHandle>;
  /** Server rendering and tests: the width and height to lay out before the window measures them. */
  initialSize?: { width: number; height: number };
}

// Where each list was left (anchor item and offset), so returning to it (another section, filters cleared) restores it.
const places = new Map<string, GridAnchor>();
const PLACES_KEPT = 40;
const remember = (listKey: string, anchor: GridAnchor | null) => {
  places.delete(listKey);
  if (anchor) places.set(listKey, anchor);
  while (places.size > PLACES_KEPT) places.delete(places.keys().next().value!);
};

interface Viewport { top: number; height: number; width: number }

/**
 * The library grid, virtualized (oss/lib-1103): images by day in justified rows with their day headings (one sticky
 * heading follows the view), and cards in rows of equal columns; only the rows near the view are rendered, so the
 * page's DOM and memory stay the same however far it is scrolled. The layout is computed (grid-layout.ts); card rows
 * are measured once shown. Whenever the layout changes under the view (more pages, a host change, another width when
 * the drawer opens, another thumbnail size) the item at the top of the view stays where it was.
 */
export function VirtualGrid(props: VirtualGridProps) {
  const { api, scrollRef, sections, items, rowHeight, listKey, selected, selecting, activeKey, memberships, batches, onOpen, onSelect, collectEntries, onAddToTray, lead, onNearEnd, hasMore, handle, initialSize } = props;
  const { t, lang } = useUiText();
  const body = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ top: 0, height: initialSize?.height ?? 0, width: initialSize?.width ?? 0 });
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(() => new Map());
  const layout = useMemo<GridLayout | null>(() => viewport.width > 0 ? layoutGrid(sections, viewport.width, rowHeight, measured) : null, [sections, viewport.width, rowHeight, measured]);
  const keys = layout?.keys ?? [];

  // The scroll container: the page's ref, or (in the commit that mounts both, before the page's ref is attached) the
  // nearest scrolling ancestor of the grid.
  const scrollerOf = (): HTMLElement | null => {
    if (scrollRef.current) return scrollRef.current;
    for (let node = body.current?.parentElement ?? null; node; node = node.parentElement) if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
    return null;
  };
  // The grid's own top inside the scroll container, and the view's top in grid coordinates.
  const gridTop = () => {
    const scroller = scrollerOf(), node = body.current;
    if (!scroller || !node) return 0;
    return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
  };
  const readViewport = useCallback((): Viewport | null => {
    const scroller = scrollerOf(), node = body.current;
    if (!scroller || !node) return null;
    return { top: scroller.scrollTop - gridTop(), height: scroller.clientHeight, width: node.clientWidth };
  }, [scrollRef]);

  // Sizes: the grid's width (it changes with the drawer and the window) and the view's height.
  useLayoutEffect(() => {
    const scroller = scrollerOf(), node = body.current;
    if (!scroller || !node) return;
    const update = () => { const next = readViewport(); if (next && next.width > 0) setViewport(current => current.width === next.width && current.height === next.height && current.top === next.top ? current : next); };
    update();
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    observer.observe(scroller); observer.observe(node);
    return () => observer.disconnect();
  }, [scrollRef, readViewport]);

  // Scrolling: only a different set of rows (or sticky heading) renders again.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const rangeOf = (view: Viewport, current: GridLayout | null) => {
    if (!current) return '';
    const overscan = Math.max(600, view.height);
    const [from, to] = blocksIn(current, view.top - overscan, view.top + view.height + overscan);
    const sticky = stickyHeading(current, view.top);
    return `${from}:${to}:${sticky?.index ?? -1}:${sticky?.push ?? 0}`;
  };
  const shown = useRef('');
  const nearEnd = useRef(onNearEnd); nearEnd.current = onNearEnd;
  const checkEnd = (view: Viewport, current: GridLayout | null) => {
    if (current && hasMoreRef.current && view.top + view.height * 3 >= current.height) nearEnd.current?.();
  };
  const hasMoreRef = useRef(hasMore); hasMoreRef.current = hasMore;
  useEffect(() => {
    const scroller = scrollerOf();
    if (!scroller) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = readViewport(); if (!next) return;
        lastViewTop.current = next.top;
        const current = layoutRef.current;
        if (listKeyRef.current !== null && pendingPlace.current === undefined) remember(listKeyRef.current, current && next.top > 0 ? anchorAt(current, next.top, current.keys) : null);
        checkEnd(next, current);
        const range = rangeOf(next, current);
        if (range !== shown.current || next.width !== viewport.width || next.height !== viewport.height) setViewport(next);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => { scroller.removeEventListener('scroll', onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [scrollRef, readViewport, viewport.width, viewport.height]);

  // Layout changes: keep the view on the item it showed at its top; a new list starts where it was left, or at the top.
  // null until the first layout: a grid mounted again (back from Recently deleted) restores its list's place too.
  const listKeyRef = useRef<string | null>(null);
  const previous = useRef<{ layout: GridLayout; listKey: string } | null>(null);
  const pendingPlace = useRef<GridAnchor | null | undefined>(undefined);
  const pendingFocus = useRef<string | null>(null);
  const lastActive = useRef<{ key: string | null; width: number }>({ key: null, width: 0 });
  // The view's top as last seen (scroll events, own scrolls): a layout change reads its anchor there, because by then
  // the browser may already have clamped scrollTop to a shorter grid (the drawer closing makes the grid shorter).
  const lastViewTop = useRef(0);
  const scrollTo = (gridOffset: number) => { const scroller = scrollerOf(); if (scroller) { scroller.scrollTop = Math.max(0, gridOffset + gridTop()); lastViewTop.current = scroller.scrollTop - gridTop(); } };
  useLayoutEffect(() => {
    const scroller = scrollerOf();
    if (listKey !== listKeyRef.current) {
      listKeyRef.current = listKey;
      pendingPlace.current = places.get(listKey) ?? null;
      previous.current = null;
    }
    if (!layout || !scroller) return;
    if (pendingPlace.current !== undefined) {
      // A list shown again: once it has items, back to where it was (when that item is still there), else the top.
      if (!layout.keys.length) return;
      const top = pendingPlace.current ? anchorTop(layout, pendingPlace.current) : null;
      pendingPlace.current = undefined;
      if (top !== null) scrollTo(top); else { scroller.scrollTop = 0; lastViewTop.current = scroller.scrollTop - gridTop(); }
    } else if (previous.current && previous.current.layout !== layout && previous.current.listKey === listKey) {
      const viewTop = lastViewTop.current;
      // At the very top new items simply appear above; further down the item at the top of the view stays put.
      if (viewTop > 0) {
        const anchor = anchorAt(previous.current.layout, viewTop, previous.current.layout.keys);
        const top = anchor ? anchorTop(layout, anchor) : null;
        if (top !== null && Math.abs(top - viewTop) >= 1) scrollTo(top);
      }
    }
    previous.current = { layout, listKey };
    // The drawer's item stays in view when it changes (← →) and when the grid's width changes (drawer opened).
    if (activeKey && (lastActive.current.key !== activeKey || lastActive.current.width !== layout.width)) revealKey(activeKey, layout);
    lastActive.current = { key: activeKey, width: layout.width };
    const next = readViewport();
    if (next) { checkEnd(next, layout); if (rangeOf(next, layout) !== rangeOf(viewport, layout) || next.top !== viewport.top) setViewport(current => ({ ...next, width: current.width || next.width })); }
  }, [layout, listKey, activeKey]);

  function revealKey(key: string, current = layoutRef.current): boolean {
    const scroller = scrollerOf(), index = current?.blockOf.get(key);
    if (!current || !scroller || index === undefined) return false;
    const block = current.blocks[index], viewTop = scroller.scrollTop - gridTop();
    const inset = current.blocks.some(value => value.kind === 'day') ? HEADING_HEIGHT : 0;
    const top = revealTop(block, viewTop, scroller.clientHeight, inset);
    if (top !== null) scrollTo(top);
    return true;
  }
  const focusNow = (key: string) => {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&');
    const target = body.current?.querySelector<HTMLElement>(`[data-key="${escaped}"] .lib-tile-open, [data-key="${escaped}"] .lib-card-open`);
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  };
  // A focus asked for is kept for a moment: the row may render only after the reveal, or a card row be made again by a
  // new layout (the drawer closing changes the width), and the focus then goes to the new element.
  const pendingFocusUntil = useRef(0);
  useImperativeHandle(handle, () => ({
    reveal: key => revealKey(key),
    focus: key => {
      if (!revealKey(key)) return false;
      pendingFocus.current = key; pendingFocusUntil.current = Date.now() + 600;
      focusNow(key);
      return true;
    },
  }));
  useLayoutEffect(() => {
    const key = pendingFocus.current;
    if (!key) return;
    if (Date.now() > pendingFocusUntil.current) { pendingFocus.current = null; return; }
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.('[data-key]')?.getAttribute('data-key') !== key) focusNow(key);
    if (pendingFocus.current === key) revealKey(key);
  });

  // The focused item's row stays rendered while it is out of view (the keyboard focus is not lost).
  const [focusKey, setFocusKey] = useState<string | null>(null);
  useEffect(() => {
    const node = body.current;
    if (!node) return;
    const onFocus = (event: FocusEvent) => setFocusKey((event.target as HTMLElement | null)?.closest?.('[data-key]')?.getAttribute('data-key') ?? null);
    node.addEventListener('focusin', onFocus);
    return () => node.removeEventListener('focusin', onFocus);
  }, []);

  // One source object per item and batch list, so a tile that did not change is not rendered again while scrolling.
  const sourceOf = useMemo(() => {
    const known = new WeakMap<AssetItem, ReturnType<typeof imageSource>>();
    return (item: AssetItem) => { let value = known.get(item); if (!value) { value = imageSource(item, batches); known.set(item, value); } return value; };
  }, [batches]);

  // Card rows: their measured heights replace the estimates.
  const observer = useMemo(() => typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    setMeasured(current => {
      let next: Map<string, number> | null = null;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey, height = Math.ceil((entry.target as HTMLElement).offsetHeight);
        if (!key || !(height > 0) || Math.abs((current.get(key) ?? -1) - height) < 1) continue;
        next ??= new Map(current); next.set(key, height);
      }
      return next ?? current;
    });
  }) : null, []);
  useEffect(() => () => observer?.disconnect(), [observer]);
  const measure = useCallback((node: HTMLDivElement | null) => { if (node && observer) { observer.observe(node); return () => observer.unobserve(node); } }, [observer]);

  if (!layout) return <div ref={body} className="lib-vbody" style={{ height: 0 }} data-testid="library-grid" />;
  const overscan = Math.max(600, viewport.height);
  const [from, to] = blocksIn(layout, viewport.top - overscan, viewport.top + viewport.height + overscan);
  const indexes = new Set<number>();
  for (let index = from; index < to; index++) indexes.add(index);
  for (const key of [focusKey, activeKey]) { const index = key ? layout.blockOf.get(key) : undefined; if (index !== undefined) indexes.add(index); }
  const sticky = stickyHeading(layout, viewport.top);
  shown.current = rangeOf(viewport, layout);
  const tile = (item: AssetItem, index: number, x: number, y: number, w: number, h: number) => {
    const key = itemKey(item);
    return <ImageTile key={key} api={api} item={item} index={index} selected={selected.has(key)} selecting={selecting} active={activeKey === key}
      favorited={(memberships.get(key)?.length ?? 0) > 0} source={sourceOf(item)} t={t} onOpen={onOpen} onSelect={onSelect} collectEntries={collectEntries} x={x} y={y} w={w} h={h} />;
  };
  const card = (item: AssetItem, index: number) => {
    const key = itemKey(item);
    return <Card key={key} api={api} item={item} index={index} t={t} selected={selected.has(key)} selecting={selecting} active={activeKey === key} onOpen={onOpen} onSelect={onSelect} onAddToTray={onAddToTray} />;
  };
  return <div ref={body} className={clsx('lib-vbody', selecting && 'is-selecting')} style={{ height: layout.height }} data-testid="library-grid" data-total={keys.length}>
    {sticky && <div className="lib-vstick" aria-hidden="true"><div className="lib-day-h" style={sticky.push ? { transform: `translateY(${sticky.push}px)` } : undefined}>{sticky.label}{sticky.count > 0 && <span className="ui-faint"> · {formatNumber(sticky.count, lang)}</span>}</div></div>}
    {gridElements(layout, indexes, items, {
      heading: block => <h3 key={block.key} className="lib-day-h lib-vhead" style={{ top: block.top }}>{block.label}{block.kind === 'day' && <> <span className="ui-faint">· {formatNumber(block.count, lang)}</span></>}</h3>,
      tile, card,
      cardRow: (block, children) => <div key={block.key} ref={measure} data-row-key={block.measureKey}
        className="lib-vcards" style={{ top: block.top, gridTemplateColumns: `repeat(${block.columns}, minmax(0, 1fr))` }}>
        {block.lead && lead}
        {children}
      </div>,
    })}
  </div>;
}

type Block = GridLayout['blocks'][number];
export interface GridRenderers {
  heading(block: Extract<Block, { kind: 'day' | 'heading' }>): ReactElement;
  tile(item: AssetItem, index: number, x: number, y: number, width: number, height: number): ReactElement;
  card(item: AssetItem, index: number): ReactElement;
  cardRow(block: Extract<Block, { kind: 'cards' }>, children: ReactElement[]): ReactElement;
}
/**
 * The grid's children for the rendered blocks (review rework P2-2): ONE flat list of keyed elements, headings and card
 * rows by their block key and every image tile by its item key, never a nested array per row. React then keeps each
 * element (and its DOM node, focus and picture) however the set of rendered rows shifts while scrolling; a nested array
 * would be matched by its position and every tile after a changed row would be made again.
 */
export function gridElements(layout: GridLayout, indexes: Iterable<number>, items: readonly AssetItem[], render: GridRenderers): ReactElement[] {
  const out: ReactElement[] = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const block = layout.blocks[index];
    if (!block) continue;
    if (block.kind === 'day' || block.kind === 'heading') out.push(render.heading(block));
    // Tiles are placed one by one (not in row elements), so a new layout moves them without recreating them.
    else if (block.kind === 'tiles') for (let offset = 0; offset < block.end - block.start; offset++) out.push(render.tile(items[block.start + offset], block.start + offset, block.xs[offset], block.top, block.widths[offset], block.height));
    else out.push(render.cardRow(block, items.slice(block.start, block.end).map((item, offset) => render.card(item, block.start + offset))));
  }
  return out;
}

/** The day heading that sticks at the top of the view, and how far the next one pushes it up. */
function stickyHeading(layout: GridLayout, viewTop: number): { index: number; label: string; count: number; push: number } | null {
  if (viewTop <= 0) return null;
  let found = -1;
  const [first] = blocksIn(layout, viewTop, viewTop + 1);
  for (let index = Math.min(first, layout.blocks.length - 1); index >= 0; index--) {
    const block = layout.blocks[index];
    if (block.kind === 'day' || block.kind === 'heading') { if (block.top <= viewTop) { found = index; break; } }
  }
  if (found < 0) return null;
  const block = layout.blocks[found] as Extract<GridLayout['blocks'][number], { kind: 'day' | 'heading' }>;
  let push = 0;
  for (let index = found + 1; index < layout.blocks.length; index++) {
    const next = layout.blocks[index];
    if (next.top > viewTop + HEADING_HEIGHT) break;
    if (next.kind === 'day' || next.kind === 'heading') { push = Math.min(0, next.top - viewTop - HEADING_HEIGHT); break; }
  }
  return { index: found, label: block.label, count: block.kind === 'day' ? block.count : 0, push };
}
