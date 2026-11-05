#!/usr/bin/env node
// Electron build of the client (npm run build:electron; npm run build runs it after the renderer):
//  1. empties dist-electron/ and dist-mcp/, so no file of an older build is packaged;
//  2. compiles the main process with tsc (tsconfig.electron.json; this also copies
//     shared/runtime/data-paths.cjs to dist-electron/shared/runtime/);
//  3. bundles the MCP tag modules (../src/tag-details.mjs and what it imports) into
//     dist-electron/vendor/tag-details.cjs, which the main process loads instead of reaching
//     outside the client directory at run time;
//  4. bundles the MCP server (../src/mcp.mjs with @modelcontextprotocol/sdk, ajv, the contracts
//     and the tag modules) into the single file dist-mcp/novelai-mcp.mjs (both bundles are defined
//     in scripts/bundles.mjs; THIRD_PARTY_NOTICES.md lists what they contain). electron-builder ships
//     it as resources/mcp/novelai-mcp.mjs; it runs with the app's own Electron as Node:
//     ELECTRON_RUN_AS_NODE=1 <app executable> <resources>/mcp/novelai-mcp.mjs
// The MCP sources and their dependencies come from the parent novelai/ package, so its
// dependencies must be installed too (npm --prefix novelai install).
import { spawnSync } from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleDefinitions } from './bundles.mjs';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

for (const directory of ['dist-electron', 'dist-mcp']) await rm(path.join(client, directory), { recursive: true, force: true });

const tsc = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(client, 'tsconfig.electron.json')], { cwd: client, stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

// Both bundles are defined in scripts/bundles.mjs, which scripts/generate-notices.mjs reads too.
const bundles = bundleDefinitions(client);
try {
  await build(bundles.tagDetails);
  await build(bundles.mcp);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
const size = (await stat(path.join(client, 'dist-mcp', 'novelai-mcp.mjs'))).size;
console.log(`MCP bundle: dist-mcp/novelai-mcp.mjs (${(size / 1024).toFixed(0)} KiB); tag modules: dist-electron/vendor/tag-details.cjs`);
