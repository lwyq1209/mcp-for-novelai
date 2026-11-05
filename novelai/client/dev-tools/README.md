# Dev tools

Reusable tools for implementing and reviewing MCP for NovelAI against a **real, windowed, isolated test client** of
this checkout — without the daily client, its data, a real token or real (paid) generation. Every entry is a plain
`node <file>.mjs` command that prints one JSON object (`--help` prints its usage text instead); every `lib/` module
can be imported by scripts.

Build the client first (the tools use the built app and the MCP bundle): `npm --prefix novelai/client run build`.
Paths below are relative to `novelai/client`.

## Safety rules (enforced by the tools)

- **Explicit test data roots only.** `--data <folder>` is required. Refused: anything inside the platform's
  application-data folder or Pictures (macOS `~/Library`, `~/Pictures`; Windows `%APPDATA%`, `%LOCALAPPDATA%`,
  `~\AppData`, `~\Pictures`, `~\OneDrive\Pictures` and the Pictures folder of the registry; Linux `~/.config`,
  `~/.local/share`, `~/Pictures` and `XDG_PICTURES_DIR` of `user-dirs.dirs`, or without one the default output folder
  `~/MCP for NovelAI` that the client then uses), any `.runtime` / `.isolated` folder
  (e.g. the main repository's `novelai/.runtime`), the home folder, `/`, this checkout or its ancestors, and anything
  inside this checkout except its ignored `.tmp/` folders. Symbolic links are resolved first. A subfolder of the OS
  temp folder is always allowed. A non-empty folder must carry the marker `.dev-tools/marker.json` written by these
  tools (pass `--adopt` only for a throwaway folder).
- **Own processes only.** A test client is this checkout's `node_modules/electron` executable started with the marker
  argument `--nai-dev-tools-data=<data root>` (last on its command line). `stop` re-reads each PID's command line
  right before signalling it, sends SIGTERM (Windows: `taskkill` without `/F`; a process without a window, which
  `taskkill` cannot ask, is terminated), waits, and never uses
  `pkill`/`killall`. Other Electron processes — the daily client, other checkouts' test clients, helpers — are never
  matched. Several data roots (and several checkouts) can each run one test client at the same time.
- **No keychain, no real token.** Test clients always run with Chromium's `--use-mock-keychain`: OSCrypt uses an
  in-process fake keychain with the fixed password `mock_password` (Chromium 148 `os_crypt_mac.mm` /
  `fake_keychain_v2.mm`), so the login keychain is never read or written. With `--fake-novelai` the tools write a
  clearly fake token (`fake-dev-tools-…`) encrypted for that mock keychain (macOS). Without `--fake-novelai` the
  data root gets the official endpoints and **no token**, so a fake token never reaches NovelAI.
- **No real generation.** Point test clients at the fake service; it binds `127.0.0.1` only.

## test-client — start / stop / status

```sh
node dev-tools/test-client.mjs start --data ../../.tmp/t1 --port auto --fake-novelai http://127.0.0.1:PORT --locale zh-CN --size 1440x900 [--quiet]
node dev-tools/test-client.mjs start --data ../../.tmp/t2 --port auto --fake-novelai http://127.0.0.1:PORT --no-token --first-run   # a new user
node dev-tools/test-client.mjs start --data ../../.tmp/t3 --port auto --fake-novelai http://127.0.0.1:PORT --foreground  # the window comes to the front
node dev-tools/test-client.mjs stop --data ../../.tmp/t1          # [--timeout 20] [--force: SIGKILL a verified PID that did not exit]
node dev-tools/test-client.mjs status [--data ../../.tmp/t1]      # all test clients of this checkout (pid, data root, port, bridge)
```

`start` refuses (`already_running`, `data_root_busy`) while any process of that data root still runs: its main process,
a helper (profile `--user-data-dir=<data>`) or an app started with `NOVELAI_DATA_DIR=<data>` (MCP servers run as Node do
not count); after a stop or kill, wait until they have all exited. A client started in the background never comes to
the front, also not when a second launch reaches it (the second-instance event is ignored in background mode).
`start` runs `node_modules/electron/dist/…` on this checkout's built app with `NOVELAI_DATA_DIR=<data>`, writes
`<data>/.dev-tools/client.json` (pid) and `client.log`, and returns once `<data>/runtime/bridge.json` exists (only
its existence is checked). `--quiet` prints only `{ok, pid, port, dataRoot, bridgeReadyMs, cdpReadyMs}` (plus
`windowSizeApplied: false` and `windowSizeReason` when `--size` was not applied) instead of the full result.
**Background by default:** the window appears without activating the app or taking the focus (the client's
`NAI_DEV_TOOLS_BACKGROUND=1`: `showInactive()` instead of `show()`, and on macOS the app runs as an accessory app from
before ready, so its launch never activates it and **the test window has no Dock icon** (and no menu bar); a normal start
without the variable is unchanged), so a test run never comes in front of what you are doing; DevTools clicks, typing and
screenshots work on it as before. On macOS a background window (test-client and the `test:dev-tools` fixture window)
runs on an **agent copy of Electron**: an APFS clone of `node_modules/electron/dist/Electron.app` whose Info.plist says
`LSUIElement=1`, ad-hoc signed again, kept in `node_modules/.cache/nai-dev-tools-electron/` (not in git) and made again
when Electron changes (lib/background-app.mjs); `--foreground` uses the plain Electron. Should the app still become
active, it hides at once and logs `[dev-tools] … became the active app; it was hidden at once`. **Front-app watch**
(macOS, lib/front-watch.mjs, its own process, `lsappinfo` every 50 ms): `start` watches from before the launch until
5 s after the client is ready (so `start` takes 5 s longer), and `ui.mjs` / `mcp.mjs` watch during every command; a
test client in front fails that run with `front_detected` (its times and pid in the error; `start` also stops the
client). The start result carries `frontWatch: {hits: 0, samples, maxGapMs, from, to}`.
`--foreground` shows it the ordinary way (the result says `background: true|false`). `--agent-start` starts it the way an
agent's MCP server starts the app (`--started-by-agent=dev-tools`): its window then waits for the user (not shown on
macOS and Linux, minimized on Windows) and its page is not throttled meanwhile, so the canvas tools can be checked
against a window nobody sees (the result says `agentStart: true`). `--no-token` writes no token and no cached account (a user who has not connected NovelAI yet; with `--fake-novelai`
the endpoints still point at the fake service, so a token typed into the window is verified there). `--first-run`
leaves `hasOnboarded` false, so the app opens its first-run guide. `--port <n>|auto` opens DevTools on 127.0.0.1 (Chromium binds the debug port to loopback).
`--build` runs `npm run build` first. `--project <dir>` sets `NOVELAI_PROJECT_ROOT`. The window is kept "visible"
when other windows cover it (`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`), otherwise
DevTools wheel input stalls on a covered window; `--allow-occlusion` turns that off. Settings written to the test
data root: onboarding done, no update checks or automatic backups, optional language; with `--fake-novelai` custom
endpoints on, no fallback to the official hosts, direct connection. `--size` resizes through `window.resizeTo`; the OS
clamps it to the screen's work area (the result reports what was applied).

