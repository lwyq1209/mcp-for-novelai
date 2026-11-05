import { describe, expect, it } from 'vitest';
import { anchorAt, anchorTop, blocksIn, cardColumns, DAY_GAP, HEADING_HEIGHT, justifiedRows, layoutGrid, revealTop, rowFrames, TILE_GAP, type LayoutSection } from './grid-layout';

/** oss/lib-1103: the geometry of the virtual grid, without a DOM. */
const tiles = (prefix: string, aspects: number[]) => aspects.map((aspect, index) => ({ key: `${prefix}${index}`, aspect }));
const days = (groups: Array<[string, number[]]>): LayoutSection => ({ type: 'days', headings: true, groups: groups.map(([key, aspects]) => ({ key, label: key, count: aspects.length, items: tiles(`${key}-`, aspects) })) });

describe('justified rows', () => {
  it('break where the bases and gaps no longer fit, as flex-wrap does; a wide image gets its own row', () => {
    // width 1000, row height 200: bases 200·aspect, gaps 6.
    expect(justifiedRows([1, 1, 1, 1, 1], 1000, 200)).toEqual([[0, 4], [4, 5]]); // 4·200+3·6 = 818; a fifth needs 1024
    expect(justifiedRows([1.5, 1.5, 1.5], 1000, 200)).toEqual([[0, 3]]); // 900 + 12 = 912
    expect(justifiedRows([0.68, 6, 0.68], 1000, 200)).toEqual([[0, 1], [1, 2], [2, 3]]);
    expect(justifiedRows([], 1000, 200)).toEqual([]);
  });
  it('a full row is stretched to the width by aspect (as flex-grow did), the last row keeps its bases, edges are whole pixels', () => {
    const full = rowFrames([1, 2, 1], 1000, 200, true);
    expect(full.xs[0]).toBe(0);
    expect(full.xs[2] + full.widths[2]).toBe(1000);
    expect(full.widths[1] / full.widths[0]).toBeCloseTo(2, 1);
    for (let index = 1; index < 3; index++) expect(full.xs[index] - (full.xs[index - 1] + full.widths[index - 1])).toBe(TILE_GAP);
    expect(rowFrames([1, 1], 1000, 200, false)).toEqual({ xs: [0, 206], widths: [200, 200] });
    // Too wide for the row: shrinks to it even when it is the last row.
    expect(rowFrames([6], 1000, 200, false)).toEqual({ xs: [0], widths: [1000] });
  });
});

describe('layout', () => {
  it('places day headings and rows with the CSS sizes, maps every item to its row and keeps the flat order', () => {
    const layout = layoutGrid([days([['d1', [1, 1, 1, 1, 1]], ['d2', [1]]])], 1000, 200);
    expect(layout.blocks.map(block => [block.kind, block.top, block.height])).toEqual([
      ['day', DAY_GAP, HEADING_HEIGHT],
      ['tiles', DAY_GAP + HEADING_HEIGHT, 200],
      ['tiles', DAY_GAP + HEADING_HEIGHT + 200 + TILE_GAP, 200],
      ['day', DAY_GAP + HEADING_HEIGHT + 400 + TILE_GAP + DAY_GAP, HEADING_HEIGHT],
      ['tiles', DAY_GAP + HEADING_HEIGHT + 400 + TILE_GAP + DAY_GAP + HEADING_HEIGHT, 200],
    ]);
    expect(layout.blocks.filter(block => block.kind === 'tiles').map(block => block.kind === 'tiles' && [block.start, block.end, block.last])).toEqual([[0, 4, false], [4, 5, true], [5, 6, true]]);
    expect(layout.keys).toEqual(['d1-0', 'd1-1', 'd1-2', 'd1-3', 'd1-4', 'd2-0']);
    expect(layout.blockOf.get('d1-4')).toBe(2);
    expect(layout.height).toBe(layout.blocks.at(-1)!.top + 200);
  });

  it('cards: columns of at least 190 px, the lead cell first, estimates until measured', () => {
    expect(cardColumns(1000)).toBe(5); // 5·190 + 4·12 = 998, as auto-fill minmax(190px, 1fr)
    expect(cardColumns(997)).toBe(4);
    expect(cardColumns(100)).toBe(1);
    const items = Array.from({ length: 9 }, (_, index) => ({ key: `c${index}`, estimate: (width: number) => width * 0.75 + 66 }));
    const layout = layoutGrid([{ type: 'cards', items, lead: 240 }], 900, 200);
    const rows = layout.blocks.filter(block => block.kind === 'cards');
    expect(rows.map(block => block.kind === 'cards' && [block.start, block.end, block.lead, block.columns])).toEqual([[0, 3, true, 4], [3, 7, false, 4], [7, 9, false, 4]]);
    expect(rows[0].height).toBe(240);
    expect(rows[1].height).toBe(Math.ceil(((900 - 36) / 4) * 0.75 + 66));
    const measured = new Map([[(rows[1] as { measureKey: string }).measureKey, 400]]);
    expect(layoutGrid([{ type: 'cards', items, lead: 240 }], 900, 200, measured).blocks[1].height).toBe(400);
  });

  it('finds the rows in a range by binary search', () => {
    const layout = layoutGrid([days([['d', Array.from({ length: 400 }, () => 1)]])], 1000, 200);
    const [from, to] = blocksIn(layout, 5000, 5800);
    expect(layout.blocks[from].top + layout.blocks[from].height).toBeGreaterThan(5000);
    expect(layout.blocks[from - 1].top + layout.blocks[from - 1].height).toBeLessThanOrEqual(5000);
    expect(layout.blocks[to - 1].top).toBeLessThan(5800);
    expect(layout.blocks[to]?.top ?? Infinity).toBeGreaterThanOrEqual(5800);
    // However long the list, a view renders the same few rows.
    expect(to - from).toBeLessThan(6);
  });
});

