# MCP for NovelAI

A desktop NovelAI image client built to be driven by AI agents. Your agent — Claude Code, Cursor, Codex, Pi, or anything
that can run a command — works it through the bundled **MCP server** or the **`nai` command line**: it prepares
recipes, queues images and organises your library, while you watch, steer and paint in the app.

**English** · [简体中文](README.zh-CN.md)

[Download](https://github.com/lwyq1209/mcp-for-novelai/releases/latest) · [MCP tools](docs/mcp-tools.md) · [The `nai` command line](docs/cli.md) · [Changelog](CHANGELOG.md)

![The queue page: a batch queued from the nai command line is running, batches from Claude Code and Codex wait behind it, and images made by hand are below](docs/images/queue.png)

*One queue for everyone: a batch from `nai` in a terminal is running, batches that Claude Code and Codex queued over MCP
wait behind it, and the images made by hand on the canvas are below.*

## Two ways to drive it: MCP and `nai`

| | MCP server (`novelai`) | `nai` command line |
| --- | --- | --- |
| Made for | Agents that speak MCP: Claude Code, Cursor, Codex, Pi, Claude Desktop and other `mcpServers` clients | Agents that work in a shell, scripts, and people who like a terminal |
| Set up | Copy the configuration that **Settings › MCP access** writes for your agent | Link one launcher onto your `PATH` |
| You pass | JSON arguments in a tool call | Options, or JSON files the agent edits on disk |
| You get back | Structured answers; images as pictures the model looks at | One JSON document on stdout that `jq` can read; images written to files |
| Long prompts | Travel in the conversation | Stay in recipe files (`nai asset recipe` never prints them) |
| Needs Node.js | No, it runs with the app's own executable | No, the same |

Both are the same thing underneath: `nai` creates the bundled MCP server in its own process and calls it as an MCP
client, so every check, every error and every rule about paid requests is identical. Both start the app in the
background when it is closed, and both appear by name on the queue page and under Settings › MCP access (`nai` as
`nai-cli`). Use either, or both at once.

### Through MCP

Ask your agent something like *"make six more of that cafe picture in my Warm watercolor preset and file them in a
project called cafe-scene"*. The calls it makes:

```jsonc
// asset_library: find the style preset (and the picture) in the library
{ "action": "list", "kinds": ["style_preset"], "query": "Warm watercolor" }

// prepare_recipe: freeze the recipe. The preset writes artists, negative text and sampling.
{ "mode": "t2i", "stylePresetId": "26e1ecd8-…", "seed": null, "width": 832, "height": 1216,
  "positivePrompt": "1girl, solo, cafe interior, window light, holding cup, apron, smile" }

// enqueue_recipes: generate. This is the only call that does.
{ "requestKey": "cafe-scene-01", "historyGroup": "cafe-scene",
  "items": [{ "recipeId": "b1d60659-…", "recipeRevision": 1, "inputHash": "34bfc690…", "count": 6 }] }

// read_queue: wait inside the call until the batch is done
{ "batchId": "0641ccfd-…", "wait": { "until": "done" } }

// get_queue_result: look at the six results as thumbnails
{ "batchId": "0641ccfd-…" }
```

### From a terminal

The same job with `nai`. The recipe is a file, so the agent edits it with its own tools instead of repeating the prompt
in every call:

```sh
# a history image's settings as an editable recipe file
nai asset recipe 2ce58f34-… -o draft.json

# freeze it; prints what the app decided or corrected
nai prepare -f draft.json --seed null -o prepared.json

# generate, wait for the batch, then save its thumbnails as files in .tmp/nai-cli/
nai enqueue -f prepared.json --key cafe-scene-01 --count 6 --group cafe-scene
nai queue read 0641ccfd-… --wait done
nai queue result 0641ccfd-…
```

```json
{"status":"enqueued","batchId":"0641ccfd-1cb4-48ef-99aa-4fdfd2f6bb12","count":6}
```

A few more:

```sh
nai tags "looking at viewer"        # Danbooru facts: canonical name, post count, wiki
nai study import ref.png            # import an image with the settings it carries
nai workspace read                  # what is on the canvas now; images saved as files
nai call asset_library @args.json   # any action of any tool, with JSON arguments
nai skill                           # the agent guide for the installed version
```

### The tools

| MCP tool | `nai` | What it does |
| --- | --- | --- |
| `asset_library` | `nai asset …` | Search, read, view, organise, delete and restore everything in the library; write style presets; censor an image |
| `material_library` | `nai material …` | Prompt materials: tags, combos and notes; tag search; tag covers |
| `material_studies` | `nai study …` | Import images with their generation metadata and read them |
| `tag_details` | `nai tags` | Danbooru facts about tags: canonical name, aliases, post count, wiki, co-occurring tags |
| `prepare_recipe` | `nai prepare` | Freeze one recipe (Txt2Img, Img2Img, Inpaint, Enhance, Upscale, Director) and read back the exact effective input |
| `enqueue_recipes` | `nai enqueue` | **Generate:** put frozen recipes into the queue (paid, no further confirmation) |
| `list_queue` | `nai queue list` | The queue: counts by status and the first 8 batches, agent and manual ones |
| `read_queue` | `nai queue read` | One batch: status, progress, saved images; can wait until it is done |
| `get_queue_result` | `nai queue result` | View one saved image, or a batch's results as thumbnails |
| `read_workspace` | `nai workspace read` | The canvas's state and its images |

Only `enqueue_recipes` starts generation. `read_workspace` only reads the canvas; batches are paused, resumed and
cancelled on the queue page of the app. `nai call <tool>` reaches every action that has no command of its own.
Details: [MCP tools reference](docs/mcp-tools.md) and [The `nai` command line](docs/cli.md).

What an agent can do with them:

- **Start from what the library holds**: read back the settings a history image was made with, use an imported image
  as a source, and apply a style preset by its id instead of copying its text.
- **Prepare before anything is paid**: `prepare_recipe` freezes a recipe, written out in the call or captured from the
  live canvas, and reads back what will actually be sent. A value NovelAI would not take as written (a size off the
  64-pixel grid, too many steps) is corrected with a warning instead of refused.
- **Generate and follow the batch**: `enqueue_recipes` queues frozen recipes under a `requestKey`, so a retried call
  never queues twice.
- **Use what the canvas has**: V5 Full at High or Medium effort, Enhance Max✨, and precise references (character,
  style, outfit) taken from library images.
- **Tidy up afterwards**: save a run into its own project, file images into collections, keep tags, combos and notes
  as materials, write style presets with their sample images, and censor an image into a metadata-free JPG.

## In the app

### Library

![The library: history images by day, with one image open in the detail drawer showing its prompt, its settings and the agent that made it](docs/images/library.png)

The home page. History images by day, imported images and prompt materials, with search, filters (mode, model, date,
source, archived), collections, projects, version history and multi-select. An image's drawer shows the prompt and
settings it was made with and who made it, and sends any of it back to the canvas. Deleted items go to **Recently
deleted** for 30 days.

### Style presets

![A style preset: its artists with weights and on/off switches, the negative text of the style and its sample images](docs/images/style-preset.png)

A style is more than a prompt. A preset keeps its artists (each with a weight and an on/off switch), the negative text
that belongs to the style, recommended sampling settings, notes and up to six labelled sample images. Choosing one on
the canvas applies it, an agent applies it by id, and an imported image that carries settings can be saved as a preset.

### Canvas

| Txt2Img | Inpaint, with the mask painted on the image |
| --- | --- |
| ![The canvas after a Txt2Img generation, with the recent images below](docs/images/canvas.png) | ![Inpaint: a mask painted over part of the source image](docs/images/inpaint.png) |

A manual workbench for Txt2Img, Img2Img, Inpaint and Post: Enhance (1×, 2×, and Max✨ on V5), Upscale and the Director
tools (remove background, line art, sketch, colorize, emotion, declutter). NovelAI Diffusion V3 to V5, with the High /
Medium effort switch of V5 Full. Precise references (character, style, character & style; outfit on V5) on V4.5 and V5,
and Vibe references on the models that have them. Agents read the canvas and can generate what it holds; they do not
edit it.

### One queue

Every image, from an agent or from the canvas, goes through one queue in order (the picture at the top of this page).
Pause, resume and cancel per batch. A failed or unknown image never holds anyone up: only that image is marked (never
resent) and the queue goes on; a "too many requests" answer is retried for about a minute, and after a restart
unfinished batches continue by themselves.

### Censor and export

![Censor and export: a mosaic painted over part of an image, with the export settings on the right](docs/images/censor.png)

Paint over part of an image to cover it with a mosaic, a blur, black or white, and save JPGs that carry no metadata at
all: no prompt, no settings, no EXIF, none of NovelAI's hidden data. One image or up to 100 at a time; the originals in
the library are only read. An agent does the same with `asset_library` `censor` (`nai asset censor`).

### Tags and imported images

| Danbooru tags and the combo tray | The settings an imported image carries |
| --- | --- |
| ![Tags as materials with covers, a tag's Danbooru facts, and the combo tray](docs/images/tags.png) | ![The generation settings read from an imported image](docs/images/import-settings.png) |

A tag's canonical name, aliases, post count, wiki and the tags it appears with; tag search from an English prefix (or a
Chinese word, with the optional dictionary). Tags you keep become materials with a cover image. PNG, JPEG and WebP
files come in with the generation settings they carry, and can be the source of an Img2Img, Inpaint or Post image.

### Also

- **Updates**: the app finds new releases and, when you choose **Update and restart**, checks the release's signature
  and replaces itself in place (see [Updates](#updates)).
- **Backups**: automatic backups and portable `.naisbackup` exports; your API token is never in an automatic backup.
- English and Chinese interface, dark theme.

Screenshots show synthetic sample images, made with a local stand-in for NovelAI.

## Get started

1. Get a NovelAI **Persistent API Token**: [Before you start](#before-you-start).
2. [Install](#install) the app and paste the token in its first-run guide.
3. Connect your agent: copy the MCP configuration from **Settings › MCP access**, or put `nai` on your `PATH`. Both are
   under [Connect an agent](#connect-an-agent).
4. Ask your agent to "list the NovelAI queue", or run `nai queue list`.

## Before you start

- A **NovelAI subscription** and a **Persistent API Token**. In the NovelAI web app: menu (three lines, top left) ›
  Account Settings › Get Persistent API Token › Overwrite, then copy the whole token (it starts with `pst-`; it is shown
  only once and replaces the old one). Paste it in the app's first-run guide or in Settings › Account & network and click
  **Verify & save**.
- An agent on the same computer: an MCP client (Claude Code, Cursor, Codex, Pi, …), or anything that can run a
  command, for `nai`.

## Install

Download the file for your system from the [latest release](https://github.com/lwyq1209/mcp-for-novelai/releases/latest):

| System | File |
| --- | --- |
| macOS, Apple silicon (M1 and later) | `MCP-for-NovelAI-<version>-mac-arm64.dmg` |
| macOS, Intel | `MCP-for-NovelAI-<version>-mac-x64.dmg` |
| Windows 10/11, x64 | `MCP-for-NovelAI-<version>-win-x64-setup.exe` |
| Linux, x64 | `MCP-for-NovelAI-<version>-linux-x64.tar.gz` |

Each release also has `SHA256SUMS.txt`, the SHA-256 checksum of every file: compare the line of your download with the
output of `shasum -a 256 <file>` (macOS), `sha256sum <file>` (Linux) or `Get-FileHash <file>` (Windows PowerShell).
`SHA256SUMS.txt.sig` is its signature, which the in-app update checks ([docs/updates.md](docs/updates.md#checking-a-release-yourself)
shows how to check it yourself). The source code of the bundled image libraries is there too (see
[Credits and license](#credits-and-license)).

**macOS** — not sure which Mac you have? Apple menu › **About This Mac**: "Chip: Apple M…" is Apple silicon,
"Processor: Intel…" is Intel. (The same app also comes as a `.zip`.) Open the disk image and drag the app to
**Applications**. The app is signed with the project's own (self-signed) certificate but not notarized by Apple, so macOS
refuses it the first time: open it once, then go
to **System Settings › Privacy & Security**, scroll to **Security** and click **Open Anyway** (offered for about an hour
after the attempt), and confirm with your password. Control-click › Open no longer skips this check on current macOS
(since macOS 15). Run the app from Applications: run from the disk image or a downloads folder, its path changes on
every launch and agent configurations break.

**Open Anyway** only covers starting the app with a double-click: an agent runs the MCP server inside the app
directly, and macOS still blocks that with "Apple could not verify …". Run this once in Terminal after installing
(and again after installing a new version):

```sh
xattr -dr com.apple.quarantine "/Applications/MCP for NovelAI.app"
```

It removes the quarantine mark macOS puts on downloaded files, which is the same as telling macOS that you trust this
app.

**Windows** — run the `setup` installer. The installer is not code-signed yet, so SmartScreen may show "Windows
protected your PC": click **More info**, then **Run anyway**.

**Linux** — extract the `.tar.gz` and put the extracted folder where it stays, under a name without the version (for
example `~/Applications/mcp-for-novelai`), then run `mcp-for-novelai` in it. Agent configurations point at that folder:
to update, replace its contents with the new version's, keeping the folder's name and place (or copy the configuration
again). If the app does not start and reports that the SUID sandbox helper is not configured correctly, see
[Troubleshooting](docs/troubleshooting.md#linux-the-app-does-not-start).

### Build from source

Needs [Node.js](https://nodejs.org/) 22.12 or later and Git. From a clone of this repository:

```sh
npm ci --prefix novelai
npm ci --prefix novelai/client
node novelai/client/node_modules/electron/install.js
node novelai/scripts/start-client.mjs
```

`start-client.mjs` builds the app and starts it (`--no-build` skips the build next time, `--data-dir <folder>` uses a
separate data folder; on Windows you can double-click `novelai\scripts\start-client.cmd`). See
[Building and development](docs/building.md).

## Connect an agent

> [!NOTE]
> **Agents generate with your NovelAI account.** When an agent calls `enqueue_recipes` (`nai enqueue`), the app sends
> those images to NovelAI with your token right away — there is no per-image confirmation, and images outside your
> subscription's free allowance spend Anlas. Each enqueue carries a `requestKey`, so a retried call never pays twice
> for the same intent. The queue page shows every batch, and you can pause or cancel any of them there; Settings ›
> Queue limits how many images one enqueue and the whole queue may hold.

### Over MCP

Open **Settings › MCP access** (or step 2 of the first-run guide), pick your agent and copy what it shows: the app fills
in its own executable, the bundled MCP server file and its data folder. The server runs with the app's own executable
as Node (`ELECTRON_RUN_AS_NODE=1`), so you do not need Node.js. Then ask your agent to "list the NovelAI queue".
On **macOS**, run the `xattr` command from [Install](#install) once first: without it macOS blocks the agent's MCP
server with "Apple could not verify …", even after **Open Anyway**.

**The agent opens the app itself.** When the app is not running, the first call that needs it makes the MCP server
start the app in the background, and the call goes on once the app is ready (at most about 30 seconds). The app does
not show its window or take the focus: on **macOS** only its Dock icon appears — click it to show the window; on
**Windows** it appears minimized in the taskbar — click its button; on **Linux** it runs in the background without a
taskbar entry — open the app again (for example from the application menu) to see its window. Only a call that
certainly reached no app does this; a call whose outcome may be unknown is never sent again. To turn it off,
add `NOVELAI_MCP_AUTOSTART=0` to the `env` of the agent's configuration: the agent then gets `unavailable` and asks you
to open the app (it still waits for an app that is already starting). A server you run from source with your own Node
never starts the app. On macOS the app starts through LaunchServices in the background; on Windows outside the agent's
process tree (WMI), so closing the agent's terminal does not close it; on Linux as a detached process.

![Settings › MCP access: recent connections, the command for the agent you pick, and the ten tools](docs/images/settings-mcp.png)

<details>
<summary><b>The configuration for each client</b> (Claude Code, Cursor, Codex, Pi, DeepSeek Harness, others)</summary>

The shapes below show what the page generates; `<app>`, `<server>` and `<data folder>` stand for the paths the page
fills in.

**Claude Code** — run once in a terminal (add `--scope user` to use it in every project):

```sh
claude mcp add novelai --env ELECTRON_RUN_AS_NODE=1 --env NOVELAI_DATA_DIR=<data folder> -- <app> <server>
```

**Cursor** — add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project). Cursor has no tool timeout setting; if it
reports a timeout on a large enqueue, check the queue page before letting the agent resend.

```json
{
  "mcpServers": {
    "novelai": {
      "type": "stdio",
      "command": "<app>",
      "args": ["<server>"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "NOVELAI_DATA_DIR": "<data folder>" }
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project):

```toml
[mcp_servers.novelai]
command = "<app>"
args = ["<server>"]
startup_timeout_sec = 30
tool_timeout_sec = 1560

[mcp_servers.novelai.env]
ELECTRON_RUN_AS_NODE = "1"
NOVELAI_DATA_DIR = "<data folder>"
```

**Pi** (built-in MCP, Pi 0.99 and later) — add to `~/.pi/agent/mcp.json` (or `.pi/mcp.json` in a project):

```json
{
  "mcpServers": {
    "novelai": {
      "command": "<app>",
      "args": ["<server>"],
      "env": { "ELECTRON_RUN_AS_NODE": "1", "NOVELAI_DATA_DIR": "<data folder>" },
      "timeout": 1560
    }
  }
}
```

**DeepSeek Harness** (dsh) — following its documentation (DSH MCP Integration and Configuration;
[`@deepseek-ai/dsh-mcp-client`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)):
add this row to `~/.dsh/cordis.patch.yml` (every profile; for one profile `~/.dsh/profiles/<profile>/cordis.patch.yml`
— not `cordis.yml`, which dsh rewrites empty on every start), then restart dsh. If the file already has an `- insert:`
list, add only the `novelai` row to it. `toolCallTimeoutMs` is set because dsh's default of 60 seconds is too short
for a large enqueue.

```yaml
- insert:
    - id: mcp-novelai
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: novelai
        transport: stdio
        command: "<app>"
        args: ["<server>"]
        env:
          ELECTRON_RUN_AS_NODE: "1"
          NOVELAI_DATA_DIR: "<data folder>"
        toolCallTimeoutMs: 1560000
```

**Other clients** configured with `mcpServers` (for example Claude Desktop's `claude_desktop_config.json`): merge the
same entry without `type` and `timeout`, and set the client's tool timeout to 26 minutes (1560 seconds) or more — a
large enqueue can take minutes.

If a file already has `mcpServers` (or other `[mcp_servers.…]` tables), add only the `novelai` entry. Settings › MCP
access › Advanced also shows how to run the server from a source checkout with your own Node, and where the agent's
inbox folders are.

</details>

### With the `nai` command line

`nai` ships inside the app; nothing else needs to be installed. Link its launcher into a folder on your `PATH`:

| System | Launcher | For example |
| --- | --- | --- |
| macOS | `MCP for NovelAI.app/Contents/Resources/bin/nai` | `ln -s "/Applications/MCP for NovelAI.app/Contents/Resources/bin/nai" ~/.local/bin/nai` |
| Linux | `<installation folder>/resources/bin/nai` | `ln -s <installation folder>/resources/bin/nai ~/.local/bin/nai` |
| Windows | `<installation folder>\resources\bin\nai.cmd` | add `<installation folder>\resources\bin` to `PATH` |

Check it with `nai --version` and `nai env`, which prints the data folder and the project root it uses. `nai --help`
lists the commands and `nai <command> --help` the options of each.

For the agent: `nai skill` prints the guide that matches the installed version, and
[`novelai/skills/novelai-cli`](novelai/skills/novelai-cli/SKILL.md) is a short skill for agents that support skill
folders — copy the folder into your agent's skills and it tells the agent when to use `nai`. Recipes stay in files the
agent edits, answers are JSON on stdout and images are written to files. On **macOS**, the `xattr` command from
[Install](#install) is needed for `nai` too. See [The `nai` command line](docs/cli.md).

## Data and privacy

| What | Where |
| --- | --- |
| Data folder (library, queue, settings, backups, logs) | macOS `~/Library/Application Support/mcp-for-novelai` · Windows `%APPDATA%\mcp-for-novelai` · Linux `$XDG_CONFIG_HOME/mcp-for-novelai` (default `~/.config/mcp-for-novelai`). The environment variable `NOVELAI_DATA_DIR` chooses another folder. |
| Generated images | `<Pictures>/MCP for NovelAI` by default (Settings › Storage & backup › Output folder); an agent's project saves into `<date>/<project>/` there. With `NOVELAI_DATA_DIR` set, `output/` in that folder. |
| Automatic backups | `backups/` in the data folder by default; every 24 hours, the last 7 kept, without images unless you include them, never with your API token (Settings › Storage & backup). |
| Recently deleted | Kept 30 days, then purged automatically. |
| Ended queue batches | Their records are cleaned after 30 days by default (Settings › Queue: 7, 30 or 90 days, or Forever); the images stay in the library. |

<details>
<summary><b>How the token is stored, and what the app connects to</b></summary>

- **Your API token** is encrypted with Electron's `safeStorage` before it is written to the settings file: the
  Keychain on macOS, DPAPI on Windows, the desktop's secret store (GNOME Keyring, KWallet) on Linux. When encryption
  is not available the app refuses to save it. On Linux without a secret store, Electron falls back to a built-in key
  that does not protect the token. Manual backup exports leave the token out unless you select API credentials and
  confirm.
- **The app connects to:**
  - NovelAI — `api.novelai.net` (token check, account and balance) and `image.novelai.net` (generation, upscale,
    Director and the other image requests). Your token is sent only to `*.novelai.net` addresses; others are refused
    unless you allow them under Custom API address in Settings › Account & network.
  - Danbooru — `danbooru.donmai.us` when you or an agent look up, search or save Danbooru tags (also the MCP server's
    `tag_details`), and `cdn.donmai.us` for a tag's sample images, only when you open them (or use one as a cover).
  - GitHub — `api.github.com` to check for a new release; with **Update and restart**, `github.com` and GitHub's
    download hosts (`release-assets.githubusercontent.com`, `objects.githubusercontent.com`) for that release's files
    (see [Updates](#updates)). **Download** opens the release page in your browser.
  - `raw.githubusercontent.com` only when you run the optional Chinese tag dictionary installer
    (`novelai/scripts/install-tag-dictionary.mjs`).
  - Your proxy, if you set one (Settings › Account & network › Proxy; it follows the system proxy by default).
- The MCP server talks to the app only on `127.0.0.1`, with a secret the app writes into its data folder. When the app
  is not running, the server may start it (see [Connect an agent](#connect-an-agent); `NOVELAI_MCP_AUTOSTART=0` turns
  that off).
- **No telemetry, analytics or crash reporting.** The app records which agent called which tool and when (never the
  arguments) on this computer only, to show it in Settings › MCP access and on the queue page.

</details>

## Updates

An installed app checks the [latest GitHub release](https://github.com/lwyq1209/mcp-for-novelai/releases/latest) a few
seconds after it starts and then every 6 hours, and shows a newer version in the top bar and in **Settings › About &
updates**. Turn the checks off there (**Check for updates automatically**); **Check for updates** works any time. A
build from source does not check on its own.

<details>
<summary><b>What Update and restart does, and where only Download is offered</b></summary>

- **Update and restart** downloads the new version, checks it against the release's signed checksum list
  (`SHA256SUMS.txt.sig`, Ed25519, with the key built into the app; on macOS also its code signature and certificate),
  replaces the installed app in the same place and opens it again. Nothing that fails a check is installed ("The update
  could not be verified"). The download shows its progress, can be cancelled and continues where it stopped. The app
  waits while the queue has batches generating or waiting (**Update after the queue**; pause them on the queue page to
  update now) and quits the normal way; in the few seconds it hands over to its update helper it starts no image, and a
  batch that arrives then calls the update off. Your library, queue, settings and images stay as they are, and agent
  configurations stay valid. On macOS and Linux, if the new version does not start, the old one is put back.
  **Windows has no rollback of its own**: it relies on the NSIS installer (which leaves the old version when it stops
  before replacing files; otherwise run the setup by hand), and the installer ends agents' running MCP servers: a call
  under way fails, and the agent must start the server again (many do so with their next call, some need it
  reconnected, for example `/mcp` in Claude Code). During the update MCP servers do not start the app (`unavailable`,
  `details.autostart: "updating"`; call again in a minute). The first start afterwards says **Updated to x.y.z**, with
  a link to what changed.
- **Download** opens the release page, as before. It is the only choice where the app cannot replace itself: macOS run
  from Downloads or the disk image, a folder you cannot write to, Windows installed for all users, a Linux folder whose
  `chrome-sandbox` root set up.
- **A version that has no Update and restart yet is updated by hand, once**: download the new version from the
  release page and install it. On macOS the Keychain then asks once more for the app's Safe Storage key: the app is
  now signed with a fixed certificate, so **Always Allow** stays valid across later updates.

</details>

How it works, how to verify a release yourself, App Management on macOS and the threat model:
[docs/updates.md](docs/updates.md).

## Documentation

- [MCP tools reference](docs/mcp-tools.md) — every tool, request keys, the queue, retention, projects
- [The `nai` command line](docs/cli.md) — the same tools from a terminal, recipe files, images as files
- [Updates](docs/updates.md) — the in-app update, verifying a release, the threat model
- [Troubleshooting](docs/troubleshooting.md) — error codes and what to do
- [Building and development](docs/building.md) — from source, tests, dev tools
- [Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Not affiliated with NovelAI

NovelAI is a trademark of Anlatan. This is an independent project; it is not affiliated with, endorsed by or supported
by Anlatan or NovelAI. You need your own NovelAI account.

## Credits and license

Based on **Langbai NovelAI Studio** 2.2.8 (MIT License) — <https://github.com/2786886095/novelai-image-desktop>,
Copyright (c) 2026 Langbai. Thanks to its author for releasing it under the MIT License.

MCP for NovelAI is released under the [MIT License](LICENSE) (Copyright (c) 2026 Langbai, Copyright (c) 2026 lwyq1209).
The app also contains third-party software under its own licenses, listed in
[THIRD_PARTY_NOTICES.md](novelai/client/THIRD_PARTY_NOTICES.md) and shown in Settings › About & updates. Some of the
image libraries inside it (libvips and others) are under the GNU LGPL: their source code is attached to every release as
`third-party-sources-<version>.tar.gz`. The source of Electron, which the app uses unmodified, is that of the Electron
version named in the notices.