## ui — drive the window through DevTools

```sh
node dev-tools/ui.mjs route library --port 9333                    # library | canvas | queue | settings (clicks the top bar, then moves the pointer off it)
node dev-tools/ui.mjs click '[data-testid^="tile-"] button.lib-tile-open' --port 9333 [--nth 0] [--modifiers Meta] [--double] [--right] [--force]
node dev-tools/ui.mjs click 'button.lib-tile-open' --nth 2 --port 9333   # the THIRD visible tile: --nth counts visible matches from 0
node dev-tools/ui.mjs click-text 取消 --port 9333 --within '[role="dialog"]' [--exact]
node dev-tools/ui.mjs click-at 1260 82 --port 9333                 # a real click at fixed coordinates, whatever is there now
node dev-tools/ui.mjs type 'textarea.prompt-box' '1girl, night sky' --port 9333 [--replace | --clear] [--per-key]
node dev-tools/ui.mjs key Escape --port 9333                       # Enter, Tab, Shift+Tab, Mod+A (Meta on macOS), ArrowDown …
node dev-tools/ui.mjs wait 'text^=生成完成' --port 9333 [--timeout 10] [--state visible|attached|hidden]
node dev-tools/ui.mjs dialog-text --port 9333 [--timeout 10]       # the visible, top-most dialog: label, text, buttons
node dev-tools/ui.mjs toasts --port 9333 [--timeout 10] [--contains 生成完成]   # the toasts shown now (or wait for one)
node dev-tools/ui.mjs scroll '[data-testid^="tile-"]' --port 9333 --to-end [--delta 600]
node dev-tools/ui.mjs shot ../../.tmp/shots/a.png --port 9333
node dev-tools/ui.mjs console --port 9333 [--errors] [--wait 300]  # replays earlier messages/exceptions too
node dev-tools/ui.mjs eval 'document.title' --port 9333          # values and errors without the invisible host-error suffix
node dev-tools/ui.mjs metrics --port 9333                          # JS heap, DOM nodes, layout counts (Performance.getMetrics)
node dev-tools/ui.mjs size 1440x900 --port 9333
node dev-tools/ui.mjs --help
```

