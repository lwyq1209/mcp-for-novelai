import { useEffect, useState } from 'react';
import { BrandMark, Button, Dialog, Spinner, Toggle } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { plainErrorMessage } from '../../host-errors/bridge';
import { useAppStore } from '../../store';
import { APP_NAME, APP_VERSION, PROJECT_HOMEPAGE_URL, UPSTREAM_REPOSITORY_URL, type UpdateInfo } from '../../types';
import { InlineNote, SettingsGroup, SettingsRow, isSettingsCapture, useSettingWriter, useSettings } from './common';
import { updateCheckMessage } from './logic';

/** NovelAI's own image generation docs (the old title bar's docs link). */
export const NOVELAI_DOCS_URL = 'https://docs.novelai.net/en/image/';
/** This project's README on its home page. */
export const PROJECT_README_URL = `${PROJECT_HOMEPAGE_URL}#readme`;
/** The home page without the scheme, as the prototype shows it. */
const homepageLabel = PROJECT_HOMEPAGE_URL.replace(/^https?:\/\//, '');

type LegalKind = 'license' | 'notices';

/** The app's LICENSE or THIRD_PARTY_NOTICES.md as shipped, in plain text, with loading and failure states. */
export function LegalDocumentDialog({ kind, onClose }: { kind: LegalKind | null; onClose(): void }) {
  const { t } = useUiText();
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    if (!kind) return;
    let current = true;
    setState({});
    window.naiDesktop.readLegalDocument(kind)
      .then(text => { if (current) setState({ text }); })
      .catch(error => { if (current) setState({ error: plainErrorMessage(error) }); });
    return () => { current = false; };
  }, [kind]);
  return <Dialog open={!!kind} onClose={onClose} width={720} title={t(kind === 'notices' ? 'set.ab.noticesTitle' : 'set.ab.licenseTitle')}
    footer={<Button variant="primary" onClick={onClose}>{t('c.close')}</Button>}>
    {state.text !== undefined ? <pre className="sp-legal" data-testid="legal-text">{state.text}</pre>
      : state.error ? <InlineNote tone="danger" icon="alert">{t('set.ab.legalFailed', { reason: state.error })}</InlineNote>
        : <div className="sp-line" role="status"><Spinner size={16} /><span>{t('c.loading')}</span></div>}
  </Dialog>;
}

/** Settings › About & updates (prototype 29). */
export function AboutSection() {
  const { t } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const updateInfo = useAppStore(state => state.updateInfo);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateInfo | null>(null);
  const [legal, setLegal] = useState<LegalKind | null>(null);
  const open = (url: string) => void window.naiDesktop.openExternal(url);

  // A manual check (the old UpdateCheckNow): whatever autoCheckUpdates says; the result shows in place.
  const check = async () => {
    if (isSettingsCapture()) return;
    setChecking(true);
    try { setResult(await useAppStore.getState().checkUpdate()); }
    catch (error) { setResult({ status: 'failed', hasUpdate: false, currentVersion: APP_VERSION, error: plainErrorMessage(error) }); }
    finally { setChecking(false); }
  };
  const message = updateCheckMessage(result);
  // The newer release to offer: the manual result, else the one the automatic checks announced.
  const available = result?.status === 'available' ? result : updateInfo?.hasUpdate ? updateInfo : null;

  return <section className="sp-section" data-testid="settings-about">
    <h2>{t('set.about')}</h2>
    <SettingsGroup>
      <div className="sp-about-hero">
        <BrandMark size={56} full />
        <div className="sp-grow"><h3>{APP_NAME}</h3><div className="sp-faint">{t('set.ab.version', { version: APP_VERSION })}</div></div>
        <Button icon="refresh" busy={checking} onClick={() => void check()} data-testid="update-check">{t(checking ? 'set.ab.checking' : 'set.ab.check')}</Button>
      </div>
      {message && message.tone !== 'accent' ? <div className="sp-gb sp-divided"><InlineNote tone={message.tone === 'danger' ? 'danger' : 'ok'} icon={message.tone === 'danger' ? 'alert' : 'check'} testId="update-result">{t(message.key, message.params)}</InlineNote></div> : null}
      {available?.latestVersion ? <SettingsRow className="sp-row--update" label={t('set.ab.available', { version: available.latestVersion })} hint={t('set.ab.availableHint')}>
        <Button variant="primary" icon="external" disabled={!available.releaseUrl} onClick={() => { if (available.releaseUrl) open(available.releaseUrl); }} data-testid="update-download">{t('set.ab.download')}</Button>
      </SettingsRow> : null}
      {settings ? <SettingsRow label={t('set.ab.auto')} hint={t('set.ab.autoHint')}>
        <Toggle checked={settings.autoCheckUpdates !== false} label={t('set.ab.auto')} onChange={value => void update('autoCheckUpdates', value)} />
      </SettingsRow> : null}
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow label={t('set.ab.home')} hint={homepageLabel}>
        <Button icon="external" onClick={() => open(PROJECT_HOMEPAGE_URL)} data-testid="open-homepage">{t('set.open')}</Button>
      </SettingsRow>
      <SettingsRow label={t('set.ab.docs')}>
        <Button icon="external" onClick={() => open(PROJECT_README_URL)} data-testid="open-readme">{t('set.ab.readme')}</Button>
        <Button icon="external" onClick={() => open(NOVELAI_DOCS_URL)} data-testid="open-nai-docs">{t('set.ab.naiDocs')}</Button>
      </SettingsRow>
      <SettingsRow label={t('set.ab.license')} hint={t('set.ab.licenseHint')}>
        <Button onClick={() => setLegal('license')} data-testid="open-license">{t('set.ab.viewLicense')}</Button>
        <Button onClick={() => setLegal('notices')} data-testid="open-notices">{t('set.ab.notices')}</Button>
      </SettingsRow>
      <SettingsRow label={t('set.ab.credit')} hint={t('set.ab.trademark')}>
        <Button icon="external" onClick={() => open(UPSTREAM_REPOSITORY_URL)} data-testid="open-upstream">{t('set.ab.upstream')}</Button>
      </SettingsRow>
      <SettingsRow label={t('set.ab.setup')}>
        <Button icon="sparkle" onClick={() => useAppStore.getState().setShowOnboarding(true)} data-testid="rerun-setup">{t('set.ab.setup')}</Button>
      </SettingsRow>
    </SettingsGroup>
    <LegalDocumentDialog kind={legal} onClose={() => setLegal(null)} />
  </section>;
}
