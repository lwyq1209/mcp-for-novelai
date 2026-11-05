import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Button, ConfirmDialog, Disclosure, Field, Icon, Progress, Seg, Toggle, showToast } from '../../ui';
import { formatNumber, useUiText, type UiText } from '../../ui/i18n';
import { hostMessageText } from '../../host-errors/compose';
import { useAppStore } from '../../store';
import type { AccountSummary, TokenStatus } from '../../types';
import { CommitInput, InlineNote, SettingsBlock, SettingsGroup, SettingsRow, isSettingsCapture, saveSetting, settingErrorText, useSettingWriter, useSettings } from './common';
import { credentialIssueKinds, opusAllowance, proxyCurrent, proxyPresetFor, proxyUrlFor, PROXY_MODES, type ProxyMode } from './logic';

const NOVELAI_IMAGE_URL = 'https://novelai.net/image';
/** A capture run shows a sample token (prototype 24) instead of reading the saved one. */
const CAPTURE_TOKEN = 'pst-capture-sample-token-0000000000003f9a';

/** "Connected · Opus · 8,240 Anlas" for an account or a verification result. */
export function connectedText(t: UiText, lang: 'zh' | 'en', account: Pick<AccountSummary, 'tierName' | 'anlasBalance'>) {
  return t('set.acc.connected', { tier: account.tierName || 'NovelAI', n: typeof account.anlasBalance === 'number' ? formatNumber(account.anlasBalance, lang) : '—' });
}

/** The connection card: connected (tier, Anlas, Opus allowance, stale balance) or not connected. */
export function AccountStatus() {
  const { t, lang } = useUiText();
  const account = useAppStore(state => state.account);
  const [refreshing, setRefreshing] = useState(false);
  const allowance = account.tierLevel === 3 ? opusAllowance(account.opusUsage) : null;
  const refresh = async () => {
    if (isSettingsCapture()) return;
    setRefreshing(true);
    try { await useAppStore.getState().refreshAccount(); } finally { setRefreshing(false); }
  };
  if (!account.hasToken) {
    return <div className="sp-status" data-testid="account-status" data-state="off">
      <div className="sp-status-icon is-off"><Icon name="unlock" size={20} /></div>
      <div className="sp-status-text"><b>{t('set.acc.notConnected')}</b><span>{t('set.acc.notConnectedHint')}</span></div>
    </div>;
  }
  return <div className="sp-status" data-testid="account-status" data-state="on">
    <div className={clsx('sp-status-icon', account.stale && 'is-warn')}><Icon name={account.stale ? 'alert' : 'check'} size={20} /></div>
    <div className="sp-status-text">
      <b>{connectedText(t, lang, account)}</b>
      {account.stale ? <span className="sp-warn-text">{t('set.acc.stale')}</span> : null}
      {account.tierLevel === 3 ? allowance ? <>
        <span>{t('set.acc.opus', { percent: formatNumber(allowance.remaining, lang), images: formatNumber(allowance.images, lang) })}</span>
        <Progress value={allowance.remaining / 100} tone="accent" label={t('set.acc.opusLabel')} className="sp-usage" />
        {allowance.refill !== null ? <span className="sp-faint">{t('set.acc.opusRefill', { percent: formatNumber(allowance.refill, lang), images: formatNumber(allowance.refillImages ?? 0, lang) })}</span> : null}
        {allowance.empty ? <span className="sp-warn-text">{t('set.acc.opusEmpty')}</span> : null}
      </> : <span className="sp-faint">{t('set.acc.opusUnavailable')}</span> : null}
    </div>
    <Button size="sm" variant="ghost" icon="refresh" busy={refreshing} onClick={() => void refresh()}>{t('set.acc.refreshBalance')}</Button>
  </div>;
}

/** The token steps (the old token guide): four steps, the warning and a link to NovelAI. */
export function TokenGuide() {
  const { t } = useUiText();
  return <div className="sp-guide" data-testid="token-guide">
    <ol className="sp-steps">
      {(['set.acc.how1', 'set.acc.how2', 'set.acc.how3', 'set.acc.how4'] as const).map(key => <li key={key}>{t(key)}</li>)}
    </ol>
    <InlineNote tone="warn" icon="lock">{t('set.acc.howWarn')}</InlineNote>
    <div><Button size="sm" icon="external" onClick={() => void window.naiDesktop.openExternal(NOVELAI_IMAGE_URL)}>{t('set.acc.openNovelai')}</Button></div>
  </div>;
}

