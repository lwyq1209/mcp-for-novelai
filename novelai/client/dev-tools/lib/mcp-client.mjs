// MCP client for the bundled server (dist-mcp/novelai-mcp.mjs), run the way the app's MCP access does it:
// ELECTRON_RUN_AS_NODE=1 <this checkout's Electron> <bundle>, with NOVELAI_DATA_DIR of a TEST data root.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ToolError } from './cli.mjs';
import { checkDataRoot } from './guard.mjs';
import { buildOutputs, dataPaths, electronExecutable, missingBuildOutputs, novelaiRequire } from './paths.mjs';

async function sdk() {
  const load = specifier => import(pathToFileURL(novelaiRequire.resolve(specifier)).href);
  const [{ Client }, { StdioClientTransport }] = await Promise.all([load('@modelcontextprotocol/sdk/client/index.js'), load('@modelcontextprotocol/sdk/client/stdio.js')]);
  return { Client, StdioClientTransport };
}

/** Flattens a tools/call result: {isError, structuredContent, text, images}. */
export function flattenResult(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    isError: Boolean(result?.isError),
    structuredContent: result?.structuredContent ?? null,
    text: content.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    images: content.filter(part => part.type === 'image').map(part => ({ mimeType: part.mimeType, bytes: Buffer.byteLength(part.data ?? '', 'base64') })),
  };
}

/** Per tool call, as Settings › MCP access configures agents (1560 s). */
export const MCP_TOOL_TIMEOUT_MS = 1_560_000;
/** Bridge fault kinds of --bridge-fault (lib/mcp-fault-server.mjs). */
export const BRIDGE_FAULT_KINDS = Object.freeze(['request-lost', 'reply-lost']);
/**
 * --bridge-fault <method>:<kind>[:<times>] (repeatable): `method` a bridge method of the app (enqueue_queue_recipes,
 * lookup_queue_request, …), `kind` request-lost or reply-lost, `times` a count (default 1) or "always".
 */
export function parseBridgeFaults(values) {
  return [values ?? []].flat().filter(value => value !== undefined).map(value => {
    const [method, kind, times = '1', ...rest] = String(value).split(':');
    const count = times === 'always' ? 'always' : Number(times);
    if (!/^[a-z][a-z_]*$/.test(method ?? '') || !BRIDGE_FAULT_KINDS.includes(kind) || rest.length || (count !== 'always' && !(Number.isSafeInteger(count) && count >= 1)))
      throw new ToolError('usage', `--bridge-fault must be <method>:<${BRIDGE_FAULT_KINDS.join('|')}>[:<times>|always], e.g. enqueue_queue_recipes:reply-lost; got ${JSON.stringify(value)}.`);
    return { method, kind, times: count };
  });
}

/**
 * Connects to the MCP server of a test data root. `project` sets NOVELAI_PROJECT_ROOT (inbox/export folders);
 * `clientName` is the MCP client name the server reports to the app (e.g. claude-code). `bridgeFaults`
 * (parseBridgeFaults) runs the bundle through lib/mcp-fault-server.mjs, which loses those bridge calls. Returns {call, tools, close}.
 */
export async function connectMcp({ data, project, clientName = 'dev-tools', clientVersion = '0.0.0', stderr = 'pipe', bridgeFaults = [] } = {}) {
  if (data === undefined || data === true) throw new ToolError('refused_no_data', 'An explicit --data <test data root> is required; the real data root is never used.');
  const { dataRoot } = checkDataRoot(String(data));
  const missing = missingBuildOutputs(['mcpBundle']);
  if (missing.length) throw new ToolError('not_built', `The MCP bundle is missing (${missing.join(', ')}). Run: npm --prefix novelai/client run build.`);
  const { Client, StdioClientTransport } = await sdk();
  // A dev-tools server never starts an app by itself (src/app-autostart.mjs): start the test client with test-client.mjs.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ELECTRON_RUN_AS_NODE: '1', [dataPaths.DATA_DIR_ENV]: dataRoot, NOVELAI_MCP_AUTOSTART: '0' };
  for (const key of ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  if (project !== undefined) env[dataPaths.PROJECT_ROOT_ENV] = path.resolve(String(project));
  if (bridgeFaults.length) env.NAI_DEV_TOOLS_BRIDGE_FAULTS = JSON.stringify(bridgeFaults);
  const args = bridgeFaults.length ? [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-fault-server.mjs'), buildOutputs.mcpBundle] : [buildOutputs.mcpBundle];
  const transport = new StdioClientTransport({ command: electronExecutable(), args, env, stderr });
  const client = new Client({ name: clientName, version: clientVersion });
  await client.connect(transport);
  return {
    client, dataRoot,
    async tools() { const { tools } = await client.listTools(); return tools; },
    // The tool timeout the app's MCP configurations set (electron/mcp-access.ts MCP_TOOL_TIMEOUT_SECONDS), not the SDK's
    // 60 s default: an enqueue may settle a lost answer for up to about 150 s.
    async call(name, args = {}) { return flattenResult(await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_TOOL_TIMEOUT_MS })); },
    close: () => client.close(),
  };
}
