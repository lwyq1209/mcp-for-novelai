import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import { createWorkspaceController } from "./controller";
import { pickCreativeState, validatePatch } from "./state";
import { freezeGenerationInput } from "./generation-input";

const cleanups: Array<() => void> = [];
beforeEach(() => useAppStore.setState(useAppStore.getInitialState(), true));
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
describe("postprocess recipe patch validation", () => {
  it("accepts supported scalar fields and merges only the chosen Director options", () => {
    const before = pickCreativeState(useAppStore.getState());
    const patch = validatePatch({ enhanceMagnitude: 10, enhanceScale: 2, upscaleScale: 4, directorTool: "colorize", augmentOptions: { defry: 3, colorizePrompt: "blue cotton coat" } }, before);
    expect(patch).toMatchObject({ enhanceMagnitude: 10, enhanceScale: 2, upscaleScale: 4, directorTool: "colorize", augmentOptions: { ...before.augmentOptions, defry: 3, colorizePrompt: "blue cotton coat" } });
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
  });

  it("rejects invalid scalars, unknown tools, noninteger options and extra fields atomically", () => {
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const invalid = [{ enhanceMagnitude: 0 }, { enhanceMagnitude: 11 }, { enhanceMagnitude: 2.5 }, { enhanceScale: 3 }, { upscaleScale: 3 }, { upscaleScale: 1 }, { directorTool: "unknown" }, { augmentOptions: { defry: 6 } }, { augmentOptions: { emotionLevel: -1 } }, { augmentOptions: { emotionLevel: 1.5 } }, { augmentOptions: { emotion: "unknown" } }, { augmentOptions: { colorizePrompt: false } }, { augmentOptions: { token: "must-not-be-accepted" } }];
    for (const patch of invalid) expect(() => validatePatch({ enhanceMagnitude: 4, ...patch }, before)).toThrow();
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
  });

  it("applies a Director draft into the actual frozen recipe and undo restores all prior parameters", async () => {
    useAppStore.setState({ workbenchImage: { filePath: "/fixture/source.png", fileUrl: "local-media://fixture/source.png", width: 256, height: 256 } });
    const before = structuredClone(pickCreativeState(useAppStore.getState()));
    const controller = createWorkspaceController({ read: () => pickCreativeState(useAppStore.getState()), subscribe: (fn) => useAppStore.subscribe(fn), apply: (patch) => useAppStore.setState(patch), validateImages: async () => {}, readActivity: () => ({}) }, "postprocess-fixture");
    cleanups.push(controller.dispose);
    const args = () => ({ workspaceId: "postprocess-fixture", expectedRevision: controller.getView().revision });
    const draft = await controller.execute("draft_edit", { ...args(), patch: { directorTool: "colorize", augmentOptions: { defry: 2, colorizePrompt: "blue cotton coat" } } }) as any;
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
    await controller.execute("apply_edit", { ...args(), draftId: draft.draftId });
    const actual = await freezeGenerationInput(pickCreativeState(useAppStore.getState()), "director", async () => ({ mimeType: "image/png", data: "fixture" }));
    expect(actual.director).toMatchObject({ tool: "colorize", options: { defry: 2, colorizePrompt: "blue cotton coat" } });
    expect(actual.params).toEqual(before.params);
    await controller.execute("undo_edit", args());
    expect(pickCreativeState(useAppStore.getState())).toEqual(before);
  });

  it("preserves the manual 4x preference but refuses using it as a queued single-request upscale", async () => {
    const before = pickCreativeState(useAppStore.getState()), patch = validatePatch({ upscaleScale: 4 }, before);
    const state = { ...before, ...patch, workbenchImage: { filePath: "/fixture/image.png", fileUrl: "fixture", width: 256, height: 256 } };
    await expect(freezeGenerationInput(state, "upscale", async () => ({ mimeType: "image/png", data: "fixture" }))).rejects.toMatchObject({ code: "unsupported_configuration" });
    expect(patch.upscaleScale).toBe(4);
  });
});