export interface TokenFormProps {
  /** page: the account section (show/hide beside the field, remove token). guide: the first-run guide (prototype 30). */
  layout?: 'page' | 'guide';
  /** Called after a successful verification (the token is saved and the account refreshed). */
  onVerified?: (status: TokenStatus) => void;
  /** guide: more links on the row of How to get a token (the guide's proxy link, prototype 30). */
  links?: ReactNode;
}

/**
 * The NovelAI token: masked field (a saved token is filled in, as before, and can be shown), Verify & save (the
 * result in place, then the account is refreshed), How to get a token (steps in place) and, on the page, Remove token.
 */
export function TokenForm({ layout = 'page', onVerified, links }: TokenFormProps) {
  const { t, lang, language } = useUiText();
  const [token, setToken] = useState('');
  // The token saved when the form opened (or last verified), to say what a failed check leaves in use.
  const saved = useRef('');
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [keptOld, setKeptOld] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const hasToken = useAppStore(state => state.account.hasToken);
  const account = useAppStore(state => state.account);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (isSettingsCapture()) { setToken(CAPTURE_TOKEN); return; }
    // The saved token is filled in (masked) so it can be shown, checked again or replaced.
    // No token is "" (an older host answered undefined): the field is text either way.
    void window.naiDesktop.storedToken().then(value => { const text = typeof value === 'string' ? value : ''; saved.current = text; setToken(text); }).catch(() => undefined);
  }, []);

  const verify = async () => {
    if (!token.trim() || checking) return;
    if (isSettingsCapture()) return;
    setChecking(true);
    try {
      const result = await window.naiDesktop.verifyToken(token);
      if (!mounted.current) return;
      // A failed check saves nothing: a different saved token stays in use (verifyToken writes only a valid one).
      setKeptOld(!result.valid && !!saved.current && saved.current !== token.trim());
      if (result.valid) saved.current = token.trim();
      setStatus(result);
      await useAppStore.getState().refreshAccount();
      if (result.valid) onVerified?.(result);
    } catch (error) {
      if (mounted.current) setStatus({ valid: false, message: settingErrorText(error, language) });
    } finally {
      if (mounted.current) setChecking(false);
    }
  };

  const remove = async () => {
    setRemoving(true);
    try {
      if (!isSettingsCapture()) await window.naiDesktop.clearToken();
      setToken(''); setStatus(null); setKeptOld(false); saved.current = ''; setConfirmRemove(false);
      if (!isSettingsCapture()) await useAppStore.getState().refreshAccount();
      showToast({ message: t('set.acc.removed'), tone: 'ok' });
    } catch (error) {
      showToast({ message: settingErrorText(error, language), tone: 'danger' });
    } finally { setRemoving(false); }
  };

  const field = (id: string) => <input id={id} className={clsx('ui-input', 'sp-mono', 'sp-token-input')} type={visible ? 'text' : 'password'} value={token} autoComplete="off" spellCheck={false}
    placeholder={t('set.acc.tokenPlaceholder')} aria-label={t('set.acc.token')} data-testid="token-input"
    onChange={event => { setToken(event.target.value); setStatus(null); setKeptOld(false); }}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void verify(); } }} />;
  const showButton = <Button icon="eye" aria-label={t(visible ? 'set.acc.hideToken' : 'set.acc.showToken')} aria-pressed={visible} onClick={() => setVisible(value => !value)} data-testid="token-reveal">{t(visible ? 'set.acc.hide' : 'set.acc.show')}</Button>;
  const verifyButton = <Button variant="primary" icon="check" busy={checking} disabled={!token.trim()} onClick={() => void verify()} data-testid="token-verify">{t(checking ? 'set.acc.verifying' : 'set.acc.verify')}</Button>;
  const howButton = <Button variant="ghost" size={layout === 'guide' ? 'sm' : 'md'} icon="info" aria-expanded={howOpen} onClick={() => setHowOpen(value => !value)} data-testid="token-how">{t(howOpen ? 'set.acc.howHide' : 'set.acc.how')}</Button>;
  const result = status ? status.valid
    ? <div className="sp-okbar" role="status" data-testid="token-result"><Icon name="check" size={16} /><span>{connectedText(t, lang, status)}</span></div>
    : <InlineNote tone="danger" icon="alert" testId="token-result">{t('set.acc.verifyFailed', { reason: hostMessageText(status, language) })}{keptOld ? <><br /><span data-testid="token-kept-old">{t('set.acc.keptOld')}</span></> : null}</InlineNote>
    : null;

  if (layout === 'guide') {
    // A token saved before (the guide run again from About) shows as connected until it is checked again.
    const saved = !result && hasToken && token ? <div className="sp-okbar" role="status" data-testid="token-connected"><Icon name="check" size={16} /><span>{connectedText(t, lang, account)}</span></div> : null;
    return <div className="sp-token sp-token--guide" data-testid="token-form" data-layout="guide">
      <label className="ui-field__label" htmlFor="sp-token-guide">{t('set.acc.token')}</label>
      <div className="sp-line">{field('sp-token-guide')}{verifyButton}</div>
      {result ?? saved}
      <div className="sp-line">{howButton}{links}</div>
      {howOpen ? <TokenGuide /> : null}
    </div>;
  }
  return <div className="sp-token" data-testid="token-form" data-layout="page">
    <label className="ui-field__label" htmlFor="sp-token-page">{t('set.acc.token')}</label>
    <div className="sp-line">{field('sp-token-page')}{showButton}</div>
    <div className="sp-line">
      {verifyButton}{howButton}
      <span className="sp-grow" />
      {hasToken || token ? <Button variant="dangerGhost" onClick={() => setConfirmRemove(true)} data-testid="token-remove">{t('set.acc.remove')}</Button> : null}
    </div>
    {result}
    <span className="sp-faint">{t('set.acc.verifyHint')}</span>
    {howOpen ? <TokenGuide /> : null}
    <ConfirmDialog open={confirmRemove} tone="danger" icon="trash" title={t('set.acc.removeTitle')} description={t('set.acc.removeBody')}
      confirmLabel={t('set.acc.remove')} cancelLabel={t('c.cancel')} busy={removing} onCancel={() => setConfirmRemove(false)} onConfirm={() => void remove()} />
  </div>;
}

