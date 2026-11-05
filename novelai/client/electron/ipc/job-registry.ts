import crypto from "crypto";

// Each paid generation call (generate/i2i/inpaint/upscale/augment) gets
// its own entry here instead of sharing one module-level AbortController. A
// slow-to-finish older call can no longer null out a newer call's controller
// out from under it, and "stop" cancels every job actually in flight instead
// of whichever one happened to hold a shared reference last.
const jobs = new Map<string, AbortController>();
const isolatedJobs = new Set<string>();
let queueReservation: symbol | null = null;

export function hasActiveGenerationJobs(): boolean {
  return jobs.size > 0 || queueReservation !== null;
}

/** Reserve the paid generation slot before asynchronous queue preparation starts. */
export function reserveQueueGeneration(): () => void {
  if (hasActiveGenerationJobs()) throw Object.assign(new Error("The client is already generating; wait until it ends."), { code: "workspace_busy" });
  const reservation = Symbol("queue-generation");
  queueReservation = reservation;
  return () => { if (queueReservation === reservation) queueReservation = null; };
}

export function beginJob(options?: { signal?: AbortSignal; isolated?: boolean }): { id: string; controller: AbortController; end: () => void } {
  // Every generation runs as a child job of the shared queue (isolated); since step 4a manual generation does too, so
  // nothing else may take the slot the queue reserved.
  if (queueReservation && !options?.isolated) throw Object.assign(new Error("The shared queue holds the generation slot; no request was sent."), { code: "workspace_busy" });
  const id = crypto.randomUUID();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options?.signal?.aborted) controller.abort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.isolated) isolatedJobs.add(id);
  jobs.set(id, controller);
  return {
    id,
    controller,
    end: () => {
      options?.signal?.removeEventListener("abort", onAbort);
      isolatedJobs.delete(id);
      if (jobs.get(id) === controller) jobs.delete(id);
    },
  };
}

export function cancelAllJobs(): boolean {
  let cancelled = false;
  for (const [id, controller] of jobs) {
    if (isolatedJobs.has(id) || controller.signal.aborted) continue;
    // Cancellation is a request, not completion. Keep the slot until the
    // original call's finally/end so late manual saves cannot race a new queue run.
    controller.abort(); cancelled = true;
  }
  return cancelled;
}
