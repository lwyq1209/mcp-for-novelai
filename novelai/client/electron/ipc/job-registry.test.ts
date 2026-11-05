import { describe, expect, it } from "vitest";
import { beginJob, cancelAllJobs, hasActiveGenerationJobs, reserveQueueGeneration } from "./job-registry";

describe("job-registry", () => {
  it("an older job finishing after a newer one starts does not clear the newer job's controller", () => {
    const a = beginJob();
    const b = beginJob();

    // A finishes late (its own cleanup runs) — this must not touch B.
    a.end();

    expect(b.controller.signal.aborted).toBe(false);
    const cancelled = cancelAllJobs();
    expect(cancelled).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    b.end();
  });

  it("cancelAllJobs aborts every job currently in flight, not just the most recent", () => {
    const a = beginJob();
    const b = beginJob();
    const c = beginJob();

    cancelAllJobs();

    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    expect(c.controller.signal.aborted).toBe(true);
    a.end(); b.end(); c.end();
  });

  it("cancelAllJobs is a no-op that reports nothing-to-cancel when the registry is empty", () => {
    const a = beginJob();
    a.end();

    expect(cancelAllJobs()).toBe(false);
  });

  it("end() is idempotent and never removes a different job with the same id slot reused later", () => {
    const a = beginJob();
    a.end();
    a.end(); // calling twice must not throw or affect anything else

    const b = beginJob();
    expect(cancelAllJobs()).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    b.end();
  });

  it("retains cancelled manual calls until end so a queue run cannot reserve during a late callback", () => {
    const manual = beginJob();
    expect(cancelAllJobs()).toBe(true);
    expect(manual.controller.signal.aborted).toBe(true);
    expect(hasActiveGenerationJobs()).toBe(true);
    expect(() => reserveQueueGeneration()).toThrow(/already generating/);
    expect(cancelAllJobs()).toBe(false);
    manual.end();
    expect(hasActiveGenerationJobs()).toBe(false);
    const release = reserveQueueGeneration();
    expect(hasActiveGenerationJobs()).toBe(true);
    release();
    expect(hasActiveGenerationJobs()).toBe(false);
  });
});
