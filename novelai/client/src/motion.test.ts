// The Web Animations replacement of the former GSAP tweens (src/motion.ts, used by the reference preset page): same
// offsets, durations and curves, skipped under "Reduce motion", and nothing of GSAP is left in the client.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { animateIn, EASE_OUT_CUBIC, skipMotion } from "./motion";

function fakeElement(style: { opacity: string; transform: string } = { opacity: "1", transform: "none" }) {
  const running = [{ cancel: vi.fn() }];
  const created: Array<{ keyframes: unknown; options: KeyframeAnimationOptions; animation: { onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> } }> = [];
  const element = {
    animate: vi.fn((keyframes: unknown, options: KeyframeAnimationOptions) => {
      const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
      created.push({ keyframes, options, animation });
      return animation;
    }),
    getAnimations: vi.fn(() => running),
  };
  vi.stubGlobal("getComputedStyle", () => style);
  return { element: element as unknown as HTMLElement, running, created };
}
function stubDocument(reduced: boolean) {
  vi.stubGlobal("document", { documentElement: { classList: { contains: (name: string) => reduced && name === "motion-reduced" } } });
}
afterEach(() => vi.unstubAllGlobals());

describe("motion without GSAP", () => {
  it("skips animations when Reduce motion is on or the element cannot animate", () => {
    stubDocument(true);
    expect(skipMotion(fakeElement().element)).toBe(true);
    stubDocument(false);
    expect(skipMotion(fakeElement().element)).toBe(false);
    expect(skipMotion({} as HTMLElement)).toBe(true);
  });

  it("fades and slides in with the former offsets, duration and ease-out curve, replacing a running animation", () => {
    const { element, running, created } = fakeElement();
    animateIn(element, "translateY(-6px) scale(0.985)", 160);
    expect(running[0].cancel).toHaveBeenCalled();
    expect(created[0].keyframes).toEqual([{ opacity: 0, transform: "translateY(-6px) scale(0.985)" }, { opacity: 1, transform: "none" }]);
    expect(created[0].options).toEqual({ duration: 160, easing: EASE_OUT_CUBIC });
    expect(EASE_OUT_CUBIC).toBe("cubic-bezier(0.215, 0.61, 0.355, 1)");
  });

  // Step 4c2: the old select menu (components/ui.tsx) and its exit animation (animateOut) were removed.
  it("drives the reference preset page, and the client no longer depends on GSAP", () => {
    const presets = readFileSync(new URL("./library/ReferencePresets.tsx", import.meta.url), "utf8");
    expect(presets).toContain('animateIn(section, "translateY(10px)", 240)');
    expect(presets).not.toMatch(/gsap/i);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.dependencies).not.toHaveProperty("gsap");
    expect(JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")).packages).not.toHaveProperty("node_modules/gsap");
  });
});
