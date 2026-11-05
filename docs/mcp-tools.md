# MCP tools reference

MCP for NovelAI ships one MCP server, named `novelai`, with 18 tools. This page describes what each tool does, how
generation, request keys and the shared queue work, and what the server returns when something goes wrong. The tool
definitions an agent receives (`tools/list`) and the instructions the server sends when an agent connects are the
authoritative text; this page explains them for people.

- [How the server runs](#how-the-server-runs)
- [When the app is not running](#when-the-app-is-not-running)
- [Tools at a glance](#tools-at-a-glance)
- [Library tools](#library-tools)
- [Recipes and the queue](#recipes-and-the-queue)
- [Canvas tools](#canvas-tools)
- [Request keys and paid requests](#request-keys-and-paid-requests)
- [Queue limits and stop protection](#queue-limits-and-stop-protection)
- [Queue retention and cleaned batches](#queue-retention-and-cleaned-batches)
- [When a recipe is gone: `recipe_not_found`](#when-a-recipe-is-gone-recipe_not_found)
- [Several projects on one queue](#several-projects-on-one-queue)
- [Files, inboxes and exports](#files-inboxes-and-exports)
- [Timeouts](#timeouts)
- [Errors](#errors)

## How the server runs

- The server is a single file, `resources/mcp/novelai-mcp.mjs` inside the installed app (`dist-mcp/novelai-mcp.mjs`
  in a build from source). The agent starts it over stdio with the app's own executable as Node:
  `ELECTRON_RUN_AS_NODE=1 <app executable> <path to novelai-mcp.mjs>`. No separate Node.js install is needed.
  From a source checkout you can also run `node novelai/src/mcp.mjs` with your own Node.
- Every configuration that **Settings › MCP access** shows passes the app's data folder as `NOVELAI_DATA_DIR`, so
  the server finds the running app even when the agent starts it with a different environment.
- The server talks to the app over a local connection: the app writes `runtime/bridge.json` in its data
  folder (a `127.0.0.1` address and a per-run secret) and the server reads it on every call. Every tool but
  `tag_details` (which asks Danbooru directly) works through the app; when it is not running, the server starts it
  (see [When the app is not running](#when-the-app-is-not-running)).
- The app records which agent called (the MCP client's own name and version from `initialize`), the tool and the
  time, never the arguments. Settings › MCP access shows the recent connections; the queue shows which agent put
  each batch in.

## When the app is not running

The server starts the app itself, so an agent never has to ask the user to open it:

1. A call fails before it reached any app: there is no `bridge.json`, or the address it names refuses the connection
   (the app that wrote it is gone). These are the only two failures that start anything. A call that may have
   reached the app — the connection dropped after the request was sent, the reply was garbled, the call timed out —
   is reported as it is and **never sent again**; the rules of [Request keys and paid
   requests](#request-keys-and-paid-requests) stay exactly as they are.
2. If the app is already starting for this data folder (its single-instance lock names a live process, or another
   server started it less than a minute ago), the server only waits for it. Otherwise it starts the app it belongs
   to: the installed app whose executable runs the server, or — from source — the built client whose
   `dist-mcp/novelai-mcp.mjs` it is, with that client's development Electron. It starts it at most once a minute,
   and when several agents call at once only one server starts it (a claim file, `runtime/mcp-autostart.json`, with
   the app's own single-instance lock behind it).
3. It waits up to 30 seconds for the app's `bridge.json`, then sends the call once more. If the call was a canvas
   tool and the app's window is still loading (`workspace_not_ready`, which the app answers before it runs
   anything), it sends it again every half second within the same 30 seconds.

The app starts in the background and never takes the focus: its first window is shown without activating it
(`showInactive`), and a second start by an agent never brings the running window forward; its Dock or taskbar icon
shows as usual. macOS: LaunchServices (`open -n -g -a <app> --env NOVELAI_DATA_DIR=…`); Windows: `Win32_Process.Create`
(WMI), outside the agent's process tree and job, so closing the agent's terminal does not close the app (if WMI fails,
a detached process, and the server logs that); Linux: a detached process. The app gets the server's
`NOVELAI_DATA_DIR` (or none, for the default data folder) and records in Settings › MCP access which agent started it.
Starting the app never generates anything: batches it recovers from its last run wait paused for an explicit resume.

When the server does not start the app, `unavailable` says why in its message and in `details.autostart`:

| `details.autostart` | Meaning |
| --- | --- |
| `off` | `NOVELAI_MCP_AUTOSTART=0` (also `false`, `off`, `no`) in the server's environment: ask the user to open the app |
| `off_in_tests` | A test process (`node --test`, Vitest, `npm test`); tests never start the app |
| `unsupported` | The server does not run with an app's own executable (for example system Node running `novelai/src/mcp.mjs`) |
| `recently_started` | This server started the app less than a minute ago and it is not running |
| `start_failed` | Starting it failed (the message names the reason) |
| `started_not_ready`, `started_exited` | It was started but was not ready within 30 seconds, or closed again |
| `starting_not_ready` | It was already starting and was not ready within 30 seconds |
| `lost` | It became ready, but its connection was gone again before the call reached it |

In every one of these cases nothing was sent. `NOVELAI_MCP_AUTOSTART=0` turns off only the start: a server still
waits for an app that is already starting.

## Tools at a glance

The groups are the ones Settings › MCP access shows.

| Group | Tool | What it does |
| --- | --- | --- |
| Library | `asset_library` | Search, read, view, organise, delete and restore everything in the library (history images, imported images, tags, presets, notes) |
| Library | `material_library` | Prompt materials: tags, combos and notes; tag search; tag covers |
| Library | `material_studies` | Import images (with their generation metadata) from the study inbox and read them |
| Library | `tag_details` | Danbooru facts about tags: canonical name, aliases, post count, wiki, co-occurring tags |
| Recipes & queue | `prepare_recipe` | Freeze one generation recipe (six modes) and read back the exact effective input |
| Recipes & queue | `enqueue_recipes` | **Generate:** put frozen recipes into the queue (paid, no further confirmation) |
| Recipes & queue | `lookup_enqueue` | Look up what happened to an enqueue by its request key |
| Recipes & queue | `list_queue` | The queue: counts and the first 8 batches, agent and manual ones |
| Recipes & queue | `read_queue` | One batch: status, per-image progress, saved images with their file names |
| Recipes & queue | `get_queue_result` | View one saved image of a batch |
| Recipes & queue | `control_queue` | Pause, resume or cancel one batch the user names |
| Canvas | `list_workspaces` | The app's canvas workspace and its ID |
| Canvas | `read_workspace` | The canvas's complete state and its images |
| Canvas | `read_prompt_review` | The effective request the canvas (or a draft) would send, built by the real request builder |
| Canvas | `get_asset` | View one image of the canvas |
| Canvas | `draft_edit` | Stage a visible edit proposal on the canvas |
| Canvas | `apply_edit` | Apply a staged draft |
| Canvas | `undo_edit` | Undo the last edit made through MCP |

Only `enqueue_recipes` generates images, and only when an agent calls it. Browsing, editing, drafting and saving never
generate anything. `control_queue` can resume a paused batch, which continues generating with the batch's original
recipes.

## Library tools

### `asset_library`

The library as the app shows it, without the canvas. Items are identified by `kind` + `id` and an exact `revision`
(`expectedRevision` for changes); categories are `history`, `imports`, `tags`, `presets` and `notes`.

- `list` returns summaries (default 10, at most 20 per page) with filters: text query, category or kinds, collection,
  history tags, archived items, sorting. `queueRequestKey` (an `enqueue_recipes` key) or `queueBatchId` lists the images
  that batch saved. A project is the collection `history:<historyGroupId>`.
- `read` loads one item (`detail: summary|full`); `image` returns one history image (a thumbnail of at most 384 px
  unless `variant: "original"` is asked for). The image's `assetId` is what `prepare_recipe` and covers use.
- `collections`, `create-collection`, and `mutate` with `archive`, `update` (only the fields each kind allows),
  `add-to-collection` and `remove-from-collection`.
- `mutate` `delete` moves items to **Recently deleted**; `delete-archived` deletes archived items (500 per call).
  `preview: true` lists the effects without changing anything: tag covers made from a deleted image are cleared,
  collection memberships are removed, recipes that use a deleted image as their source fail at enqueue until it is
  restored (batches already queued keep their own copy).
- `recently-deleted` lists deleted entries with their `trashId`; `restore` brings them back with their versions, files
  and collections; `purge` deletes them for good (it cannot be undone). Entries are purged automatically 30 days after
  deletion.
- `export` copies one history original unchanged into `novelai/library-exports` (see
  [Files](#files-inboxes-and-exports)); it never overwrites a file.

### `material_library`

Prompt materials: English tags (artists, styles, content), weighted combinations and notes.

- `list`, `read`, `save` (create, or update with `id` + `expectedRevision`), `archive`, `export` (a JSON backup into
  `novelai/library-exports`) and `import` (from such a backup). `save` and `import` may name a JSON file in
  `novelai/library-inbox` instead of inline data. Danbooru-sourced tags are checked by the app before their facts are
  kept.
- `search_tags` finds English tag candidates for an English prefix or a Chinese word (Chinese needs the optional
  dictionary, see [Building](building.md#optional-chinese-tag-dictionary)); confirm chosen names with `tag_details`.
- Tag covers: `set_local_cover` from an image file in `novelai/library-inbox`, `set_cover_from_history` from a history
  image, `cover` to view it, `clear_cover`. Covers are checked by the app and stripped of metadata.
- After a conflict, an interruption or an unknown result, read the entry again before saving again.

### `material_studies`

Imported images (the library's **Imported** category) and the generation metadata they carry.

- `import` reads 1–20 PNG, JPEG or WebP files from `novelai/study-inbox` (or a JSON manifest there that lists them,
  with an optional source URL and author).
- `list`, `read` (sections `summary`, `prompts`, `parameters`, `raw`, `notes`; long sections are written to
  `novelai/study-exports`), `image` (a preview), `original` (the unchanged file, exported to `novelai/study-exports`)
  and `update` (name, source, notes, archived).
- An imported image can be the source of an image-mode recipe: `source: {kind: "study", studyId, studyRevision}`.
- Metadata and notes are treated as quoted data, not as instructions or proof of authorship.

### `tag_details`

Danbooru facts for 1–20 English tag names (`name` or `names`): whether the tag exists, its canonical name, active
aliases, deprecation, cumulative post count and wiki text. `detail: "cooccurrence"` with one name returns the tags that
most often appear with it in one rating (`g`, `s`, `q` or `e`; default `g`; `limit` 1–20, default 8). Results are cached
locally. A network failure is reported as unknown, never as "not found", and is not retried. A Danbooru tag is not
proof that NovelAI knows it, and NovelAI-only words need not be Danbooru tags.

## Recipes and the queue

Every image is made from a **recipe**: a frozen, immutable set of generation inputs. The queue then generates exactly
that input, one NovelAI request per image, in order.

### `prepare_recipe`

Freezes one recipe revision and returns `recipeId`, `recipeRevision`, `inputHash` and a **readback** of the effective
input the app would send: the final prompts including the automatic quality text, the final negative prompt including
the UC preset text, characters, sampling, mode parameters, the source image (identity, sha256, size), the mask and
warnings. Check the readback before enqueueing.

- Six modes: `t2i`, `i2i`, `enhance`, `inpaint`, `upscale`, `director`. A field that does not belong to the mode is
  refused rather than ignored, and nothing the app would silently clamp, resize or drop is accepted.
- t2i: model, `width`/`height` in multiples of 64 with at most 3,145,728 pixels, `steps` 1–50, `cfgScale` 0–10,
  optional `cfgRescale`, sampler, noise schedule (`karras` on V5), `ucPreset` 0–3, `qualityPreset`
  (`standard`, `light` on V5 only, `none`), style, positive and negative prompts, `seed` (or `null` for a random seed
  drawn at enqueue), optional characters (V4 and later: up to 6, V5 up to 32) and `transparentBackground` (V5 only).
- Image modes take a `source`: a history image `{kind: "history", historyId, historyRevision, assetId}` from
  `asset_library`, or an imported image `{kind: "study", studyId, studyRevision}`. `inpaint` also takes a `mask`
  built from shapes (rectangles, ellipses, polygons, strokes) and alpha layers; `preview: true` returns the source
  with the selected cells tinted red so the mask can be checked before saving.
- `preview: true` runs every check and the real request builder without saving anything.
- `canvas: {workspaceId, expectedRevision, draftId?}` freezes the live canvas (or a staged draft) at exactly that
  revision instead of inline fields.
- To revise, pass `recipeId` with its current `expectedRevision` and every field again; a new revision is saved.

### `enqueue_recipes`

Puts frozen recipes into the shared queue. **The app then generates these images with your NovelAI account, which can
spend Anlas, with no further confirmation.**

- `requestKey` (required) identifies this intent; see [Request keys](#request-keys-and-paid-requests).
- `items`: `[{recipeId, recipeRevision, inputHash, count?, seeds?}]`. One mode per enqueue. A fixed-seed recipe used
  for more than one image needs explicit `seeds` (one per image). `upscale` and `director` recipes take no seed and
  are listed once each.
- Optional `intervalSeconds` (0–60) between images, and `historyGroup` / `fileNamePrefix` for your project (see
  [Several projects](#several-projects-on-one-queue)).
- A wrong revision or `inputHash`, mixed modes, a blocked recipe or a source that is gone are refused before anything is
  sent; the key stays unused.
- The receipt lists warnings, for example characters that a model does not take or a preset that adds no text.

### `lookup_enqueue`

Looks up the receipt of one of your request keys: `enqueued` (with the batch), `rejected`, `unknown` or `not_found`,
plus a **settlement** that says what you may do next. It never enqueues or resends anything. See
[Request keys](#request-keys-and-paid-requests).

### `list_queue`, `read_queue`, `get_queue_result`

- `list_queue`: the total, counts by status, the first 8 batches (`batchId`, `source`, `status`, `stopReason`, `count`,
  `activeJobId`, failed and unknown item counts) and, when the app reports it, storage use of the frozen queue and the
  recipe store against their limits. Batches started with **Generate** in the app are listed too, with
  `source: {kind: "manual", persistent: false}` (they are kept only while the app runs); agent batches have
  `source: {kind: "agent", client}`.
- `read_queue {batchId}`: status, request key, plan hash, interval, output (project and prefix), per-item status,
  job ID, result count and error code, and `results` — one entry per saved image with `itemIndex`, `index`,
  `historyId`, `actualSeed` (the seed it was generated with; `null` for upscale and director), `fileName` and `file`
  (the path relative to the project root, or `null` outside it).
- `get_queue_result {batchId, itemIndex, index?}`: one saved image, with the same identity fields.

Copy files only by the `fileName` / `file` these return, never by guessing numbers. A `historyId` from here can be the
source of a new image-mode recipe (through `asset_library`).

### `control_queue`

`{batchId, action: "pause" | "resume" | "cancel"}`, only for the batch the user names and only when the user asks.

- `pause` stops the batch before its next image; an image already running may still finish and be saved (and
  charged).
- `resume` continues a paused batch with its **original** frozen recipes. It does not pick up later edits, re-enqueue
  anything or retry failed or unknown images.
- `cancel` skips the images that have not started. It does not guarantee that a running image was stopped upstream
  or not charged; read the batch until its outcome is known.

The queue page in the app offers the same pause, resume and cancel for every batch, agent and manual.

## Canvas tools

The canvas is the app's manual workbench. The canvas tools read it and stage visible edits; **they never generate.**

- `list_workspaces` gives the `workspaceId`; `read_workspace` returns the complete creative state with its revision
  and an asset manifest (images are attached natively, at most five per call; `get_asset` views one more).
- `read_prompt_review {workspaceId, expectedRevision, mode, draftId?}` returns the full effective request built by the
  same code that sends it — prompts with the automatic quality and UC text, characters and positions, sampling,
  readiness and inputs the mode does not use. A detached t2i `patch` can be previewed without staging it.
- `draft_edit` stages a visible proposal at the exact current revision (the user sees it on the canvas);
  `apply_edit` applies it only if nothing changed in between; `undo_edit` undoes the last MCP edit only while its
  result is still unchanged. A newer revision is a conflict: read the workspace again.
- To generate what the canvas holds: read it, stage a draft if it needs changes, freeze it with
  `prepare_recipe {canvas: {workspaceId, expectedRevision, draftId?}}`, check the readback, then `enqueue_recipes`.
  `apply_edit` is only needed to show the draft on the canvas. Results of an agent enqueue go to the library and the
  queue, not back onto the canvas.

## Request keys and paid requests

`enqueue_recipes` spends your NovelAI balance. The request key is what keeps a retry from paying twice.

- Choose one `requestKey` per intent (1–120 printable characters) and reuse the **same** key for the same intent,
  also after a restart. The server namespaces it (`mcp-…`) and looks it up before sending, so a key that already has a
  receipt is never queued again: a repeated call answers `already_enqueued` with the existing batch. A new key is a
  new paid request.
- If the same key is used with a different plan, the call is refused with `request_conflict` and nothing is sent.
- **When an outcome is unknown** (a timeout, a dropped connection, `unknown`): do not resend and do not switch keys.
  Call `lookup_enqueue` with the same key and follow its settlement:
  - `settling` — look up the same key again after `retryAfterSeconds`;
  - `stale` with `newKeyAdvised: true` — only after two unknown lookups at least the settle window (about 130 s)
    apart with no batch in the queue: the same plan may be enqueued under a new key (a late acceptance of the old key
    could still duplicate it);
  - `not_found` — no receipt yet; resending the same plan with the same key is safe. For a key this server process
    never sent (after a restart, or sent by another process) the first `not_found` is also `settling`; once the
    window has passed it is `clear`.
- An image with an unknown outcome may have been generated and charged. It is never resent automatically;
  `read_queue` tells you to check the library (`asset_library` with `queueBatchId`) before making it again under a
  new key.

## Queue limits and stop protection

Settings › Queue in the app holds the limits; they are this app's safety stops, not NovelAI limits.

| Limit | Default | Range | Refusal |
| --- | --- | --- | --- |
| Images per enqueue | 20 | 1–200 | `enqueue_limit_exceeded`, naming the current limit |
| Queued images in total (all unfinished images) | 200 | 1–100,000 or no limit | `queue_full` |
| Frozen queue on disk | 64 MiB per batch, 512 MiB in total | fixed | `queue_input_too_large` / `queue_full` |

The images' frozen sources and masks may take about 32 MiB per enqueue. These limits apply to agent enqueues, not to
generating on the canvas.

Stop protection: when an image fails or its outcome is unknown, later agent batches are paused before they send
anything (`stopReason.code: "queue_halted"`) until someone checks and resumes them; failed or unknown images are never
resent. `read_queue`, `list_queue` and `control_queue` report `stopReason` as `{code, message}`; the codes the queue
sets are `queue_halted`, `child_stopped`, `child_rejected`, `submission_unconfirmed`, `restart_unconfirmed`,
`restart_blocked`, `recovered_paused`, `child_lookup_failed`, `child_status_unavailable`, `cancel_unconfirmed`,
`queue_storage_error`, `scheduler_stopped` and `scheduler_closed`. Resuming a batch the queue paused itself asks for
confirmation in the app, because it lifts the protection.

## Queue retention and cleaned batches

Ended agent batches (succeeded, cancelled or blocked) are cleaned once they ended more than the retention period ago:
**30 days by default**; Settings › Queue › Ended batches offers 7, 30 or 90 days, or Forever. Cleaning removes the
batch's frozen inputs, its receipt and the recipes only it used. **The images stay in the library.** Queued, running
and paused batches are never cleaned, and manual batches are not stored at all.

A small record of every cleaned batch stays, so an old request key keeps answering "accepted, ended, cleaned" and is
never treated as unused:

- `lookup_enqueue` answers `enqueued` with the cleaned batch; a repeated `enqueue_recipes` with the same key and plan
  answers `already_enqueued` and sends nothing; a different plan under that key is `request_conflict`.
- `read_queue` returns the cleaned batch with `results: []`; `control_queue` changes nothing.
- A cleaned batch carries `cleaned: true`, `cleanedAt`, `finishedAt`, its final `status`, `stopReason`, `count`,
  `output` and `itemCounts` (`succeeded`, `failed`, `unknown`, `cancelled`, `skipped`); its per-image details are
  gone. A batch rebuilt from the library after its record was lost (see
  [Troubleshooting](troubleshooting.md#cleaned-batch-records-damaged-or-missing)) carries `recovered: true` and
  `savedImages` instead, and how it ended is unknown.
- To find its images: `asset_library {action: "list", category: "history", queueRequestKey}` (or `queueBatchId`).

If the cleaned records are damaged or missing, the app fails closed: see
[Troubleshooting](troubleshooting.md#cleaned-batch-records-damaged-or-missing).

## When a recipe is gone: `recipe_not_found`

Recipes are reclaimed under two rules, so an old `recipeId` can stop working:

- a canvas capture (`prepare_recipe {canvas}`) is removed 7 days after every batch that used it ended (or after its
  enqueue was refused); one that was never enqueued is removed 7 days after it was captured;
- a recipe prepared from inline fields is removed with the last batch that used it, when queue retention cleans that
  batch. A recipe that was never enqueued stays.

A batch that is queued or running never needs its recipe (it runs from its own frozen copy). `enqueue_recipes` or
`prepare_recipe` naming a removed recipe answers `recipe_not_found`; nothing is saved or queued and no request key is
used. Prepare it again with the same fields — the new recipe gets a new `recipeId` and the same `inputHash` — or
capture the canvas again.

## Several projects on one queue

All agents and projects share one queue and one output folder. Give every enqueue your project's name:

- `historyGroup` (1–80 characters): images are saved under `<output folder>/<date>/<historyGroup>/` and join that
  history group, which the app shows as a **project** in the library. It is created on first use and reused by
  case-insensitive name.
- `fileNamePrefix` (1–40 characters, no path characters): every file name starts with it, for example
  `proj_<date>_01_<model>.png`.

Both are part of the plan (the same key with another group is a different plan). Take your files only by the
`fileName` / `file` that `read_queue` or `get_queue_result` give per `historyId`, never by number ranges, because other
projects save into the same folders. A canvas capture does not take over the canvas's project; pass `historyGroup`
yourself.

## Files, inboxes and exports

File inputs are plain file names (no paths, URLs or symbolic links) in four folders under the **project root**:

| Folder | Used by |
| --- | --- |
| `novelai/library-inbox` | `material_library` save/import from a file, local tag covers |
| `novelai/library-exports` | `material_library` export, `asset_library` export |
| `novelai/study-inbox` | `material_studies` import |
| `novelai/study-exports` | `material_studies` read (long sections), original, import reports |

The project root is `NOVELAI_PROJECT_ROOT` when the server is started with it, otherwise `<data folder>/workspace`
(the app creates its two inbox folders there). Inbox files must be ordinary files with a single link. Paths in results
are relative to the project root (`pathBase: "project-root"`, with the root named in `projectRoot`).

## Timeouts

One tool call can take long: `enqueue_recipes` makes up to 23 calls to the app in a row, each bounded at 65 seconds.
Allow about **26 minutes (1560 seconds)** per tool call. The configurations in Settings › MCP access already set this
for Codex (`tool_timeout_sec`, plus `startup_timeout_sec = 30`), Pi (`timeout`) and DeepSeek Harness
(`toolCallTimeoutMs: 1560000`; its default is 60 seconds). Claude Code's defaults are long enough. A call that starts
the app takes up to 30 seconds longer. Cursor has no setting for it: if Cursor reports a timeout, check the queue page before letting the agent
resend. For other clients, set the tool timeout yourself.

## Errors

A failed call returns `isError: true` with `{error: {code, message, details?}}`. Messages are written for the agent and
say what to do next. Common codes are explained in [Troubleshooting](troubleshooting.md).
