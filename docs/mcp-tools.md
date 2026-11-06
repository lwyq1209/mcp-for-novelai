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
2. If the app is already starting for this data folder (its single-instance lock names the live process that made
   it, or another live server is starting it right now), the server only waits for it. Otherwise it starts the app it
   belongs to: the installed app whose executable runs the server, or — from source — the built client whose
   `dist-mcp/novelai-mcp.mjs` it is, with exactly that client's own development Electron
   (`node_modules/electron/dist`). It starts it at most once a minute, and when several agents call at once only one
   server starts it: they compete for a claim file, `runtime/mcp-autostart.json`, that only one can hold (taken over
   only when its server is gone, or the claim is more than a minute old or in the future), and the app's own
   single-instance lock keeps it to one app in any case.
3. It waits up to 30 seconds for the app's `bridge.json`, then sends the call once more. If the call was a canvas
   tool or `prepare_recipe {canvas}` and the app's window is still loading (`workspace_not_ready`, which the app
   answers before it runs anything), it sends it again every half second within the same 30 seconds.

The app starts in the background, never takes the focus and keeps its window out of the way until the user opens it:
on macOS the window is not shown — only the Dock icon appears, and clicking it shows the window; on Windows the window
appears minimized in the taskbar without being activated, and its button restores it; on Linux the window is not shown
and the app has no taskbar entry until the user opens the app again. Opening the app again shows the window on every
platform; a second start by an agent never brings it forward. The window still loads, so the canvas tools work while
it waits (its page is not throttled in the background meanwhile). macOS: LaunchServices (`open -n -g -a <app> --env NOVELAI_DATA_DIR=…`); Windows: `Win32_Process.Create`
(WMI), outside the agent's process tree and job, so closing the agent's terminal does not close the app (if WMI fails,
a detached process, and the server logs that); Linux: a detached process. The app gets `NOVELAI_DATA_DIR` only when
the server's data folder is not the app's default one (every configuration of Settings › MCP access names the data
folder, the default one included; for the default folder the variable is left out, so the app starts as from its icon
and keeps `<Pictures>/MCP for NovelAI` as its default output folder; the app also treats `NOVELAI_DATA_DIR` set to its
default folder as an ordinary start). It gets none of the agent's environment: on Windows and Linux only the variables
the system needs to run it (system folders, user profile, locale, display, session bus, input methods), never
`ELECTRON_*`, proxy, key, token, secret or password variables. The app has its own proxy setting (Settings › Account &
network, the system proxy by default), so an agent's proxy variables are not needed. The app records in Settings › MCP
access which agent started it.
Starting the app never generates anything: batches it recovers from its last run wait paused for an explicit resume.

When the server does not start the app, `unavailable` says why in its message and in `details.autostart`:

