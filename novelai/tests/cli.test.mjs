// nai (src/cli.mjs) as a process and its pure parts: the parser and help, the folders it decides before any business
// module loads (src/cli-env.mjs), the recipe file conversion (src/cli-recipe.mjs), exit codes, stdin and @file inputs,
// interruption, and that --help / skill / version read and start nothing. Every process gets its own temporary data
// folder; the bridge, when there is one, is a local HTTP double.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, EXIT, GLOBAL_OPTIONS, CliUsageError, helpText, parseCommandLine } from '../src/cli-spec.mjs';
import { applyCliEnvironment, detectProjectRoot, resolveCliEnvironment } from '../src/cli-env.mjs';
import { enqueueItemFromArgument, enqueueItemsFromFile, historyToRecipe, parseSetValue } from '../src/cli-recipe.mjs';
import { skillGuide } from '../src/cli-guide.mjs';
import { resolveOwnApp } from '../src/app-launch.mjs';
import { VERSION } from '../src/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'src', 'cli.mjs');
const temp = async (t, prefix = 'novelai-cli-') => { const dir = await realpath(await mkdtemp(join(tmpdir(), prefix))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

/** Runs `node src/cli.mjs …` with a hand-built environment (no inherited NOVELAI_* or ELECTRON_*). */
function run(argv, { cwd, env = {}, stdin, nodeArgs = [], onSpawn } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI, ...argv], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, TMPDIR: process.env.TMPDIR ?? tmpdir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), NOVELAI_MCP_AUTOSTART: '0', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => { let json; try { json = JSON.parse(stdout); } catch { json = undefined; } resolvePromise({ code, signal, stdout, stderr, json }); });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
    onSpawn?.(child);
  });
}

