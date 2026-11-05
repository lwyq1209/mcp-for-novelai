// LICENSE and THIRD_PARTY_NOTICES.md: the notices file is exactly what scripts/generate-notices.mjs produces from the
// lockfile and the installed packages, it covers what the installers ship, and packaging puts both files in.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The generator is a plain ES module script without type declarations.
import { checkReactIconSets, generateNotices, NOTICES_FILE } from "../scripts/generate-notices.mjs";

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");

describe("license and third-party notices", () => {
  it("keeps THIRD_PARTY_NOTICES.md identical to the generator's output", async () => {
    const generated: string = await generateNotices();
    expect(readFileSync(NOTICES_FILE, "utf8").replace(/\r\n?/g, "\n"), "run npm run notices and commit THIRD_PARTY_NOTICES.md").toBe(generated);
  }, 60_000);

  it("covers Electron, the main-process dependencies, the renderer bundle, sharp with libvips, the MCP bundle and the data", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { dev?: boolean; optional?: boolean; version: string }> };
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || entry.dev) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      expect(notices, name).toContain(`| ${name} | ${entry.version} |`);
    }
    // The renderer bundle's packages are development dependencies (not copied into app.asar/node_modules) and still listed.
    const renderer = notices.slice(notices.indexOf("### 2.2 Renderer bundle"), notices.indexOf("## 3. Image processing binaries"));
    // (@tanstack/react-virtual left the bundle in step 4b1: only the history panel used it, and the new frame no
    // longer mounts that panel. date-fns left it in step 4b3: only the old canvas's status bar formatted a date.)
    for (const name of ["react", "react-dom", "react-icons", "zustand", "@tanstack/react-query", "clsx", "scheduler"]) {
      expect(lock.packages[`node_modules/${name}`], name).toMatchObject({ dev: true });
      expect(renderer, name).toContain(`| ${name} | ${lock.packages[`node_modules/${name}`].version} |`);
    }
    const electron = JSON.parse(read("node_modules/electron/package.json")) as { version: string };
    expect(notices).toContain(`| electron | ${electron.version} | MIT |`);
    expect(notices).toContain("LICENSES.chromium.html");
    expect(notices).toMatch(/LGPL-3\.0-or-later/);
    expect(notices).toContain("https://github.com/libvips/libvips/tree/v");
    expect(notices).toContain("https://github.com/lovell/sharp-libvips/tree/v");
    expect(notices).toContain("GNU LESSER GENERAL PUBLIC LICENSE");
    for (const name of ["@modelcontextprotocol/sdk", "ajv", "zod"]) expect(notices).toMatch(new RegExp(`## 4\\. MCP server bundle[\\s\\S]*\\| ${name.replace("/", "\\/")} \\|`));
    expect(notices).toContain("`electron/data/tag-dictionary.ts`");
    expect(notices).not.toMatch(/source to be confirmed/i);
    for (const file of ["electron/data/tag-dictionary.ts", "src/related-tags.ts", "src/prompt-data.ts"]) {
      expect(notices, file).toMatch(new RegExp("`" + file.replace(/[./]/g, "\\$&") + "`[^\\n]*\\n  Source: Provided with the MIT-licensed source code of the upstream Langbai NovelAI Studio"));
    }
  });

  it("vendors the license files of every library in sharp's libvips, unchanged and with their sources", () => {
    const dir = new URL("../scripts/licenses/sharp-libvips/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as {
      sharpLibvips: string; versions: Record<string, string>; freetypeYear: string; notices: { file: string; sha256: string };
      components: Array<{ id: string; key: string; name: string; version: string; source: string; files: Array<{ file: string; from: string; sha256: string }> }>;
    };
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version: string }> };
    for (const [key, entry] of Object.entries(lock.packages)) if (/node_modules\/@img\/sharp-libvips-/.test(key)) expect(entry.version, key).toBe(manifest.sharpLibvips);
    const sha = (file: string) => createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex");
    expect(sha(manifest.notices.file)).toBe(manifest.notices.sha256);
    // Every library of versions.properties, at its version, plus libnsgif (inside libvips), each with license files.
    expect([...new Set(manifest.components.map(component => component.key))].sort()).toEqual(Object.keys(manifest.versions).sort());
    expect(manifest.components.map(component => component.id)).toContain("libnsgif");
    const notices = read("THIRD_PARTY_NOTICES.md");
    for (const component of manifest.components) {
      expect(component.version, component.name).toBe(manifest.versions[component.key]);
      expect(component.source, component.name).toMatch(/^https:\/\//);
      expect(component.files.length, component.name).toBeGreaterThan(0);
      for (const file of component.files) {
        expect(sha(file.file), file.file).toBe(file.sha256);
        expect(file.from, file.file).toMatch(/^https:\/\//);
      }
      expect(notices, component.name).toContain(`| ${component.name} | ${component.version} |`);
    }
    // cairo with its own LGPL-2.1/MPL-1.1 files and the MPL-2.0 text; the acknowledgements IJG and FreeType require.
    expect(manifest.components.find(component => component.key === "cairo")!.files.map(file => file.file)).toEqual(["cairo/COPYING", "cairo/COPYING-MPL-1.1", "cairo/COPYING-LGPL-2.1", "cairo/MPL-2.0.txt"]);
    expect(notices).toContain("Mozilla Public License Version 2.0");
    expect(notices).toContain("This software is based in part on the work of the Independent JPEG Group.");
    expect(notices).toContain(`Portions of this software are copyright © ${manifest.freetypeYear} The FreeType Project (https://freetype.org). All rights reserved.`);
    expect(notices).toContain("This product includes Gain Map technology under license by Adobe.");
  });

  it("reproduces FreeType's X11-style licenses of its BDF and PCF drivers and fthash", () => {
    const dir = new URL("../scripts/licenses/sharp-libvips/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { components: Array<{ key: string; files: Array<{ file: string; from: string }> }> };
    const freetype = manifest.components.find(component => component.key === "freetype")!;
    expect(freetype.files.map(file => file.file)).toEqual(["freetype/LICENSE.TXT", "freetype/FTL.TXT", "freetype/bdf-README", "freetype/pcf-README", "freetype/fthash.c-license.txt"]);
    expect(freetype.files.find(file => file.file === "freetype/fthash.c-license.txt")!.from).toMatch(/→ src\/base\/fthash\.c \(excerpt: /);
    const notices = read("THIRD_PARTY_NOTICES.md");
    for (const file of ["bdf-README", "pcf-README", "fthash.c-license.txt"]) {
      const text = readFileSync(new URL(`freetype/${file}`, dir), "utf8").replace(/\r\n?/g, "\n");
      expect(text, file).toContain("Permission is hereby granted, free of charge");
      expect(notices, file).toContain(text.split("\n").map(line => line.replace(/\s+$/, "")).join("\n").trim());
    }
    expect(notices).toContain("FreeType is built with its default modules, which include the BDF and PCF font drivers.");
  });

  it("lists every Rust crate compiled into librsvg and the Rust standard library, with their vendored license files", () => {
    const dir = new URL("../scripts/licenses/sharp-libvips/", import.meta.url);
    const manifest = JSON.parse(readFileSync(new URL("manifest.json", dir), "utf8")) as { versions: Record<string, string> };
    const list = JSON.parse(readFileSync(new URL("rsvg-crates.json", dir), "utf8")) as {
      rsvg: string; targets: string[]; workspaceMembers: Array<{ name: string }>;
      rustStd: { commit: string; version: string; files: Array<{ file: string; sha256: string }> };
      crates: Array<{ name: string; version: string; license: string; authors: string[]; targets: string[]; source: string; files: Array<{ file: string; sha256: string }> }>;
    };
    expect(list.rsvg).toBe(manifest.versions.rsvg);
    expect(list.targets).toEqual(["x86_64-unknown-linux-gnu", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-gnu"]);
    expect(list.workspaceMembers.map(member => member.name).sort()).toEqual(["librsvg", "librsvg-c"]);
    expect(list.crates.length).toBeGreaterThan(100);
    const sha = (file: string) => createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex");
    const notices = read("THIRD_PARTY_NOTICES.md");
    const rust = notices.slice(notices.indexOf("### 3.3 Rust code in librsvg"), notices.indexOf("## 4. MCP server bundle"));
    for (const item of list.crates) {
      expect(item.license, item.name).toMatch(/\S/);
      expect(item.targets.length, item.name).toBeGreaterThan(0);
      expect(item.source, item.name).toBe(`https://crates.io/crates/${item.name}/${item.version}`);
      for (const file of item.files) expect(sha(file.file), file.file).toBe(file.sha256);
      expect(rust, item.name).toContain(`| ${item.name} | ${item.version} | ${item.license} |`);
      if (!item.files.length) expect(rust, item.name).toContain(`${item.name} ${item.version} (${item.license}; authors: ${item.authors.join(", ")})`);
    }
    expect(list.rustStd.commit).toMatch(/^787af2b8[0-9a-f]{32}$/);
    expect(list.rustStd.files.map(file => path.basename(file.file))).toEqual(["LICENSE-MIT", "LICENSE-APACHE", "COPYRIGHT"]);
    for (const file of list.rustStd.files) expect(sha(file.file), file.file).toBe(file.sha256);
    expect(rust).toContain(`| Rust standard library | ${list.rustStd.version} (commit ${list.rustStd.commit}) |`);
    expect(rust).toContain("The Rust Project is dual-licensed under Apache 2.0 and MIT");
    expect(notices).toContain("Apache-2.0 WITH LLVM-exception");
  });

  it("vendors the SPDX MIT License text without a copyright line", () => {
    const md5 = createHash("md5").update(readFileSync(new URL("../scripts/licenses/MIT.txt", import.meta.url))).digest("hex");
    expect(md5).toBe("8a52d78d75ab56275fea060db65827ab");
    const text = read("scripts/licenses/MIT.txt");
    expect(text.startsWith("MIT License\n\nPermission is hereby granted, free of charge,")).toBe(true);
    expect(text).not.toMatch(/Copyright/);
  });

  it("refuses a react-icons set other than the Material Design icons the notes name", () => {
    expect(checkReactIconSets()).toEqual(["/md"]);
    const root = mkdtempSync(path.join(os.tmpdir(), "nai-react-icons-"));
    try {
      mkdirSync(path.join(root, "ui"));
      writeFileSync(path.join(root, "ui", "a.tsx"), 'import { MdAdd } from "react-icons/md";\n');
      expect(checkReactIconSets(root)).toEqual(["/md"]);
      writeFileSync(path.join(root, "ui", "b.tsx"), "import { FaBeer } from 'react-icons/fa';\n");
      expect(() => checkReactIconSets(root)).toThrow(/react-icons\/fa, not only react-icons\/md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(read("THIRD_PARTY_NOTICES.md")).toContain("Of react-icons the renderer uses only the Material Design icons (`react-icons/md`)");
  });

  it("vendors the unmodified GNU LGPL and GPL version 3 texts", () => {
    const md5 = (relative: string) => createHash("md5").update(readFileSync(new URL(`../${relative}`, import.meta.url))).digest("hex");
    expect(md5("scripts/licenses/LGPL-3.0.txt")).toBe("3000208d539ec061b899bce1d9ce9404");
    expect(md5("scripts/licenses/GPL-3.0.txt")).toBe("1ebbd3e34237af26da5dc08a4e440464");
  });

  it("licenses the project under MIT with the upstream and this project's copyright lines", () => {
    const license = read("../../LICENSE");
    expect(license.startsWith("MIT License\n\nCopyright (c) 2026 Langbai\nCopyright (c) 2026 lwyq1209\n\nPermission is hereby granted, free of charge,")).toBe(true);
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
    expect(JSON.parse(read("package.json")).license).toBe("MIT");
    expect(JSON.parse(read("../package.json")).license).toBe("MIT");
  });

  it("packages LICENSE, THIRD_PARTY_NOTICES.md and, on macOS, Chromium's notices as resources", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string>; build: { extraResources: Array<{ from: string; to: string }>; mac: { extraResources: Array<{ from: string; to: string }> } } };
    expect(pkg.build.extraResources).toEqual(expect.arrayContaining([{ from: "../../LICENSE", to: "LICENSE" }, { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" }]));
    expect(pkg.build.mac.extraResources).toEqual([{ from: "node_modules/electron/dist/LICENSES.chromium.html", to: "LICENSES.chromium.html" }]);
    for (const script of ["pack:dir", "dist", "dist:mac", "dist:linux"]) expect(pkg.scripts[script], script).toContain("npm run notices:check");
    // Releases are drafted by .github/workflows/release.yml; electron-builder has no publish target (packaging-config.test.ts).
    expect((pkg.build as { publish?: unknown }).publish).toBeNull();
  });
});
