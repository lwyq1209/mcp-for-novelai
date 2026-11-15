// The client's queue limits in the enqueue_recipes description: the app publishes its two settings as
// <data root>/runtime/queue-limits.json, tools/list states them as they are now, and the server tells its client to
// list the tools again when the file changes. Nothing is added to any tool result.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, createNovelAiMcpServer } from '../src/mcp.mjs';
import { QUEUE_LIMITS_FILE, readQueueLimits, watchQueueLimits } from '../src/queue-limits-file.mjs';

async function folder(t) { const dir = await mkdtemp(join(tmpdir(), 'nai-queue-limits-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const published = (maxItemsPerEnqueue, maxPendingItems) => JSON.stringify({ schemaVersion: 1, maxItemsPerEnqueue, maxPendingItems });
async function connect(t, options) {
  const server = createNovelAiMcpServer({ bridgeClient: { async call() { throw new Error('tools/list never calls the host'); } }, ...options });
  const client = new Client({ name: 'queue-limits-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  t.after(async () => { await client.close(); await server.close(); });
  const description = async name => (await client.listTools()).tools.find(tool => tool.name === name).description;
  return { server, client, description };
}

test('readQueueLimits: the two published settings, or null for anything that is not exactly that', async t => {
  const dir = await folder(t), file = join(dir, QUEUE_LIMITS_FILE);
  assert.equal(readQueueLimits(file), null, 'no file: an older app, or a data root never started');
  await writeFile(file, published(50, 200));
  assert.deepEqual(readQueueLimits(file), { perEnqueue: 50, pendingLimit: 200 });
  await writeFile(file, published(200, null));
  assert.deepEqual(readQueueLimits(file), { perEnqueue: 200, pendingLimit: null }, 'null: no total limit');
  for (const bad of ['', 'not json', 'null', '[]', JSON.stringify({ schemaVersion: 2, maxItemsPerEnqueue: 50, maxPendingItems: 200 }), published(0, 200), published(201, 200), published('50', 200), published(50, 0), published(50, 100_001), published(50, undefined),
    `${published(50, 200)}${' '.repeat(2000)}`]) { await writeFile(file, bad); assert.equal(readQueueLimits(file), null, bad.slice(0, 80)); }
  assert.equal(readQueueLimits(dir), null, 'a directory is not a limits file');
});

test('tools/list: enqueue_recipes names the limits the user has set now; without published limits it names the defaults', async t => {
  let limits = null, reads = 0;
  const { description, client } = await connect(t, { queueLimits: () => { reads += 1; return limits; } });
  assert.deepEqual(client.getServerCapabilities().tools, { listChanged: true });
  const fixed = TOOL_DEFINITIONS.find(tool => tool.name === 'enqueue_recipes').description;
  assert.equal(await description('enqueue_recipes'), fixed);
  assert.match(fixed, /a client setting, default 20, at most 200/); assert.match(fixed, /total queue limit, default 200/);
  limits = { perEnqueue: 50, pendingLimit: 1000 };
  const now = await description('enqueue_recipes');
  assert.match(now, /items \[[^\]]+\]: 1 up to 50 images in total \(the per-enqueue limit the user has set in the client now/);
  assert.match(now, /the whole queue holds at most 1000 unfinished images/);
  assert.doesNotMatch(now, /default 20|default 200/, 'the defaults are not named beside the current values');
  // Only the limits sentence differs: the rest of the description is the same text.
  const [head, tail] = fixed.split(/1 up to the client's per-enqueue limit[^)]*\)/);
  assert.ok(head.length > 100 && tail.length > 1000 && now.startsWith(head) && now.endsWith(tail));
  limits = { perEnqueue: 200, pendingLimit: null };
  const unlimited = await description('enqueue_recipes');
  assert.match(unlimited, /1 up to 200 images in total/); assert.match(unlimited, /no limit on the unfinished images of the whole queue/); assert.doesNotMatch(unlimited, /queue_full\)/);
  assert.equal(reads, 3, 'read at every tools/list');
  // The other tools are as fixed, and a failing read falls back to the fixed text.
  for (const tool of (await client.listTools()).tools) if (tool.name !== 'enqueue_recipes') assert.equal(tool.description, TOOL_DEFINITIONS.find(item => item.name === tool.name).description, tool.name);
  const failing = await connect(t, { queueLimits: () => { throw new Error('unreadable'); } });
  assert.equal(await failing.description('enqueue_recipes'), fixed);
});

test('a changed limits file makes the server send tools/list_changed, and the next list has the new values', async t => {
  const dir = await folder(t), file = join(dir, QUEUE_LIMITS_FILE);
  await writeFile(file, published(20, 200));
  const { server, client, description } = await connect(t, { queueLimits: () => readQueueLimits(file) });
  assert.match(await description('enqueue_recipes'), /1 up to 20 images in total \(the per-enqueue limit the user has set/);
  let notified = 0, wake = () => undefined;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { notified += 1; wake(); });
  const stop = watchQueueLimits(() => { server.sendToolListChanged().catch(() => undefined); }, { file, intervalMs: 20 });
  t.after(stop);
  const next = () => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('no tools/list_changed within 5 s')), 5000); wake = () => { clearTimeout(timer); resolve(); }; });
  // The same content written again is not a change (the app also rewrites nothing in that case).
  await writeFile(file, published(20, 200));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(notified, 0);
  const changed = next();
  await writeFile(file, published(80, null));
  await changed;
  assert.equal(notified, 1);
  const now = await description('enqueue_recipes');
  assert.match(now, /1 up to 80 images in total/); assert.match(now, /no limit on the unfinished images of the whole queue/);
  // A file that appears later (the app's first start after the server) is a change too.
  const late = join(dir, 'later', QUEUE_LIMITS_FILE);
  let seen = 0; const stopLate = watchQueueLimits(() => { seen += 1; }, { file: late, intervalMs: 20 }); t.after(stopLate);
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(dir, 'later')); await writeFile(late, published(35, 200));
  for (let i = 0; i < 100 && seen === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(seen, 1);
});
