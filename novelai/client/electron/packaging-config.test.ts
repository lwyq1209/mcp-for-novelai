import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// electron-builder configuration (package.json "build"), as the release workflow (.github/workflows/release.yml) and
// its check (.github/scripts/packaged-app-check.mjs) rely on it.
const manifest = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string>; build: Record<string, any> };
const build = manifest.build;

describe("packaging configuration", () => {
  it("never publishes from electron-builder: no publish target (no app-update.yml or latest*.yml) and --publish never in every packaging script", () => {
    expect(build.publish).toBeNull();
    for (const script of ["pack:dir", "dist", "dist:mac", "dist:linux"]) expect(manifest.scripts[script], script).toMatch(/electron-builder .*--publish never$/);
  });

  it("names every artifact with the version, the OS and the architecture", () => {
    expect(build.artifactName).toBe("MCP-for-NovelAI-${version}-${os}-${arch}.${ext}");
    expect(build.nsis.artifactName).toBe("MCP-for-NovelAI-${version}-win-${arch}-setup.${ext}");
    // Platform and target sections inherit the top-level name (the NSIS installer only adds its suffix).
    for (const section of ["mac", "dmg", "linux", "win"]) expect(build[section]?.artifactName, section).toBeUndefined();
  });

  it("ships only installers that run from a fixed place, so agent configurations stay valid", () => {
    // Windows: the NSIS installer only (a portable .exe runs from a new temporary folder on every launch).
    expect(build.win.target).toEqual(["nsis"]);
    expect(build).not.toHaveProperty("portable");
    expect(manifest.scripts.dist).toContain("electron-builder --win nsis ");
    // Linux: a tar.gz to extract to a fixed folder (an AppImage runs from a new mount point on every launch).
    expect(build.linux.target).toEqual(["tar.gz"]);
    expect(manifest.scripts["dist:linux"]).toContain("electron-builder --linux tar.gz ");
  });

  it("builds macOS per architecture (the arch comes from the command line), ad-hoc signed without a Gatekeeper assessment", () => {
    expect(build.mac.target).toEqual(["dmg", "zip"]);
    expect(build.mac).not.toHaveProperty("x64ArchFiles");
    expect(build.mac).toMatchObject({ identity: "-", hardenedRuntime: false, gatekeeperAssess: false });
  });

  it("keeps the app in app.asar but unpacks sharp's native addon and libvips (Linux ships libvips-cpp.so.<version>, which smart unpacking misses)", () => {
    expect(build.asar).toBe(true);
    expect(build.asarUnpack).toEqual(["**/node_modules/@img/sharp-*/**/*"]);
    expect(build.npmRebuild).toBe(false);
  });

  it("ships the MCP bundle next to app.asar, where ELECTRON_RUN_AS_NODE=1 <app executable> can run it", () => {
    expect(build.extraResources).toEqual(expect.arrayContaining([{ from: "dist-mcp", to: "mcp", filter: ["novelai-mcp.mjs"] }]));
    expect(build.files).toEqual(expect.arrayContaining(["dist/**", "dist-electron/**", "package.json"]));
  });
});
