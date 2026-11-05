// Step 3a: Settings → MCP access commands, quoted for each platform.
import { describe, expect, it } from "vitest";
import { buildMcpAccess, shellWord, temporaryExecutableLocation, type McpAccessFacts } from "./mcp-access";

const mac: McpAccessFacts = {
  platform: "darwin", packaged: true,
  executable: "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI",
  bundle: "/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs", bundleExists: true, sourceEntry: null,
  dataRoot: "/Users/u/Library/Application Support/mcp-for-novelai", customDataRoot: false,
  workspaceRoot: "/Users/u/Library/Application Support/mcp-for-novelai/workspace",
  materialInbox: "/Users/u/Library/Application Support/mcp-for-novelai/workspace/novelai/library-inbox",
  studyInbox: "/Users/u/Library/Application Support/mcp-for-novelai/workspace/novelai/study-inbox", temporaryLocation: false,
};

describe("shellWord", () => {
  it("leaves plain words bare and quotes the rest correctly for POSIX shells and Windows", () => {
    expect(shellWord("ELECTRON_RUN_AS_NODE=1", "darwin")).toBe("ELECTRON_RUN_AS_NODE=1");
    expect(shellWord("/usr/local/bin/app", "linux")).toBe("/usr/local/bin/app");
    expect(shellWord("/Applications/My App.app", "darwin")).toBe('"/Applications/My App.app"');
    expect(shellWord("/tmp/it's $HOME", "linux")).toBe("'/tmp/it'\\''s $HOME'");
    expect(shellWord('/tmp/a"b', "darwin")).toBe(`'/tmp/a"b'`);
    expect(shellWord("C:\\Program Files\\App\\App.exe", "win32")).toBe('"C:\\Program Files\\App\\App.exe"');
    expect(shellWord("C:\\tools\\app.exe", "win32")).toBe("C:\\tools\\app.exe");
  });
});

describe("DeepSeek Harness (dsh)", () => {
  it("writes one @deepseek-ai/dsh-mcp-client row for a user patch layer, with the 26-minute call timeout", () => {
    const info = buildMcpAccess(mac);
    expect(info.clients.dsh).toMatchObject({ format: "yaml", file: "~/.dsh/cordis.patch.yml", toolTimeout: "set" });
    expect(info.clients.dsh.snippet).toBe([
      "- insert:",
      "    - id: mcp-novelai",
      "      name: '@deepseek-ai/dsh-mcp-client'",
      "      config:",
      "        serverName: novelai",
      "        transport: stdio",
      '        command: "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI"',
      '        args: ["/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs"]',
      "        env:",
      '          ELECTRON_RUN_AS_NODE: "1"',
      '          NOVELAI_DATA_DIR: "/Users/u/Library/Application Support/mcp-for-novelai"',
      "        toolCallTimeoutMs: 1560000",
    ].join("\n"));
  });
  it("quotes Windows paths and Chinese data roots as YAML double-quoted strings", () => {
    const info = buildMcpAccess({ ...mac, platform: "win32", executable: "C:\\Program Files\\MCP for NovelAI\\MCP for NovelAI.exe", bundle: "C:\\Program Files\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs", dataRoot: "D:\\测试 数据\\nai" });
    expect(info.clients.dsh.snippet).toContain('        command: "C:\\\\Program Files\\\\MCP for NovelAI\\\\MCP for NovelAI.exe"');
    expect(info.clients.dsh.snippet).toContain('          NOVELAI_DATA_DIR: "D:\\\\测试 数据\\\\nai"');
  });
});

