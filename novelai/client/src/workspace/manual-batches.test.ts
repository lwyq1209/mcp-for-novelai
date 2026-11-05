import { expect, it } from "vitest";
import { imagesAhead, manualBatchesOf, newManualRequestKey } from "./manual-batches";
import type { BatchJob } from "./batch-types";

const batch = (batchId: string, status: BatchJob["status"], items: Array<BatchJob["items"][number]["status"]>, manual = false) =>
  ({ batchId, status, items: items.map((value, index) => ({ index, status: value })), ...(manual ? { source: { kind: "manual", persistent: false } } : {}) }) as unknown as BatchJob;

it("counts the unfinished images that run first, from a newest-first queue view; a paused batch does not count", () => {
  // Newest first, as list_queue and the batch events give it.
  const view = [
    batch("mine", "queued", ["pending", "pending"], true),
    batch("paused", "paused", ["succeeded", "pending", "pending"]),
    batch("running", "running", ["succeeded", "running", "pending"]),
    batch("done", "succeeded", ["succeeded"]),
  ];
  expect(imagesAhead(view)).toBe(4);
  expect(imagesAhead(view, "mine")).toBe(2);
  expect(imagesAhead(view, "running")).toBe(0);
  expect(imagesAhead([])).toBe(0);
  expect(manualBatchesOf(view).map((value) => value.batchId)).toEqual(["mine"]);
  expect(newManualRequestKey()).toMatch(/^manual-[a-f0-9-]{36}$/);
});
