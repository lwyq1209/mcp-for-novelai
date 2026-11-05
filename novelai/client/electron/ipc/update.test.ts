// New-version notice (update.ts): semantic-version comparison, the GitHub request (stubbed axios, real proxy
// settings), the checker's statuses and its schedule. Nothing here reaches the network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../src/types";

const { axiosGet, getSettings } = vi.hoisted(() => ({ axiosGet: vi.fn(), getSettings: vi.fn() }));
vi.mock("axios", () => ({ default: { get: axiosGet } }));
vi.mock("./store", () => ({ getSettings }));

import {
  compareVersions,
  createUpdateChecker,
  fetchLatestRelease,
  FIRST_UPDATE_CHECK_DELAY_MS,
  isNewerVersion,
  LATEST_RELEASE_API_URL,
  parseVersion,
  RELEASES_PAGE_URL,
  shouldScheduleAutomaticChecks,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_REQUEST_TIMEOUT_MS,
  UPDATE_RESPONSE_MAX_BYTES,
  type LatestRelease,
} from "./update";
import { readFileSync } from "node:fs";
import { USER_AGENT } from "../../src/types";

function proxySettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { proxyMode: "direct", proxyUrl: "", proxyForNai: true, proxyForUpdate: true, apiBaseUrl: "https://api.novelai.net", ...overrides } as AppSettings;
}

beforeEach(() => {
  axiosGet.mockReset();
  getSettings.mockReset();
  getSettings.mockReturnValue(proxySettings());
});
afterEach(() => vi.useRealTimers());