Targets are CSS selectors, `text=<exact text>` or `text^=<contained text>` (visible text, `aria-label` or `title`;
the nearest interactive ancestor is used). **`--nth n` is a 0-based index among the VISIBLE matches**: `--nth 0`
(the default) is the first visible match, `--nth 1` the second; hidden matches (display none, visibility hidden,
zero size) are not counted (`wait --state attached` counts all). Results report `matches` (visible matches) and
`nth`; an index past them fails with `not_found` and says how many there are (`--nth 2 is out of range: 2 visible
matches …`); a negative or fractional `--nth` is a usage error. Clicks are real `Input.dispatchMouseEvent` events at
the element's centre: the element is scrolled into view first, and the click is **refused** with `obscured` when
something else covers that point, or `disabled` for a disabled control (`--force` clicks anyway). `type` clicks the
field and refuses with `not_focused` when the focus did not move into it, then uses `Input.insertText` (`--per-key`
sends key events). `--replace` first selects the whole content with the real keyboard shortcut (Meta+A on macOS,
Control+A elsewhere: `Input.dispatchKeyEvent`, with the `selectAll` editing command on macOS) so the text replaces
it; `--clear` selects all and presses Backspace first. Both check that the shortcut really selected everything
(`not_selected` otherwise, nothing typed); the result reads the field's `value` back.

`dialog-text` reads the **visible, top-most** dialog (`role=dialog`, `role=alertdialog`, open `<dialog>`): the old
canvas keeps many hidden panels with `role=dialog`, so a plain `[role=dialog]` query picks the wrong one. A dialog
counts when it is rendered (not `display:none`, `visibility:hidden`, opacity 0, zero size or off-screen) and one of
five points inside it hit-tests to it rather than to a backdrop, the page or another dialog over it. Several on top:
an inner dialog before the one containing it, then the one painted above where they overlap, then modal ones, then
the later one in the document. The result has `dialog` (`label` from aria-label/labelledby/heading, `modal`,
`text` and `lines` from `innerText`, `buttons` with `disabled`, `rect`), `others` (further dialogs on top),
`covered` (visible but under something) and `counts`; it waits up to `--timeout` (10 s) and fails with `no_dialog`.
`toasts` lists the frame's toasts (`.ui-toast`, oldest first: `text`, `tone` ok/warn/danger/neutral, `role`,
`action`); without options it reads them once (an empty list is not an error); `--timeout` waits for one,
`--contains <text>` waits (10 s by default) for one whose text contains it, else `no_toast`. Toasts disappear after
about 4.5 s, so start waiting before (or right after) the action that shows one.

