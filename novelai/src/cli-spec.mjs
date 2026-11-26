/**
 * The command line `nai` (src/cli.mjs): its commands, options and help texts, and the parser. Pure: no file, network or
 * business module is touched here, so `nai --help` and every usage error answer without connecting to anything.
 *
 * Every command runs one or more of the MCP server's own tools (src/mcp.mjs) through an in-memory MCP client
 * (src/cli-run.mjs); `call` reaches any tool with raw JSON arguments.
 */

/** Process exit codes of `nai`. */
export const EXIT = Object.freeze({
  ok: 0,
  /** The tool answered an error ({ok:false, error} on stdout). */
  toolError: 1,
  /** The command line or a local input file was wrong; nothing was sent to the app. */
  usage: 2,
  /** The call succeeded but its output (an image, a recipe or receipt file) could not be written; the result says what happened. */
  output: 3,
  /** An unexpected failure inside nai itself. */
  internal: 4,
  /** Interrupted by SIGINT (130) or SIGTERM (143): the outcome of a write may be unknown. */
  interrupted: 130,
  terminated: 143,
});

export class CliUsageError extends Error {
  constructor(message, code = 'usage') { super(message); this.name = 'CliUsageError'; this.code = code; }
}

const RECIPE_MODES = ['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director'];
const WAIT = ['done', 'next'];
const ASSET_KINDS = ['tag', 'combo', 'note', 'study', 'history', 'artist_favorite', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset'];

/**
 * Option types: flag (no value), string, int (a safe integer, negative allowed), number, seed (an integer, or null /
 * random for a random seed), enum (values), json (inline JSON, @file or - for stdin). `repeat` collects every use.
 */
export const GLOBAL_OPTIONS = Object.freeze({
  'data-dir': { type: 'string', value: '<dir>', help: 'Data folder of the app (sets NOVELAI_DATA_DIR for this run). Default: NOVELAI_DATA_DIR, else the app\'s own data folder.' },
  project: { type: 'string', value: '<dir>', help: 'Project root of the inbox/export folders (sets NOVELAI_PROJECT_ROOT). Default: NOVELAI_PROJECT_ROOT, else the nearest folder up from here whose .mcp.json / .pi/mcp.json sets mcpServers.novelai.env.NOVELAI_PROJECT_ROOT (that value, ${VAR} expanded) or that holds novelai/library-inbox or novelai/study-inbox, else <data folder>/workspace.' },
  'image-dir': { type: 'string', value: '<dir>', help: 'Folder for returned images. Default: <project root>/.tmp/nai-cli.' },
  pretty: { type: 'flag', help: 'Indent the JSON output.' },
  help: { type: 'flag', alias: 'h', help: 'Show help (for a command: nai <command> --help). Offline.' },
  version: { type: 'flag', help: 'Print the version. Offline.' },
});

const out = { type: 'string', value: '<file|folder/>', help: 'Write the image to this file (folders are created; the extension follows the image type), or into this folder (an existing one, or a path ending in /).' };
const force = { type: 'flag', help: 'Accepted for compatibility: outputs are always replaced.' };
const revision = { type: 'int', alias: 'r', value: '<n>', help: 'Exact revision (default: the current one).' };
const offset = { type: 'int', value: '<n>', help: 'Rows to skip.' };
const waitOptions = {
  wait: { type: 'enum', values: WAIT, value: 'done|next', help: 'Wait in this call: until the batch ended (done) or saved a new image (next).' },
  'wait-seconds': { type: 'number', value: '<s>', help: 'Longest wait, 1–1200 seconds (default 300); checked before anything is sent.' },
};

/**
 * Every command: path, positionals ([{name, required?, variadic?}]), options, a one-line summary and optional notes.
 * The tool each runs is in `tools` (help text only; src/cli-run.mjs maps the arguments).
 */
export const COMMANDS = Object.freeze([
  { path: ['skill'], summary: 'Print the agent guide for this version of nai (Markdown). Offline.', offline: true },
  { path: ['version'], summary: 'Print the version. Offline.', offline: true },
  { path: ['help'], positionals: [{ name: 'command', variadic: true }], summary: 'Show help for a command. Offline.', offline: true },
  { path: ['env'], summary: 'Show the data folder, the project root (and where it came from), the image folder and whether nai can start the app. Calls nothing.' },
  { path: ['tools'], positionals: [{ name: 'tool' }], options: { names: { type: 'flag', help: 'Only the tool names.' } }, summary: 'List the MCP tools, or one tool\'s description and input schema (for nai call). Calls nothing.' },
  { path: ['call'], positionals: [{ name: 'tool', required: true }, { name: 'arguments' }], summary: 'Call any MCP tool with its JSON arguments: inline JSON, @file.json or - (stdin); none is {}.', tools: 'any',
    notes: 'Images the tool returns are saved as files (savedImages); nothing else changes the tool\'s answer.' },
  { path: ['tags'], positionals: [{ name: 'name', variadic: true }], summary: 'Danbooru facts for 1–20 tags (tag_details).', tools: 'tag_details',
    options: { full: { type: 'flag', help: 'detail full: the whole wiki and diagnostics.' }, co: { type: 'string', value: '<tag>', help: 'Tags that commonly appear with this one (detail cooccurrence); no other names.' },
      rating: { type: 'enum', values: ['g', 's', 'q', 'e'], value: 'g|s|q|e', help: 'With --co: rating scope (default g).' }, limit: { type: 'int', value: '<n>', help: 'With --co: 1–20 (default 8).' } } },

  { path: ['material', 'list'], summary: 'List prompt materials (material_library list).', tools: 'material_library',
    options: { query: { type: 'string', alias: 'q', value: '<text>' }, kind: { type: 'enum', values: ['tag', 'combo', 'note'], value: 'tag|combo|note' }, group: { type: 'string', value: '<group>' },
      archived: { type: 'flag', help: 'Include archived entries.' }, offset, limit: { type: 'int', value: '<n>', help: '1–50.' } } },
  { path: ['material', 'read'], positionals: [{ name: 'id', required: true }], options: { revision }, summary: 'Read one material entry.', tools: 'material_library' },
  { path: ['material', 'search'], positionals: [{ name: 'query', required: true }], summary: 'Find tag candidates by English prefix or Chinese word (search_tags).', tools: 'material_library',
    options: { limit: { type: 'int', value: '<n>', help: '1–20.' }, artist: { type: 'flag', help: 'Artists only.' } } },
  { path: ['material', 'save'], summary: 'Create or update an entry from a local JSON file (the entry object), or from a save request file ({entry, id?, expectedRevision?}) read through novelai/library-inbox.', tools: 'material_library',
    options: { file: { type: 'string', alias: 'f', value: '<entry.json>', help: 'Local file with the entry {kind, name, …} (- for stdin).' }, inbox: { type: 'string', value: '<file.json>', help: 'A save request file, used alone: a name in novelai/library-inbox or any file (copied there first).' },
      id: { type: 'string', value: '<id>', help: 'Update this entry (with --expected-revision).' }, 'expected-revision': { type: 'int', value: '<n>' }, 'refresh-evidence': { type: 'flag' } } },
  { path: ['material', 'archive'], positionals: [{ name: 'id', required: true }], summary: 'Archive an entry (or --unarchive).', tools: 'material_library',
    options: { 'expected-revision': { type: 'int', value: '<n>', required: true }, unarchive: { type: 'flag' } } },
  { path: ['material', 'export'], positionals: [{ name: 'id', variadic: true }], summary: 'Write a JSON backup into novelai/library-exports (all entries, or these).', tools: 'material_library' },
  { path: ['material', 'import'], summary: 'Restore a backup file (any file is copied into novelai/library-inbox first; - reads stdin).', tools: 'material_library',
    options: { file: { type: 'string', alias: 'f', value: '<backup.json>' }, inbox: { type: 'string', value: '<file.json>', help: 'The same as -f.' } } },
  { path: ['material', 'set-cover'], positionals: [{ name: 'entryId', required: true }, { name: 'file', required: true }], summary: 'Make a PNG/JPEG/WebP/GIF the local cover of a tag (any file is copied into novelai/library-inbox first).', tools: 'material_library',
    options: { revision: { type: 'int', alias: 'r', value: '<n>', required: true, help: 'The tag\'s current revision.' }, 'expected-cover-revision': { type: 'int', value: '<n>', required: true, help: 'Its current coverRevision (0 at first).' } } },
  { path: ['material', 'cover'], positionals: [{ name: 'entryId', required: true }], options: { out, force }, summary: 'Save a tag\'s local cover image to a file.', tools: 'material_library' },

  { path: ['study', 'import'], positionals: [{ name: 'file', variadic: true }], summary: 'Import 1–20 PNG/JPEG/WebP images: any files (copied into novelai/study-inbox first) or names in that inbox.', tools: 'material_studies',
    options: { 'source-url': { type: 'string', value: '<url>' }, 'source-author': { type: 'string', value: '<name>' }, manifest: { type: 'string', value: '<file.json>', help: 'A JSON manifest {files, sourceUrl?, sourceAuthor?}, used alone; its files are names in novelai/study-inbox.' } } },
  { path: ['study', 'list'], summary: 'List imported images.', tools: 'material_studies',
    options: { query: { type: 'string', alias: 'q', value: '<text>' }, archived: { type: 'flag' }, offset, limit: { type: 'int', value: '<n>', help: '1–50.' } } },
  { path: ['study', 'read'], positionals: [{ name: 'id', required: true }], summary: 'Read one section of an imported image.', tools: 'material_studies',
    options: { section: { type: 'enum', values: ['summary', 'prompts', 'parameters', 'raw', 'notes'], value: '<section>' }, 'to-file': { type: 'flag', help: 'Write the section into novelai/study-exports.' } } },
  { path: ['study', 'image'], positionals: [{ name: 'id', required: true }], options: { out, force }, summary: 'Save the preview of an imported image to a file.', tools: 'material_studies' },
  { path: ['study', 'original'], positionals: [{ name: 'id', required: true }], summary: 'Export the original bytes into novelai/study-exports.', tools: 'material_studies' },
  { path: ['study', 'update'], positionals: [{ name: 'id', required: true }], summary: 'Change name, source, notes or archive state.', tools: 'material_studies',
    options: { 'expected-revision': { type: 'int', value: '<n>', required: true }, name: { type: 'string', value: '<name>' }, notes: { type: 'string', value: '<text>' }, 'source-url': { type: 'string', value: '<url>' },
      'source-author': { type: 'string', value: '<name>' }, archive: { type: 'flag' }, unarchive: { type: 'flag' } } },

  { path: ['asset', 'list'], summary: 'List library items (asset_library list).', tools: 'asset_library',
    options: { query: { type: 'string', alias: 'q', value: '<text>' }, category: { type: 'enum', values: ['history', 'imports', 'tags', 'presets', 'notes'], value: '<category>' },
      kind: { type: 'enum', values: ASSET_KINDS, repeat: true, value: '<kind>', help: 'Repeatable.' }, collection: { type: 'string', value: '<id>', help: 'A collection id; a history group is history:<groupId>.' },
      batch: { type: 'string', value: '<batchId>', help: 'Images that queue batch saved.' }, 'request-key': { type: 'string', value: '<key>', help: 'Images saved under your enqueue key.' },
      tag: { type: 'string', repeat: true, value: '<tag>', help: 'History tag filter (repeatable; needs --category history).' }, 'tag-match': { type: 'enum', values: ['all', 'any'], value: 'all|any' },
      archived: { type: 'flag' }, sort: { type: 'enum', values: ['updatedAt', 'createdAt', 'name'], value: '<field>' }, asc: { type: 'flag' }, desc: { type: 'flag' }, offset, limit: { type: 'int', value: '<n>', help: '1–20.' } } },
  { path: ['asset', 'read'], positionals: [{ name: 'id', required: true }], summary: 'Read one library item; a history image as everything it was made with.', tools: 'asset_library',
    options: { kind: { type: 'enum', values: ASSET_KINDS, value: '<kind>', help: 'Default history.' }, revision } },
  { path: ['asset', 'recipe'], positionals: [{ name: 'historyId', required: true }], summary: 'Write a history image\'s generation settings as a prepare_recipe JSON file; prints only a summary.', tools: 'asset_library',
    options: { revision, output: { type: 'string', alias: 'o', value: '<recipe.json>', required: true, help: 'The recipe file to write (folders are created, an existing file is replaced).' }, force,
      mode: { type: 'enum', values: ['t2i', 'i2i', 'enhance'], value: 't2i|i2i|enhance', help: 'Default t2i. i2i/enhance use this image as source; add strength (i2i) or magnitude and scale (enhance) in the file.' },
      'random-seed': { type: 'flag', help: 'seed null (random at enqueue) instead of the image\'s seed.' } },
    notes: 'Edit the file with any editor, then: nai prepare -f <recipe.json>.' },
  { path: ['asset', 'image'], positionals: [{ name: 'id', required: true }], summary: 'Save a history (or imported) image to a file: a ≤384 px thumbnail, or --original.', tools: 'asset_library',
    options: { kind: { type: 'enum', values: ['history', 'study'], value: 'history|study' }, revision, 'asset-id': { type: 'string', value: '<assetId>' }, original: { type: 'flag' }, out, force } },
  { path: ['asset', 'export'], positionals: [{ name: 'historyId', required: true }], summary: 'Copy a history original into novelai/library-exports.', tools: 'asset_library',
    options: { revision, 'asset-id': { type: 'string', value: '<assetId>' } } },
  { path: ['asset', 'censor'], positionals: [{ name: 'id', required: true }], summary: 'Cover a masked area and write a metadata-free JPG into novelai/library-exports (--preview: save the censored picture here, write nothing there).', tools: 'asset_library',
    options: { kind: { type: 'enum', values: ['history', 'study'], value: 'history|study' }, revision, 'asset-id': { type: 'string', value: '<assetId>' }, mask: { type: 'json', value: '<json|@file>', required: true },
      style: { type: 'enum', values: ['mosaic', 'blur', 'black', 'white'], value: '<style>' }, 'size-px': { type: 'int', value: '<n>' }, 'feather-px': { type: 'int', value: '<n>' }, quality: { type: 'int', value: '<n>' }, preview: { type: 'flag' }, out, force } },
  { path: ['asset', 'collections'], summary: 'List collections (id, name).', tools: 'asset_library' },

  { path: ['prepare'], summary: 'Freeze a recipe (prepare_recipe) from a local JSON file, or from the live canvas.', tools: 'prepare_recipe',
    options: { file: { type: 'string', alias: 'f', value: '<recipe.json>', help: 'The recipe object (- for stdin).' }, output: { type: 'string', alias: 'o', value: '<prepared.json>', help: 'Write {recipeId, recipeRevision, inputHash, mode} here for nai enqueue -f (folders are created; never the -f file).' },
      preview: { type: 'flag', help: 'Dry run: check and build without saving (inpaint: saves the mask preview image).' }, seed: { type: 'seed', value: '<n|null>', help: 'Override seed (null: random at enqueue).' },
      mode: { type: 'enum', values: RECIPE_MODES, value: '<mode>' }, model: { type: 'string', value: '<model>' }, width: { type: 'int', value: '<px>' }, height: { type: 'int', value: '<px>' }, steps: { type: 'int', value: '<n>' },
      set: { type: 'string', repeat: true, value: '<key>=<json>', help: 'Set a top-level field (value as JSON, else as text). Repeatable.' }, unset: { type: 'string', repeat: true, value: '<key>', help: 'Remove a top-level field. Repeatable.' },
      revise: { type: 'string', value: '<recipeId>', help: 'Save a new revision of this recipe (with --expected-revision).' }, 'expected-revision': { type: 'int', value: '<n>' },
      canvas: { type: 'string', value: '<workspaceId>', help: 'Capture the live canvas at --expected-revision instead of a file.' }, patch: { type: 'json', value: '<json|@file>', help: 'With --canvas: a t2i text patch.' }, out, force },
    notes: 'The readback lists only what the host decided or changed; check its warnings before you enqueue.' },
  { path: ['enqueue'], summary: 'GENERATE (paid): enqueue prepared recipes, optionally waiting for the batch.', tools: 'enqueue_recipes, read_queue',
    options: { key: { type: 'string', value: '<requestKey>', required: true, help: 'Your idempotency key for this intent; reuse it to retry the same intent.' },
      file: { type: 'string', alias: 'f', repeat: true, value: '<prepared.json>', help: 'Files with {recipeId, recipeRevision, inputHash} (an object, an array of them, or {items:[…]}). Repeatable.' },
      recipe: { type: 'string', repeat: true, value: '<id>:<revision>:<inputHash>', help: 'A recipe on the command line. Repeatable.' },
      count: { type: 'int', value: '<n>', help: 'Images per recipe (a different count or seeds in a prepared file is a conflict).' }, seeds: { type: 'string', value: '<n,n,…>', help: 'Explicit seeds (one recipe only; length = count).' },
      group: { type: 'string', value: '<historyGroup>' }, prefix: { type: 'string', value: '<fileNamePrefix>' }, interval: { type: 'number', value: '<s>', help: 'Pause between images, 0–60 s.' }, ...waitOptions },
    notes: 'An answer that is not definite (an unknown outcome, an interruption) is settled by running the same command again with the same --key; never switch keys for the same intent.' },

  { path: ['queue', 'list'], summary: 'The shared queue: counts and the first batches.', tools: 'list_queue' },
  { path: ['queue', 'read'], positionals: [{ name: 'batchId', required: true }], options: { ...waitOptions }, summary: 'One batch: status, saved images, failures; optionally waiting.', tools: 'read_queue' },
  { path: ['queue', 'result'], positionals: [{ name: 'batchId', required: true }], summary: 'Save a batch\'s images: thumbnails of the whole batch, or one image with --item.', tools: 'get_queue_result',
    options: { item: { type: 'int', value: '<itemIndex>' }, index: { type: 'int', value: '<n>', help: 'With --item: which result of that item.' }, offset, out, force } },

  { path: ['workspace', 'read'], aliases: [['ws', 'read'], ['ws']], summary: 'Read the live canvas (workspaceId, revision, prompts); its images are saved as files.', tools: 'read_workspace',
    options: { workspace: { type: 'string', value: '<workspaceId>' }, asset: { type: 'string', repeat: true, value: '<assetId>', help: 'Images to include (up to 5). Repeatable.' }, 'no-images': { type: 'flag' }, full: { type: 'flag', help: 'detail full.' } } },
]);

const ALL_PATHS = COMMANDS.flatMap(command => [command.path, ...(command.aliases ?? [])].map(path => ({ path, command })));

/** The command whose path (or alias) the leading words name: the longest match. */
export function findCommand(words) {
  let best = null;
  for (const entry of ALL_PATHS) {
    if (entry.path.length <= words.length && entry.path.every((word, index) => words[index] === word) && (!best || entry.path.length > best.path.length)) best = entry;
  }
  return best;
}

const INT = /^-?\d+$/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
function convert(name, spec, raw) {
  switch (spec.type) {
    case 'string': case 'json': return raw;
    case 'int': {
      if (!INT.test(raw) || !Number.isSafeInteger(Number(raw))) throw new CliUsageError(`--${name} takes an integer, not ${JSON.stringify(raw)}.`);
      return Number(raw);
    }
    case 'number': {
      const value = Number(raw);
      if (!NUMBER.test(raw) || !Number.isFinite(value)) throw new CliUsageError(`--${name} takes a number, not ${JSON.stringify(raw)}.`);
      return value;
    }
    case 'seed': {
      if (raw === 'null' || raw === 'random') return null;
      if (!INT.test(raw) || !Number.isSafeInteger(Number(raw))) throw new CliUsageError(`--${name} takes an integer or null, not ${JSON.stringify(raw)}.`);
      return Number(raw);
    }
    case 'enum': {
      if (!spec.values.includes(raw)) throw new CliUsageError(`--${name} takes one of ${spec.values.join(', ')}, not ${JSON.stringify(raw)}.`);
      return raw;
    }
    default: throw new TypeError(`Unknown option type ${spec.type}`);
  }
}

/**
 * A standalone --help or -h anywhere before `--` asks for help, whatever else the line holds (also where an option
 * expects a value): {command|null, group?, global:{help:true}}. The command is named by the leading words that form a
 * command path, other options and their values skipped. Never throws. Null when no help is asked.
 */
function helpRequest(argv) {
  const end = argv.indexOf('--');
  const before = end < 0 ? argv : argv.slice(0, end);
  if (!before.some(token => token === '--help' || token === '-h')) return null;
  const words = [];
  for (let index = 0; index < before.length; index++) {
    const token = before[index];
    if (token.startsWith('-') && token !== '-') {
      // A global option's value is not a command word.
      const name = token.startsWith('--') ? token.slice(2).split('=')[0] : null;
      if (name && !token.includes('=') && GLOBAL_OPTIONS[name] && GLOBAL_OPTIONS[name].type !== 'flag') index++;
      continue;
    }
    const extended = [...words, token];
    if (!ALL_PATHS.some(item => item.path.length >= extended.length && extended.every((word, at) => item.path[at] === word))) break;
    words.push(token);
  }
  const exact = ALL_PATHS.find(item => item.path.length === words.length && item.path.every((word, at) => word === words[at]));
  if (exact) return { command: exact.command, options: {}, positionals: {}, global: { help: true } };
  return { command: null, ...(words.length ? { group: words[0] } : {}), options: {}, positionals: [], global: { help: true } };
}

/**
 * Parses the arguments after `nai`: {command, options, positionals, global}. Global options may stand anywhere;
 * `--` ends the options (what follows is positional). Throws CliUsageError for anything it does not know.
 */
export function parseCommandLine(argv) {
  if (!Array.isArray(argv) || argv.some(arg => typeof arg !== 'string')) throw new TypeError('argv must be an array of strings.');
  const help = helpRequest(argv);
  if (help) return help;
  const global = {}, words = [];
  let index = 0, entry = null;
  // The command path: the leading words, with global options allowed before it.
  const takeOption = (specs, target, token, next) => {
    const eq = token.indexOf('=');
    const long = token.startsWith('--');
    const key = long ? token.slice(2, eq > 2 ? eq : undefined) : token.slice(1);
    const name = long ? key : Object.keys(specs).find(candidate => specs[candidate].alias === key);
    if (!name || !Object.hasOwn(specs, name)) return null;
    const spec = specs[name];
    let raw;
    if (spec.type === 'flag') {
      if (long && eq > 2) throw new CliUsageError(`--${name} takes no value.`);
      raw = null;
    } else if (long && eq > 2) raw = token.slice(eq + 1);
    else {
      if (next === undefined) throw new CliUsageError(`--${name} needs a value${spec.value ? ` ${spec.value}` : ''}.`);
      raw = next; index++;
    }
    const value = spec.type === 'flag' ? true : convert(name, spec, raw);
    if (spec.repeat) (target[name] ??= []).push(value);
    else if (Object.hasOwn(target, name) && spec.type !== 'flag') throw new CliUsageError(`--${name} is given twice.`);
    else target[name] = value;
    return name;
  };
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--') break;
    if (token.startsWith('-') && token !== '-') {
      if (takeOption(GLOBAL_OPTIONS, global, token, argv[index + 1]) === null) {
        // An option before any command word that is not global: the command decides (or it is unknown).
        if (!words.length) throw new CliUsageError(`Unknown option ${token.split('=')[0]}. Run nai --help.`);
        break;
      }
      continue;
    }
    const extended = [...words, token];
    // A word that does not extend any command path is a positional of the command found so far.
    if (!ALL_PATHS.some(item => item.path.length >= extended.length && extended.every((word, at) => item.path[at] === word))) break;
    words.push(token);
    const exact = ALL_PATHS.find(item => item.path.length === words.length && item.path.every((word, at) => word === words[at]));
    entry = exact ?? (entry && entry.path.length < words.length ? entry : null);
  }
  if (!entry || entry.path.length !== words.length) {
    if (!words.length && (global.help || global.version || index >= argv.length)) return { command: null, options: {}, positionals: [], global };
    if (words.length && global.help) return { command: null, group: words[0], options: {}, positionals: [], global };
    if (words.length) {
      const subcommands = COMMANDS.filter(command => command.path[0] === words[0]).map(command => command.path.slice(1).join(' ')).filter(Boolean);
      throw new CliUsageError(`nai ${words.join(' ')} needs a subcommand${argv[index] !== undefined ? ` (not ${JSON.stringify(argv[index])})` : ''}: ${subcommands.join(', ')}. Run nai ${words[0]} --help.`);
    }
    throw new CliUsageError(`Unknown command ${JSON.stringify(argv[index])}. Run nai --help.`);
  }
  const command = entry.command;
  const specs = { ...(command.options ?? {}) };
  const options = {}, positionals = [];
  let rest = false;
  for (; index < argv.length; index++) {
    const token = argv[index];
    if (!rest && token === '--') { rest = true; continue; }
    if (!rest && token.startsWith('-') && token !== '-' && !/^-\d/.test(token)) {
      if (takeOption(specs, options, token, argv[index + 1]) !== null) continue;
      if (takeOption(GLOBAL_OPTIONS, global, token, argv[index + 1]) !== null) continue;
      throw new CliUsageError(`Unknown option ${token.split('=')[0]} for nai ${command.path.join(' ')}. Run nai ${command.path.join(' ')} --help.`);
    }
    positionals.push(token);
  }
  if (global.help) return { command, options, positionals, global };
  const declared = command.positionals ?? [];
  const named = {};
  let at = 0;
  for (const positional of declared) {
    if (positional.variadic) { named[positional.name] = positionals.slice(at); at = positionals.length; continue; }
    if (at < positionals.length) named[positional.name] = positionals[at++];
    else if (positional.required) throw new CliUsageError(`nai ${command.path.join(' ')} needs <${positional.name}>. Run nai ${command.path.join(' ')} --help.`);
  }
  if (at < positionals.length) throw new CliUsageError(`Unexpected argument ${JSON.stringify(positionals[at])} for nai ${command.path.join(' ')}. Run nai ${command.path.join(' ')} --help.`);
  for (const [name, spec] of Object.entries(specs)) if (spec.required && !Object.hasOwn(options, name)) throw new CliUsageError(`nai ${command.path.join(' ')} needs --${name}${spec.value ? ` ${spec.value}` : ''}.`);
  return { command, options, positionals: named, global };
}

