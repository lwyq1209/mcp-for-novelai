import type { GenerationJob } from "./generation-types";

/** How many finished job identities are remembered so a repeated event refreshes nothing twice. */
export const OBSERVED_JOB_LIMIT = 1024;

/**
 * Follows the host's generation job events (the recipe queue's children; the canvas itself no longer generates)
 * and re-reads exactly the history items each succeeded job saved, once per job. It never changes the canvas,
 * its parameters or its activity: a queued recipe runs from its frozen input, so the canvas is not busy meanwhile.
 */
export function observeGenerationJobs(subscribe: (listener: (job: GenerationJob) => void) => () => void, refreshHistoryItems: (ids: readonly string[]) => Promise<void>) {
  const refreshed = new Set<string>();
  return subscribe(job => {
    if (job?.status !== "succeeded" || !Array.isArray(job.results) || !job.results.length || typeof job.jobId !== "string" || refreshed.has(job.jobId)) return;
    refreshed.add(job.jobId);
    if (refreshed.size > OBSERVED_JOB_LIMIT) refreshed.delete(refreshed.values().next().value!);
    void refreshHistoryItems(job.results.map(result => result.id)).catch(() => {});
  });
}
