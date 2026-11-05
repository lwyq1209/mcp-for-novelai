// The two esbuild bundles of the client build (scripts/build-electron.mjs), in one place so that
// scripts/generate-notices.mjs lists exactly the third-party packages they contain:
//   tagDetails  ../src/tag-details.mjs → dist-electron/vendor/tag-details.cjs (loaded by the main process)
//   mcp         ../src/mcp.mjs → dist-mcp/novelai-mcp.mjs (shipped as resources/mcp/novelai-mcp.mjs)
import path from 'node:path';

// Electron 42 runs Node 24; the bundles keep to features of the Node it embeds.
export const NODE_TARGET = 'node24';

/** esbuild options of both bundles for the client folder `client` (novelai/client). */
export function bundleDefinitions(client) {
  const novelai = path.resolve(client, '..');
  const shared = { bundle: true, platform: 'node', target: NODE_TARGET, absWorkingDir: novelai, logLevel: 'warning', legalComments: 'eof', sourcemap: false };
  return {
    tagDetails: {
      ...shared, entryPoints: [path.join(novelai, 'src', 'tag-details.mjs')], outfile: path.join(client, 'dist-electron', 'vendor', 'tag-details.cjs'), format: 'cjs',
      banner: { js: '// Bundled from novelai/src/tag-details.mjs by client/scripts/build-electron.mjs; do not edit.' },
    },
    mcp: {
      ...shared, entryPoints: [path.join(novelai, 'src', 'mcp.mjs')], outfile: path.join(client, 'dist-mcp', 'novelai-mcp.mjs'), format: 'esm',
      // Bundled CommonJS dependencies (ajv and friends) may require() Node built-ins; an ES module has no require.
      banner: { js: "// MCP for NovelAI server, bundled from novelai/src/mcp.mjs by client/scripts/build-electron.mjs; do not edit.\n// Third-party code in this file: see THIRD_PARTY_NOTICES.md in the app's resources folder (the parent of this mcp folder).\nimport { createRequire as __novelaiCreateRequire } from 'node:module';\nconst require = __novelaiCreateRequire(import.meta.url);" },
    },
  };
}
