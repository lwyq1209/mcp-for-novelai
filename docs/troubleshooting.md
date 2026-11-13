# Troubleshooting

Tool errors come back as `{error: {code, message, details?}}` (see [MCP tools](mcp-tools.md#errors)); the message says
what to do next. This page explains the codes and situations people ask about most.

- [The agent cannot reach the app (`unavailable`)](#the-agent-cannot-reach-the-app-unavailable)
- [`host_outdated`](#host_outdated)
- [Settings › MCP access shows a warning](#settings--mcp-access-shows-a-warning)
- [Timeouts and unknown outcomes](#timeouts-and-unknown-outcomes)
- [Corrected values in a recipe](#corrected-values-in-a-recipe)
- [Refused enqueues](#refused-enqueues)
- [Failed, unknown and partial batches](#failed-unknown-and-partial-batches)
- [Cleaned batch records damaged or missing](#cleaned-batch-records-damaged-or-missing)
- [Queue storage errors](#queue-storage-errors)
- [NovelAI refuses a request](#novelai-refuses-a-request)
- [Files in the inboxes](#files-in-the-inboxes)
- [Opening the app the first time](#opening-the-app-the-first-time)
- [Linux: the app does not start](#linux-the-app-does-not-start)
- [Updates](#updates)
- [Logs](#logs)

## The agent cannot reach the app (`unavailable`)

`unavailable` means the MCP server found no running app for its data folder, or the connection dropped. The server
reads `runtime/bridge.json` in the data folder on every call; the app writes it when it starts and removes it when it
quits. When no app is running, the server normally starts it in the background and waits up to 30 seconds (see
[When the app is not running](mcp-tools.md#when-the-app-is-not-running)); `unavailable` then means it could not, and
`details.autostart` says why:

- `off` — automatic start is turned off (`NOVELAI_MCP_AUTOSTART=0` in the agent's configuration). Open the app, then
  call again; or remove the variable.
- `unsupported` — the server does not run with an app's own executable, for example `node novelai/src/mcp.mjs` with
  your own Node. Open the app yourself, or register the server with the configuration from Settings › MCP access.
- `started_not_ready`, `started_exited`, `start_failed` — the server started the app (or tried to) but it did not
  come up. Open the app yourself and look at what it shows (a first launch on macOS may need **Open** in the Finder
  once; see [Opening the app the first time](#opening-the-app-the-first-time)); the app's log is in `logs/` of the data
  folder.
- `starting_not_ready` — the app is starting (by you or another agent) and was slow; call again in a moment.
- `updating` — the app is installing an update and opens again by itself; the server does not start it meanwhile.
  Call again in a minute. The state ends when the new version runs, when the update gives up, or after 5 minutes.
- `recently_started` — this server tried to start the app less than a minute ago (the start failed, or the app closed
  again); it does not try again so soon. Open it yourself or call again later.
- On Linux, `started_not_ready` can also mean the agent starts its MCP servers without the desktop's variables
  (`DISPLAY` or `WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`): the app cannot open without them. Open it yourself, or
  pass them in the agent's MCP configuration.
- No `details.autostart` — usually the connection dropped after the request was sent: the call may or may not have
  reached the app and is never sent again automatically (see the next points). Two cases without it are certain not to
  have been sent: the message says the connection file cannot be read (restart the app; it writes a new one), or the
  call was cancelled while it waited for the app to start.

Also:

- Make sure the agent starts the server with the configuration from **Settings › MCP access** of the app you are
  running: it names the app's data folder as `NOVELAI_DATA_DIR`. A server started for another data folder (another
  install, a test folder, a build from source with `--data-dir`) looks for (and starts) a different app.
- After `unavailable` in the middle of a write (an enqueue, a save), read the current state before doing anything
  again: the write may or may not have happened. An enqueue is the exception that needs no care: `enqueue_recipes`
  with the same request key and plan is always safe (the app answers a repeat from the key's receipt), and is also
  how to ask what the key holds.
- `invalid_connection` means `bridge.json` exists but is not a valid local connection file. Restart the app; it writes a
  new one.
- The app started by an agent keeps its window out of the way: on macOS only its Dock icon appears (click it to show
  the window), on Windows it is minimized in the taskbar (click its button), on Linux it runs in the background without
  a taskbar entry (open the app again to see the window). Settings › MCP access lists which agent started it and when.

## `host_outdated`

The MCP server is newer than the app it reached and asked for something the app does not know. Nothing was saved or
enqueued and no request key was used. This happens when the agent's configuration points at the server of a newer
install or a source checkout while an older app is running. Copy the configuration again from Settings › MCP access of
the app you run (or update the app), restart the agent's MCP connection and call again. From source, rebuild and
restart the app (`node novelai/scripts/start-client.mjs`).

## Settings › MCP access shows a warning

- **"The agent channel hasn't started yet"** — the app is still starting; open the page again in a moment.
- **"The MCP server file is missing"** — a build from source without the MCP bundle: build the client completely
  (`npm --prefix novelai/client run build`, which `start-client.mjs` runs unless you pass `--no-build`).
- **"This app runs from a temporary location"** — the app's path changes on every launch: a macOS app that was not
  moved to Applications and runs translocated or from the disk image (or a portable Windows build or an AppImage you
  made yourself). A configuration copied now would break at the next launch. On macOS move the app to Applications
  and open it from there; on Windows use the `setup` installer; on Linux use the extracted `.tar.gz` folder at a fixed
  place (see the [README](../README.md#install)).

## Timeouts and unknown outcomes

One `enqueue_recipes` call can take minutes. Allow about 26 minutes (1560 seconds) per tool call (see
[Timeouts](mcp-tools.md#timeouts)).

- `timeout` from the server: the call to the app took longer than 65 seconds or was interrupted. Its outcome is
  unknown. Do not repeat a write automatically; read the current state first.
- An enqueue whose answer is lost is settled by `enqueue_recipes` itself, in the same call: it looks the request key
  up, waits while the app is still handling it and sends the same plan under the same key again when the app holds
  nothing (never a second batch), for up to about 150 seconds, then answers `enqueued` (`reconciled: true`) or the
  refusal. Only if the app stays silent is the answer still `queue_acceptance_unknown` — call `enqueue_recipes` again
  with the same key and plan once the app answers; never switch keys while an outcome is still unknown
  (see [Request keys](mcp-tools.md#request-keys-and-paid-requests)).
- When the agent's own client times out, the server may still have finished the enqueue. Look at the queue page, or
  call `enqueue_recipes` again with the same request key and plan (it answers `already_enqueued` if it was).

## Corrected values in a recipe

`prepare_recipe` no longer refuses values the app would adjust anyway: a size that is not a multiple of 64, `steps`
above 50, a noise schedule V5 does not use, `light` quality off V5, too many characters, an i2i size off the source's
aspect ratio, a large upscale source and so on are corrected to what will run, saved that way, and listed as warnings
in the readback (`value_clamped`, `size_adjusted`, `value_replaced`, `value_dropped`, `i2i_size_adjusted`, …, each
with `field`, `from` and `to`). Check the readback's `effective` values and warnings; the full list is in
[MCP tools](mcp-tools.md#corrections-prepare_recipe). `enqueue_recipes` likewise gives a fixed-seed recipe used for
several images the seeds seed, seed + 1, … (`fixed_seed_incremented`) and sends an upscale or Director recipe once
(`postprocess_single_image`).

## Refused enqueues

Nothing was sent and the request key is still unused unless the message says otherwise.

| Code | Meaning | What to do |
| --- | --- | --- |
| `enqueue_limit_exceeded` | More images than Settings › Queue › Images per enqueue (default 20) | Split the plan, or raise the limit (up to 200) |
| `queue_full` | All unfinished images would exceed Settings › Queue › Queued images in total (default 200), or the frozen queue has no room | Wait for batches to finish, or raise the limit |
| `queue_input_too_large` | One batch's frozen input would exceed 64 MiB | Fewer images or smaller sources per enqueue |
| `request_conflict` | This request key already names a different plan (also when its batch was cleaned) | Use a new key only if the new plan is really wanted |
| `recipe_not_found` | The recipe revision does not exist or was reclaimed | Prepare it again with the same fields (same `inputHash`), see [recipe_not_found](mcp-tools.md#when-a-recipe-is-gone-recipe_not_found) |
| `history_group_conflict` | The project name (`historyGroup`) would save into the same folder as an existing project whose name differs only in spaces, case or path characters | Use the existing name the message offers, or a clearly different name |
| `history_group_unavailable` | The project could not be created or read | Nothing was queued and the key was not used; check the app and try again |
| `invalid_arguments` | The arguments do not match the tool's schema or rules | Fix the call; the message names the problem |

## Failed, unknown and partial batches

A failed or unknown image never stops the queue: only that image is marked, it is never resent, and its batch goes
on with its next image; other batches (other projects', the app's own Generate) are not affected. A batch that ran to
its end with such images ends **partial** (部分完成 on the queue page) instead of succeeded. Check its failed and
unknown images on the queue page or with `read_queue` (`itemCounts`, each item's `error` code, `itemReasons`) and the
library (`asset_library {action: "list", category: "history", queueBatchId}`): an unknown image may have been generated
and charged, so look there before making it again under a new request key.

- A received **HTTP 429** is sent again automatically for about a minute (`rateLimitRetries` counts the resends);
  only after that does the image fail as `rate_limited`.
- After the app closed or crashed, unfinished batches **continue by themselves** at the next start; an image that was
  running then and was not saved is `unknown` (`restart_unconfirmed`). A batch you paused stays paused.
- Only a frozen-queue storage failure (`queue_storage_error`, below) still stops every agent batch.

An agent follows a batch with `read_queue {batchId, wait: {until: "done"}}` instead of polling; `ahead` and
`etaSeconds` say what is queued before it and roughly how long it takes.
[MCP tools](mcp-tools.md#queue-limits-and-failures) lists every code. Batches an app version before 0.1.4 stored may
show **blocked** (stopped at their first unsuccessful image) or stop reasons such as `queue_halted`; they are kept
for reading.

## Cleaned batch records damaged or missing

The app keeps a small record of every batch that queue retention cleaned (an append-only file in
`runtime/queue-cleaned` of the data folder, checked against two anchor files, one there and one in `queue-anchor`).
These records are what lets an old request key answer "already enqueued" instead of "not found". If they are damaged
or missing, the app **fails closed**: every lookup or enqueue whose key has no receipt is refused with
`queue_storage_failed` (`details.reason: "cleaned_records_unreadable"`, `details.problem` one of `records_missing`,
`chain_broken`, `anchor_missing`, `anchor_invalid`, `anchor_mismatch`, `torn_unverified`, `read_failed`), so nothing
can be generated and charged twice. Settings › Queue shows the problem.

To recover, in this order:

1. **Restore from a backup.** Settings › Storage & backup › Restore from backup…, and pick a recent backup (automatic
   backups are in the backup folder, by default `backups/` in the data folder). Every backup carries these records,
   whatever data you select; importing adds the backup's records to the ones here and never removes any.
2. Or, with the app closed, copy the folders `runtime/queue-cleaned` and `queue-anchor` back into the data folder from
   a copy of it (for example a file-system backup) and start the app again.
3. Only if no backup has them: Settings › Queue › **I have checked: continue with the records left…**. The app rebuilds
   what it can from the library (batches that saved images) and says how many records are lost. Batches that made no
   image cannot be rebuilt; if an agent reuses their keys, they may be generated and charged again. This cannot be
   undone.

## Queue storage errors

- `queue_storage_error` — the frozen queue cannot be read or written safely. Agent batches are paused and new enqueues
  are refused until it is fixed (the one failure that still stops the queue, to protect the queued data). The log
  (see [Logs](#logs)) names the cause. After the problem is fixed and the app restarted, the paused batches continue
  by themselves.
- `queue_acceptance_unknown` — the request key has a receipt, but the frozen queue cannot be read right now, so its
  batch may already exist. Do not resend and do not switch keys; fix the app first (restarting it is your decision),
  then look up the same key again.
- `queue_storage_failed` for other reasons (for example a full recipe store) — read the message; nothing was saved.

## NovelAI refuses a request

- **Authentication failed (401/403)** — paste and verify your Persistent API Token again in Settings › Account &
  network, and check that the image API is `https://image.novelai.net` (Custom API address is off by default). Queued
  images fail one after another (quickly) until the token works again; nothing is paused.
- **Not enough Anlas or subscription (402)** — check your balance and subscription on NovelAI. As with 401, the
  queued images fail and the queue moves on.
- **Too many requests (429)** — usually another generation on the same account ("Concurrent generation is locked").
  The queue sends that image again for about a minute, then marks it `rate_limited` and goes on.
- **A server error (5xx) or a timeout** — the image may have been generated and charged, so it is marked unknown and
  never resent; the batch goes on. Check the library before making it again.
- **"Set up your NovelAI API token in Settings first"** — the app has no token yet (Settings › Account & network).

## Files in the inboxes

`file_unavailable` means an inbox or export folder, or the named file, is missing or not allowed. Inbox inputs are plain
file names (no paths, URLs or symbolic links) of ordinary single-link files directly inside `novelai/library-inbox` or
`novelai/study-inbox` under the project root (see [Files](mcp-tools.md#files-inboxes-and-exports)). Settings › MCP
access › Advanced shows where the inboxes are now.

## Opening the app the first time

- **macOS: "Apple could not verify …" / the app does not open.** Builds are signed with the project's self-signed
  certificate and not notarized. Open the
  app once, then go to **System Settings › Privacy & Security**, scroll to Security and click **Open Anyway** (it is
  offered for about an hour after the attempt), then confirm with your password. Control-click › Open no longer skips
  this check on current macOS.
- **macOS: the app opens, but the agent's MCP server is blocked with "Apple could not verify …"** (the agent says
  the server failed to start or could not connect). **Open Anyway** only covers starting the app with a double-click;
  the agent runs the MCP server inside the app directly, and Gatekeeper still checks that. Run once in Terminal (and
  again after installing a new version), then restart the agent or reconnect its MCP server:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/MCP for NovelAI.app"
  ```

  It removes the quarantine mark macOS puts on downloaded files, which is the same as telling macOS that you trust
  this app.
- **Windows: "Windows protected your PC" (SmartScreen).** Builds are not code-signed yet. Click **More info**, then
  **Run anyway**.
- **The app opens the existing window instead of a second one.** Only one app runs per data folder; starting it again
  brings the running window to the front.

## Linux: the app does not start

Run `mcp-for-novelai` from a terminal in the extracted folder to see why. If it says that the SUID sandbox helper
(`chrome-sandbox`) is not configured correctly: Electron's sandbox needs either unprivileged user namespaces, which
some distributions restrict (Ubuntu 24.04 and later through AppArmor), or its `chrome-sandbox` helper owned by root
with the setuid bit. An archive cannot carry that ownership, so set it once in the extracted folder:

```sh
sudo chown root:root chrome-sandbox
sudo chmod 4755 chrome-sandbox
```

Do this again after replacing the folder with a new version. Starting the app with `--no-sandbox` also works but turns
Chromium's sandbox off; avoid it.

## Updates

- **"The update could not be verified"**: the release's signature, checksum, version or (macOS) code signature did not
  match; nothing was installed. Try again later or use **Download**. A repeated failure on a correct network means a
  release file was changed after signing, or the release is not signed yet: report it (see SECURITY.md).
- **"The update file could not be unpacked"**: usually a full disk next to the app; make room and click **Try again**.
- **"Update after the queue"**: the queue has batches generating or waiting. Wait, or pause them on the queue page
  (paused batches are kept). It also shows again when a batch arrived while the app was handing over to the update.
- **Windows: "another copy of this app is running"**: an app with another data folder runs from the same installation;
  the installer would close it. Close it, then update.
- **Only Download is offered**: the app cannot replace itself where it is (the reasons are listed in
  [Updates](updates.md#when-the-app-cannot-update-itself)).
- **"The update to x.y.z did not complete"**: the helper changed nothing or put the old version back; the reason is
  shown, and `updates/<id>/helper.log` in the data folder has the details. macOS "did not allow moving the app": see
  [App Management](updates.md#macos-signing-the-keychain-and-app-management).
- **The app is gone after a power cut during an update** (macOS, Linux): the old version is in the hidden folder
  `.mcp-for-novelai-update-…/old` next to where the app was; rename it back (for example to `MCP for NovelAI.app`), or
  install the release by hand.

## Logs

Settings › Storage & backup › Logs: "Write a log" is on by default and writes `app.log` to the `logs` folder of the data
folder (you can choose another folder). The page has buttons to open the log file and its folder. Logs and bug
reports never need your token; do not paste it anywhere.
