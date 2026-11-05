// The update source (source.ts): the official addresses, the redirect hosts, and that the rehearsal variables do
// nothing outside a rehearsal build (the marker file) — the lock against a switch that would change the trusted key.
import { describe, expect, it } from "vitest";
import { OFFICIAL_MAC_CERT_SHA256, OFFICIAL_SOURCE, OFFICIAL_UPDATE_PUBLIC_KEY, resolveUpdateSource, TEST_ENV } from "./source";

const testEnv = { [TEST_ENV.feed]: "http://127.0.0.1:43123", [TEST_ENV.publicKey]: "A".repeat(43) + "=", [TEST_ENV.macCertificate]: "ab".repeat(32) };
const allows = (url: string, tag = "v0.1.3", source = OFFICIAL_SOURCE) => source.allowsDownloadUrl(new URL(url), tag);

describe("the official update source", () => {
  it("is this repository's GitHub releases, the built-in key and certificate", () => {
    expect(OFFICIAL_SOURCE.latestApiUrl).toBe("https://api.github.com/repos/lwyq1209/mcp-for-novelai/releases/latest");
    expect(OFFICIAL_SOURCE.downloadUrl("v0.1.3", "SHA256SUMS.txt")).toBe("https://github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/SHA256SUMS.txt");
    expect(OFFICIAL_SOURCE.releasePageUrl("v0.1.3")).toBe("https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.1.3");
    expect(OFFICIAL_SOURCE.publicKey).toBe("Kd4drS/jkRBrI5p6sEUc0clnYHcJ8xQ6RkX+wVJccPw=");
    expect(OFFICIAL_SOURCE.macCertificateSha256).toBe("40:01:B2:F7:73:A1:F2:58:CA:C3:51:59:7A:51:8C:99:24:D2:94:E1:67:D2:98:29:7C:64:CD:40:9E:E6:75:24".replace(/:/g, "").toLowerCase());
  });

  it("downloads only from this release's download folder and GitHub's download hosts, over https", () => {
    expect(allows("https://github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/SHA256SUMS.txt")).toBe(true);
    expect(allows("https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=x")).toBe(true);
    expect(allows("https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2")).toBe(true);
    for (const url of [
      "http://github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip",
      "https://github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.2/a.zip",
      "https://github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/x/a.zip",
      "https://github.com/other/repo/releases/download/v0.1.3/a.zip",
      "https://github.com:8443/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip",
      "https://user:pw@github.com/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip",
      "https://evil.example/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip",
      "https://release-assets.githubusercontent.com.evil.example/x",
      "https://githubusercontent.com/x", "https://raw.githubusercontent.com/x", "http://release-assets.githubusercontent.com/x",
      "http://127.0.0.1:43123/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip",
    ]) expect(allows(url), url).toBe(false);
  });
});

describe("rehearsal builds", () => {
  it("never read the rehearsal variables without the marker file of a rehearsal build", () => {
    expect(resolveUpdateSource({ testBuild: false, env: testEnv })).toBe(OFFICIAL_SOURCE);
    expect(resolveUpdateSource({ testBuild: false, env: { ...process.env, ...testEnv } }).publicKey).toBe(OFFICIAL_UPDATE_PUBLIC_KEY);
  });

  it("use a loopback feed, their key and certificate only when all are valid", () => {
    const source = resolveUpdateSource({ testBuild: true, env: testEnv });
    expect(source.kind).toBe("test");
    expect(source.publicKey).toBe(testEnv[TEST_ENV.publicKey]);
    expect(source.macCertificateSha256).toBe("ab".repeat(32));
    expect(source.latestApiUrl).toBe("http://127.0.0.1:43123/repos/lwyq1209/mcp-for-novelai/releases/latest");
    expect(allows("http://127.0.0.1:43123/lwyq1209/mcp-for-novelai/releases/download/v0.1.3/a.zip", "v0.1.3", source)).toBe(true);
    expect(allows("http://127.0.0.1:43123/__assets/a.zip?token=1", "v0.1.3", source)).toBe(true);
    for (const url of ["http://127.0.0.1:43124/__assets/a.zip", "http://localhost:43123/__assets/a.zip", "http://127.0.0.2:43123/__assets/a.zip", "http://127.0.0.1:43123/elsewhere/a.zip", "https://release-assets.githubusercontent.com/x"])
      expect(allows(url, "v0.1.3", source), url).toBe(false);
    for (const feed of ["http://localhost:43123", "https://127.0.0.1:43123", "http://127.0.0.1", "http://127.0.0.1:43123/path", "http://u@127.0.0.1:43123", "http://10.0.0.1:43123", "nonsense"])
      expect(resolveUpdateSource({ testBuild: true, env: { ...testEnv, [TEST_ENV.feed]: feed } }), feed).toBe(OFFICIAL_SOURCE);
    expect(resolveUpdateSource({ testBuild: true, env: { ...testEnv, [TEST_ENV.publicKey]: "short" } })).toBe(OFFICIAL_SOURCE);
    expect(resolveUpdateSource({ testBuild: true, env: { ...testEnv, [TEST_ENV.macCertificate]: "xyz" } })).toBe(OFFICIAL_SOURCE);
    expect(resolveUpdateSource({ testBuild: true, env: { ...testEnv, [TEST_ENV.macCertificate]: undefined } }).macCertificateSha256).toBe(OFFICIAL_MAC_CERT_SHA256);
  });
});
