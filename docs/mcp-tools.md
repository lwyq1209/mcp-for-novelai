# MCP tools reference

MCP for NovelAI ships one MCP server, named `novelai`, with 13 tools. This page describes what each tool does, how
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
- [Queue limits and failures](#queue-limits-and-failures)
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
   is reported as it is and **never sent again** by the automatic start; the rules of [Request keys and paid
   requests](#request-keys-and-paid-requests) stay exactly as they are (`enqueue_recipes` settles a lost enqueue
   answer itself, under the same key).
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
Starting the app (also by an agent) continues the batches its last run had not finished: an image that was running
when the app closed and was not saved is marked unknown and never resent, the other images go on in queue order. A
batch the user paused stays paused until it is resumed.

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
| Canvas | `read_workspace` | The canvas's state and its images |

Only `enqueue_recipes` generates images, and only when an agent calls it. Browsing, reading and saving never
generate anything. `control_queue` can resume a paused batch, which continues generating with the batch's original
recipes, and a restarted app continues the batches that were already queued.

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
- `censor` covers part of one image and writes the result as a JPG **without any metadata** (no prompt, settings, EXIF
  or NovelAI's hidden data) into `novelai/library-exports`, under a new name (`censored-history-<id>-r<revision>.jpg`,
  `censored-study-<id>-r<revision>.jpg`); the image in the library is only read. It is the agent's way to the window's
  *Censor and export* editor and renders the same way.
  - The image: `{kind: "history", id, revision, assetId}` or an imported image `{kind: "study", id, revision}` (PNG,
    JPEG or WebP; a rotated or mirrored original is refused, as for recipes).
  - `mask` says what to cover, in the grammar of the inpaint mask of [`prepare_recipe`](#prepare_recipe) (`units`, `layers` of shapes
    and alpha images, `growPx`, `invert`). Any selected pixel counts (the 8×8 cells of inpainting do not matter here);
    a mask that selects nothing is refused (`mask_empty`). Cover generously: `growPx` widens a shape.
  - `style`: `mosaic` (default), `blur`, `black` or `white`. `sizePx` (2–96) is the mosaic's cell edge or the blur's
    radius; without it the mosaic uses 1/100 of the image's longer side and at least 4 px, the usual lower bound for
    posting. `featherPx` (0–48) softens the edge of the covered area; `quality` (60–100, default 95) is the JPG's.
  - `preview: true` writes nothing and returns the censored picture (long edge at most 1024) to look at; check that
    everything is covered, adjust the mask, then call again without `preview`.
  - The result names `file` (project-relative), the size, `covered` (`pixels`, `percent`, `bbox`) and the rounded mask.
    An app older than this action answers `host_outdated`.

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
input the app would send. Check the readback before enqueueing.

The readback says what the app made of the recipe without repeating what the caller wrote. There is one readback; it
has no detail option.

- A recipe prepared from inline fields does not echo its prompts or character texts. The server compares the stored
  fields with the request one by one, and a difference is the error `recipe_input_mismatch`, not a readback. What it
  returns: the model id sent, sampling, mode parameters, `warnings`, the text the app appended
  (`effective.automaticQuality.appendedText`, `effective.ucPreset.text`), characters by `index` and `center` (with a
  text only where it differs from the request), the source (identity and size) and the mask (size, cells, layers). The
  final positive prompt is `stylePrompt`, `positivePrompt` and the quality text joined with `, `; the final negative is
  `negativePrompt` and the UC text.
- A canvas recipe's texts were never sent by the caller, so they are stated once: `authoredPrompts` (`stylePrompt`,
  `positivePrompt`, `negativePrompt`) and the character texts in `effective.characters`.
- When the appended text cannot be separated from the builder output (warning `readback_not_derived`), the final
  `effective.positivePrompt` and `effective.negativePrompt` are returned instead.
- `readiness` appears only for a blocked recipe (`ready: false`).

