import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerationService } from "../../electron/generation-service";
import { DEFAULT_PARAMS, type HistoryItem } from "../types";
import { useAppStore } from "../store";
import { createRendererWorkspace } from "./adapter";
import { pickCreativeState, snapshotDocument } from "./state";
import { generationProvenance, imageActualSeed } from "./generation-provenance";
import { waitUntil } from '../test-support/wait-until';

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
const image: HistoryItem = { id: "history-post", filePath: "/fixture/post.png", fileUrl: `data:image/png;base64,${PNG}`, date: "2026-09-10", createdAt: "2026-09-10T12:00:00Z", params: DEFAULT_PARAMS, actualSeed: 0, model: "nai-diffusion-5-curated", width: 1, height: 1 };
const cleanup: Array<() => void> = [];
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  vi.stubGlobal("document", { querySelector: () => null });
  vi.stubGlobal("Image", class {
    naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  });
});
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });

describe("explicit queue seed provenance across the workspace", () => {
  it.each(["upscale", "director"] as const)("preserves %s seedless metadata through service → saved history item → workspace read", async mode => {
    const execute = vi.fn<Parameters<typeof createGenerationService>[0]['execute']>(async () => ({ ok: true, message: "saved fixture", items: [{ ...image, model: mode === "director" ? "director-lineart" : image.model }] }));
    const service = createGenerationService({ execute, validateImage: () => ({ width: 1, height: 1 }), readResult: async () => Buffer.from(PNG, "base64") });
    const job = service.submit({ workspaceId: "original-window", expectedRevision: 9, requestKey: "post", mode,
      snapshot: { params: DEFAULT_PARAMS, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, sourceImage: { mimeType: "image/png", data: PNG }, upscale: { scale: 2 }, director: { tool: "lineart", options: { defry: 0, colorizePrompt: "", emotion: "happy", emotionLevel: 0 } } } });
    await waitUntil(() => expect(service.read({ workspaceId: "w", jobId: job.jobId }).status).toBe("succeeded"));
    expect(execute.mock.calls[0][2].provenance).toMatchObject({ mode, actualSeed: null, originWorkspaceId: "original-window" });
    // The saved history item carries the job's seedless provenance; selected on the canvas it reads back the same.
    const saved = (await service.result({ workspaceId: "w", jobId: job.jobId, index: 0 })).historyItem;
    vi.stubGlobal("window", { naiDesktop: { onGenerationJob: () => () => {} } });
    const workspace = createRendererWorkspace(); cleanup.push(workspace.dispose);
    useAppStore.setState({ currentImage: saved });
    const internal = useAppStore.getState().currentImage!;
    expect(internal.actualSeed).toBe(0); expect(internal.generationOrigin).toMatchObject({ mode, actualSeed: null, jobId: job.jobId });
    const read = workspace.read();
    expect((read.state.currentImage as any).actualSeed).toBeNull(); expect((read.state.currentImage as any).generationOrigin.submittedRevision).toBe(9);
  });

  it("keeps a legitimate generation seed 0 even with the same model name", () => {
    const seeded = { ...image, generationOrigin: { jobId: "seeded-job", mode: "t2i" as const, originWorkspaceId: "w", submittedRevision: 2, actualSeed: 0 } };
    expect(imageActualSeed(seeded)).toBe(0);
    useAppStore.setState({ currentImage: seeded });
    expect((snapshotDocument(pickCreativeState(useAppStore.getState())).state.currentImage as any).actualSeed).toBe(0);
  });

  it("rejects malformed saved provenance instead of inferring mode or publishing extra fields", () => {
    const meta = { jobId: "p", mode: "upscale", originWorkspaceId: "w", submittedRevision: 0, actualSeed: null };
    expect(() => generationProvenance({ ...meta, actualSeed: 0 })).toThrow(/provenance/);
    expect(() => generationProvenance({ ...meta, token: "private" })).toThrow(/provenance/);
    expect(() => generationProvenance({ ...meta, mode: "t2i" })).toThrow(/provenance/);
  });
});