const PROXY_LABEL: Record<ProxyMode, 'set.net.auto' | 'set.net.http' | 'set.net.socks' | 'set.net.custom' | 'set.net.direct'> = {
  auto: 'set.net.auto', http: 'set.net.http', socks: 'set.net.socks', custom: 'set.net.custom', direct: 'set.net.direct',
};

/**
 * The proxy: five modes (System is the default; Local HTTP 127.0.0.1:7890; Local SOCKS5 127.0.0.1:10808; Custom with
 * an address; Off), and the current routing. Writes proxyMode and proxyUrl together, like the old control.
 */
export function ProxyControl() {
  const { t, language } = useUiText();
  const settings = useSettings();
  const mode = settings?.proxyMode ?? 'auto';
  const url = settings?.proxyUrl ?? '';
  const [preset, setPreset] = useState<ProxyMode>(() => proxyPresetFor(mode, url));
  const [custom, setCustom] = useState(url);
  const [error, setError] = useState('');
  useEffect(() => { setPreset(proxyPresetFor(mode, url)); setCustom(url); }, [mode, url]);

  const write = async (nextMode: ProxyMode, nextUrl: string) => {
    setError('');
    try { await saveSetting('proxyMode', nextMode); await saveSetting('proxyUrl', nextUrl); }
    catch (reason) { setError(settingErrorText(reason, language)); }
  };
  const select = (next: ProxyMode) => { setPreset(next); void write(next, proxyUrlFor(next, custom)); };
  const current = proxyCurrent(preset, preset === 'custom' ? custom : url);
  return <div className="sp-proxy" data-testid="proxy-control" data-mode={preset}>
    <Seg label={t('set.net.proxy')} value={preset} onChange={select} options={PROXY_MODES.map(value => ({ value, label: t(PROXY_LABEL[value]) }))} />
    {preset === 'custom' ? <Field label={t('set.net.customLabel')}>
      <input className="ui-input sp-mono" value={custom} placeholder={t('set.net.customPlaceholder')} data-testid="proxy-url"
        onChange={event => setCustom(event.target.value)} onBlur={() => { if (custom !== url || mode !== 'custom') void write('custom', custom); }}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
    </Field> : null}
    <div className={clsx('sp-current', (preset === 'auto' || preset === 'direct') && 'is-direct')} data-testid="proxy-current">
      <b>{t('set.net.current')}</b><code>{t(current.key, current.url ? { url: current.url } : undefined)}</code>
    </div>
    {error ? <InlineNote tone="danger" icon="alert">{error}</InlineNote> : null}
  </div>;
}

