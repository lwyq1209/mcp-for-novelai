import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AGENT_ACTIVITY_FILE, AGENT_ACTIVITY_LIMITS, createAgentActivity, parseAgentActivity } from './agent-activity';
import { agentClientLabel, batchSourceLabel } from '../src/agent-clients';
import { parseBridgeCaller } from './bridge-server';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function runtime() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-agent-activity-')); roots.push(root); return root; }
const clock = (start = Date.parse('2026-11-03T10:00:00.000Z')) => { let now = start; return { now: () => new Date(now), tick: (ms = 1000) => { now += ms; } }; };

it('records client, tool and time per tool call (never arguments) and keeps one summary per client', async () => {
  const dir = await runtime(), time = clock();
  const activity = createAgentActivity({ runtimeDir: dir, now: time.now, writeDelayMs: 0 });
  const claude = { name: 'claude-code', version: '2.1.112' };
  activity.record('lookup_queue_request', { tool: 'enqueue_recipes', client: claude, callId: 'call-1' });
  time.tick(); activity.record('enqueue_queue_recipes', { tool: 'enqueue_recipes', client: claude, callId: 'call-1' });
  time.tick(); activity.record('list_queue', { tool: 'list_queue', client: { name: 'pi', version: '1.5.0' }, callId: 'call-2' });
  time.tick(); activity.record('list_queue', { tool: null, client: null, callId: null });
  const read = await activity.read();
  expect(read.recent).toEqual([
    { at: '2026-11-03T10:00:03.000Z', client: null, tool: null, method: 'list_queue' },
    { at: '2026-11-03T10:00:02.000Z', client: { name: 'pi', version: '1.5.0' }, tool: 'list_queue', method: 'list_queue' },
    // One tool call with two host calls is one row, at its latest host call.
    { at: '2026-11-03T10:00:01.000Z', client: claude, tool: 'enqueue_recipes', method: 'lookup_queue_request' },
  ]);
  expect(read.clients.map(summary => [summary.client?.name ?? null, summary.calls, summary.lastTool])).toEqual([[null, 1, null], ['pi', 1, 'list_queue'], ['claude-code', 1, 'enqueue_recipes']]);
  await activity.flush();
  const stored = JSON.parse(await fs.readFile(path.join(dir, AGENT_ACTIVITY_FILE), 'utf8'));
  expect(stored.schemaVersion).toBe(1);
  expect(Object.keys(stored.recent[0]).sort()).toEqual(['at', 'client', 'method', 'tool']);
  // A later process reads the same rows back.
  const again = createAgentActivity({ runtimeDir: dir, now: time.now, writeDelayMs: 0 });
  expect(await again.read()).toEqual(read);
  expect((await fs.readdir(dir)).sort()).toEqual([AGENT_ACTIVITY_FILE]);
});

it('keeps the newest calls and clients within their limits; a damaged file starts empty', async () => {
  const dir = await runtime(), time = clock();
  const activity = createAgentActivity({ runtimeDir: dir, now: time.now, writeDelayMs: 0 });
  for (let index = 0; index < 70; index++) { time.tick(); activity.record('list_queue', { tool: 'list_queue', client: { name: `client-${index}`, version: null }, callId: `c-${index}` }); }
  const read = await activity.read();
  expect(read.recent).toHaveLength(AGENT_ACTIVITY_LIMITS.recent);
  expect(read.recent[0].client?.name).toBe('client-69');
  expect(read.clients).toHaveLength(AGENT_ACTIVITY_LIMITS.clients);
  await activity.flush();
  await fs.writeFile(path.join(dir, AGENT_ACTIVITY_FILE), '{not json');
  const damaged = createAgentActivity({ runtimeDir: dir, now: time.now, writeDelayMs: 0, log: () => {} });
  expect(await damaged.read()).toEqual({ recent: [], clients: [] });
  expect(parseAgentActivity({ schemaVersion: 1, recent: [{ at: 'yesterday', client: null, tool: null, method: 'x' }, { at: '2026-11-03T10:00:00.000Z', client: null, tool: 'list_queue', method: 'list_queue', args: { secret: 1 } }], clients: [] }).recent)
    .toEqual([{ at: '2026-11-03T10:00:00.000Z', client: null, tool: 'list_queue', method: 'list_queue' }]);
});

