---
name: novelai-cli
description: Drive MCP for NovelAI from a terminal with its `nai` command line — tag lookups, the library, imported images, recipes, the generation queue and the live canvas — when the novelai MCP tools are not loaded, or when long prompts, large JSON answers or images are easier to handle as local files.
---

# MCP for NovelAI from the terminal (`nai`)

`nai` ships inside the MCP for NovelAI app (`<app resources>/bin/nai`, `nai.cmd` on Windows; `novelai/client/bin/nai`
in a built source checkout) and runs the same tools as the `novelai` MCP server, with the same checks and answers.

## First use in a session

Run `nai skill` once and follow it: it prints the guide that matches the installed version (folders and inboxes, the
recipe-file workflow, request keys and waiting, image files, exit codes, every command). Options of one command:
`nai <command> --help`. Both work offline and start nothing.

## Working rules

- Stdout is one JSON document; exit 0 means success. On failure stdout is `{"ok":false,"error":{code,message}}`:
  exit 1 is the tool's own error, 2 a local usage or input problem (nothing was sent), 3 an output file that could not
  be written after the call succeeded (its `result` says what was done), 130 an interruption. Files nai writes are
  reported by absolute path; tool paths with `pathBase: "project-root"` are relative to the project root.
- Keep long prompts in files: `nai asset recipe <historyId> -o draft.json`, edit the file, `nai prepare -f draft.json
  -o prepared.json`, then `nai enqueue -f prepared.json --key <key> --wait done`. Read the summary's `warnings`;
  records keep no reference images; upscale and Director images have no recipe (`recipe_not_reproducible`).
- Only `nai enqueue` generates, and it costs Anlas: run it for images the user asked for. Repeat an uncertain enqueue,
  or one interrupted before it answered, with the identical command and the same `--key`; a new key is a new paid
  request. Interrupted while waiting, follow the batch with `nai queue read <batchId> --wait done`.
- Images are written to files (`savedImages`, default `<project root>/.tmp/nai-cli/`); open those files to look at them.
  Local files to import go straight to `nai study import <file>…` (nai copies them into the inbox).
- `unavailable` means the app is not running and could not be started (`details.autostart` says why): ask the user to
  open the app. `nai env` shows the data folder, the project root and whether nai can start the app.
- Anything without its own command: `nai tools <tool>` shows the schema, `nai call <tool> @args.json` runs it.
- If `nai` itself is missing or fails to start, report its output as it is; do not substitute another build.
