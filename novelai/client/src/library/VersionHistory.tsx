import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AssetDetail, AssetItem, AssetVersions } from '../asset-library/types';
import { assetQueryKey, invalidateAssetQueries, useLocalAssetQuery } from '../asset-library/query';
import { readHostError } from '../host-errors';
import { Button, Dialog, Icon, Spinner, Tag, showToast } from '../ui';
import { formatDay, formatTime, useUiText, type UiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { libraryErrorText } from './errors';
import { itemTitle } from './present';
import { restorableKind, restoreChanges, versionDifferences, versionFields, versionUse, type VersionField } from './versions';

export interface VersionHistoryProps {
  api: LibraryApi;
  /** The current saved state (the drawer's read); it follows changes made elsewhere. */
  current: AssetItem;
  /** Project names by collection id ("history:<groupId>"), for a history image's project. */
  projects?: ReadonlyMap<string, string>;
  onClose(): void;
  /** 用这一版: the current version's main action with the chosen version (on the canvas, or onto the combo tray). */
  onUse?(item: AssetItem): void | Promise<void>;
}

const when = (value: string | undefined, lang: 'zh' | 'en') => value ? `${formatDay(value, lang)} ${formatTime(value)}` : '';

/**
 * 版本历史 of a library item (step 4c1; the drawer's ⋯ menu): every saved version, newest first; the chosen one's
 * content with what differs from the current version; 用这一版 (the drawer's main action with that version's content)
 * and 恢复为新版本 (the host's restore-content: a new version with that content, history kept), confirmed first and
 * sent with the revision the comparison was made against, so a change made elsewhere meanwhile is refused, not lost.
 * The comparison tells what a restore changes from what it keeps (the group; 恢复不改这一项), and a version whose
 * restorable content is the current one's cannot be restored (review rework). A change arriving while the
 * confirmation is open withdraws it and says so; refusals keep the focus in the dialog, so Escape still closes it.
 */
export function VersionHistory({ api, current, projects, onClose, onUse }: VersionHistoryProps) {
  const { t, lang } = useUiText();
  const versionsQuery = useLocalAssetQuery<AssetVersions>(assetQueryKey(api, 'versions', current.kind, current.id), () => api.assetLibrary({ action: 'versions', kind: current.kind, id: current.id }));
  const versions = versionsQuery.data?.versions ?? [];
  const [chosen, setChosen] = useState<number | null>(null);
  // The newest version older than the current one is chosen first (the current one when there is no other).
  useEffect(() => {
    if (chosen !== null || !versions.length) return;
    setChosen(versions.find(version => version.revision !== current.revision)?.revision ?? versions[0].revision);
  }, [versions.length]);
  const isCurrent = chosen === current.revision;
  const versionQuery = useLocalAssetQuery<AssetDetail>(assetQueryKey(api, 'detail', current.kind, current.id, chosen ?? 0),
    () => api.assetLibrary({ action: 'read', kind: current.kind, id: current.id, revision: chosen }), chosen !== null && !isCurrent);
  const version = isCurrent ? current : versionQuery.data?.item;
  const [confirm, setConfirm] = useState<{ revision: number; expected: number } | null>(null);
  const [busy, setBusy] = useState<'restore' | 'use' | ''>('');
  // Rendered when shown (in the current language): a host refusal, or a change made elsewhere while confirming.
  const [refusal, setRefusal] = useState<{ error: unknown } | { changedTo: number } | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const refusalRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => { setConfirm(null); setRefusal(null); }, [chosen]);
  // The item changed elsewhere while the confirmation was open: its numbers no longer hold, so it is withdrawn.
  useEffect(() => {
    if (confirm && confirm.expected !== current.revision) { setConfirm(null); setRefusal({ changedTo: current.revision }); }
  }, [current.revision]);
  // A refusal takes the focus (inside the dialog; the confirm button it replaces is gone), so Escape still closes.
  useEffect(() => { if (refusal) refusalRef.current?.focus({ preventScroll: true }); }, [refusal]);
  const canRestore = (versionsQuery.data?.canRestore ?? restorableKind(current.kind)) && restorableKind(current.kind);
  const use = versionUse(current.kind);

  const restore = async () => {
    if (!confirm || busy) return;
    setBusy('restore'); setRefusal(null);
    try {
      const receipt = await api.assetLibrary({ action: 'restore-content', kind: current.kind, id: current.id, revision: confirm.revision, expectedRevision: confirm.expected }) as { item?: AssetItem };
      await invalidateAssetQueries();
      showToast({ message: t('ver.restored', { n: receipt?.item?.revision ?? confirm.expected + 1, from: confirm.revision }), tone: 'ok' });
      onClose();
    } catch (failure) {
      // Changed elsewhere since the comparison: nothing was restored; the dialog shows the latest state.
      const changed = readHostError(failure).reason === 'library.item_changed';
      setRefusal({ error: changed ? 'conflict' : failure });
      setConfirm(null);
      if (changed) await invalidateAssetQueries();
    } finally { setBusy(''); }
  };
  const useVersion = async () => {
    if (!version || !onUse || busy) return;
    setBusy('use');
    try { await onUse(version); } finally { setBusy(''); }
  };

  const differences = useMemo(() => version && !isCurrent ? versionDifferences(version, current, projects) : [], [version, current, projects, isCurrent]);
  const fields = useMemo(() => version ? versionFields(version, projects) : [], [version, projects]);
  const changed = new Map(differences.map(difference => [difference.key, difference]));
  // A read-only kind (history, artist picks) only says what differs.
  const restorable = canRestore ? differences.filter(difference => difference.restores) : differences, kept = canRestore ? differences.filter(difference => !difference.restores) : [];
  const effect = useMemo(() => version && !isCurrent ? restoreChanges(version, current, differences) : { changes: false, unlisted: false }, [version, current, differences, isCurrent]);
  const refusalText = !refusal ? '' : 'changedTo' in refusal ? t('ver.changedMeanwhile', { n: refusal.changedTo }) : refusal.error === 'conflict' ? t('ver.conflict') : libraryErrorText(refusal.error, t, lang);
  const shown = (field: Pick<VersionField, 'key' | 'value'>) => field.key === 'tag.target' ? t(`tag.target.${field.value}` as 'tag.target.base') : field.key === 'tag.source' ? t(`src.${field.value}` as 'src.danbooru') : field.value;

  const footer = confirm ? <>
    <span className="lib-ver-confirm" role="status"><Icon name="alert" size={14} />{t('ver.restoreAsk', { n: confirm.revision, next: confirm.expected + 1 })}</span>
    <Button onClick={() => setConfirm(null)} disabled={!!busy}>{t('c.cancel')}</Button>
    <Button ref={confirmRef} variant="primary" icon="refresh" busy={busy === 'restore'} onClick={() => void restore()} data-testid="version-restore-confirm">{t('ver.restore')}</Button>
  </> : <>
    <Button variant="ghost" onClick={onClose} disabled={!!busy}>{t('c.close')}</Button>
    {use && onUse && !current.archived && <Button icon={use === 'tray' ? 'combo' : 'canvas'} disabled={!version || !!busy} busy={busy === 'use'} onClick={() => void useVersion()} data-testid="version-use">{t(use === 'tray' ? 'ver.useTray' : 'ver.use')}</Button>}
    {canRestore && <Button variant="primary" icon="refresh" disabled={!version || isCurrent || !effect.changes || !!busy} title={isCurrent ? t('ver.isCurrent') : version && !effect.changes ? t('ver.same') : undefined}
      onClick={() => { if (chosen !== null) { setConfirm({ revision: chosen, expected: current.revision }); requestAnimationFrame(() => confirmRef.current?.focus()); } }} data-testid="version-restore">{t('ver.restore')}</Button>}
  </>;

  return <Dialog open onClose={onClose} busy={!!busy} icon="history" width={820} title={t('ver.title', { name: itemTitle(current) })}
    description={canRestore ? t('ver.desc') : t('ver.readOnly')} footer={footer}>
    <div className="lib-ver" data-testid="version-history">
      <ol className="lib-ver-list" aria-label={t('ver.list')}>
        {versionsQuery.isPending && <li className="lib-wait" role="status"><Spinner size={14} /> {t('c.loading')}</li>}
        {versionsQuery.error && <li className="lib-error" role="alert">{libraryErrorText(versionsQuery.error, t, lang)}</li>}
        {versions.map(entry => <li key={entry.revision}>
          <button type="button" className={clsx('lib-ver-row', chosen === entry.revision && 'is-on')} aria-pressed={chosen === entry.revision} onClick={() => setChosen(entry.revision)} data-testid={`version-${entry.revision}`}>
            <span className="lib-ver-n">{t('ver.n', { n: entry.revision })}{entry.revision === current.revision && <Tag tone="accent">{t('ver.current')}</Tag>}</span>
            <span className="ui-faint ui-num">{when(entry.updatedAt ?? entry.createdAt, lang)}</span>
            {entry.name && entry.name !== current.name && <span className="lib-ver-name">{entry.name}</span>}
          </button>
        </li>)}
      </ol>
      <div className="lib-ver-body">
        {versions.length === 1 && <p className="ui-muted">{t('ver.only')}</p>}
        {refusal && <p ref={refusalRef} tabIndex={-1} className="lib-error" role="alert" data-testid="version-refusal"><Icon name="alert" size={14} />{refusalText}</p>}
        {chosen !== null && !version && (versionQuery.error ? <p className="lib-error" role="alert">{libraryErrorText(versionQuery.error, t, lang)}</p> : <p className="lib-wait" role="status"><Spinner size={14} /> {t('c.loading')}</p>)}
        {version && <>
          <h3 className="lib-ver-h">{isCurrent ? t('ver.currentContent') : t('ver.contentOf', { n: version.revision })}</h3>
          {!isCurrent && <div className="lib-ver-summary" data-testid="version-summary">
            {restorable.length ? <p className="ui-muted">{t('ver.changed', { n: restorable.length })}</p> : differences.length === 0 && !effect.unlisted && <p className="ui-muted">{t('ver.same')}</p>}
            {kept.length > 0 && <p className="ui-muted">{t('ver.keptCount', { n: kept.length })}</p>}
            {effect.unlisted && <p className="ui-muted">{t('ver.unlisted')}</p>}
            {canRestore && !effect.changes && <p className="ui-muted" data-testid="version-restore-same">{t('ver.restoreSame')}</p>}
          </div>}
          <dl className="lib-ver-fields">
            {fields.map(field => <VersionRow key={field.key} t={t} label={t(field.label)} value={shown(field)} mono={field.mono} kept={canRestore && !field.restores} current={changed.has(field.key) ? shown({ key: field.key, value: changed.get(field.key)!.current }) : undefined} />)}
            {differences.filter(difference => !fields.some(field => field.key === difference.key)).map(difference => <VersionRow key={difference.key} t={t} label={t(difference.label)} value="" mono={difference.mono} kept={canRestore && !difference.restores} current={shown({ key: difference.key, value: difference.current })} />)}
          </dl>
        </>}
      </div>
    </div>
  </Dialog>;
}

/** One field of a version; a differing one shows the current value and, when a restore keeps it (kept), says so. */
function VersionRow({ t, label, value, current, mono, kept }: { t: UiText; label: string; value: string; current?: string; mono?: boolean; kept?: boolean }) {
  const differs = current !== undefined;
  return <div className={clsx('lib-ver-field', differs && (kept ? 'is-kept' : 'is-changed'))} data-kept={differs && kept ? 'true' : undefined}>
    <dt>{label}{differs && (kept ? <Tag>{t('ver.notRestored')}</Tag> : <Tag tone="warn">{t('ver.differs')}</Tag>)}</dt>
    <dd className={clsx(mono && 'ui-mono')}>{value || <span className="ui-faint">{t('ver.empty')}</span>}</dd>
    {current !== undefined && <dd className={clsx('lib-ver-now', mono && 'ui-mono')}><span className="ui-faint">{t('ver.now')}</span> {current || <span className="ui-faint">{t('ver.empty')}</span>}</dd>}
  </div>;
}
