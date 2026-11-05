/**
 * Settings → MCP access: how an MCP client (Claude Code, Pi, Cursor …) starts this app's MCP server. The server
 * is the single-file bundle built by scripts/build-electron.mjs (dist-mcp/novelai-mcp.mjs, shipped as
 * resources/mcp/novelai-mcp.mjs) and runs with this app's own Electron as Node (ELECTRON_RUN_AS_NODE=1), so no
 * separate Node install is needed. Pure functions: main.ts supplies the run-time facts.
 */
import { PROJECT_FOLDERS, PROJECT_ROOT_ENV, DATA_DIR_ENV } from "../shared/runtime/data-paths.cjs";
import type { McpAccessInfo } from "../src/types";

export interface McpAccessFacts {
  platform: NodeJS.Platform;
  /** A packaged build (electron-builder) rather than a development run from the source tree. */
  packaged: boolean;
  /** The Electron executable that runs the bundle as Node (process.execPath). */
  executable: string;
  /** The single-file MCP server. */
  bundle: string;
  bundleExists: boolean;
  /** novelai/src/mcp.mjs of this source tree, when there is one. */
  sourceEntry: string | null;
  /** The absolute data root of this client; every command passes it as NOVELAI_DATA_DIR. */
  dataRoot: string;
  /** NOVELAI_DATA_DIR is set for this client (shown in the page; the commands pass the data root either way). */
  customDataRoot: boolean;
  /** <data root>/workspace: the project root the MCP server uses without NOVELAI_PROJECT_ROOT. */
  workspaceRoot: string;
  materialInbox: string;
  studyInbox: string;
  /** The executable or bundle path changes from launch to launch (portable, AppImage, a translocated or mounted app). */
  temporaryLocation: boolean;
  /** The workspace bridge of this client is serving (an MCP server started now can reach it). Default false. */
  bridgeReady?: boolean;
}

/**
 * Seconds an MCP client should allow one tool call: enqueue_recipes makes at most 23 host calls in a row, each bounded
 * by the 65-second bridge timeout (about 25 minutes), so 26 minutes (docs/mcp-tools.md, "Timeouts").
 */
export const MCP_TOOL_TIMEOUT_SECONDS = 1560;
/** Seconds a client should allow the server to start (Codex waits 10 by default; Electron as Node starts in about one). */
export const MCP_STARTUP_TIMEOUT_SECONDS = 30;

/** A YAML double-quoted scalar (a JSON string literal is one: YAML double quotes take the same escapes). */
const yamlString = (value: string) => JSON.stringify(value);

/** A TOML basic string (a JSON string literal is one: the same escapes, and \uXXXX). */
const tomlString = (value: string) => JSON.stringify(value);

/** One shell word, bare when it needs no quoting. POSIX: double quotes when nothing in it is special inside them,
 * else single quotes. Windows (cmd and PowerShell): double quotes (a Windows path cannot contain one). */
