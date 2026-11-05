import type { UpstreamReasonFields } from '../types';
import type { GenerateExtras, GenerateParams, HistoryItem, I2IParams, NAIInpaintModel, AugmentOptions, DirectorTool } from "../types";

export const GENERATION_MODES = ["t2i", "i2i", "inpaint", "enhance", "upscale", "director"] as const;
export type GenerationMode = typeof GENERATION_MODES[number];
export const isSeededGeneration = (mode: GenerationMode) => mode !== "upscale" && mode !== "director";
export interface PostprocessRecipe {
  recipeScope?: "independent_inpaint";
  enhance?: { magnitude: number; scale: 1 | 2; requestedNoise: number };
  /** Queued recipes take scale 2 only; a manual batch item (the window's Generate) may take 4 (two requests). */
  upscale?: { scale: 2 | 4 };
  director?: { tool: DirectorTool; options: AugmentOptions };
  processing?: { inputWidth: number; inputHeight: number; outputWidth: number; outputHeight: number; resizedInput: boolean; alphaFlattened: boolean };
  unusedInputs?: string[];
}
export type GenerationStatus = "preparing" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface GenerationJob {
  jobId: string;
  workspaceId: string;
  originWorkspaceId: string;
  submittedRevision: number;
  expectedRevision: number;
  requestKey: string;
  draftId?: string;
  mode: GenerationMode;
  status: GenerationStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  model: string;
  actualSeed: number | null;
  providerRequestId: null;
  inputSummary: {
    sampleCount: 1; width: number; height: number; steps: number; sampler: string; cfgScale: number;
    characterCount: number; ignoredBatchCount?: number;
    source?: { width: number; height: number; sha256: string };
  };
  quote: { source: string; amount: number | null };
  /** reason/params (step 4a): the window's catalog message id and values for this failure. */
  error: { code: string; message: string; statusCode?: number; reason?: string; params?: Record<string, string | number>; upstream?: UpstreamReasonFields } | null;
  results: Array<{ index: number; id: string; width: number; height: number; model: string; actualSeed: number | null }>;
  cancelRequested: boolean;
  providerOutcome: "not_submitted" | "unknown" | "response_received";
}

/** Internal-only immutable input. Never returned through the public bridge. */
export interface GenerationSnapshot extends PostprocessRecipe {
  params: GenerateParams;
  extras: GenerateExtras;
  sourceImage?: { mimeType: string; data: string };
  i2i?: I2IParams;
  inpaint?: { model: NAIInpaintModel; maskBase64: string; strength: number; noise: number };
  sourceSummary?: { width: number; height: number; sourceMode: "original" | "latest" };
  batchCount?: number;
  /** Manual upscale only: the source file name at the click (the manual upscale file is named after it). */
  sourceName?: string;
}
export interface GenerationRequest {
  workspaceId: string; expectedRevision: number; requestKey: string; mode: GenerationMode;
  draftId?: string;
}
export interface GenerationResult {
  jobId: string; workspaceId: string; index: number; mimeType: string; data: string;
  originWorkspaceId: string; submittedRevision: number; historyId: string; createdAt: string; providerRequestId: null;
  width: number; height: number; model: string; actualSeed: number | null;
  /** Main → renderer only; removed before returning to the MCP server. */
  historyItem: HistoryItem;
}
/** A refusal names its code, an English message and (step 4a) the reason/params the window renders (src/host-errors). */
export type GenerationResponse<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string; reason?: string; params?: Record<string, string | number> } };