Every session emulates page focus (`Emulation.setFocusEmulationEnabled`), so focus behaviour does not depend on
which app is frontmost. As a library: `import { connectPage, dialogText, toasts } from './lib/cdp.mjs'` →
`page.route/click/clickText/hover/type/key/wait/dialogText/toasts/scroll/screenshot/captureConsole/consoleEntries/metrics/evaluate`
(`dialogText(page, { timeoutMs })` and `toasts(page, { timeoutMs, contains })` are the same as the methods).

## fake-novelai — local NovelAI stand-in

```sh
node dev-tools/fake-novelai.mjs start --dir ../../.tmp/fake1 [--fault generation:1:500] [--delay 250] [--stream-steps 3] [--price 0] [--anlas 10000] [--quiet]
node dev-tools/fake-novelai.mjs requests --url http://127.0.0.1:PORT [--since 12] [--endpoint generate-image] [--class generation]
node dev-tools/fake-novelai.mjs fault --url http://127.0.0.1:PORT --match generation --nth 2 --kind 429 [--times 1]
node dev-tools/fake-novelai.mjs fault --url http://127.0.0.1:PORT --match generation --kind 500 --body 'Upstream GPU melted' [--content-type text/html]
node dev-tools/fake-novelai.mjs fault --url http://127.0.0.1:PORT --match generate --kind 400 --json '{"statusCode":400,"message":"prompt rejected"}' [--header 'X-Request-Id: 1']
node dev-tools/fake-novelai.mjs respond --url http://127.0.0.1:PORT --match account --json '{"subscription":{"tier":3,"active":true,"trainingStepsLeft":{"fixedTrainingStepsLeft":777,"purchasedTrainingSteps":0}}}'
node dev-tools/fake-novelai.mjs faults --url http://127.0.0.1:PORT [--clear]
node dev-tools/fake-novelai.mjs clear --url http://127.0.0.1:PORT [--faults]
node dev-tools/fake-novelai.mjs stop --dir ../../.tmp/fake1        # serve = the same in the foreground
```

Routes (as `electron/ipc/nai.ts` calls them): `GET /user/data` (Opus account, balance), `POST /ai/generate-image`
(t2i / img2img / infill / enhance; JSON or multipart; ZIP of `n_samples` PNGs at the requested size),
`POST /ai/generate-image-stream` (framed MessagePack like the official service, `--stream-format sse` for SSE;
intermediate previews then the final image), `POST /ai/generate-image/request-price`, `POST /ai/upscale` (2× the
source), `POST /ai/augment-image` (Director, the given size), `POST /ai/encode-vibe`, `GET /ai/generate-image/suggest-tags`.
Images are placeholder PNGs (gradient and blocks from the seed) with a `Comment` text chunk describing the request.
Every request is logged (`requests`): endpoint, classes, whether the fake token was sent (`auth`) and which token
(`authHash`: the first 8 hex digits of its SHA-256, never the token), content type, the JSON body
with base64 fields summarized (length, sha256 prefix, image size), multipart parts, the response status/kind/size.

Faults: `<match>:<nth>:<kind>[:<times>]`. `match` is `any`, a class (`generation` = generate-image, stream, upscale,
augment-image; `generate` = generate-image + stream; `stream`; `paid` = generation + encode-vibe; `account`; `price`),
an endpoint name, or a path (`/user/data`). `nth` counts matching requests from when the rule was added (1 = next);
`kind` is a status code (`500`, `429` with `retry-after`, `402`, `401` …), `hang` (never answers; `POST /__fake/release`
drops it), `reset` (connection dropped after the request), `bad-zip`, `bad-image` (ZIP with an undecodable PNG),
`empty-zip`, `stream-cut` (stream ends after one frame / half a ZIP), `stream-error` (error frame) or `delay=<ms>`.
`times` may be `always` (every matching request from the `nth` on).

