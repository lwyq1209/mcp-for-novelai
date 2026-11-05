import { describe, expect, it } from "vitest";
import {
  buildBinaryInpaintMask,
  buildInpaintMaskPreview,
} from "./inpaint-mask";

function mask(width: number, height: number, points: Array<[number, number]>) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of points) {
    const index = (y * width + x) * 4;
    rgba[index] = 255;
    rgba[index + 1] = 255;
    rgba[index + 2] = 255;
    rgba[index + 3] = 255;
  }
  return buildBinaryInpaintMask(rgba, width, height);
}

describe("buildBinaryInpaintMask", () => {
  it("keeps painted pixels exact instead of expanding them to 64px cells", () => {
    const result = mask(128, 128, [[1, 1], [70, 90]]);
    const redAt = (x: number, y: number) => result.rgba[(y * 128 + x) * 4];
    expect(redAt(1, 1)).toBe(255);
    expect(redAt(70, 90)).toBe(255);
    expect(redAt(2, 1)).toBe(0);
    expect(redAt(64, 64)).toBe(0);
    expect(result.any).toBe(true);
  });

  it("produces a transparent, binary empty mask", () => {
    const result = mask(96, 64, []);
    expect([...result.rgba.slice(0, 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result.any).toBe(false);
  });

  it("normalizes antialiased source pixels to black or white", () => {
    const rgba = new Uint8ClampedArray([12, 12, 12, 40, 0, 0, 0, 0]);
    const result = buildBinaryInpaintMask(rgba, 2, 1);
    expect([...result.rgba]).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
  });

  it("treats opaque black as selected and transparent color as preserved", () => {
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 255,
      255, 0, 0, 0,
    ]);
    const result = buildBinaryInpaintMask(rgba, 2, 1);
    expect([...result.rgba]).toEqual([
      255, 255, 255, 255,
      0, 0, 0, 0,
    ]);
    expect(result.any).toBe(true);
  });
});

describe("buildInpaintMaskPreview", () => {
  it("keeps preserved pixels transparent and colors selected pixels", () => {
    const binary = new Uint8ClampedArray([
      0, 0, 0, 0,
      255, 255, 255, 255,
    ]);
    expect([...buildInpaintMaskPreview(binary, 2, 1, "#7c3aed")]).toEqual([
      0, 0, 0, 0,
      124, 58, 237, 255,
    ]);
  });

  it("keeps pure black and red exact at full preview opacity", () => {
    const binary = new Uint8ClampedArray([255, 255, 255, 255]);
    expect([...buildInpaintMaskPreview(binary, 1, 1, "#000000")])
      .toEqual([0, 0, 0, 255]);
    expect([...buildInpaintMaskPreview(binary, 1, 1, "#ef4444")])
      .toEqual([239, 68, 68, 255]);
  });

  it("rejects incomplete buffers", () => {
    expect(() => buildInpaintMaskPreview(new Uint8ClampedArray(4), 2, 1))
      .toThrow(RangeError);
  });
});

describe("mask cells and invert (step 4b3)", () => {
  it("counts the 8×8 cells that select anything, partial edge cells included", async () => {
    const { countMaskCells } = await import("./inpaint-mask");
    const width = 20, height = 10, rgba = new Uint8ClampedArray(width * height * 4);
    const select = (x: number, y: number) => { rgba[(y * width + x) * 4 + 3] = 255; };
    select(0, 0); select(7, 7); select(8, 0); select(19, 9);
    expect(countMaskCells(rgba, width, height)).toBe(3);
    expect(countMaskCells(new Uint8ClampedArray(16), 2, 2)).toBe(0);
  });
  it("inverts selected and unselected pixels", async () => {
    const { invertMaskPixels } = await import("./inpaint-mask");
    const rgba = new Uint8ClampedArray([9, 9, 9, 255, 0, 0, 0, 0]);
    invertMaskPixels(rgba, "#ef4444");
    expect([...rgba]).toEqual([0, 0, 0, 0, 0xef, 0x44, 0x44, 255]);
  });
});
