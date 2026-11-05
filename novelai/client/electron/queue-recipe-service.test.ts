import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
vi.mock('axios', () => ({ default: { get: () => { throw new Error('No network'); }, post: () => { throw new Error('No network'); } } }));
vi.mock('./ipc/store', () => ({ getToken: () => { throw new Error('No account'); }, getSettings: () => { throw new Error('No settings'); } }));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: { createFromBuffer: (buffer: Buffer) => {
  const png = PNG.sync.read(buffer);
  return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }), toPNG: () => buffer, resize: () => ({ toPNG: () => buffer }) };
} } }));
import { createQueueRecipeService, normalizeQueuePreparation, recipeHash, QUEUE_METHODS, QUEUE_WORKSPACE } from './queue-recipe-service';
import { buildPromptReview } from './prompt-review';
import { runCleanups } from '../src/test-support/temp-dirs';

const cleanups: string[] = [];
afterEach(async () => { await runCleanups(cleanups.splice(0).map(dir => () => fs.rm(dir, { recursive: true, force: true }))); });
const prep = (positivePrompt = 'teacup, table', extra: Record<string, any> = {}) => ({ mode: 't2i', authored: { params: { positivePrompt, negativePrompt: 'text, watermark', seed: 42, seedMode: 'fixed', width: 64, height: 64 }, ...extra }, assets: [] });
const item = (value: any, seed?: number) => ({ recipeId: value.recipeId, recipeRevision: value.recipeRevision, inputHash: value.inputHash, ...(seed === undefined ? {} : { seed }) });
function picture(value: number) { const png = new PNG({ width: 64, height: 64 }); png.data.fill(value); for (let i = 3; i < png.data.length; i += 4) png.data[i] = 255; return PNG.sync.write(png).toString('base64'); }
function largePicture() { const png = new PNG({ width: 1024, height: 1024 }); randomBytes(png.data.length).copy(png.data); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255; return PNG.sync.write(png, { colorType: 6, inputColorType: 6 }).toString('base64'); }
/** A second runtime holding a copy of this runtime's recipe store (moved data, or the same store after a restart). */
async function copiedRuntime(runtimeDir: string) {
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-recipe-copy-')); cleanups.push(target);
  await fs.cp(path.join(runtimeDir, 'queue-recipes'), path.join(target, 'queue-recipes'), { recursive: true });
  return target;
}
async function setup() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-recipe-')); cleanups.push(runtimeDir);
  const jobs = new Map<string, any>();
  const batch = { ready: Promise.resolve(), enqueue: vi.fn(async (args: any) => {
    const job = { ...args, batchId: randomUUID(), originWorkspaceId: args.workspaceId, submittedRevision: 0, status: 'queued', recipePlanHash: undefined, items: args.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
    delete job.snapshots; jobs.set(args.requestKey, job); return job;
  }), lookup: vi.fn((args: any) => jobs.get(args.requestKey) ?? null), list: vi.fn(() => ({ batches: [...jobs.values()] })),
    read: vi.fn((args: any) => [...jobs.values()].find(value => value.batchId === args.batchId)),
    pause: vi.fn((args: any) => ({ ...[...jobs.values()].find(value => value.batchId === args.batchId), status: 'paused' })),
    resume: vi.fn((args: any) => ({ ...[...jobs.values()].find(value => value.batchId === args.batchId), status: 'queued' })),
    cancel: vi.fn((args: any) => ({ ...[...jobs.values()].find(value => value.batchId === args.batchId), status: 'cancelled' })) };
  const service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97 });
  return { service, batch, jobs, runtimeDir };
}