Custom responses: a status fault may carry its **own response body**, to test how upstream text reaches the
client's error messages — `--body <text>` (sent as is, default `text/plain; charset=utf-8`), `--json <json>`
(checked, sent as `application/json`) or `--body-file <file>` (`.json` → application/json, `.html` → text/html,
else text/plain), `--content-type <type>` to override, `--header 'Name: value'` (repeatable; `content-type`,
`content-length` and connection headers are the service's own) and `--delay <ms>` before answering. Without a body
a status fault answers `{statusCode, message}` as before (429 also sends `retry-after: 1`). `respond` adds a
**fixed custom answer** for a class of requests — any status 200–599 (default 200) with such a body, by default for
every matching request (`--times always`; `--nth`/`--times n` work as for faults), e.g. the account route with a
chosen balance or a request-price answer. Rules apply in the order they were added (the first matching rule whose
window covers a request answers it; `faults --clear` removes them). The same rules as JSON, for `--fault` on
`start`/`serve`, the control route and `startFakeNovelAI({ faults })`:
`{"match":"generation","nth":1,"kind":500,"body":"upstream text","contentType":"text/plain"}`,
`{"match":"account","kind":"respond","json":{…},"times":"always"}` (fields: `match nth times kind status body json
contentType headers delayMs`). The request log marks them `fault:<status>` / `respond:<status>` with `custom: true`.
`start --quiet` prints only `{ok, url, port, pid, faults}`.

Control routes for scripts in other processes: `/__fake/health|requests|faults|reset|config|release`
(`fakeNovelAIControl(url)`); in-process: `startFakeNovelAI(options)` from `lib/fake-novelai-server.mjs`.

## seed-library — sample library in a new, empty data root

```sh
node dev-tools/seed-library.mjs --data ../../.tmp/lib10k --history 10000 [--trash 30] [--tags 40] [--imports 12] [--image-scale 8] [--quiet]
```

`--quiet` prints only `{ok, dataRoot, counts, totalMs}` instead of the full report (projects, collections, phase
timings, sizes).

Built with the client's compiled repository (`dist-electron/electron/library/repository.js`), in place at the final
data root: history images over `--days` (120) with all six modes, six models, six projects (history groups, named
through `putCollection` before items join them), ~5 % archived, ~30 % agent-sourced (generationOrigin/queueOrigin),
some with two continuous revisions and custom tags; tags (most with covers), combos, notes, style/positive presets,
prompt chunks, reference presets, artist favourites, user collections and imported images (studies with previews);
optional Recently Deleted entries through the client's own trash module. Every record passes
`validateLibraryPayload` (history also `validateGeneratedHistoryPayload`), and `integrityCheck()` must be `ok`.
Image files are `1/--image-scale` placeholders of the recorded size. 10 000 images take about 9 s (see the report).

## mcp — call the bundled MCP server of a test data root

```sh
node dev-tools/mcp.mjs tools --data ../../.tmp/t1 [--names]
node dev-tools/mcp.mjs call list_queue '{}' --data ../../.tmp/t1 [--project <dir>] [--client-name claude-code]
```

Runs `dist-mcp/novelai-mcp.mjs` with this checkout's Electron as Node (`ELECTRON_RUN_AS_NODE=1`) and the data root's
`NOVELAI_DATA_DIR`, always with `NOVELAI_MCP_AUTOSTART=0`: it never starts an app by itself (without a running test
client a call answers `unavailable`, `details.autostart: "off"`); start the test client with `test-client.mjs`.
Library: `connectMcp({ data, project, clientName })` → `{ tools(), call(name, args), close() }` from
`lib/mcp-client.mjs`.

## Examples

- `node dev-tools/examples/smoke.mjs [--keep]` — fake service → small seeded library → test client → library
  (detail, select two, delete confirmation **cancelled**) → one canvas Generate through the fake service → result
  on the canvas → queue page → MCP reads the same batch → screenshots → everything stopped.
- `node dev-tools/examples/fault-injection.mjs [--fault generation:1:500] [--keep]` — the first generation request
  fails; an agent enqueues two batches; the second is paused by the queue's stop protection (`queue_halted`, shown
  on the queue page) without sending anything; the agent then resumes it.
