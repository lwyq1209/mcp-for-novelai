#!/usr/bin/env node
// Calls the bundled MCP server of a TEST data root.
//   node dev-tools/mcp.mjs tools --data <dir> [--names]
//   node dev-tools/mcp.mjs call <tool> '<json args>' --data <dir> [--project <dir>] [--client-name claude-code]
//   node dev-tools/mcp.mjs --help
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, printUsage, runCli } from './lib/cli.mjs';
import { connectMcp } from './lib/mcp-client.mjs';
import { withFrontWatch } from './lib/front-watch.mjs';

export { connectMcp };

// Every command runs under the front-app watcher (macOS): a test client in front fails it with front_detected.
async function main(argv) {
  if (helpRequested(argv)) return printUsage(import.meta.url);
  return withFrontWatch(`mcp.mjs ${argv[0] ?? ''}`.trim(), () => command(argv));
}
async function command(argv) {
  const { positional, options } = parseArgs(argv, { booleans: ['names'] });
  const [command, tool, json] = positional;
  if (command !== 'tools' && command !== 'call') throw new ToolError('usage', "Usage: mcp.mjs tools --data <dir> | call <tool> '<json>' --data <dir> [--project <dir>] [--client-name <name>]");
  allowOptions(options, ['data', 'project', 'client-name', 'client-version', 'names']);
  let args = {};
  if (command === 'call') {
    if (!tool) throw new ToolError('usage', 'call needs a tool name.');
    try { args = json === undefined ? {} : JSON.parse(json); } catch { throw new ToolError('usage', 'The tool arguments must be one JSON object.'); }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('usage', 'The tool arguments must be one JSON object.');
  }
  const mcp = await connectMcp({ data: options.data, project: options.project, clientName: options['client-name'] ?? 'dev-tools', clientVersion: options['client-version'] ?? '0.0.0' });
  try {
    if (command === 'tools') {
      const tools = await mcp.tools();
      return { ok: true, count: tools.length, tools: options.names ? tools.map(entry => entry.name) : tools.map(entry => ({ name: entry.name, description: String(entry.description ?? '').split('\n')[0].slice(0, 200) })) };
    }
    const result = await mcp.call(tool, args);
    return { ok: !result.isError, tool, ...result };
  } finally { await mcp.close(); }
}

if (isMain(import.meta.url)) await runCli(main);
