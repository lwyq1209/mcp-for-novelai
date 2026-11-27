// nai in process (src/cli.mjs main): every command goes through the MCP server's own registry over an in-memory MCP
// client, here with a bridge double. The recipe methods are the REAL client queue-recipe service
// (client/electron/queue-recipe-service.ts through jiti, as in mcp-business-recipes.test.mjs), so the file workflow —
// recipe from a history image, a local edit, prepare, enqueue --wait — runs against the host's own checks.
// Offline: fetch refused, tag cache redirected, every folder temporary.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-cli-flow-cache-'));
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in nai tests.'); };

const { createJiti } = await import('jiti');
const { main } = await import('../src/cli.mjs');
const { BridgeError } = await import('../src/bridge-client.mjs');
const { EXIT } = await import('../src/cli-spec.mjs');
const { REFERENCES_NOTE } = await import('../src/cli-recipe.mjs');

let createQueueRecipeService, queueBridgeError, fixtureDir;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'novelai-cli-flow-host-'));
  const electron = join(fixtureDir, 'electron.mjs'), axios = join(fixtureDir, 'axios.mjs');
  await writeFile(electron, `const forbidden = () => { throw new Error('recipe fixture cannot access native UI or account paths'); };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};
export const nativeImage = { createFromBuffer: forbidden, createFromPath: forbidden };`);
  await writeFile(axios, `const forbidden = () => { throw new Error('recipe fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: { electron, axios } });
  ({ createQueueRecipeService } = await jiti.import(fileURLToPath(new URL('../client/electron/queue-recipe-service.ts', import.meta.url))));
  ({ queueBridgeError } = await jiti.import(fileURLToPath(new URL('../client/electron/queue-bridge-error.ts', import.meta.url))));
});
after(async () => {
  globalThis.fetch = originalFetch;
  await rm(tagCacheDir, { recursive: true, force: true });
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const PROMPT = '1girl, garden, wide shot from across the pond, long shadows, soft warm light';
const STUDY = '0b4d4a50-1c0e-4c7e-9a52-6c2f5d1e7a10';
const ENTRY = '12345678-1234-1234-1234-123456789abc';

/** A history image as the host's asset_library read returns it (the record the compact view is made from). */
const historyRecord = (id, project) => ({
  item: { kind: 'history', id, revision: 2, name: `${id}.png`, createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:01.000Z', archived: false, schemaVersion: 1, source: { namespace: 'history', legacyId: id },
    preview: { assetId: `path:${id}`, role: 'original', cacheKey: 'k'.repeat(64), width: 832, height: 1216 },
    payload: { id, date: '2026-11-13', createdAt: '2026-11-13T00:00:00.000Z', groupId: 'g-1', model: 'nai-diffusion-5-full', width: 832, height: 1216, actualSeed: 4242, filePath: join(project, 'out', `${id}.png`),
      params: { model: 'nai-diffusion-5-full', promptAssemblyVersion: 1, stylePrompt: 'watercolor', positivePrompt: PROMPT, negativePrompt: 'blurry', width: 832, height: 1216, steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral',
        noiseSchedule: 'karras', seed: 4242, seedMode: 'fixed', ucPreset: 2, qualityPreset: 'standard', qualityToggle: true, transparentBackground: false, smea: false, smeaDyn: false, variety: false, fileNamePrefix: '' },
      characterSnapshot: { version: 1, captions: [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }] }, generationOrigin: { mode: 't2i', actualSeed: 4242 } } },
  tags: [], assets: [], links: [], memberships: [{ namespace: 'history', collectionId: 'g-1', kind: 'history', id }], tagCoverage: {},
});
const historyImage = (request, bytes = PNG) => ({ kind: request.kind, id: request.id, revision: request.revision, assetId: request.assetId ?? `path:${request.id}`, role: 'original', variant: request.variant ?? 'thumbnail',
  mimeType: 'image/png', width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, sourceMimeType: 'image/png', byteLength: bytes.length, sourceByteLength: bytes.length,
  sha256: sha(bytes), sourceSha256: sha(bytes), contentBinding: 'read-time-sha256', data: bytes.toString('base64') });

/**
 * The host: the real queue-recipe service for the recipe methods (with an in-memory batch backend whose batches
 * finish at once), and small doubles for the library, studies, materials, the queue reads and the canvas.
 */
async function host(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'novelai-cli-flow-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const runtimeDir = join(base, 'runtime'), project = join(base, 'project'), data = join(base, 'data');
  for (const dir of [runtimeDir, project, data, join(project, 'novelai', 'library-inbox'), join(project, 'novelai', 'library-exports'), join(project, 'novelai', 'study-inbox'), join(project, 'novelai', 'study-exports')]) await mkdir(dir, { recursive: true });
  const jobs = [];
  const backend = {
    ready: Promise.resolve(),
    async enqueue(args) {
      const job = { batchId: randomUUID(), requestKey: args.requestKey, execution: args.execution, status: 'queued', count: args.count, intervalSeconds: args.intervalSeconds,
        originWorkspaceId: args.workspaceId, submittedRevision: args.expectedRevision, mode: args.mode, activeJobId: null,
        items: args.seeds.map((seed, index) => ({ index, status: 'queued', jobId: null, seed, results: [] })) };
      jobs.push({ job, args: json(args) });
      return structuredClone(job);
    },
    lookup: args => structuredClone(jobs.find(entry => entry.job.requestKey === args.requestKey)?.job ?? null),
    list: () => ({ batches: jobs.map(entry => structuredClone(entry.job)) }),
    read: args => structuredClone(jobs.find(entry => entry.job.batchId === args.batchId)?.job),
  };
  const service = createQueueRecipeService({ runtimeDir, batch: backend, randomSeed: () => 777 });
  const calls = [], histories = {}, held = new Map();
  /** The batch as the host reads it once it ran: every item saved one image into the project. */
  const finished = batchId => {
    const entry = jobs.find(item => item.job.batchId === batchId);
    if (!entry) throw new BridgeError('batch_not_found', 'No such batch.');
    const job = structuredClone(entry.job);
    job.status = 'succeeded';
    job.items = job.items.map(item => ({ ...item, status: 'succeeded', results: [{ index: 0, id: `hist-${batchId.slice(0, 4)}-${item.index}`, actualSeed: item.seed, filePath: join(project, 'out', `img-${item.index}.png`) }] }));
    return job;
  };
  const handlers = {
    asset_library(args) {
      if (args.action === 'read' && args.kind === 'history') return histories[args.id] ?? historyRecord(args.id, project);
      if (args.action === 'read' && args.kind === 'study') return { item: { kind: 'study', id: args.id, revision: 3, name: 'study', payload: {} }, responseInfo: {} };
      if (args.action === 'image') return historyImage(args);
      throw new BridgeError('unsupported', `asset_library ${args.action} is not in this double.`);
    },
    read_queue: args => finished(args.batchId),
    get_queue_result: args => ({ variant: args.variant, mimeType: 'image/png', data: PNG.toString('base64'), width: 1, height: 1, index: args.index, historyId: finished(args.batchId).items[args.itemIndex].results[0].id, filePath: join(project, 'out', `img-${args.itemIndex}.png`) }),
    material_studies: args => args.action === 'image' ? { id: args.id, revision: 1, mimeType: 'image/jpeg', data: JPEG.toString('base64') }
      : args.action === 'import' ? { study: { id: randomUUID(), revision: 1, name: args.name, sha256: sha(Buffer.from(args.data, 'base64')), metadataStatus: 'missing', metadataKind: 'unknown' } } : { items: [], total: 0 },
    material_samples: args => args.action === 'cover' ? { entryId: args.entryId, coverRevision: 1, mimeType: 'image/png', data: PNG.toString('base64') }
      : args.action === 'set_local_cover' ? { entryId: args.entryId, entryRevision: args.revision, coverRevision: args.expectedCoverRevision + 1, coverStatus: 'ready', cover: { source: 'local', rating: null } } : {},
    material_library: args => args.action === 'import' ? { imported: args.data?.entries?.length ?? 0 } : {},
    list_workspaces: () => ({ workspaces: [{ workspaceId: 'w1' }] }),
    read_workspace: () => ({ workspaceId: 'w1', revision: 3, state: { params: { positivePrompt: 'a harbor' }, activeTab: 'generate' }, assets: [{ id: 'a1', role: 'currentImage' }, { id: 'a2', role: 'workbenchImage' }], activeImageAssetId: 'a1' }),
    get_asset: args => ({ assetId: args.assetId, mimeType: 'image/png', data: PNG.toString('base64') }),
  };
  const bridge = { async call(method, args, signal, caller) {
    calls.push({ method, args: structuredClone(args), caller });
    // A held method never answers; its listener learns that the call arrived.
    if (held.has(method)) { held.get(method)(); return new Promise(() => undefined); }
    if (handlers[method]) return json(await handlers[method](args));
    if (typeof service[method] !== 'function') throw new BridgeError('unknown_method', 'No such host method.');
    try { return json(await service[method](json(args))); }
    catch (error) { const bridged = queueBridgeError(error); throw new BridgeError(bridged.code, bridged.message, bridged.details); }
  } };
  /** Runs nai like a terminal would, in `cwd`; returns {code, out (parsed JSON), text}. */
  const nai = async (argv, { cwd = project, env = {}, signals = false } = {}) => {
    let text = '';
    const code = await main(['--data-dir', data, '--project', project, ...argv], { cwd, env: { ...env }, signals, stdout: chunk => { text += chunk; },
      runOptions: { serverOptions: { bridgeClient: bridge, projectRoot: project, recipeQueue: { sleep: async () => undefined } }, projectRoot: project } });
    let out;
    try { out = JSON.parse(text); } catch { out = undefined; }
    return { code, out, text };
  };
  return { base, project, data, jobs, calls, histories, held, bridge, nai, methods: () => calls.map(call => call.method) };
}

test('nai file workflow: recipe from a history image → local edit → prepare -o → enqueue --wait done → queue result thumbnails, all through the MCP tools', async t => {
  const h = await host(t);
  // 1. The recipe file: prompts go into the file, the terminal gets a summary.
  const recipe = await h.nai(['asset', 'recipe', 'h0', '-o', 'draft.json']);
  assert.equal(recipe.code, EXIT.ok, recipe.text);
  assert.deepEqual(recipe.out, { file: join(h.project, 'draft.json'), historyId: 'h0', revision: 2, assetId: 'path:h0', madeWith: 't2i', mode: 't2i', model: 'nai-diffusion-5-full', width: 832, height: 1216, seed: 4242, characters: 1,
    promptChars: 'watercolor'.length + PROMPT.length + 'girl, red dress'.length, references: REFERENCES_NOTE, next: 'nai prepare -f draft.json' });
  assert.equal(recipe.text.includes(PROMPT), false, 'the prompt is never printed');
  const draft = JSON.parse(await readFile(join(h.project, 'draft.json'), 'utf8'));
  assert.deepEqual(draft, { mode: 't2i', model: 'nai-diffusion-5-full', width: 832, height: 1216, stylePrompt: 'watercolor', positivePrompt: PROMPT, negativePrompt: 'blurry', steps: 28, cfgScale: 5, cfgRescale: 0,
    sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 2, qualityPreset: 'standard', seed: 4242, characters: [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }] });
  // Outputs are replaced like any command-line tool's, and missing folders are made.
  await writeFile(join(h.project, 'draft.json'), 'old');
  const again = await h.nai(['asset', 'recipe', 'h0', '-o', 'draft.json']);
  assert.equal(again.code, EXIT.ok, again.text);
  assert.deepEqual(JSON.parse(await readFile(join(h.project, 'draft.json'), 'utf8')), draft);
  const nested = await h.nai(['asset', 'recipe', 'h0', '-o', join('drafts', 'deep', 'h0.json')]);
  assert.equal(nested.code, EXIT.ok, nested.text); assert.equal(nested.out.file, join(h.project, 'drafts', 'deep', 'h0.json'));

  // 2. A local edit of a few tags (what an agent does with its editor).
  draft.positivePrompt = draft.positivePrompt.replace('garden', 'rooftop garden');
  await writeFile(join(h.project, 'draft.json'), JSON.stringify(draft, null, 2));

  // 3. prepare -f with an override, receipt to a file; the readback is the compact one.
  const prepared = await h.nai(['prepare', '-f', 'draft.json', '-o', 'prepared.json', '--seed', 'null']);
  assert.equal(prepared.code, EXIT.ok, prepared.text);
  assert.equal(prepared.out.receiptFile, join(h.project, 'prepared.json'));
  assert.match(prepared.out.recipeId, /^[a-f0-9-]{36}$/);
  assert.equal(prepared.text.includes('rooftop garden'), false, 'nothing the call wrote is echoed');
  const receipt = JSON.parse(await readFile(join(h.project, 'prepared.json'), 'utf8'));
  assert.deepEqual(receipt, { recipeId: prepared.out.recipeId, recipeRevision: 1, inputHash: prepared.out.inputHash, mode: 't2i', ready: true });
  const put = h.calls.find(call => call.method === 'put_queue_recipe');
  assert.equal(put.args.seed ?? put.args.recipe?.seed ?? null, null);
  assert.ok(JSON.stringify(put.args).includes('rooftop garden'), 'the edited file is what was prepared');

  // 4. enqueue -f --wait done: one command enqueues and returns the finished batch.
  const enqueued = await h.nai(['enqueue', '-f', 'prepared.json', '--key', 'cli-flow-1', '--count', '2', '--prefix', 'proj', '--wait', 'done', '--wait-seconds', '5']);
  assert.equal(enqueued.code, EXIT.ok, enqueued.text);
  assert.equal(enqueued.out.enqueue.status, 'enqueued');
  const batchId = enqueued.out.enqueue.batchId;
  assert.equal(enqueued.out.batch.batchId, batchId);
  assert.equal(enqueued.out.batch.status, 'succeeded');
  assert.equal(enqueued.out.batch.wait.ended, 'done');
  assert.deepEqual(enqueued.out.batch.results.map(result => result.file), ['out/img-0.png', 'out/img-1.png']);
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].args.seeds.length, 2);
  // The same key and plan again never queues twice.
  const repeated = await h.nai(['enqueue', '-f', 'prepared.json', '--key', 'cli-flow-1', '--count', '2', '--prefix', 'proj']);
  assert.equal(repeated.code, EXIT.ok, repeated.text); assert.equal(repeated.out.status, 'already_enqueued'); assert.equal(h.jobs.length, 1);

  // 5. queue result: the thumbnails are files, each result names its own.
  const results = await h.nai(['queue', 'result', batchId]);
  assert.equal(results.code, EXIT.ok, results.text);
  assert.equal(results.text.includes(PNG.toString('base64')), false, 'no image bytes on stdout');
  assert.equal(results.out.savedImages.length, 2);
  for (const [index, result] of results.out.results.entries()) {
    assert.equal(result.image, results.out.savedImages[index].file);
    assert.ok(result.image.startsWith(join(h.project, '.tmp', 'nai-cli', 'queue-')) && /-\d{8}-\d{6}-[a-f0-9]{6}-\d\.png$/.test(result.image), result.image);
    assert.deepEqual(await readFile(result.image), PNG);
  }
  // Every host call was made inside a tool call of the registry, by the nai-cli client.
  assert.ok(h.calls.every(call => call.caller?.client?.name === 'nai-cli' && typeof call.caller.tool === 'string' && typeof call.caller.callId === 'string'), JSON.stringify(h.calls.map(call => call.caller)));
  assert.deepEqual([...new Set(h.calls.map(call => call.caller.tool))].sort(), ['asset_library', 'enqueue_recipes', 'get_queue_result', 'prepare_recipe', 'read_queue']);
});

test('nai enqueue: several -f files and --recipe, --seeds, and the errors that stop before anything is sent', async t => {
  const h = await host(t);
  const base = JSON.parse(JSON.stringify((await h.nai(['asset', 'recipe', 'h1', '-o', 'a.json'])).out));
  assert.equal(base.file, join(h.project, 'a.json'));
  const first = await h.nai(['prepare', '-f', 'a.json', '-o', 'p1.json']);
  const second = await h.nai(['prepare', '-f', 'a.json', '--set', 'steps=20', '--set', 'negativePrompt="lowres"', '-o', 'p2.json']);
  assert.equal(second.code, EXIT.ok, second.text);
  const lastPut = JSON.stringify(h.calls.filter(call => call.method === 'put_queue_recipe').at(-1).args);
  assert.ok(lastPut.includes('"steps":20') && lastPut.includes('"negativePrompt":"lowres"'), '--set values are JSON (or text) top-level fields');
  // One file with an array of receipts and one --recipe on the command line.
  await writeFile(join(h.project, 'both.json'), JSON.stringify([JSON.parse(await readFile(join(h.project, 'p1.json'), 'utf8'))]));
  const p2 = JSON.parse(await readFile(join(h.project, 'p2.json'), 'utf8'));
  const p1 = JSON.parse(await readFile(join(h.project, 'p1.json'), 'utf8'));
  await writeFile(join(h.project, 'counted.json'), JSON.stringify({ ...p1, count: 3 }));
  await writeFile(join(h.project, 'seeded.json'), JSON.stringify({ ...p1, seeds: [1, 2] }));
  await symlink(join(h.project, 'a.json'), join(h.project, 'a-link.json'));
  const draftBytes = await readFile(join(h.project, 'a.json'), 'utf8');
  const sent = h.methods().length;
  // Errors found locally: nothing reaches the host.
  for (const [argv, code] of [
    [['enqueue', '--key', 'k'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'missing.json'], 'file_unavailable'],
    [['enqueue', '--key', 'k', '--recipe', 'nonsense'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'both.json', '-f', 'p2.json', '--seeds', '1,2'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'p1.json', '--seeds', '1,x'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'p1.json', '--wait-seconds', '5'], 'usage'],
    [['enqueue', '-f', 'p1.json'], 'usage'],
    // The wait is checked before the paid enqueue (read_queue takes 1–1200 s).
    [['enqueue', '--key', 'k', '-f', 'p1.json', '--wait', 'done', '--wait-seconds', '0'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'p1.json', '--wait', 'done', '--wait-seconds', '5000'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'p1.json', '--wait', 'done', '--wait-seconds', '-1'], 'usage'],
    // A count in the prepared file and another on the command line: no silent winner.
    [['enqueue', '--key', 'k', '-f', 'counted.json', '--count', '2'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'counted.json', '--seeds', '1,2'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'seeded.json', '--seeds', '1,3'], 'usage'],
    [['enqueue', '--key', 'k', '-f', 'seeded.json', '--count', '3'], 'usage'],
    // prepare -o never replaces the recipe it reads (also not through a link or with --force).
    [['prepare', '-f', 'a.json', '-o', 'a.json'], 'usage'],
    [['prepare', '-f', 'a.json', '-o', 'a-link.json', '--force'], 'usage'],
    [['queue', 'read', '0b4d4a50-1c0e-4c7e-9a52-6c2f5d1e7a10', '--wait', 'next', '--wait-seconds', '1201'], 'usage'],
  ]) {
    const result = await h.nai(argv);
    assert.equal(result.code, EXIT.usage, `${argv.join(' ')}: ${result.text}`);
    assert.equal(result.out.ok, false); assert.equal(result.out.error.code, code, argv.join(' '));
  }
  assert.equal(h.methods().length, sent, 'nothing was sent for a local error');
  assert.equal(await readFile(join(h.project, 'a.json'), 'utf8'), draftBytes, 'the recipe file was not overwritten');
  assert.equal(h.jobs.length, 0, 'no batch was queued by a refused enqueue');
  // The same values in both places are fine; a receipt is replaced, its folder made.
  const same = await h.nai(['enqueue', '--key', 'same', '-f', 'counted.json', '--count', '3']);
  assert.equal(same.code, EXIT.ok, same.text); assert.equal(h.jobs.at(-1).args.seeds.length, 3);
  const replaced = await h.nai(['prepare', '-f', 'a.json', '-o', 'p1.json']);
  assert.equal(replaced.code, EXIT.ok, replaced.text);
  const deep = await h.nai(['prepare', '-f', 'a.json', '-o', join('receipts', 'new', 'p.json')]);
  assert.equal(deep.code, EXIT.ok, deep.text); assert.equal(JSON.parse(await readFile(join(h.project, 'receipts', 'new', 'p.json'), 'utf8')).recipeId, deep.out.recipeId);
  const enqueued = await h.nai(['enqueue', '--key', 'two', '-f', 'both.json', '--recipe', `${p2.recipeId}:${p2.recipeRevision}:${p2.inputHash}`]);
  assert.equal(enqueued.code, EXIT.ok, enqueued.text);
  assert.equal(h.jobs.at(-1).args.seeds.length, 2);
  const seededRun = await h.nai(['enqueue', '--key', 'three', '-f', 'p1.json', '--seeds', '5,6,7']);
  assert.equal(seededRun.code, EXIT.ok, seededRun.text);
  assert.deepEqual(h.jobs.at(-1).args.seeds, [5, 6, 7]);
  // A tool error is exit 1 with the server's envelope: a mismatched inputHash.
  const wrong = await h.nai(['enqueue', '--key', 'four', '--recipe', `${p2.recipeId}:${p2.recipeRevision}:${'0'.repeat(64)}`]);
  assert.equal(wrong.code, EXIT.toolError, wrong.text); assert.equal(wrong.out.ok, false); assert.equal(typeof wrong.out.error.code, 'string');
  // A preview saves nothing: -o is refused before anything is sent, and a preview receipt cannot be enqueued.
  const preview = await h.nai(['prepare', '-f', 'a.json', '--preview', '-o', 'x.json']);
  assert.equal(preview.code, EXIT.usage);
  assert.equal(first.code, EXIT.ok);
});

test('nai images: every tool that returns an image writes it to a file (savedImages), never to stdout', async t => {
  const h = await host(t);
  const checks = [
    [['asset', 'image', 'h2'], 'image/png', PNG],
    [['study', 'image', STUDY], 'image/jpeg', JPEG],
    [['material', 'cover', ENTRY], 'image/png', PNG],
    [['workspace', 'read'], 'image/png', PNG],
    [['ws', '--asset', 'a1', '--asset', 'a2'], 'image/png', PNG],
    [['call', 'asset_library', JSON.stringify({ action: 'image', kind: 'history', id: 'h3', revision: 2, assetId: 'path:h3' })], 'image/png', PNG],
  ];
  for (const [argv, mimeType, bytes] of checks) {
    const result = await h.nai(argv);
    assert.equal(result.code, EXIT.ok, `${argv.join(' ')}: ${result.text}`);
    assert.equal(result.text.includes(bytes.toString('base64')), false, `${argv.join(' ')} prints no image bytes`);
    assert.ok(result.out.savedImages.length >= 1, argv.join(' '));
    for (const saved of result.out.savedImages) {
      assert.equal(saved.mimeType, mimeType);
      assert.ok(saved.file.endsWith(mimeType === 'image/jpeg' ? '.jpg' : '.png'), saved.file);
      assert.ok(isAbsolute(saved.file) && saved.file.startsWith(join(h.project, '.tmp', 'nai-cli')), 'paths nai writes are absolute');
      assert.deepEqual(await readFile(saved.file), bytes);
    }
  }
  const two = await h.nai(['ws', '--asset', 'a1', '--asset', 'a2']);
  assert.deepEqual(two.out.savedImages.map(item => item.assetId), ['a1', 'a2']);
  // asset image read the history first for its revision and assetId (one asset_library read, then the image).
  assert.deepEqual(h.calls.filter(call => call.method === 'asset_library').slice(0, 2).map(call => call.args.action), ['read', 'image']);
  // --out names the file (an existing one is replaced, folders are made); the extension follows the image type.
  const out = await h.nai(['asset', 'image', 'h2', '-r', '2', '--asset-id', 'path:h2', '--out', 'pick.jpg']);
  assert.equal(out.code, EXIT.ok, out.text); assert.equal(out.out.savedImages[0].file, join(h.project, 'pick.png'));
  const again = await h.nai(['asset', 'image', 'h2', '-r', '2', '--asset-id', 'path:h2', '--out', join('shots', 'pick.png'), '--force']);
  assert.equal(again.code, EXIT.ok, again.text); assert.deepEqual(await readFile(join(h.project, 'shots', 'pick.png')), PNG);
  const twice = await h.nai(['asset', 'image', 'h2', '-r', '2', '--asset-id', 'path:h2', '--out', join('shots', 'pick.png')]);
  assert.equal(twice.code, EXIT.ok, twice.text);
  // --image-dir: another folder.
  const elsewhere = await h.nai(['--image-dir', join(h.base, 'shots'), 'study', 'image', STUDY]);
  assert.equal(elsewhere.code, EXIT.ok, elsewhere.text); assert.ok(isAbsolute(elsewhere.out.savedImages[0].file));
  assert.deepEqual((await readdir(join(h.base, 'shots'))).length, 1);
  // (Creating a symbolic link needs extra rights on Windows.)
  if (process.platform === 'win32') return;
  // A linked .tmp (a shared scratch folder) is followed like any folder; a missing project root is created.
  const linked = await host(t);
  const scratch = join(linked.base, 'scratch');
  await mkdir(scratch);
  await symlink(scratch, join(linked.project, '.tmp'));
  const followed = await linked.nai(['study', 'image', STUDY]);
  assert.equal(followed.code, EXIT.ok, followed.text);
  assert.equal((await readdir(join(scratch, 'nai-cli'))).length, 1);
});

test('nai images of prepare --preview and asset censor --preview are saved like every other (scripted MCP answers)', async () => {
  const { runCommand } = await import('../src/cli-run.mjs');
  const { parseCommandLine } = await import('../src/cli-spec.mjs');
  const project = await realpath(await mkdtemp(join(tmpdir(), 'novelai-cli-preview-')));
  try {
    const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
    const sent = [];
    const connect = async () => ({
      async call(name, args) {
        sent.push({ name, args });
        if (name === 'asset_library' && args.action === 'read') return { content: [{ type: 'text', text: '{}' }], structuredContent: { kind: 'history', id: args.id, revision: 4, assetId: 'path:x' } };
        const preview = name === 'prepare_recipe' ? { preview: true, previewImage: { width: 8, height: 8, mimeType: 'image/webp', imageAttached: true } } : { preview: true, previewImage: { mimeType: 'image/jpeg', imageAttached: true } };
        const bytes = name === 'prepare_recipe' ? WEBP : JPEG;
        return { content: [{ type: 'text', text: JSON.stringify(preview) }, { type: 'image', mimeType: name === 'prepare_recipe' ? 'image/webp' : 'image/jpeg', data: bytes.toString('base64') }], structuredContent: preview };
      },
      async listTools() { return []; }, async close() {},
    });
    await writeFile(join(project, 'inpaint.json'), JSON.stringify({ mode: 'inpaint', source: { kind: 'history', historyId: 'x', historyRevision: 4, assetId: 'path:x' }, mask: { units: 'fraction', layers: [{ op: 'add', shape: { type: 'rect', x: 0, y: 0, width: 0.5, height: 0.5 } }] } }));
    const run = argv => runCommand(parseCommandLine(argv), { io: { cwd: project, env: {} }, projectRoot: project, connect });
    const prepared = await run(['prepare', '-f', join(project, 'inpaint.json'), '--preview']);
    assert.equal(prepared.output.savedImages[0].mimeType, 'image/webp'); assert.match(prepared.output.savedImages[0].file, /prepare-preview-.*\.webp$/);
    assert.deepEqual(await readFile(prepared.output.savedImages[0].file), WEBP);
    const censored = await run(['asset', 'censor', 'x', '--mask', '{"units":"fraction","layers":[]}', '--preview', '--out', join(project, 'censored')]);
    assert.equal(censored.output.savedImages[0].file, join(project, 'censored.jpg'));
    assert.deepEqual(await readFile(join(project, 'censored.jpg')), JPEG);
    assert.deepEqual(sent.map(item => item.name), ['prepare_recipe', 'asset_library', 'asset_library']);
    assert.deepEqual(sent[2].args, { action: 'censor', kind: 'history', id: 'x', revision: 4, assetId: 'path:x', mask: { units: 'fraction', layers: [] }, preview: true });
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('nai call: inline JSON, @file and stdin-less defaults reach every tool through the registry; a refused call keeps the server\'s envelope', async t => {
  const h = await host(t);
  await writeFile(join(h.project, 'args.json'), JSON.stringify({ action: 'read', kind: 'history', id: 'h9' }));
  const fromFile = await h.nai(['call', 'asset_library', '@args.json']);
  assert.equal(fromFile.code, EXIT.ok, fromFile.text); assert.equal(fromFile.out.id, 'h9');
  // A raw host method name, a retired tool or a schema violation never reaches the host.
  const sent = h.methods().length;
  for (const [argv, code] of [[['call', 'put_queue_recipe', '{}'], 'unknown_tool'], [['call', 'lookup_enqueue', '{}'], 'unknown_tool'], [['call', 'list_queue', '{"extra":1}'], 'invalid_arguments'],
    [['call', 'read_queue', '{"batchId":"x","wait":{"until":"later"}}'], 'invalid_arguments']]) {
    const result = await h.nai(argv);
    assert.equal(result.code, EXIT.toolError, result.text); assert.equal(result.out.error.code, code, argv.join(' '));
  }
  assert.equal(h.methods().length, sent);
  for (const [argv, code] of [[['call', 'list_queue', '[1]'], 'usage'], [['call', 'list_queue', '{bad'], 'invalid_json'], [['call', 'list_queue', '@'], 'usage'], [['call', 'list_queue', '@nope.json'], 'file_unavailable']]) {
    const result = await h.nai(argv);
    assert.equal(result.code, EXIT.usage, result.text); assert.equal(result.out.error.code, code, argv.join(' '));
  }
  // tools: names and one schema, without the app.
  const names = await h.nai(['tools', '--names']);
  assert.deepEqual(names.out, ['material_library', 'tag_details', 'material_studies', 'asset_library', 'prepare_recipe', 'enqueue_recipes', 'list_queue', 'read_queue', 'get_queue_result', 'read_workspace']);
  const schema = await h.nai(['tools', 'prepare_recipe']);
  assert.equal(schema.out.inputSchema.type, 'object');
  assert.equal(h.methods().length, sent, 'tools/list reaches no host');
  // NOVELAI_CLI_CLIENT names the caller (cleaned like an MCP client name); an unusable name falls back to nai-cli.
  await h.nai(['queue', 'list'], { env: { NOVELAI_CLI_CLIENT: 'claude-code' } });
  assert.deepEqual(h.calls.at(-1).caller.client, { name: 'claude-code', version: 'nai-cli 0.2.0' });
  await h.nai(['queue', 'list'], { env: { NOVELAI_CLI_CLIENT: 'bad\u0007name' } });
  assert.equal(h.calls.at(-1).caller.client.name, 'nai-cli');
});

/** A history record made with `payload` changes (mode, model sent, params). */
const variant = (id, project, { mode, model, params = {}, characters, drop = [] }) => {
  const record = historyRecord(id, project);
  const payload = record.item.payload;
  if (model !== undefined) { payload.model = model; payload.params.model = model; }
  payload.generationOrigin = mode === null ? undefined : { mode, actualSeed: 4242 };
  Object.assign(payload.params, params);
  for (const key of drop) delete payload.params[key];
  if (characters) payload.characterSnapshot = { version: 1, captions: characters };
  return record;
};

test('nai asset recipe: every kind of source image, model ids as prepare_recipe takes them, and a refusal for images no recipe remakes', async t => {
  const h = await host(t);
  const p = h.project;
  // A multi-character t2i image round-trips: the recipe from its record prepares the same input as the call that made it.
  const original = { mode: 't2i', model: 'nai-diffusion-5-full', width: 832, height: 1216, steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 2, qualityPreset: 'standard',
    stylePrompt: 'watercolor', positivePrompt: PROMPT, negativePrompt: 'blurry', seed: 4242,
    characters: [{ prompt: 'girl, red dress', negativePrompt: 'hat', useCoords: true, x: 0.3, y: 0.5 }, { prompt: 'boy, blue coat', useCoords: true, x: 0.7, y: 0.5 }] };
  await writeFile(join(p, 'original.json'), JSON.stringify(original));
  const direct = await h.nai(['prepare', '-f', 'original.json']);
  h.histories.multi = variant('multi', p, { mode: 't2i', characters: original.characters });
  const multi = await h.nai(['asset', 'recipe', 'multi', '-o', 'multi.json']);
  assert.equal(multi.code, EXIT.ok, multi.text); assert.equal(multi.out.characters, 2); assert.equal(multi.out.warnings, undefined);
  const again = await h.nai(['prepare', '-f', 'multi.json']);
  assert.equal(again.out.inputHash, direct.out.inputHash, 'the same input as the call that made the image');

  // Effort Medium: sent as nai-diffusion-5-full-medium, written as V5 Full with effort medium (its fixed values left to it).
  h.histories.medium = variant('medium', p, { mode: 't2i', model: 'nai-diffusion-5-full-medium', params: { steps: 14, cfgRescale: 0, ucPreset: 0 } });
  const medium = await h.nai(['asset', 'recipe', 'medium', '-o', 'medium.json']);
  assert.equal(medium.code, EXIT.ok, medium.text);
  const mediumRecipe = JSON.parse(await readFile(join(p, 'medium.json'), 'utf8'));
  assert.deepEqual([mediumRecipe.model, mediumRecipe.effort, mediumRecipe.steps, mediumRecipe.sampler, mediumRecipe.negativePrompt], ['nai-diffusion-5-full', 'medium', undefined, undefined, undefined]);
  assert.deepEqual(medium.out.warnings.map(warning => warning.code), ['model_normalized']);
  const mediumPrepared = await h.nai(['prepare', '-f', 'medium.json']);
  assert.equal(mediumPrepared.code, EXIT.ok, mediumPrepared.text); assert.equal(mediumPrepared.out.ready, true);
  assert.ok(JSON.stringify(h.calls.filter(call => call.method === 'put_queue_recipe').at(-1).args).includes('"effort":"medium"'), `prepare asks for Medium again: ${mediumPrepared.text}`);

  // An inpaint image: the base model, its prompts as a t2i recipe, and a warning that its source is not included.
  h.histories.inpaint = variant('inpaint', p, { mode: 'inpaint', model: 'nai-diffusion-4-5-full-inpainting' });
  const inpaint = await h.nai(['asset', 'recipe', 'inpaint', '-o', 'inpaint.json']);
  assert.equal(inpaint.code, EXIT.ok, inpaint.text);
  assert.equal(JSON.parse(await readFile(join(p, 'inpaint.json'), 'utf8')).model, 'nai-diffusion-4-5-full');
  assert.deepEqual(inpaint.out.warnings.map(warning => warning.code), ['model_normalized', 'source_not_included']);
  assert.equal((await h.nai(['prepare', '-f', 'inpaint.json'])).code, EXIT.ok);

  // Records keep no reference images: every summary says so plainly, nothing is guessed.
  assert.equal(inpaint.out.references, REFERENCES_NOTE);
  // An image made with Generate in the app has feature instead of mode (client/electron/ipc/nai.ts).
  h.histories.manual = variant('manual', p, { mode: null, params: {} });
  h.histories.manual.item.payload.feature = 't2i';
  const manual = await h.nai(['asset', 'recipe', 'manual', '-o', 'manual.json']);
  assert.equal(manual.code, EXIT.ok, manual.text); assert.equal(manual.out.madeWith, 't2i'); assert.equal(manual.out.warnings, undefined);
  h.histories.manualInpaint = variant('manualInpaint', p, { mode: null, model: 'nai-diffusion-4-5-full-inpainting' });
  h.histories.manualInpaint.item.payload.feature = 'inpaint';
  const manualInpaint = await h.nai(['asset', 'recipe', 'manualInpaint', '-o', 'manual-inpaint.json']);
  assert.deepEqual(manualInpaint.out.warnings.map(warning => warning.code), ['model_normalized', 'source_not_included']);
  assert.match(manualInpaint.out.warnings[1].message, /describes only the repainted area/);
  h.histories.manualUpscale = variant('manualUpscale', p, { mode: null, model: 'upscale', params: { positivePrompt: 'upscale' } });
  h.histories.manualUpscale.item.payload.feature = 'upscale';
  assert.equal((await h.nai(['asset', 'recipe', 'manualUpscale', '-o', 'mu.json'])).out.error.code, 'recipe_not_reproducible');

  // i2i and enhance of this image: it becomes the source; what the image cannot give is named.
  const i2i = await h.nai(['asset', 'recipe', 'multi', '-o', 'i2i.json', '--mode', 'i2i']);
  assert.deepEqual([i2i.code, i2i.out.missing], [EXIT.ok, ['strength']]);
  assert.deepEqual(JSON.parse(await readFile(join(p, 'i2i.json'), 'utf8')).source, { kind: 'history', historyId: 'multi', historyRevision: 2, assetId: 'path:multi' });
  const enhance = await h.nai(['asset', 'recipe', 'medium', '-o', 'enhance.json', '--mode', 'enhance']);
  assert.deepEqual([enhance.code, enhance.out.missing], [EXIT.ok, ['magnitude', 'scale']]);
  const enhanceRecipe = JSON.parse(await readFile(join(p, 'enhance.json'), 'utf8'));
  assert.equal(Object.hasOwn(enhanceRecipe, 'effort'), false, 'enhance runs on High: no effort in the file');
  // The values Medium fixed are not copied into a High recipe: the app's High defaults stand in (and the warning says so).
  assert.deepEqual([enhanceRecipe.steps, enhanceRecipe.sampler, enhanceRecipe.ucPreset, enhanceRecipe.negativePrompt, enhanceRecipe.cfgRescale, enhanceRecipe.width], [28, 'k_euler_ancestral', 2, '', 0, undefined]);
  assert.deepEqual(enhance.out.warnings.map(warning => warning.code), ['model_normalized', 'effort_not_applied']);
  assert.match(enhance.out.warnings[1].message, /High defaults/);

  // Images no recipe remakes: refused with a code, exit 1, nothing written, nothing prepared.
  h.histories.up = variant('up', p, { mode: 'upscale', model: 'upscale', params: { positivePrompt: 'upscale' } });
  h.histories.dir = variant('dir', p, { mode: 'director', model: 'director-lineart', params: { positivePrompt: 'director-lineart' } });
  h.histories.odd = variant('odd', p, { mode: null, model: 'director-lineart' });
  for (const id of ['up', 'dir', 'odd']) {
    const refused = await h.nai(['asset', 'recipe', id, '-o', `${id}.json`]);
    assert.equal(refused.code, EXIT.toolError, refused.text); assert.equal(refused.out.error.code, 'recipe_not_reproducible');
    await assert.rejects(readFile(join(p, `${id}.json`)), { code: 'ENOENT' });
  }
});

test('nai enqueue interrupted: during the enqueue it says to repeat the same key; during the wait, that the batch is queued and how to follow it', async t => {
  const h = await host(t);
  await h.nai(['asset', 'recipe', 'h0', '-o', 'draft.json']);
  await h.nai(['prepare', '-f', 'draft.json', '-o', 'prepared.json']);
  const interruptAt = method => { const signals = new EventEmitter(); h.held.clear(); h.held.set(method, () => setImmediate(() => signals.emit('SIGINT'))); return signals; };
  // Stopped while the wait reads the batch: the enqueue is known.
  const waiting = await h.nai(['enqueue', '-f', 'prepared.json', '--key', 'int-1', '--wait', 'done'], { signals: interruptAt('read_queue') });
  assert.equal(waiting.code, EXIT.interrupted, waiting.text);
  assert.equal(waiting.out.error.code, 'interrupted');
  assert.equal(waiting.out.enqueue.status, 'enqueued');
  assert.match(waiting.out.error.message, new RegExp(`nai queue read ${waiting.out.enqueue.batchId} --wait done; do not enqueue again`));
  assert.equal(h.jobs.length, 1);
  // Stopped while the enqueue itself is under way: its outcome is unknown, so the same key again.
  const enqueuing = await h.nai(['enqueue', '-f', 'prepared.json', '--key', 'int-2', '--wait', 'done'], { signals: interruptAt('lookup_queue_request') });
  assert.equal(enqueuing.code, EXIT.interrupted, enqueuing.text);
  assert.equal(enqueuing.out.enqueue, undefined);
  assert.match(enqueuing.out.error.message, /Run the same command again with the same --key/);
  h.held.clear();
});

test('nai copies local files into the inbox a tool reads by name: study import, material import and set-cover; inbox names and files there are used as they are', async t => {
  const h = await host(t);
  const outside = join(h.base, 'downloads');
  await mkdir(outside);
  await writeFile(join(outside, 'one.png'), PNG);
  await writeFile(join(outside, 'two.png'), PNG);
  const inbox = join(h.project, 'novelai', 'study-inbox');
  await writeFile(join(inbox, 'one.png'), 'another file of that name');
  await writeFile(join(inbox, 'here.png'), PNG);
  const imported = await h.nai(['study', 'import', join(outside, 'one.png'), '../downloads/two.png', 'here.png', join(inbox, 'here.png')], { cwd: h.project });
  assert.equal(imported.code, EXIT.ok, imported.text);
  const sent = h.calls.filter(call => call.method === 'material_studies').map(call => call.args.name);
  assert.deepEqual(sent, ['one-1.png', 'two.png', 'here.png', 'here.png'], 'a name taken in the inbox gets a free one');
  assert.deepEqual(imported.out.copied, [{ from: join(outside, 'one.png'), to: 'novelai/study-inbox/one-1.png' }, { from: join(outside, 'two.png'), to: 'novelai/study-inbox/two.png' }]);
  assert.equal(await readFile(join(inbox, 'one.png'), 'utf8'), 'another file of that name', 'nothing in the inbox is replaced');
  // The same file again: the copy made before is used, not another one.
  const again = await h.nai(['study', 'import', join(outside, 'two.png')]);
  assert.deepEqual(again.out.copied, [{ from: join(outside, 'two.png'), to: 'novelai/study-inbox/two.png', reused: true }]);
  assert.deepEqual((await readdir(inbox)).sort(), ['here.png', 'one-1.png', 'one.png', 'two.png']);
  // A missing name is passed on, and the tool reports it.
  const missing = await h.nai(['study', 'import', 'nowhere.png']);
  assert.equal(missing.out.items[0].status, 'failed');

  // material import -f: the backup goes through the library inbox (created when missing), under a name the tool takes.
  await rm(join(h.project, 'novelai', 'library-inbox'), { recursive: true });
  await writeFile(join(outside, '素材 backup.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
  const restored = await h.nai(['material', 'import', '-f', join(outside, '素材 backup.json')]);
  assert.equal(restored.code, EXIT.ok, restored.text);
  assert.deepEqual(restored.out.copied, [{ from: join(outside, '素材 backup.json'), to: 'novelai/library-inbox/backup.json' }]);
  // set-cover from any image file.
  const cover = await h.nai(['material', 'set-cover', ENTRY, join(outside, 'one.png'), '-r', '7', '--expected-cover-revision', '0']);
  assert.equal(cover.code, EXIT.ok, cover.text);
  assert.deepEqual(cover.out.copied, [{ from: join(outside, 'one.png'), to: 'novelai/library-inbox/one.png' }]);
  const setCover = h.calls.find(call => call.method === 'material_samples' && call.args.action === 'set_local_cover');
  assert.equal(setCover.args.fileName, 'one.png');
});

test('nai enqueue --wait: when the wait fails after the enqueue, the answer says the batch is queued and how to follow it', async t => {
  const h = await host(t);
  await h.nai(['asset', 'recipe', 'h0', '-o', 'draft.json']);
  await h.nai(['prepare', '-f', 'draft.json', '-o', 'prepared.json']);
  const original = h.bridge.call;
  h.bridge.call = async (method, ...rest) => { if (method === 'read_queue') throw new BridgeError('invalid_response', 'Nothing was sent. The host returned something else.'); return original(method, ...rest); };
  const result = await h.nai(['enqueue', '-f', 'prepared.json', '--key', 'wait-fails', '--wait', 'done', '--wait-seconds', '3']);
  h.bridge.call = original;
  assert.equal(result.code, EXIT.toolError, result.text);
  assert.equal(result.out.error.code, 'wait_failed');
  assert.match(result.out.error.message, new RegExp(`^The enqueue was accepted \\(batch ${result.out.enqueue.batchId}\\); only the wait failed \\(invalid_response\\)\\. Follow the batch with nai queue read ${result.out.enqueue.batchId} --wait done; do not enqueue again\\.$`));
  assert.equal(result.out.error.waitError.code, 'invalid_response');
  assert.equal(result.out.enqueue.status, 'enqueued'); assert.equal(h.jobs.length, 1);
});

test('nai inbox files: a name that is a file here is that file, also when the inbox holds an older one of that name', async t => {
  const h = await host(t);
  const inbox = join(h.project, 'novelai', 'study-inbox'), library = join(h.project, 'novelai', 'library-inbox');
  const work = join(h.base, 'work');
  await mkdir(work);
  // An older ref.png in the inbox, a different ref.png in the working directory: the one here is imported.
  await writeFile(join(inbox, 'ref.png'), JPEG);
  await writeFile(join(work, 'ref.png'), PNG);
  const fresh = await h.nai(['study', 'import', 'ref.png'], { cwd: work });
  assert.equal(fresh.code, EXIT.ok, fresh.text);
  assert.deepEqual(fresh.out.copied, [{ from: join(work, 'ref.png'), to: 'novelai/study-inbox/ref-1.png' }]);
  const sentStudy = h.calls.filter(call => call.method === 'material_studies').at(-1).args;
  assert.equal(sentStudy.name, 'ref-1.png'); assert.deepEqual(Buffer.from(sentStudy.data, 'base64'), PNG);
  assert.deepEqual(await readFile(join(inbox, 'ref.png')), JPEG, 'the older file stays');
  // The same bytes again reuse that copy; a name that is no file here is the inbox's file.
  assert.deepEqual((await h.nai(['study', 'import', 'ref.png'], { cwd: work })).out.copied, [{ from: join(work, 'ref.png'), to: 'novelai/study-inbox/ref-1.png', reused: true }]);
  const fromInbox = await h.nai(['study', 'import', 'ref.png'], { cwd: h.base });
  assert.equal(fromInbox.out.copied, undefined); assert.deepEqual(Buffer.from(h.calls.filter(call => call.method === 'material_studies').at(-1).args.data, 'base64'), JPEG);
  // material import -f backup.json: the backup here, not an older one of that name in the library inbox.
  await mkdir(library, { recursive: true });
  await writeFile(join(library, 'backup.json'), JSON.stringify({ schemaVersion: 1, entries: [{ old: true }] }));
  await writeFile(join(work, 'backup.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
  const restored = await h.nai(['material', 'import', '-f', 'backup.json'], { cwd: work });
  assert.equal(restored.code, EXIT.ok, restored.text);
  assert.deepEqual(restored.out.copied, [{ from: join(work, 'backup.json'), to: 'novelai/library-inbox/backup-1.json' }]);
  assert.deepEqual(h.calls.filter(call => call.method === 'material_library').at(-1).args.data, { schemaVersion: 1, entries: [] });
  // --manifest and set-cover share the rule.
  await writeFile(join(inbox, 'm.json'), JSON.stringify({ files: ['ref.png'] }));
  await writeFile(join(work, 'm.json'), JSON.stringify({ files: ['ref-1.png'] }));
  const manifest = await h.nai(['study', 'import', '--manifest', 'm.json'], { cwd: work });
  assert.deepEqual(manifest.out.copied, [{ from: join(work, 'm.json'), to: 'novelai/study-inbox/m-1.json' }]);
  await writeFile(join(library, 'cover.png'), JPEG);
  await writeFile(join(work, 'cover.png'), PNG);
  const cover = await h.nai(['material', 'set-cover', ENTRY, 'cover.png', '-r', '7', '--expected-cover-revision', '0'], { cwd: work });
  assert.deepEqual(cover.out.copied, [{ from: join(work, 'cover.png'), to: 'novelai/library-inbox/cover-1.png' }]);
});

test('nai reads -f and @file from pipes (process substitution, a FIFO), keeps the 16 MiB limit, and refuses folders', { skip: process.platform === 'win32' }, async t => {
  const h = await host(t);
  await h.nai(['asset', 'recipe', 'h0', '-o', 'draft.json']);
  const { execFileSync } = await import('node:child_process');
  const fifo = join(h.base, 'draft.fifo');
  execFileSync('mkfifo', [fifo]);
  const feed = (file, bytes) => { const writer = import('node:fs').then(fs => new Promise((done, fail) => { const stream = fs.createWriteStream(file); stream.on('error', fail); stream.end(bytes, done); })); return writer; };
  const draft = await readFile(join(h.project, 'draft.json'));
  const [prepared] = await Promise.all([h.nai(['prepare', '-f', fifo, '--preview']), feed(fifo, draft)]);
  assert.equal(prepared.code, EXIT.ok, prepared.text); assert.equal(prepared.out.preview, true);
  const real = await h.nai(['prepare', '-f', 'draft.json', '-o', 'p.json']);
  const [enqueued] = await Promise.all([h.nai(['enqueue', '-f', fifo, '--key', 'from-pipe']), feed(fifo, await readFile(join(h.project, 'p.json')))]);
  assert.equal(enqueued.code, EXIT.ok, enqueued.text); assert.equal(enqueued.out.batchId, h.jobs.at(-1).job.batchId);
  assert.equal(real.code, EXIT.ok);
  const [called] = await Promise.all([h.nai(['call', 'list_queue', `@${fifo}`]), feed(fifo, '{}')]);
  assert.equal(called.code, EXIT.ok, called.text);
  // A pipe over the limit, and a folder.
  const [big] = await Promise.all([h.nai(['prepare', '-f', fifo]), feed(fifo, Buffer.alloc(16 * 1024 * 1024 + 10, 0x20)).catch(() => undefined)]);
  assert.equal(big.code, EXIT.usage); assert.equal(big.out.error.code, 'input_too_large');
  const folder = await h.nai(['prepare', '-f', h.base]);
  assert.equal(folder.code, EXIT.usage); assert.match(folder.out.error.message, /is a folder/);
});

test('nai --out: empty is a usage error; an existing folder or a path ending in a separator receives the images', async t => {
  const h = await host(t);
  const empty = await h.nai(['asset', 'image', 'h2', '--out', '']);
  assert.equal(empty.code, EXIT.usage); assert.match(empty.out.error.message, /--out needs a file/);
  await mkdir(join(h.project, 'picked'));
  const intoFolder = await h.nai(['asset', 'image', 'h2', '--out', 'picked']);
  assert.equal(intoFolder.code, EXIT.ok, intoFolder.text);
  assert.ok(intoFolder.out.savedImages[0].file.startsWith(join(h.project, 'picked', 'history-h2-')), intoFolder.out.savedImages[0].file);
  const newFolder = await h.nai(['study', 'image', STUDY, '--out', `new${process.platform === 'win32' ? '\\' : '/'}`]);
  assert.equal(newFolder.code, EXIT.ok, newFolder.text);
  assert.ok(newFolder.out.savedImages[0].file.startsWith(join(h.project, 'new', 'study-')) && newFolder.out.savedImages[0].file.endsWith('.jpg'));
});
