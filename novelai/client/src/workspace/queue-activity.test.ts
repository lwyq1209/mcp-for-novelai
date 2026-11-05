import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS } from "../types";
import { useAppStore } from "../store";
import { createRendererWorkspace } from "./adapter";
import type { GenerationJob } from "./generation-types";
import { waitUntil } from '../test-support/wait-until';

// Busy state (step 3a+, memo risk 2): a queued recipe runs from its frozen input and never reads the canvas, so a
// queue child job must not mark the canvas as generating; apply_edit keeps working while the queue runs. A manual
// generation still marks it busy, and apply_edit is still refused then.
const cleanups: Array<() => void> = [];
beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true);
  useAppStore.setState({ params: { ...DEFAULT_PARAMS, positivePrompt: "a blue ceramic teacup" }, settings: { modelMode: "anime" } as any });
  vi.stubGlobal("document", { querySelector: () => null });
});
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllGlobals(); });

function harness() {
  const listeners = new Set<(job: GenerationJob) => void>();
  const getHistoryItems = vi.fn(async () => []);
  // Only the job events reach the renderer; the canvas has no generation or batch IPC any more.
  vi.stubGlobal("window", { naiDesktop: {
    onGenerationJob: (listener: (job: GenerationJob) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setSetting: vi.fn(async () => {}), getHistoryItems, getHistory: vi.fn(async () => []),
  } });
  const workspace = createRendererWorkspace(); cleanups.push(workspace.dispose);
  const emit = (job: GenerationJob) => listeners.forEach(listener => listener(structuredClone(job)));
  return { workspace, emit, getHistoryItems, identity: () => ({ workspaceId: workspace.getView().workspaceId, expectedRevision: workspace.getView().revision }) };
}

/** A child job of the durable recipe queue, as the host's generation service reports it. */
function queueJob(status: GenerationJob["status"], extra: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date().toISOString();
  return { jobId: "queue-child-1", workspaceId: "recipe-queue", originWorkspaceId: "recipe-queue", submittedRevision: 0, expectedRevision: 0, requestKey: "batch-11111111-1111-4111-8111-111111111111-0",
    mode: "t2i", status, createdAt: now, updatedAt: now, startedAt: now, finishedAt: status === "running" ? null : now, model: DEFAULT_PARAMS.model, actualSeed: 42, providerRequestId: null,
    inputSummary: { sampleCount: 1, width: 832, height: 1216, steps: 28, sampler: "k_euler_ancestral", cfgScale: 5, characterCount: 0 }, quote: { source: "unavailable", amount: null }, error: null, results: [],
    cancelRequested: false, providerOutcome: "unknown", ...extra } as GenerationJob;
}

describe("queue execution and the canvas busy state", () => {
  it("a running queue child does not mark the canvas busy, and apply_edit succeeds meanwhile", async () => {
    const h = harness();
    h.emit(queueJob("running"));
    await Promise.resolve();
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(useAppStore.getState().activeGenerationRunId).toBeNull();
    const draft = await h.workspace.execute("draft_edit", { ...h.identity(), patch: { params: { positivePrompt: "a red ceramic teacup" } } }) as { draftId: string };
    const applied = await h.workspace.execute("apply_edit", { ...h.identity(), draftId: draft.draftId }) as any;
    expect(applied.state.params.positivePrompt).toBe("a red ceramic teacup");
    expect(useAppStore.getState().params.positivePrompt).toBe("a red ceramic teacup");
    // Completion still refreshes the saved history items; it does not replace the canvas or its parameters.
    h.emit(queueJob("succeeded", { results: [{ index: 0, id: "queue-history-1", width: 832, height: 1216, model: DEFAULT_PARAMS.model, actualSeed: 42 }] }));
    await waitUntil(() => expect(h.getHistoryItems).toHaveBeenCalled());
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(useAppStore.getState().currentImage).toBeNull();
    expect(useAppStore.getState().params.seed).toBe(DEFAULT_PARAMS.seed);
  });

  it("apply_edit still refuses to change a locked prompt and keeps the draft", async () => {
    const h = harness();
    useAppStore.setState({ settings: { modelMode: "anime", lockStylePrompt: true } as any });
    const draft = await h.workspace.execute("draft_edit", { ...h.identity(), patch: { params: { stylePrompt: "watercolor" } } }) as { draftId: string };
    await expect(h.workspace.execute("apply_edit", { ...h.identity(), draftId: draft.draftId })).rejects.toMatchObject({ code: "input_locked" });
    expect(h.workspace.getView()).toMatchObject({ revision: 0, draft: { draftId: draft.draftId }, undoAvailable: false });
    expect(useAppStore.getState().params.stylePrompt).toBe(DEFAULT_PARAMS.stylePrompt);
  });

  it("a running manual batch (step 4a: frozen in the shared queue) does not block apply_edit", async () => {
    const h = harness();
    useAppStore.setState({ isGenerating: true, activeGenerationRunId: "manual-run", generationPhase: "requesting" });
    const draft = await h.workspace.execute("draft_edit", { ...h.identity(), patch: { params: { positivePrompt: "a green ceramic teacup" } } }) as { draftId: string };
    // A queue event in the middle neither clears nor takes over the manual run's state.
    h.emit(queueJob("succeeded"));
    await Promise.resolve();
    expect(useAppStore.getState()).toMatchObject({ isGenerating: true, activeGenerationRunId: "manual-run" });
    await h.workspace.execute("apply_edit", { ...h.identity(), draftId: draft.draftId });
    expect(useAppStore.getState()).toMatchObject({ isGenerating: true, activeGenerationRunId: "manual-run" });
    expect(useAppStore.getState().params.positivePrompt).toBe("a green ceramic teacup");
  });
});
