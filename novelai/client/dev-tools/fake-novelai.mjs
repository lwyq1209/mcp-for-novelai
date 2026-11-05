#!/usr/bin/env node
// Fake NovelAI service on 127.0.0.1 (see lib/fake-novelai-server.mjs).
//   node dev-tools/fake-novelai.mjs serve [--port 0] [--fault <rule>]… [--delay <ms>] [--stream-steps <n>]
//                                          [--stream-format msgpack|sse] [--price <n>] [--anlas <n>]
//   node dev-tools/fake-novelai.mjs start --dir <state dir> [same options] [--quiet]   (background; prints {url, pid})
//   node dev-tools/fake-novelai.mjs stop --dir <state dir>
//   node dev-tools/fake-novelai.mjs requests --url <url> [--since <seq>] [--endpoint <name>] [--class <class>]
//   node dev-tools/fake-novelai.mjs clear --url <url> [--faults]
//   node dev-tools/fake-novelai.mjs fault --url <url> --match <m> [--nth 1] --kind <500|429|402|respond|hang|reset|…>
//        [--times 1|always] [--body '<text>' | --json '<json>' | --body-file <file>] [--content-type <type>]
//        [--header 'Name: value']… [--delay <ms>]
//   node dev-tools/fake-novelai.mjs respond --url <url> --match <m> [--status 200] (--json '<json>' | --body '<text>'
//        | --body-file <file>) [--content-type <type>] [--header 'Name: value']… [--nth 1] [--times always] [--delay <ms>]
//   node dev-tools/fake-novelai.mjs faults --url <url> [--clear]
//   node dev-tools/fake-novelai.mjs --help
// A --fault rule is "<match>:<nth>:<kind>[:<times>]" or a JSON rule such as
//   '{"match":"generation","kind":500,"body":"upstream says no","contentType":"text/plain"}'.
// --body sends the text as is (default text/plain; charset=utf-8); --json checks and sends JSON (application/json);
// --body-file reads a file (application/json for .json, text/html for .html, else text/plain). A status fault
// without a body answers {statusCode, message}. respond = a fixed custom answer (default every matching request).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, pick, pollUntil, printJson, printUsage, runCli, sleep } from './lib/cli.mjs';
import { fakeNovelAIControl, parseFault, startFakeNovelAI } from './lib/fake-novelai-server.mjs';
import { alive, commandOf } from './lib/processes.mjs';
import { dataRootRefusal } from './lib/guard.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SERVE_OPTIONS = ['port', 'fault', 'delay', 'stream-steps', 'step-delay', 'stream-format', 'price', 'anlas', 'charge', 'tier', 'state'];
const STATE_FILE = 'fake-novelai.json';

function serviceOptions(options) {
  const number = key => options[key] === undefined ? undefined : Number(options[key]);
  const port = number('port') ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ToolError('usage', '--port must be 0–65535.');
  if (options['stream-format'] !== undefined && !['msgpack', 'sse'].includes(options['stream-format'])) throw new ToolError('usage', '--stream-format is msgpack or sse.');
  return {
    port, delayMs: number('delay'), streamSteps: number('stream-steps'), stepDelayMs: number('step-delay'), streamFormat: options['stream-format'],
    price: number('price'), anlas: number('anlas'), chargePerImage: number('charge'), tier: number('tier'),
    faults: (options.fault ?? []).map(value => { try { return parseFault(value); } catch (error) { throw new ToolError('usage', error.message); } }),
  };
}

async function serve(options) {
  allowOptions(options, SERVE_OPTIONS);
  const service = await startFakeNovelAI(serviceOptions(options));
  const info = { ok: true, url: service.url, port: service.port, pid: process.pid, faults: service.faults(), startedAt: new Date().toISOString(), script: SCRIPT };
  if (options.state) fs.writeFileSync(options.state, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  printJson(info);
  const stop = async () => { await service.close(); if (options.state) fs.rmSync(options.state, { force: true }); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  // Stays up until signalled.
  await new Promise(() => {});
}

function stateDir(options) {
  if (!options.dir || options.dir === true) throw new ToolError('usage', '--dir <state folder> is required.');
  const dir = path.resolve(String(options.dir));
  const refusal = dataRootRefusal(dir);
  if (refusal) throw new ToolError('refused_location', refusal);
  return dir;
}

const isOurService = (pid, stateFile) => { const command = commandOf(pid); return Boolean(command && command.includes(SCRIPT) && command.includes(stateFile)); };

async function startDetached(options) {
  allowOptions(options, [...SERVE_OPTIONS.filter(key => key !== 'state'), 'dir', 'quiet']);
  const dir = stateDir(options);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(dir, STATE_FILE);
  const previous = readState(stateFile);
  if (previous?.pid && alive(previous.pid) && isOurService(previous.pid, stateFile)) throw new ToolError('already_running', `A fake service already runs for ${dir} (PID ${previous.pid}, ${previous.url}).`, previous);
  fs.rmSync(stateFile, { force: true });
  serviceOptions(options); // validate before spawning
  const args = [SCRIPT, 'serve', '--state', stateFile];
  for (const key of SERVE_OPTIONS.filter(name => name !== 'state' && name !== 'fault')) if (options[key] !== undefined) args.push(`--${key}`, String(options[key]));
  for (const fault of options.fault ?? []) args.push('--fault', String(fault));
  const log = fs.openSync(path.join(dir, 'fake-novelai.log'), 'a');
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true });
  fs.closeSync(log);
  child.unref();
  const state = await pollUntil(() => readState(stateFile), { timeoutMs: 10_000 });
  if (!state) throw new ToolError('start_failed', 'The fake service did not start.', { log: path.join(dir, 'fake-novelai.log') });
  if (options.quiet) return { ...pick(state, ['ok', 'url', 'port', 'pid']), faults: state.faults?.length ?? 0 };
  return { ...state, stateFile };
}

