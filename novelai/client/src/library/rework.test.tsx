import { afterEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import type { AssetItem } from '../asset-library/types';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import { chunks, commitDeleteAll, listArchived, mergeReceipts, PartialDeleteError, PartialRunError, previewDeleteAll, purgeListed, restoreListed, type LibraryApi } from './api';
import { createCaptureFixture } from './capture-fixture';
import { libraryListOptions } from './data';
import { libraryErrorText } from './errors';
import { receiptTrashIds, receiptUnnamed, summarizeDeleteReceipt } from './impacts';
import { refreshSelection, shortcutsBlocked, SHORTCUT_BLOCKERS } from './model';
import { SelectionBar } from './SelectionBar';
import { EMPTY_ARM_MS, EmptyAllFooter, emptyAllReady, trashCountText } from './TrashView';
import { deleteErrorText, impactLines } from './dialogs';
import { tagResolution } from './MaterialDetail';

/**
 * Step 4b1 review rework: the guards and helpers of the bulk delete paths, without a DOM (the real-host scenarios
 * are in electron/library-ui-delete-paths.test.ts).
 */
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const zh = ((key: string, params?: Record<string, unknown>) => uiText('zh', key as never, params as never)) as never;
const en = ((key: string, params?: Record<string, unknown>) => uiText('en', key as never, params as never)) as never;

describe('清空最近删除: the last step cannot be passed by a double click or repeated Enter', () => {
  const opened = 1_000_000;
  it('needs the typed number and EMPTY_ARM_MS since the step opened', () => {
    // The second click of a double click (90 ms later), with or without the number.
    expect(emptyAllReady({ typed: '', count: 8, openedAt: opened, now: opened + 90 })).toBe(false);
    expect(emptyAllReady({ typed: '8', count: 8, openedAt: opened, now: opened + 90 })).toBe(false);
    // Enter pressed again and again for a second: still no number typed.
    for (let at = 0; at <= 1000; at += 33) expect(emptyAllReady({ typed: '', count: 8, openedAt: opened, now: opened + at })).toBe(false);
    expect(emptyAllReady({ typed: '7', count: 8, openedAt: opened, now: opened + 5000 })).toBe(false);
    expect(emptyAllReady({ typed: '8', count: 8, openedAt: opened, now: opened + EMPTY_ARM_MS - 1 })).toBe(false);
    expect(emptyAllReady({ typed: ' 8 ', count: 8, openedAt: opened, now: opened + EMPTY_ARM_MS })).toBe(true);
    expect(emptyAllReady({ typed: '0', count: 0, openedAt: opened, now: opened + 5000 })).toBe(false);
  });
  it('puts 彻底删除 on the left, off until ready, and Cancel on the right where 继续 was', () => {
    setLanguage('zh-CN');
    const off = renderToStaticMarkup(<EmptyAllFooter count={8} ready={false} busy={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    const buttons = [...off.matchAll(/<button[^>]*data-testid="([^"]+)"[^>]*>/g)].map(match => [match[1], /\sdisabled=""/.test(match[0])]);
    expect(buttons).toEqual([['empty-confirm', true], ['empty-cancel', false]]);
    expect(off).toContain('彻底删除 8 项');
    const on = renderToStaticMarkup(<EmptyAllFooter count={8} ready busy={false} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(/data-testid="empty-confirm"[^>]*disabled/.test(on) || /disabled=""[^>]*data-testid="empty-confirm"/.test(on)).toBe(false);
  });
});

describe('Recently deleted header and selection notes', () => {
  it('counts the host total, with the size of what is loaded', () => {
    const entry = (bytes: number) => ({ trashId: String(bytes), kind: 'history' as const, name: 'x', deletedAt: '', expiresAt: '', files: { moved: 1 }, bytes: { moved: bytes } });
    expect(trashCountText({ total: 2, entries: [entry(1_000_000), entry(2_000_000)], hasMore: false }, zh, 'zh')).toBe('2 项 · 共 3.0 MB');
    expect(trashCountText({ total: 240, entries: [entry(1_000_000)], hasMore: true }, zh, 'zh')).toBe('240 项 · 已加载的 1 项共 1.0 MB');
    expect(trashCountText({ total: 240, entries: [entry(1_000_000)], hasMore: true }, en, 'en')).toBe('240 items · 1.0 MB in the 1 loaded');
  });
  it('once the host totals are read, counts the size of all of Recently deleted (oss/lib-1103)', () => {
    const entry = (bytes: number) => ({ trashId: String(bytes), kind: 'history' as const, name: 'x', deletedAt: '', expiresAt: '', files: { moved: 1 }, bytes: { moved: bytes } });
    const totals = (moved: number, unknownSize = 0) => ({ entries: 240, collections: 0, files: { moved: 240, kept: 0, missing: 0 }, bytes: { moved, unknownSize } });
    expect(trashCountText({ total: 240, entries: [entry(1_000_000)], hasMore: true, totals: totals(512_000_000) }, zh, 'zh')).toBe('240 项 · 共 512 MB');
    expect(trashCountText({ total: 240, entries: [entry(1_000_000)], hasMore: true, totals: totals(512_000_000, 3) }, en, 'en')).toBe('240 items · 512 MB (size unknown: 3)');
    expect(trashCountText({ total: 240, entries: [], hasMore: true, totals: totals(0, 2) }, zh, 'zh')).toBe('240 项 · 2 个文件大小未知');
    expect(trashCountText({ total: 240, entries: [], hasMore: true, totals: totals(0) }, zh, 'zh')).toBe('240 项');
  });
  it('the selection bar says how many selected items the view does not show', () => {
    setLanguage('zh-CN');
    const html = renderToStaticMarkup(<SelectionBar count={6} outside={2} allSelected={false} onAll={() => undefined} collectEntries={[]} archived={false} onArchive={() => undefined} onDelete={() => undefined} onDone={() => undefined} />);
    expect(html).toContain('已选 6 项');
    expect(html).toContain('其中 2 项不在当前视图');
    expect(renderToStaticMarkup(<SelectionBar count={6} allSelected={false} onAll={() => undefined} collectEntries={[]} archived={false} onArchive={() => undefined} onDelete={() => undefined} onDone={() => undefined} />)).not.toContain('selection-outside');
    // More can load: 全选 says it takes the loaded items only (review rework).
    const loaded = renderToStaticMarkup(<SelectionBar count={6} allSelected={false} loaded={400} onAll={() => undefined} collectEntries={[]} archived={false} onArchive={() => undefined} onDelete={() => undefined} onDone={() => undefined} />);
    expect(loaded).toContain('全选已加载的 400 项');
    expect(uiText('en', 'sel.allLoaded', { n: 400 })).toBe('Select the 400 loaded items');
  });
});

describe('the selection follows the saved state', () => {
  const item = (id: string, revision: number) => ({ kind: 'history', id, revision, name: id } as AssetItem);
  it('replaces a selected item whose revision changed and keeps the map when nothing changed', () => {
    const selected = new Map([['history:a', item('a', 1)], ['history:b', item('b', 1)]]);
    expect(refreshSelection(selected, [item('a', 1), item('c', 4)])).toBe(selected);
    const next = refreshSelection(selected, [item('a', 2)]);
    expect(next).not.toBe(selected);
    expect([...next.values()].map(value => `${value.id}@${value.revision}`)).toEqual(['a@2', 'b@1']);
    expect(refreshSelection(new Map(), [item('a', 2)]).size).toBe(0);
  });
});

describe('清空已归档 refused part way: the confirmation says what happened (review rework P2-1)', () => {
  const reasonZh = '「cafe_01.png」刚被改动过（例如被 Agent 改名或移动）。', reasonEn = 'An item changed just now (an agent may have renamed or moved it).';
  it('a refusal of a later request: what was moved (Undo) and what was not, never “nothing was deleted”', () => {
    const error = { text: reasonZh, stale: true, committed: true, partial: { done: 500, left: 126, reason: reasonZh } };
    const zhText = deleteErrorText(error, zh, 'zh');
    expect(zhText).toBe('已移走 500 项（可撤销）；还有 126 项没有删除：「cafe_01.png」刚被改动过（例如被 Agent 改名或移动）。');
    expect(zhText).not.toContain('没有删除任何内容');
    const enText = deleteErrorText({ ...error, text: reasonEn, partial: { done: 500, left: 126, reason: reasonEn } }, en, 'en');
    expect(enText).toBe('Moved 500 (you can undo it); not deleted: 126. An item changed just now (an agent may have renamed or moved it).');
    expect(enText).not.toMatch(/Nothing was deleted/);
    // A reason without a full stop still reads as its own sentence.
    expect(deleteErrorText({ ...error, partial: { done: 2, left: 1, reason: '磁盘忙' } }, zh, 'zh')).toBe('已移走 2 项（可撤销）；还有 1 项没有删除：磁盘忙。');
  });
  it('a refusal of the first (or only) request: nothing was deleted', () => {
    expect(deleteErrorText({ text: reasonZh, stale: true, committed: true }, zh, 'zh')).toBe(`${reasonZh} 没有删除任何内容。请按现在的状态重新检查。`);
    expect(deleteErrorText({ text: reasonEn, stale: true, committed: true }, en, 'en')).toBe(`${reasonEn} Nothing was deleted. Check again with the current state.`);
    // A failed preview (nothing committed) is only its reason.
    expect(deleteErrorText({ text: reasonZh, stale: true, committed: false }, zh, 'zh')).toBe(reasonZh);
  });
  it('after Undo from the toast: the moved items are back (or how many could not be)', () => {
    const undone = { text: reasonZh, stale: true, committed: true, partial: { done: 500, left: 126, reason: reasonZh, undone: 500 } };
    expect(deleteErrorText(undone, zh, 'zh')).toBe('已撤销，移走的 500 项都已恢复。');
    expect(deleteErrorText(undone, en, 'en')).toBe('Undone: the 500 moved items are back.');
    expect(deleteErrorText({ ...undone, partial: { ...undone.partial, undone: 498 } }, zh, 'zh')).toBe('已撤销：恢复了 498 项，另有 2 项已经不在最近删除里。');
    expect(deleteErrorText({ ...undone, partial: { ...undone.partial, undone: 498 } }, zh, 'zh')).not.toContain('已移走');
  });
  it('a preview in several requests counts files “about” (a file two requests share is not seen)', () => {
    const summary = { count: 620, omitted: 0, filesMoved: 60, bytesMoved: 2_000_000, unknownSize: 0, filesKept: 3, filesMissing: 0, collections: [], recipes: 0, recipesUnknown: false, coversCleared: [], referencedBy: 0, byKind: [], rows: [], remaining: 0 };
    const lines = impactLines(summary, zh, 'zh', 'archived', { approximate: true }).map(line => line.text);
    expect(lines).toContain('约移走 60 个文件（约 2.0 MB）');
    expect(lines).toContain('约 3 个文件也被其它条目使用，会留在原处');
    expect(impactLines(summary, en, 'en', 'archived').map(line => line.text)).toContain('60 files move out (2.0 MB)');
  });
});

describe('host refusals in the user’s words', () => {
  it('names the item, never its internal id, and turns request validation into a plain limit', () => {
    const changed = { code: 'library_conflict', reason: 'trash.item_changed', params: { item: 'history:h1', revision: 2 }, message: 'history:h1 changed (current revision 2); read it again.' };
    expect(libraryErrorText(changed, zh, 'zh', new Map([['history:h1', 'cafe_01.png']]))).toBe('「cafe_01.png」刚被改动过（例如被 Agent 改名或移动）。');
    expect(libraryErrorText(changed, en, 'en')).toBe('An item changed just now (an agent may have renamed or moved it).');
    const invalid = { code: 'invalid_argument', reason: 'library.invalid_request', params: { detail: 'data must NOT have additional properties, data/action must be equal to constant' } };
    expect(libraryErrorText(invalid, zh, 'zh')).toBe('素材库没法处理这次请求（一次最多 500 项）。');
    expect(libraryErrorText({ reason: 'trash.entry_not_found', params: { trashId: '64361313-3c41-4d75-b80d-fe7d495acb04' } }, zh, 'zh')).not.toMatch(/[0-9a-f]{8}-/);
  });
});

describe('Undo names every entry a deletion created', () => {
  it('uses the listed rows and omitted.trashIds, and counts what the receipt did not name', () => {
    const receipt = { deleted: [{ kind: 'history' as const, id: 'a', revision: 1, name: 'a', trashId: 't1' }], omitted: { count: 3, trashIds: ['t2', 't3'] }, totals: { entries: 4 } };
    expect(receiptTrashIds(receipt)).toEqual(['t1', 't2', 't3']);
    expect(receiptUnnamed(receipt)).toBe(1);
  });
});

describe('batched requests', () => {
  it('splits into requests of at most 500', () => {
    expect(chunks(Array.from({ length: 1001 }, (_, index) => index)).map(part => part.length)).toEqual([500, 500, 1]);
  });
  it('purges and restores only the named entries; an entry gone since is skipped and counted, never replaced by another', async () => {
    const present = new Set(['a', 'b', 'c']);
    const sent: string[][] = [];
    const api: LibraryApi = { assetLibrary: async (args: Record<string, any>) => {
      if (args.action === 'recently-deleted') return { entries: [...present].map(trashId => ({ trashId })), total: present.size, offset: 0, limit: 100, hasMore: false, nextOffset: null };
      sent.push([...args.trashIds]);
      if (args.trashIds.some((id: string) => !present.has(id))) throw Object.assign(new Error('gone'), { reason: 'trash.entry_not_found' });
      for (const id of args.trashIds) present.delete(id);
      return { totals: { entries: args.trashIds.length } };
    } };
    present.delete('b'); // restored elsewhere after the confirmation listed it
    present.add('z'); // deleted after the confirmation opened
    expect(await purgeListed(api, ['a', 'b', 'c'])).toEqual({ purged: 2, gone: 1, retryLater: 0 });
    expect(sent).toEqual([['a', 'b', 'c'], ['a', 'c']]);
    expect([...present]).toEqual(['z']);
    expect(await restoreListed(api, ['z'])).toEqual({ restored: 1, gone: 0 });
  });
  it('a run that stops part way names what it settled, so a retry sends only the rest and counts nothing twice', async () => {
    const present = new Set(Array.from({ length: 700 }, (_, index) => `e${index}`));
    let fail = true;
    const api: LibraryApi = { assetLibrary: async (args: Record<string, any>) => {
      if (args.action === 'recently-deleted') return { entries: [...present].map(trashId => ({ trashId })), total: present.size, offset: 0, limit: 100, hasMore: false, nextOffset: null };
      if (fail && args.trashIds.includes('e600')) { fail = false; throw Object.assign(new Error('disk busy'), { code: 'library_failed' }); }
      for (const id of args.trashIds) present.delete(id);
      return { totals: { entries: args.trashIds.length } };
    } };
    const all = Array.from({ length: 700 }, (_, index) => `e${index}`);
    let stopped: PartialRunError | null = null;
    try { await purgeListed(api, all); } catch (error) { stopped = error as PartialRunError; }
    expect(stopped).toBeInstanceOf(PartialRunError);
    expect(stopped!.done).toBe(500);
    expect(stopped!.settled).toHaveLength(500);
    const settled = new Set(stopped!.settled);
    const rest = all.filter(id => !settled.has(id));
    expect(await purgeListed(api, rest)).toEqual({ purged: 200, gone: 0, retryLater: 0 });
    expect(present.size).toBe(0);
  });
  it('清空已归档 takes the host’s complete list of archived items (ui-archived), whatever their number', async () => {
    const fixture = createCaptureFixture('en', new Date(), { archivedTotal: 112 });
    const list = await listArchived(fixture.api);
    expect(list.total).toBe(112);
    expect(list.items).toHaveLength(112);
    expect(list.items.every(item => item.name && Number.isSafeInteger(item.revision))).toBe(true);
    expect((await listArchived(createCaptureFixture('en', new Date()).api)).items).toHaveLength(12);
  });
  it('previews and deletes a long list 500 at a time; the receipts add up, and a refusal part way says what was deleted and what is left', async () => {
    const items = Array.from({ length: 1203 }, (_, index) => ({ kind: 'history' as const, id: `h${index}`, revision: 1 }));
    const sent: Array<{ preview: boolean; n: number }> = [];
    let refuseAt = -1;
    const api: LibraryApi = { assetLibrary: async (args: Record<string, any>) => {
      sent.push({ preview: args.preview === true, n: args.items.length });
      if (!args.preview && refuseAt === sent.filter(call => !call.preview).length - 1) throw Object.assign(new Error('changed'), { code: 'library_conflict', reason: 'trash.item_changed', params: { item: `history:${args.items[3].id}`, revision: 2 } });
      const rows = args.items.slice(0, 100).map((item: any) => ({ kind: 'history', id: item.id, revision: 1, name: item.id, ...(args.preview ? {} : { trashId: `t-${item.id}` }), files: { moved: 1 }, bytes: { moved: 10, unknownSize: 0 } }));
      return { deleted: rows, omitted: { count: args.items.length - rows.length, ...(args.preview ? {} : { trashIds: args.items.slice(100).map((item: any) => `t-${item.id}`) }) }, totals: { entries: args.items.length, files: { moved: args.items.length }, bytes: { moved: args.items.length * 10, unknownSize: 0 } } };
    } };
    const progress: number[] = [];
    const preview = await previewDeleteAll(api, items, done => progress.push(done));
    expect(sent.map(call => call.n)).toEqual([500, 500, 203]);
    expect(progress).toEqual([500, 1000, 1203]);
    expect(summarizeDeleteReceipt(preview)).toMatchObject({ count: 1203, filesMoved: 1203, bytesMoved: 12030 });
    sent.length = 0;
    const receipt = await commitDeleteAll(api, items);
    expect(sent.map(call => call.n)).toEqual([500, 500, 203]);
    expect(receiptTrashIds(receipt)).toHaveLength(1203);
    expect(receiptUnnamed(receipt)).toBe(0);
    // The second request is refused: the first stays deleted (Undo names its 500), the rest is left as it was.
    sent.length = 0; refuseAt = 1;
    let stopped: PartialDeleteError | null = null;
    try { await commitDeleteAll(api, items); } catch (error) { stopped = error as PartialDeleteError; }
    expect(stopped).toBeInstanceOf(PartialDeleteError);
    expect(sent.map(call => call.n)).toEqual([500, 500]);
    expect(receiptTrashIds(stopped!.receipt)).toHaveLength(500);
    expect(stopped!.left.map(item => item.id)).toEqual(items.slice(500).map(item => item.id));
    // A refusal of the first request is the plain refusal (nothing was deleted).
    sent.length = 0; refuseAt = 0;
    await expect(commitDeleteAll(api, items)).rejects.toMatchObject({ code: 'library_conflict' });
    expect(sent).toHaveLength(1);
    expect(mergeReceipts([{ deleted: [{ kind: 'tag', id: 'a', revision: 1, name: 'a', files: { moved: 0 } }] }, { deleted: [{ kind: 'tag', id: 'b', revision: 1, name: 'b', files: { moved: 0 } }] }]).totals).toMatchObject({ entries: 2 });
  });
});

describe('a hidden library page does not read in the background', () => {
  it('a host change while the page is hidden only marks the list stale; it is read once when the page shows', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    let reads = 0;
    const api: LibraryApi = { assetLibrary: async () => { reads++; return { items: [], total: 0, offset: 0, limit: 100, hasMore: false, revision: reads }; } };
    const request = { action: 'list', kinds: ['history'] };
    const observer = new InfiniteQueryObserver(client, libraryListOptions(api, request, true) as never);
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
    expect(reads).toBe(1);
    observer.setOptions(libraryListOptions(api, request, false) as never); // the page is hidden
    await client.invalidateQueries({ queryKey: ['asset-library'] }); // a host change batch
    await client.invalidateQueries({ queryKey: ['asset-library'] });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    observer.setOptions(libraryListOptions(api, request, true) as never); // shown again
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(observer.getCurrentResult().isFetching).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(2);
    unsubscribe(); client.clear();
  });
});

describe('keyboard shortcuts and copy', () => {
  it('stop while a dialog, menu, the settings dialog or the first-run guide is open', () => {
    const doc = (match: string | null) => ({ querySelector: (selector: string) => (match && selector === SHORTCUT_BLOCKERS ? {} : null) }) as never;
    expect(shortcutsBlocked(doc('x'))).toBe(true);
    expect(shortcutsBlocked(doc(null))).toBe(false);
    for (const part of ['.ui-scrim', '[role="menu"]', 'dialog[open]', '.modal-backdrop', '[role="dialog"][aria-modal="true"]']) expect(SHORTCUT_BLOCKERS).toContain(part);
  });
  it('names the Danbooru check in words (no raw resolution, no literal OK)', () => {
    expect(tagResolution({ resolution: 'canonical', tagStatus: 'found' })).toBe('canonical');
    expect(tagResolution({ resolution: 'alias' })).toBe('alias');
    expect(tagResolution({ resolution: 'not_found' })).toBe('not_found');
    expect(tagResolution({ resolution: 'exact' })).toBe('unknown');
    expect(tagResolution({ tagStatus: 'not_found' })).toBe('not_found');
    for (const value of ['canonical', 'alias', 'not_found', 'unknown']) expect(uiText('zh', `tag.res.${value}` as never)).not.toMatch(/OK|canonical|not_found/);
  });
  it('uses 条目 rather than 项目 for items in Chinese, and plurals for the English preset filter', () => {
    expect(uiText('zh', 'tr.sub')).toContain('删除的条目');
    expect(uiText('zh', 'sel.label')).toBe('已选的条目');
    expect(['style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'].map(kind => uiText('en', `pre.kind.${kind}` as never))).toEqual(['Styles', 'Prompts', 'Snippets', 'References']);
  });
});

afterEach(() => vi.restoreAllMocks());
