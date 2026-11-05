import { useEffect, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { invalidateAssetQueries } from '../asset-library/query';
import { Button, Checkbox, ConfirmDialog, Dialog, EmptyState, Field, Icon, Progress, Spinner, TextInput, showToast } from '../ui';
import { formatBytes, formatWhen, useUiText, type UiLang, type UiText } from '../ui/i18n';
import { listAllTrash, PartialRunError, purgeListed, restoreListed, type LibraryApi } from './api';
import { useTrash, useTrashTotals, type TrashTotals } from './data';
import { libraryErrorText } from './errors';
import { purgeSize, trashDaysLeft, trashDeletedBy, trashImpacts, type TrashEntry } from './impacts';
import { KIND_ICONS } from './present';

const RETENTION_DAYS = 30;

export function trashImpactText(entry: TrashEntry, t: UiText): string {
  const impacts = trashImpacts(entry);
  if (!impacts.length) return t('tr.i.none');
  return impacts.map(impact => t(`tr.i.${impact.key}`, { n: impact.n })).join(' · ');
}
export function trashLeftText(days: number, t: UiText) { return days <= 0 ? t('tr.leftToday') : days === 1 ? t('tr.leftOne') : t('tr.left', { n: days }); }

/** How long the last step of 清空最近删除 stays off after it opens (a double click or a held Enter cannot pass it). */
export const EMPTY_ARM_MS = 800;
/**
 * Whether the last step of 清空最近删除 may run (review rework): the user typed the number of entries the first step
 * listed, and the step has been open for EMPTY_ARM_MS. Pure, so the guard is tested without a DOM.
 */
export function emptyAllReady(state: { typed: string; count: number; openedAt: number; now: number }) {
  return state.count > 0 && state.typed.trim() === String(state.count) && state.now - state.openedAt >= EMPTY_ARM_MS;
}
/** The size line of 清空最近删除 for the listed entries. */
export function emptyAllFilesText(entries: readonly TrashEntry[], t: UiText, lang: UiLang): string | null {
  const size = purgeSize(entries);
  if (!size.files) return null;
  return size.bytes === null ? t('tr.emptyAll.filesNoSize', { f: size.files }) : t('tr.emptyAll.files', { f: size.files, size: formatBytes(size.bytes, lang) });
}
/**
 * The header count: the host's total with the size of all of Recently deleted (ui-trash-totals, oss/lib-1103); until
 * those totals are read, the size of what is loaded (all of it, or the loaded part).
 */
export function trashCountText(state: { total: number; entries: readonly TrashEntry[]; hasMore: boolean; totals?: TrashTotals | null }, t: UiText, lang: UiLang): string {
  if (state.totals) {
    const { moved, unknownSize } = state.totals.bytes, n = Math.max(state.total, state.totals.entries);
    if (!(moved > 0)) return unknownSize > 0 ? t('tr.countSizeUnknown', { n, m: unknownSize }) : t('tr.countNoSize', { n });
    return unknownSize > 0 ? t('tr.countSome', { n, size: formatBytes(moved, lang), m: unknownSize }) : t('tr.count', { n, size: formatBytes(moved, lang) });
  }
  const bytes = purgeSize(state.entries).bytes;
  if (bytes === null || bytes <= 0) return t('tr.countNoSize', { n: state.total });
  return state.hasMore ? t('tr.countPartial', { n: state.total, m: state.entries.length, size: formatBytes(bytes, lang) }) : t('tr.count', { n: state.total, size: formatBytes(bytes, lang) });
}

type Confirm = { kind: 'purge'; entries: TrashEntry[] } | { kind: 'empty' };

/**
 * Recently deleted (prototype 20, 21): what was deleted, by whom (you or the agent's name), when, how long it stays,
 * what the deletion affected; restore, delete forever (confirmed, with what it removes) and empty (two separate
 * confirmations over the entries listed when it opened). 100 entries per page, 加载更多 for the rest.
 */
export function TrashView({ api, active = true, now = Date.now(), initialSelected, initialPurge = false, initialEmpty }: { api: LibraryApi; active?: boolean; now?: number; initialSelected?: readonly string[]; initialPurge?: boolean; initialEmpty?: 1 | 2 }) {
  const { t, lang } = useUiText();
  const trash = useTrash(api, active);
  const totals = useTrashTotals(api, active);
  const entries = trash.entries;
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected ?? []));
  const [confirm, setConfirm] = useState<Confirm | null>(initialEmpty ? { kind: 'empty' } : null);
  // Capture scenario (prototype 21): the delete-forever confirmation of the selected entries, once they are listed.
  const shown = useRef(false);
  useEffect(() => {
    if (!initialPurge || shown.current || !entries.length) return;
    shown.current = true;
    setConfirm({ kind: 'purge', entries: entries.filter(entry => selected.has(entry.trashId)) });
  }, [initialPurge, entries.length]);
  const [busy, setBusy] = useState(false);
  const picked = entries.filter(entry => selected.has(entry.trashId));
  const total = trash.total;
  const toggle = (trashId: string) => setSelected(current => { const next = new Set(current); if (next.has(trashId)) next.delete(trashId); else next.add(trashId); return next; });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); setSelected(new Set()); }
    catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); }
    finally { setBusy(false); setConfirm(null); await invalidateAssetQueries(); }
  };
  const restore = (targets: TrashEntry[]) => run(async () => {
    const result = await restoreListed(api, targets.map(entry => entry.trashId));
    showToast({ message: result.gone ? t('del.undoneGone', { n: result.restored, m: result.gone }) : t('tr.restored', { n: result.restored }), tone: 'ok' });
  });
  const purge = (targets: TrashEntry[]) => run(async () => {
    const result = await purgeListed(api, targets.map(entry => entry.trashId));
    showToast({ message: t('tr.purged', { n: result.purged }), tone: 'ok' });
    if (result.gone) showToast({ message: t('tr.gone', { n: result.gone }), tone: 'warn' });
    if (result.retryLater) showToast({ message: t('tr.purgeLater', { n: result.retryLater }), tone: 'warn' });
  });
  const purgeInfo = confirm?.kind === 'purge' ? purgeSize(confirm.entries) : null;
  const allPicked = entries.length > 0 && picked.length === entries.length;
  return <div className="lib-trash" data-testid="trash-view">
    <header className="lib-trash-head">
      <div><h1>{t('tr.title')}</h1><p className="ui-muted">{t('tr.sub')}</p></div>
      <div className="lib-toolbar-gap" />
      {picked.length > 0 ? <>
        <span className="ui-muted">{trash.hasMore ? t('tr.selectedLoaded', { n: picked.length, m: total }) : t('tr.selected', { n: picked.length })}</span>
        <Button icon="restore" disabled={busy} onClick={() => void restore(picked)}>{t('tr.restore')}</Button>
        <Button variant="dangerGhost" icon="trash" disabled={busy} onClick={() => setConfirm({ kind: 'purge', entries: picked })}>{t('tr.purge')}</Button>
      </> : <>
        {total > 0 && <span className="ui-muted ui-num" data-testid="trash-count">{trashCountText({ ...trash, totals }, t, lang)}</span>}
        <Button variant="dangerGhost" disabled={!total || busy} onClick={() => setConfirm({ kind: 'empty' })} data-testid="trash-empty">{t('tr.emptyAll')}</Button>
      </>}
    </header>
    {trash.loading && !entries.length ? <p className="lib-trash-wait" role="status"><Spinner size={16} /> {t('c.loading')}</p>
      : trash.error && !entries.length ? <p className="lib-error" role="alert">{libraryErrorText(trash.error, t, lang)}</p>
      : !entries.length ? <EmptyState icon="trash" title={t('empty.trash.t')} body={t('empty.trash.d')} />
      : <div className="lib-trash-scroll"><table className="lib-table">
        <thead><tr>
          <th className="is-check"><Checkbox checked={allPicked} indeterminate={picked.length > 0 && !allPicked} label={trash.hasMore ? t('tr.selectAllLoaded', { n: entries.length }) : t('tr.selectAll')} onChange={value => setSelected(value ? new Set(entries.map(entry => entry.trashId)) : new Set())} /></th>
          <th colSpan={2}>{t('tr.col.name')}</th><th>{t('tr.col.deleted')}</th><th>{t('tr.col.left')}</th><th>{t('tr.col.impact')}</th><th className="is-actions"><span className="ui-sr-only">{t('tr.col.actions')}</span></th>
        </tr></thead>
        <tbody>{entries.map(entry => {
          const days = trashDaysLeft(entry, now), by = trashDeletedBy(entry), on = selected.has(entry.trashId);
          const who = by ? (by.kind === 'user' ? t('c.you') : by.label) : '';
          const when = formatWhen(entry.deletedAt, lang, new Date(now));
          return <tr key={entry.trashId} className={clsx(on && 'is-sel')} data-testid={`trash-${entry.trashId}`}>
            <td className="is-check"><Checkbox checked={on} label={t('tr.selectRow', { name: entry.name })} onChange={() => toggle(entry.trashId)} /></td>
            <td className="is-icon"><span className="lib-trash-ico"><Icon name={KIND_ICONS[entry.kind]} size={18} /></span></td>
            <td><b className="lib-trash-name">{entry.name}</b><span className="ui-faint">{t(`kind.${entry.kind}`)}{entry.state === 'moving' ? ` · ${t('tr.moving')}` : ''}</span></td>
            <td className="ui-muted">{who ? t('tr.by', { who, when }) : when}</td>
            <td><span className={clsx('lib-left', days <= 7 && 'is-warn')}><Progress value={Math.min(1, days / RETENTION_DAYS)} tone={days <= 7 ? 'warn' : 'accent'} label={trashLeftText(days, t)} /><span>{trashLeftText(days, t)}</span></span></td>
            <td className="ui-muted">{trashImpactText(entry, t)}</td>
            <td className="is-actions"><div className="lib-row-actions">
              <Button size="sm" variant="ghost" className="lib-purge" disabled={busy} onClick={() => setConfirm({ kind: 'purge', entries: [entry] })}>{t('tr.purge')}</Button>
              <Button size="sm" icon="restore" disabled={busy} onClick={() => void restore([entry])}>{t('tr.restore')}</Button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>
      {trash.hasMore && <div className="lib-trash-more"><span className="ui-faint ui-num">{t('tr.loaded', { m: entries.length, n: total })}</span>
        <Button size="sm" busy={trash.loadingMore} onClick={trash.loadMore} data-testid="trash-load-more">{t('tr.loadMore')}</Button></div>}
      <p className="lib-note"><Icon name="info" size={14} />{t('tr.restoreNote')}</p>
      </div>}
    {confirm?.kind === 'purge' && purgeInfo && <ConfirmDialog open tone="danger" icon="alert" busy={busy} cancelLabel={t('c.cancel')} confirmLabel={t('tr.purge')} onCancel={() => setConfirm(null)} onConfirm={() => void purge(confirm.entries)}
      title={confirm.entries.length === 1 ? t('tr.purge.titleOne', { name: confirm.entries[0].name }) : t('tr.purge.title', { n: confirm.entries.length })}
      description={purgeInfo.files === 0 ? t('tr.purge.bodyNoFiles') : purgeInfo.bytes === null ? t('tr.purge.bodyNoSize', { f: purgeInfo.files }) : t('tr.purge.body', { f: purgeInfo.files, size: formatBytes(purgeInfo.bytes, lang) })}>
      <p className="lib-note"><Icon name="info" size={14} />{t('tr.purge.shared')}</p>
    </ConfirmDialog>}
    {confirm?.kind === 'empty' && <EmptyTrashFlow api={api} initialStep={initialEmpty} onClose={() => setConfirm(null)} onDone={async result => {
      setConfirm(null); setSelected(new Set());
      showToast({ message: t('tr.purged', { n: result.purged }), tone: 'ok' });
      if (result.gone) showToast({ message: t('tr.gone', { n: result.gone }), tone: 'warn' });
      if (result.retryLater) showToast({ message: t('tr.purgeLater', { n: result.retryLater }), tone: 'warn' });
      await invalidateAssetQueries();
    }} />}
  </div>;
}

/**
 * The last step's buttons: 彻底删除 on the left (off until emptyAllReady), Cancel on the right, where the first step
 * had 继续 (a second click of a double click lands on Cancel). The dialog focuses Cancel.
 */
export function EmptyAllFooter({ count, ready, busy, onConfirm, onCancel, cancelRef }: { count: number; ready: boolean; busy: boolean; onConfirm(): void; onCancel(): void; cancelRef?: RefObject<HTMLButtonElement | null> }) {
  const { t } = useUiText();
  return <div className="lib-empty-ft">
    <Button variant="danger" icon="trash" busy={busy} disabled={!ready} onClick={onConfirm} data-testid="empty-confirm">{t('tr.emptyAll.confirm', { n: count })}</Button>
    <span className="lib-toolbar-gap" />
    <Button ref={cancelRef} onClick={onCancel} disabled={busy} data-testid="empty-cancel">{t('c.cancel')}</Button>
  </div>;
}

type EmptyPhase =
  | { step: 'loading' }
  | { step: 'failed'; text: string }
  | { step: 1; entries: TrashEntry[] }
  | { step: 2; entries: TrashEntry[]; openedAt: number };

/**
 * 清空最近删除 (review rework): lists every entry when it opens (all pages) and purges exactly those, 500 per
 * request; entries deleted after it opened are not touched. The second confirmation is its own dialog: the number of
 * entries has to be typed, its delete button sits where the first step had nothing (Cancel takes the place of
 * 继续, and has the focus), and it stays off for EMPTY_ARM_MS, so a double click, a held Enter or repeated Enter
 * presses cannot pass it.
 */
export function EmptyTrashFlow({ api, initialStep, onClose, onDone }: { api: LibraryApi; initialStep?: 1 | 2; onClose(): void; onDone(result: { purged: number; gone: number; retryLater: number }): void }) {
  const { t, lang } = useUiText();
  const [phase, setPhase] = useState<EmptyPhase>({ step: 'loading' });
  const [typed, setTyped] = useState('');
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel1 = useRef<HTMLButtonElement | null>(null);
  const tally = useRef({ purged: 0, gone: 0, retryLater: 0 });
  const cancel2 = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let live = true;
    listAllTrash(api).then(entries => { if (live) setPhase(initialStep === 2 && entries.length ? { step: 2, entries, openedAt: Date.now() } : { step: 1, entries }); },
      failure => { if (live) setPhase({ step: 'failed', text: libraryErrorText(failure, t, lang) }); });
    return () => { live = false; };
  }, []);
  const step = phase.step, openedAt = phase.step === 2 ? phase.openedAt : 0;
  // Armed EMPTY_ARM_MS after the last step opens (again after a partial failure narrowed its list).
  useEffect(() => {
    if (step !== 2) return;
    setArmed(false);
    const timer = setTimeout(() => setArmed(true), EMPTY_ARM_MS);
    return () => clearTimeout(timer);
  }, [step, openedAt]);
  if (phase.step === 'loading' || phase.step === 'failed' || phase.step === 1) {
    const entries = phase.step === 1 ? phase.entries : [];
    const files = phase.step === 1 ? emptyAllFilesText(entries, t, lang) : null;
    const none = phase.step === 1 && !entries.length;
    return <Dialog key="empty-1" open onClose={onClose} tone="danger" icon="alert" title={t('tr.emptyAll.title')} initialFocusRef={cancel1}
      description={phase.step === 1 ? (none ? t('tr.emptyAll.none') : t('tr.emptyAll.body', { n: entries.length })) : undefined}
      footer={<>
        <Button ref={cancel1} onClick={onClose}>{none || phase.step === 'failed' ? t('c.close') : t('c.cancel')}</Button>
        {!none && phase.step !== 'failed' && <Button disabled={phase.step !== 1} onClick={() => { if (phase.step === 1) { setTyped(''); setPhase({ step: 2, entries: phase.entries, openedAt: Date.now() }); } }} data-testid="empty-next">{t('tr.emptyAll.next')}</Button>}
      </>}>
      {phase.step === 'loading' && <p className="lib-del-wait" role="status"><Spinner size={16} />{t('tr.emptyAll.loading')}</p>}
      {phase.step === 'failed' && <p className="lib-error" role="alert">{phase.text}</p>}
      {phase.step === 1 && !none && <>
        {files && <p className="lib-del-note"><Icon name="image" size={14} />{files}</p>}
        <p className="lib-del-note"><Icon name="info" size={14} />{t('tr.emptyAll.later')}</p>
      </>}
    </Dialog>;
  }
  const entries = phase.entries, count = entries.length;
  const ready = armed && emptyAllReady({ typed, count, openedAt: phase.openedAt, now: Date.now() });
  const run = async () => {
    // Checked again at the click: typed number, and the time since the step opened.
    if (busy || !emptyAllReady({ typed, count, openedAt: phase.openedAt, now: Date.now() })) return;
    setBusy(true); setError('');
    try {
      const result = await purgeListed(api, entries.map(entry => entry.trashId));
      onDone({ purged: tally.current.purged + result.purged, gone: tally.current.gone + result.gone, retryLater: tally.current.retryLater + result.retryLater });
    } catch (failure) {
      // Stopped part way: what was purged (or skipped as gone) is not sent again; a retry covers only the rest, and
      // the counts of the final message add up over the attempts.
      const partial = failure instanceof PartialRunError ? failure : null;
      const settled = new Set(partial?.settled ?? []);
      tally.current = { ...tally.current, purged: tally.current.purged + (partial?.done ?? 0), gone: tally.current.gone + (partial?.gone ?? 0) };
      const rest = entries.filter(entry => !settled.has(entry.trashId));
      const reason = libraryErrorText(partial ? partial.failure : failure, t, lang);
      if (rest.length !== entries.length) { setTyped(''); setPhase({ step: 2, entries: rest, openedAt: Date.now() }); }
      setError(tally.current.purged > 0 ? t('tr.emptyAll.partial', { n: tally.current.purged, m: rest.length, reason }) : reason);
      setBusy(false);
      await invalidateAssetQueries();
    }
  };
  return <Dialog key="empty-2" open onClose={onClose} busy={busy} tone="danger" icon="trash" title={t('tr.emptyAll.again', { n: count })} description={t('tr.emptyAll.body', { n: count })} initialFocusRef={cancel2}
    footer={<EmptyAllFooter count={count} ready={ready} busy={busy} onConfirm={() => void run()} onCancel={onClose} cancelRef={cancel2} />}>
    <Field label={t('tr.emptyAll.type', { n: count })}>
      <TextInput value={typed} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={12} disabled={busy} onChange={event => setTyped(event.target.value)} data-testid="empty-typed"
        onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} />
    </Field>
    {error && <p className="lib-error" role="alert">{error}</p>}
  </Dialog>;
}
