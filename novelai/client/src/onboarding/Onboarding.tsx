import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { BrandMark, Button, Icon, Spinner, type IconName } from '../ui';
import { useUiText, type UiLang } from '../ui/i18n';
import { plainErrorMessage } from '../host-errors/bridge';
import { useAppStore } from '../store';
import { agentClientLabel } from '../agent-clients';
import { navigate } from '../shell/route';
import type { CaptureRequest } from '../shell/capture';
import { PROJECT_HOMEPAGE_URL, type McpClientId } from '../types';
import { TokenForm, ProxyControl } from '../settings/sections/AccountSection';
import { OutputFolderField } from '../settings/sections/StorageSection';
import { AgentConnect } from '../settings/mcp/AgentConnect';
import { useAgentActivity, useMcpAccess, useNow } from '../settings/mcp/hooks';
import { callSince, clientTileOf, previousClient, relativeWhen } from '../settings/mcp/model';
import '../settings/settings.css';
import '../settings/mcp/mcp.css';
import './onboarding.css';
import { WindowControls } from '../shell/WindowControls';

export type OnboardingStep = 1 | 2 | 3;
/** The step a capture name opens (onboarding-2-connected → 2). */
export const captureStep = (capture: CaptureRequest | null): OnboardingStep => {
  const match = capture ? /^onboarding-([123])/.exec(capture.page) : null;
  return match ? Number(match[1]) as OnboardingStep : 1;
};

/**
 * The first-run guide (step 4b2, prototype 30–33), full window above the frame: connect NovelAI (the token, with the
 * proxy under 「连不上？」) → connect an agent (pick, copy, then wait for its first call, seen in the recent agent
 * calls; or do it later) → done (where images are saved). Skip and the last step mark the guide done (completeSetup),
 * so it does not open again; Settings › About runs it again.
 */
/** Marks the guide done and closes it (skip, finish, the error card's skip); opens the library when asked. */
export async function completeGuide(capture: CaptureRequest | null, openLibrary: boolean) {
  if (!capture) { await window.naiDesktop.completeSetup(); await useAppStore.getState().load(); }
  useAppStore.getState().setShowOnboarding(false);
  if (openLibrary) navigate('library');
}

/**
 * The guide's error card (second rework, P2), shown by the shell's boundary under the top bar: retry the guide, skip
 * it (as 跳过: marked done, then the library; Settings › About runs it again) or copy the error. Its text names only
 * these ways out.
 */
export function OnboardingFailure({ error, retry, copy }: { error: Error; retry: () => void; copy: () => void }) {
  const { t } = useUiText();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const skip = async () => {
    if (busy) return;
    setBusy(true); setFailed('');
    try { await completeGuide(null, true); }
    catch (failure) { setFailed(t('onb.finishFailed', { reason: plainErrorMessage(failure) })); setBusy(false); }
  };
  return <section className="app-error-boundary" role="alert" data-testid="onboarding-error-card">
    <strong>{t('onb.err.title')}</strong>
    <p>{t('onb.err.note')}</p>
    <code>{plainErrorMessage(error)}</code>
    <div>
      <button type="button" onClick={retry} disabled={busy} data-testid="onboarding-error-retry">{t('onb.err.retry')}</button>
      <button type="button" onClick={() => void skip()} disabled={busy} data-testid="onboarding-error-skip">{t('onb.err.skip')}</button>
      <button type="button" onClick={copy} data-testid="onboarding-error-copy">{t('onb.err.copy')}</button>
    </div>
    {failed ? <p role="status" data-testid="onboarding-error-failed">{failed}</p> : null}
  </section>;
}