describe('the rendered children keep their identity (review rework P2-2)', () => {
  it('one flat list of keyed elements: a tile is matched by its item key whichever rows are rendered', async () => {
    const { gridElements } = await import('./VirtualGrid');
    const { createElement } = await import('react');
    const groups: Array<[string, number[]]> = [['d1', Array.from({ length: 40 }, () => 1)], ['d2', Array.from({ length: 40 }, () => 0.7)]];
    const layout = layoutGrid([days(groups), { type: 'heading', key: 'other', label: 'Other' }, { type: 'cards', items: Array.from({ length: 9 }, (_, index) => ({ key: `c${index}`, estimate: () => 200 })), lead: 240 }], 1000, 200);
    const items = layout.keys.map(key => ({ kind: key.startsWith('c') ? 'tag' : 'history', id: key, key }) as never);
    const render = {
      heading: (block: { key: string }) => createElement('h3', { key: block.key }),
      tile: (item: { key: string }) => createElement('div', { key: item.key }),
      card: (item: { key: string }) => createElement('div', { key: item.key }),
      cardRow: (block: { key: string }, children: unknown[]) => createElement('div', { key: block.key }, children as never),
    };
    const range = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => from + offset);
    const a = gridElements(layout, range(0, 6), items, render as never), b = gridElements(layout, range(3, layout.blocks.length), items, render as never);
    for (const list of [a, b]) {
      expect(list.every(element => !Array.isArray(element) && element && typeof element === 'object' && typeof element.key === 'string' && element.key.length > 0)).toBe(true);
      expect(new Set(list.map(element => element.key)).size).toBe(list.length);
    }
    // Tiles of a row rendered in both ranges carry the same keys (React keeps their elements as the range moves).
    const tileKeys = (list: typeof a) => list.map(element => element.key).filter(key => /^d\d-/.test(String(key)));
    const shared = tileKeys(a).filter(key => tileKeys(b).includes(key));
    expect(shared.length).toBeGreaterThan(5);
    // Card rows are keyed elements whose cards are keyed too.
    const row = b.find(element => String(element.key).startsWith('c:'))!;
    expect(((row.props as { children: Array<{ key: string }> }).children).every(child => typeof child.key === 'string')).toBe(true);
  });
});

describe('keeping the view in place', () => {
  it('a new image above, a narrower grid (the drawer) or another row height keeps the item at the top of the view where it was', () => {
    const before = layoutGrid([days([['d', Array.from({ length: 300 }, () => 1)]])], 1000, 200);
    const viewTop = 3000;
    const anchor = anchorAt(before, viewTop, before.keys)!;
    expect(anchor.key).toBe(before.keys[(before.blocks[blocksIn(before, viewTop, viewTop + 1)[0]] as { start: number }).start]);
    // One new image at the top: the same item, one place later.
    const withNew = layoutGrid([days([['d', [1, ...Array.from({ length: 300 }, () => 1)]]])], 1000, 200);
    const shifted = { ...withNew, keys: ['new', ...before.keys], blockOf: new Map([['new', 1], ...[...before.keys].map((key, index) => [key, withNew.blockOf.get(withNew.keys[index + 1])!] as [string, number])]) };
    expect(anchorTop(shifted, anchor)).not.toBeNull();
    // A narrower grid: more rows above, the anchor moves down, and the view follows it.
    const narrow = layoutGrid([days([['d', Array.from({ length: 300 }, () => 1)]])], 600, 200);
    const top = anchorTop(narrow, anchor)!;
    expect(top).toBeGreaterThan(viewTop);
    expect(narrow.blocks[narrow.blockOf.get(anchor.key)!].top - top).toBe(anchor.offset);
    // The anchor deleted meanwhile: the first item after it that is left.
    const gone = { ...narrow, blockOf: new Map([...narrow.blockOf].filter(([key]) => key !== anchor.key)) };
    expect(anchorTop(gone, anchor)).toBe(Math.max(0, narrow.blocks[narrow.blockOf.get(anchor.after[0])!].top - anchor.offset));
    expect(anchorTop({ ...narrow, blockOf: new Map() }, anchor)).toBeNull();
  });

  it('reveals a row with the least movement, below the sticky heading', () => {
    expect(revealTop({ top: 1000, height: 200 }, 900, 800)).toBeNull();
    expect(revealTop({ top: 500, height: 200 }, 900, 800)).toBe(500 - HEADING_HEIGHT);
    expect(revealTop({ top: 2000, height: 200 }, 900, 800)).toBe(2000 + 200 - 800 + 8);
  });
});
