# novelai

The two packages of MCP for NovelAI:

- `client/` — the desktop app (Electron, React, TypeScript). Its build also bundles the MCP server into
  `client/dist-mcp/novelai-mcp.mjs`.
- this folder — the MCP server `novelai` (`src/mcp.mjs`), the command line `nai` that runs the same tools from a
  terminal (`src/cli.mjs`; bundled into `client/dist-mcp/novelai-cli.mjs`, launched by `client/bin/nai`), the library
  contracts (`contracts/`), its tests (`tests/`), the agent skill of the command line (`skills/novelai-cli/`) and the
  source launcher (`scripts/start-client.mjs`).

See the [README](../README.md) for using the app, [docs/building.md](../docs/building.md) for building, testing and the
repository layout, [docs/mcp-tools.md](../docs/mcp-tools.md) for the MCP tools and [docs/cli.md](../docs/cli.md) for `nai`.