/** A local HTTP double of the app's bridge, with bridge.json in `<data>/runtime`. */
async function bridgeDouble(t, data, answer) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const parsed = JSON.parse(body);
      requests.push({ ...parsed, authorization: request.headers.authorization });
      const result = await answer(parsed.method, parsed.args, requests.length);
      if (result === undefined) return; // never answers
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections?.(); await new Promise(done => server.close(done)); });
  await mkdir(join(data, 'runtime'), { recursive: true });
  await writeFile(join(data, 'runtime', 'bridge.json'), JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${server.address().port}/`, token: 't'.repeat(64), pid: process.pid }));
  return requests;
}

// ------------------------------------------------------------------ parser and help
test('parser: commands, aliases, global options anywhere, typed values and every usage error', () => {
  const parsed = parseCommandLine(['--data-dir', '/d', 'enqueue', '--key', 'k', '-f', 'a.json', '-f', 'b.json', '--count', '2', '--pretty', '--wait=done']);
  assert.deepEqual([parsed.command.path, parsed.options, parsed.global], [['enqueue'], { key: 'k', file: ['a.json', 'b.json'], count: 2, wait: 'done' }, { 'data-dir': '/d', pretty: true }]);
  assert.deepEqual(parseCommandLine(['prepare', '-f', 'x', '--seed', 'null']).options.seed, null);
  assert.deepEqual(parseCommandLine(['prepare', '-f', 'x', '--seed', '-1']).options.seed, -1);
  assert.deepEqual(parseCommandLine(['prepare', '-f', 'x', '--seed', 'random']).options.seed, null);
  assert.deepEqual(parseCommandLine(['ws']).command.path, ['workspace', 'read']);
  assert.deepEqual(parseCommandLine(['ws', 'read', '--no-images']).options, { 'no-images': true });
  assert.deepEqual(parseCommandLine(['tags', 'a', 'b', 'c']).positionals, { name: ['a', 'b', 'c'] });
  assert.deepEqual(parseCommandLine(['call', 'list_queue', '-']).positionals, { tool: 'list_queue', arguments: '-' });
  assert.deepEqual(parseCommandLine(['asset', 'read', '--', '-weird-id']).positionals, { id: '-weird-id' });
  assert.deepEqual(parseCommandLine(['asset', 'list', '--kind', 'tag', '--kind', 'note']).options.kind, ['tag', 'note']);
  assert.equal(parseCommandLine(['--help']).command, null);
  // A standalone --help / -h before -- wins, also where an option expects a value.
  for (const [argv, path] of [[['prepare', '-f', '--help'], ['prepare']], [['enqueue', '--help', '--key'], ['enqueue']], [['--data-dir', 'x', 'queue', 'read', '-h'], ['queue', 'read']], [['tags', 'a', '--seed', 'zz', '--help'], ['tags']]]) {
    const parsed = parseCommandLine(argv);
    assert.deepEqual([parsed.command?.path, parsed.global.help], [path, true], argv.join(' '));
  }
  assert.equal(parseCommandLine(['material', '-h']).group, 'material');
  assert.deepEqual(parseCommandLine(['call', 'x', '--', '--help']).positionals, { tool: 'x', arguments: '--help' });
  assert.equal(parseCommandLine(['material', '--help']).group, 'material');
  for (const [argv, pattern] of [
    [['nope'], /Unknown command "nope"/], [['material'], /needs a subcommand/], [['material', 'nope'], /needs a subcommand \(not "nope"\)/],
    [['--nope'], /Unknown option --nope/], [['queue', 'list', '--nope'], /Unknown option --nope for nai queue list/],
    [['prepare', '--seed', 'abc'], /--seed takes an integer or null/], [['prepare', '--width', '1.5'], /--width takes an integer/], [['prepare', '--width', '99999999999999999999'], /--width takes an integer/],
    [['enqueue', '--interval', 'x', '--key', 'k'], /--interval takes a number/], [['enqueue', '--wait', 'later', '--key', 'k'], /--wait takes one of done, next/],
    [['queue', 'read'], /needs <batchId>/], [['enqueue'], /needs --key/], [['queue', 'list', 'extra'], /Unexpected argument "extra"/],
    [['prepare', '--file'], /--file needs a value/], [['prepare', '-f', 'a', '-f', 'b'], /--file is given twice/], [['skill', '--pretty=1'], /--pretty takes no value/],
  ]) assert.throws(() => parseCommandLine(argv), error => error instanceof CliUsageError && pattern.test(error.message), argv.join(' '));
});

test('help names every command, option and exit code; every command with a tool is reachable from the overview', () => {
  const overview = helpText();
  for (const command of COMMANDS) assert.ok(overview.includes(`  ${command.path.join(' ')}`), command.path.join(' '));
  for (const name of Object.keys(GLOBAL_OPTIONS)) assert.ok(overview.includes(`--${name}`), name);
  for (const code of ['0 ', '1 ', '2 ', '3 ', '4 ', '130']) assert.ok(overview.includes(`  ${code}`), code);
  const enqueue = helpText(['enqueue']);
  for (const option of ['--key', '--file', '--recipe', '--count', '--seeds', '--group', '--prefix', '--interval', '--wait', '--wait-seconds']) assert.ok(enqueue.includes(option), option);
  assert.match(helpText(['material']), /^Commands of nai material:/);
  assert.throws(() => helpText(['nope']), CliUsageError);
});

test('skill: the guide of this version, with the file workflow, keys, waiting, images, folders and exit codes', () => {
  const guide = skillGuide();
  assert.match(guide, new RegExp(`^# nai ${VERSION.replace(/\./g, '\\.')} `));
  for (const needle of ['nai asset recipe', 'nai prepare -f', '-o prepared.json', 'nai enqueue -f', '--key', '--wait done', 'savedImages', '.tmp/nai-cli', 'novelai/library-inbox', 'novelai/study-inbox', 'pathBase', 'NOVELAI_PROJECT_ROOT', 'nai call', 'nai tools', 'nai env', 'details.autostart'])
    assert.ok(guide.includes(needle), needle);
  // A public guide: no machine-specific paths.
  assert.doesNotMatch(guide, /\/Users\/|\/home\/|[A-Z]:\\\\/);
});

