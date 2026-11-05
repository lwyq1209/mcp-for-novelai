import { agentClientLabel, type AgentActivity, type AgentCall, type AgentClientSummary } from '../../agent-clients';
import { formatWhen, uiText, type UiLang } from '../../ui/i18n';
import type { McpClientId } from '../../types';

/**
 * Settings › MCP access and the agent step of the guide (step 4b2): pure helpers. The tool list is the MCP server's
 * (novelai/src/mcp.mjs TOOL_DEFINITIONS; mcp-model.test.ts checks they agree), grouped as the prototype shows it.
 */
export const MCP_SERVER_NAME = 'novelai';
export const MCP_TOOL_GROUPS = {
  library: ['asset_library', 'material_library', 'material_studies', 'tag_details'],
  queue: ['prepare_recipe', 'enqueue_recipes', 'lookup_enqueue', 'list_queue', 'read_queue', 'get_queue_result', 'control_queue'],
  canvas: ['list_workspaces', 'read_workspace', 'read_prompt_review', 'get_asset', 'draft_edit', 'apply_edit', 'undo_edit'],
} as const;
export type McpToolGroup = keyof typeof MCP_TOOL_GROUPS;
export const MCP_TOOL_NAMES: readonly string[] = Object.values(MCP_TOOL_GROUPS).flat();
export const MCP_CLIENTS: readonly McpClientId[] = ['claude', 'cursor', 'codex', 'pi', 'dsh', 'other'];

/** The picker tile of an MCP client the activity names (initialize clientInfo.name), when it has one. */
const CLIENT_TILES: Record<string, McpClientId> = { 'claude-code': 'claude', claude: 'claude', 'cursor-vscode': 'cursor', 'codex-mcp-client': 'codex', pi: 'pi', 'dsh-mcp-client': 'dsh' };
export const clientTileOf = (name: string | null | undefined): McpClientId | null => name && Object.hasOwn(CLIENT_TILES, name) ? CLIENT_TILES[name] : null;

/** "刚刚" under a minute, "N 分钟前" under an hour, else the day and time (今天 10:21, 昨天 22:14, 11 月 1 日). */
export function relativeWhen(at: string, lang: UiLang, now: Date = new Date()): string {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const minutes = Math.floor((now.getTime() - time) / 60_000);
  if (minutes < 1) return uiText(lang, 'mcp.justNow');
  if (minutes < 60) return uiText(lang, 'mcp.minutesAgo', { n: minutes });
  return formatWhen(new Date(time), lang, now);
}

/** A connection seen within this many milliseconds shows as live (agent colour). */
export const LIVE_CONNECTION_MS = 15 * 60_000;
export interface ConnectionRow { key: string; label: string; when: string; tool: string | null; calls: number; live: boolean }
/** The clients seen, most recent first, as the recent-connections list shows them. */
export function connectionRows(activity: AgentActivity | null, lang: UiLang, now: Date = new Date(), limit = 5): ConnectionRow[] {
  return (activity?.clients ?? []).slice()
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
    .slice(0, limit)
    .map((summary: AgentClientSummary, index) => ({
      key: `${summary.client?.name ?? ''}#${index}`, label: agentClientLabel(summary.client), when: relativeWhen(summary.lastSeenAt, lang, now),
      tool: summary.lastTool, calls: summary.calls, live: now.getTime() - Date.parse(summary.lastSeenAt) < LIVE_CONNECTION_MS,
    }));
}

/** The newest start of the app by an agent's MCP server, as the recent-connections list shows it, or null. */
export function lastAppStart(activity: AgentActivity | null, lang: UiLang, now: Date = new Date()): { label: string; when: string; at: string } | null {
  const start = (activity?.appStarts ?? []).slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return start ? { label: agentClientLabel(start.client), when: relativeWhen(start.at, lang, now), at: start.at } : null;
}

/**
 * The newest agent call made at or after `since` (ms): the guide's "connected" signal. Calls stamped a little
 * before `since` (clock skew between the MCP server's host call and this window) are allowed by `skewMs`.
 */
export function callSince(activity: AgentActivity | null, since: number, skewMs = 2_000): AgentCall | null {
  let found: AgentCall | null = null;
  for (const call of activity?.recent ?? []) {
    const at = Date.parse(call.at);
    if (!Number.isFinite(at) || at < since - skewMs) continue;
    if (!found || at > Date.parse(found.at)) found = call;
  }
  return found;
}

/** The most recently seen client before the guide's agent step opened (a second run of the guide). */
export function previousClient(activity: AgentActivity | null): AgentClientSummary | null {
  return (activity?.clients ?? []).slice().sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0] ?? null;
}

/** Capture runs: the recent connections of the prototype (Claude Code 2 minutes ago, Codex today 10:21, Pi yesterday 22:14). */
export function captureActivity(now: Date, connected: 'none' | 'sample' | 'just-now'): AgentActivity {
  if (connected === 'none') return { recent: [], clients: [] };
  const day = (back: number, hh: number, mm: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, hh, mm).toISOString();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const claude = { name: 'claude-code', version: '2.1.0' }, codex = { name: 'codex-mcp-client', version: '0.50.0' }, pi = { name: 'pi', version: '1.5.0' };
  if (connected === 'just-now') return { recent: [{ at: new Date(now.getTime() + 1_000).toISOString(), client: claude, tool: 'list_queue', method: 'list_queue' }], clients: [{ client: claude, firstSeenAt: ago(0), lastSeenAt: new Date(now.getTime() + 1_000).toISOString(), lastTool: 'list_queue', calls: 1 }] };
  return {
    recent: [{ at: ago(2), client: claude, tool: 'get_queue_result', method: 'get_queue_result' }],
    clients: [
      { client: claude, firstSeenAt: day(1, 9, 0), lastSeenAt: ago(2), lastTool: 'get_queue_result', calls: 214 },
      // Today 10:21 as in the prototype, or three hours ago when the capture runs before that (never in the future).
      { client: codex, firstSeenAt: day(2, 9, 0), lastSeenAt: new Date(Math.min(Date.parse(day(0, 10, 21)), now.getTime() - 3 * 3_600_000)).toISOString(), lastTool: 'prepare_recipe', calls: 37 },
      { client: pi, firstSeenAt: day(3, 9, 0), lastSeenAt: day(1, 22, 14), lastTool: 'enqueue_recipes', calls: 12 },
    ],
  };
}
