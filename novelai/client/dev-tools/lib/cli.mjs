// Small shared helpers for the dev-tools command-line entries: argument parsing and one JSON result per run.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** A refusal or failure with a stable code; the CLI prints it as JSON. */
export class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Parses `cmd positional --key value --flag --key=value`. `booleans` lists flags that take no value; `repeat` lists
 * options that may be given more than once (collected into arrays). Unknown options are kept; callers check them.
 */
export function parseArgs(argv, { booleans = [], repeat = [] } = {}) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break; }
    if (!arg.startsWith('--') || arg === '-') { positional.push(arg); continue; }
    const eq = arg.indexOf('=');
    const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2));
    let value;
    if (eq >= 0) value = arg.slice(eq + 1);
    else if (booleans.includes(key)) value = true;
    else {
      value = argv[index + 1];
      if (value === undefined) throw new ToolError('usage', `Option --${key} needs a value.`);
      index++;
    }
    if (booleans.includes(key) && typeof value === 'string') value = !['0', 'false', 'no'].includes(value.toLowerCase());
    if (repeat.includes(key)) (options[key] ??= []).push(value);
    else options[key] = value;
  }
  return { positional, options };
}

/** Refuses options this command does not know (a typo must not silently fall back to a default). */
export function allowOptions(options, allowed) {
  const unknown = Object.keys(options).filter(key => !allowed.includes(key));
  if (unknown.length) throw new ToolError('usage', `Unknown option(s): ${unknown.map(key => `--${key}`).join(', ')}.`);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const EXIT = { usage: 2, refused: 3 };

/** Runs a CLI main: its resolved value is printed as JSON; a thrown error becomes {ok:false,error} with exit 1/2/3. */
export async function runCli(main) {
  try {
    const result = await main(process.argv.slice(2));
    if (result !== undefined) printJson(result);
    if (result && result.ok === false && !process.exitCode) process.exitCode = 1;
  } catch (error) {
    const code = error instanceof ToolError ? error.code : 'failed';
    printJson({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...(error?.details !== undefined ? { details: error.details } : {}) } });
    process.exitCode = EXIT[code] ?? (String(code).startsWith('refused') ? 3 : 1);
  }
}

/** Whether the arguments ask for the usage text (--help, -h or the command help). */
export function helpRequested(argv) {
  return argv.includes('--help') || argv.includes('-h') || argv[0] === 'help';
}

/**
 * The usage text of a CLI entry: its leading `//` comment block (after the shebang), which is the one place the
 * commands and options are documented in the file. Printed as plain text by `--help`.
 */
export function usageText(importMetaUrl) {
  const lines = fs.readFileSync(fileURLToPath(importMetaUrl), 'utf8').split('\n');
  const body = [];
  for (const line of lines.slice(lines[0]?.startsWith('#!') ? 1 : 0)) {
    if (!line.startsWith('//')) break;
    body.push(line.replace(/^\/\/ ?/, ''));
  }
  return `${body.join('\n')}\n`;
}

/** Prints the usage text of a CLI entry (plain text, not JSON) and returns undefined (runCli then prints nothing). */
export function printUsage(importMetaUrl) {
  process.stdout.write(usageText(importMetaUrl));
  return undefined;
}

/** The given keys of an object that are not undefined/null, in that order (for the short --quiet results). */
export function pick(value, keys) {
  return Object.fromEntries(keys.filter(key => value?.[key] !== undefined && value?.[key] !== null).map(key => [key, value[key]]));
}

/** True when this module file is the process entry (node <file>). */
export function isMain(importMetaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Polls `probe` until it returns a truthy value or the timeout passes (then returns the last value). */
export async function pollUntil(probe, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value = await probe();
  while (!value && Date.now() < deadline) {
    await sleep(intervalMs);
    value = await probe();
  }
  return value;
}
