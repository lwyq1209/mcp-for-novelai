// MCP client for the bundled server (dist-mcp/novelai-mcp.mjs), run the way the app's MCP access does it:
// ELECTRON_RUN_AS_NODE=1 <this checkout's Electron> <bundle>, with NOVELAI_DATA_DIR of a TEST data root.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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

/**
 * Connects to the MCP server of a test data root. `project` sets NOVELAI_PROJECT_ROOT (inbox/export folders);
 * `clientName` is the MCP client name the server reports to the app (e.g. claude-code). Returns {call, tools, close}.
 */
export async function connectMcp({ data, project, clientName = 'dev-tools', clientVersion = '0.0.0', stderr = 'pipe' } = {}) {
  if (data === undefined || data === true) throw new ToolError('refused_no_data', 'An explicit --data <test data root> is required; the real data root is never used.');
  const { dataRoot } = checkDataRoot(String(data));
  const missing = missingBuildOutputs(['mcpBundle']);
  if (missing.length) throw new ToolError('not_built', `The MCP bundle is missing (${missing.join(', ')}). Run: npm --prefix novelai/client run build.`);
  const { Client, StdioClientTransport } = await sdk();
  // A dev-tools server never starts an app by itself (src/app-autostart.mjs): start the test client with test-client.mjs.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ELECTRON_RUN_AS_NODE: '1', [dataPaths.DATA_DIR_ENV]: dataRoot, NOVELAI_MCP_AUTOSTART: '0' };
  for (const key of ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  if (project !== undefined) env[dataPaths.PROJECT_ROOT_ENV] = path.resolve(String(project));
  const transport = new StdioClientTransport({ command: electronExecutable(), args: [buildOutputs.mcpBundle], env, stderr });
  const client = new Client({ name: clientName, version: clientVersion });
  await client.connect(transport);
  return {
    client, dataRoot,
    async tools() { const { tools } = await client.listTools(); return tools; },
    async call(name, args = {}) { return flattenResult(await client.callTool({ name, arguments: args })); },
    close: () => client.close(),
  };
}
