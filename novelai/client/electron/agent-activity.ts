import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renameReplace } from './platform-fs';
import type { BridgeCaller } from './bridge-server';
import type { AgentActivity, AgentCall, AgentClient, AgentClientSummary } from '../src/agent-clients';
import { plainClientText } from '../src/agent-clients';

/**
 * Recent agent calls (step 4a, user decision 3): which MCP client called which tool and when. Only the client's
 * initialize clientInfo name and version, the MCP tool, the host method and the time are kept — never arguments,
 * results or errors. One tool call that makes several host calls is one row (the MCP server sends one callId per tool
 * call). Kept in <data root>/runtime/agent-activity.json: the newest RECENT_LIMIT calls and one summary per client
 * (CLIENT_LIMIT clients, most recently seen first). A missing, unreadable or malformed file starts empty.
 */
export const AGENT_ACTIVITY_FILE = 'agent-activity.json';
export const AGENT_ACTIVITY_LIMITS = Object.freeze({ recent: 50, clients: 20, fileBytes: 256 * 1024 });
export type { AgentActivity, AgentCall, AgentClient, AgentClientSummary } from '../src/agent-clients';
interface StoredActivity extends AgentActivity { schemaVersion: 1 }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() !== '' && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
/** A stored client name or version, as plain text (invisible format characters removed). */
const clientText = (value: unknown, max: number) => plainClientText(value, max);
const clientOf = (value: unknown): AgentClient | null | undefined => {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = clientText((value as any).name, 100);
  return name ? { name, version: clientText((value as any).version, 50) } : undefined;
};
const time = (value: unknown) => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
const sameClient = (a: AgentClient | null, b: AgentClient | null) => (a?.name ?? null) === (b?.name ?? null);

/** The stored file, keeping only well-formed rows; anything else reads as empty. */
export function parseAgentActivity(raw: unknown): AgentActivity {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (value.schemaVersion !== 1) return { recent: [], clients: [] };
  const recent = (Array.isArray(value.recent) ? value.recent : []).flatMap((row: any) => {
    const at = time(row?.at), client = clientOf(row?.client), method = text(row?.method, 80), tool = row?.tool === null ? null : text(row?.tool, 80);
    return at && client !== undefined && method && (tool !== null || row?.tool === null) ? [{ at, client, tool, method }] : [];
  }).slice(0, AGENT_ACTIVITY_LIMITS.recent);
  const clients = (Array.isArray(value.clients) ? value.clients : []).flatMap((row: any) => {
    const client = clientOf(row?.client), firstSeenAt = time(row?.firstSeenAt), lastSeenAt = time(row?.lastSeenAt), lastTool = row?.lastTool === null ? null : text(row?.lastTool, 80);
    return client !== undefined && firstSeenAt && lastSeenAt && (lastTool !== null || row?.lastTool === null) && Number.isSafeInteger(row?.calls) && row.calls >= 1 ? [{ client, firstSeenAt, lastSeenAt, lastTool, calls: row.calls }] : [];
  }).slice(0, AGENT_ACTIVITY_LIMITS.clients);
  return { recent, clients };
}

export interface AgentActivityOptions {
  runtimeDir: string;
  now?: () => Date;
  /** Delay before a change is written (several calls in a row write once). */
  writeDelayMs?: number;
  onChange?: (activity: AgentActivity) => void;
  log?: (message: string) => void;
}

export function createAgentActivity(options: AgentActivityOptions) {
  const file = path.join(path.resolve(options.runtimeDir), AGENT_ACTIVITY_FILE);
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.warn(message));
  let state: AgentActivity = { recent: [], clients: [] };
  /** The latest rows of this process per callId, so the host calls of one tool call stay one row. */
  const byCall = new Map<string, AgentCall>();
  let timer: ReturnType<typeof setTimeout> | null = null, writing: Promise<void> = Promise.resolve(), dirty = false;
  const snapshot = (): AgentActivity => structuredClone(state);
  const ready = (async () => {
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > AGENT_ACTIVITY_LIMITS.fileBytes) { log(`[agent-activity] ${AGENT_ACTIVITY_FILE} is not a small regular file; starting empty.`); return; }
      state = parseAgentActivity(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error: any) { if (error?.code !== 'ENOENT') log(`[agent-activity] ${AGENT_ACTIVITY_FILE} could not be read; starting empty.`); }
  })();
  async function write() {
    dirty = false;
    const body: StoredActivity = { schemaVersion: 1, ...snapshot() };
    const temporary = path.join(path.dirname(file), `.agent-activity-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
      await renameReplace(temporary, file);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      log(`[agent-activity] could not save recent calls: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  function schedule() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; writing = writing.then(write); }, options.writeDelayMs ?? 500);
    timer.unref?.();
  }
  function record(method: string, caller: BridgeCaller, at: string) {
    const client = caller.client ? { name: caller.client.name, version: caller.client.version } : null;
    const previous = caller.callId ? byCall.get(caller.callId) : undefined;
    if (previous && state.recent.includes(previous)) previous.at = at;
    else {
      const row: AgentCall = { at, client, tool: caller.tool, method };
      state.recent = [row, ...state.recent].slice(0, AGENT_ACTIVITY_LIMITS.recent);
      if (caller.callId) { byCall.set(caller.callId, row); if (byCall.size > AGENT_ACTIVITY_LIMITS.recent) byCall.delete(byCall.keys().next().value!); }
    }
    const index = state.clients.findIndex(summary => sameClient(summary.client, client));
    const current = index >= 0 ? state.clients[index] : null;
    const summary: AgentClientSummary = { client: client ?? current?.client ?? null, firstSeenAt: current?.firstSeenAt ?? at, lastSeenAt: at, lastTool: caller.tool ?? current?.lastTool ?? null, calls: (current?.calls ?? 0) + (previous ? 0 : 1) };
    state.clients = [summary, ...state.clients.filter((_, position) => position !== index)].slice(0, AGENT_ACTIVITY_LIMITS.clients);
    schedule();
    try { options.onChange?.(snapshot()); } catch { /* A closing window never affects the record. */ }
  }
  return {
    ready,
    /** Records one bridge call (after the stored file was read, so nothing is lost). */
    record(method: string, caller: BridgeCaller) { const at = now().toISOString(); void ready.then(() => record(method, caller, at)); },
    async read(): Promise<AgentActivity> { await ready; return snapshot(); },
    /** Writes a pending change now (quit, tests). */
    async flush() { await ready; if (timer) { clearTimeout(timer); timer = null; } if (dirty) writing = writing.then(write); await writing; },
  };
}
export type AgentActivityRecorder = ReturnType<typeof createAgentActivity>;

/** The agent of a bridge call, as a queued batch (source) and a Recently Deleted entry (deletedBy) name it. */
export function agentActor(caller: BridgeCaller) {
  return { kind: 'agent' as const, client: caller.client ? { name: caller.client.name, version: caller.client.version } : null };
}
