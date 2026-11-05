/**
 * Geometry of the library grid (oss/lib-1103): the images by day in justified rows and the cards of the other kinds,
 * as absolutely placed blocks (day headings, rows), so only the blocks near the viewport are rendered. Pure functions;
 * the sizes here are the ones library.css gives the same elements (.lib-vday, .lib-vrow, .lib-vcards).
 *
 * Image rows reproduce the earlier flex-wrap layout exactly: an image's basis is its aspect × the row height, a row
 * takes images while their bases and the gaps fit the width, and the browser then stretches the row (CSS flex-grow by
 * aspect, as before); the last row of a day is not stretched. Card rows hold as many 190 px minimum columns as fit;
 * their height is measured once shown and estimated before.
 */
export const DAY_GAP = 14;
export const HEADING_HEIGHT = 34;
export const TILE_GAP = 6;
export const CARD_GAP = 12;
export const CARD_MIN = 190;
export const CARDS_TOP = 14;

export interface LayoutTile { key: string; aspect: number }
export interface LayoutCard { key: string; estimate: (columnWidth: number) => number }
export type LayoutSection =
  | { type: 'days'; headings: boolean; groups: ReadonlyArray<{ key: string; label: string; count: number; items: readonly LayoutTile[] }> }
  | { type: 'heading'; key: string; label: string }
  | { type: 'cards'; items: readonly LayoutCard[]; /** A first cell that is not an item (the drop zone of imports), with its minimum height. */ lead?: number };

/** start/end: the item indexes in the flat order of every section's items (images first, then cards). */
export type LayoutBlock =
  | { kind: 'day'; key: string; top: number; height: number; label: string; count: number }
  | { kind: 'heading'; key: string; top: number; height: number; label: string }
  | { kind: 'tiles'; key: string; top: number; height: number; start: number; end: number; last: boolean; /** Each image's left edge and width in the row. */ xs: number[]; widths: number[] }
  | { kind: 'cards'; key: string; top: number; height: number; start: number; end: number; lead: boolean; columns: number; measured: boolean; /** Its measured height is kept under this key. */ measureKey: string };

export interface GridLayout { blocks: LayoutBlock[]; height: number; width: number; /** Item key → the index of its block. */ blockOf: Map<string, number>; keys: string[] }

/**
 * The left edges and widths of one row's images, as the earlier flex row gave them: a full row is stretched to the
 * width (each image by its aspect, CSS flex-grow), the last row of a day keeps the bases; an image wider than the row
 * shrinks to it. Edges are whole pixels so neighbouring images never overlap or leave a seam.
 */
export function rowFrames(aspects: readonly number[], width: number, rowHeight: number, stretch: boolean, gap = TILE_GAP): { xs: number[]; widths: number[] } {
  const bases = aspects.map(aspect => aspect * rowHeight), gaps = gap * Math.max(0, bases.length - 1);
  const sum = bases.reduce((total, basis) => total + basis, 0);
  const scale = sum > 0 && (stretch || sum + gaps > width) ? (width - gaps) / sum : 1;
  const xs: number[] = [], widths: number[] = [];
  let at = 0;
  for (const basis of bases) {
    const left = Math.round(at), right = Math.round(at + basis * scale);
    xs.push(left); widths.push(Math.max(1, right - left));
    at += basis * scale + gap;
  }
  return { xs, widths };
}

/** Rows of a justified layout: the item indexes of each row, as flex-wrap breaks them. */
export function justifiedRows(aspects: readonly number[], width: number, rowHeight: number, gap = TILE_GAP): Array<[number, number]> {
  const rows: Array<[number, number]> = [];
  let start = 0, used = 0;
  for (let index = 0; index < aspects.length; index++) {
    const basis = aspects[index] * rowHeight;
    if (index > start && used + gap + basis > width + 0.5) { rows.push([start, index]); start = index; used = basis; }
    else used = index > start ? used + gap + basis : basis;
  }
  if (aspects.length > start) rows.push([start, aspects.length]);
  return rows;
}

export const cardColumns = (width: number) => Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN + CARD_GAP)));
export const columnWidth = (width: number, columns: number) => Math.max(1, (width - CARD_GAP * (columns - 1)) / columns);
/** The key a measured card row is kept under: its first item, columns and column width (a resize measures again). */
export const cardRowKey = (firstKey: string, columns: number, width: number) => `${firstKey}|${columns}|${Math.round(columnWidth(width, columns))}`;

