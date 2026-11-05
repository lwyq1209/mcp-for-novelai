import { useCallback, useEffect, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, TextInput, Tooltip, showToast, type IconName } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { hostErrorText } from '../../host-errors';
import { windowCaptureRequest } from '../../shell/capture';
import { useAppStore } from '../../store';
import type { AppSettings, SettingKey } from '../../types';
import { commitNumber } from './logic';

/** A capture run (shell/capture.ts) shows the page without writing settings or calling NovelAI. */
export const isSettingsCapture = () => !!windowCaptureRequest();

/** The text of a host refusal in the interface language (the host's own message when the catalog does not know it). */
export const settingErrorText = (error: unknown, language: unknown) => hostErrorText(error, language);

/**
 * Writes one setting and reloads the settings (the old dialog's update()). A refusal throws to the caller and is not
 * shown here; writeSetting shows it as a toast. In a capture run the value only changes in the window.
 */
export async function saveSetting<K extends SettingKey>(key: K, value: AppSettings[K]): Promise<void> {
  if (isSettingsCapture()) {
    useAppStore.setState(state => ({ settings: state.settings ? { ...state.settings, [key]: value } : state.settings }));
    return;
  }
  await window.naiDesktop.setSetting(key, value);
  await useAppStore.getState().refreshSettings();
}

/** update(key, value): saves a setting; a refusal is shown as a toast and the call resolves false. */
export function useSettingWriter() {
  const { t, language } = useUiText();
  return useCallback(async <K extends SettingKey>(key: K, value: AppSettings[K]): Promise<boolean> => {
    try { await saveSetting(key, value); return true; }
    catch (error) { showToast({ message: t('set.saveFailed', { reason: settingErrorText(error, language) }), tone: 'danger' }); return false; }
  }, [t, language]);
}

export function SettingsGroup({ title, icon, children, className, testId }: { title?: ReactNode; icon?: IconName; children: ReactNode; className?: string; testId?: string }) {
  return <div className={clsx('sp-group', className)} data-testid={testId}>
    {title ? <div className="sp-gh">{icon ? <Icon name={icon} size={15} /> : null}<span>{title}</span></div> : null}
    {children}
  </div>;
}

/** An ⓘ after a label whose detail shows on hover or focus (step 4c2: details that need not stay on screen). */
export function InfoTip({ content }: { content: ReactNode }) {
  return <Tooltip content={content}><span className="sp-tip" tabIndex={0} role="img" aria-label={typeof content === 'string' ? content : undefined}><Icon name="info" size={13} /></span></Tooltip>;
}

/** One row: label and hint on the left (tip: a detail on hover), the control on the right. */
export function SettingsRow({ label, hint, tip, children, className, id }: { label: ReactNode; hint?: ReactNode; tip?: ReactNode; children?: ReactNode; className?: string; id?: string }) {
  return <div className={clsx('sp-row', className)}>
    <div className="sp-row-l"><b id={id}>{label}{tip ? <InfoTip content={tip} /> : null}</b>{hint ? <span>{hint}</span> : null}</div>
    {children ? <div className="sp-row-c">{children}</div> : null}
  </div>;
}

/** A block of free content inside a group (fields, lists, notes). */
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx('sp-gb', className)}>{children}</div>;
}

/** An inline message under a control (role status, or alert for a failure). */
export function InlineNote({ tone = 'neutral', icon, children, testId }: { tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'; icon?: IconName; children: ReactNode; testId?: string }) {
  return <div className={clsx('sp-note', tone !== 'neutral' && `sp-note--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'} data-testid={testId}>
    {icon ? <Icon name={icon} size={14} /> : null}<span>{children}</span>
  </div>;
}

/**
 * A number committed on blur or Enter, rounded and clamped into [min, max] (the old CommittedNumberInput). Text that
 * is not a number reverts; Escape reverts.
 */
export function NumberField({ value, min, max, onCommit, label, unit, disabled, testId }: { value: number; min: number; max: number; onCommit(value: number): void; label: string; unit?: string; disabled?: boolean; testId?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = commitNumber(draft, min, max);
    if (next === null) { setDraft(String(value)); return; }
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };
  return <div className={clsx('sp-numbox', disabled && 'is-disabled')}>
    <TextInput inputMode="numeric" aria-label={label} value={draft} disabled={disabled} data-testid={testId}
      onChange={event => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') setDraft(String(value)); }} />
    {unit ? <span className="sp-unit">{unit}</span> : null}
  </div>;
}

/**
 * A text setting committed on blur or Enter, never per keystroke (a half-typed path or address is never saved). A
 * refusal keeps the text editable with the reason under it; Escape reverts.
 */
export function CommitInput({ settingKey, value, label, placeholder, disabled, mono = true, testId }: { settingKey: 'outputDir' | 'logDir' | 'imageNameTemplate' | 'apiBaseUrl' | 'imageBaseUrl' | 'proxyUrl'; value: string; label: string; placeholder?: string; disabled?: boolean; mono?: boolean; testId?: string }) {
  const { language } = useUiText();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value); setError(''); }, [value]);
  const save = async () => {
    if (busy || disabled || draft === value) return;
    setBusy(true); setError('');
    try { await saveSetting(settingKey, draft); }
    catch (reason) { setError(settingErrorText(reason, language)); }
    finally { setBusy(false); }
  };
  return <div className="sp-commit">
    <TextInput className={clsx(mono && 'sp-mono')} aria-label={label} value={draft} placeholder={placeholder} disabled={disabled} readOnly={busy} invalid={!!error} data-testid={testId}
      onChange={event => setDraft(event.target.value)} onBlur={() => void save()}
      onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { setDraft(value); setError(''); } }} />
    {error ? <div className="ui-field__error" role="alert"><Icon name="alert" size={12} />{error}</div> : null}
  </div>;
}

/** The current settings, or null before they are loaded. */
export const useSettings = () => useAppStore(state => state.settings);
