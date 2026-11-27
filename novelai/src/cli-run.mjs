/**
 * The commands of `nai` (src/cli.mjs). Loaded only after src/cli-env.mjs wrote the data folder and project root into
 * the environment, because the modules below read them when they are imported.
 *
 * Every command is a client of the MCP server itself: createNovelAiMcpServer (src/mcp.mjs) connected over an in-memory
 * MCP transport, so a call runs the registry's precheck, schema and validation, the tool's host-call scope with its
 * fixed host methods, the compact results, the project-root note and the scrubbed error envelope exactly as an MCP
 * client's call does; nothing here talks to the app directly. The client names itself in initialize as nai-cli (or
 * NOVELAI_CLI_CLIENT), which the app shows under Settings › MCP access like any agent.
 *
 * What nai adds lies only around the tool answers: images are written to files instead of printed (savedImages),
 * recipe files are read and written locally, and `enqueue --wait` reads the batch with read_queue after a successful
 * enqueue.
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createNovelAiMcpServer } from './mcp.mjs';
import { PROJECT_ROOT, callerClient } from './business-guards.mjs';
import { projectDirectories, resolveDataPaths } from './data-paths.mjs';
import { resolveOwnApp } from './app-launch.mjs';
import { autostartPolicy } from './app-autostart.mjs';
import { QUEUE_WAIT } from './queue-control.mjs';
import { MATERIAL_EXPORTS, MATERIAL_INBOX } from './material-tools.mjs';
import { STUDY_EXPORTS, STUDY_INBOX } from './study-tools.mjs';
import { VERSION } from './version.mjs';
import { CliUsageError, EXIT } from './cli-spec.mjs';
import { CliFileError, jsonFileText, readJsonArgument, readJsonFile, sameFile, saveImages, shown, stageIntoInbox, writeOutputFile } from './cli-files.mjs';
import { REFERENCES_NOTE, RecipeExtractionError, RecipeReferenceError, enqueueItemFromArgument, enqueueItemsFromFile, historyToRecipe, madeWith, parseSetValue, preparedReceipt, recipeSummary } from './cli-recipe.mjs';

export const CLI_CLIENT_ENV = 'NOVELAI_CLI_CLIENT';
export const DEFAULT_CLIENT = Object.freeze({ name: 'nai-cli', version: VERSION });
/** Longest single tool call (read_queue waits up to 1200 s; the server's own host timeouts end everything else sooner). */
export const CALL_TIMEOUT_MS = 30 * 60_000;

/**
 * The client name nai gives the server: NOVELAI_CLI_CLIENT when it is a usable name (cleaned like any MCP client's
 * name, business-guards callerClient), with version "nai-cli <version>"; else nai-cli <version>.
 */
