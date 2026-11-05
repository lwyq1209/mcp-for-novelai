# Changelog

All notable changes to MCP for NovelAI are recorded here. Versions follow [Semantic Versioning](https://semver.org).

## 0.1.3

### Added

- **Update and restart**: when a newer version exists, the top bar and Settings › About & updates offer to install it.
  The app downloads the release's `SHA256SUMS.txt` and its new Ed25519 signature `SHA256SUMS.txt.sig`, checks them with
  the key built into the app, downloads its platform's file (macOS the zip of its architecture, Windows the setup,
  Linux the tar.gz) only from the release's GitHub download address and GitHub's download hosts, through the app's proxy
  setting, and checks its SHA-256. Anything that does not verify — another signature, a changed file, an older or the
  same version, a manifest of another release — stops the update; nothing is installed. The download shows its progress,
  can be cancelled and continues where it stopped.
- macOS: the new version must also pass `codesign --verify --deep --strict` and carry the running app's certificate. A
  helper started by the app swaps the bundles after the app quit, starts the new version and puts the old one back if it
  does not start. Windows: the checked installer runs silently into the same per-user installation. Linux: the extracted
  folder is replaced the same way as on macOS. The app keeps its path, so agent configurations stay valid.
- The update waits while the queue has batches generating or waiting (manual ones too): **Update after the queue**.
  The app quits normally before it installs; it is never killed.
- The first start after an update says **Updated to x.y.z** with a link to its release notes, or why the update did not
  complete; what the update left (the old version, the download) is removed.
- Releases carry `SHA256SUMS.txt.sig`; [docs/updates.md](docs/updates.md) shows how to check it and describes the
  threat model.
- `dev-tools/update-rehearsal.mjs` and a fake GitHub release (`dev-tools/lib/fake-release-server.mjs`): a real update
  between two rehearsal builds with throwaway keys; the CI workflow runs it on all three platforms on request.

### Changed

- macOS builds are signed with the project's fixed self-signed certificate instead of ad-hoc, so the Keychain's
  **Always Allow** for the app survives updates. After installing 0.1.3 the Keychain asks one last time. Gatekeeper
  treats the app as before (not notarized): the first manual install still needs **Open Anyway** and the `xattr`
  command; an in-app update needs neither.
- Updating from 0.1.2 to 0.1.3 is still done by hand: 0.1.2 does not have the in-app update.

## 0.1.2 - 2026-11-05

### Fixed

- Large images show whole again: the library's image detail and its full screen, the canvas full screen, the full
  screen of preset images and the generation preview showed only part of a tall image (for example 832×1216, or
  1664×2432 after an upscale), and cropped thumbnails (cards, covers, queue cells) were cut from the top instead of
  around the centre.
- The pictures beside a Style or prompt preset (shown while the pointer rests on it) load after a restart too; before,
  they stayed broken until that preset's image dialog had been opened.
- macOS: the READMEs and Troubleshooting say that **Open Anyway** only covers starting the app with a double-click,
  and give the one `xattr` command an agent's MCP server needs (it removes the quarantine mark of the download, which
  is the same as trusting the app).

## 0.1.1 - 2026-11-05

### Added

- Agents open the app themselves: when it is not running, the MCP server starts it in the background and sends the
  call once it is ready (at most about 30 seconds). The app never takes the focus and keeps its window out of the
  way: on macOS only its Dock icon appears (click it to show the window), on Windows it is minimized in the taskbar,
  on Linux it runs in the background until you open it again. Only a call that certainly reached no app
  starts anything; a call whose outcome may be unknown is never sent again. One start per minute per server, one
  server per data folder at a time. `NOVELAI_MCP_AUTOSTART=0` turns it off. macOS starts the app through
  LaunchServices, Windows outside the agent's process tree (WMI), Linux as a detached process. The started app gets
  none of the agent's environment (only what the system needs to run it: no tokens, keys or proxies), and on the
  default data folder it starts as from its icon (images still go to `<Pictures>/MCP for NovelAI`). A server run from
  source with your own Node does not start the app.
- Settings › MCP access shows which agent started the app and when, and says under Advanced how to turn the automatic
  start off.
- DeepSeek Harness (dsh) in Settings › MCP access and the README: a `@deepseek-ai/dsh-mcp-client` row for
  `cordis.patch.yml` with the 26-minute tool timeout (`toolCallTimeoutMs`).

### Changed

- `unavailable` now says whether anything was sent and, when the server did not start the app, why
  (`details.autostart`). The server instructions describe the automatic start.
- The Windows source launcher quotes a command-line argument that ends in a backslash correctly.

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
