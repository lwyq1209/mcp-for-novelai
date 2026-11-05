// Fixed locations of THIS checkout (the worktree the dev-tools file lives in). Nothing here looks at other checkouts.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const devToolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const clientDir = path.resolve(devToolsDir, '..');
export const novelaiDir = path.resolve(clientDir, '..');
export const worktreeRoot = path.resolve(novelaiDir, '..');

/** require() resolving from the client package (sharp, pngjs, @msgpack/msgpack, the compiled main process). */
export const clientRequire = createRequire(path.join(clientDir, 'package.json'));
/** require() resolving from the novelai/ package (@modelcontextprotocol/sdk). */
export const novelaiRequire = createRequire(path.join(novelaiDir, 'package.json'));

/** The development Electron executable of this checkout (node_modules/electron/dist/<path.txt>). */
export function electronExecutable() {
  const pathTxt = path.join(clientDir, 'node_modules', 'electron', 'path.txt');
  let relative;
  try { relative = fs.readFileSync(pathTxt, 'utf8').trim(); }
  catch { throw new Error(`Electron is not installed in ${clientDir} (missing ${pathTxt}).`); }
  return path.join(clientDir, 'node_modules', 'electron', 'dist', relative);
}

export const buildOutputs = Object.freeze({
  renderer: path.join(clientDir, 'dist', 'index.html'),
  main: path.join(clientDir, 'dist-electron', 'electron', 'bootstrap.js'),
  repository: path.join(clientDir, 'dist-electron', 'electron', 'library', 'repository.js'),
  mcpBundle: path.join(clientDir, 'dist-mcp', 'novelai-mcp.mjs'),
});

/** The build outputs that are missing (empty when the client has been built). */
export function missingBuildOutputs(keys = Object.keys(buildOutputs)) {
  return keys.filter(key => !fs.existsSync(buildOutputs[key])).map(key => path.relative(worktreeRoot, buildOutputs[key]));
}

/** The shared data-path module of the client (same rules as the client and the MCP server). */
export const dataPaths = clientRequire(path.join(clientDir, 'shared', 'runtime', 'data-paths.cjs'));

/** Folder of the dev-tools bookkeeping inside a test data root (marker, pid file, logs). */
export const DEV_TOOLS_FOLDER = '.dev-tools';
export const devToolsFolder = dataRoot => path.join(dataRoot, DEV_TOOLS_FOLDER);