// ------------------------------------------------------------------ folders
test('folders: --data-dir / --project beat the environment, the project root is found from markers, else the data folder\'s workspace', async t => {
  const base = await temp(t);
  const env = { NOVELAI_DATA_DIR: join(base, 'env-data'), NOVELAI_PROJECT_ROOT: join(base, 'env-project') };
  await mkdir(join(base, 'flag-project'));
  assert.deepEqual(resolveCliEnvironment({ global: { 'data-dir': 'flag-data', project: 'flag-project' }, env, cwd: base }),
    { dataRoot: join(base, 'flag-data'), dataSource: '--data-dir', projectRoot: join(base, 'flag-project'), projectSource: '--project' });
  assert.deepEqual(resolveCliEnvironment({ global: {}, env, cwd: base }), { dataRoot: env.NOVELAI_DATA_DIR, dataSource: 'NOVELAI_DATA_DIR', projectRoot: env.NOVELAI_PROJECT_ROOT, projectSource: 'NOVELAI_PROJECT_ROOT' });
  assert.throws(() => resolveCliEnvironment({ global: { project: 'missing' }, env, cwd: base }), error => error.code === 'project_not_found' && !error.message.includes(base));
  // Markers, nearest first: a novelai/<inbox> folder, or an MCP configuration that sets the novelai server's project root.
  const deep = join(base, 'p', 'a', 'b');
  await mkdir(deep, { recursive: true });
  assert.equal(detectProjectRoot(deep), null);
  await mkdir(join(base, 'p', 'novelai', 'study-inbox'), { recursive: true });
  assert.deepEqual(detectProjectRoot(deep), { root: join(base, 'p'), marker: 'novelai/study-inbox', markerPath: join(base, 'p', 'novelai', 'study-inbox') });
  // A configuration without that key is no marker, and nothing else of it is read (its data folder neither).
  await writeFile(join(base, 'p', 'a', '.mcp.json'), JSON.stringify({ mcpServers: { novelai: { command: 'x', env: { NOVELAI_DATA_DIR: '/elsewhere' } } } }));
  assert.deepEqual(detectProjectRoot(deep).root, join(base, 'p'));
  assert.equal(resolveCliEnvironment({ global: {}, env: {}, cwd: deep }).dataRoot, null);
  // With the key: that root, a relative value taken from the configuration's folder; .pi/mcp.json likewise.
  await writeFile(join(base, 'p', 'a', '.mcp.json'), JSON.stringify({ mcpServers: { novelai: { env: { NOVELAI_PROJECT_ROOT: 'studio', NOVELAI_DATA_DIR: '/elsewhere' } } } }));
  assert.deepEqual(resolveCliEnvironment({ global: {}, env: {}, cwd: deep }), { dataRoot: null, dataSource: 'default', projectRoot: join(base, 'p', 'a', 'studio'), projectSource: 'detected', marker: '.mcp.json', markerPath: join(base, 'p', 'a', '.mcp.json') });
  await mkdir(join(deep, '.pi'));
  await writeFile(join(deep, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { novelai: { env: { NOVELAI_PROJECT_ROOT: join(base, 'abs') } } } }));
  assert.deepEqual(detectProjectRoot(deep), { root: join(base, 'abs'), marker: '.pi/mcp.json', markerPath: join(deep, '.pi', 'mcp.json') });
  // In one folder a configuration with the key comes before an inbox; ${VAR} and ${VAR:-default} are expanded, and an
  // unresolved or empty value is no marker (the search goes on, nothing is made).
  const both = join(base, 'both', 'deeper');
  await mkdir(join(base, 'both', 'novelai', 'library-inbox'), { recursive: true });
  await mkdir(both, { recursive: true });
  const config = value => writeFile(join(base, 'both', '.mcp.json'), JSON.stringify({ mcpServers: { novelai: { env: { NOVELAI_PROJECT_ROOT: value } } } }));
  await config('${NAI_TEST_HOME}/studio');
  assert.deepEqual(detectProjectRoot(both, { NAI_TEST_HOME: join(base, 'home') }), { root: join(base, 'home', 'studio'), marker: '.mcp.json', markerPath: join(base, 'both', '.mcp.json') });
  assert.equal(resolveCliEnvironment({ global: {}, env: { NAI_TEST_HOME: join(base, 'h2') }, cwd: both }).projectRoot, join(base, 'h2', 'studio'), 'expanded with the environment nai runs in');
  await config('${NAI_TEST_UNSET:-fallback}');
  assert.equal(detectProjectRoot(both, {}).root, join(base, 'both', 'fallback'));
  for (const unresolved of ['${NAI_TEST_UNSET}/x', '${NAI_TEST_EMPTY:-}', '   ']) {
    await config(unresolved);
    assert.deepEqual(detectProjectRoot(both, { NAI_TEST_EMPTY: '' }), { root: join(base, 'both'), marker: 'novelai/library-inbox', markerPath: join(base, 'both', 'novelai', 'library-inbox') }, unresolved);
  }
  assert.equal(existsSync(join(base, 'both', '${NAI_TEST_UNSET}')), false);
  // A linked inbox counts like any folder.
  const own = join(base, 'q');
  await mkdir(join(base, 'target', 'library-inbox'), { recursive: true });
  await mkdir(join(own, 'novelai'), { recursive: true });
  await symlink(join(base, 'target', 'library-inbox'), join(own, 'novelai', 'library-inbox'));
  assert.equal(resolveCliEnvironment({ global: {}, env: {}, cwd: own }).projectRoot, own);
  assert.throws(() => resolveCliEnvironment({ global: { 'image-dir': '' }, env: {}, cwd: own }), error => error.code === 'usage');
  // apply: absolute folders in, ELECTRON_RUN_AS_NODE out (it must reach no process nai starts).
  const target = { ELECTRON_RUN_AS_NODE: '1', NOVELAI_PROJECT_ROOT: 'stale' };
  applyCliEnvironment({ dataRoot: '/d', projectRoot: null }, target);
  assert.deepEqual(target, { NOVELAI_DATA_DIR: '/d' });
});

