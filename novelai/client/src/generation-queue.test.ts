import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntil } from "./test-support/wait-until";
import { normalizeBatchIntervalSeconds, useAppStore } from "./store";
import type { BatchJob } from "./workspace/batch-types";
import type { ManualItemEvent } from "./workspace/manual-batches";

/**
 * The window's side of manual generation in the shared queue (step 4a): a click is quoted and frozen into one manual
 * batch (manualEnqueue); the host's batch events drive the phases, preview frames and saved images go to the canvas.
 * The host here is a stub that the test drives event by event (electron/manual-queue-e2e.test.ts runs the real one).
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let clock = Date.parse("2026-11-03T10:00:00.000Z");
const at = () => new Date(clock += 5).toISOString();
function batchOf(batchId: string, count: number, status: BatchJob["status"], settled: Array<BatchJob["items"][number]["status"]> = [], activeIndex: number | null = null): BatchJob {
  return { batchId, workspaceId: "recipe-queue", originWorkspaceId: "recipe-queue", submittedRevision: 0, checkpointWorkspaceId: "recipe-queue", checkpointRevision: 0, requestKey: `manual-${batchId}`, execution: "queued", mode: "t2i", count, intervalSeconds: 0, seedMode: "explicit",
    status, activeJobId: activeIndex === null ? null : "job", activeIndex, createdAt: at(), updatedAt: at(), finishedAt: null, error: null, cancelRequested: false, source: { kind: "manual", persistent: false },
    items: Array.from({ length: count }, (_, index) => ({ index, plannedSeed: index, actualSeed: null, requestKey: `batch-${batchId}-${index}`, jobId: null, status: settled[index] ?? (index === activeIndex ? "running" : "pending"), results: [], error: null })) } as BatchJob;
}
const image = (id: string, seed = 33) => ({ id, date: "2026-11-03", createdAt: "2026-11-03T10:00:00.000Z", filePath: `${id}.png`, fileUrl: `local-media://${id}.png`, params: { ...useAppStore.getState().params }, actualSeed: seed, model: "nai-diffusion-5-full", width: 64, height: 64 });
const saved = (batchId: string, item: ReturnType<typeof image>, itemIndex = 0): ManualItemEvent => ({ batchId, requestKey: `manual-${batchId}`, itemIndex, mode: "t2i", status: "succeeded", items: [item as any], actualSeed: item.actualSeed, error: null });

function host() {
  const batchListeners = new Set<(batch: BatchJob) => void>(), itemListeners = new Set<(event: ManualItemEvent) => void>(), previewListeners = new Set<(event: any) => void>();
  let next = 0;
  const api = {
    getSettings: vi.fn().mockResolvedValue({ language: "en-US" }), accountCached: vi.fn().mockResolvedValue({ hasToken: true, anlasBalance: 100 }), isFirstRun: vi.fn().mockResolvedValue(false),
    getHistoryDates: vi.fn().mockResolvedValue([]), getHistoryGroups: vi.fn().mockResolvedValue([]), getHistory: vi.fn().mockResolvedValue([]), getHistoryItems: vi.fn().mockResolvedValue({ order: [], items: [] }),
    onUpdateEvent: () => () => {}, getUpdateStatus: vi.fn().mockResolvedValue(null),
    hasToken: vi.fn().mockResolvedValue({ hasToken: true, anlasBalance: 100, tierName: "Opus" }),
    quoteAnlas: vi.fn().mockResolvedValue({ ok: true, amount: 0, balance: 100 }),
    onQueueBatch: (listener: any) => { batchListeners.add(listener); return () => batchListeners.delete(listener); },
    onManualItem: (listener: any) => { itemListeners.add(listener); return () => itemListeners.delete(listener); },
    onGenerationPreview: (listener: any) => { previewListeners.add(listener); return () => previewListeners.delete(listener); },
    manualEnqueue: vi.fn(async (request: any) => ({ ok: true, result: { batch: { ...batchOf(`b${++next}`, request.count, "queued"), requestKey: request.requestKey }, ahead: 0 } })),
    manualLookup: vi.fn(),
    queueCall: vi.fn(async (method: string, args: any) => ({ ok: true, result: batchOf(args.batchId, 1, method === "cancel_queue" ? "cancelling" : method === "pause_queue" ? "pausing" : "queued", [], 0) })),
  };
  vi.stubGlobal("window", { naiDesktop: api });
  return {
    api,
    batch: (value: BatchJob) => batchListeners.forEach((listener) => listener(structuredClone(value))),
    item: (value: ManualItemEvent) => itemListeners.forEach((listener) => listener(structuredClone(value))),
    preview: (value: any) => previewListeners.forEach((listener) => listener(value)),
  };
}
async function loaded() {
  const h = host();
  await useAppStore.getState().load();
  useAppStore.setState((state) => ({ account: { hasToken: true, anlasBalance: 100, tierName: "Opus" }, params: { ...state.params, positivePrompt: "1girl" }, batchCount: 1 }));
  return h;
}

describe("manual generation in the window", () => {
  beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("normalizes the batch interval the click sends", () => {
    expect(normalizeBatchIntervalSeconds(-2)).toBe(0);
    expect(normalizeBatchIntervalSeconds(2.6)).toBe(3);
    expect(normalizeBatchIntervalSeconds(99999)).toBe(3600);
  });

  it("one click sends its frozen inputs once; the batch events drive preparing, queued, requesting and idle", async () => {
    const h = await loaded();
    const quote = deferred<any>();
    h.api.quoteAnlas.mockReturnValueOnce(quote.promise);
    useAppStore.setState({ batchCount: 3, batchIntervalSeconds: 2 });
    const click = useAppStore.getState().generate();
    expect(useAppStore.getState()).toMatchObject({ generationPhase: "preparing", manualPreparing: true });
    // A second click while the first is being quoted waits for it (no duplicate batch).
    await useAppStore.getState().generate();
    quote.resolve({ ok: true, amount: 3, balance: 100 });
    await click;
    expect(h.api.manualEnqueue).toHaveBeenCalledTimes(1);
    expect(h.api.manualEnqueue.mock.calls[0][0]).toMatchObject({ mode: "t2i", count: 3, intervalSeconds: 2, params: { positivePrompt: "1girl" } });
    expect(useAppStore.getState()).toMatchObject({ manualPreparing: false, isGenerating: false, generationPhase: "queued" });
    h.batch(batchOf("b1", 3, "running", [], 0));
    expect(useAppStore.getState()).toMatchObject({ isGenerating: true, activeGenerationRunId: "b1", generationPhase: "requesting", statusText: "Generating 1/3 (success 0, failed 0, waiting 0)..." });
    h.batch({ ...batchOf("b1", 3, "running", ["succeeded"], null), intervalSeconds: 2 });
    expect(useAppStore.getState().statusText).toBe("Waiting 2s before image 2/3…");
    h.batch(batchOf("b1", 3, "succeeded", ["succeeded", "succeeded", "succeeded"]));
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ manualBatches: [], isGenerating: false, activeGenerationRunId: null, generationPhase: "idle" }));
    await waitUntil(() => expect(useAppStore.getState().statusText).toBe("Batch generation complete: 3 images, spent 0 Anlas."));
  });

  it("the actual-cost placeholder and the settled message are one toast: both carry the batch's toast key (step 4b2)", async () => {
    const h = await loaded();
    const toasts: Array<[string, string]> = [];
    const stop = useAppStore.subscribe((state, previous) => { if (state.toast && (state.toast !== previous.toast || state.toastKey !== previous.toastKey)) toasts.push([state.toast, state.toastKey]); });
    await useAppStore.getState().generate();
    h.batch(batchOf("b1", 1, "running", [], 0));
    h.batch(batchOf("b1", 1, "succeeded", ["succeeded"]));
    await waitUntil(() => expect(toasts.filter(([, key]) => key === "manual-settled:b1")).toHaveLength(2));
    stop();
    const settled = toasts.filter(([, key]) => key === "manual-settled:b1").map(([text]) => text);
    expect(settled).toEqual(["Generation complete; saved 1 image, actual cost updating.", "Generation complete; saved 1 image, spent 0 Anlas."]);
    // Other messages carry no key, so they still stack as before; clearing the toast clears its key.
    useAppStore.getState().setToast("Other");
    expect(useAppStore.getState().toastKey).toBe("");
    useAppStore.getState().clearToast();
    expect(useAppStore.getState()).toMatchObject({ toast: "", toastKey: "" });
  });

  it("a failed click (HTTP 400) shows one toast: the placeholder and the settled failure share the batch key, not two copies (step 4b2)", async () => {
    const h = await loaded();
    const toasts: Array<[string, string]> = [];
    // As the frame does (AppShell): each toast is shown, then cleared from the store.
    const stop = useAppStore.subscribe((state) => { if (state.toast) { toasts.push([state.toast, state.toastKey]); useAppStore.getState().clearToast(); } });
    await useAppStore.getState().generate();
    h.batch(batchOf("b1", 1, "running", [], 0));
    const error = { code: "generation_failed", message: "Image generation failed (HTTP 400): Prompt too long.", reason: "generation.failed_t2i", params: { status: 400, httpZh: "（HTTP 400）", httpEn: " (HTTP 400)", detail: "Prompt too long." } };
    h.item({ batchId: "b1", requestKey: "manual-b1", itemIndex: 0, mode: "t2i", status: "failed", items: [], actualSeed: null, error });
    // The batch ends partly done (2026-12: a failed image no longer stops it with a batch reason).
    h.batch(batchOf("b1", 1, "partial", ["failed"]));
    await waitUntil(() => expect(toasts.filter(([, key]) => key === "manual-settled:b1")).toHaveLength(2));
    stop();
    // Every toast of this click carries the key, so the toast host shows them as one (Toast.tsx replaces in place).
    expect(toasts.every(([, key]) => key === "manual-settled:b1")).toBe(true);
    expect(new Set(toasts.map(([text]) => text))).toEqual(new Set(["Image generation failed (HTTP 400): Prompt too long."]));
  });

  it("keeps the decoded final stream frame visible until the saved image is decoded, and the run open until then", async () => {
    const decoded = deferred<void>();
    const preloaders: any[] = [];
    vi.stubGlobal("Image", class { onload: (() => void) | null = null; onerror: (() => void) | null = null; src = ""; decode = vi.fn(() => decoded.promise); constructor() { preloaders.push(this); } });
    const h = await loaded();
    await useAppStore.getState().generate();
    h.batch(batchOf("b1", 1, "running", [], 0));
    const frame = "data:image/png;base64,final-stream-frame";
    h.preview({ requestId: "b1", progress: 1, currentStep: 28, totalSteps: 28, sampleIndex: 0, imageDataUrl: frame });
    expect(useAppStore.getState()).toMatchObject({ generationPhase: "saving", generationPreview: { imageDataUrl: frame } });
    // A frame of another batch is not this run's.
    h.preview({ requestId: "someone-else", progress: .5, currentStep: 1, totalSteps: 2, sampleIndex: 0, imageDataUrl: "data:image/png;base64,other" });
    expect(useAppStore.getState().generationPreview?.imageDataUrl).toBe(frame);
    const item = image("stream-handoff", 77);
    h.item(saved("b1", item));
    h.batch(batchOf("b1", 1, "succeeded", ["succeeded"]));
    await waitUntil(() => expect(useAppStore.getState().currentImage?.fileUrl).toBe(frame));
    expect(useAppStore.getState().params.seed).toBe(77);
    preloaders[0]?.onload?.(); decoded.resolve();
    await waitUntil(() => expect(useAppStore.getState().currentImage?.fileUrl).toBe(item.fileUrl));
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ isGenerating: false, generationPhase: "idle" }));
  });

  it("without a stream the saving phase and the open run last until the saved image is decoded", async () => {
    const decoded = deferred<void>();
    const preloaders: any[] = [];
    vi.stubGlobal("Image", class { onload: (() => void) | null = null; onerror: (() => void) | null = null; src = ""; decode = vi.fn(() => decoded.promise); constructor() { preloaders.push(this); } });
    const h = await loaded();
    const previous = image("previous");
    useAppStore.setState({ currentImage: previous as any, history: [previous as any] });
    await useAppStore.getState().generate();
    h.batch(batchOf("b1", 1, "running", [], 0));
    const item = image("nonstream-handoff", 88);
    h.item(saved("b1", item));
    h.batch(batchOf("b1", 1, "succeeded", ["succeeded"]));
    await waitUntil(() => expect(preloaders).toHaveLength(1));
    expect(useAppStore.getState()).toMatchObject({ generationPhase: "saving", isGenerating: true });
    expect(useAppStore.getState().currentImage?.id).toBe(previous.id);
    preloaders[0].onload?.(); decoded.resolve();
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ generationPhase: "idle", isGenerating: false }));
    expect(useAppStore.getState().currentImage?.id).toBe(item.id);
  });

  it("a click while a batch runs queues another batch behind it; Pause and Stop act on the current one through the queue", async () => {
    const h = await loaded();
    await useAppStore.getState().generate();
    h.batch(batchOf("b1", 1, "running", [], 0));
    useAppStore.setState((state) => ({ params: { ...state.params, positivePrompt: "second prompt" } }));
    await useAppStore.getState().generate();
    expect(h.api.manualEnqueue).toHaveBeenCalledTimes(2);
    expect(h.api.manualEnqueue.mock.calls[1][0].params.positivePrompt).toBe("second prompt");
    expect(h.api.manualEnqueue.mock.calls[1][0].requestKey).not.toBe(h.api.manualEnqueue.mock.calls[0][0].requestKey);
    expect(useAppStore.getState().manualBatches.map((value) => value.batchId)).toEqual(["b1", "b2"]);
    // The running batch stays this run's while the second waits.
    expect(useAppStore.getState()).toMatchObject({ isGenerating: true, activeGenerationRunId: "b1" });
    await useAppStore.getState().togglePause();
    expect(h.api.queueCall).toHaveBeenLastCalledWith("pause_queue", { batchId: "b1" });
    await useAppStore.getState().cancel();
    expect(h.api.queueCall).toHaveBeenLastCalledWith("cancel_queue", { batchId: "b1" });
    h.batch(batchOf("b1", 1, "cancelled", ["cancelled"]));
    await waitUntil(() => expect(useAppStore.getState().manualBatches.map((value) => value.batchId)).toEqual(["b2"]));
    expect(useAppStore.getState()).toMatchObject({ isGenerating: false, generationPhase: "queued" });
    await waitUntil(() => expect(useAppStore.getState().statusText).toContain("Batch cancelled: 0 succeeded"));
  });

  it("a refusal before anything is queued is said as it came; nothing stays waiting", async () => {
    const h = await loaded();
    h.api.manualEnqueue.mockResolvedValueOnce({ ok: false, error: { code: "invalid_arguments", message: "A manual batch has 1–999 images." } } as any);
    await useAppStore.getState().generate();
    expect(useAppStore.getState()).toMatchObject({ manualBatches: [], manualPreparing: false, generationPhase: "idle", toast: "Not queued: A manual batch has 1–999 images." });
    expect(h.api.manualLookup).not.toHaveBeenCalled();
  });

  it("an image that arrives before the enqueue reply is still shown once the reply names its batch", async () => {
    const h = await loaded();
    const item = image("early", 9);
    h.api.manualEnqueue.mockImplementationOnce(async (request: any) => {
      h.batch({ ...batchOf("early-batch", 1, "running", [], 0), requestKey: request.requestKey });
      h.item(saved("early-batch", item));
      h.batch({ ...batchOf("early-batch", 1, "succeeded", ["succeeded"]), requestKey: request.requestKey });
      return { ok: true, result: { batch: { ...batchOf("early-batch", 1, "queued"), updatedAt: "2026-11-03T09:00:00.000Z", requestKey: request.requestKey }, ahead: 0 } };
    });
    await useAppStore.getState().generate();
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ manualBatches: [], generationPhase: "idle" }));
    expect(useAppStore.getState().currentImage?.id).toBe("early");
  });

  it("previews a clicked history image without loading a source or importing its embedded prompt", async () => {
    const loadImageFromPath = vi.fn().mockResolvedValue({ ok: true, image: { filePath: "history.png", fileUrl: "local-media://history.png", width: 832, height: 1216 }, metadata: { imported: { positivePrompt: "embedded history prompt", seed: 123 }, characterCaptions: [] } });
    vi.stubGlobal("window", { naiDesktop: { loadImageFromPath } });
    const item = { ...image("history-preview", 123), filePath: "history.png", fileUrl: "local-media://history.png", params: { ...useAppStore.getState().params, positivePrompt: "embedded history prompt" } };
    useAppStore.setState((state) => ({ activeTab: "generate", params: { ...state.params, positivePrompt: "keep this editor prompt", seed: 456 }, history: [item as any] }));
    useAppStore.getState().selectImage(item as any);
    useAppStore.getState().setActiveTab("inpaint");
    useAppStore.getState().setActiveTab("postprocess");
    await Promise.resolve();
    expect(loadImageFromPath).not.toHaveBeenCalled();
    expect(useAppStore.getState().workbenchImage).toBeNull();
    expect(useAppStore.getState().currentImage?.id).toBe(item.id);
    expect(useAppStore.getState().params).toMatchObject({ positivePrompt: "keep this editor prompt", seed: 456 });
    await useAppStore.getState().loadWorkbenchFromPath(item.filePath, { restoreMetadata: false });
    expect(loadImageFromPath).toHaveBeenCalledOnce();
    expect(useAppStore.getState().params.positivePrompt).toBe("keep this editor prompt");
  });

  it("a reloaded window takes over its unfinished manual batch: Stop cancels it and its next image comes to the canvas (step 4b3c)", async () => {
    const h = host();
    const running = { ...batchOf("old", 2, "running", ["succeeded"], 1), requestKey: "manual-old" };
    const agent = { ...batchOf("agent", 1, "running", [], 0), source: { kind: "agent", client: null } } as BatchJob;
    h.api.queueCall.mockImplementation((async (method: string, args: any) => method === "list_queue"
      ? { ok: true, result: { batches: [agent, running, batchOf("done", 1, "succeeded", ["succeeded"])], storage: {} } }
      : { ok: true, result: { ...batchOf(args.batchId, 2, "cancelling", ["succeeded"], 1), requestKey: "manual-old" } }) as any);
    await useAppStore.getState().load();
    await waitUntil(() => expect(useAppStore.getState().manualBatches.map((track) => track.batchId)).toEqual(["old"]));
    expect(useAppStore.getState()).toMatchObject({ isGenerating: true, activeGenerationRunId: "old" });
    expect(useAppStore.getState().manualBatches[0]).toMatchObject({ requestKey: "manual-old", done: 1, anlasBefore: null });
    // Its next saved image goes to the canvas, as if this window had clicked it.
    const item = image("after-reload");
    h.item(saved("old", item, 1));
    await waitUntil(() => expect(useAppStore.getState().currentImage?.id).toBe("after-reload"));
    // Stop acts on it (the host's cancel), and its end settles the window.
    await useAppStore.getState().cancel();
    expect(h.api.queueCall).toHaveBeenCalledWith("cancel_queue", { batchId: "old" });
    h.batch({ ...batchOf("old", 2, "cancelled", ["succeeded", "succeeded"]), requestKey: "manual-old" });
    await waitUntil(() => expect(useAppStore.getState()).toMatchObject({ manualBatches: [], isGenerating: false, generationPhase: "idle" }));
    // A second load (a settings refresh) adopts nothing twice.
    await useAppStore.getState().load();
    expect(useAppStore.getState().manualBatches).toEqual([]);
  });
});