export function cliClientInfo(env = process.env) {
  const raw = env[CLI_CLIENT_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return { ...DEFAULT_CLIENT };
  const cleaned = callerClient({ name: raw, version: `nai-cli ${VERSION}` });
  return cleaned ? { name: cleaned.name, version: cleaned.version ?? VERSION } : { ...DEFAULT_CLIENT };
}

/** An MCP session with the server in this process. `serverOptions` are createNovelAiMcpServer's (tests only). */
export async function openSession({ serverOptions = {}, clientInfo = DEFAULT_CLIENT } = {}) {
  const server = createNovelAiMcpServer(serverOptions);
  const client = new Client({ name: clientInfo.name, version: clientInfo.version ?? '' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  return {
    call: (name, args, signal) => client.callTool({ name, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS }),
    listTools: async () => (await client.listTools()).tools,
    close: async () => { await client.close().catch(() => undefined); await server.close().catch(() => undefined); },
  };
}

/** A tool's error envelope ({code, message, details?}), carried to the output. */
export class ToolFailure extends Error {
  constructor(error, context = {}) { super(error?.message ?? 'The tool failed.'); this.name = 'ToolFailure'; this.error = error; this.context = context; }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const usage = message => { throw new CliUsageError(message); };

/** The JSON of a tool result and its image blocks; a tool error becomes ToolFailure. */
function unwrap(result) {
  let value = result?.structuredContent;
  if (value === undefined) {
    const text = result?.content?.find(block => block.type === 'text')?.text;
    try { value = text === undefined ? {} : JSON.parse(text); } catch { value = { text }; }
  }
  if (result?.isError) throw new ToolFailure(record(value?.error) ? value.error : { code: 'internal_error', message: 'The tool failed.' });
  return { value, images: (result?.content ?? []).filter(block => block?.type === 'image' && typeof block.data === 'string') };
}

/**
 * Runs one parsed command. `io`: {cwd, env, signal}; `resolved`: the folders of src/cli-env.mjs; `serverOptions` and
 * `projectRoot` only for tests (an in-process server over a fake bridge). Returns {exit, output} where output is the
 * JSON value to print. `connect` opens the MCP session (tests may give a scripted one).
 */
export async function runCommand(parsed, { io = {}, resolved = {}, serverOptions = {}, projectRoot = serverOptions.projectRoot ?? PROJECT_ROOT, connect = openSession } = {}) {
  const cwd = io.cwd ?? process.cwd(), env = io.env ?? process.env, signal = io.signal;
  const key = parsed.command.path.join(' ');
  const imageDirectory = parsed.global['image-dir'] !== undefined ? path.resolve(cwd, parsed.global['image-dir']) : path.join(projectRoot, '.tmp', 'nai-cli');
  const ctx = {
    parsed, options: parsed.options, positionals: parsed.positionals, cwd, env, signal, resolved, projectRoot, imageDirectory,
    progress: io.progress ?? {}, folders: projectDirectories(projectRoot), clientInfo: cliClientInfo(env), session: null,
    // Every path nai writes itself is reported absolute (docs/cli.md): tool answers carry their own pathBase.
    shown: file => path.resolve(cwd, file),
  };
  const handler = HANDLERS[key];
  if (!handler) throw new CliUsageError(`nai ${key} cannot run here.`);
  // A file option given as an empty word (an unset shell variable) names nothing.
  for (const name of ['out', 'output', 'file', 'inbox', 'manifest']) {
    const value = parsed.options[name];
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) if (typeof item === 'string' && !item.trim()) throw new CliUsageError(`--${name} needs a file, not an empty value.`);
  }
  try {
    if (!LOCAL.has(key)) ctx.session = await connect({ serverOptions, clientInfo: ctx.clientInfo });
    return await handler(ctx);
  } finally { await ctx.session?.close(); }
}

/** Calls one tool through the session. */
async function invoke(ctx, name, args) {
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('aborted');
  return unwrap(await ctx.session.call(name, args, ctx.signal));
}

/** Saves the images of one answer; returns the shown paths' records. */
async function keepImages(ctx, images, label) {
  const saved = await saveImages(images.map(image => ({ mimeType: image.mimeType, data: image.data })), {
    // A trailing separator (a folder meant for the images) survives the resolve.
    directory: ctx.imageDirectory, out: ctx.options.out !== undefined ? path.resolve(ctx.cwd, ctx.options.out) + (/[\\/]$/.test(ctx.options.out) ? path.sep : '') : null, label,
  });
  return saved.map(item => ({ ...item, file: ctx.shown(item.file) }));
}

/** A tool call whose images are saved and listed under savedImages. */
async function callWithImages(ctx, name, args, label = name) {
  const { value, images } = await invoke(ctx, name, args);
  if (!images.length) return { value, saved: [] };
  try { return { value, saved: await keepImages(ctx, images, label) }; }
  catch (error) { throw outputFailure(error, value); }
}
const withSaved = (value, saved) => saved.length ? { ...(record(value) ? value : { result: value }), savedImages: saved } : value;

/** An output that could not be written after a successful call: exit 3 with the result. */
class OutputFailure extends Error {
  constructor(error, result) { super(error.message); this.name = 'OutputFailure'; this.error = { code: error.code ?? 'output_unavailable', message: error.message }; this.result = result; }
}
const outputFailure = (error, result) => error instanceof CliFileError || error?.code ? new OutputFailure(error, result) : error;

const ok = output => ({ exit: EXIT.ok, output });

/** Names the tools take for a file copied into an inbox (src/material-tools.mjs, src/study-tools.mjs). */
const materialJsonName = name => `${(name.replace(/\.json$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'import').slice(0, 100)}.json`;
const coverName = name => name.replace(/[\p{Cc}\p{Cf}\\/:*?"<>|]/gu, '-').replace(/^[.\s]+/, '').trim().slice(-200) || 'cover';
const plainName = name => name.replace(/[\p{Cc}]/gu, '-').slice(-200);
/** A local file or inbox name for an inbox tool (src/cli-files.mjs stageIntoInbox): {name, copiedFrom?}. */
const INBOX_LABELS = { materialInbox: 'novelai/library-inbox/', studyInbox: 'novelai/study-inbox/' };
const stage = async (ctx, folder, given, sanitize) => ({ ...await stageIntoInbox(ctx.folders[folder], given, { cwd: ctx.cwd, sanitize }), folder: INBOX_LABELS[folder] });
/** The answer with the files nai copied into an inbox for it: copied [{from, to (project-relative)}]. */
const withStaged = (value, staged) => {
  const copied = staged.filter(item => item.copiedFrom).map(item => ({ from: item.copiedFrom, to: `${item.folder ?? ''}${item.name}`, ...(item.reused ? { reused: true } : {}) }));
  return copied.length ? { ...(record(value) ? value : { result: value }), copied } : value;
};

/** --wait / --wait-seconds as read_queue takes them (1–1200 s), checked locally. */
function checkWait(o) {
  if (o['wait-seconds'] === undefined) return;
  if (o.wait === undefined) usage('--wait-seconds goes with --wait done|next.');
  if (!(o['wait-seconds'] >= 1 && o['wait-seconds'] <= QUEUE_WAIT.maxSeconds)) usage(`--wait-seconds takes 1–${QUEUE_WAIT.maxSeconds} seconds, not ${o['wait-seconds']}. Nothing was sent.`);
}


// ------------------------------------------------------------------ handlers
const LOCAL = new Set(['env']);

/** The history read that gives a revision and assetId, when the command line did not. */
async function historyIdentity(ctx, id, kind = 'history') {
  if (kind === 'history' && ctx.options.revision !== undefined && ctx.options['asset-id'] !== undefined) return { revision: ctx.options.revision, assetId: ctx.options['asset-id'] };
  if (kind === 'study' && ctx.options['asset-id'] !== undefined) usage('--asset-id is for history images; an imported image has one original.');
  if (kind === 'study' && ctx.options.revision !== undefined) return { revision: ctx.options.revision };
  const { value } = await invoke(ctx, 'asset_library', defined({ action: 'read', kind, id, revision: ctx.options.revision }));
  if (kind === 'history') return { revision: value.revision, assetId: ctx.options['asset-id'] ?? value.assetId };
  return { revision: value?.item?.revision ?? value?.revision };
}

const HANDLERS = {
  async env(ctx) {
    const app = resolveOwnApp();
    const policy = autostartPolicy({ env: ctx.env });
    return ok({
      version: VERSION, runtime: process.versions.electron ? 'electron-as-node' : 'node',
      dataRoot: resolveDataPaths().root, dataSource: ctx.resolved.dataSource ?? 'default',
      projectRoot: ctx.projectRoot, projectSource: ctx.resolved.projectSource ?? 'data-dir-workspace', ...(ctx.resolved.marker ? { projectMarker: ctx.resolved.marker, projectMarkerPath: ctx.resolved.markerPath } : {}),
      folders: { materialInbox: path.resolve(MATERIAL_INBOX), materialExports: path.resolve(MATERIAL_EXPORTS), studyInbox: path.resolve(STUDY_INBOX), studyExports: path.resolve(STUDY_EXPORTS) },
      imageDir: ctx.imageDirectory,
      app: app.ok ? { startable: true, kind: app.kind } : { startable: false, reason: app.reason },
      autostart: policy.launch ? (app.ok ? 'on' : 'unsupported') : policy.reason,
      client: ctx.clientInfo,
    });
  },

  async tools(ctx) {
    const tools = await ctx.session.listTools();
    if (ctx.positionals.tool !== undefined) {
      const tool = tools.find(item => item.name === ctx.positionals.tool);
      if (!tool) throw new ToolFailure({ code: 'unknown_tool', message: `No tool ${JSON.stringify(ctx.positionals.tool)}; nai tools lists them.` });
      return ok({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
    }
    if (ctx.options.names) return ok(tools.map(tool => tool.name));
    return ok(tools.map(tool => ({ name: tool.name, summary: String(tool.description ?? '').split(/(?<=\.)\s/)[0] })));
  },

  async call(ctx) {
    const raw = ctx.positionals.arguments;
    const args = raw === undefined ? {} : await readJsonArgument(raw, 'The tool arguments', ctx.cwd);
    if (!record(args)) usage('The tool arguments must be a JSON object.');
    const { value, saved } = await callWithImages(ctx, ctx.positionals.tool, args, ctx.positionals.tool);
    return ok(withSaved(value, saved));
  },

  async tags(ctx) {
    const { full, co, rating, limit } = ctx.options, names = ctx.positionals.name ?? [];
    if (co !== undefined) {
      if (names.length) usage('--co takes one tag and no other names.');
      if (full) usage('--full and --co cannot be combined.');
      return ok((await invoke(ctx, 'tag_details', defined({ name: co, detail: 'cooccurrence', rating, limit }))).value);
    }
    if (rating !== undefined || limit !== undefined) usage('--rating and --limit go with --co.');
    if (!names.length) usage('nai tags needs 1–20 tag names (or --co <tag>).');
    return ok((await invoke(ctx, 'tag_details', defined({ ...(names.length === 1 ? { name: names[0] } : { names }), detail: full ? 'full' : undefined }))).value);
  },

  async 'material list'(ctx) {
    const o = ctx.options;
    return ok((await invoke(ctx, 'material_library', defined({ action: 'list', query: o.query, kind: o.kind, group: o.group, includeArchived: o.archived, offset: o.offset, limit: o.limit }))).value);
  },
  async 'material read'(ctx) { return ok((await invoke(ctx, 'material_library', defined({ action: 'read', id: ctx.positionals.id, revision: ctx.options.revision }))).value); },
  async 'material search'(ctx) {
    return ok((await invoke(ctx, 'material_library', defined({ action: 'search_tags', query: ctx.positionals.query, limit: ctx.options.limit, category: ctx.options.artist ? 'artist' : undefined }))).value);
  },
  async 'material save'(ctx) {
    const o = ctx.options;
    if ((o.file === undefined) === (o.inbox === undefined)) usage('nai material save takes -f <entry.json> or --inbox <file.json>.');
    if (o.inbox !== undefined) {
      if (o.id !== undefined || o['expected-revision'] !== undefined || o['refresh-evidence']) usage('--inbox is used alone: put id and expectedRevision into that file.');
      const staged = await stage(ctx, 'materialInbox', o.inbox, materialJsonName);
      return ok(withStaged((await invoke(ctx, 'material_library', { action: 'save', file: staged.name })).value, [staged]));
    }
    if ((o.id === undefined) !== (o['expected-revision'] === undefined)) usage('An update needs both --id and --expected-revision.');
    const entry = await readJsonFile(o.file, { label: 'The entry file', cwd: ctx.cwd });
    if (!record(entry)) usage('The entry file must hold one JSON object.');
    return ok((await invoke(ctx, 'material_library', defined({ action: 'save', entry, id: o.id, expectedRevision: o['expected-revision'], refreshEvidence: o['refresh-evidence'] }))).value);
  },
  async 'material archive'(ctx) {
    return ok((await invoke(ctx, 'material_library', { action: 'archive', id: ctx.positionals.id, expectedRevision: ctx.options['expected-revision'], archived: !ctx.options.unarchive })).value);
  },
  async 'material export'(ctx) {
    const ids = ctx.positionals.id ?? [];
    return ok((await invoke(ctx, 'material_library', defined({ action: 'export', ids: ids.length ? ids : undefined }))).value);
  },
  async 'material import'(ctx) {
    const o = ctx.options;
    if ((o.file === undefined) === (o.inbox === undefined)) usage('nai material import takes -f <backup.json> (or --inbox <file.json>).');
    if (o.file === '-') {
      const data = await readJsonFile('-', { label: 'The backup', cwd: ctx.cwd });
      if (!record(data)) usage('The backup must be one JSON object.');
      return ok((await invoke(ctx, 'material_library', { action: 'import', data })).value);
    }
    // A backup file goes through the library inbox (the tool reads up to 64 MiB there), copied in when it is elsewhere.
    const staged = await stage(ctx, 'materialInbox', o.file ?? o.inbox, materialJsonName);
    return ok(withStaged((await invoke(ctx, 'material_library', { action: 'import', file: staged.name })).value, [staged]));
  },
  async 'material set-cover'(ctx) {
    const o = ctx.options;
    const staged = await stage(ctx, 'materialInbox', ctx.positionals.file, coverName);
    return ok(withStaged((await invoke(ctx, 'material_library', { action: 'set_local_cover', entryId: ctx.positionals.entryId, revision: o.revision, expectedCoverRevision: o['expected-cover-revision'], file: staged.name })).value, [staged]));
  },
  async 'material cover'(ctx) {
    const { value, saved } = await callWithImages(ctx, 'material_library', { action: 'cover', entryId: ctx.positionals.entryId }, 'material-cover');
    return ok(withSaved(value, saved));
  },

  async 'study import'(ctx) {
    const o = ctx.options, files = ctx.positionals.file ?? [];
    if (o.manifest !== undefined) {
      if (files.length || o['source-url'] !== undefined || o['source-author'] !== undefined) usage('--manifest is used alone: put the files and source into it.');
      const staged = await stage(ctx, 'studyInbox', o.manifest, plainName);
      return ok(withStaged((await invoke(ctx, 'material_studies', { action: 'import', file: staged.name })).value, [staged]));
    }
    if (!files.length) usage('nai study import needs 1–20 images: files anywhere (copied into novelai/study-inbox) or names in it (or --manifest <file.json>).');
    const staged = [];
    for (const file of files) staged.push(await stage(ctx, 'studyInbox', file, plainName));
    return ok(withStaged((await invoke(ctx, 'material_studies', defined({ action: 'import', files: staged.map(item => item.name), sourceUrl: o['source-url'], sourceAuthor: o['source-author'] }))).value, staged));
  },
  async 'study list'(ctx) {
    const o = ctx.options;
    return ok((await invoke(ctx, 'material_studies', defined({ action: 'list', query: o.query, includeArchived: o.archived, offset: o.offset, limit: o.limit }))).value);
  },
  async 'study read'(ctx) {
    return ok((await invoke(ctx, 'material_studies', defined({ action: 'read', id: ctx.positionals.id, section: ctx.options.section, toFile: ctx.options['to-file'] }))).value);
  },
  async 'study image'(ctx) {
    const { value, saved } = await callWithImages(ctx, 'material_studies', { action: 'image', id: ctx.positionals.id }, 'study');
    return ok(withSaved(value, saved));
  },
  async 'study original'(ctx) { return ok((await invoke(ctx, 'material_studies', { action: 'original', id: ctx.positionals.id })).value); },
  async 'study update'(ctx) {
    const o = ctx.options;
    if (o.archive && o.unarchive) usage('--archive and --unarchive cannot be combined.');
    const patch = defined({ name: o.name, notes: o.notes, sourceUrl: o['source-url'], sourceAuthor: o['source-author'], archived: o.archive ? true : o.unarchive ? false : undefined });
    if (!Object.keys(patch).length) usage('nai study update needs at least one change (--name, --notes, --source-url, --source-author, --archive, --unarchive).');
    return ok((await invoke(ctx, 'material_studies', { action: 'update', id: ctx.positionals.id, expectedRevision: o['expected-revision'], patch })).value);
  },

  async 'asset list'(ctx) {
    const o = ctx.options;
    if (o.asc && o.desc) usage('--asc and --desc cannot be combined.');
    return ok((await invoke(ctx, 'asset_library', defined({ action: 'list', query: o.query, category: o.category, kinds: o.kind, collectionId: o.collection, queueBatchId: o.batch, queueRequestKey: o['request-key'],
      historyTags: o.tag, historyTagMatch: o['tag-match'], includeArchived: o.archived, sortBy: o.sort, sortDirection: o.asc ? 'asc' : o.desc ? 'desc' : undefined, offset: o.offset, limit: o.limit }))).value);
  },
  async 'asset read'(ctx) {
    return ok((await invoke(ctx, 'asset_library', defined({ action: 'read', kind: ctx.options.kind ?? 'history', id: ctx.positionals.id, revision: ctx.options.revision }))).value);
  },
  async 'asset recipe'(ctx) {
    const o = ctx.options;
    const target = path.resolve(ctx.cwd, o.output);
    const { value } = await invoke(ctx, 'asset_library', defined({ action: 'read', kind: 'history', id: ctx.positionals.historyId, revision: o.revision }));
    let extracted;
    try { extracted = historyToRecipe(value, { mode: o.mode ?? 't2i', randomSeed: o['random-seed'] === true }); }
    catch (error) { if (error instanceof RecipeExtractionError) throw new ToolFailure({ code: error.code, message: error.message }); throw error; }
    const { recipe, dropped, missing, warnings } = extracted;
    const summary = { historyId: value.id, revision: value.revision, assetId: value.assetId, madeWith: madeWith(value), ...recipeSummary(recipe), ...(recipe.effort ? { effort: recipe.effort } : {}),
      ...(dropped.length ? { droppedParams: dropped } : {}), ...(missing.length ? { missing } : {}), ...(warnings.length ? { warnings } : {}), references: REFERENCES_NOTE };
    let file;
    try { file = await writeOutputFile(target, jsonFileText(recipe), { display: o.output }); }
    catch (error) { throw outputFailure(error, summary); }
    return ok({ file: ctx.shown(file), ...summary, next: missing.length ? `Add ${missing.join(', ')} to the file, then nai prepare -f ${o.output}` : `nai prepare -f ${o.output}` });
  },
  async 'asset image'(ctx) {
    const kind = ctx.options.kind ?? 'history', id = ctx.positionals.id;
    const identity = await historyIdentity(ctx, id, kind);
    const args = defined({ action: 'image', kind, id, revision: identity.revision, assetId: identity.assetId, variant: ctx.options.original ? 'original' : undefined });
    const { value, saved } = await callWithImages(ctx, 'asset_library', args, `${kind}-${id}`);
    return ok(withSaved(value, saved));
  },
  async 'asset export'(ctx) {
    const id = ctx.positionals.historyId, identity = await historyIdentity(ctx, id, 'history');
    return ok((await invoke(ctx, 'asset_library', { action: 'export', kind: 'history', id, revision: identity.revision, assetId: identity.assetId })).value);
  },
  async 'asset censor'(ctx) {
    const o = ctx.options, kind = o.kind ?? 'history', id = ctx.positionals.id;
    if (o.out !== undefined && !o.preview) usage('--out saves the --preview picture; without --preview the JPG goes into novelai/library-exports.');
    const mask = await readJsonArgument(o.mask, '--mask', ctx.cwd);
    if (!record(mask)) usage('--mask must be a JSON object ({units, layers}).');
    const identity = await historyIdentity(ctx, id, kind);
    const args = defined({ action: 'censor', kind, id, revision: identity.revision, assetId: kind === 'history' ? identity.assetId : undefined, mask, style: o.style, sizePx: o['size-px'], featherPx: o['feather-px'], quality: o.quality, preview: o.preview });
    const { value, saved } = await callWithImages(ctx, 'asset_library', args, 'censor-preview');
    return ok(withSaved(value, saved));
  },
  async 'asset collections'(ctx) { return ok((await invoke(ctx, 'asset_library', { action: 'collections' })).value); },

  async prepare(ctx) {
    const o = ctx.options;
    let args;
    if (o.canvas !== undefined) {
      const conflicting = ['file', 'seed', 'model', 'width', 'height', 'steps', 'set', 'unset', 'revise'].filter(name => o[name] !== undefined);
      if (conflicting.length) usage(`--canvas takes only --expected-revision, --mode, --patch and --preview (not --${conflicting.join(', --')}).`);
      if (o['expected-revision'] === undefined) usage('--canvas needs --expected-revision (the revision read_workspace gave).');
      const patch = o.patch !== undefined ? await readJsonArgument(o.patch, '--patch', ctx.cwd) : undefined;
      if (patch !== undefined && !record(patch)) usage('--patch must be a JSON object.');
      args = defined({ canvas: defined({ workspaceId: o.canvas, expectedRevision: o['expected-revision'], patch }), mode: o.mode ?? 't2i', preview: o.preview });
    } else {
      if (o.file === undefined) usage('nai prepare needs -f <recipe.json> (or --canvas <workspaceId>).');
      if (o.patch !== undefined) usage('--patch goes with --canvas.');
      if ((o.revise === undefined) !== (o['expected-revision'] === undefined)) usage('A revision needs both --revise <recipeId> and --expected-revision <n>.');
      const recipe = await readJsonFile(o.file, { label: 'The recipe file', cwd: ctx.cwd });
      if (!record(recipe)) usage('The recipe file must hold one JSON object (the prepare_recipe arguments).');
      args = { ...recipe };
      for (const name of ['mode', 'model', 'width', 'height', 'steps']) if (o[name] !== undefined) args[name] = o[name];
      if (Object.hasOwn(o, 'seed')) args.seed = o.seed;
      for (const assignment of o.set ?? []) {
        const at = assignment.indexOf('=');
        if (at < 1) usage(`--set takes <key>=<value>, not ${JSON.stringify(assignment)}.`);
        args[assignment.slice(0, at)] = parseSetValue(assignment.slice(at + 1));
      }
      for (const name of o.unset ?? []) delete args[name];
      if (o.revise !== undefined) { args.recipeId = o.revise; args.expectedRevision = o['expected-revision']; }
      if (o.preview) args.preview = true;
    }
    if (o.output !== undefined && args.preview) usage('A preview saves no recipe: -o goes with a prepare without --preview.');
    const receiptTarget = o.output !== undefined ? path.resolve(ctx.cwd, o.output) : null;
    if (receiptTarget) {
      // The one write nai refuses: the receipt replacing the recipe it was made from.
      if (o.file !== undefined && o.file !== '-' && await sameFile(path.resolve(ctx.cwd, o.file), receiptTarget)) usage('-o names the recipe file given with -f; write the receipt to another file. Nothing was sent.');
    }
    if (o.out !== undefined && !args.preview) usage('--out saves the inpaint --preview picture.');
    const { value, saved } = await callWithImages(ctx, 'prepare_recipe', args, 'prepare-preview');
    let result = withSaved(value, saved);
    if (o.output !== undefined) {
      try {
        const file = await writeOutputFile(receiptTarget, jsonFileText(preparedReceipt(value, args)), { display: o.output });
        result = { ...result, receiptFile: ctx.shown(file) };
      } catch (error) { throw outputFailure(error, result); }
    }
    return ok(result);
  },

  async enqueue(ctx) {
    const o = ctx.options;
    // Everything the wait needs is checked before the (paid) enqueue: a wrong value must not surface after it.
    checkWait(o);
    const items = [];
    try {
      for (const file of o.file ?? []) items.push(...enqueueItemsFromFile(await readJsonFile(file, { label: 'The prepared file', cwd: ctx.cwd }), file === '-' ? 'stdin' : shown(file)));
      for (const text of o.recipe ?? []) items.push(enqueueItemFromArgument(text));
    } catch (error) { if (error instanceof RecipeReferenceError) usage(error.message); throw error; }
    if (!items.length) usage('nai enqueue needs -f <prepared.json> or --recipe <id>:<revision>:<inputHash>.');
    if (o.seeds !== undefined) {
      if (items.length !== 1) usage('--seeds goes with exactly one recipe.');
      const seeds = o.seeds.split(',').map(part => part.trim());
      if (!seeds.every(part => /^\d+$/.test(part) && Number.isSafeInteger(Number(part)))) usage('--seeds takes whole numbers separated by commas.');
      if (o.count !== undefined && o.count !== seeds.length) usage('--count must equal the number of --seeds.');
      const item = items[0];
      if (item.seeds !== undefined && JSON.stringify(item.seeds) !== JSON.stringify(seeds.map(Number))) usage('--seeds and the seeds in the prepared file differ; give them in one place.');
      if (item.count !== undefined && item.count !== seeds.length) usage('--seeds and the count in the prepared file differ; give them in one place.');
      item.seeds = seeds.map(Number); item.count = seeds.length;
    }
    if (o.count !== undefined) for (const [index, item] of items.entries()) {
      if (item.count !== undefined && item.count !== o.count) usage(`--count ${o.count} and the count ${item.count} of recipe ${index} in its prepared file differ; give the count in one place.`);
      if (item.seeds !== undefined && item.seeds.length !== o.count) usage(`--count ${o.count} and the ${item.seeds.length} seeds of recipe ${index} in its prepared file differ.`);
      item.count = o.count;
    }
    const args = defined({ requestKey: o.key, items, historyGroup: o.group, fileNamePrefix: o.prefix, intervalSeconds: o.interval });
    ctx.progress.stage = 'enqueue';
    const { value: receipt } = await invoke(ctx, 'enqueue_recipes', args);
    ctx.progress.stage = 'enqueued'; ctx.progress.enqueue = receipt;
    if (o.wait === undefined) return ok(receipt);
    if (typeof receipt?.batchId !== 'string') return ok({ enqueue: receipt, wait: { skipped: 'The answer names no batch to wait for.' } });
    try {
      const { value: batch } = await invoke(ctx, 'read_queue', { batchId: receipt.batchId, wait: defined({ until: o.wait, seconds: o['wait-seconds'] }) });
      return ok({ enqueue: receipt, batch });
    } catch (error) {
      // The batch is queued: whatever the wait met, the answer says so first, never "nothing was sent".
      if (error instanceof ToolFailure) throw new ToolFailure({ code: 'wait_failed', message: `The enqueue was accepted (batch ${receipt.batchId}); only the wait failed (${error.error?.code ?? 'error'}). Follow the batch with nai queue read ${receipt.batchId} --wait done; do not enqueue again.`, waitError: error.error }, { enqueue: receipt });
      throw error;
    }
  },

  async 'queue list'(ctx) { return ok((await invoke(ctx, 'list_queue', {})).value); },
  async 'queue read'(ctx) {
    const o = ctx.options;
    checkWait(o);
    return ok((await invoke(ctx, 'read_queue', defined({ batchId: ctx.positionals.batchId, wait: o.wait ? defined({ until: o.wait, seconds: o['wait-seconds'] }) : undefined }))).value);
  },
  async 'queue result'(ctx) {
    const o = ctx.options;
    const args = defined({ batchId: ctx.positionals.batchId, itemIndex: o.item, index: o.index, offset: o.offset });
    const { value, saved } = await callWithImages(ctx, 'get_queue_result', args, `queue-${ctx.positionals.batchId.slice(0, 8)}`);
    if (!saved.length) return ok(value);
    if (Array.isArray(value?.results)) {
      // The images follow the results that have one, in order.
      let next = 0;
      const results = value.results.map(result => result?.imageAttached === false || next >= saved.length ? result : { ...result, image: saved[next++].file });
      return ok({ ...value, results, savedImages: saved });
    }
    return ok({ ...value, image: saved[0].file, savedImages: saved });
  },

  async 'workspace read'(ctx) {
    const o = ctx.options;
    if (o['no-images'] && o.asset?.length) usage('--asset and --no-images cannot be combined.');
    const args = defined({ workspaceId: o.workspace, includeImages: o['no-images'] ? false : undefined, assetIds: o.asset, detail: o.full ? 'full' : undefined });
    const { value, saved } = await callWithImages(ctx, 'read_workspace', args, 'workspace');
    const ids = value?.imageAttachments?.includedAssetIds ?? [];
    return ok(withSaved(value, saved.map((item, index) => ids[index] !== undefined ? { assetId: ids[index], ...item } : item)));
  },
};
HANDLERS['ws read'] = HANDLERS['workspace read'];
HANDLERS.ws = HANDLERS['workspace read'];

export { OutputFailure };