export function layoutGrid(sections: readonly LayoutSection[], width: number, rowHeight: number, measured: ReadonlyMap<string, number> = new Map()): GridLayout {
  const blocks: LayoutBlock[] = [], blockOf = new Map<string, number>(), keys: string[] = [];
  let top = 0, offset = 0;
  const add = (block: LayoutBlock) => { blocks.push(block); top = block.top + block.height; };
  for (const section of sections) {
    if (section.type === 'heading') { add({ kind: 'heading', key: `h:${section.key}`, top: top + DAY_GAP, height: HEADING_HEIGHT, label: section.label }); continue; }
    if (section.type === 'days') {
      for (const group of section.groups) {
        top += DAY_GAP;
        if (section.headings && group.label) add({ kind: 'day', key: `d:${group.key}`, top, height: HEADING_HEIGHT, label: group.label, count: group.count });
        const rows = justifiedRows(group.items.map(item => item.aspect), width, rowHeight);
        rows.forEach(([from, to], row) => {
          const at = row === 0 ? top : top + TILE_GAP;
          for (let index = from; index < to; index++) { blockOf.set(group.items[index].key, blocks.length); keys.push(group.items[index].key); }
          const last = row === rows.length - 1, frames = rowFrames(group.items.slice(from, to).map(item => item.aspect), width, rowHeight, !last);
          add({ kind: 'tiles', key: `r:${group.items[from].key}`, top: at, height: rowHeight, start: offset + from, end: offset + to, last, xs: frames.xs, widths: frames.widths });
        });
        offset += group.items.length;
      }
      continue;
    }
    // Cards: a grid of equal columns; the lead cell (if any) takes the first place of the first row.
    const columns = cardColumns(width), column = columnWidth(width, columns);
    const cells = (section.lead !== undefined ? 1 : 0) + section.items.length;
    top += CARDS_TOP;
    for (let cell = 0, row = 0; cell < cells; cell += columns, row++) {
      const lead = section.lead !== undefined && cell === 0;
      const from = Math.max(0, cell - (section.lead !== undefined ? 1 : 0)), to = Math.min(section.items.length, cell + columns - (section.lead !== undefined ? 1 : 0));
      const first = section.items[from]?.key ?? 'lead';
      const measureKey = cardRowKey(lead ? `lead:${first}` : first, columns, width), known = measured.get(measureKey);
      let estimate = lead ? section.lead! : 0;
      for (let index = from; index < to; index++) estimate = Math.max(estimate, section.items[index].estimate(column));
      for (let index = from; index < to; index++) { blockOf.set(section.items[index].key, blocks.length); keys.push(section.items[index].key); }
      add({ kind: 'cards', key: `c:${lead ? 'lead:' : ''}${first}`, top: row === 0 ? top : top + CARD_GAP, height: known ?? Math.ceil(estimate), start: offset + from, end: offset + to, lead, columns, measured: known !== undefined, measureKey });
    }
    offset += section.items.length;
  }
  return { blocks, height: top, width, blockOf, keys };
}

/** The blocks that overlap [from, to) (offsets in the grid), by binary search over the sorted tops. */
export function blocksIn(layout: Pick<GridLayout, 'blocks'>, from: number, to: number): [number, number] {
  const { blocks } = layout;
  let low = 0, high = blocks.length;
  while (low < high) { const middle = (low + high) >>> 1; if (blocks[middle].top + blocks[middle].height <= from) low = middle + 1; else high = middle; }
  let end = low;
  while (end < blocks.length && blocks[end].top < to) end++;
  return [low, end];
}

/** Where the view is: the first item row at or below the view's top, the item it starts with, and how far up it sits. */
export interface GridAnchor { key: string; offset: number; /** The next items, for when the anchor item is gone. */ after: string[] }
export function anchorAt(layout: GridLayout, viewTop: number, items: readonly string[]): GridAnchor | null {
  const [first] = blocksIn(layout, viewTop, viewTop + 1);
  for (let index = first; index < layout.blocks.length; index++) {
    const block = layout.blocks[index];
    if (block.kind !== 'tiles' && block.kind !== 'cards') continue;
    if (block.end <= block.start) continue;
    return { key: items[block.start], offset: block.top - viewTop, after: items.slice(block.start + 1, block.start + 60) };
  }
  return null;
}
/** The view top that puts the anchor (or the first remaining item after it) where it was; null when none is left. */
export function anchorTop(layout: GridLayout, anchor: GridAnchor): number | null {
  for (const key of [anchor.key, ...anchor.after]) {
    const index = layout.blockOf.get(key);
    if (index !== undefined) return Math.max(0, layout.blocks[index].top - anchor.offset);
  }
  return null;
}
/** The scroll (view top) that shows a block whole with the least movement, or null when it is already shown. */
export function revealTop(block: Pick<LayoutBlock, 'top' | 'height'>, viewTop: number, viewHeight: number, topInset = HEADING_HEIGHT): number | null {
  if (block.top - topInset < viewTop) return Math.max(0, block.top - topInset);
  if (block.top + block.height > viewTop + viewHeight) return Math.max(0, Math.min(block.top - topInset, block.top + block.height - viewHeight + 8));
  return null;
}
