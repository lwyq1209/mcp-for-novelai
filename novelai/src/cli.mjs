#!/usr/bin/env node
/**
 * `nai`: the command line of MCP for NovelAI, for agents that work in a terminal. Every command runs the MCP server's
 * own tools (src/cli-run.mjs: an in-memory MCP client of createNovelAiMcpServer), prints one JSON document on stdout
 * and exits with a code of src/cli-spec.mjs EXIT. Images are written to files, never printed.
 *
 * Order matters here: the arguments are parsed and the data folder and project root decided (src/cli-env.mjs) before
 * any business module is imported, because those modules read NOVELAI_DATA_DIR / NOVELAI_PROJECT_ROOT when they load.
 * `--help`, `--version`, `help` and `skill` stop before that: they read and start nothing.
 *
 * Shipped as resources/mcp/novelai-cli.mjs (client/dist-mcp/novelai-cli.mjs in a build) and started by the launcher
 * resources/bin/nai (nai.cmd on Windows) with the app's own executable as Node (ELECTRON_RUN_AS_NODE=1), which is what
 * lets it start the app in the background when it is not running (src/app-autostart.mjs). `node novelai/src/cli.mjs`
 * runs it from source with your own Node; it then never starts the app.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliUsageError, EXIT, helpText, parseCommandLine } from './cli-spec.mjs';
import { CliEnvironmentError, applyCliEnvironment, resolveCliEnvironment } from './cli-env.mjs';
import { skillGuide } from './cli-guide.mjs';
import { VERSION } from './version.mjs';

/** Set before src/mcp.mjs loads: it then starts no stdio server of its own, also inside the one-file bundle. */
export const EMBEDDED_MARKER = Symbol.for('novelai.mcp.embedded');

const failureOutput = (code, message, extra = {}) => ({ ok: false, error: { code, message }, ...extra });
const INTERRUPTED = {
  enqueue: 'Interrupted before the enqueue answered: it may or may not have reached the app. Run the same command again with the same --key (it is never queued twice), never with a new key.',
  waiting: batchId => `The enqueue was accepted (see enqueue); only the wait was interrupted. Follow the batch with nai queue read ${batchId ?? '<batchId>'} --wait done; do not enqueue again.`,
  other: 'Interrupted before the answer arrived. A change may or may not have been made: read the current state before any further write.',
};

/**
 * Runs nai with `argv` (the words after the executable and script). `io`: {stdout(text), env, cwd}. Resolves the
 * exit code. Exported for tests; the module runs it itself when it is the started script.
 */
export async function main(argv, io = {}) {
  const write = io.stdout ?? (text => { try { process.stdout.write(text); } catch { /* a closed pipe */ } });
  let pretty = false;
  const print = value => write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
  // Every failure, also one outside a command (a deleted working directory, a defect), is one JSON document, exit 4.
  try { return await run(argv, io, write, print, value => { pretty = value; }); }
  catch (error) { print(failureOutput('internal_error', `nai failed unexpectedly: ${error?.message ?? error}`)); return EXIT.internal; }
}

