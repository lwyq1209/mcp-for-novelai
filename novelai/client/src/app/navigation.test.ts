import { describe, expect, it } from "vitest";
import { ACTIVE_TABS, isActiveTab, restorableActiveTab } from "./navigation";

describe("main navigation", () => {
  it("keeps the restorable page ids, the last being referencePresets", () => {
    expect(ACTIVE_TABS.at(-1)).toBe("referencePresets");
  });

  it("validates top-level routes", () => {
    expect(isActiveTab("referencePresets")).toBe(true);
    expect(isActiveTab("upscale")).toBe(false);
    expect(isActiveTab("aitag")).toBe(false);
  });

  it("opens any page id it does not know on the generate page", () => {
    for (const unknown of ["no-such-page", "", 42, null, undefined, {}]) {
      expect(isActiveTab(unknown)).toBe(false);
      expect(restorableActiveTab(unknown)).toBe("generate");
    }
    for (const tab of ACTIVE_TABS) expect(restorableActiveTab(tab)).toBe(tab);
  });
});
