import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, ConfirmDialog, Dialog, Toggle } from '../../ui';
import { formatBytes, formatWhen, useUiText } from '../../ui/i18n';
import type { UiStringKey } from '../../ui/strings';
import { hostMessageText } from '../../host-errors/compose';
import { useAppStore } from '../../store';
import type { DataBackupCategory, DataBackupInspectResult, DataBackupStatus } from '../../types';
import { DEFAULT_DATA_BACKUP_CATEGORIES, initialImportConfirmationStage, integrityReasonsForSelection, requiresCredentialExportConfirmation, withMergedCounts } from '../../features/settings/data-backup';
import { collectPortableWorkspaceData, mergePortableWorkspaceData } from '../../features/settings/data-backup-workspace';
import { InlineNote, NumberField, SettingsBlock, SettingsGroup, SettingsRow, isSettingsCapture, settingErrorText, useSettingWriter, useSettings } from './common';
import { BACKUP_CATEGORIES, importStageAfter, type ConfirmStage } from './logic';

const CATEGORY_LABEL = Object.fromEntries(BACKUP_CATEGORIES.map(category => [category, `set.st.cat.${category}`])) as Record<DataBackupCategory, UiStringKey>;

/** A host result as a note: its text in the interface language, red when it did not complete. */
type Result = { text: string; ok: boolean; from?: 'export' | 'import' } | null;

function CategoryList({ available, selected, onChange, summaries }: { available: readonly DataBackupCategory[]; selected: Set<DataBackupCategory>; onChange(next: Set<DataBackupCategory>): void; summaries?: DataBackupInspectResult['categories'] }) {
  const { t, lang } = useUiText();
  const sizes = new Map(summaries?.map(item => [item.category, item]));
  return <div className="sp-cats" data-testid="backup-categories">
    {available.map(category => {
      const info = sizes.get(category);
      const toggle = (on: boolean) => { const next = new Set(selected); if (on) next.add(category); else next.delete(category); onChange(next); };
      return <label key={category} className="sp-cat">
        <Checkbox checked={selected.has(category)} label={t(CATEGORY_LABEL[category])} onChange={toggle} />
        <span className="sp-cat-name">{t(CATEGORY_LABEL[category])}</span>
        {info ? <span className="sp-faint">{t('set.st.catSize', { n: info.items, size: formatBytes(info.bytes, lang) })}</span> : null}
      </label>;
    })}
  </div>;
}

/**
 * Export & restore (the old DataPortabilitySettings, every step kept): an export with category choice (API credentials
 * left out by default, a second confirmation when they are chosen), and a restore that inspects the archive first, then
 * asks to accept an incomplete scope, to merge, and to replace settings when settings or credentials are chosen.
 */
