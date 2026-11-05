import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VERSION } from "./types";

const client = process.cwd();
const novelai = path.resolve(client, "..");
const repository = path.resolve(novelai, "..");

function readJson(file: string): { version: string } {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
const readText = (file: string) => fs.readFileSync(path.join(repository, file), "utf8");

/** Versions of other software the READMEs may name, each only right after its name (Markdown emphasis allowed). */
const OTHER_VERSIONS: Record<string, RegExp> = {
  // The upstream project this app is based on.
  "2.2.8": /Langbai NovelAI Studio\**\s+2\.2\.8\b/g,
};

// One release version for the desktop app: the client (package.json, which APP_VERSION reads), the MCP server it
// ships (serverInfo.version), the novelai package around both, the newest CHANGELOG entry, and every version the
// READMEs name.
describe("release version consistency", () => {
  it("keeps the client, its MCP server and the novelai package on one version", async () => {
    const clientVersion = readJson(path.join(client, "package.json")).version;
    const novelaiVersion = readJson(path.join(novelai, "package.json")).version;
    const mcp = await import(/* @vite-ignore */ new URL("../../src/mcp.mjs", import.meta.url).href) as { SERVER_VERSION: string };

    expect(clientVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(APP_VERSION).toBe(clientVersion);
    expect(novelaiVersion).toBe(clientVersion);
    expect(mcp.SERVER_VERSION).toBe(clientVersion);
  });

  it("derives the desktop display version instead of hard-coding it", () => {
    const desktopVersionSource = fs.readFileSync(path.join(client, "src", "types.ts"), "utf8");

    expect(desktopVersionSource).toContain(
      'import { version as packageVersion } from "../package.json";',
    );
    expect(desktopVersionSource).toContain(
      "export const APP_VERSION = packageVersion;",
    );
  });

  it("names the package version as the newest CHANGELOG entry", () => {
    const version = readJson(path.join(client, "package.json")).version;
    const entries = [...readText("CHANGELOG.md").matchAll(/^## \[?v?(\d+\.\d+\.\d+)\]?(?=\s|$)/gm)].map(match => match[1]);
    expect(entries.length, "CHANGELOG.md has no '## <version>' entry").toBeGreaterThan(0);
    expect(entries[0]).toBe(version);
    expect(new Set(entries).size, "every version has one CHANGELOG entry").toBe(entries.length);
  });

  it("names no other version of this app in the READMEs", () => {
    const version = readJson(path.join(client, "package.json")).version;
    for (const file of ["README.md", "README.zh-CN.md"]) {
      const text = readText(file);
      // Every x.y.z: this app's version, or another project's version in its allowed place.
      for (const [found] of text.matchAll(/(?<![\d.])\d+\.\d+\.\d+(?![\d.])/g)) {
        if (found === version) continue;
        expect(Object.keys(OTHER_VERSIONS), `${file} names version ${found}`).toContain(found);
      }
      for (const [other, place] of Object.entries(OTHER_VERSIONS)) {
        const all = text.split(other).length - 1;
        expect([...text.matchAll(place)].length, `${file}: ${other} only where it names that project`).toBe(all);
      }
      // Release file names and tags, if a README links them, carry this version.
      for (const match of text.matchAll(/MCP-for-NovelAI-(?:Setup-)?(\d+\.\d+\.\d+)|releases\/tag\/v(\d+\.\d+\.\d+)/g)) expect(match[1] ?? match[2], file).toBe(version);
    }
  });
});