export function shellWord(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return /^[\w+=:,./\\-]+$/.test(value) ? value : `"${value}"`;
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  if (!/["\\$`!]/.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Settings text for this run: the commands and the JSON configuration, built from the facts. Every variant names the
 * client's absolute data root as NOVELAI_DATA_DIR, the default one included, so the MCP server finds this client even
 * when its host starts it with another environment (another user profile, or without XDG_CONFIG_HOME on Linux).
 */
export function buildMcpAccess(facts: McpAccessFacts): McpAccessInfo {
  const word = (value: string) => shellWord(value, facts.platform);
  const flag = (key: string, value: string) => `--env ${word(`${key}=${value}`)}`;
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1", [DATA_DIR_ENV]: facts.dataRoot };
  const envFlags = Object.entries(env).map(([key, value]) => flag(key, value)).join(" ");
  const claudeCommand = `claude mcp add novelai ${envFlags} -- ${word(facts.executable)} ${word(facts.bundle)}`;
  const jsonConfig = JSON.stringify({ mcpServers: { novelai: { command: facts.executable, args: [facts.bundle], env } } }, null, 2);
  const source = facts.sourceEntry ?? "<clone>/novelai/src/mcp.mjs";
  const sourceCommand = `claude mcp add novelai ${flag(DATA_DIR_ENV, facts.dataRoot)} -- node ${facts.sourceEntry ? word(source) : source}`;
  const server = { command: facts.executable, args: [facts.bundle], env };
  const json = (value: unknown) => JSON.stringify({ mcpServers: { novelai: value } }, null, 2);
  // Per client, as each one's documentation describes it (checked 2026-11-03; see McpClientConfig):
  const clients: McpAccessInfo["clients"] = {
    // Claude Code: `claude mcp add <name> --env K=V -- <command> [args]` (code.claude.com/docs/en/mcp). A tool call may
    // take about 28 hours in all by default (MCP_TOOL_TIMEOUT); from v2.1.203 a stdio server silent for 30 minutes (no
    // response, no progress) is stopped (CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT). One call here is at most about 26 minutes
    // (MCP_TOOL_TIMEOUT_SECONDS), so nothing is added.
    // Shown one argument per line with POSIX line continuations, so no path breaks in the middle (Windows shells continue
    // lines differently: one line there). Either form is the same command.
    claude: { format: "command", file: null, snippet: facts.platform === "win32" ? claudeCommand : [`claude mcp add novelai`, ...Object.entries(env).map(([key, value]) => `  ${flag(key, value)}`), `  -- ${word(facts.executable)}`, `  ${word(facts.bundle)}`].join(" \\\n"), toolTimeout: "default" },
    // Cursor: ~/.cursor/mcp.json or <project>/.cursor/mcp.json; its field table names type "stdio" (cursor.com/docs/mcp).
    // The documentation has no tool timeout setting.
    cursor: { format: "json", file: "~/.cursor/mcp.json", snippet: json({ type: "stdio", ...server }), toolTimeout: "unavailable" },
    // Codex: [mcp_servers.<name>] in ~/.codex/config.toml; startup_timeout_sec (default 10) and tool_timeout_sec (default 60)
    // in seconds; env as a sub-table, as in the documentation's example (developers.openai.com/codex/mcp).
    codex: { format: "toml", file: "~/.codex/config.toml", toolTimeout: "set", snippet: [
      "[mcp_servers.novelai]",
      `command = ${tomlString(facts.executable)}`,
      `args = [${tomlString(facts.bundle)}]`,
      `startup_timeout_sec = ${MCP_STARTUP_TIMEOUT_SECONDS}`,
      `tool_timeout_sec = ${MCP_TOOL_TIMEOUT_SECONDS}`,
      "",
      "[mcp_servers.novelai.env]",
      ...Object.entries(env).map(([key, value]) => `${key} = ${tomlString(value)}`),
    ].join("\n") },
    // Pi (built-in MCP since 0.99): ~/.pi/agent/mcp.json or <project>/.pi/mcp.json, mcpServers format; timeout is the
    // per-request timeout in seconds (default 60) (earendil-works/pi docs/mcp.md).
    pi: { format: "json", file: "~/.pi/agent/mcp.json", snippet: json({ ...server, timeout: MCP_TOOL_TIMEOUT_SECONDS }), toolTimeout: "set" },
    // DeepSeek Harness (dsh): one @deepseek-ai/dsh-mcp-client plugin row per server, inserted in a user patch layer —
    // $DSH_HOME/cordis.patch.yml (~/.dsh, every profile) or $DSH_HOME/profiles/<profile>/cordis.patch.yml; the root
    // cordis.yml is rewritten empty on every start. toolCallTimeoutMs defaults to 60000 ms (deepseekdocs.com/en/docs/
    // features/mcp, /user-guide/configuration; github.com/deepseek-ai/deepseek-harness packages/mcp/mcp-client/README.md
    // and docs/user/guide/mcp-memory.md, checked 2026-11-05). Its stdio child gets the ambient environment without
    // KEY/PASSWORD/SECRET/TOKEN-like and DSH_* names, plus env below.
    dsh: { format: "yaml", file: "~/.dsh/cordis.patch.yml", toolTimeout: "set", snippet: [
      "- insert:",
      "    - id: mcp-novelai",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: novelai",
      "        transport: stdio",
      `        command: ${yamlString(facts.executable)}`,
      `        args: [${yamlString(facts.bundle)}]`,
      "        env:",
      ...Object.entries(env).map(([key, value]) => `          ${key}: ${yamlString(value)}`),
      `        toolCallTimeoutMs: ${MCP_TOOL_TIMEOUT_SECONDS * 1000}`,
    ].join("\n") },
    // Any client configured with mcpServers (for example Claude Desktop's claude_desktop_config.json).
    other: { format: "json", file: null, snippet: jsonConfig, toolTimeout: "manual" },
  };
  return {
    platform: facts.platform, packaged: facts.packaged, executable: facts.executable, bundle: facts.bundle, bundleExists: facts.bundleExists,
    sourceEntry: facts.sourceEntry, dataRoot: facts.dataRoot, customDataRoot: facts.customDataRoot, dataDirEnv: DATA_DIR_ENV,
    projectRootEnv: PROJECT_ROOT_ENV, workspaceRoot: facts.workspaceRoot, materialInbox: facts.materialInbox, studyInbox: facts.studyInbox,
    inboxFolders: [PROJECT_FOLDERS.materialInbox, PROJECT_FOLDERS.studyInbox], temporaryLocation: facts.temporaryLocation,
    bridgeReady: facts.bridgeReady === true, toolTimeoutSeconds: MCP_TOOL_TIMEOUT_SECONDS, startupTimeoutSeconds: MCP_STARTUP_TIMEOUT_SECONDS,
    claudeCommand, jsonConfig, sourceCommand, clients,
  };
}

/** Whether a packaged executable lives somewhere that changes between launches. */
export function temporaryExecutableLocation(platform: NodeJS.Platform, executable: string, env: NodeJS.ProcessEnv): boolean {
  if (platform === "linux" && env.APPIMAGE) return true;
  if (platform === "win32" && env.PORTABLE_EXECUTABLE_DIR) return true;
  if (platform === "darwin" && (executable.includes("/AppTranslocation/") || executable.startsWith("/Volumes/"))) return true;
  return false;
}
