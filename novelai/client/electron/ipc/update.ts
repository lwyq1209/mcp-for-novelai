// New-version notice. The app tells the user that a newer release exists; "Download" opens its GitHub release page in
// the system browser, "Update and restart" hands it to the self-update (electron/update/: signed manifest, download,
// install), which asks the same latest-release API again before it downloads anything.
//
// One source: the latest release of this project on GitHub (unauthenticated REST API, the "update" proxy
// category). A packaged app checks once shortly after start and then every 6 hours while automatic checks
// are on (setting autoCheckUpdates); Settings › About can check at any time, in every run. Automatic checks are silent: a
// timeout or any other failure only goes to the log. A version the user chose to skip (ignoredUpdateVersion) is
// not announced by automatic checks again; a manual check still names it.
import axios from "axios";
import type { AppSettings, UpdateInfo } from "../../src/types";
import { USER_AGENT } from "../../src/types";
import { proxyConfig } from "./proxy";

/** The GitHub repository whose releases are this app's releases. */
export const RELEASE_REPOSITORY = "lwyq1209/mcp-for-novelai";
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
/** Opened when a release names no usable page of its own. */
export const RELEASES_PAGE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/latest`;
/** The first automatic check runs this long after start, so it does not compete with startup. */
export const FIRST_UPDATE_CHECK_DELAY_MS = 5_000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_REQUEST_TIMEOUT_MS = 10_000;
/** Largest answer read from GitHub; a release's JSON (notes and asset list included) stays far below it. */
export const UPDATE_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated pre-release identifiers (numeric ones as numbers); empty for a regular release. */
  prerelease: Array<string | number>;
}

// Semantic Versioning 2.0.0 (https://semver.org), with an optional leading "v" as in release tags.
const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** A version such as 1.2.3, v1.2.3, 1.2.3-beta.1 or 1.2.3+build; null for anything else. */
export function parseVersion(value: unknown): SemanticVersion | null {
  if (typeof value !== "string") return null;
  const match = SEMVER.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  if (prerelease.some((id) => typeof id === "number" && !Number.isSafeInteger(id))) return null;
  return { major, minor, patch, prerelease };
}

/** The version without a leading "v" or build metadata (1.2.3-beta.1), as shown to the user. */
export function formatVersion(version: SemanticVersion): string {
  const core = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length ? `${core}-${version.prerelease.join(".")}` : core;
}

/** Semantic-version precedence: 1 when a is newer, -1 when older, 0 when equal (build metadata is ignored). */
export function compareVersions(a: SemanticVersion, b: SemanticVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  // A pre-release ranks below the regular release of the same version.
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index], y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x > y ? 1 : -1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Whether release `latest` is newer than the running version `current`. An unreadable version is never newer,
 * and a pre-release is never offered to a regular release (it would be newer by precedence only when its own
 * version is higher, but users of a regular release are told about regular releases only).
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const a = parseVersion(latest), b = parseVersion(current);
  if (!a || !b) return false;
  if (a.prerelease.length && !b.prerelease.length) return false;
  return compareVersions(a, b) > 0;
}

/** Whether two version strings name the same version (v prefix and build metadata ignored). */
export function sameVersion(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  return Boolean(x && y && compareVersions(x, y) === 0);
}

export interface LatestRelease {
  /** The release tag as published (for example v0.2.0). */
  tag: string;
  /** Its release page on github.com. */
  releaseUrl: string;
}

/**
 * The release page to open: the release's own html_url when it is a release page of this repository
 * (https://github.com/<repository>/releases/tag/…, default port, no credentials), else the latest-release page.
 */
function releasePage(value: unknown): string {
  if (typeof value !== "string") return RELEASES_PAGE_URL;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com" && url.port === "" && !url.username && !url.password
      && url.pathname.startsWith(`/${RELEASE_REPOSITORY}/releases/tag/`) && url.pathname.length > `/${RELEASE_REPOSITORY}/releases/tag/`.length) return url.toString();
  } catch {
    // Not a URL: fall through.
  }
  return RELEASES_PAGE_URL;
}

/**
 * The latest release of this project, or null when the repository has published none yet (HTTP 404). Drafts and
 * pre-releases never come back from this endpoint; one marked so anyway is treated as no release.
 */
export async function fetchLatestRelease(apiUrl: string = LATEST_RELEASE_API_URL): Promise<LatestRelease | null> {
  let response;
  try {
    response = await axios.get(apiUrl, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT },
      timeout: UPDATE_REQUEST_TIMEOUT_MS,
      responseType: "json",
      maxContentLength: UPDATE_RESPONSE_MAX_BYTES,
      ...proxyConfig("update"),
    });
  } catch (error: any) {
    if (error?.response?.status === 404) return null;
    throw error;
  }
  const data = response.data;
  if (!data || typeof data !== "object") throw new Error("GitHub returned no release data.");
  if (data.draft === true || data.prerelease === true) return null;
  if (typeof data.tag_name !== "string" || !data.tag_name.trim()) throw new Error("GitHub returned a release without a tag.");
  return { tag: data.tag_name.trim(), releaseUrl: releasePage(data.html_url) };
}

/** At most 64 characters of remote text on one line, for messages. */
function shortText(value: string): string {
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > 64 ? `${line.slice(0, 63)}…` : line;
}

/**
 * Whether the main process schedules automatic checks: only in a packaged app, never in a run from source or a
 * test client (which would ask GitHub on every start) and never in UI capture. "Check now" works in every run.
 */
export function shouldScheduleAutomaticChecks(run: { packaged: boolean; uiCapture: boolean }): boolean {
  return run.packaged && !run.uiCapture;
}

export type UpdateSettings = Pick<AppSettings, "autoCheckUpdates" | "ignoredUpdateVersion">;
export type UpdateCheckTrigger = "automatic" | "manual";

export interface UpdateCheckerOptions {
  /** The running app's version (package.json). */
  currentVersion: string;
  /** Read at every check, so a changed setting applies to the next one. */
  readSettings: () => UpdateSettings;
  /** Receives every definite result (available, current, ignored); not failures or skipped checks. */
  publish: (info: UpdateInfo) => void;
  fetchLatest?: () => Promise<LatestRelease | null>;
  now?: () => Date;
  warn?: (message: string) => void;
  timers?: {
    setTimeout: (callback: () => void, ms: number) => unknown;
    setInterval: (callback: () => void, ms: number) => unknown;
    clearTimeout: (handle: any) => void;
    clearInterval: (handle: any) => void;
  };
}

export interface UpdateChecker {
  /** One check. Automatic checks do nothing while autoCheckUpdates is off and skip the ignored version. */
  check(trigger: UpdateCheckTrigger): Promise<UpdateInfo>;
  /** The last published result, with a since-ignored version no longer announced; null before the first one. */
  status(): UpdateInfo | null;
  /** The first automatic check after FIRST_UPDATE_CHECK_DELAY_MS, then one every UPDATE_CHECK_INTERVAL_MS. */
  start(): void;
  stop(): void;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const fetchLatest = options.fetchLatest ?? fetchLatestRelease;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const timers: NonNullable<UpdateCheckerOptions["timers"]> = options.timers ?? {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    clearInterval: (handle) => clearInterval(handle),
  };
  const currentVersion = options.currentVersion;
  let last: UpdateInfo | null = null;
  let firstTimer: unknown, intervalTimer: unknown;

  const result = (status: UpdateInfo["status"], extra: Partial<UpdateInfo> = {}): UpdateInfo => ({
    status, hasUpdate: status === "available", currentVersion, checkedAt: now().toISOString(), ...extra,
  });
  const ignored = (version: string | undefined, settings: UpdateSettings) =>
    Boolean(version && settings.ignoredUpdateVersion && sameVersion(version, settings.ignoredUpdateVersion));

  async function check(trigger: UpdateCheckTrigger): Promise<UpdateInfo> {
    const settings = options.readSettings();
    if (trigger === "automatic" && settings.autoCheckUpdates === false) return result("disabled");
    let latest: LatestRelease | null;
    try {
      latest = await fetchLatest();
    } catch (error: any) {
      const message = error?.message ? String(error.message) : String(error);
      warn(`[update] ${trigger} update check failed: ${message}`);
      return result("failed", { error: message });
    }
    const parsed = latest ? parseVersion(latest.tag) : null;
    let info: UpdateInfo;
    if (latest && !parsed) {
      // The tag is remote text: only a short, single-line excerpt goes into the log and the message.
      const tag = shortText(latest.tag);
      warn(`[update] the latest release tag is not a version: ${tag}`);
      return result("failed", { error: `Unrecognized release version: ${tag}` });
    }
    if (!latest || !parsed || !isNewerVersion(latest.tag, currentVersion)) {
      info = result("current", parsed ? { latestVersion: formatVersion(parsed) } : {});
    } else {
      const latestVersion = formatVersion(parsed);
      const skip = trigger === "automatic" && ignored(latestVersion, settings);
      info = result(skip ? "ignored" : "available", { latestVersion, releaseUrl: latest.releaseUrl });
    }
    last = info;
    options.publish(info);
    return info;
  }

  function status(): UpdateInfo | null {
    if (last?.status === "available" && ignored(last.latestVersion, options.readSettings())) return { ...last, status: "ignored", hasUpdate: false };
    return last;
  }

  const automatic = () => { void check("automatic").catch(() => undefined); };
  return {
    check,
    status,
    start() {
      if (firstTimer !== undefined || intervalTimer !== undefined) return;
      firstTimer = timers.setTimeout(automatic, FIRST_UPDATE_CHECK_DELAY_MS);
      intervalTimer = timers.setInterval(automatic, UPDATE_CHECK_INTERVAL_MS);
      (firstTimer as { unref?: () => void })?.unref?.();
      (intervalTimer as { unref?: () => void })?.unref?.();
    },
    stop() {
      if (firstTimer !== undefined) timers.clearTimeout(firstTimer);
      if (intervalTimer !== undefined) timers.clearInterval(intervalTimer);
      firstTimer = intervalTimer = undefined;
    },
  };
}
