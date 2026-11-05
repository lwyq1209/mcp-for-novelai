import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, TextArea, Toggle, showToast } from '../../ui';
import { formatBytes, useUiText } from '../../ui/i18n';
import { hostErrorText } from '../../host-errors';
import { openInLibrary } from '../../library/intent';
import { exportLibraryBackup, LIBRARY_BACKUP_MAX_BYTES, parseLibraryBackup, saveJsonFile } from '../../library/library-backup';
import { backupImportText, backupParseText, LibraryBackupImport } from '../../library/LibraryBackupImport';
import type { MaterialBackup } from '../../workspace/material-library-types';
import { useAppStore } from '../../store';
import type { McpAccessInfo } from '../../types';
import { BackupSettings } from './BackupSettings';
import { CommitInput, InlineNote, SettingsBlock, SettingsGroup, SettingsRow, isSettingsCapture, saveSetting, settingErrorText, useSettingWriter, useSettings } from './common';
import { logInfoLine, openFolderKey } from './logic';

/** The placeholders a file name may use (the host's image name template). */
export const IMAGE_NAME_PLACEHOLDERS = '{date} {time} {seq} {seed} {model} {type} {ts}';

export interface OutputFolderFieldProps {
  /** page: path (editable, Enter saves), Change and Open. guide: path and Change only (prototype 33). */
  layout?: 'page' | 'guide';
}

/** The output folder: its path (editable in place, as the old StorageDirectoryInput), Change (folder dialog) and Open. */
export function OutputFolderField({ layout = 'page' }: OutputFolderFieldProps) {
  const { t, language } = useUiText();
  const settings = useSettings();
  const outputDir = settings?.outputDir ?? '';
  const change = async () => {
    if (isSettingsCapture()) return;
    try { await window.naiDesktop.selectOutputDir(); await useAppStore.getState().refreshSettings(); }
    catch (error) { showToast({ message: settingErrorText(error, language), tone: 'danger' }); }
  };
  return <div className="sp-folder" data-testid="output-folder" data-layout={layout}>
    {/* The guide names the field itself (图片保存在, prototype 33); the input keeps its own label. */}
    {layout === 'page' ? <label className="ui-field__label">{t('set.st.output')}</label> : null}
    <div className="sp-pathline">
      <CommitInput settingKey="outputDir" value={outputDir} label={t('set.st.output')} testId="output-dir" />
      <Button onClick={() => void change()} data-testid="output-change">{t('set.change')}</Button>
      {layout === 'page' ? <Button icon="folder" disabled={!outputDir} onClick={() => void window.naiDesktop.openInExplorer(outputDir)}>{t('set.open')}</Button> : null}
    </div>
    {layout === 'page' ? <span className="sp-faint">{t('set.st.outputHint')}</span> : null}
  </div>;
}

/**
 * Library backup (the old material library's backup file): export as JSON, import as new entries. The check, the
 * preview of what a file holds (and which entries look like existing ones) and the import are the library page's own
 * (src/library/library-backup.ts, LibraryBackupImport; step 4c1), for a chosen file and for pasted JSON alike.
 */
