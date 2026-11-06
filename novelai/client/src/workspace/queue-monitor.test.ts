import { describe, expect, it, vi } from "vitest";
import { createQueueMonitor, queueActions, queueProgress, queueRunning, type QueueMonitorPort } from "./queue-monitor";
import type { BatchItem, BatchJob } from "./batch-types";
import { waitUntil } from '../test-support/wait-until';

// The window's queue read model (queue-monitor.ts): what the queue page and the top bar show (step 4c2: the old
// floating panel and the indicator beside Generate were removed with their tests).
const item = (index: number, status: BatchItem["status"], extra: Partial<BatchItem> = {}): BatchItem => ({ index, plannedSeed: 11 + index, actualSeed: status === "succeeded" ? 11 + index : null, requestKey: `k-${index}`, jobId: status === "pending" ? null : `job-${index}`,
  status, results: status === "succeeded" ? [{ index: 0, id: `history-${index}`, width: 64, height: 64, model: "nai-diffusion-4-5-full", actualSeed: 11 + index }] : [], error: null, ...extra });
const batch = (batchId: string, status: BatchJob["status"], items: BatchItem[], extra: Partial<BatchJob> = {}): BatchJob => ({
  batchId, workspaceId: "recipe-queue", originWorkspaceId: "recipe-queue", submittedRevision: 0, checkpointWorkspaceId: "recipe-queue", checkpointRevision: 0, requestKey: `mcp-${batchId}`, execution: "queued",
  mode: "t2i", count: items.length, intervalSeconds: 0, seedMode: "explicit", status, activeJobId: status === "running" ? "job-1" : null, activeIndex: status === "running" ? 1 : null,
  createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z", finishedAt: null, error: null, cancelRequested: status === "cancelling", items, ...extra });

const RUNNING = batch("run-1", "running", [item(0, "succeeded"), item(1, "running")]);
// A batch the user paused (the queue never pauses one by itself any more).
const PAUSED = batch("pause-2", "paused", [item(0, "pending")], { pausedBy: "user" });
// Stored by an older version, which stopped a batch at its first unsuccessful image; still read.
const BLOCKED = batch("block-3", "blocked", [item(0, "succeeded"), item(1, "unknown", { error: { code: "queue_acceptance_unknown", message: "unknown" } }), item(2, "skipped")], { finishedAt: "2026-11-02T10:05:00.000Z", error: { code: "child_unknown", message: "子任务结果未知，批次已停止。" } });
// Ran to its end past a failed image: partly done.
const FAILED = batch("fail-4", "partial", [item(0, "failed", { error: { code: "rate_limited", message: "HTTP 429" } }), item(1, "succeeded")], { finishedAt: "2026-11-02T10:06:00.000Z" });

function port(handlers: Partial<Record<string, (args: any) => any>> = {}) {
  const listeners = new Set<(batch: BatchJob) => void>();
  const call = vi.fn(async (method: string, args: Record<string, unknown>) => {
    const handler = handlers[method];
    if (!handler) return { ok: false as const, error: { code: "batch_not_paused", message: "只有正常暂停的批次可恢复；失败或未知的批次不会重发。" } };
    return { ok: true as const, result: await handler(args) };
  });
  const value: QueueMonitorPort & { emit(batch: BatchJob): void; call: typeof call } = { call, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, emit: next => listeners.forEach(listener => listener(next)) };
  return value;
}

describe("queue monitor", () => {
  it("drops the batches the queue retention removed, and only those (queue retention)", async () => {
    const removed = new Set<(event: { batchIds: string[] }) => void>();
    const h = { ...port({ list_queue: () => ({ batches: [RUNNING, BLOCKED, FAILED] }) }), subscribeRemoved: (listener: (event: { batchIds: string[] }) => void) => { removed.add(listener); return () => removed.delete(listener); } };
    const monitor = createQueueMonitor(h), disconnect = monitor.connect();
    await waitUntil(() => expect(monitor.getView().batches).toHaveLength(3));
    removed.forEach(listener => listener({ batchIds: ["block-3", "fail-4", "not-shown"] }));
    expect(monitor.getView().batches.map(value => value.batchId)).toEqual(["run-1"]);
    removed.forEach(listener => listener({ batchIds: [] })); removed.forEach(listener => listener({ nonsense: true } as any));
    expect(monitor.getView().batches.map(value => value.batchId)).toEqual(["run-1"]);
    disconnect(); expect(removed.size).toBe(0);
  });

  it("lists with list_queue and routes pause, resume and cancel to the host queue methods with only the batchId", async () => {
    const h = port({ list_queue: () => ({ batches: [RUNNING, PAUSED], storage: {} }), pause_queue: ({ batchId }) => ({ ...RUNNING, batchId, status: "pausing", updatedAt: "2026-11-02T10:01:00.000Z" }),
      resume_queue: ({ batchId }) => ({ ...PAUSED, batchId, status: "queued", error: null, updatedAt: "2026-11-02T10:02:00.000Z" }), cancel_queue: ({ batchId }) => ({ ...RUNNING, batchId, status: "cancelling", cancelRequested: true, updatedAt: "2026-11-02T10:03:00.000Z" }) });
    const monitor = createQueueMonitor(h);
    const remove = monitor.connect();
    await waitUntil(() => expect(monitor.getView().loaded).toBe(true));
    expect(h.call).toHaveBeenCalledWith("list_queue", {});
    expect(monitor.getView().batches.map(value => value.batchId)).toEqual(["run-1", "pause-2"]);
    await monitor.pause("run-1");
    await monitor.resume("pause-2");
    await monitor.cancel("run-1");
    expect(h.call.mock.calls.slice(1)).toEqual([["pause_queue", { batchId: "run-1" }], ["resume_queue", { batchId: "pause-2" }], ["cancel_queue", { batchId: "run-1" }]]);
    expect(monitor.getView().batches.map(value => [value.batchId, value.status])).toEqual([["run-1", "cancelling"], ["pause-2", "queued"]]);
    // Host events: a later state replaces, an earlier one is ignored, a new batch comes first.
    h.emit({ ...RUNNING, status: "cancelled", updatedAt: "2026-11-02T10:04:00.000Z" });
    h.emit({ ...RUNNING, status: "running", updatedAt: "2026-11-02T10:00:30.000Z" });
    h.emit({ ...FAILED, batchId: "new-5" });
    expect(monitor.getView().batches.map(value => [value.batchId, value.status])).toEqual([["new-5", "partial"], ["run-1", "cancelled"], ["pause-2", "queued"]]);
    remove();
    h.emit({ ...PAUSED, status: "succeeded", updatedAt: "2026-11-02T11:00:00.000Z" });
    expect(monitor.getView().batches[2].status).toBe("queued");
  });

  it("reads the list once when an event shows an agent batch it has not listed, so its project (output) appears (review rework 4b2 P2)", async () => {
    const output = { historyGroup: "Lighthouse", historyGroupId: "g-1", historyGroupName: "Lighthouse" };
    let listed: BatchJob[] = [RUNNING];
    const h = port({ list_queue: () => ({ batches: listed }) });
    const monitor = createQueueMonitor(h, { readDelayMs: 5 });
    monitor.connect();
    await waitUntil(() => expect(monitor.getView().loaded).toBe(true));
    const fresh = batch("new-9", "queued", [item(0, "pending")], { updatedAt: "2026-11-02T10:10:00.000Z" });
    listed = [{ ...fresh, output } as BatchJob, RUNNING];
    // The event (as the host sends it: no output), then a later event before the list answers.
    h.emit(fresh);
    h.emit({ ...fresh, status: "running", updatedAt: "2026-11-02T10:10:05.000Z" });
    await waitUntil(() => expect((monitor.getView().batches.find(value => value.batchId === "new-9") as any)?.output).toEqual(output));
    // The later event state is kept, with the project from the list; the list is read once for the batch.
    expect(monitor.getView().batches.find(value => value.batchId === "new-9")?.status).toBe("running");
    expect(h.call.mock.calls.filter(([method]) => method === "list_queue")).toHaveLength(2);
    h.emit({ ...fresh, status: "succeeded", updatedAt: "2026-11-02T10:11:00.000Z" });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.call.mock.calls.filter(([method]) => method === "list_queue")).toHaveLength(2);
    expect((monitor.getView().batches.find(value => value.batchId === "new-9") as any)?.output).toEqual(output);
    // A manual batch has no project: no extra list.
    h.emit(batch("manual-1", "queued", [item(0, "pending")], { source: { kind: "manual", persistent: false } }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(h.call.mock.calls.filter(([method]) => method === "list_queue")).toHaveLength(2);
  });

  it("keeps an unlisted agent batch marked while its list read fails, reads again after a wait and clears it on success (second rework, P3)", async () => {
    const output = { historyGroup: "FailProject", historyGroupId: "g-2", historyGroupName: "FailProject" };
    let fail = false, listed: BatchJob[] = [RUNNING];
    const h = port({ list_queue: () => { if (fail) throw new Error("list down"); return { batches: listed }; } });
    // A handler that throws answers like a refusal (the port turns the throw into ok:false below).
    const call = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (method: string, args: Record<string, unknown>) => {
      if (method === "list_queue" && fail) return { ok: false as const, error: { code: "queue_unavailable", message: "down" } };
      return call(method, args);
    });
    const monitor = createQueueMonitor(h, { readDelayMs: 5, backoffMs: [20, 40] });
    monitor.connect();
    await waitUntil(() => expect(monitor.getView().loaded).toBe(true));
    fail = true;
    const fresh = batch("new-7", "queued", [item(0, "pending")], { updatedAt: "2026-11-02T10:20:00.000Z" });
    listed = [{ ...fresh, output } as BatchJob, RUNNING];
    h.emit(fresh);
    expect(monitor.getView().unlisted).toEqual(["new-7"]);
    // The read fails: still unlisted (shown as being read), and read again after the wait.
    await waitUntil(() => expect(h.call.mock.calls.filter(([method]) => method === "list_queue").length).toBeGreaterThanOrEqual(3));
    expect(monitor.getView().unlisted).toEqual(["new-7"]);
    expect((monitor.getView().batches.find(value => value.batchId === "new-7") as any)?.output).toBeUndefined();
    fail = false;
    await waitUntil(() => expect((monitor.getView().batches.find(value => value.batchId === "new-7") as any)?.output).toEqual(output));
    expect(monitor.getView().unlisted).toEqual([]);
    const calls = h.call.mock.calls.length;
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(h.call.mock.calls.length).toBe(calls); // no more reads once listed
  });

  it("surfaces a host refusal with its own code and message and changes nothing", async () => {
    const h = port({ list_queue: () => ({ batches: [BLOCKED] }) });
    const monitor = createQueueMonitor(h); await monitor.refresh();
    await expect(monitor.resume("block-3")).rejects.toMatchObject({ code: "batch_not_paused", message: expect.stringContaining("不会重发") });
    expect(monitor.getView().batches).toEqual([BLOCKED]);
  });

  it("offers pause/resume/cancel by status and counts the images of a batch", () => {
    expect(queueActions({ status: "queued", cancelRequested: false })).toEqual(["pause", "cancel"]);
    expect(queueActions({ status: "running", cancelRequested: false })).toEqual(["pause", "cancel"]);
    expect(queueActions({ status: "pausing", cancelRequested: false })).toEqual(["cancel"]);
    expect(queueActions({ status: "paused", cancelRequested: false })).toEqual(["resume", "cancel"]);
    for (const status of ["cancelling", "succeeded", "partial", "cancelled", "blocked"] as const) expect(queueActions({ status, cancelRequested: status === "cancelling" })).toEqual([]);
    expect(queueProgress(BLOCKED)).toEqual({ total: 3, succeeded: 1, failed: 0, unknown: 1, cancelled: 0, skipped: 1, images: 1 });
    expect(queueRunning([PAUSED, BLOCKED])).toBe(false);
    expect(queueRunning([PAUSED, RUNNING])).toBe(true);
    expect(queueRunning([{ ...RUNNING, status: "pausing" }])).toBe(true);
  });
});
