# Changelog

All notable changes to MCP for NovelAI are recorded here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-05

First public release. MCP for NovelAI is based on Langbai NovelAI Studio 2.2.8 (MIT License,
<https://github.com/2786886095/novelai-image-desktop>) and reworked into a desktop client for AI agents.

### Added

- An MCP server (`novelai`) with 18 tools in three groups — library, recipes & queue, canvas — shipped inside the app
  and run with the app's own executable as Node, so no separate Node.js install is needed.
- Frozen recipes for six modes (Txt2Img, Img2Img, Inpaint with masks built from shapes, Enhance, Upscale, Director)
  with a readback of the exact effective input before anything is generated.
- One shared, ordered queue for agent and manual images, with request keys against paying twice, pause / resume /
  cancel per batch, stop protection after a failed or unknown image, limits per enqueue and in total, and retention of
  ended batches (7, 30 or 90 days, or forever; 30 by default) that keeps old request keys answered.
- A rebuilt library as the home page: history and imported images, tags, combos, notes, presets and artist picks,
  collections and projects, filters, version history, multi-select and Recently deleted (30 days).
- A new interface (library, canvas, queue, settings, first-run guide); agent drafts shown on the canvas to apply or
  discard.
- Settings › MCP access, which writes ready-to-paste configurations for Claude Code, Cursor, Codex, Pi and other
  `mcpServers` clients and shows recent agent connections.
- Automatic backups and `.naisbackup` export and restore; the API token is encrypted with the system's secure storage.
- A new-version notice from GitHub releases (announce only; it can be turned off).
- Release files: macOS dmg and zip for Apple silicon (arm64) and Intel (x64), ad-hoc signed; a Windows x64 installer
  (NSIS); a Linux x64 tar.gz; `SHA256SUMS.txt`; and `third-party-sources-<version>.tar.gz` with the source code of the
  libraries inside the bundled libvips.

### Changed

- New name, app ID and data folder (`mcp-for-novelai`); images are saved to `<Pictures>/MCP for NovelAI` by default.
- Interface languages: English and Chinese; dark theme only.

### Removed

- Features of the upstream app outside this project's scope, among them the online galleries, AI prompt reverse,
  conversion and translation, the built-in agent and Character Tavern, the comic and Prompt Codex tools, batch
  Img2Img and the artist lab tools.
