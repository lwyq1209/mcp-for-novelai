# Troubleshooting

Tool errors come back as `{error: {code, message, details?}}` (see [MCP tools](mcp-tools.md#errors)); the message says
what to do next. This page explains the codes and situations people ask about most.

- [The agent cannot reach the app (`unavailable`)](#the-agent-cannot-reach-the-app-unavailable)
- [`host_outdated`](#host_outdated)
- [Settings › MCP access shows a warning](#settings--mcp-access-shows-a-warning)
- [Timeouts and unknown outcomes](#timeouts-and-unknown-outcomes)
- [Refused enqueues](#refused-enqueues)
- [Paused batches (`queue_halted` and other stop reasons)](#paused-batches-queue_halted-and-other-stop-reasons)
- [Cleaned batch records damaged or missing](#cleaned-batch-records-damaged-or-missing)
- [Queue storage errors](#queue-storage-errors)
- [NovelAI refuses a request](#novelai-refuses-a-request)
- [Files in the inboxes](#files-in-the-inboxes)
- [Opening the app the first time](#opening-the-app-the-first-time)
- [Linux: the app does not start](#linux-the-app-does-not-start)
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
- `recently_started` — this server started the app less than a minute ago and it closed again; it does not start it
  again so soon. Open it yourself or call again later.
- No `details.autostart` — the connection dropped after the request was sent: the call may or may not have reached the
  app and is never sent again automatically (see the next points).

Also:

- Make sure the agent starts the server with the configuration from **Settings › MCP access** of the app you are
  running: it names the app's data folder as `NOVELAI_DATA_DIR`. A server started for another data folder (another
  install, a test folder, a build from source with `--data-dir`) looks for (and starts) a different app.
- After `unavailable` in the middle of a write (an enqueue, a save), read the current state before doing anything
  again: the write may or may not have happened. For enqueues, use `lookup_enqueue` with the same request key.
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
- When the agent's own client times out, the server may still have finished the enqueue. Look at the queue page, or
  call `lookup_enqueue` with the same request key. Never resend under a new key while an outcome is still settling
  (see [Request keys](mcp-tools.md#request-keys-and-paid-requests)).

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

## Paused batches (`queue_halted` and other stop reasons)

When an image fails or its outcome is unknown, the queue pauses the agent batches after it before they send anything
(`stopReason.code: "queue_halted"`), so a run of failures does not keep spending. Failed and unknown images are never
resent. Check the failed batch (the queue page, or `read_queue`) and the library, then resume the paused batches on the
queue page (the app asks you to confirm, because resuming lifts the protection) or ask the agent to
`control_queue {action: "resume"}`. After a restart, batches that had not finished wait paused for an explicit resume
(`recovered_paused`); one whose running image had an unknown outcome cannot be resumed (`restart_unconfirmed`).
[MCP tools](mcp-tools.md#queue-limits-and-stop-protection) lists every stop reason.

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
  are refused until it is fixed. The log (see [Logs](#logs)) names the cause.
- `queue_acceptance_unknown` — the request key has a receipt, but the frozen queue cannot be read right now, so its
  batch may already exist. Do not resend and do not switch keys; fix the app first (restarting it is your decision),
  then look up the same key again.
- `queue_storage_failed` for other reasons (for example a full recipe store) — read the message; nothing was saved.

## NovelAI refuses a request

- **Authentication failed (401/403)** — paste and verify your Persistent API Token again in Settings › Account &
  network, and check that the image API is `https://image.novelai.net` (Custom API address is off by default).
- **Not enough Anlas or subscription (402)** — check your balance and subscription on NovelAI.
- **Too many requests (429) or a server error** — the batch stops; later agent batches pause (`queue_halted`).
  Wait, then resume on the queue page.
- **"Set up your NovelAI API token in Settings first"** — the app has no token yet (Settings › Account & network).

## Files in the inboxes

`file_unavailable` means an inbox or export folder, or the named file, is missing or not allowed. Inbox inputs are plain
file names (no paths, URLs or symbolic links) of ordinary single-link files directly inside `novelai/library-inbox` or
`novelai/study-inbox` under the project root (see [Files](mcp-tools.md#files-inboxes-and-exports)). Settings › MCP
access › Advanced shows where the inboxes are now.

## Opening the app the first time

- **macOS: "Apple could not verify …" / the app does not open.** Builds are ad-hoc signed and not notarized. Open the
  app once, then go to **System Settings › Privacy & Security**, scroll to Security and click **Open Anyway** (it is
  offered for about an hour after the attempt), then confirm with your password. Control-click › Open no longer skips
  this check on current macOS.
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

## Logs

Settings › Storage & backup › Logs: "Write a log" is on by default and writes `app.log` to the `logs` folder of the data
folder (you can choose another folder). The page has buttons to open the log file and its folder. Logs and bug
reports never need your token; do not paste it anywhere.
