# The `nai` command line

`nai` runs the tools of the MCP server from a terminal. It is meant for coding agents that work in a shell (and for
people who like one): long prompts stay in files the agent edits, answers are one JSON document on stdout that `jq` can
read, and images are written to files instead of travelling as base64. It ships with the app; nothing else needs to be
installed.

- [Install](#install)
- [How it works](#how-it-works)
- [Folders](#folders)
- [Inbox files](#inbox-files)
- [Commands](#commands)
- [Recipes as files](#recipes-as-files)
- [Images](#images)
- [Output and exit codes](#output-and-exit-codes)
- [Environment variables](#environment-variables)
- [Agent skill](#agent-skill)

## Install

The launcher is in the app's resources folder. Link it into a folder on your `PATH`:

| System | Launcher | For example |
| --- | --- | --- |
| macOS | `MCP for NovelAI.app/Contents/Resources/bin/nai` | `ln -s "/Applications/MCP for NovelAI.app/Contents/Resources/bin/nai" ~/.local/bin/nai` |
| Linux | `<installation folder>/resources/bin/nai` | `ln -s <installation folder>/resources/bin/nai ~/.local/bin/nai` |
| Windows | `<installation folder>\resources\bin\nai.cmd` | add `<installation folder>\resources\bin` to `PATH` |

The launcher follows links to its own file, so a link keeps working after the app is updated in place. It runs the
command line (`resources/mcp/novelai-cli.mjs`, next to the MCP server) with the app's own executable as Node
(`ELECTRON_RUN_AS_NODE=1`, set for that one process only). On Windows, link or copy nothing: put the folder on `PATH`
(a copied `nai.cmd` cannot find the app).

From a source checkout, `npm --prefix novelai/client run build` builds `novelai/client/dist-mcp/novelai-cli.mjs`, and
`novelai/client/bin/nai` (`nai.cmd`) runs it with the checkout's development Electron; link it like the app's. `node
novelai/src/cli.mjs` runs the sources with your own Node, without a build; it never starts the app.

Check it with `nai --version` and `nai env`.

## How it works

Every command is an MCP client of the server itself: `nai` creates the same server as `novelai/src/mcp.mjs` in its own
process and calls it over an in-memory MCP connection. A call therefore goes through exactly what an agent's MCP call
goes through — the argument checks, each tool's fixed list of host methods, the compact answers, the project-relative
paths and the error envelope with paths and credentials scrubbed — and reaches the app over the same local bridge. What
`nai` adds lies around the answers: it reads and writes local JSON files, writes images to files, and `enqueue --wait`
follows the batch with `read_queue` after a successful enqueue.

The app records `nai-cli` (or the name in `NOVELAI_CLI_CLIENT`) as the caller, so its calls appear under Settings › MCP
access › recent connections and on the batches it queued. When the app is not running, `nai` started through the
launcher starts it in the background without taking the focus, exactly like the MCP server
([When the app is not running](mcp-tools.md#when-the-app-is-not-running)); `NOVELAI_MCP_AUTOSTART=0` turns that off.

`nai --help`, `nai <command> --help`, `nai skill` and `nai --version` load none of the tools: they read no data folder,
contact nothing and start nothing.

## Folders

`nai` decides both folders before it loads the tools, so every part of it uses the same ones:

- **Data folder**: `--data-dir <dir>`, else `NOVELAI_DATA_DIR`, else the app's own data folder (see the
  [README](../README.md#data-and-privacy)).
- **Project root** (the base of `novelai/library-inbox`, `novelai/study-inbox` and the two export folders, and of every
  path returned with `pathBase: "project-root"`): `--project <dir>`, else `NOVELAI_PROJECT_ROOT`, else the nearest
  folder at or above the working directory that either has a `.mcp.json` or `.pi/mcp.json` whose
  `mcpServers.novelai.env` sets `NOVELAI_PROJECT_ROOT` — then that value, the root the agent's MCP server there uses
  (`${VAR}` and `${VAR:-default}` expanded as Claude Code does; a relative value taken from that folder; a value that
  stays unresolved or empty is no marker) — or holds `novelai/library-inbox` or `novelai/study-inbox`; in one folder the
  configuration comes first. Else `<data folder>/workspace`. Of those configuration files only that one key is read
  (never a data folder).

`nai env` prints both, where each came from (`projectMarker`, `projectMarkerPath`), the four inbox and export folders,
the image folder and whether this `nai` can start the app. Commands whose tool reads a file by name from an inbox take
any local file and copy it in first (see [Inbox files](#inbox-files)).

## Inbox files

`material_library` and `material_studies` read their input files by name from the inboxes under the project root. `nai
study import <file>…`, `nai study import --manifest <file>`, `nai material import -f <file>`, `nai material save
--inbox <file>` and `nai material set-cover <entryId> <file>` take any local file, also a pipe (`<(…)`). A file that
exists where you name it — a bare name too, relative to the working directory — is the one meant: unless it is in the
inbox already, it is copied there (the inbox is made when missing) under its own name, or `<name>-<n>` when the inbox
holds another file of that name; nothing there is replaced, and a file there with the same bytes is used again; a
material JSON name is reduced to the letters the tool takes. Only a bare name that is no file in the working directory
names a file in the inbox. The answer lists the copies in `copied: [{from, to, reused?}]`. A manifest's own `files` are
names in the study inbox.

## Commands

| Command | Tool | What it does |
| --- | --- | --- |
| `nai skill` | — | The agent guide of this version (Markdown) |
| `nai env` | — | Data folder, project root, image folder, whether the app can be started |
| `nai tools [tool] [--names]` | — | The tools, or one tool's description and input schema |
| `nai call <tool> [json\|@file\|-]` | any | Any tool with its JSON arguments (inline, a file, or stdin) |
| `nai tags <name>… [--full]`, `nai tags --co <tag> [--rating] [--limit]` | `tag_details` | Danbooru facts, or co-occurring tags |
| `nai material list\|read\|search\|save\|archive\|export\|import\|cover\|set-cover` | `material_library` | Prompt materials, tag search, a tag's cover |
| `nai study import\|list\|read\|image\|original\|update` | `material_studies` | Imported images |
| `nai asset list\|read\|recipe\|image\|export\|censor\|collections` | `asset_library` | The library; `recipe` writes a history image's settings as a recipe file |
| `nai prepare -f <recipe.json>` or `--canvas <workspaceId> --expected-revision <n>` | `prepare_recipe` | Freeze a recipe from a file or the live canvas |
| `nai enqueue --key <key> -f <prepared.json>… [--wait done\|next]` | `enqueue_recipes` (+ `read_queue`) | **Generate** (paid), optionally waiting for the batch |
| `nai queue list\|read\|result` | `list_queue`, `read_queue`, `get_queue_result` | The queue, one batch (`--wait`), its images |
| `nai workspace read` (`nai ws`) | `read_workspace` | The live canvas |

JSON arguments (`nai call`, `--mask`, `--patch`) can be written inline, as `@file.json` or as `-` for stdin; prefer a file
when the shell's quoting gets in the way (Windows `cmd` in particular).

`nai <command> --help` lists the options of each. Global options, accepted anywhere: `--data-dir`, `--project`,
`--image-dir`, `--pretty`, `--help`, `--version`. Every action of every tool that has no command of its own (style
presets, collections, covers, deletes and restores …) is reached with `nai call`.

## Recipes as files

```sh
nai asset recipe <historyId> -o draft.json        # the image's settings as prepare_recipe arguments; prints a summary
# edit draft.json with any editor
nai prepare -f draft.json -o prepared.json        # freeze it; prepared.json holds {recipeId, recipeRevision, inputHash, mode}
nai enqueue -f prepared.json --key <requestKey> --count 2 --group <project> --wait done
nai queue result <batchId>                        # the batch's thumbnails as files
```

- `nai asset recipe` never prints the prompts. The model is written as `prepare_recipe` takes it: an image sent to the
  inpainting model names its base model, one made on V5 Full Medium names V5 Full with `effort: "medium"` (the values
  Medium fixes are left to it). `warnings` say what the record cannot give: the source of an i2i, enhance or inpaint
  image (`source_not_included`; an inpaint prompt often describes only the repainted area), a normalized model
  (`model_normalized`). How an image was made comes from its queue record or, for an image made with Generate in the
  app, from its `feature`. History records do not keep precise reference or vibe images, so no image's references can
  be written: the summary's `references` says so every time; add `references` to the file yourself when the original
  used them. An upscale or a Director result has no recipe of its own: it is refused with `recipe_not_reproducible`
  (exit 1) and nothing is written. `--mode i2i|enhance` writes the image as the recipe's `source` (add `strength`, or
  `magnitude` and `scale`, which the image cannot give; enhance runs on High, so no `effort`, and the values Medium fixed
  are replaced by the app's High defaults: steps 28, k_euler_ancestral, UC preset 2, no negative); `--random-seed` writes
  `seed: null` instead of the image's seed.
- `nai prepare` takes quick overrides without editing the file: `--seed <n|null>`, `--mode`, `--model`, `--width`,
  `--height`, `--steps`, `--set <key>=<json>` and `--unset <key>`; `--preview` checks without saving (an inpaint
  preview's mask picture is saved as an image); `--revise <recipeId> --expected-revision <n>` saves a new revision.
  `-o` may not name the `-f` file (also not through a link): that would lose the recipe; this is checked before
  anything is sent.
- `nai enqueue` takes several `-f` files (each a receipt, an array of receipts or `{items: […]}`) and
  `--recipe <id>:<revision>:<inputHash>`, with `--count`, `--seeds`, `--group`, `--prefix` and `--interval` (a count or
  seeds given both in a file and on the command line must agree, else exit 2). `--wait-seconds` (1–1200) is checked
  before the enqueue is sent; values the tool itself refuses (`--count 0`, `--count 201` …) answer
  `invalid_arguments` (exit 1) and nothing is queued. The rules of
  [Request keys and paid requests](mcp-tools.md#request-keys-and-paid-requests) apply unchanged: run an uncertain or
  interrupted enqueue again with the identical command and the same `--key`. With `--wait done|next` (and
  `--wait-seconds`, 1–1200) the answer is `{enqueue, batch}`. If the wait fails after the enqueue succeeded, the error
  is `wait_failed` (the wait's own error in `waitError`) and says that the batch is queued and to follow it with `nai
  queue read <batchId> --wait done`, with `enqueue` beside it; an interruption while waiting says the same, one during
  the enqueue itself says to repeat the command with the same key.

## Images

Tools that return images — `queue result`, `asset image`, `asset censor --preview`, `prepare --preview` (inpaint),
`study image`, `material cover`, `workspace read`, and `nai call` of those tools — never print them. Each image is
written to a new file named after the command and the time, with the extension of its type, in
`<project root>/.tmp/nai-cli/` (`--image-dir <dir>` for another folder), and the answer lists them in `savedImages`
(`[{file, mimeType, bytes}]`; queue thumbnails also name their file per result as `image`). `--out <file>` names the
file of a one-image command; `--out <folder>` (an existing folder, or any path ending in `/`) puts the images into that
folder under the usual names. An empty `--out`, `-o` or `-f` is a usage error.

**Writing files**: `nai` writes like any command-line tool — missing folders are created (the project root too), an
existing file is replaced, symbolic links are followed. Each file is written beside its target and renamed over it, so
it is never left half written. The one write `nai` refuses is `prepare -o` naming the `-f` recipe. `--force` is
accepted and changes nothing.

**Paths**: every file `nai` writes itself (`savedImages[].file`, `image`, `receiptFile`, the `file` of `asset recipe`)
is reported as an absolute path. Paths inside tool answers keep the server's convention: with `pathBase:
"project-root"` they are relative to the project root (`nai env` prints it). `nai`'s own error messages name files as
you gave them.

## Output and exit codes

| Exit | Meaning | stdout |
| --- | --- | --- |
| 0 | Success | The tool's answer (plus `savedImages`, `file` or `receiptFile`) |
| 1 | The tool answered an error — also its own argument checks (`invalid_arguments`: nothing was sent or queued) — or `asset recipe` found no recipe to write (`recipe_not_reproducible`), or the wait after a successful enqueue failed (`wait_failed`) | `{"ok":false,"error":{"code","message","details"?}}`, the server's own envelope ([Errors](mcp-tools.md#errors)) |
| 2 | `nai`'s own usage or local input error (unknown option, malformed number, `--wait-seconds` outside 1–1200, unreadable or invalid JSON — the error names the line and column, never the content —, over 16 MiB, `prepare -o` naming the `-f` file); nothing was sent | `{"ok":false,"error":{"code","message"}}` |
| 3 | The call succeeded but an output file could not be written | `{"ok":false,"error":{…,"stage":"output"},"result":…}` |
| 4 | Internal error of `nai`, a working directory that is gone (`cwd_unavailable`), or the launcher found no app or build | `{"ok":false,"error":{…}}` |
| 130, 143 | Interrupted (SIGINT, SIGTERM); a write may or may not have happened | `{"ok":false,"error":{"code":"interrupted",…}}` |

A standalone `--help` or `-h` anywhere before `--` prints the help of the command it follows (exit 0), whatever else
the line holds; `--help`, `--version` and `skill` work even where the working directory is gone. `-f` and `@file` take
pipes and process substitutions (`nai prepare -f <(…)`) as well as files, up to 16 MiB. `--pretty` indents the JSON.

## Environment variables

| Variable | Effect |
| --- | --- |
| `NOVELAI_DATA_DIR` | The data folder (`--data-dir` wins) |
| `NOVELAI_PROJECT_ROOT` | The project root (`--project` wins) |
| `NOVELAI_MCP_AUTOSTART=0` | Never start the app (otherwise `nai` starts it exactly as the MCP server does) |
| `NOVELAI_CLI_CLIENT` | The caller name the app shows (default `nai-cli`) |

## Agent skill

[`novelai/skills/novelai-cli/SKILL.md`](../novelai/skills/novelai-cli/SKILL.md) is a short skill for agents that
support skill folders: copy the `novelai-cli` folder into your agent's skills. It tells the agent when to use `nai`
and to read `nai skill` once per session, so the detailed guide always matches the installed version.
