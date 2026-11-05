// The generated icon set (scripts/build-icons.mjs from build/icon-source/) is complete and wired into packaging,
// the title bar uses the star-only small icon, and no screenshot of the NovelAI website ships any more.
import { existsSync, readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { uiText } from "./ui/i18n";

const file = (path: string) => new URL(`../${path}`, import.meta.url);
const pngSize = (bytes: Buffer) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
/** The PNG images inside an .icns file (iconutil stores every size of a modern iconset as PNG). */
function icnsImages(icns: Buffer): Buffer[] {
  const images: Buffer[] = [];
  for (let offset = 8; offset + 8 <= icns.length;) {
    const length = icns.readUInt32BE(offset + 4);
    const data = icns.subarray(offset + 8, offset + length);
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) images.push(data);
    offset += length;
  }
  return images;
}
/** The box of the pixels that are not fully transparent: [left, top, right, bottom]. */
function opaqueBox(bytes: Buffer): [number, number, number, number] {
  const image = PNG.sync.read(bytes);
  let left = image.width, top = image.height, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return [left, top, right, bottom];
}

describe("brand assets", () => {
  it("has the full icon set at the expected sizes", () => {
    expect(pngSize(readFileSync(file("build/icon.png")))).toEqual({ width: 1024, height: 1024 });
    expect(pngSize(readFileSync(file("public/icon.png")))).toEqual({ width: 512, height: 512 });
    expect(pngSize(readFileSync(file("public/icon-small.png")))).toEqual({ width: 64, height: 64 });
    const icns = readFileSync(file("build/icon.icns"));
    expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const ico = readFileSync(file("build/icon.ico"));
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, index) => ico.readUInt8(6 + 16 * index) || 256);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
    // The small sizes are the star-only variant: no connector element in its source.
    const small = readFileSync(file("build/icon-source/icon-small.svg"), "utf8");
    const full = readFileSync(file("build/icon-source/icon.svg"), "utf8");
    expect(full).toContain("<circle");
    expect(small).not.toMatch(/<circle|M330 330/);
  });

  it("gives the macOS icon Apple's transparent margin and keeps the Windows and Linux icons full-bleed", () => {
    const images = icnsImages(readFileSync(file("build/icon.icns")));
    const sizes = images.map(image => pngSize(image).width);
    // iconutil keeps the 16 px entry in a legacy format; every other size is a PNG.
    expect(sizes).toEqual(expect.arrayContaining([32, 64, 128, 256, 512, 1024]));
    for (const image of images) {
      const { width } = pngSize(image);
      if (width < 128) continue;
      // The rounded square fills 824/1024 of the canvas: a margin of 100/1024 of the size on every side.
      const margin = Math.round((width * 100) / 1024);
      const [left, top, right, bottom] = opaqueBox(image);
      for (const edge of [left, top, width - 1 - right, width - 1 - bottom]) expect(Math.abs(edge - margin), `${width} px`).toBeLessThanOrEqual(1);
    }
    expect(opaqueBox(readFileSync(file("build/icon.png")))).toEqual([0, 0, 1023, 1023]);
    const ico = readFileSync(file("build/icon.ico"));
    const last = 6 + 16 * (ico.readUInt16LE(4) - 1);
    const largest = ico.subarray(ico.readUInt32LE(last + 12), ico.readUInt32LE(last + 12) + ico.readUInt32LE(last + 8));
    expect(opaqueBox(largest)).toEqual([0, 0, 255, 255]);
  });

  it("packages the generated icons and shows the small one in the title bar and as favicon", () => {
    const build = JSON.parse(readFileSync(file("package.json"), "utf8")).build;
    expect(build.mac.icon).toBe("build/icon.icns");
    expect(build.win.icon).toBe("build/icon.ico");
    expect(build.linux.icon).toBe("build/icon.png");
    // Step 4c2: the top bar draws the small brand star (BrandMark); icon-small.png stays the favicon.
    expect(readFileSync(file("src/shell/TopBar.tsx"), "utf8")).toContain("<BrandMark size={18} />");
    expect(readFileSync(file("index.html"), "utf8")).toContain('<link rel="icon" type="image/png" href="/icon-small.png" />');
  });

  it("explains the token in text only, in Chinese and English, without NovelAI website screenshots", () => {
    expect(existsSync(file("public/tutorial"))).toBe(false);
    const app = readFileSync(file("src/App.tsx"), "utf8");
    expect(app).not.toMatch(/tutorial\/|token-step|\.webp/);
    // Step 4c2: the guide is the account section's 如何获取 token steps (set.acc.how1–4), text only.
    const account = readFileSync(file("src/settings/sections/AccountSection.tsx"), "utf8");
    expect(account).not.toMatch(/<img|tutorial\/|\.webp/);
    const steps = ["set.acc.how1", "set.acc.how2", "set.acc.how3", "set.acc.how4"] as const;
    for (const key of steps) for (const lang of ["zh", "en"] as const) expect(uiText(lang, key), `${key} ${lang}`).not.toBe(key);
    expect(JSON.stringify(steps.map(key => uiText("zh", key)))).not.toMatch(/蓝圈/);
    expect(JSON.stringify(steps.map(key => uiText("en", key)))).not.toMatch(/blue circle/i);
    // NovelAI generates the token only after "Overwrite", invalidates the old one and never shows it again.
    expect(uiText("zh", "set.acc.how3")).toMatch(/Overwrite/);
    expect(uiText("en", "set.acc.how3")).toMatch(/Overwrite/);
  });
});
