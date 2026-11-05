import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROJECT_HOMEPAGE_URL, UPSTREAM_REPOSITORY_URL } from "./types";
import { uiText } from "./ui/i18n";

/** Every source file of the settings page (sections included), joined. */
function settingsSources() {
  const root = fileURLToPath(new URL("./settings/", import.meta.url));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
  return walk(root).map(file => readFileSync(file, "utf8")).join("\n");
}

describe("About page upstream attribution", () => {
  it("credits the MIT-licensed upstream in every language", () => {
    expect(uiText("zh", "set.ab.credit")).toBe("基于 Langbai NovelAI Studio 改造（MIT 许可）");
    expect(uiText("en", "set.ab.credit")).toBe("Based on Langbai NovelAI Studio (MIT License)");
    expect(UPSTREAM_REPOSITORY_URL).toBe("https://github.com/2786886095/novelai-image-desktop");
  });

  it("links the attribution to the upstream and no longer shows upstream contact or reward details", () => {
    // The About section of the settings page (step 4b2).
    const about = readFileSync(new URL("./settings/sections/AboutSection.tsx", import.meta.url), "utf8");
    expect(about).toContain("t('set.ab.credit')");
    expect(about).toContain("open(UPSTREAM_REPOSITORY_URL)");
    expect(about).toContain("window.naiDesktop.openExternal(url)");
    expect(uiText("zh", "set.ab.credit")).toBe("基于 Langbai NovelAI Studio 改造（MIT 许可）");
    expect(uiText("en", "set.ab.credit")).toBe("Based on Langbai NovelAI Studio (MIT License)");
    // No upstream contact, reward or repository id in the app or anywhere in the settings page.
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    for (const source of [app, settingsSources()]) {
      expect(source).not.toMatch(/921985070|reward-grid|wechat-reward|alipay-reward|aboutAuthor|aboutSupport|aboutProject|onboarding\.github/);
      expect(source.match(/2786886095/g)).toBeNull();
    }
  });

  it("links the project homepage and opens the license and third-party notices from the About page", () => {
    expect(PROJECT_HOMEPAGE_URL).toBe("https://github.com/lwyq1209/mcp-for-novelai");
    const about = readFileSync(new URL("./settings/sections/AboutSection.tsx", import.meta.url), "utf8");
    expect(about).toContain("open(PROJECT_HOMEPAGE_URL)");
    expect(about).toContain("setLegal('license')");
    expect(about).toContain("setLegal('notices')");
    expect(about).toContain("window.naiDesktop.readLegalDocument(kind)");
    for (const key of ["set.ab.home", "set.ab.license", "set.ab.licenseHint", "set.ab.viewLicense", "set.ab.notices", "set.ab.licenseTitle", "set.ab.noticesTitle"] as const) {
      expect(uiText("zh", key), key).not.toBe(uiText("en", key));
      expect(uiText("zh", key), key).not.toBe(key);
    }
    expect(uiText("zh", "set.ab.license")).toContain("MIT");
  });

  it("offers the project homepage again on the first onboarding page", () => {
    const onboarding = readFileSync(new URL("./onboarding/Onboarding.tsx", import.meta.url), "utf8");
    expect(onboarding).toContain("openExternal(PROJECT_HOMEPAGE_URL)");
  });
});