function LibraryBackup() {
  const { t, language } = useUiText();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'' | 'export' | 'import'>('');
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, setPending] = useState<MaterialBackup | null>(null);
  const api = () => window.naiDesktop as unknown as Parameters<typeof exportLibraryBackup>[0];
  const exportLibrary = async () => {
    if (isSettingsCapture()) return;
    setBusy('export'); setNote(null);
    try {
      const { data, coversLeftOut } = await exportLibraryBackup(api());
      saveJsonFile(data, 'novelai-material-library.json');
      setNote({ text: [t('set.st.libExported'), coversLeftOut ? t('set.st.libCoversOut', { n: coversLeftOut }) : ''].filter(Boolean).join(' · '), ok: true });
    } catch (error) { setNote({ text: hostErrorText(error, language), ok: false }); }
    finally { setBusy(''); }
  };
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const importLibrary = async (chosen: File) => {
    if (chosen.size > LIBRARY_BACKUP_MAX_BYTES) { setNote({ text: t('set.st.libTooBig'), ok: false }); return; }
    importText(await chosen.text());
  };
  // A backup file chosen, or its JSON pasted (the old library's 粘贴素材库备份 JSON, review rework 4b2): checked, then
  // previewed (counts and likely duplicates) before anything is imported.
  const importText = (text: string) => {
    if (isSettingsCapture()) return;
    setNote(null);
    const parsed = parseLibraryBackup(text);
    if (!parsed.ok) { setNote({ text: backupParseText(parsed, t), ok: false }); return; }
    setPending(parsed.data);
  };
  return <>
    <SettingsRow label={t('set.st.libRow')} hint={t('set.st.libHint')}>
      <Button busy={busy === 'export'} onClick={() => void exportLibrary()} data-testid="library-export">{t('set.st.libExport')}</Button>
      <Button busy={busy === 'import'} onClick={() => file.current?.click()} data-testid="library-import">{t('set.st.libImport')}</Button>
      <input ref={file} type="file" accept="application/json,.json" hidden aria-label={t('set.st.libImport')}
        onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; if (chosen) void importLibrary(chosen); }} />
      <Button variant="ghost" aria-expanded={pasteOpen} onClick={() => setPasteOpen(value => !value)} data-testid="library-paste-toggle">{t('set.st.libPaste')}</Button>
    </SettingsRow>
    {pasteOpen ? <SettingsBlock>
      <TextArea className="sp-mono" aria-label={t('set.st.libPasteLabel')} placeholder={t('set.st.libPastePh')} value={pasted} rows={5} onChange={event => setPasted(event.target.value)} data-testid="library-paste" />
      <div className="sp-line"><Button disabled={!pasted.trim()} busy={busy === 'import'} onClick={() => importText(pasted)} data-testid="library-paste-import">{t('set.st.libPasteImport')}</Button></div>
    </SettingsBlock> : null}
    {note ? <SettingsBlock><InlineNote tone={note.ok ? 'ok' : 'danger'} icon={note.ok ? 'check' : 'alert'} testId="library-backup-note">{note.text}</InlineNote></SettingsBlock> : null}
    {pending ? <LibraryBackupImport api={api()} data={pending} onClose={() => setPending(null)}
      onDone={result => { setPending(null); setNote({ text: backupImportText(result, t, language), ok: !result.error }); if (!result.error) setPasted(''); }} /> : null}
  </>;
}

