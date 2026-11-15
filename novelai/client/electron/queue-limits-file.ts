// The two queue safety settings, published for the MCP server as <data root>/runtime/queue-limits.json: a tool
// description is read when an agent lists the tools, outside any tool call and possibly while this app is not running,
// so the server cannot ask the bridge for them. The file holds nothing but the two numbers (no token, no other
// setting); the server writes them into the enqueue_recipes description and tells its client when they change
// (novelai/src/queue-limits-file.mjs). The settings stay the only source: enqueue reads them, never this file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameReplace } from './platform-fs';
import { normalizeQueueEnqueueItems, normalizeQueuePendingItems } from '../src/queue-limits';

export const QUEUE_LIMITS_FILE = 'queue-limits.json';
export interface PublishedQueueLimits { schemaVersion: 1; maxItemsPerEnqueue: number; maxPendingItems: number | null }

export function createQueueLimitsPublisher(options: { runtimeDir: string; settings: () => { queueMaxItemsPerEnqueue?: unknown; queueMaxPendingItems?: unknown }; log?: (message: string) => void }) {
  const file = path.join(path.resolve(options.runtimeDir), QUEUE_LIMITS_FILE);
  const log = options.log ?? ((message: string) => console.warn(message));
  let written: string | null = null, writing: Promise<void> = Promise.resolve();
  async function write() {
    const settings = options.settings();
    const body: PublishedQueueLimits = { schemaVersion: 1, maxItemsPerEnqueue: normalizeQueueEnqueueItems(settings.queueMaxItemsPerEnqueue), maxPendingItems: normalizeQueuePendingItems(settings.queueMaxPendingItems) };
    const text = JSON.stringify(body);
    if (text === written) return;
    const temporary = path.join(path.dirname(file), `.queue-limits-${randomUUID()}.tmp`);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
      await renameReplace(temporary, file);
      written = text;
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      log(`[queue-limits] could not publish the queue limits for the MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  /** Writes the current settings when they differ from what this process last wrote; calls are serialized and never throw. */
  return function publish(): Promise<void> { writing = writing.then(write); return writing; };
}
