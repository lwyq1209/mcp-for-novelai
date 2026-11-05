import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../store";
import { DEFAULT_PARAMS } from "../types";
import { createWorkspaceController, type WorkspacePort } from "./controller";
import { pickCreativeState } from "./state";

// Fields this version does not know, in saved UI state or in the live workspace state (here: gallery-shaped fields
// such as a revision counter, a selected post and its tag selection), are ignored: the state loads, reads, drafts
// and applies normally and never exposes them.
const UNKNOWN_FIELDS = {
  galleryRevision: 12,
  gallery: { query: "garden", rating: "e", page: 2, selected: { postId: 42, rating: "e" }, selectedTags: ["garden"], promptMode: "append" },
  gallerySource: { provider: "danbooru", postId: 42, sourceUrl: "https://danbooru.donmai.us/posts/42", target: "vibe", variant: "sample" },
};
const GALLERY_KEYS = /gallery|danbooru|tagSearch/i;

let settings: any;
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  settings = { persistGenerateParams: true, lastGenerationState: null };
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("window", { naiDesktop: {
    setSetting: vi.fn(async (key, value) => { settings[key] = structuredClone(value); }),
    getSettings: vi.fn(async () => structuredClone(settings)), accountCached: vi.fn(async () => ({ hasToken: false })),
    isFirstRun: vi.fn(async () => false), getHistoryDates: vi.fn(async () => []), getHistoryGroups: vi.fn(async () => []),
    getHistory: vi.fn(async () => []), onGenerationPreview: vi.fn(), onUpdateEvent: vi.fn(),
    generate: vi.fn(), saveMetadataSnapshotFromPath: vi.fn(),
  } });
});
afterEach(() => vi.unstubAllGlobals());

describe("unknown fields in creative state", () => {
  it("in saved UI state: the store boots normally, restores the recipe and drops the unknown fields on the next save", async () => {
    settings.lastGenerationState = { params: { ...DEFAULT_PARAMS, positivePrompt: "saved garden" }, charCaptions: [], ...UNKNOWN_FIELDS };
    Object.assign(settings, UNKNOWN_FIELDS);
    await useAppStore.getState().load();
    const state = useAppStore.getState() as unknown as Record<string, unknown>;
    expect(state.bootError).toBeNull();
    expect(useAppStore.getState().params.positivePrompt).toBe("saved garden");
    expect(Object.keys(state).filter(key => GALLERY_KEYS.test(key))).toEqual([]);
    useAppStore.getState().setParam("positivePrompt", "next garden");
    expect(settings.lastGenerationState.params.positivePrompt).toBe("next garden");
    expect(Object.keys(settings.lastGenerationState).filter(key => GALLERY_KEYS.test(key))).toEqual([]);
  });

  it("in the live workspace state: reads, drafts and applies through the real controller without exposing them", async () => {
    useAppStore.setState({ ...UNKNOWN_FIELDS, params: { ...DEFAULT_PARAMS, positivePrompt: "garden" } } as never);
    const port: WorkspacePort = {
      read: () => pickCreativeState(useAppStore.getState()),
      subscribe: listener => useAppStore.subscribe(listener),
      apply: patch => useAppStore.setState(patch),
      validateImages: async () => {},
      readActivity: () => ({ isGenerating: false }),
    };
    const controller = createWorkspaceController(port, "unknown-fields-workspace");
    const read = controller.read();
    expect((read.state as { params: { positivePrompt: string } }).params.positivePrompt).toBe("garden");
    expect(JSON.stringify(read.state)).not.toMatch(/galleryRevision|danbooru/);
    expect(Object.keys(read.capabilities).filter(key => GALLERY_KEYS.test(key))).toEqual([]);
    expect(Object.keys(controller.getView()).filter(key => GALLERY_KEYS.test(key))).toEqual([]);
    // A change of the unknown fields alone is not a creative change.
    useAppStore.setState({ galleryRevision: 13 } as never);
    expect(controller.read().revision).toBe(0);
    const draft = await controller.execute("draft_edit", { workspaceId: "unknown-fields-workspace", expectedRevision: 0, patch: { params: { positivePrompt: "garden at dusk" } } }) as { draftId: string };
    expect(Object.keys(draft).filter(key => GALLERY_KEYS.test(key))).toEqual([]);
    await controller.execute("apply_edit", { workspaceId: "unknown-fields-workspace", expectedRevision: 0, draftId: draft.draftId });
    expect(useAppStore.getState().params.positivePrompt).toBe("garden at dusk");
    controller.dispose();
  });
});
