import type { UpstreamReasonFields } from '../types';
import type { GenerationJob, GenerationSnapshot } from "./generation-types";
import type { BatchScene } from "./scene-patch";

/** The scheduler accepts the first four modes; others are reserved for adapters. */
export type BatchMode = "t2i" | "i2i" | "inpaint" | "enhance" | "upscale" | "director";
export type BatchSeedMode = "increment" | "random" | "fixed";
export type BatchStatus = "queued" | "running" | "pausing" | "paused" | "cancelling" | "succeeded" | "cancelled" | "blocked";
export interface BatchRequest {
  workspaceId: string;
  expectedRevision: number;
  requestKey: string;
  execution?: "queued";
  draftId?: string;
  mode: BatchMode;
  count: number;
  intervalSeconds: number;
  seedMode?: BatchSeedMode;
  seeds?: number[];
  scenes?: BatchScene[];
}
export interface BatchItem {
  index: number;
  sceneId?: string;
  authoredSeed?: number;
  authoredSeedMode?: string;
  executionSeedMode?: "fixed";
  plannedSeed: number;
  actualSeed: number | null;
  requestKey: string;
  jobId: string | null;
  status: "pending" | "submitting" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "skipped";
  /** Direct child-executor evidence. Missing on old records means unknown. */
  providerOutcome?: GenerationJob["providerOutcome"];
  results: GenerationJob["results"];
  /**
   * upstream (step 4c1): what NovelAI answered to a failed agent image, cleaned, for the window's queue page; a stored
   * batch from before has none. The bridge drops it and MCP reads an item's code only.
   */
  error: { code: string; message: string; reason?: string; params?: Record<string, string | number>; upstream?: UpstreamReasonFields } | null;
}
/**
 * Who put a batch into the shared queue (step 4a). agent: an MCP enqueue; client is the MCP client's initialize
 * clientInfo (name, version), null when it sent none. manual: a Generate click on this window's canvas; manual
 * batches live only in this run of the app (persistent:false) and are gone after a restart. A stored batch without
 * source predates this field; every batch of that time was an agent batch (read as agent with client null).
 */
export type BatchSource = { kind: "agent"; client: { name: string; version: string | null } | null } | { kind: "manual"; persistent: false };
export const batchSourceOf = (batch: Pick<BatchJob, "source">): BatchSource => batch.source ?? { kind: "agent", client: null };
export interface BatchJob {
  batchId: string;
  workspaceId: string;
  originWorkspaceId: string;
  submittedRevision: number;
  expectedRevision?: number;
  draftId?: string;
  checkpointWorkspaceId: string;
  checkpointRevision: number;
  requestKey: string;
  execution?: "queued";
  mode: BatchMode;
  count: number;
  intervalSeconds: number;
  seedMode: BatchSeedMode | "explicit";
  scenePlanHash?: string;
  status: BatchStatus;
  activeJobId: string | null;
  activeIndex: number | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** reason/params (step 4a): only on a frozen-queue storage stop naming an entry, for the window's own text. */
  error: { code: string; message: string; reason?: string; params?: Record<string, string | number> } | null;
  cancelRequested: boolean;
  items: BatchItem[];
  source?: BatchSource;
}
export type BatchChildJob = Omit<GenerationJob, "mode"> & { mode: BatchMode };
export interface BatchChildRequest { workspaceId: string; expectedRevision: number; requestKey: string; mode: BatchMode }
export interface BatchGenerationPort {
  lookup(args: BatchChildRequest): BatchChildJob | null | Promise<BatchChildJob | null>;
  /** queue: queued batches only — the durable batch item this child runs for (saved as history queueOrigin). */
  /** manual: an item of a manual batch (the window's Generate), run with the manual generation's options. */
  /** manualSource: a manual item's source captured at the click (bytes beside the snapshot, not inside it). */
  submit(args: BatchChildRequest & { snapshot: GenerationSnapshot; queue?: { batchId: string; requestKey: string; itemIndex: number }; manual?: true; manualSource?: { bytes: Uint8Array; mimeType: string }; historySeedMode?: "random" }): BatchChildJob | Promise<BatchChildJob>;
  read(args: { workspaceId: string; jobId: string }): BatchChildJob | Promise<BatchChildJob>;
  cancel(args: { workspaceId: string; jobId: string }): BatchChildJob | Promise<BatchChildJob>;
  subscribe?(listener: (job: BatchChildJob) => void): () => void;
}
/** Images one manual batch (one Generate click of the window) may hold; its item indexes are 0 … MANUAL_BATCH_MAX_ITEMS − 1. */
export const MANUAL_BATCH_MAX_ITEMS = 999;
/** Images one durable queued batch (an agent enqueue) may hold at most, whatever the per-enqueue setting says. */
export const QUEUED_BATCH_MAX_ITEMS = 200;
export const isBatchTerminal = (status: BatchStatus) => ["succeeded", "cancelled", "blocked"].includes(status);
