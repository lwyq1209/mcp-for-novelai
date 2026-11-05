import type { GenerationOrigin } from "../types";
import { GENERATION_MODES, isSeededGeneration } from "./generation-types";
import { WorkspaceError } from "./protocol";

export function generationProvenance(value: unknown): GenerationOrigin | undefined {
  if (value === undefined) return undefined;
  const meta = value as GenerationOrigin;
  const validId = (id: unknown) => typeof id === "string" && id.length > 0 && id.length <= 120 && !/[\x00-\x1f]/.test(id);
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || Object.keys(meta).some(key => !["jobId", "mode", "originWorkspaceId", "submittedRevision", "actualSeed"].includes(key))
    || !validId(meta.jobId) || !validId(meta.originWorkspaceId) || !GENERATION_MODES.includes(meta.mode)
    || !Number.isSafeInteger(meta.submittedRevision) || meta.submittedRevision < 0
    || (isSeededGeneration(meta.mode) ? !Number.isSafeInteger(meta.actualSeed) || (meta.actualSeed as number) < 0 : meta.actualSeed !== null)) throw new WorkspaceError("invalid_document", "Invalid generation provenance.");
  return { jobId: meta.jobId, mode: meta.mode, originWorkspaceId: meta.originWorkspaceId, submittedRevision: meta.submittedRevision, actualSeed: meta.actualSeed };
}

/** Undefined means the source has no seed metadata; null means explicitly seedless. */
export function imageActualSeed(source: { generationOrigin?: unknown; actualSeed?: unknown } | null | undefined): number | null | undefined {
  const provenance = generationProvenance(source?.generationOrigin);
  return provenance ? provenance.actualSeed : typeof source?.actualSeed === "number" ? source.actualSeed : undefined;
}
