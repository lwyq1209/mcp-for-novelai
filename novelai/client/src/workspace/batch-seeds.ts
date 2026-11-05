import type { BatchRequest } from "./batch-types";
import type { GenerationSnapshot } from "./generation-types";

export const MAX_BATCH_SEED = 2_147_483_646;
export function isValidBatchSeed(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_BATCH_SEED;
}

/** Validate authored seeds before adopting a draft and again at the host boundary.
 * This does not choose random seeds or change the frozen recipe. */
export function batchSeedInputError(args: BatchRequest, snapshots: GenerationSnapshot[]): string | null {
  const base = snapshots[0].params.seed;
  if (!args.seeds && args.seedMode === "fixed" && snapshots.some(snapshot => !isValidBatchSeed(snapshot.params.seed))) return "固定策略需要每份配方中的有效 seed。";
  if (!args.seeds && args.seedMode === "increment" && !isValidBatchSeed(base)) return "增量策略需要首份配方中的有效起始 seed。";
  if (args.seedMode === "increment" && base + args.count - 1 > MAX_BATCH_SEED) return "增量种子超出有效范围。";
  return null;
}