export function Onboarding({ capture = null }: { capture?: CaptureRequest | null }) {
  const { t } = useUiText();
  const [step, setStep] = useState<OnboardingStep>(() => captureStep(capture));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const finish = async (openLibrary: boolean) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await completeGuide(capture, openLibrary);
    } catch (failure) { setError(t('onb.finishFailed', { reason: plainErrorMessage(failure) })); }
    finally { setBusy(false); }
  };
  return <div className="ui-scope ob-root" role="dialog" aria-modal="true" aria-label={t('onb.label')} data-testid="onboarding" data-step={step}>
    <header className="ob-top">
      <div className="ob-brand"><BrandMark size={18} /><span>{t('app.name')}</span></div>
      <Steps step={step} />
      <div className="ob-top-right">
        <LanguageSwitch capture={!!capture} />
        <button type="button" className="ob-skip" onClick={() => void finish(false)} disabled={busy} data-testid="onboarding-skip">{t('onb.skip')}</button>
        <WindowControls />
      </div>
    </header>
    <main className="ob-main">
      <div className="ob-body">
        {step === 1 ? <StepConnect onNext={() => setStep(2)} />
          : step === 2 ? <StepAgent capture={capture} onBack={() => setStep(1)} onNext={() => setStep(3)} />
          : <StepDone busy={busy} onBack={() => setStep(2)} onFinish={() => void finish(true)} />}
        {error ? <p className="ob-error" role="alert">{error}</p> : null}
      </div>
    </main>
  </div>;
}

function Steps({ step }: { step: OnboardingStep }) {
  const { t } = useUiText();
  const names = [t('onb.s1'), t('onb.s2'), t('onb.s3')];
  return <ol className="ob-steps" aria-label={t('onb.steps')}>
    {names.map((name, index) => {
      const number = (index + 1) as OnboardingStep, done = number < step, current = number === step;
      return <li key={name} className={clsx('ob-step', done && 'is-done', current && 'is-on')} aria-current={current ? 'step' : undefined}>
        {index > 0 ? <i className="ob-step-line" aria-hidden="true" /> : null}
        <span className="ob-step-num" aria-hidden="true">{done ? <Icon name="check" size={13} /> : number}</span>
        <span className="ob-step-name">{done ? <span className="ui-sr-only">{t('onb.stepDone', { name })}</span> : null}<span aria-hidden={done || undefined}>{name}</span></span>
      </li>;
    })}
  </ol>;
}

function LanguageSwitch({ capture }: { capture: boolean }) {
  const { t, lang } = useUiText();
  const set = async (next: UiLang) => {
    if (next === lang) return;
    const code = next === 'zh' ? 'zh-CN' : 'en-US';
    if (capture) { useAppStore.setState(state => ({ settings: state.settings ? { ...state.settings, language: code } : state.settings })); return; }
    await window.naiDesktop.setSetting('language', code);
    await useAppStore.getState().refreshSettings();
  };
  return <div className="as-langsw ob-langsw" role="group" aria-label={t('top.lang')}>
    {(['zh', 'en'] as const).map(value => <button key={value} type="button" aria-pressed={lang === value} className={clsx(lang === value && 'is-on')} onClick={() => void set(value)} lang={value === 'zh' ? 'zh-CN' : 'en'}>{t(value === 'zh' ? 'top.langZh' : 'top.langEn')}</button>)}
  </div>;
}

function StepConnect({ onNext }: { onNext(): void }) {
  const { t } = useUiText();
  const hasToken = useAppStore(state => state.account.hasToken);
  const [proxy, setProxy] = useState(false);
  return <section className="ob-step-body" data-testid="onboarding-step-1">
    <div className="ob-hero">
      <span className="ob-hero-mark"><BrandMark size={34} /></span>
      <div><span className="ob-kicker">{t('onb.welcome')}</span><h1>{t('onb.t1')}</h1></div>
    </div>
    <p className="ob-desc">{t('onb.d1')}</p>
    <div className="ob-card">
      {/* The proxy link shares the row of How to get a token (prototype 30). */}
      <TokenForm layout="guide" links={<Button variant="ghost" size="sm" icon="globe" aria-expanded={proxy} onClick={() => setProxy(value => !value)} data-testid="onboarding-proxy">{t(proxy ? 'onb.netHide' : 'onb.net')}</Button>} />
      {proxy ? <div className="ob-proxy"><ProxyControl /></div> : null}
    </div>
    <footer className="ob-foot">
      <button type="button" className="ob-link" onClick={() => void window.naiDesktop.openExternal(PROJECT_HOMEPAGE_URL)}><Icon name="external" size={14} />{t('onb.home')}</button>
      <span className="ob-gap" />
      {!hasToken ? <Button variant="ghost" onClick={onNext} data-testid="onboarding-later-1">{t('onb.later1')}</Button> : null}
      <Button variant="primary" size="lg" iconAfter="right" disabled={!hasToken} onClick={onNext} data-testid="onboarding-next">{t('onb.next')}</Button>
    </footer>
  </section>;
}