| `details.autostart` | Meaning |
| --- | --- |
| `off` | `NOVELAI_MCP_AUTOSTART=0` (also `false`, `off`, `no`) in the server's environment: ask the user to open the app |
| `off_in_tests` | A test process (`node --test`, Vitest, `npm test`); tests never start the app |
| `unsupported` | The server does not run with an app's own executable (for example system Node running `novelai/src/mcp.mjs`) |
| `recently_started` | This server tried to start the app less than a minute ago (whether that start worked or not) and it is not running |
| `start_failed` | Starting it failed (the message names the reason) |
| `started_not_ready`, `started_exited` | It was started but was not ready within 30 seconds, or closed again |
| `starting_not_ready` | It was already starting and was not ready within 30 seconds |
| `lost` | It became ready, but its connection was gone again before the call reached it |
| `updating` | The app is installing an update (it hands over to its update helper, quits, and the new version opens by itself): the server does not start the old version meanwhile. Call again in a minute |

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
- `effort` (t2i, i2i, inpaint; optional, default `high`): V5 Full's Effort toggle. `medium` runs NovelAI's distilled
  Medium model and exists only for `nai-diffusion-5-full` (see [V5 Full Effort](#v5-full-effort-medium)).
- enhance: `scale` 1, 2 or `"max"` (Max✨, V5 models only; see [Enhance Max✨](#enhance-max)).
- Image modes take a `source`: a history image `{kind: "history", historyId, historyRevision, assetId}` from
  `asset_library`, or an imported image `{kind: "study", studyId, studyRevision}`. `inpaint` also takes a `mask`
  built from shapes (rectangles, ellipses, polygons, strokes) and alpha layers; `preview: true` returns the source
  with the selected cells tinted red so the mask can be checked before saving.
- `preview: true` runs every check and the real request builder without saving anything.
- `canvas: {workspaceId, expectedRevision, draftId?}` freezes the live canvas (or a staged draft) at exactly that
  revision instead of inline fields.
- To revise, pass `recipeId` with its current `expectedRevision` and every field again; a new revision is saved.

### V5 Full Effort (Medium)

NovelAI's V5 Full has two effort levels (2026-10-08, [NovelAI docs](https://docs.novelai.net/en/image/effort/)). High
is the model as it always ran. Medium is a distilled model that costs about 42 % less at default settings. What a
Medium request sends was read from NovelAI's own web client (build of 2026-11-06):

| | Medium |
| --- | --- |
| Model id sent | `nai-diffusion-5-full-medium`; inpaint `nai-diffusion-5-full-medium-inpainting` |
| Steps, sampler | 14, `k_euler_ancestral` |
| CFG rescale | 0 (not supported); `cfgScale` still applies |
| Undesired content | the Heavy preset (`ucPreset` 0), prefixed with `nsfw, ` unless the positive prompt contains `nsfw`; no negative prompt and no character negative prompts are sent |
| Inpaint strength below 1 | `img2img {strength, color_correct: true}`, as on High |

- `prepare_recipe` with `effort: "medium"`: `steps`, `sampler`, `ucPreset` and `negativePrompt` may be left out (and
  `cfgRescale` and character `negativePrompt`s). A value you give is replaced, never refused, and each replacement is a
  warning `effort_medium_fixed`, for example `effort medium fixes steps to 14; your 28 was replaced.` The stored recipe
  holds the values that run.
- Refused (`invalid_arguments`, `details.reason: "effort_not_supported"`): Medium on any other model (V5 Curated has no
  Medium) and in enhance, upscale or director. `effort: "high"` is accepted everywhere and changes nothing.
- The readback shows the model id sent (`effective.model`), `effective.effort` (`level`, and for Medium the fixed values
  with the full UC text) and `authored.effort`.
- On the canvas the effort is the parameter `params.effort` (`"medium"`, or absent for High; also
  `inpaintRecipe.effort`). It applies where the model that runs is V5 Full: the txt2img/img2img model, or the inpaint
  model for inpaint. `draft_edit` sets it with `params.effort: "high" | "medium"`. A canvas capture of a Medium canvas
  is the Medium request; its readback says which canvas values Medium replaced (`effort_medium_fixed`), and a Medium
  setting on a model without it is reported as `effort_not_applied` (and listed in `unusedInputs`).
- Enhance always runs High.

### Enhance Max✨

V5 Curated and V5 Full have a third enhance size, Max✨, which uses NovelAI's new upscaler (from the official web
client, build of 2026-11-06):

- The request is an img2img with `upscaled_enhance: true` and the source at its own size. The source must be a multiple
  of 64 and under 0.8 × 3,145,728 = 2,516,582 pixels; `prepare_recipe` adjusts any other source to the closest such
  size instead of refusing it (warning `enhance_max_source_adjusted`).
- NovelAI returns the image about twice as large, at most about 3.1 MP. The readback gives the size NovelAI's client
  expects (`effective.enhance.expectedOutput`: each side floored to 16 and doubled, fitted into 3,145,728 pixels in
  steps of 32; for 832×1216 that is 1440×2144); the saved image keeps the size NovelAI actually returns.
- **Max✨ costs Anlas on Opus too** (warning `enhance_max_paid`): its result is always larger than 1024×1024.
- `magnitude` sets the strength as for 1× and 2×. On another model `scale: "max"` is refused
  (`details.reason: "max_enhance_not_supported"`). 1× and 2× are unchanged. NovelAI's own client also offers 1.5×; this
  app does not.

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
- `draft_edit` stages a visible proposal at the exact current revision (the user sees it on the canvas). It also sets
  V5 Full's effort (`params.effort`) and Enhance Max✨ (`enhanceScale: "max"`);
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
`queue_storage_error`, `scheduler_stopped`, `scheduler_closed` and `update_pending`. Resuming a batch the queue paused
itself asks for confirmation in the app, because it lifts the protection.

`update_pending` is not a pause: while the app hands over to its update helper (Settings › About › Update and restart,
a few seconds) it starts no image; queued batches show it with status `queued`. A batch enqueued in that moment calls
the update off, and the queue then runs as usual. Otherwise the app quits for the update; calls meanwhile answer
`unavailable` (`details.autostart: "updating"` once the app is gone) until the new version runs (see
[Updates](updates.md)).

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
