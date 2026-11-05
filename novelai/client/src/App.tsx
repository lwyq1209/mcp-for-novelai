import { WorkspaceBridge } from "./workspace/WorkspaceBridge";
import { MaterialLibraryLauncher } from "./workspace/MaterialLibraryLauncher";
import { ImageSaveFeedback } from "./components/ImageSaveFeedback";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
const loadInpaintCanvas = () => import("./InpaintCanvas").then((m) => ({ default: m.InpaintCanvas }));
const InpaintCanvas = lazy(loadInpaintCanvas);
import { selectCreativeMode, useWorkbenchNavigation } from './app/workbench-navigation';
import { useAppStore } from "./store";
import { CanvasPage } from "./canvas/CanvasPage";
import { collectPortableWorkspaceData } from "./features/settings/data-backup-workspace";
import { Button } from "./ui";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { AppShell } from "./shell/AppShell";
import { windowCaptureRequest } from "./shell/capture";
import { navigate } from "./shell/route";
import { isActiveTab } from "./app/navigation";
import { useUiText } from "./ui/i18n";
import { APP_NAME, PROJECT_HOMEPAGE_URL, APP_VERSION } from "./types";

const appIconUrl = "./icon.png";

// ── Splash ────────────────────────────────────────────────────────────────────
function SplashPage() {
  // Show a custom entrance image when public/splash.png exists; otherwise fall
  // back to the built-in animated orbs. The <img> hides itself on load error.
  const [hasCustom, setHasCustom] = useState(true);
  const { t } = useUiText();
  const bootError = useAppStore((state) => state.bootError);
  const load = useAppStore((state) => state.load);
  return (
    <div className="splash-page splash-animate">
      {hasCustom && (
        <img
          className="splash-custom"
          src="./splash.png"
          alt=""
          onError={() => setHasCustom(false)}
        />
      )}
      {!hasCustom && (
        <div className="splash-art">
          <div className="splash-orb splash-orb-a" />
          <div className="splash-orb splash-orb-b" />
          <div className="splash-logo-mark">
            <div className="logo-gem" />
            <div className="logo-ring" />
          </div>
        </div>
      )}
      <div className="splash-title">
        <div className="splash-brand">
          <img className="brand-icon-img" src={appIconUrl} alt="" />
          <h1>{APP_NAME}</h1>
        </div>
        <div className="splash-divider" />
        <p className="splash-sub">{t('app.splashSub')}</p>
        <p className="splash-ver">v{APP_VERSION}</p>
        {bootError && (
          <>
            <p className="splash-sub" style={{ color: "var(--danger)" }}>
              {bootError}
            </p>
            <Button variant="primary" onClick={() => void load()}>
              {t('c.retry')}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
function MainPage() {
  const activeTab = useAppStore((state) => state.activeTab);
  const settings = useAppStore((state) => state.settings);
  const language = settings?.language;
  const { t } = useUiText();
  const uiCaptureParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const capture = useMemo(() => windowCaptureRequest(), []);
  useEffect(() => {
    const captureSurface = uiCaptureParams.get("uiCapture");
    if (captureSurface) useAppStore.getState().setShowOnboarding(captureSurface === "onboarding");
    // A capture of a new page (step 4b1) opens that page with sample data; the old capture names keep their pages.
    if (capture) return;
    if (captureSurface === "updateBanner") {
      // A sample announcement: capture runs never ask GitHub.
      useAppStore.setState({
        updateInfo: { status: "available", hasUpdate: true, currentVersion: APP_VERSION, latestVersion: "9.9.9", releaseUrl: `${PROJECT_HOMEPAGE_URL}/releases/latest` },
      });
    }
    if (captureSurface === "opusUsage" || captureSurface === "opusInline") {
      useAppStore.setState({
        account: {
          hasToken: true,
          tierName: "Opus",
          tierLevel: 3,
          anlasBalance: 10_000,
          opusUsage: { percent: 73.4, isNegative: false, timeUntilNextPercent: 6042 },
          opusUsageUpdatedAt: Date.now(),
        },
      });
    }
    if (isActiveTab(captureSurface)) {
      useAppStore.getState().setActiveTab(captureSurface);
      navigate("canvas");
    } else if (captureSurface === "settings") {
      // The old settings capture names open the settings page at their section (step 4b2).
      navigate("settings", uiCaptureParams.get("uiSettingsSection") || "api");
    } else if (captureSurface === "opusUsage" || captureSurface === "opusInline" || captureSurface === "referenceModal") {
      navigate("canvas");
    }
  }, [uiCaptureParams, capture]);

  // A page id this version does not know never leaves the main area blank: fall back to generate. The tools page
  // was removed (step 4b1): its tools live in the library now, so a restored "tools" opens the last canvas mode.
  useEffect(() => {
    if (!isActiveTab(activeTab)) {
      useAppStore.getState().setActiveTab("generate");
    } else if (activeTab === "tools" || activeTab === "metadata" || activeTab === "referencePresets") {
      // The tools page (step 4b1) and its two pages (step 4b3c: reading metadata is in the library's 导入图片, the
      // reference presets in its 预设 › 参考) are gone: a restored one opens the last canvas mode.
      selectCreativeMode(useWorkbenchNavigation.getState().lastCreative);
    }
  }, [activeTab]);

  // Dark only (user decision 1, step 4b1): the existing pages use their dark theme, and the settings offer no theme.
  useEffect(() => {
    document.documentElement.classList.add("theme-dark");
  }, []);

  // Motion is an explicit in-app accessibility choice. Do not inherit Windows'
  // broad "Animation effects" performance flag: on this machine it is off for
  // performance reasons, not as a request to remove product feedback.
  useEffect(() => {
    document.documentElement.classList.toggle("motion-reduced", settings?.reduceMotion === true);
    return () => document.documentElement.classList.remove("motion-reduced");
  }, [settings?.reduceMotion]);

  useEffect(() => {
    document.documentElement.lang = settings?.language ?? "zh-CN";
  }, [settings?.language]);

  // The canvas page (step 4b3): the rebuilt canvas (src/canvas) with Inpaint's canvas in its stage. The old material
  // rail, the image metadata page and the reference preset page are no longer mounted (4b3c): the canvas's library
  // picker (src/canvas/LibraryPicker.tsx) inserts from the library, and the library page manages it.
  const canvas = (
    <div className="as-canvas-page">
      <AppErrorBoundary scope="page:canvas">
        <CanvasPage
          inpaintStage={
            <Suspense fallback={<div className="lazy-tool-loading">{t('app.loadingInpaint')}</div>}>
              <InpaintCanvas />
            </Suspense>
          }
        />
      </AppErrorBoundary>
    </div>
  );

  return (
    <AppShell
      canvas={canvas}
      libraryApi={window.naiDesktop}
      capture={capture}
      overlays={<ImageSaveFeedback language={language} />}
    />
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  const SPLASH_MIN_VISIBLE_MS = 700;
  const [splash, setSplash] = useState(true);
  const bootDone = useAppStore((state) => state.bootDone);
  const load = useAppStore((state) => state.load);

  useEffect(() => {
    let cancelled = false;
    // Inpaint is the only lazy screen needed on the startup critical path.
    // The other top-level routes warm after first paint so the splash never
    // waits for screens the user may not open in this session.
    const warmCriticalScreen = loadInpaintCanvas();
    const minimumSplash = new Promise<void>((resolve) => {
      window.setTimeout(resolve, SPLASH_MIN_VISIBLE_MS);
    });
    void Promise.allSettled([warmCriticalScreen, minimumSplash]).then(() => {
      if (!cancelled) setSplash(false);
    });
    void load();
    // Full archive work must not compete with scrolling, generation or initial
    // route setup. Track real interaction and wait for a quiet window; the
    // service performs the due check and defaults migrated users to metadata-
    // only automatic archives.
    const BACKUP_IDLE_MS = 45_000;
    let lastInteractionAt = Date.now();
    let automaticBackupTimer: number | undefined;
    let automaticBackupStarted = false;
    const markInteraction = () => { lastInteractionAt = Date.now(); };
    const attemptAutomaticBackup = () => {
      if (cancelled || automaticBackupStarted) return;
      const idleFor = Date.now() - lastInteractionAt;
      const activelyGenerating = useAppStore.getState().isGenerating;
      if (
        activelyGenerating ||
        (document.visibilityState === "visible" && idleFor < BACKUP_IDLE_MS)
      ) {
        automaticBackupTimer = window.setTimeout(
          attemptAutomaticBackup,
          activelyGenerating ? 30_000 : Math.max(10_000, BACKUP_IDLE_MS - idleFor),
        );
        return;
      }
      automaticBackupStarted = true;
      void window.naiDesktop.runAutomaticBackup(collectPortableWorkspaceData());
    };
    window.addEventListener("pointerdown", markInteraction, { passive: true });
    window.addEventListener("keydown", markInteraction);
    window.addEventListener("wheel", markInteraction, { passive: true });
    automaticBackupTimer = window.setTimeout(attemptAutomaticBackup, 60_000);
    return () => {
      cancelled = true;
      if (automaticBackupTimer !== undefined) window.clearTimeout(automaticBackupTimer);
      window.removeEventListener("pointerdown", markInteraction);
      window.removeEventListener("keydown", markInteraction);
      window.removeEventListener("wheel", markInteraction);
    };
  }, [load]);

  const shouldShowSplash = useMemo(() => splash || !bootDone, [splash, bootDone]);
  return <>{shouldShowSplash ? <SplashPage /> : <MainPage />}<WorkspaceBridge /><MaterialLibraryLauncher /></>;
}
