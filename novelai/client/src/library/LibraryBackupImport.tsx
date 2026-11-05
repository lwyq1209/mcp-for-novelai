import { useEffect, useState } from 'react';
import { invalidateAssetQueries } from '../asset-library/query';
import { hostErrorText } from '../host-errors';
import { Button, Dialog, Icon, Seg, Spinner } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import type { MaterialBackup } from '../workspace/material-library-types';
import { importLibraryBackup, previewLibraryBackup, readExistingMaterials, withoutEntries, type BackupImportResult, type BackupParse, type BackupPreview } from './library-backup';

type Api = Parameters<typeof readExistingMaterials>[0];

/** The text of a backup that cannot be imported (parseLibraryBackup's refusal): which entry or cover, never the validator's report. */
export function backupParseText(refusal: Extract<BackupParse, { ok: false }>, t: UiText): string {
  if (refusal.reason === 'too_big') return t('set.st.libTooBig');
  if (refusal.reason === 'bad_entry') return refusal.name ? t('mj.badEntryNamed', { n: refusal.n, name: refusal.name }) : t('mj.badEntry', { n: refusal.n });
  if (refusal.reason === 'bad_cover') return t('mj.badCover', { n: refusal.n });
  if (refusal.reason === 'too_many_covers') return t('mj.tooManyCovers');
  return t('set.st.libBadFile');
}

/** What an import did, in one line (the same words in Settings and the library). */
export function backupImportText(result: BackupImportResult, t: UiText, language: string): string {
  const head = result.error ? t('set.st.libPartial', { n: result.count, reason: hostErrorText(result.error, language) }) : t('set.st.libImported', { n: result.count });
  return [head, result.covers ? t('set.st.libCoversIn', { n: result.covers }) : ''].filter(Boolean).join(' · ');
}

export interface LibraryBackupImportProps {
  api: Api;
  /** A backup that passed parseLibraryBackup. */
  data: MaterialBackup;
  onClose(): void;
  /** After the import ran: what it did (also a partial import). */
  onDone(result: BackupImportResult): void;
}

/**
 * 导入素材 JSON (step 4c1): before anything is written, what the file holds (by kind, covers) and how many of its
 * entries have the kind, name and tag text of one already in the library; those can be left out. The import itself
 * is the host's (new entries, existing ones kept); importing past the library's limit is not offered.
 */
export function LibraryBackupImport({ api, data, onClose, onDone }: LibraryBackupImportProps) {
  const { t, language } = useUiText();
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [failure, setFailure] = useState('');
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    readExistingMaterials(api).then(existing => { if (live) setPreview(previewLibraryBackup(data, existing)); }, error => { if (live) setFailure(hostErrorText(error, language)); });
    return () => { live = false; };
  }, [data]);
  const leaveOut = preview && skip && preview.duplicates.length ? preview.duplicates : [];
  const count = preview ? preview.total - leaveOut.length : 0;
  const blocked = !preview || count === 0 || (leaveOut.length ? preview.overLimitWithout : preview.overLimit);
  const run = async () => {
    if (blocked || busy) return;
    setBusy(true);
    try {
      const result = await importLibraryBackup(api, leaveOut.length ? withoutEntries(data, leaveOut) : data);
      await invalidateAssetQueries();
      onDone(result);
    } catch (error) { setFailure(hostErrorText(error, language)); setBusy(false); }
  };
  return <Dialog open onClose={onClose} busy={busy} icon="upload" width={540} title={t('mj.importTitle')} description={t('set.st.libHint')}
    footer={<>
      <Button onClick={onClose} disabled={busy}>{t('c.cancel')}</Button>
      <Button variant="primary" icon="upload" busy={busy} disabled={blocked} onClick={() => void run()} data-testid="library-backup-import-run">{t('mj.importDo', { n: count })}</Button>
    </>}>
    <div className="lib-mj" data-testid="library-backup-preview">
      {!preview && !failure && <p className="lib-wait" role="status"><Spinner size={14} /> {t('mj.checking')}</p>}
      {failure && <p className="lib-error" role="alert"><Icon name="alert" size={14} />{failure}</p>}
      {preview && <>
        <p data-testid="library-backup-summary">{t('mj.summary', { n: preview.total, tags: preview.byKind.tag, combos: preview.byKind.combo, notes: preview.byKind.note })}{preview.covers ? ` · ${t('mj.covers', { n: preview.covers })}` : ''}</p>
        {preview.duplicates.length > 0 && <div className="lib-mj-dup" data-testid="library-backup-duplicates">
          <p><Icon name="alert" size={14} />{t('mj.duplicates', { n: preview.duplicates.length })}</p>
          <Seg<'skip' | 'all'> full label={t('mj.duplicates', { n: preview.duplicates.length })} value={skip ? 'skip' : 'all'} onChange={value => setSkip(value === 'skip')}
            options={[{ value: 'skip', label: t('mj.skipDup', { n: preview.duplicates.length }) }, { value: 'all', label: t('mj.importDup') }]} />
        </div>}
        {(leaveOut.length ? preview.overLimitWithout : preview.overLimit) && <p className="lib-error" role="alert" data-testid="library-backup-limit"><Icon name="alert" size={14} />{t('mj.overLimit', { n: preview.existing, max: 1000 })}</p>}
        {preview.total === 0 && <p className="ui-muted">{t('mj.empty')}</p>}
      </>}
    </div>
  </Dialog>;
}