export function useBackupPortability() {
  const { language } = useUiText();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSelection, setExportSelection] = useState<Set<DataBackupCategory>>(() => new Set(DEFAULT_DATA_BACKUP_CATEGORIES));
  const [archive, setArchive] = useState<DataBackupInspectResult | null>(null);
  const [importSelection, setImportSelection] = useState<Set<DataBackupCategory>>(() => new Set());
  const [stage, setStage] = useState<ConfirmStage>(0);
  const [degradedConfirmed, setDegradedConfirmed] = useState(false);
  const [busy, setBusy] = useState<'' | 'export' | 'inspect' | 'import'>('');
  const [result, setResult] = useState<Result>(null);
  const reasons = useMemo(() => integrityReasonsForSelection(archive?.integrityReasons, importSelection), [archive, importSelection]);

  const runExport = async (credentialConfirmed: boolean) => {
    if (!exportSelection.size) return;
    if (requiresCredentialExportConfirmation(exportSelection) && !credentialConfirmed) { setStage(3); return; }
    setStage(0); setBusy('export'); setResult(null);
    try {
      const reply = await window.naiDesktop.exportDataBackup({ categories: [...exportSelection], workspaceData: collectPortableWorkspaceData(), confirmApiCredentialsExport: credentialConfirmed });
      if (reply.cancelled) return;
      setResult({ text: hostMessageText(reply, language), ok: reply.ok, from: 'export' }); setExportOpen(false);
    } catch (error) { setResult({ text: settingErrorText(error, language), ok: false, from: 'export' }); }
    finally { setBusy(''); }
  };

  const chooseImport = async () => {
    if (isSettingsCapture()) return;
    setResult(null); setBusy('inspect');
    try {
      const reply = await window.naiDesktop.inspectDataBackup();
      if (!reply.ok) { if (!reply.cancelled) setResult({ text: hostMessageText(reply, language), ok: false, from: 'import' }); return; }
      setArchive(reply); setImportSelection(new Set(reply.categories.map(item => item.category))); setStage(0); setDegradedConfirmed(false);
    } catch (error) { setResult({ text: settingErrorText(error, language), ok: false, from: 'import' }); }
    finally { setBusy(''); }
  };

  const runImport = async (confirmConfigurationOverwrite: boolean) => {
    if (!archive?.path || !importSelection.size) return;
    setStage(0); setBusy('import');
    try {
      const reply = await window.naiDesktop.importDataBackup({ path: archive.path, categories: [...importSelection], confirmConfigurationOverwrite, confirmDegradedImport: degradedConfirmed, currentWorkspaceData: collectPortableWorkspaceData() });
      if (reply.workspaceData) {
        const merged = mergePortableWorkspaceData(reply.workspaceData);
        reply.imported += merged.imported; reply.skipped += merged.skipped;
      }
      setResult({ text: hostMessageText(withMergedCounts(reply), language), ok: reply.ok, from: 'import' });
      setArchive(null);
      if (reply.ok) {
        // Rehydrate only a committed import.
        await useAppStore.getState().load();
        window.dispatchEvent(new Event('novelai:reference-presets-changed'));
      }
    } catch (error) { setResult({ text: settingErrorText(error, language), ok: false, from: 'import' }); }
    finally { setBusy(''); }
  };

  /** The confirm button of the current stage. */
  const confirm = () => {
    if (stage === 3) { void runExport(true); return; }
    if (stage === 2) { void runImport(true); return; }
    if (stage === 4) setDegradedConfirmed(true);
    const next = importStageAfter(stage, importSelection);
    if (next === 'run') void runImport(false); else setStage(next);
  };
  const cancel = () => { if (stage === 4) setDegradedConfirmed(false); setStage(0); };
  const startImport = () => { setDegradedConfirmed(false); setStage(initialImportConfirmationStage(reasons.length > 0)); };
  return { exportOpen, setExportOpen, exportSelection, setExportSelection, archive, setArchive, importSelection, setImportSelection, stage, busy, result, reasons, runExport, chooseImport, confirm, cancel, startImport };
}

const STAGE_TEXT: Record<Exclude<ConfirmStage, 0>, { title: UiStringKey; body: UiStringKey; confirm: UiStringKey; tone: 'default' | 'danger' | 'warn' }> = {
  1: { title: 'set.st.mergeTitle', body: 'set.st.mergeBody', confirm: 'set.st.continue', tone: 'default' },
  2: { title: 'set.st.overwriteTitle', body: 'set.st.overwriteBody', confirm: 'set.st.overwriteDo', tone: 'danger' },
  3: { title: 'set.st.credTitle', body: 'set.st.credBody', confirm: 'set.st.credDo', tone: 'danger' },
  4: { title: 'set.st.degradedTitle', body: 'set.st.degradedBody', confirm: 'set.st.degradedDo', tone: 'warn' },
};