- `node dev-tools/examples/library-scroll.mjs --data <seeded root> [--shots <folder>] [--delta 1200]` — performance:
  start, first tile, wheel-scroll the library to the end; the renderer's DOM nodes, JS heap and memory every 50 steps,
  at the end and again after a full garbage collection; page errors.
- `node dev-tools/examples/library-browse.mjs --data <seeded root> [--arrows 50] [--filters mode,date,source,archived,combined] [--shots <folder>]`
  — browsing: wheel-scroll to the middle of the library, open the image there, press → N times in the drawer (time per
  step, whether the grid follows), close it with Esc (where the focus and the scroll position end up), then time each
  filter (set, then back to 全部) until the count and the tiles stop changing. Measures only; nothing is written.

The library grid is virtual (only the rows near the view are rendered, `src/library/VirtualGrid.tsx`): a tile scrolled
past is no longer in the DOM. Scroll the library's scroll container `.lib-scroll` (e.g. `ui.mjs scroll '.lib-scroll'`,
or wheel events over its middle), not a tile, which may leave the DOM after the first step; find tiles again after each
scroll; `[data-testid="library-grid"]` carries `data-total` (items loaded) and every tile/card `data-key` and
`data-index` (its place in the view's order).

Output goes under `.tmp/dev-tools-examples/` of the worktree (screenshots, kept data with `--keep`).

## Tests

`npm --prefix novelai/client run test:dev-tools` (node:test): data-root guard, process identification and selective
stop (stand-in processes), mock-keychain token (known answer), test settings, the fake service protocol (decoded
with the client's own stream decoder and JSZip), every fault kind and custom response bodies, placeholder images and
ZIPs, key parsing, seeding, `--quiet`/`--help`, CLI refusals, and the DevTools driver (`--nth`, `dialog-text`,
`toasts`, `type --replace/--clear`) against a **hidden Electron window** (`tests/fixtures/window-host.cjs`: this
checkout's Electron with `--use-mock-keychain`, every Electron path inside the test's temp folder, no client and no
app data; those tests are skipped where Electron cannot start). They start no client window.

Every folder the tests create is under the OS temp folder with the prefix `nai-devtools-test-`, registered by
`tests/helpers.mjs` and removed by its test (and once more when the test process exits). `tests/temp-cleanup.test.mjs`
runs all other test files again with an empty temp folder (`TMPDIR`/`TMP`/`TEMP`) and fails if anything is left
in it. One entry is not the tests': `npm run` itself (npm ≥ 10.9 calls `module.enableCompileCache()` in its
`lib/cli.js`) creates and then reuses `<temp>/node-compile-cache` for npm's own modules. To leave the temp folder
untouched, run `node --test "dev-tools/tests/*.test.mjs"` in `novelai/client`, or set
`NODE_DISABLE_COMPILE_CACHE=1` for `npm run test:dev-tools`.

## Known limitations

- The window size is clamped to the screen's work area (`--size 1440x900` gives 1440×~890 on a 900-px-high work area).
- Windows/Linux are untested. Without macOS's mock keychain the fake token cannot be pre-written: with `--port`,
  `start` lets the app verify and save it (DPAPI on Windows) through its own `verifyToken` path.
- There is no renderer routing hook: `route` clicks the top bar (Chinese or English labels).
- `console` sees what V8 replays (recent messages and exceptions) plus what happens while connected.