describe('independent recipe service', () => {
  it('a copied store keeps exact recipe, source/Mask bytes and receipt identities without invoking enqueue again',async()=>{const{service,batch,runtimeDir}=await setup(),assets=[{role:'source',mimeType:'image/png',data:picture(70)},{role:'mask',mimeType:'image/png',data:picture(255)}],saved=await service.put_queue_recipe({preparation:{...prep('archive source',{inpaintRecipe:{positivePrompt:'archive source',negativePrompt:'text',seed:17,seedMode:'fixed'}}),mode:'inpaint',assets}}),args={requestKey:'archive-receipt',items:[item(saved,17)]};await service.enqueue_queue_recipes(args);const target=await copiedRuntime(runtimeDir);const restored=createQueueRecipeService({runtimeDir:target,batch});const restoredRecipe=await restored.read_queue_recipe({recipeId:saved.recipeId,recipeRevision:saved.recipeRevision});expect(restoredRecipe.inputHash).toBe(saved.inputHash);expect(restoredRecipe.snapshot.reviewInput.assets.map((value:any)=>value.data)).toEqual(expect.arrayContaining(assets.map(value=>value.data)));expect((await restored.lookup_queue_request({requestKey:args.requestKey})).status).toBe('accepted');expect(batch.enqueue).toHaveBeenCalledTimes(1);});
  it('defaults complete input through the production builder, no UI/settings read', async () => {
    const { service, runtimeDir } = await setup(); const preparation = prep('teacup, table', { charCaptions: [{ prompt: 'adult woman, blue coat', negativePrompt: 'hat', useCoords: true, x: .25, y: .6 }] });
    const saved = await service.put_queue_recipe({ preparation });
    expect(saved.snapshot).toMatchObject({ workspaceId: `recipe:${saved.recipeId}`, revision: 1, draftId: null, mode: 't2i', reviewInput: { readiness: { status: 'ready' } } });
    expect(saved.snapshot.reviewInput).toEqual(await buildPromptReview(normalizeQueuePreparation(preparation)));
    expect(saved.snapshot.reviewInput.authored.charCaptions[0]).toEqual({ prompt: 'adult woman, blue coat', negativePrompt: 'hat', useCoords: true, x: .25, y: .6 });
    expect(saved.characterIds).toEqual(['character-0']);
    const read = await service.read_queue_recipe({ recipeId: saved.recipeId, recipeRevision: 1 }); expect(read).toEqual(saved);
    // win32 reports no POSIX permission bits (always 0o666); privacy there relies on the user profile ACL.
    if (process.platform !== 'win32') expect((await fs.stat(path.join(runtimeDir, 'queue-recipes', `${saved.recipeId}.1.json`))).mode & 0o777).toBe(0o600);
  });
  it('versions new literal assembly without upgrading a historical revision that omits the marker',async()=>{
    const repeated=prep('red mug, soft light, blue vase, soft light'),{service}=await setup();
    const created=normalizeQueuePreparation(repeated),legacy=normalizeQueuePreparation(repeated,{newRecipe:false}),strict=normalizeQueuePreparation({ ...repeated, authored:{...repeated.authored,params:{...repeated.authored.params,preservePromptText:true}}},{newRecipe:false});
    expect(created.authored.params.promptAssemblyVersion).toBe(1);
    expect(legacy.authored.params).not.toHaveProperty('promptAssemblyVersion');
    expect(strict.authored.params).toMatchObject({preservePromptText:true});
    const createdInput=await buildPromptReview(created),legacyInput=await buildPromptReview(legacy);
    expect(createdInput.effective.request.input).toContain('red mug, soft light, blue vase, soft light');
    expect(legacyInput.effective.request.input).toContain('red mug, soft light, blue vase');
    const identity=(input:any)=>recipeHash({...input,assets:input.assets.map(({data:_data,...asset}:any)=>asset)});
    expect(identity(createdInput)).not.toBe(identity(legacyInput));
    expect((await buildPromptReview(strict)).effective.request.input).toContain('red mug, soft light, blue vase, soft light');
    const saved=await service.put_queue_recipe({preparation:repeated}),revised=await service.put_queue_recipe({recipeId:saved.recipeId,expectedRevision:1,preparation:prep('red mug, red mug')});
    expect(revised.snapshot.reviewInput.authored.params.promptAssemblyVersion).toBe(1);
    expect(()=>normalizeQueuePreparation({...repeated,authored:{...repeated.authored,params:{...repeated.authored.params,promptAssemblyVersion:2}}})).toThrow();
  });
  it('reads only recipe records of its own shape: a record carrying any other field is refused, and the retired derive methods are gone', async () => {
    const { service, runtimeDir, batch } = await setup();
    expect(QUEUE_METHODS).not.toContain('derive_queue_recipe'); expect(QUEUE_METHODS).not.toContain('lookup_derived_queue_recipe');
    expect(service).not.toHaveProperty('derive_queue_recipe'); expect(service).not.toHaveProperty('lookup_derived_queue_recipe');
    const saved = await service.put_queue_recipe({ preparation: prep() });
    const file = path.join(runtimeDir, 'queue-recipes', `${saved.recipeId}.1.json`), { recordHash: _hash, ...record } = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(record).sort()).toEqual(['inputHash', 'preparation', 'recipeId', 'recipeRevision', 'schemaVersion']);
    expect(saved.snapshot.workspaceId).toBe(`recipe:${saved.recipeId}`);
    // The same record with one more field, correctly hashed: not a record this version writes.
    const otherId = randomUUID(), other = { ...record, recipeId: otherId, lineage: { kind: 'unknown' } };
    await fs.writeFile(path.join(runtimeDir, 'queue-recipes', `${otherId}.1.json`), JSON.stringify({ ...other, recordHash: recipeHash(other) }), { mode: 0o600 });
    await expect(service.read_queue_recipe({ recipeId: otherId, recipeRevision: 1 })).rejects.toMatchObject({ code: 'queue_storage_failed', message: expect.stringContaining('unsupported older version') });
    await expect(service.enqueue_queue_recipes({ requestKey: 'other-shape', items: [item({ recipeId: otherId, recipeRevision: 1, inputHash: record.inputHash }, 5)] })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    await expect(service.put_queue_recipe({ recipeId: otherId, expectedRevision: 1, preparation: prep() })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    expect(batch.enqueue).not.toHaveBeenCalled();
    expect(await service.lookup_queue_request({ requestKey: 'other-shape' })).toEqual({ batch: null });
  });

  it('isolates multiple recipes; concurrent same-version writers have a single winner and retain history', async () => {
    const { service } = await setup();
    const [a, b] = await Promise.all(['red teacup', 'blue teacup'].map(prompt => service.put_queue_recipe({ preparation: prep(prompt) })));
    expect(a.recipeId).not.toBe(b.recipeId);
    const writes = await Promise.allSettled(['green teacup', 'yellow teacup'].map(prompt => service.put_queue_recipe({ recipeId: a.recipeId, expectedRevision: 1, preparation: prep(prompt) })));
    expect(writes.map(v => v.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await service.read_queue_recipe({ recipeId: a.recipeId, recipeRevision: 1 })).inputHash).toBe(a.inputHash);
    expect((await service.read_queue_recipe({ recipeId: b.recipeId, recipeRevision: 1 })).inputHash).toBe(b.inputHash);
  });
  it('enqueues multiple actual frozen recipes, fixed seeds and identity hash; exact historical input remains usable', async () => {
    const { service, batch } = await setup(); const a = await service.put_queue_recipe({ preparation: prep('red teacup') }), b = await service.put_queue_recipe({ preparation: prep('blue teacup') });
    await service.put_queue_recipe({ recipeId: a.recipeId, expectedRevision: 1, preparation: prep('green teacup') });
    const items = [item(a, 10), item(b, 20), item(a, 30)];
    const job = await service.enqueue_queue_recipes({ requestKey: 'a', items });
    expect(job.recipePlanHash).toBe(recipeHash(items));
    const sent = batch.enqueue.mock.calls[0][0]; expect(sent).toMatchObject({ workspaceId: QUEUE_WORKSPACE, execution: 'queued', expectedRevision: 0, count: 3, seeds: [10, 20, 30] });
    expect(sent.snapshots.map((s: any) => s.params.positivePrompt)).toEqual(['red teacup', 'blue teacup', 'red teacup']);
    expect(sent.snapshots.every((s: any) => s.batchCount === 1)).toBe(true);
    const compact = JSON.stringify(job); expect(compact).not.toContain('positivePrompt'); expect(compact).not.toContain('red teacup');
  });
  it('deduplicates request receipt across service restart; seed/hash/order changes reject', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() });
    const args = { requestKey: 'same-key', items: [item(a, 11), item(a, 12)] };
    const accepted = await service.enqueue_queue_recipes(args);
    const restarted = createQueueRecipeService({ runtimeDir, batch });
    expect(await restarted.enqueue_queue_recipes(args)).toEqual(accepted);
    expect((await restarted.lookup_queue_request({ requestKey: args.requestKey })).batch).toEqual(accepted);
    await expect(restarted.enqueue_queue_recipes({ ...args, items: [...args.items].reverse() })).rejects.toMatchObject({ code: 'request_conflict' });
    expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('all-or-nothing: stale input hash or mixed mode rejects before accepting', async () => {
    const { service, batch } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() });
    await expect(service.enqueue_queue_recipes({ requestKey: 'bad-hash', items: [item(a), { ...item(a), inputHash: '0'.repeat(64) }] })).rejects.toMatchObject({ code: 'recipe_changed' });
    const i2i = await service.put_queue_recipe({ preparation: { ...prep(), mode: 'i2i', assets: [{ role: 'source', mimeType: 'image/png', data: picture(80) }] } });
    await expect(service.enqueue_queue_recipes({ requestKey: 'mixed', items: [item(a), item(i2i)] })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(batch.enqueue).not.toHaveBeenCalled();
  });
  it('reads a recipe only as stored: the retired comparison overrides are refused', async () => {
    const { service } = await setup(); const a = await service.put_queue_recipe({ preparation: prep('teacup, {{table}}') }); const identity = { recipeId: a.recipeId, recipeRevision: 1 };
    await expect(service.read_queue_recipe({ ...identity, styleOverrides: { params: 'watercolor' } })).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(service.read_queue_recipe({ ...identity, promptOverrides: [{ field: 'params.positivePrompt', value: 'teacup, table' }] })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(await service.read_queue_recipe(identity)).toEqual(a);
  });
  it('source, Mask and independent inpaint text survive freeze; missing assets cannot enqueue', async () => {
    const { service, batch } = await setup();
    const assets = [{ role: 'source', mimeType: 'image/png', data: picture(80) }, { role: 'mask', mimeType: 'image/png', data: picture(255) }];
    const preparation = { ...prep('red teacup', { inpaintRecipe: { positivePrompt: 'blue teacup', negativePrompt: 'text', seed: 44, seedMode: 'fixed' } }), mode: 'inpaint', assets };
    const a = await service.put_queue_recipe({ preparation }); expect(a.snapshot.reviewInput.readiness.status).toBe('ready');
    await service.enqueue_queue_recipes({ requestKey: 'inpaint', items: [item(a)] });
    const sent = batch.enqueue.mock.calls[0][0].snapshots[0]; expect(sent.params.positivePrompt).toBe('blue teacup'); expect(sent.sourceImage.data).toBe(assets[0].data); expect(sent.inpaint.maskBase64).toBe(assets[1].data);
    const blocked = await service.put_queue_recipe({ preparation: { ...preparation, assets: [] } });
    expect(blocked.snapshot.reviewInput.readiness.status).toBe('blocked');
    await expect(service.enqueue_queue_recipes({ requestKey: 'missing', items: [item(blocked)] })).rejects.toMatchObject({ code: 'recipe_blocked' });
    expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('stores one frozen large-image snapshot for twenty seeds of the same i2i recipe', async () => {
    const { service, batch } = await setup(), large = largePicture();
    const saved = await service.put_queue_recipe({ preparation: { ...prep(), mode: 'i2i', assets: [{ role: 'source', mimeType: 'image/png', data: large }] } });
    await service.enqueue_queue_recipes({ requestKey: 'large-shared-source', items: Array.from({ length: 20 }, (_, seed) => item(saved, seed + 1)) });
    const sent = batch.enqueue.mock.calls[0][0];
    expect(sent.snapshot.sourceImage.data).toBe(large); expect(sent.snapshots).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(sent))).toBeLessThan(5 * 1024 * 1024);
  });
  it('corrupt files and symlink records are never trusted or replaced', async () => {
    const { service, runtimeDir, batch } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() });
    const file = path.join(runtimeDir, 'queue-recipes', `${a.recipeId}.1.json`);
    const content = JSON.parse(await fs.readFile(file, 'utf8')); content.preparation.authored.params.positivePrompt = 'tampered'; await fs.writeFile(file, JSON.stringify(content));
    await expect(service.enqueue_queue_recipes({ requestKey: 'tampered', items: [item(a)] })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    await fs.unlink(file); await fs.symlink(path.join(runtimeDir, 'absent.json'), file);
    await expect(service.read_queue_recipe({ recipeId: a.recipeId, recipeRevision: 1 })).rejects.toBeDefined();
    expect(batch.enqueue).not.toHaveBeenCalled();
  });
  it('rejects deep/cyclic input, unknown entries, symlink quota locks and a symlinked runtime root before recursive work', async () => {
    const { service, runtimeDir } = await setup(); let deep: any = {}; const root = deep; for (let index = 0; index < 98; index++) deep = deep.child = {};
    await expect(service.put_queue_recipe({ preparation: root })).rejects.toMatchObject({ code: 'queue_input_too_large' });
    root.loop = root; await expect(service.put_queue_recipe({ preparation: root })).rejects.toBeDefined();
    await fs.mkdir(path.join(runtimeDir, 'queue-recipes')); await fs.writeFile(path.join(runtimeDir, 'queue-recipes', 'unexpected'), 'sentinel');
    await expect(service.put_queue_recipe({ preparation: prep() })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    await fs.unlink(path.join(runtimeDir, 'queue-recipes', 'unexpected'));
    await fs.symlink(path.join(runtimeDir, 'outside-lock'), path.join(runtimeDir, 'queue-recipes', '.quota.lock'));
    await expect(service.put_queue_recipe({ preparation: prep() })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-queue-linked-runtime-')); cleanups.push(parent); const target = path.join(parent, 'target'), linked = path.join(parent, 'linked'); await fs.mkdir(target); await fs.symlink(target, linked);
    const before = await fs.readdir(target), linkedService = createQueueRecipeService({ runtimeDir: linked, batch: (await setup()).batch });
    await expect(linkedService.put_queue_recipe({ preparation: prep() })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    expect(await fs.readdir(target)).toEqual(before);
  });
  it('unknown receipt after an unconfirmed exception is not automatically resubmitted', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: 'unknown', items: [item(a)] }; 
    batch.enqueue.mockRejectedValueOnce(new Error('connection dropped before acknowledgement'));
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    expect(await service.lookup_queue_request({ requestKey: 'unknown' })).toEqual({ batch: null, status: 'unknown' }); expect(batch.enqueue).toHaveBeenCalledTimes(1);
    const restored=createQueueRecipeService({runtimeDir:await copiedRuntime(runtimeDir),batch});expect(await restored.lookup_queue_request({requestKey:args.requestKey})).toEqual({batch:null,status:'unknown'});expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('keeps queue_storage_error unknown when durable create may have completed, then reconciles after restart without replay', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: 'storage-create-uncertain', items: [item(a, 71)] };
    let durable: any = null;
    batch.enqueue.mockImplementationOnce(async (submit: any) => {
      durable = { ...submit, batchId: randomUUID(), originWorkspaceId: submit.workspaceId, submittedRevision: 0, status: 'queued',
        items: submit.seeds.map((plannedSeed: number, index: number) => ({ index, plannedSeed, status: 'pending', jobId: null, results: [] })) };
      delete durable.snapshots;
      throw Object.assign(new Error('state was published but final storage sync failed'), { code: 'queue_storage_error' });
    });
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_acceptance_unknown' });
    expect(await service.lookup_queue_request({ requestKey: args.requestKey })).toEqual({ batch: null, status: 'unknown' });
    const recoveredBatch = { ...batch, enqueue: vi.fn(), lookup: vi.fn((lookup: any) => lookup.requestKey === args.requestKey ? durable : null) };
    const restarted = createQueueRecipeService({ runtimeDir, batch: recoveredBatch });
    expect((await restarted.enqueue_queue_recipes(args)).batchId).toBe(durable.batchId);
    expect((await restarted.lookup_queue_request({ requestKey: args.requestKey })).status).toBe('accepted');
    expect(batch.enqueue).toHaveBeenCalledTimes(1); expect(recoveredBatch.enqueue).not.toHaveBeenCalled();
  });
  it('arbitrates near-capacity writes from two independent host service instances', async () => {
    const { service, batch, runtimeDir } = await setup(), directory = path.join(runtimeDir, 'queue-recipes'), image = largePicture();
    const largePreparation = { ...prep(), mode: 'i2i', assets: [{ role: 'source', mimeType: 'image/png', data: image }] };
    const sample = await service.put_queue_recipe({ preparation: largePreparation });
    const sampleFile = path.join(directory, `${sample.recipeId}.1.json`), sampleSize = (await fs.lstat(sampleFile)).size;
    const filler = path.join(directory, '00000000-0000-4000-8000-000000000097.1.json');
    let total = 0; for (const name of await fs.readdir(directory)) total += (await fs.lstat(path.join(directory, name))).size;
    const handle = await fs.open(filler, 'w'); await handle.truncate(512 * 1024 * 1024 - total - sampleSize - Math.floor(sampleSize / 2)); await handle.close();
    const other = createQueueRecipeService({ runtimeDir, batch });
    const outcomes = await Promise.allSettled([service.put_queue_recipe({ preparation: { ...largePreparation, authored: { ...largePreparation.authored, params: { ...largePreparation.authored.params, positivePrompt: 'variant a' } } } }), other.put_queue_recipe({ preparation: { ...largePreparation, authored: { ...largePreparation.authored, params: { ...largePreparation.authored.params, positivePrompt: 'variant b' } } } })]);
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(value => value.status === 'rejected')).toHaveLength(1);
    let final = 0; for (const name of await fs.readdir(directory)) if (!name.startsWith('.quota')) final += (await fs.lstat(path.join(directory, name))).size;
    expect(final).toBeLessThanOrEqual(512 * 1024 * 1024);
  });
  it('reserves a fixed receipt slot so accepted replacement succeeds at the 512 MiB edge', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: 'receipt-capacity-edge', items: [item(a, 81)] };
    const original = batch.enqueue.getMockImplementation()!;
    const filler = path.join(runtimeDir, 'queue-recipes', '00000000-0000-4000-8000-000000000099.1.json');
    batch.enqueue.mockImplementationOnce(async (submit: any) => {
      const job = await original(submit), directory = path.dirname(filler);
      let total = 0;
      for (const name of await fs.readdir(directory)) if (name.endsWith('.json')) total += (await fs.lstat(path.join(directory, name))).size;
      const handle = await fs.open(filler, 'w'); await handle.truncate(512 * 1024 * 1024 - total); await handle.close();
      return job;
    });
    const accepted = await service.enqueue_queue_recipes(args);
    const reconciled = await service.lookup_queue_request({ requestKey: args.requestKey });
    expect(reconciled.status).toBe('accepted'); expect(reconciled.batch?.batchId).toBe(accepted.batchId); expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('keeps queue_full durable at the 512 MiB edge across same-process and restarted repeats', async () => {
    const { service, batch, runtimeDir } = await setup(); const saved = await service.put_queue_recipe({ preparation: prep() }), filler = path.join(runtimeDir, 'queue-recipes', '00000000-0000-4000-8000-000000000098.1.json');
    batch.enqueue.mockImplementationOnce(async () => { const directory = path.dirname(filler); let total = 0; for (const name of await fs.readdir(directory)) total += (await fs.lstat(path.join(directory, name))).size; const handle = await fs.open(filler, 'w'); await handle.truncate(512 * 1024 * 1024 - total); await handle.close(); throw Object.assign(new Error('capacity reached'), { code: 'queue_full' }); });
    const args = { requestKey: 'rejected-at-capacity', items: [item(saved, 82)] };
    for (let index = 0; index < 2; index++) await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_full', message: 'capacity reached' });
    const restarted = createQueueRecipeService({ runtimeDir, batch }); await restarted.ready;
    await expect(restarted.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_full', message: 'capacity reached' }); expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it.each(['queue_full', 'queue_input_too_large'])('persists explicit %s rejection and returns it stably without another enqueue', async code => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: `reject-${code}`, items: [item(a)] }; 
    batch.enqueue.mockRejectedValueOnce(Object.assign(new Error(`explicit ${code}`), { code }));
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code, message: `explicit ${code}` });
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code, message: `explicit ${code}` });
    expect(await service.lookup_queue_request({ requestKey: args.requestKey })).toEqual({ batch: null, status: 'rejected', error: { code, message: `explicit ${code}` } });
    await expect(service.enqueue_queue_recipes({ ...args, items: [{ ...item(a), seed: 99 }] })).rejects.toMatchObject({ code: 'request_conflict' });
    expect(batch.enqueue).toHaveBeenCalledTimes(1);const restored=createQueueRecipeService({runtimeDir:await copiedRuntime(runtimeDir),batch});expect((await restored.lookup_queue_request({requestKey:args.requestKey})).status).toBe('rejected');expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('reconciles a batch accepted before the final receipt state and never enqueues twice', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: 'receipt-crash', items: [item(a, 11)] };
    const accepted = await service.enqueue_queue_recipes(args), file = path.join(runtimeDir, 'queue-recipes', `request-${recipeHash(args.requestKey)}.json`);
    const current = JSON.parse(await fs.readFile(file, 'utf8'));
    const { recordHash: acceptedHash, ...acceptedPayload } = current;
    const crashedPayload = { ...acceptedPayload, status: 'preparing', revision: current.revision - 1, batchId: null, result: null, error: null, previousRecordHash: current.previousRecordHash, updatedAt: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify({ ...crashedPayload, recordHash: recipeHash(crashedPayload) }));
    const restarted = createQueueRecipeService({ runtimeDir, batch });
    expect((await restarted.enqueue_queue_recipes(args)).batchId).toBe(accepted.batchId);
    expect((await restarted.lookup_queue_request({ requestKey: args.requestKey })).status).toBe('accepted');
    expect(batch.enqueue).toHaveBeenCalledTimes(1); expect(acceptedHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('fails closed when a terminal accepted receipt loses its durable batch', async () => {
    const { service, batch, jobs } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const args = { requestKey: 'accepted-missing', items: [item(a)] };
    await service.enqueue_queue_recipes(args); jobs.clear();
    await expect(service.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_storage_failed' });
    await expect(service.lookup_queue_request({ requestKey: args.requestKey })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('refuses a receipt of any other format, on enqueue and lookup, without dispatching or rewriting it', async () => {
    const { service, batch, runtimeDir } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() });
    const args = { requestKey: 'other-receipt', items: [item(a)] }; await service.enqueue_queue_recipes(args);
    const file = path.join(runtimeDir, 'queue-recipes', `request-${recipeHash(args.requestKey)}.json`), current = JSON.parse(await fs.readFile(file, 'utf8'));
    const other = { schemaVersion: 1, requestKey: args.requestKey, requestHash: current.requestHash, recipePlanHash: current.recipePlanHash, items: current.items, args: current.args };
    const text = JSON.stringify({ ...other, recordHash: recipeHash(other) }); await fs.writeFile(file, text);
    const restarted = createQueueRecipeService({ runtimeDir, batch });
    await expect(restarted.enqueue_queue_recipes(args)).rejects.toMatchObject({ code: 'queue_storage_failed', message: expect.stringContaining('unsupported format') });
    await expect(restarted.lookup_queue_request({ requestKey: args.requestKey })).rejects.toMatchObject({ code: 'queue_storage_failed' });
    expect(batch.enqueue).toHaveBeenCalledTimes(1); expect(await fs.readFile(file, 'utf8')).toBe(text);
  });
  it('skips system metadata files, and for any other entry refuses naming it (relative to the data root), logs it once and recovers once it is gone', async () => {
    const { batch, runtimeDir: base } = await setup(), runtimeDir = path.join(base, 'runtime'); await fs.mkdir(runtimeDir);
    const log = vi.fn(), service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, log });
    const first = await service.put_queue_recipe({ preparation: prep() }), store = path.join(runtimeDir, 'queue-recipes');
    // Finder and Explorer files (Explorer's in any case): read, counted, changed and removed by nobody.
    const metadata: Record<string, string> = { '.DS_Store': 'finder', '._recipe.json': 'appledouble', 'Thumbs.db': 'explorer', 'DESKTOP.INI': 'explorer' };
    for (const [name, text] of Object.entries(metadata)) await fs.writeFile(path.join(store, name), text);
    const second = await service.put_queue_recipe({ preparation: prep('second') });
    expect((await service.list_queue({})).storage.recipeStore).toMatchObject({ records: 2 });
    expect(await service.enqueue_queue_recipes({ requestKey: 'with-metadata', items: [item(first, 1), item(second, 2)] })).toMatchObject({ status: 'queued' });
    expect(await service.lookup_queue_request({ requestKey: 'with-metadata' })).toMatchObject({ status: 'accepted' });
    for (const [name, text] of Object.entries(metadata)) expect(await fs.readFile(path.join(store, name), 'utf8'), name).toBe(text);
    expect(log).not.toHaveBeenCalled();
    // Anything else stops the store without a change and names itself; a folder or a link with a metadata name is not skipped.
    for (const [name, make] of [['notes.txt', (file: string) => fs.writeFile(file, 'mine')], [`plan-${randomUUID()}.json`, (file: string) => fs.writeFile(file, '{}')], ['old', (file: string) => fs.mkdir(file)], ['Thumbs.db.lnk', (file: string) => fs.symlink(path.join(store, 'Thumbs.db'), file)]] as const) {
      const file = path.join(store, name); await make(file);
      const restarted = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, log });
      const expected = { code: 'queue_storage_failed', message: expect.stringContaining(`runtime/queue-recipes/${name}`), details: { reason: 'unsupported_entry', entry: `runtime/queue-recipes/${name}` } };
      await expect(restarted.put_queue_recipe({ preparation: prep('blocked') })).rejects.toMatchObject(expected);
      await expect(restarted.list_queue({})).rejects.toMatchObject(expected);
      await expect(restarted.lookup_queue_request({ requestKey: 'with-metadata' })).rejects.toMatchObject(expected);
      await expect(restarted.read_queue_recipe({ recipeId: first.recipeId, recipeRevision: 1 })).rejects.toMatchObject(expected);
      expect((await fs.lstat(file)).isSymbolicLink() || (await fs.stat(file)) !== null).toBe(true);
      expect(log.mock.calls.filter(([message]) => String(message).includes(`runtime/queue-recipes/${name}`))).toHaveLength(1);
      expect(log.mock.calls.at(-1)![0]).toMatch(/Move or delete that entry, then try again/);
      // Moving it away makes the same service usable again, without a restart.
      await fs.rm(file, { recursive: true });
      expect((await restarted.list_queue({})).storage.recipeStore).toMatchObject({ records: 3 });
      expect(await restarted.lookup_queue_request({ requestKey: 'with-metadata' })).toMatchObject({ status: 'accepted' });
    }
    expect(batch.enqueue).toHaveBeenCalledTimes(1);
  });
  it('marks only a store at its record or byte limit as full', async () => {
    const { batch, runtimeDir } = await setup(), service = createQueueRecipeService({ runtimeDir, batch, randomSeed: () => 97, recordLimit: 1 });
    await service.put_queue_recipe({ preparation: prep() });
    await expect(service.put_queue_recipe({ preparation: prep('over the limit') })).rejects.toMatchObject({ code: 'queue_storage_failed', message: expect.stringContaining('Recipe storage is full'), details: { reason: 'store_full' } });
  });
  it('H1 stores upscale and Director recipes as ready; a mask outside inpaint is rejected before anything is written', async () => {
    const { service, runtimeDir } = await setup(), source = picture(120);
    const upscale = await service.put_queue_recipe({ preparation: { mode: 'upscale', authored: { params: {}, upscaleScale: 2 }, assets: [{ role: 'source', mimeType: 'image/png', data: source }] } });
    expect(upscale.snapshot).toMatchObject({ mode: 'upscale', reviewInput: { mode: 'upscale', readiness: { status: 'ready' }, effective: { sampling: { seedPolicy: 'unused' } } } });
    expect(upscale.snapshot.reviewInput.assets.find((asset: any) => asset.role === 'source').data).toBe(source);
    const director = await service.put_queue_recipe({ preparation: { mode: 'director', authored: { params: {}, directorTool: 'colorize', augmentOptions: { defry: 1, colorizePrompt: 'blue coat', emotion: 'happy', emotionLevel: 0 } }, assets: [{ role: 'source', mimeType: 'image/png', data: source }] } });
    expect(director.snapshot).toMatchObject({ mode: 'director', reviewInput: { readiness: { status: 'ready' }, authored: { directorTool: 'colorize', augmentOptions: { defry: 1, colorizePrompt: 'blue coat' } } } });
    expect((await service.read_queue_recipe({ recipeId: upscale.recipeId, recipeRevision: 1 })).inputHash).toBe(upscale.inputHash);
    const before = (await fs.readdir(path.join(runtimeDir, 'queue-recipes'))).sort();
    const mask = { role: 'mask', mimeType: 'image/png', data: picture(255) };
    for (const preparation of [
      { mode: 'upscale', authored: { params: {}, upscaleScale: 2 }, assets: [{ role: 'source', mimeType: 'image/png', data: source }, mask] },
      { mode: 'director', authored: { params: {}, directorTool: 'bg-removal' }, assets: [{ role: 'source', mimeType: 'image/png', data: source }, mask] },
      { ...prep(), mode: 'i2i', assets: [{ role: 'source', mimeType: 'image/png', data: source }, mask] },
      { ...prep(), mode: 'enhance', assets: [{ role: 'source', mimeType: 'image/png', data: source }, mask] },
      { ...prep(), assets: [mask] },
    ]) await expect(service.put_queue_recipe({ preparation })).rejects.toMatchObject({ code: 'invalid_argument', message: 'Only inpaint recipes take a mask asset.' });
    await expect(service.put_queue_recipe({ preparation: { ...prep(), mode: 'variation' } })).rejects.toMatchObject({ code: 'invalid_argument', message: 'Independent queues support t2i, i2i, inpaint, enhance, upscale and director.' });
    expect((await fs.readdir(path.join(runtimeDir, 'queue-recipes'))).sort()).toEqual(before);
  });
  it('H2 unseeded recipes enqueue with planned seed 0; a seed or a repeated recipe is rejected before dispatch', async () => {
    const { service, batch, runtimeDir } = await setup(), source = picture(130), other = picture(140);
    const upscale = (data: string) => service.put_queue_recipe({ preparation: { mode: 'upscale', authored: { params: {}, upscaleScale: 2 }, assets: [{ role: 'source', mimeType: 'image/png', data }] } });
    const a = await upscale(source), b = await upscale(other);
    await expect(service.enqueue_queue_recipes({ requestKey: 'upscale-seeded', items: [item(a, 5)] })).rejects.toMatchObject({ code: 'invalid_argument', message: 'Upscale and Director recipes do not use a seed; omit seed for these items.' });
    await expect(service.enqueue_queue_recipes({ requestKey: 'upscale-repeated', items: [item(a), item(b), item(a)] })).rejects.toMatchObject({ code: 'invalid_argument', message: 'An upscale or Director recipe may appear only once in one queue submission.' });
    // Both are refused before a receipt exists (W2d): the keys stay unused and can carry a corrected plan.
    for (const requestKey of ['upscale-seeded', 'upscale-repeated']) expect(await service.lookup_queue_request({ requestKey })).toEqual({ batch: null });
    expect(await fs.readdir(path.join(runtimeDir, 'queue-recipes'))).not.toContain(`request-${recipeHash('upscale-repeated')}.json`);
    expect(batch.enqueue).not.toHaveBeenCalled();
    const job = await service.enqueue_queue_recipes({ requestKey: 'upscale-repeated', items: [item(a), item(b)] });
    expect(job.items.map((value: any) => value.plannedSeed)).toEqual([0, 0]);
    const sent = batch.enqueue.mock.calls[0][0];
    expect(sent).toMatchObject({ execution: 'queued', mode: 'upscale', count: 2, seeds: [0, 0] });
    expect(sent.snapshots.map((snapshot: any) => [snapshot.sourceImage.data, snapshot.upscale.scale])).toEqual([[source, 2], [other, 2]]);
    const director = await service.put_queue_recipe({ preparation: { mode: 'director', authored: { params: {}, directorTool: 'bg-removal' }, assets: [{ role: 'source', mimeType: 'image/png', data: source }] } });
    await service.enqueue_queue_recipes({ requestKey: 'director-one', items: [item(director)] });
    const directed = batch.enqueue.mock.calls[1][0];
    expect(directed).toMatchObject({ mode: 'director', count: 1, seeds: [0] });
    expect(directed.snapshots[0]).toMatchObject({ sourceImage: { data: source }, director: { tool: 'bg-removal' } });
    await expect(service.enqueue_queue_recipes({ requestKey: 'mixed-unseeded', items: [item(a), item(director)] })).rejects.toMatchObject({ code: 'invalid_argument', message: /one generation mode/ });
    // Seeded modes keep repeated recipes with distinct seeds.
    const t2i = await service.put_queue_recipe({ preparation: prep() });
    await service.enqueue_queue_recipes({ requestKey: 't2i-repeated', items: [item(t2i, 1), item(t2i, 2)] });
    expect(batch.enqueue.mock.calls[2][0]).toMatchObject({ mode: 't2i', seeds: [1, 2] });
    expect(batch.enqueue).toHaveBeenCalledTimes(3);
  });
  it.each([{ workspaceId: 'canvas' }, { params: { model: 'fake' } }, { charCaptions: [{ prompt: 'woman', x: .2, y: .5 }] }, { inpaintMask: null }, { vibeImages: [{ strength: .5 }] }])('rejects invalid/foreign authored fields %j', async fields => {
    const { service } = await setup(); await expect(service.put_queue_recipe({ preparation: prep('teacup', fields) })).rejects.toBeDefined();
  });
  it('headless controls require queue ownership and use no live revision', async () => {
    const { service, batch, jobs } = await setup(); const a = await service.put_queue_recipe({ preparation: prep() }); const job = await service.enqueue_queue_recipes({ requestKey: 'control', items: [item(a)] });
    expect((await service.list_queue({})).batches).toHaveLength(1);
    await service.pause_queue({ batchId: job.batchId }); await service.resume_queue({ batchId: job.batchId }); await service.cancel_queue({ batchId: job.batchId });
    expect(batch.resume).toHaveBeenCalledWith({ workspaceId: QUEUE_WORKSPACE, expectedRevision: 0, batchId: job.batchId });
    jobs.get('control').originWorkspaceId = 'some-canvas';
    await expect(service.cancel_queue({ batchId: job.batchId })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect((await service.list_queue({})).batches).toHaveLength(0);
  });
});
