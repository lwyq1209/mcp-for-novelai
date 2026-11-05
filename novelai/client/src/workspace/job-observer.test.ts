import { expect, it, vi } from "vitest";
import { observeGenerationJobs, OBSERVED_JOB_LIMIT } from "./job-observer";
import type { GenerationJob } from "./generation-types";

const job = (jobId: string, status: GenerationJob["status"], ids: string[] = []) => ({ jobId, status, results: ids.map((id, index) => ({ index, id, width: 1, height: 1, model: "m", actualSeed: 1 })) }) as unknown as GenerationJob;

it("re-reads exactly the saved history items of each succeeded job, once, and nothing for other states", async () => {
  let listener!: (value: GenerationJob) => void;
  const unsubscribe = vi.fn();
  const refresh = vi.fn(async () => {});
  const stop = observeGenerationJobs(fn => { listener = fn; return unsubscribe; }, refresh);
  for (const status of ["preparing", "running", "cancelling", "failed", "cancelled", "unknown"] as const) listener(job("a", status, ["ignored"]));
  listener(job("b", "succeeded"));
  expect(refresh).not.toHaveBeenCalled();
  listener(job("a", "succeeded", ["h1", "h2"]));
  listener(job("a", "succeeded", ["h1", "h2"]));
  expect(refresh).toHaveBeenCalledOnce(); expect(refresh).toHaveBeenCalledWith(["h1", "h2"]);
  refresh.mockRejectedValueOnce(new Error("history read failed"));
  listener(job("c", "succeeded", ["h3"]));
  await Promise.resolve();
  expect(refresh).toHaveBeenCalledTimes(2);
  stop(); expect(unsubscribe).toHaveBeenCalledOnce();
});

it("remembers a bounded number of finished jobs", () => {
  let listener!: (value: GenerationJob) => void;
  const refresh = vi.fn(async () => {});
  observeGenerationJobs(fn => { listener = fn; return () => {}; }, refresh);
  for (let index = 0; index <= OBSERVED_JOB_LIMIT; index++) listener(job(`job-${index}`, "succeeded", [`h-${index}`]));
  expect(refresh).toHaveBeenCalledTimes(OBSERVED_JOB_LIMIT + 1);
  listener(job("job-0", "succeeded", ["h-0"]));
  expect(refresh).toHaveBeenCalledTimes(OBSERVED_JOB_LIMIT + 2);
  listener(job(`job-${OBSERVED_JOB_LIMIT}`, "succeeded", ["again"]));
  expect(refresh).toHaveBeenCalledTimes(OBSERVED_JOB_LIMIT + 2);
});
