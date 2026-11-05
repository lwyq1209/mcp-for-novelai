import { useEffect, useMemo, useRef, useState } from 'react';
import type { AssetItem } from '../asset-library/types';
import { Button, Dialog, Disclosure, Field, Icon, Spinner, TextInput, type IconName } from '../ui';
import { formatBytes, quotedList, useUiText, type UiLang, type UiText } from '../ui/i18n';
import { BATCH_LIMIT, commitDelete, commitDeleteAll, listArchived, PartialDeleteError, previewDelete, previewDeleteAll, refreshItems, type ItemRef, type LibraryApi } from './api';
import { summarizeDeleteReceipt, receiptTrashIds, receiptUnnamed, type DeleteSummary } from './impacts';
import { isStale, libraryErrorText } from './errors';
import { Thumb } from './Thumb';
import { isImageKind } from './model';
import { KIND_ICONS } from './present';

export interface ImpactLine { icon: IconName; text: string; warn?: boolean }

/**
 * The lines of 删除后会有这些变化, from the host's preview (prototype 06, 07). approximate (review rework): a preview made
 * of several requests (清空已归档 of more than 500 items) cannot see a file two requests share, so its file counts and
 * size read "about".
 */
export function impactLines(summary: DeleteSummary, t: UiText, lang: UiLang, mode: 'items' | 'archived', options: { approximate?: boolean } = {}): ImpactLine[] {
  const lines: ImpactLine[] = [], about = options.approximate === true;
  if (mode === 'archived' && summary.byKind.length) lines.push({ icon: 'layers', text: summary.byKind.map(value => t('arc.kindCount', { kind: t(`kinds.${value.kind}`, { n: value.count }), n: value.count })).join(lang === 'zh' ? ' · ' : ' · ') });
  if (summary.filesMoved > 0) {
    const size = summary.bytesMoved === null ? null : formatBytes(summary.bytesMoved, lang);
    lines.push({ icon: 'image', text: size === null ? t(about ? 'del.filesAboutNoSize' : 'del.filesNoSize', { n: summary.filesMoved })
      : summary.unknownSize > 0 ? t(about ? 'del.filesAboutUnknown' : 'del.filesUnknown', { n: summary.filesMoved, size, m: summary.unknownSize }) : t(about ? 'del.filesAbout' : 'del.files', { n: summary.filesMoved, size }) });
  } else if (summary.count > 0) lines.push({ icon: 'image', text: t('del.noFiles') });
  if (summary.filesKept > 0) lines.push({ icon: 'link', text: t(about ? 'del.sharedAbout' : 'del.shared', { n: summary.filesKept }) });
  if (summary.filesMissing > 0) lines.push({ icon: 'alert', text: t('del.missing', { n: summary.filesMissing }), warn: true });
  if (summary.collections.length) {
    const shown = summary.collections.slice(0, 3);
    lines.push({ icon: 'collection', text: summary.collections.length > 3 ? t('del.collsMore', { names: quotedList(shown, lang), n: summary.collections.length - 3 }) : t('del.colls', { names: quotedList(shown, lang), n: summary.collections.length }) });
  }
  if (summary.recipes > 0) lines.push({ icon: 'alert', text: t('del.recipes', { n: summary.recipes }), warn: true });
  else if (summary.recipesUnknown) lines.push({ icon: 'alert', text: t('del.recipesUnknown'), warn: true });
  if (summary.coversCleared.length) lines.push({ icon: 'tag', text: t('del.covers', { names: quotedList(summary.coversCleared.slice(0, 3), lang), n: summary.coversCleared.length }) });
  if (summary.referencedBy > 0) lines.push({ icon: 'link', text: t('del.referenced', { n: summary.referencedBy }), warn: true });
  if (summary.omitted > 0) lines.push({ icon: 'info', text: t('del.omitted', { n: summary.omitted }) });
  return lines;
}

export function ImpactList({ lines, title }: { lines: readonly ImpactLine[]; title: string }) {
  return <div className="lib-impact" role="list" aria-label={title}>
    <div className="lib-impact-h">{title}</div>
    {lines.map((line, index) => <div key={index} role="listitem" className={line.warn ? 'lib-impact-r is-warn' : 'lib-impact-r'}><Icon name={line.icon} size={16} /><span>{line.text}</span></div>)}
  </div>;
}

