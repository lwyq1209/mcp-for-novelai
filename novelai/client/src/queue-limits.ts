/**
 * Queue safety settings (Settings → MCP access → Queue safety). Both are this project's own safety stops for the
 * shared host queue that MCP enqueue_recipes feeds, not NovelAI limits; the frozen-queue disk limits (64 MiB per
 * batch, 512 MiB in total) stay fixed. Shared by the settings store (validation) and the settings UI.
 */
/** queueMaxItemsPerEnqueue: images one enqueue may add. The MCP schema accepts at most QUEUE_ENQUEUE_ITEMS.max. */
export const QUEUE_ENQUEUE_ITEMS = Object.freeze({ default: 20, min: 1, max: 200 });
/** queueMaxPendingItems: unfinished items all queued batches may hold together; null means no limit. */
export const QUEUE_PENDING_ITEMS = Object.freeze({ default: 200, min: 1, max: 100_000 });

/** queueRetentionDays: ended agent batches (with their receipts and the plain recipes only they used) are cleaned once
 * they ended MORE than this many days ago; null = never. The host keeps a small record per cleaned batch, so an old
 * requestKey still answers "accepted, ended, cleaned" (electron/queue-recipe-service.ts QUEUE_RETENTION). */
export const QUEUE_RETENTION_DAYS = Object.freeze({ choices: Object.freeze([7, 30, 90] as const), default: 30 });

const integerIn = (value: unknown, min: number, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

/** A stored value, or the default when it is missing or invalid. */
export function normalizeQueueEnqueueItems(value: unknown): number {
  return integerIn(value, QUEUE_ENQUEUE_ITEMS.min, QUEUE_ENQUEUE_ITEMS.max) ? value : QUEUE_ENQUEUE_ITEMS.default;
}
/** A stored value (null = no limit), or the default when it is missing or invalid. */
export function normalizeQueuePendingItems(value: unknown): number | null {
  if (value === null) return null;
  return integerIn(value, QUEUE_PENDING_ITEMS.min, QUEUE_PENDING_ITEMS.max) ? value : QUEUE_PENDING_ITEMS.default;
}
/** A stored value (null = never), or the default when it is missing or not one of the choices. */
export function normalizeQueueRetentionDays(value: unknown): number | null {
  if (value === null) return null;
  return (QUEUE_RETENTION_DAYS.choices as readonly unknown[]).includes(value) ? value as number : QUEUE_RETENTION_DAYS.default;
}
/** Why a value the user is about to save is refused, or null when it is valid. */
export function queueSettingError(key: "queueMaxItemsPerEnqueue" | "queueMaxPendingItems" | "queueRetentionDays", value: unknown): string | null {
  if (key === "queueRetentionDays") return value === null || (QUEUE_RETENTION_DAYS.choices as readonly unknown[]).includes(value) ? null : `保留天数只能是 ${QUEUE_RETENTION_DAYS.choices.join(" / ")} 天，或选择永不清理。`;
  if (key === "queueMaxItemsPerEnqueue") return integerIn(value, QUEUE_ENQUEUE_ITEMS.min, QUEUE_ENQUEUE_ITEMS.max) ? null : `单次入队最多张数必须是 ${QUEUE_ENQUEUE_ITEMS.min}–${QUEUE_ENQUEUE_ITEMS.max} 的整数。`;
  return value === null || integerIn(value, QUEUE_PENDING_ITEMS.min, QUEUE_PENDING_ITEMS.max) ? null : `排队总数上限必须是 ${QUEUE_PENDING_ITEMS.min}–${QUEUE_PENDING_ITEMS.max} 的整数，或选择不限制。`;
}
