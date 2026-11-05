import type { AugmentOptions, DirectorTool, GenerateExtras, GenerateParams, HistoryItem, I2IParams, NAIInpaintModel } from "../types";
import { isBatchTerminal, type BatchJob } from "./batch-types";
import type { GenerationStatus } from "./generation-types";

/**
 * Manual generation in the shared queue (step 4a). The window sends one request per Generate click
 * (electron/manual-generation.ts freezes it into a manual batch); the host answers with the batch and how many images
 * run before it, reports every settled image (ManualItemEvent) and streams the running image's preview frames
 * (nai:generationPreview, requestId = batchId).
 */
export type ManualMode = "t2i" | "i2i" | "inpaint" | "upscale" | "director";
export interface ManualGenerationRequest {
  requestKey: string;
  mode: ManualMode;
  count: number;
  intervalSeconds: number;
  params: GenerateParams;
  extras: GenerateExtras;
  i2i?: I2IParams;
  inpaint?: { model: NAIInpaintModel; strength: number; maskBase64: string };
  upscale?: { scale: 2 | 4 };
  director?: { tool: DirectorTool; options: AugmentOptions };
  /** Image modes: the source captured at the click (novelai:manual:capture-source). */
  sourceId?: string;
}
export interface ManualEnqueueReply { batch: BatchJob; ahead: number }
export interface ManualItemEvent {
  batchId: string;
  requestKey: string;
  itemIndex: number;
  mode: ManualMode;
  status: Extract<GenerationStatus, "succeeded" | "failed" | "cancelled" | "unknown">;
  /** The saved images of this request (one for every mode). */
  items: HistoryItem[];
  actualSeed: number | null;
  error: { code: string; message: string; statusCode?: number; reason?: string; params?: Record<string, string | number> } | null;
}

/** One requestKey per click: the same key is looked up after an unanswered enqueue, never replaced. */
export const newManualRequestKey = () => `manual-${crypto.randomUUID()}`;

const unfinished = (batch: Pick<BatchJob, "items">) => batch.items.filter(item => item.status === "pending" || item.status === "submitting" || item.status === "running").length;
const runnable = (batch: Pick<BatchJob, "status">) => !isBatchTerminal(batch.status) && batch.status !== "paused";

/**
 * Images that run before a new click (no batchId) or before batchId, from the queue view (newest first, as
 * list_queue and the batch events give it): the unfinished images of every batch ahead of it that is not paused.
 */
export function imagesAhead(batches: readonly BatchJob[], batchId?: string): number {
  const oldestFirst = [...batches].reverse();
  let ahead = 0;
  for (const batch of oldestFirst) {
    if (batch.batchId === batchId) break;
    if (runnable(batch)) ahead += unfinished(batch);
  }
  return ahead;
}

/** The manual batches the queue shows, oldest first. */
export const manualBatchesOf = (batches: readonly BatchJob[]) => [...batches].reverse().filter(batch => batch.source?.kind === "manual");
