// Where updates come from and what they are checked against (pure).
//
// The official source is fixed in the app: this repository's GitHub releases (the latest-release API, downloads only
// from https://github.com/<repository>/releases/download/<tag>/ and the hosts GitHub redirects those downloads to),
// the Ed25519 public key whose private key signs SHA256SUMS.txt in the release workflow, and on macOS the SHA-256
// fingerprint of the self-signed code signing certificate of the release builds.
//
// Update rehearsal builds only (dev-tools/update-rehearsal): a build made with NAI_UPDATE_TEST_BUILD=1 carries the file
// dist-electron/update-test-mode.json (scripts/build-electron.mjs); only such a build reads NAI_UPDATE_TEST_FEED (a
// loopback http://127.0.0.1:<port> fake GitHub), NAI_UPDATE_TEST_PUBLIC_KEY and NAI_UPDATE_TEST_MAC_CERT_SHA256 from its
// environment. Every other build — the release builds included (the release workflow never sets the variable, and
// .github/scripts/packaged-app-check.mjs fails a package that contains the file) — ignores these variables entirely:
// there is no switch that changes the trusted key, the certificate or the source of an official app.
import { RELEASE_REPOSITORY, LATEST_RELEASE_API_URL } from "../ipc/update";

/** The update signing key: raw 32-byte Ed25519 public key, base64. Its private key exists only as a GitHub secret. */
export const OFFICIAL_UPDATE_PUBLIC_KEY = "Kd4drS/jkRBrI5p6sEUc0clnYHcJ8xQ6RkX+wVJccPw=";
/** SHA-256 of the DER certificate that signs the macOS release builds (CN "MCP for NovelAI (self-signed)", O lwyq1209). */
export const OFFICIAL_MAC_CERT_SHA256 = "4001b2f773a1f258cac351597a518c9924d294e167d298297c64cd409ee67524";
/** The hosts github.com redirects release downloads to (any other redirect target is refused). */
export const GITHUB_DOWNLOAD_HOSTS = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"] as const;
/** The marker file of an update rehearsal build, in dist-electron/ (next to dist-electron/electron/). */
export const TEST_MODE_MARKER = "update-test-mode.json";
export const TEST_ENV = { feed: "NAI_UPDATE_TEST_FEED", publicKey: "NAI_UPDATE_TEST_PUBLIC_KEY", macCertificate: "NAI_UPDATE_TEST_MAC_CERT_SHA256" } as const;

export interface UpdateSource {
  kind: "github" | "test";
  /** The latest-release API (GitHub's JSON: tag_name, html_url, draft, prerelease). */
  latestApiUrl: string;
  /** The download URL of one file of the release `tag` (both already validated). */
  downloadUrl(tag: string, file: string): string;
  /** Whether a URL may be requested while downloading files of `tag` (the first URL and every redirect). */
  allowsDownloadUrl(url: URL, tag: string): boolean;
  /** The release page of `tag`. */
  releasePageUrl(tag: string): string;
  /** Raw Ed25519 public key, base64. */
  publicKey: string;
  /** macOS: SHA-256 (lowercase hex) of the code signing certificate an update must carry when the running app has none. */
  macCertificateSha256: string;
}

const downloadPath = (tag: string) => `/${RELEASE_REPOSITORY}/releases/download/${tag}/`;
/** https, default port, no user name or password, the given host. */
const plainHttps = (url: URL, host: string) => url.protocol === "https:" && url.hostname === host && url.port === "" && !url.username && !url.password;

export const OFFICIAL_SOURCE: UpdateSource = Object.freeze({
  kind: "github" as const,
  latestApiUrl: LATEST_RELEASE_API_URL,
  downloadUrl: (tag: string, file: string) => `https://github.com${downloadPath(tag)}${file}`,
  allowsDownloadUrl(url: URL, tag: string) {
    if (plainHttps(url, "github.com")) return url.pathname.startsWith(downloadPath(tag)) && !url.pathname.slice(downloadPath(tag).length).includes("/");
    return GITHUB_DOWNLOAD_HOSTS.some(host => plainHttps(url, host));
  },
  releasePageUrl: (tag: string) => `https://github.com/${RELEASE_REPOSITORY}/releases/tag/${tag}`,
  publicKey: OFFICIAL_UPDATE_PUBLIC_KEY,
  macCertificateSha256: OFFICIAL_MAC_CERT_SHA256,
});

/** A rehearsal feed: http://127.0.0.1:<port> exactly (no path, no user, no other host). */
function loopbackFeed(value: string | undefined): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) return null;
  return url;
}

/**
 * The update source of this run. `testBuild`: whether the marker file of a rehearsal build exists. Without it the
 * environment is not read at all and the official source is returned. A rehearsal build uses its feed only when all
 * of its variables are valid (else the official source, which never verifies a rehearsal package).
 */
export function resolveUpdateSource({ testBuild, env }: { testBuild: boolean; env: Record<string, string | undefined> }): UpdateSource {
  if (!testBuild) return OFFICIAL_SOURCE;
  const feed = loopbackFeed(env[TEST_ENV.feed]);
  const publicKey = env[TEST_ENV.publicKey] ?? "";
  const certificate = (env[TEST_ENV.macCertificate] ?? "").replace(/:/g, "").toLowerCase();
  if (!feed || !/^[A-Za-z0-9+/]{43}=$/.test(publicKey) || (certificate && !/^[0-9a-f]{64}$/.test(certificate))) return OFFICIAL_SOURCE;
  const origin = `http://127.0.0.1:${feed.port}`;
  const sameOrigin = (url: URL) => url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port === feed.port && !url.username && !url.password;
  return Object.freeze({
    kind: "test" as const,
    latestApiUrl: `${origin}/repos/${RELEASE_REPOSITORY}/releases/latest`,
    downloadUrl: (tag: string, file: string) => `${origin}${downloadPath(tag)}${file}`,
    // The fake GitHub's own download path, and its stand-in for the asset host (/__assets/…).
    allowsDownloadUrl: (url: URL, tag: string) => sameOrigin(url) && ((url.pathname.startsWith(downloadPath(tag)) && !url.pathname.slice(downloadPath(tag).length).includes("/")) || url.pathname.startsWith("/__assets/")),
    releasePageUrl: (tag: string) => `${origin}/${RELEASE_REPOSITORY}/releases/tag/${tag}`,
    publicKey,
    macCertificateSha256: certificate || OFFICIAL_MAC_CERT_SHA256,
  });
}
