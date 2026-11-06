# Changelog

All notable changes to MCP for NovelAI are recorded here. Versions follow [Semantic Versioning](https://semver.org).

## Unreleased

### Added

- `read_queue` `wait: {until: "done" | "next", seconds}` (1–1200, default 300): the server polls the app every 1–2
  seconds and returns as soon as the batch ended, saved a new result, was paused or cancelled, or the time ran out, with
  `wait: {until, ended, waitedSeconds}`; failed reads on the way are read through and cancelling the request stops it.
- `read_queue` says where a batch stands: `ahead: {images, batches}` queued before it, `etaSeconds` (from the recent
  image times and the intervals) and `imageSeconds`, plus `itemCounts`, `rateLimitRetries` per image and `itemReasons`
  for the queue's own item codes.
- `get_queue_result` without `itemIndex` returns the whole batch's saved results as thumbnails (at most 384 px, 20 per
  call, `offset` pages on), each with its `itemIndex`, `index`, `historyId`, `actualSeed`, `fileName` and `file`.
- Queue items record when they started and ended (`startedAt`, `finishedAt`).
- **V5 Full Effort**: the canvas has a High / Medium switch beside V5 Full (and V5 Full inpainting). Medium runs
  NovelAI's distilled model (`nai-diffusion-5-full-medium`, inpaint `nai-diffusion-5-full-medium-inpainting`), about
  42 % cheaper at default settings, with 14 steps, Euler Ancestral, the Heavy UC preset and no negative prompt or CFG
  rescale; those controls show their fixed values while Medium is on. Images made with Medium name their model in the
  library, and their metadata is recognised on import.
- `prepare_recipe` takes `effort: "high" | "medium"` for V5 Full txt2img, img2img and inpaint. Medium's fixed fields may
  be left out; given values are replaced and reported as `effort_medium_fixed` warnings. The readback shows the model id
  sent and the fixed UC text.
- **Enhance Max✨** (V5 models): the image is sent at its own size and comes back about twice as large (at most about
  3.1 MP) through NovelAI's new upscaler. Canvas Enhance offers it beside 1× and 2×; `prepare_recipe` takes
  `scale: "max"` and `draft_edit` `enhanceScale: "max"`. Max costs Anlas on Opus too.
- `lookup_enqueue` reports `inFlight`: whether the app has received an enqueue under the key and is still handling it.
- `prepare_recipe` i2i may leave out `width`/`height`: the source's aspect ratio is used at about 832×1216 pixels,
  within the Opus free size (warning `i2i_size_from_source`).

### Changed

- The local Anlas estimate prices V5 models at 1.5× the formula, as NovelAI's own client does (it was lower before).
- Imported V5 Curated images (metadata `Source` "NovelAI Diffusion V5 DB276663") are recognised as Curated, not Full.
- **No failure stops the shared queue any more.** An image that fails, is refused before it is sent or has an unknown
  outcome marks only itself (never resent); its batch goes on with its next image after its interval, and no batch
  pauses another (agent or manual). A batch that ran to its end this way ends with the new status **partial**
  (部分完成), never succeeded; `blocked` stays readable for batches stored before. The stop reason `queue_halted`, the
  automatic pause of later agent batches and the confirmation before resuming such a batch are gone.
- A received **HTTP 429** (for example "Concurrent generation is locked"; nothing generated) is sent again with the
  same frozen recipe and seed after 2, 4, 8, 16 and 30 seconds, then fails as `rate_limited`. A timeout, a dropped
  connection or an unknown outcome is still never resent.
- A status read or pre-submit lookup of the running image that fails is tried again for about 90 seconds; then only
  that image is unknown (`child_status_unavailable`, `child_lookup_failed`) and the batch goes on. Two images still
  never run at once.
- **After a restart, unfinished batches continue by themselves** (also when an agent's MCP server starts the app): an
  image that was running and was not saved is unknown (`restart_unconfirmed`, never resent), the rest goes on. A batch
  the user paused stays paused. Batches the queue had paused itself (closing app, an older version's stop after a
  failure, `recovered_paused`) continue.
- Unchanged: a frozen-queue storage failure still stops every agent batch; request keys, the per-enqueue and total
  limits, pause, resume, cancel and the hold before an update work as before.
- **`prepare_recipe` corrects instead of refusing** what the app would clamp, snap, resize, convert or drop anyway
  (`steps` 99, a 1000×1500 size, a V5 noise schedule other than karras, `light` quality or `transparentBackground` off
  V5, too many characters, `effort: "medium"` where it does not exist, an unaligned enhance or inpaint source, Max✨ off
  V5…): the corrected value is saved and each correction is a readback warning with `field`, `from` and `to`. An i2i
  size more than 3 % off the source's aspect ratio is refitted to it (`i2i_size_adjusted`) instead of refused. The input
  schema no longer limits these values, so clients do not refuse them before the call. Still refused: missing fields,
  unknown names, wrong types, fields of another mode, unreadable sources, and sizes NovelAI cannot make.
- Upscale and Director downscale a source over 1,048,576 pixels by default (warning `source_downscaled`);
  `acceptDownscale: false` keeps the old refusal.
- `enqueue_recipes`: a fixed-seed recipe used for several images without `seeds` gives them seed, seed + 1, … (listed
  in the receipt, warning `fixed_seed_incremented`) instead of a refusal, and an upscale or Director recipe listed with
  seeds, a count or twice is sent once (`postprocess_single_image`).
- **`enqueue_recipes` settles a lost answer itself**: after a timeout, a dropped connection or a reply that does not
  confirm the plan, it looks the request key up and sends the same plan under the same key again while the app holds
  nothing it is working on (the app deduplicates the key; never a second batch), for up to about 150 seconds, and
  answers `enqueued` (`reconciled: true`) or the definite refusal. The 130-second settle window, the per-process hold
  and the two-lookups-before-a-new-key rule are gone; `lookup_enqueue` answers at once and advises a new key only when
  the app finished with the key without a batch and cannot start it again. The app no longer lets a lookup turn a
  running enqueue's receipt unknown (which made that enqueue give up), and it starts a receipt whose enqueue ended
  without a batch again when the same plan comes under the same key.

## 0.1.3 - 2026-11-06

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
- Releases carry `SHA256SUMS.txt.sig`, made offline by the maintainer with `.github/scripts/sign-release.mjs` (the
  update key is never in CI or on GitHub); [docs/updates.md](docs/updates.md) shows how to check it and describes the
  threat model.
- From the hand-over to the update helper until the app quits, the queue starts no image (agents see
  `stopReason.code: "update_pending"`); a batch that arrives then calls the update off. While an update installs, MCP
  servers do not start the app: `unavailable` with `details.autostart: "updating"`. An old version opened during the
  update quits at once. Windows: the helper gives up when another copy of the app (another data folder) runs from the
  same installation, since the installer would end it.
- The helper runs with a minimal environment (`/bin/sh -p`), and the downloaded file, the staged app (macOS code
  signature and certificate) and the Windows installer are checked again right before they are used.
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
