// runtime/queue-limits.json: the two queue safety settings as the MCP server reads them for the enqueue_recipes
// description (novelai/src/queue-limits-file.mjs reads exactly this shape). Temporary folders only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { QUEUE_LIMITS_FILE, createQueueLimitsPublisher } from './queue-limits-file';

const cleanups: Array<() => unknown> = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));
async function temporary() { const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-limits-'))); cleanups.push(() => fs.rm(dir, { recursive: true, force: true })); return dir; }

describe('queue limits published for the MCP server', () => {
  it('writes the two settings and nothing else, creates the runtime folder, and rewrites only when a value changed', async () => {
    const root = await temporary(), runtimeDir = path.join(root, 'runtime'), file = path.join(runtimeDir, QUEUE_LIMITS_FILE);
    let settings: Record<string, unknown> = { queueMaxItemsPerEnqueue: 20, queueMaxPendingItems: 200, novelaiToken: 'never written', outputDir: '/somewhere' };
    const publish = createQueueLimitsPublisher({ runtimeDir, settings: () => settings });
    await publish();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, maxItemsPerEnqueue: 20, maxPendingItems: 200 });
    const first = await fs.stat(file);
    await new Promise(resolve => setTimeout(resolve, 30));
    await publish();
    expect((await fs.stat(file)).mtimeMs).toBe(first.mtimeMs);
    settings = { ...settings, queueMaxItemsPerEnqueue: 50, queueMaxPendingItems: null };
    await publish();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, maxItemsPerEnqueue: 50, maxPendingItems: null });
    expect(await fs.readdir(runtimeDir)).toEqual([QUEUE_LIMITS_FILE]);
  });

  it('publishes what an enqueue would use for a missing or invalid stored value: the defaults', async () => {
    const runtimeDir = await temporary(), file = path.join(runtimeDir, QUEUE_LIMITS_FILE);
    await createQueueLimitsPublisher({ runtimeDir, settings: () => ({ queueMaxItemsPerEnqueue: 5000, queueMaxPendingItems: 0 }) })();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ schemaVersion: 1, maxItemsPerEnqueue: 20, maxPendingItems: 200 });
  });

  it('a failed write is logged and never thrown; the next publish writes', async () => {
    const root = await temporary(), blocked = path.join(root, 'runtime'), log = vi.fn();
    await fs.writeFile(blocked, 'a file where the folder should be');
    const publish = createQueueLimitsPublisher({ runtimeDir: blocked, settings: () => ({ queueMaxItemsPerEnqueue: 30, queueMaxPendingItems: 200 }), log });
    await expect(publish()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(1); expect(log.mock.calls[0][0]).toMatch(/\[queue-limits\]/);
    await fs.rm(blocked); await publish();
    expect(JSON.parse(await fs.readFile(path.join(blocked, QUEUE_LIMITS_FILE), 'utf8')).maxItemsPerEnqueue).toBe(30);
  });
});
