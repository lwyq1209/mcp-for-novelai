// The bundled MCP server (dist-mcp/novelai-mcp.mjs) with a bridge client that loses chosen calls, for checking how the
// server handles a lost answer (mcp.mjs --bridge-fault). Started exactly like the bundle (this checkout's Electron as
// Node, a TEST data root, NOVELAI_MCP_AUTOSTART=0) by lib/mcp-client.mjs; the shipped server has no such hook.
//   ELECTRON_RUN_AS_NODE=1 <electron> lib/mcp-fault-server.mjs <bundle>   with NAI_DEV_TOOLS_BRIDGE_FAULTS=<json>
// Faults [{method, kind, times}]: request-lost (the call never reaches the app), reply-lost (the app handles it and its
// answer is lost), each as the bridge's own timeout; times is a count or "always", counted per method from the start.
import { pathToFileURL } from 'node:url';
import { novelaiRequire } from './paths.mjs';

const [bundle] = process.argv.slice(2);
const { BridgeError, createBridgeClient, createNovelAiMcpServer } = await import(pathToFileURL(bundle).href);
const { StdioServerTransport } = await import(pathToFileURL(novelaiRequire.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const faults = JSON.parse(process.env.NAI_DEV_TOOLS_BRIDGE_FAULTS ?? '[]').map(fault => ({ ...fault, left: fault.times === 'always' ? Infinity : fault.times }));
const lost = () => new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown; read current state. Do not automatically repeat a mutation.');
const real = createBridgeClient();
const bridgeClient = { async call(method, args, signal, caller) {
  const fault = faults.find(item => item.method === method && item.left > 0);
  if (fault) { fault.left--; process.stderr.write(`[dev-tools] bridge fault ${fault.kind} on ${method}\n`); }
  if (fault?.kind === 'request-lost') throw lost();
  const result = await real.call(method, args, signal, caller);
  if (fault?.kind === 'reply-lost') throw lost();
  return result;
} };
await createNovelAiMcpServer({ bridgeClient }).connect(new StdioServerTransport());