/** The data folder (where MCP for NovelAI keeps its data), read-only, with an open button named for the platform. */
function DataFolder() {
  const { t } = useUiText();
  const [info, setInfo] = useState<McpAccessInfo | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    window.naiDesktop.mcpAccess().then(value => { if (live) setInfo(value); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  const platform = info?.platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform);
  return <SettingsGroup testId="data-folder">
    <SettingsBlock>
      <label className="ui-field__label" htmlFor="sp-data-root">{t('set.st.data')}</label>
      <div className="sp-pathline">
        <input id="sp-data-root" className="ui-input sp-mono" readOnly value={info?.dataRoot ?? ''} data-testid="data-root" />
        <Button icon="folder" disabled={!info?.dataRoot} onClick={() => { if (info?.dataRoot) void window.naiDesktop.openInExplorer(info.dataRoot); }}>{t(openFolderKey(platform))}</Button>
      </div>
      {failed ? <InlineNote tone="danger" icon="alert">{t('set.st.dataFailed')}</InlineNote>
        : <span className="sp-faint">{t('set.st.dataHint')}{info?.customDataRoot ? ` ${t('set.st.dataCustom', { name: info.dataDirEnv || 'NOVELAI_DATA_DIR' })}` : ''}</span>}
    </SettingsBlock>
  </SettingsGroup>;
}

/** Logs (the old LogSettingsSection, every action kept): on/off, folder (edit, choose, reset), current file and size, open. */
export function LogSettings({ active = true }: { active?: boolean }) {
  const { t, lang, language } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const [info, setInfo] = useState<{ path: string; dir: string; exists: boolean; sizeBytes: number } | null>(null);
  const logDir = settings?.logDir ?? '';
  const enabled = settings?.loggingEnabled ?? true;
  const refresh = useCallback(() => { void window.naiDesktop.getLogInfo().then(setInfo).catch(() => undefined); }, []);
  useEffect(() => { if (active) refresh(); }, [active, refresh, logDir]);
  const choose = async () => {
    try {
      const dir = await window.naiDesktop.selectLogDir();
      if (dir && await update('logDir', dir)) showToast({ message: t('set.st.logMoved'), tone: 'ok' });
    } catch (error) { showToast({ message: settingErrorText(error, language), tone: 'danger' }); }
  };
  const open = async (which: 'file' | 'dir') => {
    const reply = await (which === 'file' ? window.naiDesktop.openLogFile() : window.naiDesktop.openLogDir()).catch(error => ({ ok: false, message: settingErrorText(error, language) }));
    // The host's reply renders in the interface language by its reason (step 4c1); an empty reply says which failed.
    if (!reply.ok) showToast({ message: reply.message ? settingErrorText(reply, language) : t(which === 'file' ? 'set.st.logFileFailed' : 'set.st.logDirFailed'), tone: 'danger' });
  };
  const toggle = async (value: boolean) => {
    try { await saveSetting('loggingEnabled', value); showToast({ message: t(value ? 'set.st.logEnabled' : 'set.st.logDisabled'), tone: 'ok' }); }
    catch (error) { showToast({ message: t('set.saveFailed', { reason: settingErrorText(error, language) }), tone: 'danger' }); }
  };
  const line = logInfoLine(info);
  return <SettingsGroup title={t('set.st.logs')} icon="note" testId="log-settings">
    <SettingsRow label={t('set.st.logOn')} hint={t('set.st.logOnHint')}>
      <Toggle checked={enabled} label={t('set.st.logOn')} onChange={value => void toggle(value)} />
    </SettingsRow>
    <SettingsBlock className="sp-divided">
      <label className="ui-field__label">{t('set.st.logDir')}</label>
      <CommitInput settingKey="logDir" value={logDir} label={t('set.st.logDir')} placeholder={t('set.st.logDirPh')} disabled={!enabled} testId="log-dir" />
      {line ? <span className="sp-faint sp-mono-line" data-testid="log-current">{t(line.key, { path: line.path, size: formatBytes(line.bytes, lang) })}</span> : null}
      <div className="sp-line">
        <Button icon="folder" onClick={() => void choose()}>{t('set.chooseFolder')}</Button>
        <Button icon="external" onClick={() => void open('file')}>{t('set.st.logOpenFile')}</Button>
        <Button icon="external" onClick={() => void open('dir')}>{t('set.st.logOpenDir')}</Button>
        {logDir ? <Button variant="ghost" icon="undo" onClick={() => void update('logDir', '')} data-testid="log-reset">{t('set.resetDefault')}</Button> : null}
      </div>
    </SettingsBlock>
  </SettingsGroup>;
}

/** Settings › Storage & backup (prototype 27). */
export function StorageSection({ active = true }: { active?: boolean }) {
  const { t } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  return <section className="sp-section" data-testid="settings-storage">
    <h2>{t('set.storage')}</h2>
    {settings ? <SettingsGroup>
      <SettingsBlock>
        <OutputFolderField layout="page" />
        <div className="sp-folder">
          <label className="ui-field__label">{t('set.st.names')}</label>
          <CommitInput settingKey="imageNameTemplate" value={settings.imageNameTemplate} label={t('set.st.names')} placeholder="{date}_{seq}_{model}" testId="name-template" />
          <span className="sp-faint">{t('set.st.namesHint', { list: IMAGE_NAME_PLACEHOLDERS })}</span>
        </div>
      </SettingsBlock>
      <SettingsRow label={t('set.st.meta')} hint={t('set.st.metaHint')} className="sp-divided">
        <Toggle checked={settings.keepImageMetadata ?? true} label={t('set.st.meta')} onChange={value => void update('keepImageMetadata', value)} />
      </SettingsRow>
    </SettingsGroup> : null}
    <BackupSettings active={active} />
    <SettingsGroup title={t('set.st.lib')} icon="library" testId="library-backup">
      <LibraryBackup />
      <SettingsRow label={t('set.st.trash')}>
        <Button icon="trash" onClick={() => openInLibrary({ view: { type: 'trash' } })} data-testid="open-trash">{t('set.st.trashOpen')}</Button>
      </SettingsRow>
    </SettingsGroup>
    <DataFolder />
    <LogSettings active={active} />
  </section>;
}