/** The dialogs of export & restore (rendered once by BackupSettings). */
function PortabilityDialogs({ state }: { state: ReturnType<typeof useBackupPortability> }) {
  const { t, lang, language } = useUiText();
  const { exportOpen, setExportOpen, exportSelection, setExportSelection, archive, setArchive, importSelection, setImportSelection, stage, busy, reasons } = state;
  const stageText = stage ? STAGE_TEXT[stage] : null;
  return <>
    <Dialog open={exportOpen && stage !== 3} onClose={() => setExportOpen(false)} title={t('set.st.exportTitle')} icon="download" busy={busy === 'export'} width={560}
      footer={<>
        <Button onClick={() => setExportOpen(false)} disabled={busy === 'export'}>{t('c.cancel')}</Button>
        <Button variant="primary" busy={busy === 'export'} disabled={!exportSelection.size} onClick={() => void state.runExport(false)} data-testid="backup-export-run">{t('set.st.exportDo')}</Button>
      </>}>
      <div className="sp-line"><Button size="sm" variant="ghost" onClick={() => setExportSelection(new Set(BACKUP_CATEGORIES))}>{t('set.st.selectAll')}</Button><Button size="sm" variant="ghost" onClick={() => setExportSelection(new Set())}>{t('set.st.selectNone')}</Button></div>
      <CategoryList available={BACKUP_CATEGORIES} selected={exportSelection} onChange={setExportSelection} />
      {!exportSelection.size ? <InlineNote tone="warn" icon="alert">{t('set.st.noCategory')}</InlineNote> : null}
      {exportSelection.has('apiCredentials') ? <InlineNote tone="warn" icon="lock">{t('set.st.sensitive')}</InlineNote> : null}
    </Dialog>
    <Dialog open={!!archive?.ok && stage === 0} onClose={() => setArchive(null)} title={t('set.st.importTitle')} icon="restore" busy={busy === 'import'} width={560}
      description={archive ? t('set.st.importDesc', { when: archive.createdAt ? formatWhen(archive.createdAt, lang) : '—', platform: archive.sourcePlatform ?? '—', version: archive.appVersion ?? '—' }) : undefined}
      footer={<>
        <Button onClick={() => setArchive(null)} disabled={busy === 'import'}>{t('c.cancel')}</Button>
        <Button variant="primary" busy={busy === 'import'} disabled={!importSelection.size} onClick={state.startImport} data-testid="backup-import-run">{t('set.st.importDo')}</Button>
      </>}>
      {archive ? <CategoryList available={archive.categories.map(item => item.category)} selected={importSelection} onChange={setImportSelection} summaries={archive.categories} /> : null}
      <InlineNote tone={reasons.length ? 'warn' : 'ok'} icon={reasons.length ? 'alert' : 'check'}>{t(reasons.length ? 'set.st.degraded' : 'set.st.complete')}</InlineNote>
      {reasons.length ? <ul className="sp-reasons">{reasons.map(reason => <li key={reason.code}>{hostMessageText(reason, language)}</li>)}</ul> : null}
      {!importSelection.size ? <InlineNote tone="warn" icon="alert">{t('set.st.noCategory')}</InlineNote> : null}
    </Dialog>
    <ConfirmDialog open={!!stageText} tone={stageText?.tone ?? 'default'} icon={stageText?.tone === 'default' ? 'restore' : 'alert'} title={stageText ? t(stageText.title) : ''} description={stageText ? t(stageText.body) : undefined}
      confirmLabel={stageText ? t(stageText.confirm) : ''} cancelLabel={t('c.cancel')} confirmVariant={stageText && stageText.tone !== 'default' ? 'danger' : 'primary'} onCancel={state.cancel} onConfirm={state.confirm}>
      {stage === 4 && reasons.length ? <ul className="sp-reasons">{reasons.map(reason => <li key={reason.code}>{hostMessageText(reason, language)}</li>)}</ul> : null}
    </ConfirmDialog>
  </>;
}