describe("buildMcpAccess", () => {
  it("registers the bundled server with the app's own executable as Node, naming the absolute default data root", () => {
    const info = buildMcpAccess(mac);
    expect(info.claudeCommand).toBe('claude mcp add novelai --env ELECTRON_RUN_AS_NODE=1 --env "NOVELAI_DATA_DIR=/Users/u/Library/Application Support/mcp-for-novelai" -- "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI" "/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs"');
    expect(JSON.parse(info.jsonConfig)).toEqual({ mcpServers: { novelai: { command: mac.executable, args: [mac.bundle], env: { ELECTRON_RUN_AS_NODE: "1", NOVELAI_DATA_DIR: mac.dataRoot } } } });
    expect(info.sourceCommand).toBe('claude mcp add novelai --env "NOVELAI_DATA_DIR=/Users/u/Library/Application Support/mcp-for-novelai" -- node <clone>/novelai/src/mcp.mjs');
    expect(info).toMatchObject({ projectRootEnv: "NOVELAI_PROJECT_ROOT", dataDirEnv: "NOVELAI_DATA_DIR", inboxFolders: ["novelai/library-inbox", "novelai/study-inbox"], workspaceRoot: mac.workspaceRoot });
  });

  it("passes a custom data root on to the MCP server, so it finds this client", () => {
    const info = buildMcpAccess({ ...mac, packaged: false, executable: "/repo/novelai/client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      bundle: "/repo/novelai/client/dist-mcp/novelai-mcp.mjs", sourceEntry: "/repo/novelai/src/mcp.mjs", dataRoot: "/tmp/nai data", customDataRoot: true });
    expect(info.claudeCommand).toBe('claude mcp add novelai --env ELECTRON_RUN_AS_NODE=1 --env "NOVELAI_DATA_DIR=/tmp/nai data" -- /repo/novelai/client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /repo/novelai/client/dist-mcp/novelai-mcp.mjs');
    expect(JSON.parse(info.jsonConfig).mcpServers.novelai.env).toEqual({ ELECTRON_RUN_AS_NODE: "1", NOVELAI_DATA_DIR: "/tmp/nai data" });
    expect(info.sourceCommand).toBe('claude mcp add novelai --env "NOVELAI_DATA_DIR=/tmp/nai data" -- node /repo/novelai/src/mcp.mjs');
  });

  it("quotes Windows paths for cmd and PowerShell, the data root included", () => {
    const info = buildMcpAccess({ ...mac, platform: "win32", executable: "C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe",
      bundle: "C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs", dataRoot: "C:\\Users\\u\\AppData\\Roaming\\mcp-for-novelai" });
    expect(info.claudeCommand).toBe('claude mcp add novelai --env ELECTRON_RUN_AS_NODE=1 --env NOVELAI_DATA_DIR=C:\\Users\\u\\AppData\\Roaming\\mcp-for-novelai -- "C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe" "C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs"');
    expect(JSON.parse(info.jsonConfig).mcpServers.novelai).toEqual({ command: "C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe",
      args: ["C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs"], env: { ELECTRON_RUN_AS_NODE: "1", NOVELAI_DATA_DIR: "C:\\Users\\u\\AppData\\Roaming\\mcp-for-novelai" } });
  });

  it("quotes data roots with spaces and Chinese characters in every variant and keeps them exact in the JSON", () => {
    const posix = buildMcpAccess({ ...mac, dataRoot: "/Users/张三/Library/Application Support/mcp-for-novelai" });
    expect(posix.claudeCommand).toContain(' --env "NOVELAI_DATA_DIR=/Users/张三/Library/Application Support/mcp-for-novelai" -- ');
    expect(posix.sourceCommand).toBe('claude mcp add novelai --env "NOVELAI_DATA_DIR=/Users/张三/Library/Application Support/mcp-for-novelai" -- node <clone>/novelai/src/mcp.mjs');
    expect(JSON.parse(posix.jsonConfig).mcpServers.novelai.env.NOVELAI_DATA_DIR).toBe("/Users/张三/Library/Application Support/mcp-for-novelai");
    const special = buildMcpAccess({ ...mac, platform: "linux", dataRoot: "/home/u/数据 $HOME's" });
    expect(special.claudeCommand).toContain(" --env 'NOVELAI_DATA_DIR=/home/u/数据 $HOME'\\''s' -- ");
    const windows = buildMcpAccess({ ...mac, platform: "win32", executable: "C:\\App\\App.exe", bundle: "C:\\App\\resources\\mcp\\novelai-mcp.mjs", dataRoot: "D:\\测试 数据\\nai" });
    expect(windows.claudeCommand).toBe('claude mcp add novelai --env ELECTRON_RUN_AS_NODE=1 --env "NOVELAI_DATA_DIR=D:\\测试 数据\\nai" -- C:\\App\\App.exe C:\\App\\resources\\mcp\\novelai-mcp.mjs');
    expect(JSON.parse(windows.jsonConfig).mcpServers.novelai.env.NOVELAI_DATA_DIR).toBe("D:\\测试 数据\\nai");
  });

  it("gives each MCP client its configuration with this run's real paths, and the tool timeout where the client has one (step 4b2)", () => {
    const info = buildMcpAccess({ ...mac, bridgeReady: true });
    expect(info.bridgeReady).toBe(true);
    expect(buildMcpAccess(mac).bridgeReady).toBe(false);
    expect(info).toMatchObject({ toolTimeoutSeconds: 1560, startupTimeoutSeconds: 30 });
    const env = { ELECTRON_RUN_AS_NODE: "1", NOVELAI_DATA_DIR: mac.dataRoot };
    // One argument per line with POSIX continuations (the same command as claudeCommand); Windows keeps one line.
    expect(info.clients.claude).toMatchObject({ format: "command", file: null, toolTimeout: "default" });
    expect(info.clients.claude.snippet).toBe([
      "claude mcp add novelai \\",
      "  --env ELECTRON_RUN_AS_NODE=1 \\",
      '  --env "NOVELAI_DATA_DIR=/Users/u/Library/Application Support/mcp-for-novelai" \\',
      '  -- "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI" \\',
      '  "/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs"',
    ].join("\n"));
    expect(info.clients.claude.snippet.replace(/ \\\n\s*/g, " ")).toBe(info.claudeCommand);
    expect(buildMcpAccess({ ...mac, platform: "win32" }).clients.claude.snippet).toBe(buildMcpAccess({ ...mac, platform: "win32" }).claudeCommand);
    expect(info.clients.cursor).toMatchObject({ format: "json", file: "~/.cursor/mcp.json", toolTimeout: "unavailable" });
    expect(JSON.parse(info.clients.cursor.snippet)).toEqual({ mcpServers: { novelai: { type: "stdio", command: mac.executable, args: [mac.bundle], env } } });
    expect(info.clients.pi).toMatchObject({ format: "json", file: "~/.pi/agent/mcp.json", toolTimeout: "set" });
    expect(JSON.parse(info.clients.pi.snippet)).toEqual({ mcpServers: { novelai: { command: mac.executable, args: [mac.bundle], env, timeout: 1560 } } });
    expect(info.clients.other).toEqual({ format: "json", file: null, snippet: info.jsonConfig, toolTimeout: "manual" });
    expect(info.clients.codex).toMatchObject({ format: "toml", file: "~/.codex/config.toml", toolTimeout: "set" });
    expect(info.clients.codex.snippet).toBe([
      "[mcp_servers.novelai]",
      'command = "/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI"',
      'args = ["/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs"]',
      "startup_timeout_sec = 30",
      "tool_timeout_sec = 1560",
      "",
      "[mcp_servers.novelai.env]",
      'ELECTRON_RUN_AS_NODE = "1"',
      'NOVELAI_DATA_DIR = "/Users/u/Library/Application Support/mcp-for-novelai"',
    ].join("\n"));
  });

  it("writes Windows paths and quotes as valid TOML basic strings for Codex", () => {
    const info = buildMcpAccess({ ...mac, platform: "win32", executable: "C:\\Program Files\\MCP for NovelAI\\MCP for NovelAI.exe", bundle: "C:\\Program Files\\MCP for NovelAI\\resources\\mcp\\novelai-mcp.mjs", dataRoot: 'D:\\测试 "数据"' });
    const lines = info.clients.codex.snippet.split("\n");
    expect(lines[1]).toBe('command = "C:\\\\Program Files\\\\MCP for NovelAI\\\\MCP for NovelAI.exe"');
    expect(lines.at(-1)).toBe('NOVELAI_DATA_DIR = "D:\\\\测试 \\"数据\\""');
    // A TOML basic string reads back like a JSON string.
    expect(JSON.parse(lines.at(-1)!.slice("NOVELAI_DATA_DIR = ".length))).toBe('D:\\测试 "数据"');
  });

  it("flags executables whose location changes from launch to launch", () => {
    expect(temporaryExecutableLocation("linux", "/tmp/.mount_abc/app", { APPIMAGE: "/home/u/App.AppImage" })).toBe(true);
    expect(temporaryExecutableLocation("win32", "C:\\Temp\\x\\App.exe", { PORTABLE_EXECUTABLE_DIR: "D:\\" })).toBe(true);
    expect(temporaryExecutableLocation("darwin", "/private/var/folders/x/AppTranslocation/y/App.app/Contents/MacOS/App", {})).toBe(true);
    expect(temporaryExecutableLocation("darwin", "/Volumes/App/App.app/Contents/MacOS/App", {})).toBe(true);
    expect(temporaryExecutableLocation("darwin", mac.executable, {})).toBe(false);
    expect(temporaryExecutableLocation("win32", "C:\\Program Files\\App\\App.exe", {})).toBe(false);
    // The Linux tar.gz, extracted to a folder of the user's choice, is a fixed location.
    expect(temporaryExecutableLocation("linux", "/home/u/Applications/MCP-for-NovelAI-0.1.0-linux-x64/mcp-for-novelai", {})).toBe(false);
    expect(temporaryExecutableLocation("linux", "/opt/mcp-for-novelai/mcp-for-novelai", { HOME: "/home/u" })).toBe(false);
  });
});
