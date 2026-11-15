/**
 * The client's two queue safety settings as the app publishes them for this server:
 * <data root>/runtime/queue-limits.json {schemaVersion:1, maxItemsPerEnqueue, maxPendingItems} (the app writes it at
 * start and whenever the user changes a setting; client/electron/queue-limits-file.ts). tools/list is answered outside
 * any tool call and often while the app is not running, so the limits cannot come over the bridge; the file holds the
 * two numbers and nothing else. They are only text for the enqueue_recipes description: the app checks its own
 * settings at every enqueue, never this file.
 */
import { readFileSync, unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';
import { resolveDataPaths } from './data-paths.mjs';

export const QUEUE_LIMITS_FILE = 'queue-limits.json';
/** The ranges of the settings (client/src/queue-limits.ts); a value outside them is not believed. */
const PER_ENQUEUE = { min: 1, max: 200 }, PENDING = { min: 1, max: 100_000 }, MAX_BYTES = 1024;
const integerIn = (value, { min, max }) => Number.isSafeInteger(value) && value >= min && value <= max;

export const queueLimitsFile = (runtimeDir = resolveDataPaths().runtime) => join(runtimeDir, QUEUE_LIMITS_FILE);

/** `{perEnqueue, pendingLimit}` (pendingLimit null: no total limit), or null when the app has not published valid limits
 * (an older app, a data root never started): the description then names the defaults. Never throws. */
export function readQueueLimits(file = queueLimitsFile()) {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > MAX_BYTES) return null;
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !integerIn(value.maxItemsPerEnqueue, PER_ENQUEUE)
      || !(value.maxPendingItems === null || integerIn(value.maxPendingItems, PENDING))) return null;
    return { perEnqueue: value.maxItemsPerEnqueue, pendingLimit: value.maxPendingItems };
  } catch { return null; }
}

/**
 * Calls onChange when the published limits differ from the last ones seen here (by polling the file's stat; the
 * watcher never keeps the process alive). Returns the function that stops it.
 */
export function watchQueueLimits(onChange, { file = queueLimitsFile(), intervalMs = 1500 } = {}) {
  let last = JSON.stringify(readQueueLimits(file));
  const listener = () => { const now = JSON.stringify(readQueueLimits(file)); if (now === last) return; last = now; onChange(); };
  watchFile(file, { persistent: false, interval: intervalMs }, listener);
  return () => unwatchFile(file, listener);
}
