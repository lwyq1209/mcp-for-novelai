import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ToastHost, showToast } from '../ui';
import { useUiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { compactRemoteErrorText } from '../error-message';
import { createQueueMonitor, windowQueueMonitor } from '../workspace/queue-monitor';
import type { CaptureFixture } from '../library/capture-fixture';
import { hostCapture } from './capture';
import { AppErrorBoundary } from '../components/AppErrorBoundary';
import { LibraryPage } from '../library/LibraryPage';
import type { LibraryApi } from '../library/api';
import { TopBar } from './TopBar';
import { QueuePage } from '../queue/QueuePage';
import { SettingsPage } from '../settings/SettingsPage';
import { Onboarding, OnboardingFailure } from '../onboarding/Onboarding';
import { navigate, useShellRoute, type ShellPage, type ShellRoute } from './route';
import type { CaptureRequest } from './capture';
import './shell.css';

export interface AppShellProps {
  /** The existing canvas workspace: mounted from the start and kept mounted (its review dialog and canvases live there). */
  canvas: ReactNode;
  /** Dialogs and notices above every page (image save notices). */
  overlays?: ReactNode;
  libraryApi: LibraryApi;
  capture?: CaptureRequest | null;
}

/** The page a capture name opens (the library is the default; settings and the guide are handled below). */
const capturePage = (page: string): ShellPage | null => page === 'shell-canvas' ? 'canvas'
  : page === 'shell-queue' || page === 'queue' || page.startsWith('queue-') ? 'queue'
  : page === 'shell-settings' || page.startsWith('settings-') ? 'settings' : null;
/** The settings section a capture name opens (settings-mcp-codex → mcp; settings-about-update → about). */
const captureSection = (page: string) => page.startsWith('settings-') ? page.slice('settings-'.length).split('-')[0] : undefined;

/**
 * The frame of the new interface (steps 4b1, 4b2): the 48px top bar and the pages library | canvas | queue | settings,
 * with the first-run guide above everything. The app starts on the library. Pages stay mounted once shown and are
 * hidden (not unmounted) when another page is open, so the canvas keeps its size, state and dialogs.
 */
export function AppShell({ canvas, overlays, libraryApi, capture = null }: AppShellProps) {
  const { t, lang } = useUiText();
  const page = useShellRoute(state => state.page);
  const settingsSection = useShellRoute(state => state.settingsSection);
  const showOnboarding = useAppStore(state => state.showOnboarding);
  const [visited, setVisited] = useState<Record<ShellPage, boolean>>({ library: true, canvas: true, queue: false, settings: false });
  // Capture runs show the sample library and queue (capture-fixture.ts, loaded only then) instead of the host's.
  const [fixture, setFixture] = useState<CaptureFixture | null>(null);
  const sample = !!capture && !hostCapture(capture.page);
  useEffect(() => {
    if (!capture || !sample) return;
    let live = true;
    void import('../library/capture-fixture').then(module => { if (live) setFixture(module.createCaptureFixture(capture.lang ?? 'zh', new Date(), capture.page === 'library-clear-archived-round' ? { archivedTotal: 112 } : {})); });
    return () => { live = false; };
  }, [capture]);
  const captureMonitor = useMemo(() => {
    if (!fixture) return null;
    const monitor = createQueueMonitor({ call: async method => method === 'list_queue' ? { ok: true, result: { batches: fixture.batches } } as never : { ok: false, error: { code: 'capture', message: 'Not available in UI capture' } } as never });
    void monitor.refresh().catch(() => undefined);
    return monitor;
  }, [fixture]);
  const monitor = captureMonitor ?? windowQueueMonitor();
  const api = fixture?.api ?? libraryApi;
  const go = (next: ShellRoute) => navigate(next);

  useEffect(() => { setVisited(previous => previous[page] ? previous : { ...previous, [page]: true }); }, [page]);

  // Capture runs open the page they name, in the language they name, with sample data (see capture.ts).
  const captured = useRef(false);
  useEffect(() => {
    if (!capture || captured.current) return;
    captured.current = true;
    if (capture.lang) useAppStore.setState(state => ({ settings: state.settings ? { ...state.settings, language: capture.lang === 'zh' ? 'zh-CN' : 'en-US' } : state.settings }));
    if (!hostCapture(capture.page)) useAppStore.setState({ account: { hasToken: true, tierName: 'Opus', tierLevel: 3, anlasBalance: 8240, opusUsage: { percent: 73, isNegative: false, timeUntilNextPercent: 6042 }, opusUsageUpdatedAt: Date.now() } });
    // The about page of the prototype announces a newer release (a sample: capture runs never ask GitHub).
    if (capture.page === 'settings-about-update') useAppStore.setState({ updateInfo: { status: 'available', hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0', releaseUrl: 'https://github.com/lwyq1209/mcp-for-novelai/releases/latest' } });
    useAppStore.getState().setShowOnboarding(capture.page.startsWith('onboarding-'));
    const target = capturePage(capture.page);
    if (target) navigate(target, target === 'settings' ? captureSection(capture.page) : undefined);
  }, [capture]);

  // The old settings entries (store.showSettings: a run without a token, the canvas's account button) open the page.
  const showSettings = useAppStore(state => state.showSettings);
  useEffect(() => {
    if (!showSettings) return;
    useAppStore.getState().setShowSettings(false);
    navigate('settings', 'account');
  }, [showSettings]);

  // Messages of the existing canvas and store (store.toast) show as toasts of the new frame.
  // A toast with a key (store.toastKey) replaces the one shown under that key: a placeholder and its result are one toast.
  const toast = useAppStore(state => state.toast);
  const toastKey = useAppStore(state => state.toastKey);
  useEffect(() => {
    if (!toast) return;
    showToast({ message: compactRemoteErrorText(toast, { maxLength: 360, language: useAppStore.getState().settings?.language }), ...(toastKey ? { key: toastKey } : {}) });
    useAppStore.getState().clearToast();
  }, [toast, toastKey]);

  return <div className="as-shell" data-route={page}>
    <TopBar route={page} onNavigate={go} onOpenAccount={() => navigate('settings', 'account')} monitor={monitor} capture={!!capture} />
    <main className="as-pages">
      <section className={clsx('as-page', page === 'library' && 'is-active')} aria-hidden={page !== 'library' || undefined} inert={page !== 'library'} data-page="library">
        <AppErrorBoundary scope="page:library">{(!sample || fixture) && <LibraryPage api={api} active={page === 'library'} monitor={monitor} capture={capture} sampleImport={fixture?.importFile} />}</AppErrorBoundary>
      </section>
      <section className={clsx('as-page', page === 'canvas' && 'is-active')} aria-hidden={page !== 'canvas' || undefined} inert={page !== 'canvas'} data-page="canvas">
        {canvas}
      </section>
      {visited.queue && <section className={clsx('as-page', page === 'queue' && 'is-active')} aria-hidden={page !== 'queue' || undefined} inert={page !== 'queue'} data-page="queue">
        <AppErrorBoundary scope="page:queue">{(!sample || fixture) && <QueuePage monitor={monitor} api={api} active={page === 'queue'} capture={capture} />}</AppErrorBoundary>
      </section>}
      {visited.settings && <section className={clsx('as-page', page === 'settings' && 'is-active')} aria-hidden={page !== 'settings' || undefined} inert={page !== 'settings'} data-page="settings">
        <AppErrorBoundary scope="page:settings"><SettingsPage section={settingsSection} active={page === 'settings'} capture={capture} /></AppErrorBoundary>
      </section>}
    </main>
    <ToastHost closeLabel={t('c.close')} lang={lang} />
    {overlays}
    {showOnboarding && <ErrorOverlay><Onboarding capture={capture} /></ErrorOverlay>}
  </div>;
}

/**
 * The guide's error boundary (second rework, P2): a failure shows one card over the pages, under the top bar, so the
 * window buttons (frameless window) and the top bar stay usable; the card retries, skips the guide or copies the error.
 */
function ErrorOverlay({ children }: { children: ReactNode }) {
  return <AppErrorBoundary scope="onboarding" renderFallback={failure => <OnboardingFailure {...failure} />}
    fallbackWrap={node => <div className="as-overlay-error" data-testid="onboarding-error">{node}</div>}>{children}</AppErrorBoundary>;
}