function StepAgent({ capture, onBack, onNext }: { capture: CaptureRequest | null; onBack(): void; onNext(): void }) {
  const { t, lang } = useUiText();
  const access = useMcpAccess(true);
  const activity = useAgentActivity(true, capture);
  const now = useNow(true, 15_000);
  // A call counts once it comes after this step opened (the guide waits for a new call, not an old one).
  const opened = useRef(capture ? Date.now() - 1 : Date.now());
  const call = callSince(activity, opened.current);
  const before = call ? null : previousClient(activity);
  const [client, setClient] = useState<McpClientId | null>(null);
  // Once an agent calls, the picker shows that agent (review rework 4b2), whatever was picked before.
  const callTile = clientTileOf(call?.client?.name);
  useEffect(() => { if (callTile) setClient(callTile); }, [callTile]);
  const picked = client ?? callTile ?? clientTileOf(before?.client?.name) ?? 'claude';
  return <section className="ob-step-body" data-testid="onboarding-step-2">
    <h1>{t('onb.t2')}</h1>
    <p className="ob-desc">{t('onb.d2')}</p>
    <div className="ob-card">
      {access.info ? <AgentConnect info={access.info} client={picked} onClient={setClient} showTry={false} />
        : access.failed ? <p className="ob-error" role="alert">{t('mcp.loadFailed')}</p>
        : <div className="mc-loading" role="status"><Spinner size={16} /><span>{t('mcp.loading')}</span></div>}
      <div className={clsx('mc-wait', call && 'is-on')} role="status" data-testid={call ? 'onboarding-connected' : 'onboarding-waiting'}>
        {call ? <><Icon name="check" size={16} /><span>{call.tool ? t('onb.connected', { name: agentClientLabel(call.client), tool: call.tool }) : t('onb.connectedNoTool', { name: agentClientLabel(call.client) })}</span></>
          : <><Spinner size={18} /><span>{t('onb.waiting')}</span></>}
      </div>
      {before ? <p className="mc-before">{t('onb.before', { name: agentClientLabel(before.client), when: relativeWhen(before.lastSeenAt, lang, now) })}</p> : null}
    </div>
    <footer className="ob-foot">
      <Button variant="ghost" icon="left" onClick={onBack}>{t('onb.prev')}</Button>
      <span className="ob-gap" />
      <Button variant="ghost" onClick={onNext} data-testid="onboarding-later-2">{t('onb.later2')}</Button>
      <Button variant="primary" size="lg" iconAfter="right" disabled={!call && !before} onClick={onNext} data-testid="onboarding-next">{t('onb.next')}</Button>
    </footer>
  </section>;
}

const TIPS: Array<{ icon: IconName; key: 'onb.tip1' | 'onb.tip2' | 'onb.tip3' }> = [{ icon: 'agent', key: 'onb.tip1' }, { icon: 'queue', key: 'onb.tip2' }, { icon: 'restore', key: 'onb.tip3' }];
function StepDone({ busy, onBack, onFinish }: { busy: boolean; onBack(): void; onFinish(): void }) {
  const { t } = useUiText();
  return <section className="ob-step-body" data-testid="onboarding-step-3">
    <div className="ob-hero">
      <span className="ob-hero-mark is-ok"><Icon name="check" size={28} /></span>
      <h1>{t('onb.t3')}</h1>
    </div>
    <p className="ob-desc">{t('onb.d3')}</p>
    <div className="ob-card"><span className="ob-label">{t('onb.output')}</span><OutputFolderField layout="guide" /></div>
    <ul className="ob-tips">{TIPS.map(tip => <li key={tip.key}><Icon name={tip.icon} size={16} /><span>{t(tip.key)}</span></li>)}</ul>
    <footer className="ob-foot">
      <Button variant="ghost" icon="left" onClick={onBack}>{t('onb.prev')}</Button>
      <span className="ob-gap" />
      <Button variant="primary" size="lg" icon="library" busy={busy} onClick={onFinish} data-testid="onboarding-finish">{t('onb.openLib')}</Button>
    </footer>
  </section>;
}
