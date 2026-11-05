import { plainErrorMessage } from "../host-errors/bridge";
import { useSyncExternalStore } from "react";
import { isBatchTerminal, type BatchJob, type BatchStatus } from "./batch-types";
import type { GenerationResponse } from "./generation-types";

/** The host queue methods the client's queue panel may call (electron/queue-ui.ts QUEUE_UI_METHODS). */
export type QueueUiMethod = "list_queue" | "pause_queue" | "resume_queue" | "cancel_queue";
export type QueueAction = "pause" | "resume" | "cancel";
export const QUEUE_ACTION_METHODS: Record<QueueAction, QueueUiMethod> = { pause: "pause_queue", resume: "resume_queue", cancel: "cancel_queue" };

export interface QueueMonitorPort {
  call(method: QueueUiMethod, args: Record<string, unknown>): Promise<GenerationResponse<any>>;
  subscribe?(listener: (batch: BatchJob) => void): () => void;
  /** Batches the queue retention removed (ended long ago): they leave the view. */
  subscribeRemoved?(listener: (event: { batchIds: string[] }) => void): () => void;
}
export interface QueueMonitorView {
  /** The host queue has been listed at least once. */
  loaded: boolean;
  /** Newest first, as list_queue returns them. */
  batches: BatchJob[];
  error: string;
  /** The refusal behind error (code, message, reason, params), for rendering in the interface language. */
  failure?: unknown;
  /** Agent batches seen only through host events so far: what the list adds (their project) is still being read. */
  unlisted?: string[];
}
export type QueueMonitor = ReturnType<typeof createQueueMonitor>;

/** Statuses in which the queue holds or is about to release the generation slot. */
const ACTIVE: readonly BatchStatus[] = ["running", "pausing", "cancelling"];
export const queueRunning = (batches: readonly BatchJob[]) => batches.some(batch => ACTIVE.includes(batch.status));

/** Which controls one batch offers; the host still decides (resume only takes a paused batch). */
export function queueActions(batch: Pick<BatchJob, "status" | "cancelRequested">): QueueAction[] {
  const actions: QueueAction[] = [];
  if ((batch.status === "queued" || batch.status === "running") && !batch.cancelRequested) actions.push("pause");
  if (batch.status === "paused") actions.push("resume");
  if (!isBatchTerminal(batch.status) && batch.status !== "cancelling") actions.push("cancel");
  return actions;
}

/** Per-image counts of one batch. */
export function queueProgress(batch: Pick<BatchJob, "count" | "items">) {
  const count = (status: BatchJob["items"][number]["status"]) => batch.items.filter(item => item.status === status).length;
  return { total: batch.count, succeeded: count("succeeded"), failed: count("failed"), unknown: count("unknown"), cancelled: count("cancelled"), skipped: count("skipped"),
    images: batch.items.reduce((sum, item) => sum + (Array.isArray(item.results) ? item.results.length : 0), 0) };
}

const validBatch = (value: unknown): value is BatchJob => Boolean(value) && typeof value === "object" && typeof (value as BatchJob).batchId === "string"
  && typeof (value as BatchJob).status === "string" && Array.isArray((value as BatchJob).items);
/** A later state replaces an earlier one; host events and action replies may arrive in either order. */
const newer = (next: BatchJob, current: BatchJob) => !(typeof next.updatedAt === "string" && typeof current.updatedAt === "string" && next.updatedAt < current.updatedAt);

/**
 * The renderer's read model of the host recipe queue for the queue panel and the "queue running" indicator. It
 * lists with list_queue, follows the host's batch events, and pauses, resumes or cancels one batch with the host's
 * own queue methods; it never changes the canvas and never resubmits anything itself.
 */