export type DeleteTarget = { kind: 'items'; items: AssetItem[]; /** Selected items the current view does not show (search or filter). */ outside?: number } | { kind: 'archived' };
export interface DeletedResult {
  summary: DeleteSummary;
  /** Every trashId the deletion created (rows and omitted.trashIds), for Undo. */
  trashIds: string[];
  /** Deleted items the receipt did not name (only Recently deleted can restore them). */
  unnamed: number;
}
type DeletePlan = { items: Array<ItemRef & { name: string }>; summary: DeleteSummary; dropped: number; archived?: { total: number } };
/**
 * A refused preview or commit. partial (清空已归档 in several requests): the requests before the refusal went through —
 * done items moved (Undo offered), left not deleted, reason the refusal in words; undone once Undo brought them back.
 */
export type DeleteError = { text: string; stale: boolean; committed: boolean; partial?: { done: number; left: number; reason: string; undone?: number } };
/**
 * What the confirmation says after a refusal (review rework P2-1). A whole refusal: nothing was deleted. A refusal part
 * way: what was moved (and can be undone) and what was not, never "nothing was deleted"; after Undo, that it is undone.
 */
export function deleteErrorText(error: DeleteError, t: UiText, lang: UiLang): string {
  const partial = error.partial;
  if (partial) {
    // The reason is a sentence of its own inside the text.
    const reason = /[\u3002.\uff01!\uff1f?]$/.test(partial.reason.trim()) ? partial.reason.trim() : `${partial.reason.trim()}${lang === 'zh' ? '\u3002' : '.'}`;
    if (partial.undone === undefined) return t('arc.partial', { n: partial.done, m: partial.left, reason });
    return partial.undone >= partial.done ? t('arc.partialUndone', { n: partial.undone }) : t('arc.partialUndoneSome', { n: partial.undone, m: partial.done - partial.undone });
  }
  return error.committed && error.stale ? `${error.text} ${t('del.stale')}` : error.text;
}

const kindCounts = (items: ReadonlyArray<Pick<ItemRef, 'kind'>>) => {
  const counts = new Map<AssetItem['kind'], number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
};

/**
 * Delete confirmation (prototype 06) and Empty archived (07). The host previews exactly the list the confirm button
 * then commits (preview:true changes nothing); a failed preview keeps the button off. Empty archived (oss/lib-1103)
 * takes the host's complete list of archived items when it opens (ui-archived), previews it 500 at a time and commits
 * that same list with the ordinary delete, 500 at a time, so an item archived later is not taken. When an item changed
 * or left since (an agent, another window), the host refuses that whole request: it and the rest are not deleted (the
 * requests before it were, and can be undone), and 重新检查 previews again with the current saved state.
 */