describe("semantic versions", () => {
  it("reads versions with or without a v prefix, pre-release identifiers and build metadata", () => {
    expect(parseVersion("0.1.0")).toEqual({ major: 0, minor: 1, patch: 0, prerelease: [] });
    expect(parseVersion("v1.10.3")).toEqual({ major: 1, minor: 10, patch: 3, prerelease: [] });
    expect(parseVersion(" v2.0.0-rc.1 ")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: ["rc", 1] });
    expect(parseVersion("1.2.3-beta.x-7+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["beta", "x-7"] });
  });

  it("refuses anything that is not a semantic version", () => {
    for (const value of ["", "v", "latest", "1", "1.2", "1.2.3.4", "01.2.3", "1.02.3", "1.2.3-", "1.2.3-01", "1.2.3-beta..1", "V1.2.3", "vv1.2.3", "1.2.3 beta", "99999999999999999999.0.0", null, undefined, 123, {}])
      expect(parseVersion(value), String(value)).toBeNull();
  });

  it("orders versions by semantic-version precedence", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect(compareVersions(parseVersion(ordered[i])!, parseVersion(ordered[j])!), `${ordered[i]} vs ${ordered[j]}`).toBe(Math.sign(i - j));
      }
    }
    expect(compareVersions(parseVersion("v1.0.0+build.1")!, parseVersion("1.0.0+build.2")!)).toBe(0);
  });

  it("announces only a newer regular release to a regular release, never a pre-release or an unreadable version", () => {
    expect(isNewerVersion("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.1", "v0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.1.0+build.9", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
    // A pre-release is not newer than a regular release, whatever its number.
    expect(isNewerVersion("0.1.0-beta.1", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.2.0-beta.1", "0.1.0")).toBe(false);
    // From a pre-release, its regular release and later pre-releases are newer.
    expect(isNewerVersion("0.2.0", "0.2.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
    expect(isNewerVersion("0.2.0-beta.1", "0.2.0-beta.1")).toBe(false);
    for (const [latest, current] of [["latest", "0.1.0"], ["0.2", "0.1.0"], ["", "0.1.0"], ["0.2.0", "dev"], ["0.2.0", ""]])
      expect(isNewerVersion(latest, current), `${latest} vs ${current}`).toBe(false);
  });
});

describe("the latest release request", () => {
  const release = (data: Record<string, unknown>) => ({ status: 200, data });

  it("asks only this project's GitHub latest-release API, with a timeout, and opens its release page", async () => {
    axiosGet.mockResolvedValueOnce(release({ tag_name: "v0.2.0", html_url: "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.2.0" }));
    await expect(fetchLatestRelease()).resolves.toEqual({ tag: "v0.2.0", releaseUrl: "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.2.0" });
    expect(LATEST_RELEASE_API_URL).toBe("https://api.github.com/repos/lwyq1209/mcp-for-novelai/releases/latest");
    expect(axiosGet).toHaveBeenCalledTimes(1);
    const [url, config] = axiosGet.mock.calls[0];
    expect(url).toBe(LATEST_RELEASE_API_URL);
    expect(config).toMatchObject({ timeout: UPDATE_REQUEST_TIMEOUT_MS, maxContentLength: UPDATE_RESPONSE_MAX_BYTES, headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT } });
    expect(UPDATE_RESPONSE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(config.headers.Authorization).toBeUndefined();
  });

  it("goes through the proxy configured for app updates", async () => {
    getSettings.mockReturnValue(proxySettings({ proxyMode: "custom", proxyUrl: "127.0.0.1:4567" }));
    axiosGet.mockResolvedValue(release({ tag_name: "v0.2.0" }));
    await fetchLatestRelease();
    const proxied = axiosGet.mock.calls[0][1];
    expect(proxied).toMatchObject({ proxy: false });
    expect(proxied.httpsAgent).toBeDefined();
    expect(String((proxied.httpsAgent as { proxy?: URL }).proxy?.href ?? "")).toContain("127.0.0.1:4567");

    // The update category can opt out of the proxy, and direct mode never uses one.
    for (const settings of [proxySettings({ proxyMode: "custom", proxyUrl: "127.0.0.1:4567", proxyForUpdate: false }), proxySettings({ proxyMode: "direct", proxyUrl: "127.0.0.1:4567" })]) {
      getSettings.mockReturnValue(settings);
      axiosGet.mockClear();
      await fetchLatestRelease();
      expect(axiosGet.mock.calls[0][1].httpsAgent).toBeUndefined();
      expect(axiosGet.mock.calls[0][1].proxy).toBeUndefined();
    }
  });

  it("treats a repository without releases (404) and a draft or pre-release answer as no release", async () => {
    axiosGet.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 404"), { response: { status: 404 } }));
    await expect(fetchLatestRelease()).resolves.toBeNull();
    axiosGet.mockResolvedValueOnce(release({ tag_name: "v0.3.0-beta.1", prerelease: true }));
    await expect(fetchLatestRelease()).resolves.toBeNull();
    axiosGet.mockResolvedValueOnce(release({ tag_name: "v0.3.0", draft: true }));
    await expect(fetchLatestRelease()).resolves.toBeNull();
  });

  it("opens only this repository's release pages, over https on github.com", async () => {
    for (const html_url of ["https://evil.example/lwyq1209/mcp-for-novelai/releases/tag/v1.0.0", "http://github.com/lwyq1209/mcp-for-novelai/releases/tag/v1.0.0", "https://github.com/someone/else/releases/tag/v1.0.0",
      "https://github.com:8443/lwyq1209/mcp-for-novelai/releases/tag/v1.0.0", "https://user:pass@github.com/lwyq1209/mcp-for-novelai/releases/tag/v1.0.0",
      "https://github.com/lwyq1209/mcp-for-novelai/releases/download/v1.0.0/setup.exe", "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/", "javascript:alert(1)", 42, undefined]) {
      axiosGet.mockResolvedValueOnce(release({ tag_name: "v1.0.0", html_url }));
      await expect(fetchLatestRelease()).resolves.toEqual({ tag: "v1.0.0", releaseUrl: RELEASES_PAGE_URL });
    }
  });

  it("fails on other HTTP errors, timeouts and answers without a tag", async () => {
    axiosGet.mockRejectedValueOnce(Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } }));
    await expect(fetchLatestRelease()).rejects.toThrow("403");
    axiosGet.mockRejectedValueOnce(Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" }));
    await expect(fetchLatestRelease()).rejects.toThrow("timeout");
    axiosGet.mockResolvedValueOnce(release({ name: "no tag" }));
    await expect(fetchLatestRelease()).rejects.toThrow("tag");
    axiosGet.mockResolvedValueOnce({ status: 200, data: "<html>" });
    await expect(fetchLatestRelease()).rejects.toThrow();
  });
});

describe("the update checker", () => {
  const page = "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.2.0";
  function checker(options: { latest?: LatestRelease | null | Error; auto?: boolean; ignored?: string; current?: string } = {}) {
    const settings = { autoCheckUpdates: options.auto ?? true, ignoredUpdateVersion: options.ignored ?? "" };
    const fetchLatest = vi.fn(async () => {
      if (options.latest instanceof Error) throw options.latest;
      return options.latest === undefined ? { tag: "v0.2.0", releaseUrl: page } : options.latest;
    });
    const publish = vi.fn(), warn = vi.fn();
    const instance = createUpdateChecker({ currentVersion: options.current ?? "0.1.0", readSettings: () => settings, publish, fetchLatest, warn, now: () => new Date("2026-11-02T00:00:00Z") });
    return { instance, settings, fetchLatest, publish, warn };
  }

  it("announces a newer release with its page", async () => {
    const { instance, publish } = checker();
    const info = await instance.check("automatic");
    expect(info).toEqual({ status: "available", hasUpdate: true, currentVersion: "0.1.0", latestVersion: "0.2.0", releaseUrl: page, checkedAt: "2026-11-02T00:00:00.000Z" });
    expect(publish).toHaveBeenCalledWith(info);
    expect(instance.status()).toEqual(info);
  });

  it("reports no update when the latest release is not newer or none is published", async () => {
    for (const latest of [{ tag: "v0.1.0", releaseUrl: page }, { tag: "0.0.9", releaseUrl: page }, { tag: "v0.2.0-beta.1", releaseUrl: page }, null]) {
      const { instance, publish } = checker({ latest });
      const info = await instance.check("automatic");
      expect(info).toMatchObject({ status: "current", hasUpdate: false, currentVersion: "0.1.0" });
      expect(info.releaseUrl).toBeUndefined();
      expect(publish).toHaveBeenCalledWith(info);
    }
  });

  it("stays silent when the request fails: no announcement, only a log line", async () => {
    const { instance, publish, warn } = checker({ latest: new Error("timeout of 10000ms exceeded") });
    await expect(instance.check("automatic")).resolves.toMatchObject({ status: "failed", hasUpdate: false, error: "timeout of 10000ms exceeded" });
    expect(publish).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timeout"));
    expect(instance.status()).toBeNull();
    const unreadable = checker({ latest: { tag: "nightly", releaseUrl: page } });
    await expect(unreadable.instance.check("automatic")).resolves.toMatchObject({ status: "failed", hasUpdate: false, error: "Unrecognized release version: nightly" });
    expect(unreadable.publish).not.toHaveBeenCalled();
    // A long or multi-line tag is cut to one line of at most 64 characters in the message and the log.
    const noisy = checker({ latest: { tag: `${"x".repeat(100)}\n[fake log line]`, releaseUrl: page } });
    const info = await noisy.instance.check("manual");
    expect(info.error).toBe(`Unrecognized release version: ${"x".repeat(63)}…`);
    expect(noisy.warn.mock.calls[0][0]).not.toContain("\n");
  });

  it("does not announce the ignored version on automatic checks, but a manual check still names it", async () => {
    const { instance, publish } = checker({ ignored: "v0.2.0" });
    await expect(instance.check("automatic")).resolves.toMatchObject({ status: "ignored", hasUpdate: false, latestVersion: "0.2.0" });
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ignored", hasUpdate: false }));
    await expect(instance.check("manual")).resolves.toMatchObject({ status: "available", hasUpdate: true, latestVersion: "0.2.0" });
    // A later release is announced again.
    const later = checker({ ignored: "0.2.0", latest: { tag: "v0.3.0", releaseUrl: page } });
    await expect(later.instance.check("automatic")).resolves.toMatchObject({ status: "available", latestVersion: "0.3.0" });
  });

  it("hides an announcement from its status once that version is ignored", async () => {
    const { instance, settings } = checker();
    await instance.check("automatic");
    settings.ignoredUpdateVersion = "0.2.0";
    expect(instance.status()).toMatchObject({ status: "ignored", hasUpdate: false, latestVersion: "0.2.0" });
  });

  it("requests nothing on automatic checks while automatic checks are off; a manual check still asks", async () => {
    const { instance, fetchLatest, publish } = checker({ auto: false });
    await expect(instance.check("automatic")).resolves.toMatchObject({ status: "disabled", hasUpdate: false });
    expect(fetchLatest).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await expect(instance.check("manual")).resolves.toMatchObject({ status: "available" });
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("checks once shortly after start, then every 6 hours, reading the setting each time, until stopped", async () => {
    vi.useFakeTimers();
    const { instance, fetchLatest, settings } = checker();
    instance.start();
    instance.start(); // starting twice does not double the schedule
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS - 1);
    expect(fetchLatest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - FIRST_UPDATE_CHECK_DELAY_MS - 1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FIRST_UPDATE_CHECK_DELAY_MS + 1);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    settings.autoCheckUpdates = false;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    settings.autoCheckUpdates = true;
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(fetchLatest).toHaveBeenCalledTimes(3);
    instance.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(fetchLatest).toHaveBeenCalledTimes(3);
  });

  it("schedules automatic checks only in a packaged app outside UI capture; main.ts follows that rule", () => {
    expect(shouldScheduleAutomaticChecks({ packaged: true, uiCapture: false })).toBe(true);
    expect(shouldScheduleAutomaticChecks({ packaged: false, uiCapture: false })).toBe(false);
    expect(shouldScheduleAutomaticChecks({ packaged: true, uiCapture: true })).toBe(false);
    const main = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
    expect(main).toContain("if (shouldScheduleAutomaticChecks({ packaged: app.isPackaged, uiCapture: Boolean(uiCapturePath) })) updateChecker.start();");
    expect(main.match(/updateChecker\.start\(\)/g)).toHaveLength(1);
    // The manual check does not depend on it.
    expect(main).toContain('ipcMain.handle("app:checkUpdate", () => updateChecker.check("manual"));');
  });

  it("never requests anything when automatic checks are off from the start", async () => {
    vi.useFakeTimers();
    const { instance, fetchLatest } = checker({ auto: false });
    instance.start();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 4);
    expect(fetchLatest).not.toHaveBeenCalled();
    instance.stop();
  });
});
