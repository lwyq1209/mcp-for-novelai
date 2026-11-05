import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "./store";

const gatewayError = () => new Error(
  "Error invoking remote method: <!doctype html><html><body><h1>Bad Gateway</h1><p>Error code 502</p></body></html>",
);

// Every paid action is one click in the shared queue (step 4a). A click whose enqueue reply is lost is looked up
// once with its own requestKey; it is never resent, and the window is not left waiting.
describe("paid image actions recover from a lost enqueue reply", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
  });

  it.each([
    ["文生图", "generate"],
    ["图生图", "generateI2I"],
    ["局部重绘", "inpaint"],
    ["超分", "upscaleCurrentImage"],
    ["后期", "runDirectorTool"],
  ] as const)("%s：回执丢失时用同一个键查一次，不重发", async (_label, actionName) => {
    const manualEnqueue = vi.fn().mockRejectedValue(gatewayError());
    const manualLookup = vi.fn().mockResolvedValue({ ok: true, result: { batch: null, ahead: 0 } });
    const naiDesktop = {
      hasToken: vi.fn().mockResolvedValue({ hasToken: true, anlasBalance: 100, tierName: "Opus" }),
      quoteAnlas: vi.fn().mockResolvedValue({ ok: true, amount: 1, balance: 100 }),
      manualCaptureSource: vi.fn().mockResolvedValue({ ok: true, result: { sourceId: "0b5c6a52-35a8-4a52-9d8e-3c6f4f1b2a01" } }),
      manualEnqueue, manualLookup,
    };
    vi.stubGlobal("window", { naiDesktop });
    useAppStore.setState((state) => ({
      account: { hasToken: true, anlasBalance: 100, tierName: "Opus" },
      settings: { language: "zh-CN" } as any,
      params: { ...state.params, positivePrompt: "1girl" },
      inpaintPositivePrompt: "1girl",
      workbenchImage: { filePath: "source.png", fileUrl: "local-media://source.png", width: 832, height: 1216 },
      inpaintMask: "mask-base64",
    }));

    await (useAppStore.getState()[actionName] as () => Promise<void>)();

    const state = useAppStore.getState();
    expect(manualEnqueue).toHaveBeenCalledTimes(1);
    expect(manualLookup).toHaveBeenCalledExactlyOnceWith(manualEnqueue.mock.calls[0][0].requestKey);
    expect(manualEnqueue.mock.calls[0][0].requestKey).toMatch(/^manual-/);
    expect(state).toMatchObject({ isGenerating: false, manualPreparing: false, manualBatches: [], generationPhase: "idle" });
    expect(state.toast).toContain("没有自动重发");
    expect(state.toast).not.toContain("<html");
  });

  it("a lost reply of a click the host did queue is found by its key and followed", async () => {
    const batch = { batchId: "b-1", requestKey: "", status: "queued", count: 1, items: [{ index: 0, status: "pending", results: [] }], activeIndex: null, updatedAt: "2026-11-03T10:00:00.000Z", source: { kind: "manual", persistent: false } };
    const manualEnqueue = vi.fn().mockRejectedValue(new Error("IPC reply lost"));
    const manualLookup = vi.fn(async (requestKey: string) => ({ ok: true, result: { batch: { ...batch, requestKey }, ahead: 2 } }));
    vi.stubGlobal("window", { naiDesktop: { hasToken: vi.fn().mockResolvedValue({ hasToken: true, anlasBalance: 100 }), quoteAnlas: vi.fn().mockResolvedValue({ ok: true, amount: 0, balance: 100 }), manualEnqueue, manualLookup } });
    useAppStore.setState((state) => ({ account: { hasToken: true, anlasBalance: 100 }, settings: { language: "en-US" } as any, params: { ...state.params, positivePrompt: "1girl" } }));
    await useAppStore.getState().generate();
    expect(manualEnqueue).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().manualBatches.map((value) => value.batchId)).toEqual(["b-1"]);
    expect(useAppStore.getState()).toMatchObject({ generationPhase: "queued", statusText: "Added to the queue; 2 ahead." });
  });
});
