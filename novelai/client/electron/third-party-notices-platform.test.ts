// THIRD_PARTY_NOTICES.md must come out the same on every build machine: Windows has no @img/sharp-libvips-*
// package, Linux and Intel Macs install other platform packages than this Mac. The generator runs, unchanged, in
// a throwaway copy of the client whose node_modules/@img holds each of those situations, and must find the
// committed file up to date every time; a lockfile whose sharp-libvips version is not the vendored one is refused.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const client = path.resolve(__dirname, "..");
const novelai = path.resolve(client, "..");
const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

/** A copy of the client the generator can run in, with `img(dir)` filling node_modules/@img. */
function copy(img: (dir: string) => void, lock?: (text: string) => string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-notices-platform-"));
  roots.push(root);
  const n = path.join(root, "novelai"), c = path.join(n, "client");
  fs.mkdirSync(path.join(c, "node_modules", "@img"), { recursive: true });
  for (const entry of ["src", "contracts", "node_modules", "package.json"]) fs.symlinkSync(path.join(novelai, entry), path.join(n, entry));
  fs.symlinkSync(path.join(client, "shared"), path.join(c, "shared"));
  // The renderer sources: the generator bundles src/main.tsx to list the renderer bundle's packages.
  fs.symlinkSync(path.join(client, "src"), path.join(c, "src"));
  fs.cpSync(path.join(client, "scripts"), path.join(c, "scripts"), { recursive: true });
  for (const file of ["package.json", "THIRD_PARTY_NOTICES.md", "electron/data/tag-dictionary.ts"]) {
    fs.mkdirSync(path.dirname(path.join(c, file)), { recursive: true });
    fs.copyFileSync(path.join(client, file), path.join(c, file));
  }
  const lockText = fs.readFileSync(path.join(client, "package-lock.json"), "utf8");
  fs.writeFileSync(path.join(c, "package-lock.json"), lock ? lock(lockText) : lockText);
  for (const entry of fs.readdirSync(path.join(client, "node_modules"))) {
    if (entry !== "@img") fs.symlinkSync(path.join(client, "node_modules", entry), path.join(c, "node_modules", entry));
  }
  fs.symlinkSync(path.join(client, "node_modules", "@img", "colour"), path.join(c, "node_modules", "@img", "colour"));
  img(path.join(c, "node_modules", "@img"));
  return c;
}
const check = (dir: string) => spawnSync(process.execPath, ["scripts/generate-notices.mjs", "--check"], { cwd: dir, encoding: "utf8", timeout: 120_000 });
/** A stand-in platform package: a package.json with that name and deliberately different README and versions. */
function fakePackage(dir: string, name: string, version: string) {
  const target = path.join(dir, name.replace("@img/", ""));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, version, license: "LGPL-3.0-or-later" }));
  fs.writeFileSync(path.join(target, "README.md"), "# not the real README\n\n## Licensing\n\nsomething else\n");
  fs.writeFileSync(path.join(target, "versions.json"), JSON.stringify({ vips: "0.0.0" }));
}

describe("third-party notices on other build machines", () => {
  it("are up to date with no sharp platform package installed, as on Windows x64", () => {
    const result = check(copy(() => undefined));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  }, 120_000);

  it("are up to date with the Linux x64 and Intel Mac packages instead of this machine's", () => {
    const linux = check(copy(dir => { fakePackage(dir, "@img/sharp-linux-x64", "0.35.4"); fakePackage(dir, "@img/sharp-libvips-linux-x64", "1.3.3"); }));
    expect(linux.status, linux.stderr).toBe(0);
    const intel = check(copy(dir => { fakePackage(dir, "@img/sharp-darwin-x64", "0.35.4"); fakePackage(dir, "@img/sharp-libvips-darwin-x64", "1.3.3"); }));
    expect(intel.status, intel.stderr).toBe(0);
  }, 120_000);

  it("name no build machine's platform package in the prose", () => {
    const notices = fs.readFileSync(path.join(client, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).not.toMatch(/README of `@img\//);
    // One macOS installer per architecture, each with the darwin pair of its architecture; Windows NSIS, Linux tar.gz.
    expect(notices).toContain("macOS, one installer per architecture (dmg\nand zip), the darwin pair of its architecture");
    expect(notices).toContain("Windows x64 (NSIS installer)");
    expect(notices).toContain("Linux x64\n(tar.gz)");
    expect(notices).not.toMatch(/universal installer|NSIS and portable|\(AppImage\)/);
    // The source code of the libvips libraries comes with every release (.github/workflows/release.yml), Electron's is upstream.
    expect(notices).toContain("provides this source code with\nits installers, as `third-party-sources-<version>.tar.gz`");
    expect(notices).toMatch(/their source code is that\nof Electron v\d+\.\d+\.\d+ \(https:\/\/github\.com\/electron\/electron\/tree\/v\d+\.\d+\.\d+/);
    expect(notices).not.toContain("x64ArchFiles");
  });

  it("refuse a lockfile whose sharp-libvips version is not the vendored one", () => {
    const dir = copy(() => undefined, text => text.replace(/("node_modules\/@img\/sharp-libvips-[^"]+": \{\s*"version": )"1\.3\.3"/g, '$1"1.3.4"'));
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not the vendored 1.3.3");
  }, 120_000);
});
