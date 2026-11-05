import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import { isActiveTab, restorableActiveTab } from "./navigation";

// A page id this version does not know (from saved state or a stale caller) opens the generate page instead of
// leaving the main area without any mounted page.
describe("an unknown page id", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));

  it("is not a page, and restores to generate", () => {
    expect(isActiveTab("no-such-page")).toBe(false);
    expect(restorableActiveTab("no-such-page")).toBe("generate");
  });

  it("opens the generate page with its matching canvas surface through the real store action", () => {
    useAppStore.getState().setGenerateMode("i2i");
    useAppStore.getState().setActiveTab("tools");
    expect(useAppStore.getState().activeTab).toBe("tools");
    useAppStore.getState().setActiveTab("no-such-page" as never);
    expect(useAppStore.getState().activeTab).toBe("generate");
    expect(useAppStore.getState().activeCanvasSurface).toBe("generate:i2i");
  });

  it("keeps existing pages unchanged", () => {
    useAppStore.getState().setActiveTab("referencePresets");
    expect(useAppStore.getState().activeTab).toBe("referencePresets");
    useAppStore.getState().setActiveTab(42 as never);
    expect(useAppStore.getState().activeTab).toBe("generate");
  });
});
