import { describe, expect, it } from "vitest";
import { canonicalizeWorkspaceMask } from "./mask-format";

describe("workspace mask pixel format", () => {
  it("turns opaque black, white and grayscale pixels into a bounded alpha selection", () => {
    const result = canonicalizeWorkspaceMask(new Uint8ClampedArray([
      0, 0, 0, 255, 255, 255, 255, 255,
      127, 127, 127, 255, 128, 128, 128, 255,
    ]), 2, 2);
    expect(result.interpretation).toBe("luminance");
    expect([...result.rgba]).toEqual([
      0, 0, 0, 0, 255, 255, 255, 255,
      0, 0, 0, 0, 255, 255, 255, 255,
    ]);
    expect(result.changed).toBe(true);
  });

  it("uses alpha for an existing transparent mask, including opaque black selections", () => {
    const result = canonicalizeWorkspaceMask(new Uint8ClampedArray([
      255, 255, 255, 0, 0, 0, 0, 255,
      30, 90, 180, 128, 10, 20, 30, 0,
    ]), 2, 2);
    expect(result.interpretation).toBe("alpha");
    expect([...result.rgba]).toEqual([
      0, 0, 0, 0, 255, 255, 255, 255,
      255, 255, 255, 255, 0, 0, 0, 0,
    ]);
  });

  it("is idempotent so an already canonical PNG need not be encoded again", () => {
    const pixels = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255]);
    const result = canonicalizeWorkspaceMask(pixels, 2, 1);
    expect(result.changed).toBe(false);
    expect(result.rgba).toEqual(pixels);
  });
});