async function run(argv, io, write, print, setPretty) {
  const env = io.env ?? process.env;
  let parsed;
  try { parsed = parseCommandLine(argv); }
  catch (error) {
    if (error instanceof CliUsageError) { print(failureOutput(error.code, error.message)); return EXIT.usage; }
    throw error;
  }
  setPretty(parsed.global.pretty === true);
  const word = parsed.command?.path.join(' ');
  // Offline answers: nothing below this is loaded for them.
  if (parsed.global.version || word === 'version') { write(`${VERSION}\n`); return EXIT.ok; }
  if (parsed.global.help || !parsed.command || word === 'help') {
    try { write(helpText(word === 'help' ? parsed.positionals.command ?? [] : parsed.command?.path ?? (parsed.group ? [parsed.group] : []))); return EXIT.ok; }
    catch (error) { if (error instanceof CliUsageError) { print(failureOutput(error.code, error.message)); return EXIT.usage; } throw error; }
  }
  if (word === 'skill') { write(skillGuide()); return EXIT.ok; }

  // Only commands that work with files need the working directory (the offline answers above never look at it).
  let cwd;
  try { cwd = io.cwd ?? process.cwd(); }
  catch { print(failureOutput('cwd_unavailable', 'The working directory is gone (deleted or unreadable): cd into an existing folder and run nai again. Nothing was sent.')); return EXIT.internal; }

  let resolved;
  try { resolved = resolveCliEnvironment({ global: parsed.global, env, cwd }); }
  catch (error) {
    if (error instanceof CliEnvironmentError) { print(failureOutput(error.code, error.message)); return EXIT.usage; }
    throw error;
  }
  applyCliEnvironment(resolved, env);
  globalThis[EMBEDDED_MARKER] = true;

  const controller = new AbortController();
  let stopped = null;
  const stop = signal => () => {
    if (stopped) process.exit(signal === 'SIGINT' ? EXIT.interrupted : EXIT.terminated);
    stopped = signal; controller.abort(new Error(`nai was stopped (${signal}).`));
  };
  const onInt = stop('SIGINT'), onTerm = stop('SIGTERM');
  // The process's signals (tests may give their own emitter).
  const signals = io.signals === false ? null : io.signals ?? process;
  signals?.on('SIGINT', onInt); signals?.on('SIGTERM', onTerm);
  try {
    const { runCommand, ToolFailure, OutputFailure } = await import('./cli-run.mjs');
    const { CliFileError } = await import('./cli-files.mjs');
    // nai's own messages name local files as the caller gave them (tool answers keep the server's scrubbed envelope).
    const local = (code, message, extra) => failureOutput(code, String(message), extra);
    const progress = {};
    try {
      const { exit, output } = await runCommand(parsed, { io: { cwd, env, signal: controller.signal, progress }, resolved, ...(io.runOptions ?? {}) });
      print(output);
      return exit;
    } catch (error) {
      const enqueue = progress.enqueue ?? error?.context?.enqueue;
      const extra = enqueue ? { enqueue } : {};
      if (controller.signal.aborted) {
        const message = progress.stage === 'enqueued' ? INTERRUPTED.waiting(enqueue?.batchId) : progress.stage === 'enqueue' ? INTERRUPTED.enqueue : INTERRUPTED.other;
        print(failureOutput('interrupted', message, extra));
        return stopped === 'SIGTERM' ? EXIT.terminated : EXIT.interrupted;
      }
      if (error instanceof ToolFailure) { print({ ok: false, error: error.error, ...extra }); return EXIT.toolError; }
      if (error instanceof OutputFailure) { print({ ok: false, error: { ...error.error, stage: 'output' }, result: error.result }); return EXIT.output; }
      if (error instanceof CliUsageError || error instanceof CliFileError) {
        print(local(error.code, error.message));
        return error.exit === 'output' ? EXIT.output : EXIT.usage;
      }
      print(local('internal_error', `nai failed unexpectedly: ${error?.message ?? error}`, extra));
      return EXIT.internal;
    }
  } finally {
    signals?.off('SIGINT', onInt); signals?.off('SIGTERM', onTerm);
  }
}

/** True when this file (or the one-file bundle made from it) is the started script; real paths, so a link works too. */
function isMainModule() {
  if (!process.argv[1]) return false;
  const real = file => { try { return realpathSync(file); } catch { try { return resolve(file); } catch { return file; } } };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  // A reader that closed the pipe early (`nai … | head`) is not an error of nai.
  process.stdout.on('error', error => { if (error?.code === 'EPIPE') process.exit(process.exitCode ?? 0); });
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // Leave once everything written to stdout is flushed (writes complete in order; a pipe may be asynchronous), without
  // waiting for idle keep-alive connections of the tag lookups.
  process.stdout.write('', () => process.exit(code));
}