const optionLine = (name, spec) => {
  const flag = `${spec.alias ? `-${spec.alias}, ` : ''}--${name}${spec.type === 'flag' ? '' : ` ${spec.value ?? '<value>'}`}`;
  const help = [spec.required ? '(required)' : '', spec.help ?? (spec.type === 'enum' ? `One of ${spec.values.join(', ')}.` : '')].filter(Boolean).join(' ');
  return `  ${flag.padEnd(34)} ${help}`.trimEnd();
};
const usageOf = command => `nai ${command.path.join(' ')}${(command.positionals ?? []).map(item => ` ${item.required ? `<${item.name}>` : `[${item.name}]`}${item.variadic ? '…' : ''}`).join('')}${Object.keys(command.options ?? {}).length ? ' [options]' : ''}`;

const EXIT_TEXT = `Exit codes:
  0    success: the result is the JSON on stdout
  1    the tool answered an error, also its own argument checks (invalid_arguments: nothing was queued), or nai refused
       what an answer holds: stdout is {"ok":false,"error":{"code","message","details"?}}
  2    nai's own usage or local input error (unknown option, malformed number, unreadable or invalid JSON file);
       nothing was sent to the app
  3    the call succeeded but an output file could not be written (the JSON says what was done)
  4    internal error of nai
  130  interrupted (143: terminated); a write may have happened: read the current state, or run the same enqueue again with the same --key`;