test('nai env as a process: every layer sees the same data folder and project root, decided before the business modules load', async t => {
  const base = await temp(t);
  const data = join(base, 'data'), project = join(base, 'project');
  await mkdir(project);
  const flags = await run(['--data-dir', 'data', '--project', 'project', 'env'], { cwd: base, env: { NOVELAI_DATA_DIR: join(base, 'other'), NOVELAI_PROJECT_ROOT: join(base, 'other-project') } });
  assert.equal(flags.code, EXIT.ok, flags.stdout + flags.stderr);
  assert.equal(flags.json.dataRoot, data); assert.equal(flags.json.projectRoot, project);
  assert.deepEqual(flags.json.folders, { materialInbox: join(project, 'novelai', 'library-inbox'), materialExports: join(project, 'novelai', 'library-exports'), studyInbox: join(project, 'novelai', 'study-inbox'), studyExports: join(project, 'novelai', 'study-exports') });
  assert.equal(flags.json.imageDir, join(project, '.tmp', 'nai-cli'));
  assert.deepEqual([flags.json.runtime, flags.json.app], ['node', { startable: false, reason: 'not_electron' }]);
  // Detected from the working directory; without anything, the data folder's workspace.
  await mkdir(join(project, 'novelai', 'library-inbox'), { recursive: true });
  const detected = await run(['--data-dir', data, 'env'], { cwd: join(project, 'novelai') });
  assert.deepEqual([detected.json.projectRoot, detected.json.projectSource, detected.json.projectMarker], [project, 'detected', 'novelai/library-inbox']);
  const fallback = await run(['--data-dir', data, 'env'], { cwd: base });
  assert.deepEqual([fallback.json.projectRoot, fallback.json.projectSource], [join(data, 'workspace'), 'data-dir-workspace']);
  // The bridge client of the same process reads bridge.json of that data folder (and nothing was created there by env).
  assert.equal(existsSync(data), false, 'env creates nothing');
  const requests = await bridgeDouble(t, data, () => ({ ok: true, result: { batches: [] } }));
  const listed = await run(['--data-dir', 'data', 'queue', 'list'], { cwd: base });
  assert.equal(listed.code, EXIT.ok, listed.stdout + listed.stderr);
  assert.deepEqual(listed.json, { total: 0, byStatus: {}, batches: [] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'list_queue'); assert.equal(requests[0].authorization, `Bearer ${'t'.repeat(64)}`);
  assert.deepEqual(requests[0].caller.client, { name: 'nai-cli', version: VERSION }); assert.equal(requests[0].caller.tool, 'list_queue');
  // --project that does not exist: a usage error, nothing sent.
  const missing = await run(['--data-dir', data, '--project', 'nowhere', 'queue', 'list'], { cwd: base });
  assert.equal(missing.code, EXIT.usage); assert.equal(missing.json.error.code, 'project_not_found'); assert.equal(requests.length, 1);
});

// ------------------------------------------------------------------ offline answers
test('--help, help, skill and --version read and start nothing: no business module loads, no bridge is asked, no folder is made', async t => {
  const base = await temp(t);
  const data = join(base, 'data');
  const requests = await bridgeDouble(t, data, () => ({ ok: true, result: {} }));
  const before = await readdir(data, { recursive: true });
  // A load hook lists every module the process loads.
  const hook = join(base, 'hook.mjs');
  await writeFile(hook, `import { registerHooks } from 'node:module';\nregisterHooks({ load(url, context, next) { if (url.startsWith('file:')) process.stderr.write('LOAD ' + url + '\\n'); return next(url, context); } });\n`);
  for (const argv of [['--help'], ['help', 'enqueue'], ['enqueue', '--help'], ['material', '--help'], ['skill'], ['--version'], ['version'], ['--data-dir', data, '--project', 'missing', 'skill'],
    ['prepare', '-f', '--help'], ['enqueue', '--help', '--key'], ['--data-dir', data, 'enqueue', '--key', 'k', '-f', 'x.json', '--wait', 'done', '-h']]) {
    // The test-run marker makes any default-data-root lookup throw: a business module loading here would fail the run.
    const result = await run(argv, { cwd: base, env: { NODE_TEST_CONTEXT: 'child' }, nodeArgs: ['--import', pathToFileURL(hook).href] });
    assert.equal(result.code, EXIT.ok, `${argv.join(' ')}: ${result.stdout}${result.stderr}`);
    const loaded = result.stderr.split('\n').filter(line => line.startsWith('LOAD ')).map(line => line.slice(5).split('/').pop());
    assert.deepEqual(loaded.filter(name => !['cli.mjs', 'cli-spec.mjs', 'cli-env.mjs', 'cli-guide.mjs', 'version.mjs', 'data-paths.cjs', 'hook.mjs'].includes(name)), [], `${argv.join(' ')} loaded ${loaded.join(', ')}`);
  }
  assert.equal((await run(['--version'], { cwd: base })).stdout, `${VERSION}\n`);
  assert.match((await run(['skill'], { cwd: base })).stdout, /^# nai /);
  assert.deepEqual(requests, []);
  assert.deepEqual(await readdir(data, { recursive: true }), before);
  assert.deepEqual((await readdir(base)).sort(), ['data', 'hook.mjs']);
});

// ------------------------------------------------------------------ errors, inputs, interruption
test('exit codes and envelopes: usage 2, tool error 1 (scrubbed by the server), unavailable when no app runs', async t => {
  const base = await temp(t);
  const data = join(base, 'data');
  const usage = await run(['--data-dir', data, 'queue', 'list', '--bogus'], { cwd: base });
  assert.equal(usage.code, EXIT.usage); assert.deepEqual(Object.keys(usage.json), ['ok', 'error']); assert.equal(usage.json.error.code, 'usage');
  // No app: unavailable, nothing started (automatic start is off here).
  const none = await run(['--data-dir', data, 'queue', 'list'], { cwd: base });
  assert.equal(none.code, EXIT.toolError); assert.equal(none.json.error.code, 'unavailable'); assert.equal(none.json.error.details.autostart, 'off');
  // A host error that names an absolute path and a credential: the server's envelope scrubs both.
  await bridgeDouble(t, data, () => ({ ok: false, error: { code: 'queue_storage_failed', message: `Cannot write ${join(base, 'secret dir', 'queue.json')} with token=abcdef123456` } }));
  const failed = await run(['--data-dir', data, 'queue', 'list'], { cwd: base });
  assert.equal(failed.code, EXIT.toolError, failed.stdout);
  assert.equal(failed.json.error.code, 'queue_storage_failed');
  assert.ok(!failed.json.error.message.includes(base) && !failed.stdout.includes('secret dir') && !failed.stdout.includes('abcdef123456'), failed.stdout);
  assert.equal(failed.stderr, '');
});

test('inputs: stdin with -, @file, size limit and invalid JSON are refused before anything is sent', async t => {
  const base = await temp(t);
  const data = join(base, 'data');
  const requests = await bridgeDouble(t, data, () => ({ ok: true, result: { batches: [] } }));
  const viaStdin = await run(['--data-dir', data, 'call', 'list_queue', '-'], { cwd: base, stdin: '{}' });
  assert.equal(viaStdin.code, EXIT.ok, viaStdin.stdout); assert.equal(requests.length, 1);
  await writeFile(join(base, 'big.json'), `{"x":"${'a'.repeat(16 * 1024 * 1024)}"}`);
  const big = await run(['--data-dir', data, 'call', 'list_queue', '@big.json'], { cwd: base });
  assert.equal(big.code, EXIT.usage); assert.equal(big.json.error.code, 'input_too_large');
  await writeFile(join(base, 'bad.json'), '{"x":');
  const bad = await run(['--data-dir', data, 'prepare', '-f', 'bad.json'], { cwd: base });
  assert.equal(bad.code, EXIT.usage); assert.equal(bad.json.error.code, 'invalid_json');
  // The parse error names the file as given and where, never what the file holds.
  await writeFile(join(base, 'secret.json'), 'sk-THE-SECRET-VALUE');
  const secret = await run(['--data-dir', data, 'call', 'list_queue', `@${join(base, 'secret.json')}`], { cwd: base });
  assert.equal(secret.json.error.code, 'invalid_json');
  assert.ok(!secret.stdout.includes('THE-SECRET') && secret.json.error.message.includes(JSON.stringify(join(base, 'secret.json'))), secret.stdout);
  assert.match(secret.json.error.message, /not valid JSON( at (line \d+, column \d+|position \d+))?\. Nothing was sent\.$/);
  const empty = await run(['--data-dir', data, '--image-dir', '', 'queue', 'list'], { cwd: base });
  assert.equal(empty.code, EXIT.usage); assert.match(empty.json.error.message, /--image-dir needs a folder/);
  const directory = await run(['--data-dir', data, 'prepare', '-f', '.'], { cwd: base });
  assert.equal(directory.code, EXIT.usage); assert.equal(directory.json.error.code, 'file_unavailable');
  const array = await run(['--data-dir', data, 'prepare', '-f', '-'], { cwd: base, stdin: '[]' });
  assert.equal(array.code, EXIT.usage); assert.match(array.json.error.message, /one JSON object/);
  assert.equal(requests.length, 1, 'only the first call reached the bridge');
});

// Windows has no SIGINT to send to another process (kill ends it at once), so this runs on macOS and Linux.
test('SIGINT during a wait: the call is cancelled, exit 130 with an interrupted envelope', { skip: process.platform === 'win32' }, async t => {
  const base = await temp(t);
  const data = join(base, 'data');
  const batchId = '0b4d4a50-1c0e-4c7e-9a52-6c2f5d1e7a10';
  let first;
  const arrived = new Promise(done => { first = done; });
  await bridgeDouble(t, data, (method, args) => {
    first();
    return { ok: true, result: { batchId: args.batchId, execution: 'queued', status: 'running', count: 1, items: [{ index: 0, status: 'running', results: [] }] } };
  });
  const result = await run(['--data-dir', data, 'queue', 'read', batchId, '--wait', 'done', '--wait-seconds', '60'], { cwd: base, onSpawn: child => { arrived.then(() => setTimeout(() => child.kill('SIGINT'), 200)); } });
  assert.equal(result.code, EXIT.interrupted, result.stdout + result.stderr);
  assert.equal(result.json.error.code, 'interrupted');
  assert.match(result.json.error.message, /read the current state/);
});

// ------------------------------------------------------------------ recipe files
test('recipe files: a history read becomes prepare_recipe arguments of the mode; receipts become enqueue items', () => {
  const view = { kind: 'history', id: 'h', revision: 3, assetId: 'path:h', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, mode: 't2i', actualSeed: 99,
    params: { stylePrompt: 's', positivePrompt: 'p', negativePrompt: '', steps: 23, cfgScale: 5, sampler: 'k_euler', noiseSchedule: 'karras', ucPreset: 0, qualityToggle: false, seedMode: 'random', variety: true, transparentBackground: true },
    characters: [{ prompt: 'a' }, { prompt: 'b', negativePrompt: 'n', x: 0.1, y: 0.9 }] };
  const t2i = historyToRecipe(view);
  assert.deepEqual(t2i.recipe, { mode: 't2i', model: 'nai-diffusion-4-5-full', width: 1024, height: 1024, stylePrompt: 's', positivePrompt: 'p', negativePrompt: '', steps: 23, cfgScale: 5, sampler: 'k_euler', noiseSchedule: 'karras', ucPreset: 0,
    transparentBackground: true, qualityPreset: 'none', seed: 99, characters: [{ prompt: 'a', useCoords: false }, { prompt: 'b', negativePrompt: 'n', useCoords: true, x: 0.1, y: 0.9 }] });
  assert.deepEqual([t2i.dropped, t2i.missing, t2i.warnings], [['variety'], [], []]);
  // How an image was made decides what its recipe can be.
  assert.throws(() => historyToRecipe({ ...view, mode: 'upscale' }), error => error.code === 'recipe_not_reproducible');
  assert.throws(() => historyToRecipe({ ...view, mode: 'director', model: 'director-lineart' }), error => error.code === 'recipe_not_reproducible');
  assert.throws(() => historyToRecipe({ ...view, mode: undefined, model: 'upscale' }), error => error.code === 'recipe_not_reproducible');
  assert.deepEqual(historyToRecipe({ ...view, mode: undefined }).warnings.map(warning => warning.code), ['mode_unknown']);
  const medium = historyToRecipe({ ...view, model: 'nai-diffusion-5-full-medium-inpainting', mode: 'inpaint' });
  assert.deepEqual([medium.recipe.model, medium.recipe.effort, medium.recipe.steps, medium.missing], ['nai-diffusion-5-full', 'medium', undefined, []]);
  assert.deepEqual(medium.warnings.map(warning => warning.code), ['model_normalized', 'source_not_included']);
  assert.equal(historyToRecipe(view, { randomSeed: true }).recipe.seed, null);
  const i2i = historyToRecipe(view, { mode: 'i2i' });
  assert.deepEqual(i2i.recipe.source, { kind: 'history', historyId: 'h', historyRevision: 3, assetId: 'path:h' });
  assert.equal(i2i.recipe.transparentBackground, undefined); assert.deepEqual(i2i.missing, ['strength']);
  const enhance = historyToRecipe(view, { mode: 'enhance' });
  assert.equal(enhance.recipe.width, undefined); assert.deepEqual(enhance.missing, ['magnitude', 'scale']);
  assert.deepEqual(parseSetValue('20'), 20); assert.deepEqual(parseSetValue('"x"'), 'x'); assert.deepEqual(parseSetValue('a, b'), 'a, b'); assert.deepEqual(parseSetValue('null'), null);
  const receipt = { recipeId: '0b4d4a50-1c0e-4c7e-9a52-6c2f5d1e7a10', recipeRevision: 2, inputHash: 'a'.repeat(64), mode: 't2i', ready: true };
  assert.deepEqual(enqueueItemsFromFile(receipt, 'f'), [{ recipeId: receipt.recipeId, recipeRevision: 2, inputHash: receipt.inputHash }]);
  assert.deepEqual(enqueueItemsFromFile({ items: [{ ...receipt, count: 3 }] }, 'f'), [{ recipeId: receipt.recipeId, recipeRevision: 2, inputHash: receipt.inputHash, count: 3 }]);
  assert.equal(enqueueItemsFromFile([receipt, receipt], 'f').length, 2);
  assert.throws(() => enqueueItemsFromFile({ preview: true, ready: true }, 'f'), /preview is not saved/);
  assert.throws(() => enqueueItemsFromFile([], 'f'), /lists no recipe/);
  assert.deepEqual(enqueueItemFromArgument(`${receipt.recipeId}:2:${receipt.inputHash}`), { recipeId: receipt.recipeId, recipeRevision: 2, inputHash: receipt.inputHash });
  for (const bad of ['x', `${receipt.recipeId}:two:${receipt.inputHash}`, `${receipt.recipeId}:2:${receipt.inputHash}:x`]) assert.throws(() => enqueueItemFromArgument(bad));
});

// ------------------------------------------------------------------ the app the command line belongs to
test('the command-line bundle next to the MCP server is recognized as the app\'s own (packaged and source), wherever the launcher was linked from', () => {
  const electron = { node: '24.0.0', electron: '42.0.0' };
  const files = list => file => list.includes(file);
  const macExe = '/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI';
  assert.deepEqual(resolveOwnApp({ platform: 'darwin', versions: electron, execPath: macExe, moduleFile: '/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-cli.mjs', exists: files([macExe]) }),
    { ok: true, kind: 'packaged', platform: 'darwin', executable: macExe, args: [], macApp: '/Applications/MCP for NovelAI.app' });
  const winExe = 'C:\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe';
  assert.equal(resolveOwnApp({ platform: 'win32', versions: electron, execPath: winExe, moduleFile: 'C:\\Programs\\MCP for NovelAI\\resources\\mcp\\novelai-cli.mjs', exists: files([winExe]) }).ok, true);
  const client = '/repo/novelai/client', dev = `${client}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`;
  const source = resolveOwnApp({ platform: 'darwin', versions: electron, execPath: dev, moduleFile: `${client}/dist-mcp/novelai-cli.mjs`, readText: () => 'Electron.app/Contents/MacOS/Electron', realpath: file => file,
    exists: files([`${client}/package.json`, `${client}/dist-electron/electron/bootstrap.js`, dev]) });
  assert.deepEqual(source, { ok: true, kind: 'source', platform: 'darwin', executable: dev, args: [client], macApp: `${client}/node_modules/electron/dist/Electron.app` });
});

// ------------------------------------------------------------------ the working directory
test('a working directory that is gone: one JSON error, exit 4, no stack trace', { skip: process.platform === 'win32' }, async t => {
  const base = await temp(t);
  const gone = join(base, 'gone');
  await mkdir(gone);
  const result = await new Promise((done, fail) => {
    // The shell enters the folder, removes it, then starts nai there.
    const child = spawn('/bin/sh', ['-c', `cd "${gone}" && rmdir "${gone}" && exec "${process.execPath}" "${CLI}" --data-dir "${join(base, 'data')}" queue list`], { env: { PATH: process.env.PATH ?? '', NOVELAI_MCP_AUTOSTART: '0' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', fail); child.on('close', code => done({ code, stdout, stderr }));
  });
  assert.equal(result.code, EXIT.internal, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, 'cwd_unavailable');
  assert.equal(result.stderr, '');
  // The offline answers need no working directory.
  for (const [argv, expect] of [[['--version'], `${VERSION}\n`], [['--help'], /^nai — /], [['skill'], /^# nai /]]) {
    await mkdir(gone);
    const offline = await new Promise((done, fail) => {
      const child = spawn('/bin/sh', ['-c', `cd "${gone}" && rmdir "${gone}" && exec "${process.execPath}" "${CLI}" ${argv.join(' ')}`], { env: { PATH: process.env.PATH ?? '' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', fail); child.on('close', code => done({ code, stdout, stderr }));
    });
    assert.equal(offline.code, EXIT.ok, argv.join(' ') + offline.stdout + offline.stderr);
    if (typeof expect === 'string') assert.equal(offline.stdout, expect); else assert.match(offline.stdout, expect);
    assert.equal(offline.stderr, '');
  }
});

test('@file from a process substitution, as a shell passes it', { skip: process.platform === 'win32' || !existsSync('/bin/bash') }, async t => {
  const base = await temp(t);
  const data = join(base, 'data');
  const requests = await bridgeDouble(t, data, () => ({ ok: true, result: { batches: [] } }));
  const result = await new Promise((done, fail) => {
    const child = spawn('/bin/bash', ['-c', `exec "${process.execPath}" "${CLI}" --data-dir "${data}" call list_queue @<(printf '{}')`], { cwd: base, env: { PATH: process.env.PATH ?? '', NOVELAI_MCP_AUTOSTART: '0' } });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.on('error', fail); child.on('close', code => done({ code, stdout }));
  });
  assert.equal(result.code, EXIT.ok, result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { total: 0, byStatus: {}, batches: [] });
  assert.equal(requests.length, 1);
});
