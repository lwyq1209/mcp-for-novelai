# Building from source and development

- [Requirements](#requirements)
- [Build and run](#build-and-run)
- [Connect an agent to a build from source](#connect-an-agent-to-a-build-from-source)
- [Optional Chinese tag dictionary](#optional-chinese-tag-dictionary)
- [Repository layout](#repository-layout)
- [How the pieces talk](#how-the-pieces-talk)
- [Tests and checks](#tests-and-checks)
- [Dev tools](#dev-tools)
- [Packaging and releases](#packaging-and-releases)
- [Third-party notices](#third-party-notices)

## Requirements

- [Node.js](https://nodejs.org/) 22.12 or later, with npm (Electron 42 requires Node 22.12; the MCP server and the
  build tools run on it too).
- Git.
- macOS, Windows or Linux.

## Build and run

```sh
git clone https://github.com/lwyq1209/mcp-for-novelai.git
cd mcp-for-novelai
npm ci --prefix novelai
npm ci --prefix novelai/client
node novelai/client/node_modules/electron/install.js
node novelai/scripts/start-client.mjs
```

- The two `npm ci` install the MCP server package (`novelai`) and the desktop client (`novelai/client`); the client
  build bundles the MCP server from the first one, so both are needed.
- `node …/electron/install.js` downloads the Electron binary once: Electron 42 does not download it during `npm ci`,
  and `start-client.mjs` does not download it either.
- `start-client.mjs` builds the client (`npm run build` in `novelai/client`) and starts it in the foreground of the
  terminal.

Options of `node novelai/scripts/start-client.mjs`:

| Option | Effect |
| --- | --- |
| `--no-build` | Start the existing build without building again (after the first build, when the source has not changed). |
| `--data-dir <folder>` | Use this data folder (sets `NOVELAI_DATA_DIR`) instead of the default one; for development and tests. |
| `--inpaint-diagnostics` | For this run, save the raw inpaint requests and responses in `inpaint-diagnostics/` of the data folder. |
| `--detach` (Windows only) | Run the launcher in the background without a console window. |

On Windows you can also double-click `novelai\scripts\start-client.cmd` (or run it with `--no-build` /
`--inpaint-diagnostics`): it runs `start-client.mjs --detach`, waits until the app is ready and keeps running after the
window closes. Its logs are in `novelai\.tmp\client-launch\`. Stop the app by closing its window.

Without `--data-dir` a build from source uses the same data folder as an installed app (see the
[README](../README.md#data-and-privacy)). Only one app runs per data folder; starting a second one brings the first
window to the front. With `NOVELAI_DATA_DIR` set (or `--data-dir`), images are saved to `output/` inside that data
folder by default, so test runs never write into your Pictures folder. A build from source never checks for updates on
its own (Settings › About & updates › Check for updates still works).

## Connect an agent to a build from source

Settings › MCP access shows the configuration for this build: it runs `novelai/client/dist-mcp/novelai-mcp.mjs` with
the checkout's Electron as Node and names the data folder as `NOVELAI_DATA_DIR`. Rebuilding replaces the bundle at the
same path, so the configuration keeps working. Settings › MCP access › Advanced also shows a command that runs the
server from source with your own Node (`node novelai/src/mcp.mjs`).

## Optional Chinese tag dictionary

Searching tags with a Chinese word (the library's tag search and `material_library` `search_tags`) uses an optional
third-party dictionary that is not part of the app. With a built client, install it into the data folder:

```sh
node novelai/scripts/install-tag-dictionary.mjs
```

It downloads one pinned file (`tags_enhanced.csv` of
[DanbooruSearchOnline](https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline), GPL-3.0, partly machine-generated
data) from `raw.githubusercontent.com`, checks its size and sha256, and saves it in `runtime/tag-dictionary` of the
data folder (`NOVELAI_DATA_DIR` applies). Restart the app afterwards.

## Repository layout

| Path | What it is |
| --- | --- |
| `novelai/client/electron/` | The Electron main process: NovelAI requests, the queue, the library (SQLite), backups, the local bridge for the MCP server |
| `novelai/client/src/` | The interface (React): library, canvas, queue, settings, first-run guide |
| `novelai/client/shared/runtime/data-paths.cjs` | Where the data folder and the inbox folders are; shared by the app and the MCP server |
| `novelai/client/dev-tools/` | Tools for isolated test clients, a fake NovelAI service and sample libraries |
| `novelai/client/scripts/` | Build, icon and third-party-notice scripts |
| `novelai/src/` | The MCP server (`mcp.mjs`: 11 core tools in `mcp-core-tools.mjs`, 7 canvas tools in `mcp-canvas-tools.mjs`) |
| `novelai/contracts/` | TypeBox sources of the library contracts and the JSON schemas generated from them |
| `novelai/tests/` | Tests of the MCP server (`node --test`) |
| `novelai/scripts/` | The source launcher (`start-client.mjs`), contract build, tag dictionary installer |

## How the pieces talk

- The app's main process serves a local bridge on `127.0.0.1` (a random port) and writes
  `{schemaVersion: 1, url, token, pid}` to `runtime/bridge.json` in the data folder (mode 0600). It accepts only
  `POST /rpc` with `Authorization: Bearer <token>` from the same machine, without a browser `Origin`.
- The MCP server (`novelai/src/mcp.mjs`, bundled into `dist-mcp/novelai-mcp.mjs` by `scripts/build-electron.mjs`) reads
  that file on every call, validates every argument before it calls the app, and calls only the fixed host methods of
  each tool. Both sides find the data folder through `shared/runtime/data-paths.cjs` (`NOVELAI_DATA_DIR`, else
  `<appData>/mcp-for-novelai`).
- When a call certainly reached no app (no `bridge.json`, a refused connection: `src/bridge-client.mjs`
  `fetchFailureDelivery`), the server starts the app it belongs to (`src/app-autostart.mjs`, `src/app-launch.mjs`) with
  `--started-by-agent`, waits for its bridge and sends the call once more. From source that is the built client whose
  `dist-mcp/` bundle runs with that client's development Electron: `electron <client> --started-by-agent` (macOS through
  `open -n -g -a …/Electron.app`). A server run with your own Node (`node novelai/src/mcp.mjs`) never starts anything.
  Test processes never start the app (`NODE_TEST_CONTEXT`, `VITEST`, `tests/run-tests.mjs`), and every test, the
  dev-tools MCP caller and the release check set `NOVELAI_MCP_AUTOSTART=0` for the servers they run.
- The NovelAI token stays in the main process; it never crosses the bridge or appears in tool results.
- The library's public schemas are written once in `novelai/contracts/src/library-contracts.mts`;
  `npm --prefix novelai run build:contracts` generates `novelai/contracts/generated/` and
  `novelai/client/src/generated/`, and `check:contracts` fails when they are stale.

## Tests and checks

```sh
npm --prefix novelai test                        # MCP server tests
npm --prefix novelai run check:contracts         # generated contracts are up to date
npm --prefix novelai/client run typecheck        # renderer and main process
npm --prefix novelai/client test                 # client tests (vitest)
npm --prefix novelai/client run build            # renderer, main process and MCP bundle
npm --prefix novelai/client run notices:check    # THIRD_PARTY_NOTICES.md is up to date
NODE_DISABLE_COMPILE_CACHE=1 npm --prefix novelai/client run test:dev-tools
```

`npm test` of both packages runs inside a throwaway folder: `NOVELAI_DATA_DIR` (also one set in your shell) and the
temp folder are replaced for the run, so tests never read or write your real data folder.

## Dev tools

`novelai/client/dev-tools/` holds reusable tools for working on the app without your own data, a real token or paid
generation: an isolated, windowed test client (`test-client.mjs`, started in the background by default), a scriptable
driver for its window (`ui.mjs`), a local stand-in for the NovelAI API with fault injection (`fake-novelai.mjs`), a
sample library generator (`seed-library.mjs`) and an MCP caller for a test data folder (`mcp.mjs`). They refuse real
data folders. Usage, safety rules and examples: [`novelai/client/dev-tools/README.md`](../novelai/client/dev-tools/README.md).

## Packaging and releases

```sh
npm --prefix novelai/client run dist:mac      # dmg and zip for this Mac's architecture (arm64 or x64)
npm --prefix novelai/client run dist          # Windows NSIS installer
npm --prefix novelai/client run dist:linux    # Linux tar.gz
```

Each script builds the client, runs `notices:check` and then electron-builder, which never publishes anything
(`--publish never`). The files go to `novelai/client/release/`: `MCP-for-NovelAI-<version>-mac-<arch>.{dmg,zip}`,
`MCP-for-NovelAI-<version>-win-x64-setup.exe`, `MCP-for-NovelAI-<version>-linux-x64.tar.gz`. sharp's native
packages are those npm installed for the machine that builds, so build each platform and architecture on its own
system. macOS builds are ad-hoc signed (`identity: "-"`); nothing else is signed.
`node .github/scripts/packaged-app-check.mjs` checks an output without opening a window: the file names, the
resources, that sharp loads from the packaged `app.asar`, the packaged MCP server's tools and, on macOS, the signature.

Releases are built by `.github/workflows/release.yml` on GitHub-hosted runners (macOS arm64 and Intel, Windows x64,
Linux x64) for a `v<version>` tag, after the CI tests. It runs the same scripts and the check, builds
`third-party-sources-<version>.tar.gz` (`.github/scripts/third-party-sources.mjs`: the source archives of the
libraries in sharp's libvips, checked against the vendored license files), writes `SHA256SUMS.txt`, and after a
maintainer's approval creates a draft GitHub release with the `CHANGELOG.md` entry of that version as its notes. A
maintainer publishes the draft by hand.

## Third-party notices

`novelai/client/THIRD_PARTY_NOTICES.md` is generated from the lockfile, the installed packages and vendored license
files by `novelai/client/scripts/generate-notices.mjs` (`npm --prefix novelai/client run notices`; `notices:check`
fails when it is stale, and every packaging script runs the check). The license files of the libraries inside sharp's
prebuilt libvips are vendored in `novelai/client/scripts/licenses/sharp-libvips/` by
`scripts/fetch-libvips-licenses.mjs`, and those of the Rust crates compiled into its librsvg by
`scripts/fetch-rsvg-crate-licenses.mjs` (it also needs `cargo`). Both are maintenance scripts that need the network; run
them again after a sharp upgrade that changes the sharp-libvips version, review the result and commit it. The app shows `LICENSE` and the notices in
Settings › About & updates.