What an image was really made with is read afterwards from the library (`asset_library` `read` gives its prompts,
parameters and seed) and from the queue (`read_queue` gives each image's status, error and seed).

- Six modes: `t2i`, `i2i`, `enhance`, `inpaint`, `upscale`, `director`. A field that does not belong to the mode is
  refused rather than ignored.
- **Corrections instead of refusals** (0.1.4): a value the app would clamp, snap, resize, convert or drop is corrected
  to what will run *before* the recipe is saved (so the stored recipe holds exactly that value), and each correction is
  a readback warning `{code, field, from, to, message}` — see [Corrections](#corrections-prepare_recipe). Only what
  cannot run is refused: a missing field, an unknown model, sampler, noise schedule or preset name, a value of the
  wrong type, a field of another mode (or of another Director tool), an unreadable source, an inpaint source over
  1600 px per side and an upscale result over 4096 px per side.
- t2i: model, `width`/`height` (snapped to multiples of 64 and fitted into 3,145,728 pixels), `steps` 1–50,
  `cfgScale` 0–10, optional `cfgRescale` 0–1, sampler, noise schedule (V5 always uses `karras`), `ucPreset` 0–3,
  `qualityPreset` (`standard`, `light` on V5 only — elsewhere `standard` —, `none`), style, positive and negative
  prompts, `seed` 0–2147483646 (or `null`, or a negative number, for a random seed drawn at enqueue), optional
  characters (V4 and later: up to 6, V5 up to 32; more are dropped) and `transparentBackground` (V5 only; dropped
  elsewhere).
- `effort` (optional, default `high`): V5 Full's Effort toggle. `medium` runs NovelAI's distilled Medium model and
  exists only for `nai-diffusion-5-full` txt2img, img2img and inpaint; anywhere else the recipe runs on High (warning
  `effort_not_applied`). See [V5 Full Effort](#v5-full-effort-medium).
- i2i: the t2i fields without `transparentBackground`, plus `source`, `strength` 0–1 and an optional `extraNoiseSeed`
  (0 or `null`: random per image). `width`/`height` are optional: a size more than 3 % off the source's aspect ratio
  is refitted to it at about the same area (`i2i_size_adjusted`; within 3 % the app stretches the source slightly and
  the readback says `source_resized_for_i2i`), and without a size the source's aspect is used at about 832×1216 pixels,
  within the Opus free size of 1024×1024 pixels (`i2i_size_from_source`). The readback gives the size used.
- enhance: `magnitude` 1–10, `scale` 1, 2 or `"max"` (Max✨, V5 models only; see [Enhance Max✨](#enhance-max)). For 1
  and 2 the request is the source × scale in multiples of 64 within 3,145,728 pixels; a source that is not aligned (or,
  at 1, too large) is resized by the app (`enhance_source_adjusted`), and a 2 that would not fit becomes 1.
- inpaint: the generation fields without size, characters or `transparentBackground` (no Furry V3), plus `source`,
  `strength` 0–1 and `mask`. A source that is not a multiple of 64 is resized up to the next multiple by the app
  (`inpaint_source_adjusted`); after that it may be at most 1600 px per side.
- upscale (`scale` 2, may be left out) and director (`tool`, optional `defry` 0–5, `colorizePrompt` for colorize — it
  may be empty or left out —, `emotion` and optional `emotionLevel` 0–5 for emotion) use no seed. A source over
  1,048,576 pixels is downscaled by the app before the request (readback warning `source_downscaled`);
  `acceptDownscale: false` refuses such a source instead (`source_needs_downscale`). `acceptDownscale: true` is the
  default and stays accepted.
- Image modes take a `source`: a history image `{kind: "history", historyId, historyRevision, assetId}` from
  `asset_library`, or an imported image `{kind: "study", studyId, studyRevision}`. `inpaint` also takes a `mask`
  built from shapes (rectangles, ellipses, polygons, strokes) and alpha layers; `preview: true` returns the source
  with the selected cells tinted red so the mask can be checked before saving.
- `preview: true` runs every check and the real request builder without saving anything.
- `canvas: {workspaceId, expectedRevision, patch?}` freezes the live canvas at exactly that revision instead of inline
  fields; `patch` is a detached t2i text patch (`params`, `charCaptions`) read over the canvas without changing it.
- To revise, pass `recipeId` with its current `expectedRevision` and every field again; a new revision is saved.

### Corrections (`prepare_recipe`)

Each correction is one warning in the readback (and in the preview), with the field, the value given (`from`) and the
value used (`to`):

| Warning | When | What is used |
| --- | --- | --- |
| `value_clamped` | A number outside its range: `steps` 1–50, `cfgScale` 0–10, `cfgRescale` 0–1, `ucPreset` 0–3, `strength` 0–1, `magnitude` 1–10, `defry` and `emotionLevel` 0–5, character `x`/`y` 0–1; `enqueue_recipes` `intervalSeconds` 0–60 | The nearest bound (whole-number fields also rounded) |
| `size_adjusted` | t2i/i2i `width`/`height` not multiples of 64, or more than 3,145,728 pixels | Each side snapped to 64, then shrunk into the limit keeping the ratio, as the app's own size rule does (1000×1500 → 1024×1472) |
| `i2i_size_adjusted` | An i2i size more than 3 % off the source's aspect | The 64-aligned size within 3 % of the source's aspect closest to the requested area |
| `i2i_size_from_source` | i2i without `width`/`height` (or with only one) | The source's aspect at about 832×1216 pixels, at most 1024×1024 pixels (or at the area the one side implies) |
| `value_replaced` | A value that does not exist on that model or mode: V5 with a noise schedule other than `karras`, `qualityPreset: "light"` off V5, upscale `scale` other than 2, enhance 2× that does not fit, Max✨ off V5 | `karras`; `standard`; 2; 1; the largest of 2 and 1 that fits |
| `value_dropped` | `transparentBackground` off V5; more characters than the model takes (V3: none) | Off; the first 6 (V4/V4.5) or 32 (V5) |
| `value_defaulted` | A character with `useCoords: true` but no `x`/`y`; emotion without `emotionLevel` | 0.5; 0 |
| `seed_random`, `seed_wrapped` | A negative `seed`/`extraNoiseSeed`; one above 2147483646 | Random at enqueue; the value wrapped into 0–2147483646 |
| `effort_not_applied` | `effort: "medium"` where Medium does not exist | High |
| `enhance_source_adjusted` | An enhance 1×/2× source that is not 64-aligned (or too large at 1×) | The size the app resizes it to |
| `inpaint_source_adjusted` | An inpaint source that is not 64-aligned | The next multiples of 64 (the result has that size) |
| `source_downscaled` | An upscale/director source over 1,048,576 pixels | The app's downscale into that limit |

An exact recipe has none of these warnings. The warnings exist at prepare (and preview) time; the stored recipe holds
the corrected values.

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
- Medium on any other model (V5 Curated has no Medium) or in enhance, upscale or director runs on High, with the
  warning `effort_not_applied` (before 0.1.4 this was refused). `effort: "high"` is accepted everywhere and changes
  nothing.
- The readback shows the model id sent (`effective.model`) and, for Medium, `effective.effort` (`level` and the fixed
  values; the fixed UC text is `effective.ucPreset.text`).
- On the canvas the effort is the parameter `params.effort` (`"medium"`, or absent for High; also
  `inpaintRecipe.effort`). It applies where the model that runs is V5 Full: the txt2img/img2img model, or the inpaint
  model for inpaint; it is set in the app. A canvas capture of a Medium canvas
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
- `magnitude` sets the strength as for 1× and 2×. On another model `scale: "max"` uses the largest of 2× and 1× that
  fits the source (warning `value_replaced`). NovelAI's own client also offers 1.5×; this app does not.

### `enqueue_recipes`

Puts frozen recipes into the shared queue. **The app then generates these images with your NovelAI account, which can
spend Anlas, with no further confirmation.**

- `requestKey` (required) identifies this intent; see [Request keys](#request-keys-and-paid-requests).
- `items`: `[{recipeId, recipeRevision, inputHash, count?, seeds?}]`. One mode per enqueue. `seeds` give one seed per
  image. Without them a random-seed recipe draws one per image, and a fixed-seed recipe used for several images gives
  them its seed, seed + 1, seed + 2 … (after 2147483646 back to 0) so they differ; the receipt lists the seeds in
  `items` and a warning `fixed_seed_incremented`. Repeat a seed in `seeds` for identical images. `upscale` and
  `director` recipes take no seed: each is sent once per enqueue (a `count`, `seeds` or a second entry are dropped,
  warning `postprocess_single_image`), because every image of it would be the same paid request.
- Optional `intervalSeconds` (0–60) between images, and `historyGroup` / `fileNamePrefix` for your project (see
  [Several projects](#several-projects-on-one-queue)).
- A wrong revision or `inputHash`, mixed modes, a blocked recipe or a source that is gone are refused before anything is
  sent; the key stays unused.
- The receipt lists warnings, for example characters that a model does not take or a preset that adds no text.
- **A lost answer is settled in the same call** (0.1.4): see [Request keys](#request-keys-and-paid-requests). The
  receipt then says `reconciled: true` and `settled: {lookups, resends, seconds}`.

### `lookup_enqueue`

Looks up the receipt of one of your request keys: `enqueued` (with the batch), `rejected`, `unknown` or `not_found`,
plus `inFlight` (the app has received an enqueue under this key and is still handling it) and a **settlement** that
says what you may do next. It never enqueues or resends anything. See [Request keys](#request-keys-and-paid-requests).

### `list_queue`, `read_queue`, `get_queue_result`

- `list_queue`: the total, counts by status, the first 8 batches (`batchId`, `source`, `status`, `stopReason`, `count`,
  `activeJobId`, failed and unknown item counts) and, when the app reports it, storage use of the frozen queue and the
  recipe store against their limits. Batches started with **Generate** in the app are listed too, with
  `source: {kind: "manual", persistent: false}` (they are kept only while the app runs); agent batches have
  `source: {kind: "agent", client}`.
- `read_queue {batchId, wait?}`: status, `stopReason`, request key, plan hash, interval, output (project and
  prefix), `itemCounts` (`pending`, `running`, `succeeded`, `failed`, `unknown`, `cancelled`, `skipped`), per-item
  status, job ID, result count, error code and `rateLimitRetries` (how often the image was sent again after HTTP 429),
  `itemReasons` (an explanation of the queue's own item codes present, see [below](#queue-limits-and-failures)), and
  `results` — one entry per saved image with `itemIndex`, `index`, `historyId`, `actualSeed` (the seed it was
  generated with; `null` for upscale and director), `fileName` and `file` (the path relative to the project root, or
  `null` outside it). It also says where the batch stands in the shared queue:
  - `ahead: {images, batches}` — unfinished images, and the batches they belong to, that run before this batch
    (paused batches hold nothing up and are not counted; of a batch being paused only its running image counts);
  - `etaSeconds` — about how many seconds until this batch ends: the recent median image time (`imageSeconds`) times
    the images before it and its own, plus its intervals. `null` while no image time is known yet (after a start the
    app reads them from the batches it stored) or while the batch is paused; `0` once it ended.
  An app older than this server reports `ahead`, `etaSeconds` and `imageSeconds` as `null`.

  **Waiting.** Instead of reading again and again with sleeps, pass `wait: {until, seconds?}` (`seconds` 1–1200,
  default 300). The server reads the batch every second (every two seconds while `etaSeconds` is over a minute) and
  returns as soon as:
  - `until: "done"` — the batch ended (`succeeded`, `partial`, `cancelled` or a cleaned batch);
  - `until: "next"` — this batch saved a result that was not there when the call started (results of other batches
    do not count); a batch that ends first returns `done`;
  - the batch is `paused` (`ended: "paused"`) or cancelled or being cancelled (`ended: "cancelled"`), whatever
    `until` says;
  - otherwise after `seconds` (`ended: "timeout"`).

  The answer is the usual `read_queue` answer plus `wait: {until, ended, waitedSeconds}`. A read that fails on the
  way (the app restarting, a dropped connection) is tried again at the next poll; if the last read failed, the answer
  carries the last good state and `wait.lastReadFailed` with the error code, and only when no read succeeded at all
  does the call fail with that error. A definite refusal (`batch_not_found`, invalid arguments) ends it at once.
  Cancelling the MCP request stops the wait. 1200 seconds is the most one call waits, below the 1560-second tool
  timeout of the MCP configurations the app shows; wait again for longer.
- `get_queue_result {batchId, itemIndex, index?}`: one saved image at full size, with the same identity fields.
- `get_queue_result {batchId, offset?}` (without `itemIndex`): the saved results of the whole batch in item order as
  native thumbnails (at most 384 px on the longer side, WebP), **at most 20 per call**: `total`, `offset`,
  `returned`, `nextOffset` (`null` on the last page; pass it as `offset` for the next page) and `results`, one entry
  per saved image with `itemIndex`, `index`, `historyId`, `actualSeed`, `fileName`, `file`, `width`, `height` (of the
  thumbnail) and `imageAttached`. The images follow the text in the order of the entries with `imageAttached: true`;
  an image whose preview cannot be made right now is listed with `imageAttached: false` and its error `code`. An app
  older than this server answers `host_outdated`; use `itemIndex` there.

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

The canvas is the app's manual workbench. The two canvas tools read it; **they never generate and never edit it.**
The canvas is edited in the app.

- `list_workspaces` gives the `workspaceId`; `read_workspace` returns the creative state with its revision and an asset
  manifest. Images are attached natively: by default the one the canvas shows, `assetIds` picks up to five from the
  manifest, `includeImages: false` none.
- `read_workspace` is compact by default and lists what it left out in `omitted`:
  - an image entry (`currentImage`, `workbenchImage`, `i2iOriginalImage`, `comparisonBeforeImage`) keeps its identity,
    seed and size but not its own recipe (`params`, `characterSnapshot`, `characterPrompts`), which in the usual case
    repeats the canvas prompts; `promptsMatchCanvas` says whether its prompts and character prompts equal the canvas
    ones;
  - `inpaintPositivePrompt` and `inpaintRecipe` appear only while the inpaint tab is active.

  `detail: "full"` returns the whole snapshot.
- To generate what the canvas holds: read it, freeze it with
  `prepare_recipe {canvas: {workspaceId, expectedRevision}}`, check the readback, then `enqueue_recipes`. With
  `preview: true` the same call is a dry run of the canvas's effective input that saves nothing. A newer revision is
  a conflict: read the workspace again. Results of an agent enqueue go to the library and the queue, not back onto the
  canvas.
- Retired on 2026-11-12: `read_prompt_review` (use `prepare_recipe {canvas, preview: true}`), `get_asset` (use
  `read_workspace {assetIds}`), `draft_edit`, `apply_edit` and `undo_edit` (edit the canvas in the app). They answer
  `unknown_tool`.

## Request keys and paid requests

`enqueue_recipes` spends your NovelAI balance. The request key is what keeps a retry from paying twice.

- Choose one `requestKey` per intent (1–120 printable characters) and reuse the **same** key for the same intent,
  also after a restart. The server namespaces it (`mcp-…`) and looks it up before sending, so a key that already has a
  receipt is never queued again: a repeated call answers `already_enqueued` with the existing batch. A new key is a
  new paid request.
- If the same key is used with a different plan, the call is refused with `request_conflict` and nothing is sent.
- **When the answer to an enqueue is lost** (a timeout, a dropped connection, a reply that does not confirm the plan),
  `enqueue_recipes` settles it itself, in the same call: it looks the key up — the app says whether an enqueue under
  it is still being handled (`inFlight`) — and waits while it is; when the app holds nothing it is working on (no
  receipt: the request never arrived; or a receipt whose enqueue ended without a batch), it sends **the same plan under
  the same key** again, at most three times, for up to about 150 seconds. That never pays twice: the app handles one
  enqueue at a time and answers a repeat of a plan from its key's receipt, and its batch store also answers a key it
  already holds with that batch. The answer is `enqueued` (with `reconciled: true`) or the definite refusal. The call
  never switches keys.
- Only when the app stays silent for that long is the answer still `queue_acceptance_unknown`. Then calling
  `enqueue_recipes` again with the same key and plan, or `lookup_enqueue` with the same key, is safe. `lookup_enqueue`
  answers at once:
  - `settling` with `inFlight: true` — the app is still handling it: look again after `retryAfterSeconds` (2), or call
    `enqueue_recipes` again with the same key and plan, which waits for it;
  - `clear` — nothing is recorded and nothing is in flight: nothing was queued, enqueue with this key as you like; with
    `resend: "same_plan_same_key"`, the app holds the key without a batch and the same plan under the same key starts
    it again (a different plan needs a new key);
  - `stale` with `newKeyAdvised: true` — only when the app finished with the key without a batch, cannot start it
    again and has no batch under it: the same plan may be enqueued under a new key (check `list_queue` afterwards).
  An app older than this server does not report `inFlight`; its unknown receipts are always `settling`, never advised
  a new key. Before 0.1.4 the agent had to look the key up twice, about 130 seconds apart, before a new key could be
  advised; that window is gone.
- An image with an unknown outcome may have been generated and charged. It is never resent automatically;
  `read_queue` tells you to check the library (`asset_library` with `queueBatchId`) before making it again under a
  new key.

## Queue limits and failures

Settings › Queue in the app holds the limits; they are this app's safety stops, not NovelAI limits.

| Limit | Default | Range | Refusal |
| --- | --- | --- | --- |
| Images per enqueue | 20 | 1–200 | `enqueue_limit_exceeded`, naming the current limit |
| Queued images in total (all unfinished images) | 200 | 1–100,000 or no limit | `queue_full` |
| Frozen queue on disk | 64 MiB per batch, 512 MiB in total | fixed | `queue_input_too_large` / `queue_full` |

The images' frozen sources and masks may take about 32 MiB per enqueue. These limits apply to agent enqueues, not to
generating on the canvas.

**No failure stops the queue.** All projects' agent batches and the app's own **Generate** clicks run in one queue,
one image at a time. When an image fails, is refused before it is sent or has an unknown outcome, only that image is
marked (`failed` or `unknown`, with its error code) — it is **never resent** — and its batch goes on with its next
image after its interval; no batch pauses another. A batch that ran to its end with such images ends **`partial`**
(never `succeeded`), with `itemCounts` saying how many failed or are unknown. `blocked` appears only on batches an
app version before 0.1.4 stopped at their first unsuccessful image.

- **HTTP 429** (NovelAI answered "too many requests", for example "Concurrent generation is locked" while another
  generation runs on the account; nothing was generated): the same image is sent again with the same frozen recipe
  and seed after 2, 4, 8, 16 and 30 seconds (about a minute in all), then it fails as `rate_limited` and the batch
  goes on. Only a received 429 counts: a timeout, a dropped connection or any unknown outcome is never resent.
- **A token that is no longer valid or not enough Anlas** (HTTP 401, 402, 403): that image fails (`authentication_failed`
  or `generation_failed`) and the batch goes on; its next images fail the same way quickly until the user fixes the
  account in the app.
- **The app cannot read the running image, or cannot confirm whether an image was already submitted**: it reads again
  with growing pauses for about 90 seconds; then only that image is marked unknown (`child_status_unavailable`,
  `child_lookup_failed`) and the batch goes on. The next image waits until the generator is free: two images never
  run at once.
- **The app closes or crashes while an image runs**: after the next start an image the library did not save is
  `unknown` (`restart_unconfirmed`, never resent), and the batch continues by itself with the rest.
- **The frozen queue cannot be written to disk** (`queue_storage_error`): this still stops every agent batch and new
  enqueues are refused, to protect the queued data, until the problem is fixed.

Item error codes the queue sets itself (explained in `read_queue` as `itemReasons`): `rate_limited`,
`child_lookup_failed`, `child_status_unavailable`, `submission_unconfirmed`, `restart_unconfirmed` and
`scheduler_error` (an internal error while handling that image). Codes of the request itself include
`generation_failed`, `authentication_failed`, `provider_unknown` and the refusals before sending (`invalid_arguments`,
`invalid_image`, `history_params_invalid`, …).

`read_queue`, `list_queue` and `control_queue` report a batch's `stopReason` as `{code, message}`. The codes the queue
sets on a batch now are `update_pending`, `queue_storage_error`, `cancel_unconfirmed`, `scheduler_closed` (the app was
closing; the batch continues after the next start) and `scheduler_stopped` (an internal error ended only this batch
early; its remaining images were skipped). Batches stored by an app version before 0.1.4 may still carry
`queue_halted`, `child_stopped`, `child_rejected`, `submission_unconfirmed`, `restart_unconfirmed`,
`restart_blocked`, `recovered_paused`, `child_lookup_failed` or `child_status_unavailable`; the message says what that
version did.

`update_pending` is not a pause: while the app hands over to its update helper (Settings › About › Update and restart,
a few seconds) it starts no image; queued batches show it with status `queued`. A batch enqueued in that moment calls
the update off, and the queue then runs as usual. Otherwise the app quits for the update; calls meanwhile answer
`unavailable` (`details.autostart: "updating"` once the app is gone) until the new version runs (see
[Updates](updates.md)).

## Queue retention and cleaned batches

Ended agent batches (succeeded, partial, cancelled or blocked) are cleaned once they ended more than the retention period ago:
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
| `novelai/library-exports` | `material_library` export, `asset_library` export and censor |
| `novelai/study-inbox` | `material_studies` import |
| `novelai/study-exports` | `material_studies` read (long sections), original, import reports |

The project root is `NOVELAI_PROJECT_ROOT` when the server is started with it, otherwise `<data folder>/workspace`
(the app creates its two inbox folders there). Inbox files must be ordinary files with a single link. Paths in results
are relative to the project root (`pathBase: "project-root"`, with the root named in `projectRoot`).

## Timeouts

One tool call can take long: `enqueue_recipes` makes up to 23 calls to the app in a row, each bounded at 65 seconds,
and settles a lost answer for up to about 150 seconds more; it ends within 24 minutes in all. Allow about
**26 minutes (1560 seconds)** per tool call. The configurations in Settings › MCP access already set this
for Codex (`tool_timeout_sec`, plus `startup_timeout_sec = 30`), Pi (`timeout`) and DeepSeek Harness
(`toolCallTimeoutMs: 1560000`; its default is 60 seconds). Claude Code's defaults are long enough. A call that starts
the app takes up to 30 seconds longer. Cursor has no setting for it: if Cursor reports a timeout, check the queue page before letting the agent
resend. For other clients, set the tool timeout yourself.

## Errors

A failed call returns `isError: true` with `{error: {code, message, details?}}`. Messages are written for the agent and
say what to do next. Common codes are explained in [Troubleshooting](troubleshooting.md).