it('shows known clients by name, unknown ones as sent and a missing name as Agent', () => {
  expect(agentClientLabel({ name: 'claude-code' })).toBe('Claude Code');
  expect(agentClientLabel({ name: 'codex-mcp-client' })).toBe('Codex');
  expect(agentClientLabel({ name: 'cursor-vscode' })).toBe('Cursor');
  expect(agentClientLabel({ name: 'pi' })).toBe('Pi');
  expect(agentClientLabel({ name: 'my-own-agent' })).toBe('my-own-agent');
  expect(agentClientLabel(null)).toBe('Agent');
  expect(agentClientLabel({ name: '  ' })).toBe('Agent');
  // Invisible format characters never reach the screen (a stored name, for example).
  expect(agentClientLabel({ name: '\u202eclaude-code\u200b' })).toBe('Claude Code');
  expect(agentClientLabel({ name: '\u200b\u2066' })).toBe('Agent');
  expect(parseBridgeCaller({ tool: 'list_queue', client: { name: 'my\u202e-agent', version: '2\u200d' }, callId: 'c1' })).toEqual({ tool: 'list_queue', client: { name: 'my-agent', version: '2' }, callId: 'c1' });
  expect(parseAgentActivity({ schemaVersion: 1, recent: [{ at: '2026-11-03T10:00:00.000Z', client: { name: '\u2067pi', version: null }, tool: null, method: 'list_queue' }], clients: [] }).recent[0].client).toEqual({ name: 'pi', version: null });
  expect(batchSourceLabel(undefined, '手动')).toBe('Agent');
  expect(batchSourceLabel({ kind: 'manual', persistent: false }, 'Manual')).toBe('Manual');
  expect(batchSourceLabel({ kind: 'agent', client: { name: 'claude-code', version: '2' } }, 'Manual')).toBe('Claude Code');
});

it('records the starts of the app by an agent (newest first, within their limit) and reads them back; older files have none', async () => {
  const dir = await runtime(), time = clock();
  const activity = createAgentActivity({ runtimeDir: dir, now: time.now, writeDelayMs: 0 });
  expect((await activity.read()).appStarts).toBeUndefined();
  activity.recordAppStart({ name: 'claude-code' });
  time.tick(); activity.recordAppStart(null);
  time.tick(); activity.recordAppStart({ name: 'bad\nname' });
  const read = await activity.read();
  expect(read.appStarts).toEqual([
    { at: '2026-11-03T10:00:02.000Z', client: null },
    { at: '2026-11-03T10:00:01.000Z', client: null },
    { at: '2026-11-03T10:00:00.000Z', client: { name: 'claude-code', version: null } },
  ]);
  expect(read.recent).toEqual([]); expect(read.clients).toEqual([]);
  await activity.flush();
  expect(await createAgentActivity({ runtimeDir: dir, writeDelayMs: 0 }).read()).toEqual(read);
  for (let index = 0; index < AGENT_ACTIVITY_LIMITS.appStarts + 3; index++) { time.tick(); activity.recordAppStart({ name: 'pi' }); }
  expect((await activity.read()).appStarts).toHaveLength(AGENT_ACTIVITY_LIMITS.appStarts);
  await activity.flush();
  expect(parseAgentActivity({ schemaVersion: 1, recent: [], clients: [], appStarts: [{ at: 'yesterday', client: null }, { at: '2026-11-03T10:00:00.000Z', client: { name: 'x' } }] }))
    .toEqual({ recent: [], clients: [], appStarts: [{ at: '2026-11-03T10:00:00.000Z', client: { name: 'x', version: null } }] });
  expect(parseAgentActivity({ schemaVersion: 1, recent: [], clients: [] })).toEqual({ recent: [], clients: [] });
});
