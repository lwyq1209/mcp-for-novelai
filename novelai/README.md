# novelai

The two packages of MCP for NovelAI:

- `client/` — the desktop app (Electron, React, TypeScript). Its build also bundles the MCP server into
  `client/dist-mcp/novelai-mcp.mjs`.
- this folder — the MCP server `novelai` (`src/mcp.mjs`), the library contracts (`contracts/`), its tests (`tests/`)
  and the source launcher (`scripts/start-client.mjs`).

See the [README](../README.md) for using the app, [docs/building.md](../docs/building.md) for building, testing and the
repository layout, and [docs/mcp-tools.md](../docs/mcp-tools.md) for the MCP tools.