/** Automatic backup (the old BackupRestoreSettings) and export & restore (prototype 27). */
export function BackupSettings({ active = true }: { active?: boolean }) {
  const { t, lang, language } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const portability = useBackupPortability();
  const [status, setStatus] = useState<DataBackupStatus | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  const [autoResult, setAutoResult] = useState<Result>(null);
  const refresh = useCallback(() => { void window.naiDesktop.getDataBackupStatus().then(setStatus).catch(() => undefined); }, []);
  useEffect(() => { if (active) refresh(); }, [active, refresh, settings?.backupDir, settings?.autoBackupEnabled, settings?.autoBackupIntervalHours, settings?.autoBackupRetentionCount]);
  if (!settings) return null;

  const chooseDirectory = async () => {
    try {
      const selected = await window.naiDesktop.selectBackupDirectory();
      if (selected && await update('backupDir', selected)) { refresh(); setAutoResult(null); }
    } catch (error) { setAutoResult({ text: settingErrorText(error, language), ok: false }); }
  };
  const openDirectory = async () => {
    const reply = await window.naiDesktop.openBackupDirectory().catch(error => ({ ok: false, message: settingErrorText(error, language) }));
    if (!reply.ok) setAutoResult({ text: reply.message || t('set.openFailed'), ok: false });
  };
  const backupNow = async () => {
    if (isSettingsCapture()) return;
    setBackingUp(true);
    try {
      const reply = await window.naiDesktop.exportDataBackup({ categories: DEFAULT_DATA_BACKUP_CATEGORIES, workspaceData: collectPortableWorkspaceData(), destination: 'internal' });
      setAutoResult({ text: hostMessageText(reply, language), ok: reply.ok });
      refresh();
    } catch (error) { setAutoResult({ text: settingErrorText(error, language), ok: false }); }
    finally { setBackingUp(false); }
  };
  const last = status?.latestCreatedAt
    ? t('set.st.last', { when: formatWhen(status.latestCreatedAt, lang), n: status.backupCount, size: formatBytes(status.totalBytes, lang) })
    : t('set.st.lastNone');

  return <>
    <SettingsGroup title={t('set.st.backup')} icon="refresh" testId="auto-backup">
      <SettingsRow label={t('set.st.autoOn')} hint={<>{t('set.st.autoHint')}<br /><span data-testid="backup-last">{last}</span></>}>
        <Toggle checked={settings.autoBackupEnabled !== false} label={t('set.st.autoOn')} onChange={value => void update('autoBackupEnabled', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.st.interval')} hint={t('set.st.intervalHint')}>
        <NumberField value={settings.autoBackupIntervalHours ?? 24} min={1} max={720} label={t('set.st.interval')} unit={t('set.st.hours')} onCommit={value => void update('autoBackupIntervalHours', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.st.withImages')} hint={t('set.st.withImagesHint')}>
        <Toggle checked={settings.autoBackupIncludeImages === true} label={t('set.st.withImages')} onChange={value => void update('autoBackupIncludeImages', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.st.keep')} hint={t('set.st.keepHint')}>
        <NumberField value={settings.autoBackupRetentionCount ?? 7} min={1} max={100} label={t('set.st.keep')} unit={t('set.st.copies')} onCommit={value => void update('autoBackupRetentionCount', value)} />
      </SettingsRow>
      <SettingsBlock className="sp-divided">
        <label className="ui-field__label" htmlFor="sp-backup-dir">{t('set.st.dir')}</label>
        <div className="sp-pathline">
          <input id="sp-backup-dir" className="ui-input sp-mono" readOnly value={status?.directory ?? settings.backupDir ?? ''} data-testid="backup-dir" />
          <Button onClick={() => void chooseDirectory()}>{t('set.change')}</Button>
          <Button icon="folder" onClick={() => void openDirectory()}>{t('set.open')}</Button>
        </div>
        <div className="sp-line">
          <Button busy={backingUp} icon="archive" onClick={() => void backupNow()} data-testid="backup-now">{t('set.st.backupNow')}</Button>
          <Button variant="ghost" busy={portability.busy === 'inspect'} onClick={() => void portability.chooseImport()} data-testid="backup-restore">{t('set.st.restore')}</Button>
          <span className="sp-grow" />
          <Button variant="ghost" size="sm" icon="refresh" onClick={refresh}>{t('set.refresh')}</Button>
        </div>
        {autoResult ? <InlineNote tone={autoResult.ok ? 'ok' : 'danger'} icon={autoResult.ok ? 'check' : 'alert'}>{autoResult.text}</InlineNote> : null}
        {portability.result?.from === 'import' ? <InlineNote tone={portability.result.ok ? 'ok' : 'danger'} icon={portability.result.ok ? 'check' : 'alert'} testId="restore-result">{portability.result.text}</InlineNote> : null}
      </SettingsBlock>
    </SettingsGroup>
    <SettingsGroup title={t('set.st.manual')} icon="archive" testId="manual-backup">
      <SettingsRow label={t('set.st.manualRow')} hint={t('set.st.manualHint')}>
        <Button icon="download" onClick={() => portability.setExportOpen(true)} data-testid="backup-export">{t('set.st.export')}</Button>
      </SettingsRow>
      {portability.result?.from === 'export' ? <SettingsBlock><InlineNote tone={portability.result.ok ? 'ok' : 'danger'} icon={portability.result.ok ? 'check' : 'alert'} testId="backup-result">{portability.result.text}</InlineNote></SettingsBlock> : null}
    </SettingsGroup>
    <PortabilityDialogs state={portability} />
  </>;
}
