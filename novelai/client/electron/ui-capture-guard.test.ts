// Step 3a review rework (P3-11): UI capture never runs on the real data folder.
import { describe, expect, it } from "vitest";
import { mainWindowSize, uiCaptureLoadOptions, uiCapturePageName, uiCaptureRefusal } from "./ui-capture-guard";

describe("uiCaptureRefusal", () => {
  it("refuses a capture run without NOVELAI_DATA_DIR, with a clear message in English and Chinese", () => {
    for (const env of [{ NAI_UI_CAPTURE_PATH: "/tmp/capture/settings-mcp.png" }, { NAI_UI_CAPTURE_PATH: "x.png", NOVELAI_DATA_DIR: "   " }]) {
      const refusal = uiCaptureRefusal(env);
      expect(refusal).toMatch(/needs its own data folder: set NOVELAI_DATA_DIR/);
      expect(refusal).toMatch(/real data folder was not created or changed/);
      expect(refusal).toContain("请把 NOVELAI_DATA_DIR 设为一个临时文件夹");
    }
  });

  it("lets an isolated capture run and every non-capture run start", () => {
    expect(uiCaptureRefusal({ NAI_UI_CAPTURE_PATH: "/tmp/capture/a.png", NOVELAI_DATA_DIR: "/tmp/capture-data" })).toBeNull();
    expect(uiCaptureRefusal({})).toBeNull();
    expect(uiCaptureRefusal({ NAI_UI_CAPTURE_PATH: "  " })).toBeNull();
  });
});

// Step 4b1: the capture page name reaches the window only in capture mode, and only as a safe name.
describe("uiCapturePageName / uiCaptureLoadOptions", () => {
  it("takes the file name without .png when it is only letters, digits and '-'", () => {
    expect(uiCapturePageName("/tmp/shots/library-detail.png")).toBe("library-detail");
    expect(uiCapturePageName("C:\\shots\\trash-purge-en.PNG")).toBe("trash-purge-en");
    expect(uiCapturePageName("01-generate.png")).toBe("01-generate");
  });

  it("refuses every other name", () => {
    for (const value of ["/tmp/shots/library.detail.png", "/tmp/a b.png", "/tmp/<script>.png", "/tmp/页面.png", "/tmp/library.jpg", "/tmp/.png", "/tmp/x/", `/tmp/${"a".repeat(81)}.png`, "", "   ", undefined]) {
      expect(uiCapturePageName(value as string | undefined), String(value)).toBeNull();
    }
  });

  it("a normal start loads without any query; a capture start adds uiCapturePage (empty when unsafe)", () => {
    expect(uiCaptureLoadOptions(undefined, { uiCapture: "settings" })).toBeUndefined();
    expect(uiCaptureLoadOptions("   ", { uiCapture: "settings" })).toBeUndefined();
    expect(uiCaptureLoadOptions("/tmp/shots/trash.png", { uiCapture: "referencePresets" })).toEqual({ query: { uiCapture: "referencePresets", uiCapturePage: "trash" } });
    expect(uiCaptureLoadOptions("/tmp/shots/bad name.png", { uiCapture: "referencePresets" })).toEqual({ query: { uiCapture: "referencePresets", uiCapturePage: "" } });
  });

  it("main.ts builds its loadFile options only through uiCaptureLoadOptions", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain("uiCaptureLoadOptions(uiCapturePath, {");
    expect(source).not.toMatch(/uiCapturePage\s*:/);
  });
});

describe("mainWindowSize", () => {
  it("is 1440×900 only for a capture under /w1440/, 1120×760 under /compact/, 1385×900 otherwise", () => {
    expect(mainWindowSize("/tmp/shots/w1440/zh/library.png")).toEqual({ width: 1440, height: 900 });
    expect(mainWindowSize("C:\\shots\\W1440\\trash.png")).toEqual({ width: 1440, height: 900 });
    expect(mainWindowSize("/tmp/shots/compact/settings-mcp.png")).toEqual({ width: 1120, height: 760 });
    expect(mainWindowSize("/tmp/shots/dark/01-generate.png")).toEqual({ width: 1385, height: 900 });
    expect(mainWindowSize(undefined)).toEqual({ width: 1385, height: 900 });
    expect(mainWindowSize("  ")).toEqual({ width: 1385, height: 900 });
  });
  it("main.ts sizes the window through it and keeps the minimum size", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
    expect(source).toContain("...mainWindowSize(uiCapturePath),");
    expect(source).toContain("minWidth: 1120,");
    expect(source).toContain("minHeight: 720,");
  });
});
