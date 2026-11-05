import type { BatchSource } from "./workspace/batch-types";

/**
 * Agent identity (step 4a). The host records which MCP client called (its initialize clientInfo name and version),
 * which tool and when — never arguments (electron/agent-activity.ts). These are the shapes the renderer reads through
 * window.naiDesktop.agentActivity() and the names it shows.
 */
export interface AgentClient { name: string; version: string | null }
export interface AgentCall { at: string; client: AgentClient | null; tool: string | null; method: string }
export interface AgentClientSummary { client: AgentClient | null; firstSeenAt: string; lastSeenAt: string; lastTool: string | null; calls: number }
/** One start of the app by an agent's MCP server (the app was not running; novelai/src/app-autostart.mjs). */
export interface AgentAppStart { at: string; client: AgentClient | null }
/** appStarts: newest first; absent in files written before 0.1.1. */
export interface AgentActivity { recent: AgentCall[]; clients: AgentClientSummary[]; appStarts?: AgentAppStart[] }

/**
 * Display names by clientInfo.name (case-sensitive, as sent). verified: read in the client's own source or bundled
 * code (2026-11-03); reported: seen in published initialize logs only; listed: a community registry only. Anything
 * not here shows its name as sent; no name shows "Agent".
 */
export const AGENT_CLIENT_NAMES: Readonly<Record<string, { label: string; evidence: "verified" | "reported" | "listed" }>> = Object.freeze({
  "claude-code": { label: "Claude Code", evidence: "verified" },
  // Claude Code 1.0.x sent "claude".
  claude: { label: "Claude Code", evidence: "verified" },
  "claude-ai": { label: "Claude Desktop", evidence: "reported" },
  "codex-mcp-client": { label: "Codex", evidence: "verified" },
  "cursor-vscode": { label: "Cursor", evidence: "reported" },
  pi: { label: "Pi", evidence: "verified" },
  // DeepSeek Harness (deepseek-ai/deepseek-harness packages/mcp/mcp-client/src/connection.ts).
  "dsh-mcp-client": { label: "DeepSeek Harness", evidence: "verified" },
  "Visual Studio Code": { label: "VS Code", evidence: "verified" },
  "Visual Studio Code - Insiders": { label: "VS Code Insiders", evidence: "verified" },
  "gemini-cli-mcp-client": { label: "Gemini CLI", evidence: "verified" },
  Cline: { label: "Cline", evidence: "verified" },
  Zed: { label: "Zed", evidence: "verified" },
  "continue-client": { label: "Continue", evidence: "verified" },
  "continue-cli-client": { label: "Continue CLI", evidence: "verified" },
  "goose-cli": { label: "Goose", evidence: "verified" },
  "goose-desktop": { label: "Goose", evidence: "verified" },
  opencode: { label: "OpenCode", evidence: "verified" },
  "windsurf-client": { label: "Windsurf", evidence: "listed" },
  Windsurf: { label: "Windsurf", evidence: "listed" },
});

/** The name to show for an MCP client: the mapped name, else the name as sent, else "Agent" (both languages). */
/** Bidirectional controls, zero-width and other invisible format characters: a client's name is shown as plain text, so
 * these are removed wherever it is taken in (the MCP server, the bridge, the activity file) and shown. */
export const INVISIBLE_FORMAT_CHARACTERS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;
/** A client's name or version as plain text: invisible format characters removed, trimmed, 1–max characters, no
 * control characters; null otherwise. */
export function plainClientText(value: unknown, max: number): string | null {
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(value)) return null;
  const text = value.replace(INVISIBLE_FORMAT_CHARACTERS, "").trim();
  return text && text.length <= max ? text : null;
}

export function agentClientLabel(client: { name?: string | null } | null | undefined): string {
  const name = plainClientText(client?.name, 100) ?? "";
  if (!name) return "Agent";
  return Object.hasOwn(AGENT_CLIENT_NAMES, name) ? AGENT_CLIENT_NAMES[name].label : name;
}

/** Who put a queued batch in: the agent's display name, or the manual label of the interface language. */
export function batchSourceLabel(source: BatchSource | undefined, manualLabel: string): string {
  if (source?.kind === "manual") return manualLabel;
  return agentClientLabel(source?.kind === "agent" ? source.client : null);
}