/** Waits before reading the list again after a failed read for an unlisted batch (ms), then the last one repeats. */
export const QUEUE_RELIST_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export function createQueueMonitor(port: QueueMonitorPort, options: { readDelayMs?: number; backoffMs?: readonly number[] } = {}) {
  let view: QueueMonitorView = { loaded: false, batches: [], error: "", unlisted: [] };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<QueueMonitorView>) => { view = { ...view, ...next }; listeners.forEach(listener => listener()); };
  // A host batch event carries the batch as the queue runs it, without what list_queue adds to an agent batch (its
  // project: output). A batch first seen through an event is read with the list (review rework 4b2 P2), coalesced:
  // one list for the events of a short while. Until a list succeeds the batch counts as unlisted (its project is
  // shown as being read, never as none); a failed read is tried again with a growing wait (second rework, P3).
  const unlisted = new Set<string>();
  const backoff = options.backoffMs ?? QUEUE_RELIST_BACKOFF_MS;
  let readTimer: ReturnType<typeof setTimeout> | null = null, failedReads = 0;
  const schedule = (delay: number) => {
    if (readTimer) return;
    readTimer = setTimeout(() => {
      readTimer = null;
      void refresh().catch(() => {
        // Still unlisted: read again later (the list succeeding by any other way clears them too).
        if (unlisted.size) schedule(backoff[Math.min(failedReads++, backoff.length - 1)]);
      });
    }, delay);
  };
  const readSoon = (batchId: string) => {
    if (unlisted.has(batchId)) return;
    unlisted.add(batchId);
    publish({ unlisted: [...unlisted] });
    schedule(options.readDelayMs ?? 250);
  };
  function merge(batch: unknown) {
    if (!validBatch(batch)) return;
    const index = view.batches.findIndex(item => item.batchId === batch.batchId);
    if (index < 0) { publish({ batches: [batch, ...view.batches] }); if (batch.source?.kind !== "manual") readSoon(batch.batchId); return; }
    const current = view.batches[index];
    if (!newer(batch, current)) return;
    const batches = view.batches.slice(); batches[index] = { ...current, ...batch }; publish({ batches });
  }
  function drop(event: unknown) {
    const ids = event && typeof event === "object" && Array.isArray((event as { batchIds?: unknown }).batchIds) ? new Set((event as { batchIds: unknown[] }).batchIds.filter((id): id is string => typeof id === "string")) : null;
    if (!ids?.size || !view.batches.some(batch => ids.has(batch.batchId))) return;
    for (const id of ids) unlisted.delete(id);
    publish({ batches: view.batches.filter(batch => !ids.has(batch.batchId)), unlisted: [...unlisted] });
  }
  async function call(method: QueueUiMethod, args: Record<string, unknown>) {
    const response = await port.call(method, args);
    if (!response || response.ok !== true) {
      const error = response && response.ok === false ? response.error : undefined;
      // Code, English message and (step 4a) reason/params: the panel renders it in the interface language (src/host-errors).
      throw Object.assign(new Error(plainErrorMessage(error?.message ?? "", "") || "The queue operation did not complete; refresh the queue to check its state."), { code: error?.code ?? "queue_failed", ...(error?.reason ? { reason: error.reason } : {}), ...(error?.params ? { params: error.params } : {}) });
    }
    return response.result;
  }
  async function act(action: QueueAction, batchId: string) {
    const result = await call(QUEUE_ACTION_METHODS[action], { batchId });
    merge(result);
    return result as BatchJob;
  }
  async function refresh() {
    try {
      const result = await call("list_queue", {});
      const listed: BatchJob[] = Array.isArray(result?.batches) ? result.batches.filter(validBatch) : [];
      // An event that arrived while the list was read is kept when it is the later state.
      const known = new Map(view.batches.map(batch => [batch.batchId, batch]));
      // A successful list answers every unlisted batch: listed ones now carry their project, absent ones are gone.
      unlisted.clear(); failedReads = 0;
      // The later state wins; what only the list names (an agent batch's project) is kept either way.
      publish({ loaded: true, error: "", failure: undefined, unlisted: [], batches: listed.map(batch => { const current = known.get(batch.batchId); return current && !newer(batch, current) ? { ...batch, ...current } : { ...current, ...batch }; }) });
    } catch (error) { publish({ error: plainErrorMessage(error, "The queue could not be read."), failure: error }); throw error; }
  }
  return {
    getView: () => view,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
    pause: (batchId: string) => act("pause", batchId),
    resume: (batchId: string) => act("resume", batchId),
    cancel: (batchId: string) => act("cancel", batchId),
    /** Follows host batch events and lists the queue once; returns the unsubscribe. */
    connect() {
      const remove = port.subscribe?.(merge) ?? (() => {}), removeDropped = port.subscribeRemoved?.(drop) ?? (() => {});
      void refresh().catch(() => {});
      return () => { remove(); removeDropped(); };
    },
  };
}

let shared: QueueMonitor | null | undefined;
/** The window's one queue monitor (null when this preload has no queue bridge, as in older builds or tests). */
export function windowQueueMonitor(): QueueMonitor | null {
  if (shared !== undefined) return shared;
  const api = typeof window === "undefined" ? undefined : window.naiDesktop;
  shared = api && typeof api.queueCall === "function"
    ? createQueueMonitor({ call: (method, args) => api.queueCall(method, args), subscribe: typeof api.onQueueBatch === "function" ? listener => api.onQueueBatch(listener) : undefined,
      subscribeRemoved: typeof api.onQueueRemoved === "function" ? listener => api.onQueueRemoved!(listener) : undefined })
    : null;
  return shared;
}
/** Tests: forget the window monitor. */
const EMPTY: QueueMonitorView = { loaded: false, batches: [], error: "" };
const noSubscribe = () => () => {};
/** The queue view for components (the panel, the indicator beside Generate). */
export function useQueueView(monitor: QueueMonitor | null = windowQueueMonitor()): QueueMonitorView {
  return useSyncExternalStore(monitor ? monitor.subscribe : noSubscribe, monitor ? monitor.getView : () => EMPTY, monitor ? monitor.getView : () => EMPTY);
}