/** Settings › Account & network (prototype 24). */
export function AccountSection() {
  const { t } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const issues = credentialIssueKinds(settings?.credentialIssues);
  const direct = settings?.proxyMode === 'direct';
  return <section className="sp-section" data-testid="settings-account">
    <h2>{t('set.account')}</h2>
    {issues.locked ? <InlineNote tone="danger" icon="alert" testId="credential-locked">{t('set.acc.credLocked')}</InlineNote> : null}
    {issues.unsupported ? <InlineNote tone="danger" icon="alert" testId="credential-format">{t('set.acc.credFormat')}</InlineNote> : null}
    <SettingsGroup>
      <AccountStatus />
      <SettingsBlock className="sp-divided"><TokenForm layout="page" /></SettingsBlock>
    </SettingsGroup>
    {settings ? <SettingsGroup title={t('set.net.title')} icon="globe">
      <SettingsRow label={t('set.net.proxy')} tip={t('set.net.proxyHint')} />
      <SettingsBlock><ProxyControl /></SettingsBlock>
      <SettingsRow label={t('set.net.scope')} hint={t('set.net.scopeHint')} className={clsx('sp-divided', direct && 'is-disabled')}>
        <div className="sp-checks">
          <label className="sp-toggle-line"><Toggle checked={settings.proxyForNai} disabled={direct} label={t('set.net.forNai')} onChange={value => void update('proxyForNai', value)} /><span>{t('set.net.forNai')}</span></label>
          <label className="sp-toggle-line"><Toggle checked={settings.proxyForUpdate} disabled={direct} label={t('set.net.forUpdate')} onChange={value => void update('proxyForUpdate', value)} /><span>{t('set.net.forUpdate')}</span></label>
        </div>
      </SettingsRow>
      <Disclosure className="sp-disclosure" summary={<span>{t('set.net.endpoint')} · <span className="sp-faint">{t('set.net.endpointHint')}</span></span>}>
        <div className="sp-endpoints">
          <Field label={t('set.net.apiBase')}><CommitInput settingKey="apiBaseUrl" value={settings.apiBaseUrl} label={t('set.net.apiBase')} testId="endpoint-api" /></Field>
          <Field label={t('set.net.imageBase')}><CommitInput settingKey="imageBaseUrl" value={settings.imageBaseUrl} label={t('set.net.imageBase')} testId="endpoint-image" /></Field>
          <SettingsRow label={t('set.net.allowCustom')} hint={t('set.net.allowCustomHint')} className="sp-row--flat">
            <Toggle checked={settings.allowCustomEndpoint} label={t('set.net.allowCustom')} onChange={value => void update('allowCustomEndpoint', value)} />
          </SettingsRow>
          {settings.allowCustomEndpoint ? <SettingsRow label={t('set.net.fallback')} hint={t('set.net.fallbackHint')} className="sp-row--flat">
            <Toggle checked={settings.allowCustomEndpointFallback} label={t('set.net.fallback')} onChange={value => void update('allowCustomEndpointFallback', value)} />
          </SettingsRow> : null}
        </div>
      </Disclosure>
    </SettingsGroup> : null}
  </section>;
}