function readState(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

async function stopDetached(options) {
  allowOptions(options, ['dir']);
  const dir = stateDir(options);
  const stateFile = path.join(dir, STATE_FILE);
  const state = readState(stateFile);
  if (!state?.pid) return { ok: true, stopped: false, reason: 'no state file (not running)' };
  if (!alive(state.pid)) { fs.rmSync(stateFile, { force: true }); return { ok: true, stopped: false, reason: 'not running' }; }
  if (!isOurService(state.pid, stateFile)) throw new ToolError('refused_not_ours', `PID ${state.pid} is not this fake service; left alone.`);
  process.kill(state.pid, 'SIGTERM');
  const gone = await pollUntil(() => !alive(state.pid), { timeoutMs: 10_000 });
  return { ok: Boolean(gone), stopped: Boolean(gone), pid: state.pid };
}

function control(options) {
  if (!options.url || options.url === true) throw new ToolError('usage', '--url <fake service url> is required.');
  const url = new URL(String(options.url));
  if (url.hostname !== '127.0.0.1') throw new ToolError('usage', 'The fake service runs on 127.0.0.1.');
  return fakeNovelAIControl(url.origin);
}

const BODY_TYPES = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8' };

/** A fault (or fixed respond) rule from the command-line options, checked by parseFault before anything is sent. */
export function ruleFromOptions(command, options) {
  const sources = ['body', 'json', 'body-file'].filter(key => options[key] !== undefined);
  if (sources.length > 1) throw new ToolError('usage', 'Give one of --body, --json or --body-file.');
  if (command === 'respond' && options.kind !== undefined) throw new ToolError('usage', 'respond takes --status, not --kind.');
  if (command === 'fault' && options.kind === undefined) throw new ToolError('usage', 'fault needs --kind (a status code such as 500, respond, hang, reset, …).');
  if (!options.match || options.match === true) throw new ToolError('usage', '--match is required (any, a class such as generation or account, an endpoint name or a path).');
  const rule = { match: String(options.match), nth: options.nth === undefined ? 1 : Number(options.nth) };
  if (command === 'respond') { rule.kind = 'respond'; rule.times = options.times ?? 'always'; if (options.status !== undefined) rule.status = Number(options.status); }
  else { rule.kind = String(options.kind); rule.times = options.times ?? 1; if (options.status !== undefined) rule.status = Number(options.status); }
  if (options.delay !== undefined) rule.delayMs = Number(options.delay);
  if (options.body !== undefined) rule.body = String(options.body);
  if (options.json !== undefined) {
    try { rule.json = JSON.parse(String(options.json)); } catch (error) { throw new ToolError('usage', `--json does not parse: ${error.message}`); }
  }
  if (options['body-file'] !== undefined) {
    const file = path.resolve(String(options['body-file']));
    try { rule.body = fs.readFileSync(file, 'utf8'); } catch (error) { throw new ToolError('usage', `--body-file cannot be read: ${error.message}`); }
    if (options['content-type'] === undefined) rule.contentType = BODY_TYPES[path.extname(file).toLowerCase()] ?? 'text/plain; charset=utf-8';
  }
  if (options['content-type'] !== undefined) rule.contentType = String(options['content-type']);
  if (options.header !== undefined) {
    rule.headers = {};
    for (const header of options.header) {
      const index = String(header).indexOf(':');
      if (index <= 0) throw new ToolError('usage', `--header is "Name: value" (got ${JSON.stringify(header)}).`);
      rule.headers[String(header).slice(0, index).trim()] = String(header).slice(index + 1).trim();
    }
  }
  try { return parseFault(rule); } catch (error) { throw new ToolError('usage', error.message); }
}

async function main(argv) {
  if (helpRequested(argv)) return printUsage(import.meta.url);
  const { positional, options } = parseArgs(argv, { booleans: ['faults', 'clear', 'quiet'], repeat: ['fault', 'header'] });
  const [command] = positional;
  if (command === 'serve') return serve(options);
  if (command === 'start') return startDetached(options);
  if (command === 'stop') return stopDetached(options);
  if (command === 'requests') { allowOptions(options, ['url', 'since', 'endpoint', 'class']); return { ok: true, requests: await control(options).requests({ since: options.since, endpoint: options.endpoint, class: options.class }) }; }
  if (command === 'clear') { allowOptions(options, ['url', 'faults']); await control(options).clear(options.faults === true); return { ok: true }; }
  if (command === 'fault' || command === 'respond') {
    allowOptions(options, ['url', 'match', 'nth', 'kind', 'status', 'times', 'body', 'json', 'body-file', 'content-type', 'header', 'delay']);
    const rule = ruleFromOptions(command, options);
    return { ok: true, added: await control(options).addFault(rule) };
  }
  if (command === 'faults') { allowOptions(options, ['url', 'clear']); const api = control(options); if (options.clear) await api.clearFaults(); return { ok: true, faults: await api.faults() }; }
  throw new ToolError('usage', 'Usage: fake-novelai.mjs serve|start|stop|requests|clear|fault|respond|faults (fake-novelai.mjs --help).');
}

if (isMain(import.meta.url)) await runCli(main);
export { sleep };