export function DeleteDialog({ api, target, onClose, onDeleted, onPartial }: { api: LibraryApi; target: DeleteTarget; onClose(): void; onDeleted(result: DeletedResult): void;
  /** 清空已归档 stopped part way: what was deleted (for Undo); the dialog stays. onUndone: Undo brought back `restored` of them. */
  onPartial?(result: DeletedResult, onUndone: (restored: number) => void): void }) {
  const { t, lang } = useUiText();
  const [plan, setPlan] = useState<DeletePlan | null>(null);
  const [error, setError] = useState<DeleteError | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const initial = target.kind === 'items' ? target.items : [];
  // The items this confirmation deletes: the selection, then after 重新检查 their current saved versions (items gone
  // since left out). The title, the thumbnails, the preview and the commit all follow this list.
  const current = useRef<AssetItem[]>(initial);
  const [shown, setShown] = useState<AssetItem[]>(initial);
  const dropped = useRef(0);
  const tooMany = target.kind === 'items' && initial.length > BATCH_LIMIT;
  // Names for the messages, including items left out since (a refusal can name one of them).
  const names = useMemo(() => new Map(initial.map(item => [`${item.kind}:${item.id}`, item.name])), [initial]);
  // 清空已归档: the names of the listed archived items (a refusal can name one of them).
  const archivedNames = useRef(new Map<string, string>());
  const namesOf = () => target.kind === 'archived' ? archivedNames.current : names;
  useEffect(() => {
    if (tooMany) return;
    let live = true;
    setPlan(null); setError(null); setChecking(null);
    void (async () => {
      if (target.kind === 'archived') {
        const list = await listArchived(api);
        archivedNames.current = new Map(list.items.map(item => [`${item.kind}:${item.id}`, item.name]));
        if (!list.items.length) return { items: [], summary: summarizeDeleteReceipt(null), dropped: 0, archived: { total: 0 } };
        const receipt = await previewDeleteAll(api, list.items, (done, total) => { if (live && total > BATCH_LIMIT) setChecking({ done, total }); });
        return { items: list.items, summary: summarizeDeleteReceipt(receipt), dropped: 0, archived: { total: list.items.length } };
      }
      if (attempt > 0) {
        // 重新检查: the saved state of every item now; items gone since are left out (and said so).
        const fresh = await refreshItems(api, current.current);
        dropped.current += fresh.gone.length;
        current.current = fresh.items;
        if (live) setShown(fresh.items);
      }
      if (!current.current.length) return { items: [], summary: summarizeDeleteReceipt(null), dropped: dropped.current };
      const receipt = await previewDelete(api, current.current);
      return { items: current.current, summary: summarizeDeleteReceipt(receipt), dropped: dropped.current };
    })().then(next => { if (live) setPlan(next); }, failure => {
      if (!live) return;
      setError({ text: libraryErrorText(failure, t, lang, namesOf()), stale: isStale(failure), committed: false });
    });
    return () => { live = false; };
  }, [attempt]);
  const confirm = async () => {
    if (!plan || !plan.items.length || busy) return;
    setBusy(true); setError(null);
    try {
      const receipt = plan.archived ? await commitDeleteAll(api, plan.items) : await commitDelete(api, plan.items);
      onDeleted({ summary: summarizeDeleteReceipt(receipt), trashIds: receiptTrashIds(receipt), unnamed: receiptUnnamed(receipt) });
    } catch (failure) {
      if (failure instanceof PartialDeleteError) {
        // Some requests went through before the refusal: say so, offer Undo for them, and keep the rest for a new check.
        const done = summarizeDeleteReceipt(failure.receipt);
        const reason = libraryErrorText(failure.failure, t, lang, namesOf());
        setError({ text: reason, stale: isStale(failure.failure), committed: true, partial: { done: done.count, left: failure.left.length, reason } });
        onPartial?.({ summary: done, trashIds: receiptTrashIds(failure.receipt), unnamed: receiptUnnamed(failure.receipt) }, restored => {
          // Undone from the toast: the dialog says so (and still offers 重新检查).
          if (mounted.current) setError(current => current?.partial && current.partial.undone === undefined ? { ...current, partial: { ...current.partial, undone: restored } } : current);
        });
      } else setError({ text: libraryErrorText(failure, t, lang, namesOf()), stale: isStale(failure), committed: true });
      setBusy(false);
    }
  };
  const recheck = () => setAttempt(value => value + 1);
  const archived = target.kind === 'archived';
  const one = !archived && shown.length === 1 ? shown[0] : null;
  const count = plan?.items.length ?? shown.length;
  const nothing = !!plan && !plan.items.length;
  const title = archived ? t('arc.title') : one ? t('del.titleOne', { name: one.name }) : t('del.title', { n: shown.length });
  const description = archived ? (plan ? (plan.items.length ? t('arc.body', { n: plan.items.length }) : t('arc.none')) : t('arc.intro'))
    : nothing ? t('del.noneLeft') : one ? t('del.bodyOne') : t('del.body');
  const images = shown.filter(item => isImageKind(item.kind));
  // The confirm button commits only a list the host previewed just now, after a refused commit only once checked again.
  const ready = !!plan && plan.items.length > 0 && !(error?.committed);
  const summary = plan ? (archived ? { ...plan.summary, byKind: kindCounts(plan.items) } : plan.summary) : null;
  return <Dialog open onClose={onClose} busy={busy} tone="danger" icon={archived ? 'archive' : 'trash'} title={title} description={description} initialFocusRef={cancelRef}
    footer={<>
      <Button ref={cancelRef} onClick={onClose} disabled={busy}>{nothing || tooMany ? t('c.close') : t('c.cancel')}</Button>
      {!nothing && !tooMany && <Button variant="danger" icon="trash" busy={busy} disabled={!ready} onClick={() => void confirm()} data-testid="delete-confirm">
        {archived ? t('arc.confirm') : one ? t('del.confirmOne') : t('del.confirm', { n: count })}
      </Button>}
    </>}>
    {images.length > 0 && <div className="lib-del-thumbs" aria-hidden="true">
      {images.slice(0, 6).map(item => <span key={`${item.kind}:${item.id}`} className="lib-del-thumb"><Thumb api={api} item={item} /></span>)}
      {images.length > 6 && <span className="lib-del-thumb is-more">+{images.length - 6}</span>}
    </div>}
    {tooMany && <p className="lib-error" role="alert">{t('del.tooMany', { max: BATCH_LIMIT, n: initial.length })}</p>}
    {!tooMany && !plan && !error && <p className="lib-del-wait" role="status"><Spinner size={16} />{checking ? t('arc.checking', { n: checking.done, m: checking.total }) : t('del.checking')}</p>}
    {target.kind === 'items' && !!target.outside && !tooMany && <p className="lib-del-note"><Icon name="info" size={14} />{t('del.outside', { n: target.outside })}</p>}
    {plan && plan.dropped > 0 && <p className="lib-del-note"><Icon name="info" size={14} />{t('del.dropped', { n: plan.dropped })}</p>}
    {summary && summary.count > 0 && <ImpactList title={t('del.impact')} lines={impactLines(summary, t, lang, target.kind, { approximate: !!plan?.archived && plan.items.length > BATCH_LIMIT })} />}
    {plan?.archived && plan.items.length > BATCH_LIMIT && <p className="lib-del-note" data-testid="archived-batches"><Icon name="info" size={14} />{t('arc.batches', { n: plan.items.length, m: Math.ceil(plan.items.length / BATCH_LIMIT) })}</p>}
    {summary && summary.rows.length > 0 && <Disclosure summary={t('c.showDetails')} className="lib-del-details">
      <ul className="lib-del-rows">{summary.rows.map(row => <li key={`${row.kind}:${row.id}`}><Icon name={KIND_ICONS[row.kind]} size={14} /><span className="lib-del-name">{row.name}</span>
        <span className="ui-faint ui-num">{[row.files?.moved ? `${row.files.moved} ${t('del.state.moved')}` : '', row.files?.kept ? `${row.files.kept} ${t('del.state.kept')}` : '', row.files?.missing ? `${row.files.missing} ${t('del.state.missing')}` : ''].filter(Boolean).join(' · ')}{row.bytes?.moved ? ` · ${formatBytes(row.bytes.moved, lang)}` : ''}</span></li>)}</ul>
    </Disclosure>}
    {error && <div className="lib-error" role="alert"><p data-testid="delete-error">{deleteErrorText(error, t, lang)}</p>
      {(error.stale || error.committed || !plan) && <Button size="sm" variant="ghost" icon="refresh" onClick={recheck}>{error.stale || error.committed ? t('del.recheck') : t('c.retry')}</Button>}</div>}
  </Dialog>;
}

/** One name: a new collection, or renaming a collection, project or image. */
export function NameDialog({ title, label, initial = '', hint, confirmLabel, onClose, onSubmit }: { title: string; label: string; initial?: string; hint?: string; confirmLabel: string; onClose(): void; onSubmit(name: string): Promise<void> }) {
  const { t, lang } = useUiText();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement | null>(null);
  const submit = async () => {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true); setError('');
    try { await onSubmit(value); } catch (failure) { setError(libraryErrorText(failure, t, lang)); setBusy(false); }
  };
  return <Dialog open onClose={onClose} busy={busy} title={title} width={440} initialFocusRef={input}
    footer={<><Button onClick={onClose} disabled={busy}>{t('c.cancel')}</Button><Button variant="primary" busy={busy} disabled={!name.trim() || name.trim() === initial.trim()} onClick={() => void submit()}>{confirmLabel}</Button></>}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Field label={label} hint={hint} error={error || undefined}><TextInput ref={input} value={name} maxLength={200} onChange={event => setName(event.target.value)} /></Field>
    </form>
  </Dialog>;
}