/** The help text: the overview, or one command (or command group) by its words. */
export function helpText(words = []) {
  const entry = words.length ? findCommand(words) : null;
  if (entry && entry.path.length === words.length) {
    const { command } = entry;
    const lines = [`Usage: ${usageOf(command)}`, '', command.summary];
    if (command.tools) lines.push(`Tool: ${command.tools}`);
    const options = Object.entries(command.options ?? {});
    if (options.length) lines.push('', 'Options:', ...options.map(([name, spec]) => optionLine(name, spec)));
    if (command.aliases?.length) lines.push('', `Aliases: ${command.aliases.map(path => `nai ${path.join(' ')}`).join(', ')}`);
    if (command.notes) lines.push('', command.notes);
    lines.push('', 'Global options: --data-dir <dir>, --project <dir>, --image-dir <dir>, --pretty (nai --help).', '', EXIT_TEXT);
    return `${lines.join('\n')}\n`;
  }
  const group = words.length ? COMMANDS.filter(command => command.path[0] === words[0]) : [];
  if (words.length && !group.length) throw new CliUsageError(`Unknown command "${words.join(' ')}". Run nai --help.`);
  const listed = group.length ? group : COMMANDS;
  const width = Math.max(...listed.map(command => usageOf(command).length - 4));
  const lines = group.length ? [`Commands of nai ${words[0]}:`, ''] : [
    'nai — the command line of MCP for NovelAI. Every command runs the MCP server\'s own tools with the same checks, and prints one JSON document on stdout.',
    '',
    'Usage: nai [global options] <command> [arguments] [options]',
    '',
    'Commands:',
  ];
  lines.push(...listed.map(command => `  ${usageOf(command).slice(4).padEnd(width)}  ${command.summary}`));
  if (!group.length) {
    lines.push('', 'Global options:', ...Object.entries(GLOBAL_OPTIONS).map(([name, spec]) => optionLine(name, spec)), '',
      'Run nai skill once for the agent guide of this version; nai <command> --help for a command\'s options.',
      'Images that tools return are written to files (savedImages in the JSON), never printed.', '', EXIT_TEXT);
  }
  return `${lines.join('\n')}\n`;
}
