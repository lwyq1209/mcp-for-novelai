import { describe, expect, it } from "vitest";
import {
  adaptiveNAIImageSize,
  fitNAIImageSize,
  isNAIDimension,
  isNAIImageSize,
  NAI_MAX_PIXEL_AREA,
  NAI_REFERENCE_BUCKETS,
  naiReferenceBucket,
  naiReferencePadSize,
  resolveNAIEnhanceOutputSize,
  snapNAIDimension,
  snapNAIDimensionWithinArea,
} from "./nai-dimensions";

describe("NovelAI custom dimensions", () => {
  it("waits for a completed value, then snaps to the nearest 64 pixels", () => {
    expect(snapNAIDimension(1000)).toBe(1024);
    expect(snapNAIDimension(1025)).toBe(1024);
    expect(snapNAIDimension(1057)).toBe(1088);
    expect(isNAIDimension(1920)).toBe(true);
  });

  it("allows official wallpaper and extreme valid aspect ratios", () => {
    expect(snapNAIDimensionWithinArea(1920, 1088)).toBe(1920);
    expect(snapNAIDimensionWithinArea(4096, 768)).toBe(4096);
    expect(4096 * 768).toBe(NAI_MAX_PIXEL_AREA);
  });

  it("adapts each source image independently", () => {
    expect(adaptiveNAIImageSize(1000, 1300)).toEqual({
      width: 1024,
      height: 1280,
    });
  });

  it("fits oversized images inside the official total-pixel limit", () => {
    const fitted = fitNAIImageSize(4000, 3000);
    expect(isNAIImageSize(fitted)).toBe(true);
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(
      NAI_MAX_PIXEL_AREA,
    );
  });

  it("allows Enhance 2x exactly at the official pixel limit", () => {
    expect(resolveNAIEnhanceOutputSize(1024, 768, 2)).toEqual({
      width: 2048,
      height: 1536,
      exceedsLimit: false,
    });
    expect(2048 * 1536).toBe(NAI_MAX_PIXEL_AREA);
  });

  it("flags an oversized Enhance 2x target instead of silently shrinking it", () => {
    expect(resolveNAIEnhanceOutputSize(832, 1216, 2)).toEqual({
      width: 1664,
      height: 2432,
      exceedsLimit: true,
    });
  });
});

describe("Precise Reference request sizes", () => {
  it("buckets a V5 reference exactly as the official client's function does (values from its build fac57e6)", () => {
    const official: Array<[number, number, ReturnType<typeof naiReferenceBucket>]> = [
      [1024, 1536, {"width": 832, "height": 1216, "resizeWidth": 832, "resizeHeight": 1248, "left": 0, "top": 16, "unchanged": false}],
      [1000, 1500, {"width": 832, "height": 1216, "resizeWidth": 832, "resizeHeight": 1248, "left": 0, "top": 16, "unchanged": false}],
      [832, 1216, {"width": 832, "height": 1216, "resizeWidth": 832, "resizeHeight": 1216, "left": 0, "top": 0, "unchanged": true}],
      [1216, 832, {"width": 1216, "height": 832, "resizeWidth": 1216, "resizeHeight": 832, "left": 0, "top": 0, "unchanged": true}],
      [1024, 1024, {"width": 1024, "height": 1024, "resizeWidth": 1024, "resizeHeight": 1024, "left": 0, "top": 0, "unchanged": true}],
      [1920, 1080, {"width": 1344, "height": 768, "resizeWidth": 1365, "resizeHeight": 768, "left": 10, "top": 0, "unchanged": false}],
      [512, 512, {"width": 1024, "height": 1024, "resizeWidth": 1024, "resizeHeight": 1024, "left": 0, "top": 0, "unchanged": false}],
      [3000, 1000, {"width": 1728, "height": 576, "resizeWidth": 1728, "resizeHeight": 576, "left": 0, "top": 0, "unchanged": false}],
      [100, 4000, {"width": 256, "height": 4096, "resizeWidth": 256, "resizeHeight": 10240, "left": 0, "top": 3072, "unchanged": false}],
      [1, 1, {"width": 1024, "height": 1024, "resizeWidth": 1024, "resizeHeight": 1024, "left": 0, "top": 0, "unchanged": false}],
      [1472, 1472, {"width": 1024, "height": 1024, "resizeWidth": 1024, "resizeHeight": 1024, "left": 0, "top": 0, "unchanged": false}],
      [1536, 1024, {"width": 1216, "height": 832, "resizeWidth": 1248, "resizeHeight": 832, "left": 16, "top": 0, "unchanged": false}],
      [2048, 3072, {"width": 832, "height": 1216, "resizeWidth": 832, "resizeHeight": 1248, "left": 0, "top": 16, "unchanged": false}],
      [850, 1200, {"width": 832, "height": 1216, "resizeWidth": 861, "resizeHeight": 1216, "left": 14, "top": 0, "unchanged": false}],
      [4096, 256, {"width": 4096, "height": 256, "resizeWidth": 4096, "resizeHeight": 256, "left": 0, "top": 0, "unchanged": true}],
      [640, 1600, {"width": 640, "height": 1600, "resizeWidth": 640, "resizeHeight": 1600, "left": 0, "top": 0, "unchanged": true}],
      [1343, 768, {"width": 1344, "height": 768, "resizeWidth": 1344, "resizeHeight": 769, "left": 0, "top": 0, "unchanged": false}],
      [768, 1343, {"width": 768, "height": 1344, "resizeWidth": 769, "resizeHeight": 1344, "left": 0, "top": 0, "unchanged": false}],
    ];
    for (const [width, height, expected] of official) expect(naiReferenceBucket(width, height), `${width}x${height}`).toEqual(expected);
  });

  it("has 97 buckets of 64-pixel steps at about 1 MP, from 256×4096 to 4096×256", () => {
    expect(NAI_REFERENCE_BUCKETS).toHaveLength(97);
    expect(NAI_REFERENCE_BUCKETS[0]).toEqual([256, 4096]);
    expect(NAI_REFERENCE_BUCKETS.at(-1)).toEqual([4096, 256]);
    for (const [width, height] of NAI_REFERENCE_BUCKETS) {
      expect(width % 64 === 0 && height % 64 === 0).toBe(true);
      expect(width * height).toBeLessThanOrEqual(1024 * 1024);
      expect(width * height).toBeGreaterThanOrEqual(851_968);
    }
  });

  it("fits a V4.5 reference into the nearest of the three pad sizes", () => {
    expect(naiReferencePadSize(832, 1216)).toEqual({ width: 1024, height: 1536, fitWidth: 1024, fitHeight: 1497, unchanged: false });
    expect(naiReferencePadSize(1472, 1472)).toEqual({ width: 1472, height: 1472, fitWidth: 1472, fitHeight: 1472, unchanged: true });
    expect(naiReferencePadSize(1920, 1080)).toEqual({ width: 1536, height: 1024, fitWidth: 1536, fitHeight: 864, unchanged: false });
  });
});
