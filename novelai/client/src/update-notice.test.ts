// The renderer side of the new-version notice: the store follows the main process's published results, "Later"
// and "Skip this version" hide the banner, and a manual check returns its result without a failure touching the
// banner. The banner offers Update and restart (the main process's self-update), Download (release page), Later and
// Skip this version, and the store follows the self-update's progress and the notice after an update.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./store";
import type { UpdateInfo } from "./types";
import { waitUntil } from './test-support/wait-until';

const available: UpdateInfo = { status: "available", hasUpdate: true, currentVersion: "0.1.0", latestVersion: "0.2.0", releaseUrl: "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.2.0" };

function naiDesktop(overrides: Record<string, unknown> = {}) {
  let publish: ((info: UpdateInfo) => void) | undefined;
  const api = {
    onGenerationPreview: vi.fn(() => vi.fn()),
    onUpdateEvent: vi.fn((callback: (info: UpdateInfo) => void) => { publish = callback; return vi.fn(); }),
    getUpdateStatus: vi.fn().mockResolvedValue(null),
    checkUpdate: vi.fn().mockResolvedValue(available),
    setSetting: vi.fn(async (_key: string, value: unknown) => value),
    getSettings: vi.fn().mockResolvedValue({ language: "zh-CN", persistGenerateParams: true, persistI2IParams: true, persistInpaintParams: true, persistUpscaleParams: true, persistDirectorParams: true, autoCheckUpdates: true, ignoredUpdateVersion: "" }),
    accountCached: vi.fn().mockResolvedValue({ hasToken: false }),
    isFirstRun: vi.fn().mockResolvedValue(false),
    getHistoryDates: vi.fn().mockResolvedValue([]),
    getHistoryGroups: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return { api, publish: (info: UpdateInfo) => publish?.(info) };
}

beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));
afterEach(() => vi.unstubAllGlobals());

describe("new-version notice in the renderer", () => {
  it("shows what the main process publishes and reads a result published before it listened", async () => {
    const early = naiDesktop({ getUpdateStatus: vi.fn().mockResolvedValue(available) });
    vi.stubGlobal("window", { naiDesktop: early.api });
    await useAppStore.getState().load();
    await waitUntil(() => expect(useAppStore.getState().updateInfo).toEqual(available));

    useAppStore.setState(useAppStore.getInitialState(), true);
    const later = naiDesktop();
    vi.stubGlobal("window", { naiDesktop: later.api });
    await useAppStore.getState().load();
    expect(useAppStore.getState().updateInfo).toBeNull();
    later.publish(available);
    expect(useAppStore.getState().updateInfo).toEqual(available);
    later.publish({ status: "current", hasUpdate: false, currentVersion: "0.1.0", latestVersion: "0.1.0" });
    expect(useAppStore.getState().updateInfo?.hasUpdate).toBe(false);
  });

  it("hides the banner for now on Later and remembers the skipped version on Skip this version", async () => {
    const desktop = naiDesktop();
    vi.stubGlobal("window", { naiDesktop: desktop.api });
    useAppStore.setState({ updateInfo: available });
    useAppStore.getState().dismissUpdate();
    expect(useAppStore.getState().updateInfo).toBeNull();
    expect(desktop.api.setSetting).not.toHaveBeenCalled();

    useAppStore.setState({ updateInfo: available });
    await useAppStore.getState().ignoreUpdate("0.2.0");
    expect(desktop.api.setSetting).toHaveBeenCalledWith("ignoredUpdateVersion", "0.2.0");
    expect(useAppStore.getState().updateInfo).toMatchObject({ status: "ignored", hasUpdate: false, latestVersion: "0.2.0" });
  });

  it("returns a manual check's result; a failed one leaves the banner as it was", async () => {
    const failed: UpdateInfo = { status: "failed", hasUpdate: false, currentVersion: "0.1.0", error: "timeout of 10000ms exceeded" };
    const desktop = naiDesktop({ checkUpdate: vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(available) });
    vi.stubGlobal("window", { naiDesktop: desktop.api });
    await expect(useAppStore.getState().checkUpdate()).resolves.toEqual(failed);
    expect(useAppStore.getState().updateInfo).toBeNull();
    await expect(useAppStore.getState().checkUpdate()).resolves.toEqual(available);
    expect(useAppStore.getState().updateInfo).toEqual(available);
  });

  it("offers Update and restart (the main process installs), Download, Later and Skip this version", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    // Step 4b1: the notice is the top bar's 新版本 pill and its menu (src/shell/TopBar.tsx).
    const pill = readFileSync(new URL("./shell/TopBar.tsx", import.meta.url), "utf8");
    expect(pill).toContain("window.naiDesktop.openExternal(updateInfo.releaseUrl)");
    for (const key of ["top.updateDownload", "top.updateLater", "top.updateIgnore", "top.updateInstall", "top.updateWaitQueue", "top.updateCancel"]) expect(pill).toContain(`'${key}'`);
    expect(pill).toContain("dismissUpdate()");
    expect(pill).toContain("ignoreUpdate(updateInfo.latestVersion!)");
    // The window only asks the main process (startUpdate / cancelUpdate); it downloads and installs nothing itself.
    expect(pill).toContain("useAppStore.getState().startUpdate()");
    expect(pill).not.toMatch(/downloadUpdate|installUpdate|fetch\(|axios/);
    expect(app).not.toMatch(/downloadUpdate|installUpdate|update-install-overlay/);
    const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
    expect(preload).toContain('startUpdate: (): Promise<UpdateProgressInfo> => ipcRenderer.invoke("app:updateStart")');
    expect(preload).toContain('cancelUpdate: (): Promise<UpdateProgressInfo> => ipcRenderer.invoke("app:updateCancel")');
  });

  it("follows the self-update's progress and the notice of the first start after an update", async () => {
    let publishProgress: ((progress: unknown) => void) | undefined;
    const notice = { kind: "updated", from: "0.1.2", to: "0.1.3", releaseUrl: "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.1.3" };
    const desktop = naiDesktop({
      onUpdateProgress: vi.fn((callback: (progress: unknown) => void) => { publishProgress = callback; return vi.fn(); }),
      getUpdateProgress: vi.fn().mockResolvedValue({ phase: "idle", install: { supported: true } }),
      getUpdateNotice: vi.fn().mockResolvedValue(notice),
      startUpdate: vi.fn().mockResolvedValue({ phase: "downloading", version: "0.2.0", received: 0, total: null, install: { supported: true } }),
      cancelUpdate: vi.fn().mockResolvedValue({ phase: "idle", install: { supported: true } }),
    });
    vi.stubGlobal("window", { naiDesktop: desktop.api });
    await useAppStore.getState().load();
    await waitUntil(() => expect(useAppStore.getState().updateNotice).toEqual(notice));
    expect(useAppStore.getState().updateProgress).toEqual({ phase: "idle", install: { supported: true } });
    publishProgress?.({ phase: "downloading", version: "0.2.0", received: 10, total: 100, install: { supported: true } });
    expect(useAppStore.getState().updateProgress).toMatchObject({ phase: "downloading", received: 10 });
    await expect(useAppStore.getState().startUpdate()).resolves.toMatchObject({ phase: "downloading" });
    await useAppStore.getState().cancelUpdate();
    expect(useAppStore.getState().updateProgress?.phase).toBe("idle");
    useAppStore.getState().dismissUpdateNotice();
    expect(useAppStore.getState().updateNotice).toBeNull();
  });
});
