import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { DEFAULT_PARAMS, DEFAULT_AUGMENT_OPTIONS, type GenerateResult, type HistoryItem } from '../src/types';
import { createGenerationService } from './generation-service';
import { startHttpBridge } from './bridge-server';
import { beginJob, cancelAllJobs, hasActiveGenerationJobs, reserveQueueGeneration } from './ipc/job-registry';
import { waitUntil } from '../src/test-support/wait-until';

const pixels = new PNG({ width: 64, height: 64 }); pixels.data.fill(255);
const IMAGE = PNG.sync.write(pixels);
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups([...cleanup.splice(0).reverse(), () => vi.restoreAllMocks()]));
function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function snapshot() { return { params: { ...DEFAULT_PARAMS, positivePrompt: 'a blue teacup on a wooden table', width: 64, height: 64, seed: 42, seedMode: 'fixed' as const }, extras: { vibeImages: [], preciseReferences: [], charCaptions: [] }, batchCount: 5 }; }
function independentInpaintSnapshot() { return { ...snapshot(), recipeScope: 'independent_inpaint' as const, unusedInputs: ['forged-unused-field'], sourceImage: { mimeType: 'image/png', data: IMAGE.toString('base64') }, inpaint: { model: 'nai-diffusion-5-full-inpainting' as const, maskBase64: IMAGE.toString('base64'), strength: .7, noise: .9 }, params: { ...snapshot().params, positivePrompt: 'a red teacup with a white handle', negativePrompt: 'blue teacup, broken handle', steps: 18, cfgScale: 4.2, cfgRescale: .2, sampler: 'k_euler' as const, noiseSchedule: 'native', seed: 31415 } }; }
function submission(overrides: Record<string, any> = {}) { return { workspaceId: 'workspace-before-reload', expectedRevision: 7, requestKey: 'tea-study-1', mode: 't2i', snapshot: snapshot(), ...overrides }; }
function item(): HistoryItem { return { id: 'history-1', filePath: '/private/not-public/fixture.png', fileUrl: 'nai-media://private/fixture.png', date: '2026-09-10', createdAt: '2026-09-10T17:30:00Z', params: snapshot().params, actualSeed: 42, model: DEFAULT_PARAMS.model, width: 64, height: 64 }; }
function success(): GenerateResult { return { ok: true, message: 'Saved', items: [item()], actualSeed: 42 }; }
function setup(extra: Partial<Parameters<typeof createGenerationService>[0]> = {}) {
  const execution = pending<GenerateResult>();
  const execute = vi.fn<Parameters<typeof createGenerationService>[0]['execute']>(async (_mode, _snapshot, options) => { options.onSubmitted?.(); return execution.promise; });
  const release = vi.fn(); const onJob = vi.fn();
  const service = createGenerationService({ execute, validateImage: value => { const decoded = PNG.sync.read(value); return { width: decoded.width, height: decoded.height }; }, reserve: () => release, onJob, readResult: async () => IMAGE, ...extra });
  return { service, execute, execution, release, onJob };
}
async function running(value: ReturnType<typeof setup>) { await waitUntil(() => expect(value.execute).toHaveBeenCalledTimes(1)); }
async function finished(value: ReturnType<typeof setup>, jobId: string) { await waitUntil(() => expect(value.service.read({ workspaceId: 'workspace', jobId }).finishedAt).not.toBeNull()); }

describe('process-owned queue generation jobs', () => {
  it('returns a single asynchronous job, freezes input, and preserves full prompt/seed after user edits', async () => {
    const state = setup(); const args = submission();
    (args.snapshot.extras as any).historyGroupId = 'frozen-group';
    const job = state.service.submit(args);
    expect(job).toMatchObject({ status: 'preparing', actualSeed: 42, providerRequestId: null, inputSummary: { sampleCount: 1, ignoredBatchCount: 5 } });
    args.snapshot.params.positivePrompt = 'a later manual change';
    (args.snapshot.extras as any).historyGroupId = 'later-group';
    await running(state);
    expect(state.execute.mock.calls[0][1].params.positivePrompt).toBe('a blue teacup on a wooden table');
    expect(state.execute.mock.calls[0][2].singleRequest).toBe(true);
    expect(state.execute.mock.calls[0][2].historyGroupId).toBe('frozen-group');
    state.execution.resolve(success()); await finished(state, job.jobId);
    const saved = state.service.read({ workspaceId: 'workspace', jobId: job.jobId });
    expect(saved).toMatchObject({ status: 'succeeded', model: DEFAULT_PARAMS.model, input: { params: { positivePrompt: 'a blue teacup on a wooden table', seed: 42 } } });
    expect(JSON.stringify(saved)).not.toContain('/private/');
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('deduplicates before busy checks even if the original response was lost, rejecting a changed mode/revision', async () => {
    const state = setup(); const args = submission(); const job = state.service.submit(args);
    expect(state.service.submit({ ...args, snapshot: undefined }).jobId).toBe(job.jobId);
    expect(() => state.service.submit({ ...args, expectedRevision: 8 })).toThrow(/requestKey/);
    expect(() => state.service.submit({ ...args, mode: 'i2i' })).toThrow(/requestKey/);
    expect(() => state.service.submit(submission({ requestKey: 'another' }))).toThrow(/already runs a job/);
    await running(state); state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.lookup(args)?.jobId).toBe(job.jobId);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps process jobs readable from a new renderer workspace while retaining original provenance', async () => {
    const state = setup(); const job = state.service.submit(submission()); await running(state);
    const context = { workspaceId: 'new-renderer', jobId: job.jobId };
    expect(state.service.list(context)).toMatchObject({ workspaceId: 'new-renderer', jobs: [{ jobId: job.jobId, workspaceId: 'new-renderer', originWorkspaceId: 'workspace-before-reload', submittedRevision: 7 }] });
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.read(context).status).toBe('succeeded');
    expect(await state.service.result(context)).toMatchObject({ workspaceId: 'new-renderer', jobId: job.jobId, mimeType: 'image/png', historyItem: { id: 'history-1' } });
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it('binds an adopted draft to the original request version while retaining its actual submission version', async () => {
    const state = setup(), args = submission({ draftId: 'draft-reviewed', submittedRevision: 8 });
    const job = state.service.submit(args);
    expect(job).toMatchObject({ draftId: 'draft-reviewed', expectedRevision: 7, submittedRevision: 8 });
    expect(state.service.lookup({ ...args, submittedRevision: undefined })?.jobId).toBe(job.jobId);
    expect(state.service.submit({ ...args, snapshot: undefined }).jobId).toBe(job.jobId);
    for (const change of [{ draftId: 'draft-replaced' }, { draftId: undefined }, { expectedRevision: 8 }]) {
      expect(() => state.service.lookup({ ...args, ...change })).toThrow(expect.objectContaining({ code: 'request_conflict' }));
    }
    await running(state);
    expect(state.execute.mock.calls[0][2].provenance).toMatchObject({ submittedRevision: 8 });
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.read({ workspaceId: 'reloaded', jobId: job.jobId })).toMatchObject({ draftId: 'draft-reviewed', expectedRevision: 7, submittedRevision: 8 });
    expect(await state.service.result({ workspaceId: 'reloaded', jobId: job.jobId })).toMatchObject({ submittedRevision: 8 });
    expect(state.execute).toHaveBeenCalledOnce();
  });

  it.each([
    { draftId: '' }, { draftId: 4 }, { draftId: 'draft\ninvalid' },
    { draftId: 'draft-good', submittedRevision: 6 }, { draftId: 'draft-good', submittedRevision: 8.5 },
    { submittedRevision: 8 },
  ])('rejects invalid draft identity or submission revision %j before executing', change => {
    const state = setup();
    expect(() => state.service.submit(submission(change))).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'w' }).jobs).toEqual([]);
  });

  it('marks uncertain submitted failures unknown, never retries, and never leaks provider error contents', async () => {
    const state = setup(); const job = state.service.submit(submission()); await running(state);
    state.execution.reject(new Error('token=private-account-secret file=/Users/Private/result.png'));
    await finished(state, job.jobId);
    const result = state.service.read({ workspaceId: 'workspace', jobId: job.jobId });
    expect(result).toMatchObject({ status: 'unknown', providerOutcome: 'unknown', error: { code: 'provider_unknown' } });
    expect(JSON.stringify(result)).not.toMatch(/private-account|Users\/Private/);
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it('marks an explicit API validation rejection failed with its status, without retry', async () => {
    const state = setup(); const job = state.service.submit(submission()); await running(state);
    state.execution.resolve({ ok: false, message: 'Remote invalid field', items: [], statusCode: 422, failureKind: 'validation' });
    await finished(state, job.jobId);
    expect(state.service.read({ workspaceId: 'workspace', jobId: job.jobId })).toMatchObject({ status: 'failed', providerOutcome: 'response_received', error: { statusCode: 422 } });
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the slot occupied after targeted cancellation until the original call settles', async () => {
    const state = setup(); const job = state.service.submit(submission()); await running(state);
    const result = state.service.cancel({ workspaceId: 'workspace', jobId: job.jobId });
    expect(result.status).toBe('cancelling');
    expect(state.execute.mock.calls[0][2].signal.aborted).toBe(true);
    expect(state.release).not.toHaveBeenCalled();
    expect(() => state.service.submit(submission({ requestKey: 'second' }))).toThrow();
    state.execution.resolve({ ok: false, message: 'cancelled', items: [], failureKind: 'cancelled' });
    await finished(state, job.jobId);
    expect(state.service.read({ workspaceId: 'workspace', jobId: job.jobId })).toMatchObject({ status: 'cancelled', cancelRequested: true, providerOutcome: 'unknown' });
    expect(state.release).toHaveBeenCalledTimes(1);
  });

  it('retains saved late success and never changes a completed job to cancelled', async () => {
    const state = setup(); const job = state.service.submit(submission()); await running(state);
    state.service.cancel({ workspaceId: 'workspace', jobId: job.jobId });
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.cancel({ workspaceId: 'workspace', jobId: job.jobId })).toMatchObject({ status: 'succeeded', cancelRequested: true, results: [{ id: 'history-1' }] });
    expect((await state.service.result({ workspaceId: 'workspace', jobId: job.jobId })).data).toBe(IMAGE.toString('base64'));
  });

  it('cancels during quotation without ever submitting generation, preserving unavailable cost as null', async () => {
    const quote = pending<{ source: string; amount: number | null }>(); const state = setup({ quote: () => quote.promise });
    const job = state.service.submit(submission()); state.service.cancel({ workspaceId: 'workspace', jobId: job.jobId });
    quote.reject(new Error('quote unavailable')); await finished(state, job.jobId);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.read({ workspaceId: 'workspace', jobId: job.jobId })).toMatchObject({ status: 'cancelled', quote: { source: 'unavailable', amount: null }, providerOutcome: 'not_submitted' });
  });

  it('rejects every reference and inpaint character configuration before costing or execution', () => {
    const state = setup();
    const reference = submission(); reference.snapshot.extras.vibeImages = [{ base64: IMAGE.toString('base64') }] as any;
    expect(() => state.service.submit(reference)).toThrow(/Precise\/Vibe references/);
    const precise = submission(); precise.snapshot.extras.preciseReferences = [{ base64: IMAGE.toString('base64') }] as any;
    expect(() => state.service.submit(precise)).toThrow(/Precise\/Vibe references/);
    const characters = submission({ mode: 'inpaint' }); characters.snapshot.extras.charCaptions = [{ prompt: 'a gardener' }];
    expect(() => state.service.submit(characters)).toThrow(/character prompts/);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'workspace' }).jobs).toEqual([]);
  });

  it('freezes source bytes and actual i2i noise seed independently of later image selection', async () => {
    const state = setup(); const args = submission({ mode: 'i2i', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: IMAGE.toString('base64') }, i2i: { strength: 0.5, noise: 0.9, extraNoiseSeed: 0 } } });
    const job = state.service.submit(args); args.snapshot.sourceImage.data = 'different image'; await running(state);
    expect(state.execute.mock.calls[0][2].sourceBytes).toEqual(IMAGE);
    const input = state.service.read({ workspaceId: 'workspace', jobId: job.jobId }).input;
    expect(input.i2i?.noise).toBe(0); expect(input.i2i!.extraNoiseSeed).toBeGreaterThan(0);
    expect(JSON.stringify(input)).not.toContain(IMAGE.toString('base64'));
    state.execution.resolve(success()); await finished(state, job.jobId);
  });

  it('rejects unsupported inpaint Furry mode without silently discarding it or starting a job', () => {
    const quote = vi.fn(); const state = setup({ quote });
    const args = submission({ mode: 'inpaint', snapshot: { ...snapshot(), extras: { ...snapshot().extras, modelMode: 'furry' } } });
    expect(() => state.service.submit(args)).toThrow(expect.objectContaining({ code: 'unsupported_configuration' }));
    expect(args.snapshot.extras.modelMode).toBe('furry');
    expect(quote).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'workspace' }).jobs).toEqual([]);
  });

  it('reports actual source-aligned inpaint dimensions and mask hash without publishing mask bytes', async () => {
    const small = new PNG({ width: 65, height: 66 }); small.data.fill(255); const source = PNG.sync.write(small).toString('base64');
    const state = setup(); const job = state.service.submit(submission({ mode: 'inpaint', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: source }, inpaint: { model: 'nai-diffusion-5-full-inpainting', maskBase64: source, strength: 1, noise: 0 } } }));
    expect(job.inputSummary).toMatchObject({ width: 128, height: 128, source: { width: 65, height: 66 } });
    const input = state.service.read({ workspaceId: 'workspace', jobId: job.jobId }).input;
    expect(input).not.toHaveProperty('recipeScope');
    expect(input.inpaint?.mask).toMatchObject({ width: 65, height: 66, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(input)).not.toContain(source);
    await running(state); state.execution.resolve(success()); await finished(state, job.jobId);
  });

  it('freezes the independent inpaint recipe for quotation, execution and readback without borrowing base characters', async () => {
    const quote = vi.fn<NonNullable<Parameters<typeof createGenerationService>[0]['quote']>>(async () => ({ source: 'fixture', amount: 1 }));
    const state = setup({ quote }); const input = independentInpaintSnapshot();
    const job = state.service.submit(submission({ mode: 'inpaint', snapshot: input }));
    const frozen = state.service.read({ workspaceId: 'workspace', jobId: job.jobId }).input;
    expect(job.inputSummary.characterCount).toBe(0);
    expect(frozen).toMatchObject({ recipeScope: 'independent_inpaint', params: { positivePrompt: 'a red teacup with a white handle', negativePrompt: 'blue teacup, broken handle', steps: 18, cfgScale: 4.2, cfgRescale: .2, sampler: 'k_euler', noiseSchedule: 'native', seed: 31415, seedMode: 'fixed' }, extras: { charCaptions: [] }, inpaint: { model: 'nai-diffusion-5-full-inpainting', strength: .7, noise: 0 } });
    expect(frozen.unusedInputs).toEqual(['params', 'charCaptions', 'inpaintPositivePrompt']);
    // The host must not mutate the caller's current workspace or accept its metadata.
    expect(input.unusedInputs).toEqual(['forged-unused-field']);
    expect(input.inpaint.noise).toBe(.9);
    input.params.positivePrompt = 'a later manual prompt'; input.params.negativePrompt = 'a later manual negative';
    input.params.steps = 28; input.params.cfgScale = 7; input.params.seed = 27;
    (input.extras.charCaptions as any[]).push({ prompt: 'a later adult gardener' });
    input.unusedInputs.push('later'); input.inpaint.strength = .1;
    await running(state);
    expect(quote).toHaveBeenCalledTimes(1);
    const quoted = quote.mock.calls[0][1];
    const executed = state.execute.mock.calls[0][1];
    for (const payload of [quoted, executed]) {
      expect(payload.params).toEqual(frozen.params);
      expect(payload.extras).toMatchObject({ charCaptions: [] });
      expect(payload.recipeScope).toBe('independent_inpaint');
      expect(payload.unusedInputs).toEqual(['params', 'charCaptions', 'inpaintPositivePrompt']);
    }
    // Readback and executor-owned copies also cannot alter the host's frozen recipe.
    executed.params.negativePrompt = 'executor mutation'; executed.extras.charCaptions.push({ prompt: 'executor mutation' } as any);
    frozen.params.positivePrompt = 'readback mutation'; frozen.unusedInputs!.push('readback mutation');
    const expectedInput = state.service.read({ workspaceId: 'workspace', jobId: job.jobId }).input;
    expect(expectedInput.params).toMatchObject({ positivePrompt: 'a red teacup with a white handle', negativePrompt: 'blue teacup, broken handle', steps: 18, cfgScale: 4.2, seed: 31415 });
    expect(expectedInput.extras.charCaptions).toEqual([]);
    expect(expectedInput.unusedInputs).toEqual(['params', 'charCaptions', 'inpaintPositivePrompt']);
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.read({ workspaceId: 'workspace', jobId: job.jobId }).input).toEqual(expectedInput);
  });

  it.each([
    ['inpaint', 'base'], ['inpaint', null], ['inpaint', {}],
    ...['t2i', 'i2i', 'enhance', 'upscale', 'director'].map(mode => [mode, 'independent_inpaint']),
  ])('rejects forged recipe scope %s/%j before any costing, reservation or execution', (mode, recipeScope) => {
    const quote = vi.fn(); const reserve = vi.fn(); const state = setup({ quote, reserve });
    expect(() => state.service.submit(submission({ mode, snapshot: { ...independentInpaintSnapshot(), recipeScope } }))).toThrow(expect.objectContaining({ code: 'invalid_arguments' }));
    expect(quote).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'workspace' }).jobs).toEqual([]);
  });

  it('rejects independent recipe and inpaint model mismatches before normalizing, costing or execution', () => {
    const quote = vi.fn(); const reserve = vi.fn(); const state = setup({ quote, reserve });
    const input = independentInpaintSnapshot(); input.params.model = 'nai-diffusion-4-5-full';
    const original = structuredClone(input);
    expect(() => state.service.submit(submission({ mode: 'inpaint', snapshot: input }))).toThrow(expect.objectContaining({ code: 'invalid_configuration' }));
    expect(input).toEqual(original);
    expect(quote).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'workspace' }).jobs).toEqual([]);
  });

  it.each([
    [{ charCaptions: [{ prompt: 'an adult gardener' }] }, 'unsupported_configuration'],
    [{ vibeImages: [{ base64: IMAGE.toString('base64') }] }, 'unsupported_reference'],
    [{ preciseReferences: [{ base64: IMAGE.toString('base64') }] }, 'unsupported_reference'],
    [{ modelMode: 'furry' }, 'unsupported_configuration'],
  ])('does not use independent scope to discard unsupported configuration %j', (extras, code) => {
    const quote = vi.fn(); const reserve = vi.fn(); const state = setup({ quote, reserve });
    const input = independentInpaintSnapshot(); Object.assign(input.extras, extras);
    const original = structuredClone(input);
    expect(() => state.service.submit(submission({ mode: 'inpaint', snapshot: input }))).toThrow(expect.objectContaining({ code }));
    expect(input).toEqual(original);
    expect(quote).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
    expect(state.service.list({ workspaceId: 'workspace' }).jobs).toEqual([]);
  });

  it('rejects a job beside a non-queue job and keeps queue cancellation apart from cancelAllJobs', () => {
    const manual = beginJob();
    const state = setup({ isBusy: hasActiveGenerationJobs, reserve: reserveQueueGeneration });
    expect(() => state.service.submit(submission())).toThrow(/already runs a job/);
    manual.end();
    const release = reserveQueueGeneration(); const controller = new AbortController();
    const isolated = beginJob({ isolated: true, signal: controller.signal });
    expect(cancelAllJobs()).toBe(false); expect(isolated.controller.signal.aborted).toBe(false);
    expect(() => beginJob()).toThrow(expect.objectContaining({ code: 'workspace_busy' }));
    controller.abort(); expect(isolated.controller.signal.aborted).toBe(true);
    expect(hasActiveGenerationJobs()).toBe(true);
    isolated.end(); release(); expect(hasActiveGenerationJobs()).toBe(false);
  });

  it('blocks unknown job IDs, result indices, and read-before-ready without accepting caller paths', async () => {
    const state = setup(); const job = state.service.submit(submission());
    expect(() => state.service.read({ workspaceId: 'workspace', jobId: 'missing' })).toThrow();
    await expect(state.service.result({ workspaceId: 'workspace', jobId: job.jobId, path: '/etc/passwd' })).rejects.toMatchObject({ code: 'result_not_ready' });
    await expect(state.service.result({ workspaceId: 'workspace', jobId: job.jobId, index: -1 })).rejects.toMatchObject({ code: 'invalid_arguments' });
    await running(state); state.execution.resolve(success()); await finished(state, job.jobId);
  });

  it('strips internal HistoryItem and arbitrary nested fields at the real HTTP result boundary (get_queue_result)', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-generation-http-')); cleanup.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const server = await startHttpBridge({ runtimeDir, dispatch: async () => ({ workspaceId: 'new-renderer', jobId: 'job-1', index: 0, data: IMAGE.toString('base64'), mimeType: 'image/png', historyItem: item(), path: '/private/source.png', nested: { token: 'private' }, width: 64, height: 64, historyId: 'history-1', model: DEFAULT_PARAMS.model, actualSeed: 42 }) });
    cleanup.push(() => server.close());
    const response = await fetch(`${server.connection.url}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${server.connection.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'get_queue_result', args: { batchId: '11111111-1111-4111-8111-111111111111', itemIndex: 0, index: 0 } }) });
    const body = await response.json();
    expect(response.status).toBe(200); expect(body.result).toMatchObject({ jobId: 'job-1', historyId: 'history-1', mimeType: 'image/png', actualSeed: 42 });
    expect(JSON.stringify(body)).not.toMatch(/historyItem|filePath|fileUrl|private|nested/);
  });
});


describe('process-owned postprocessing recipes', () => {
  it('recomputes Enhance from actual source dimensions and exposes the actual frozen noise/seed recipe', async () => {
    const state = setup();
    const input = { ...snapshot(), sourceImage: { mimeType: 'image/png', data: IMAGE.toString('base64') }, sourceSummary: { width: 9000, height: 9000, sourceMode: 'latest' as const }, enhance: { magnitude: 4, scale: 2 as const, requestedNoise: .9 }, i2i: { strength: .99, noise: .99, extraNoiseSeed: 0 } };
    const job = state.service.submit(submission({ mode: 'enhance', snapshot: input }));
    input.enhance.magnitude = 10; input.sourceImage.data = 'changed';
    await running(state);
    const effective = state.execute.mock.calls[0][1];
    expect(effective.params).toMatchObject({ width: 128, height: 128, seedMode: 'fixed', seed: 42 });
    expect(effective.enhance).toMatchObject({ magnitude: 4, scale: 2 });
    expect(effective.i2i!.strength).toBeCloseTo(.236); expect(effective.i2i!.noise).toBe(0); expect(effective.i2i!.extraNoiseSeed).toBeGreaterThan(0);
    state.execution.resolve(success()); await finished(state, job.jobId);
    const read = state.service.read({ workspaceId: 'new-context', jobId: job.jobId });
    expect(read.inputSummary).toMatchObject({ width: 128, height: 128, source: { width: 64, height: 64 } });
    expect(read.input).toMatchObject({ enhance: { magnitude: 4 }, processing: { outputWidth: 128, outputHeight: 128, resizedInput: true }, i2i: { noise: 0 } });
    expect(JSON.stringify(read)).not.toContain(IMAGE.toString('base64'));
  });

  it.each(['upscale', 'director'] as const)('keeps %s seeds null throughout list, read and result while preserving every response candidate', async mode => {
    const state = setup();
    const input = { ...snapshot(), sourceImage: { mimeType: 'image/png', data: IMAGE.toString('base64') }, upscale: { scale: 2 as const }, director: { tool: 'bg-removal' as const, options: { ...DEFAULT_AUGMENT_OPTIONS } } };
    input.params.positivePrompt = ''; input.extras.charCaptions = [{ prompt: 'unused adult gardener' }];
    const job = state.service.submit(submission({ mode, snapshot: input }));
    expect(job.actualSeed).toBeNull(); await running(state);
    expect(state.execute.mock.calls[0][1].extras.charCaptions).toEqual([]);
    state.execution.resolve({ ok: true, message: 'saved fixture candidates', items: [0, 1, 2].map(index => ({ ...item(), id: 'candidate-' + index, model: mode === 'upscale' ? 'nai-diffusion-5-curated' : 'director-bg-removal', actualSeed: 0 })) });
    await finished(state, job.jobId);
    const read = state.service.read({ workspaceId: 'new-context', jobId: job.jobId });
    expect(read.actualSeed).toBeNull(); expect(read.results).toHaveLength(3);
    expect(read.results.every(result => result.actualSeed === null)).toBe(true);
    expect(read.input.unusedInputs).toEqual(expect.arrayContaining(['params', 'charCaptions', 'vibeImages', 'preciseReferences']));
    expect(state.service.list({ workspaceId: 'new-context' }).jobs[0].actualSeed).toBeNull();
    for (let index = 0; index < 3; index++) expect(await state.service.result({ workspaceId: 'new-context', jobId: job.jobId, index })).toMatchObject({ actualSeed: null, historyId: 'candidate-' + index, originWorkspaceId: 'workspace-before-reload' });
    expect(state.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects 4×, invalid Director options, and excessive Enhance before quotation or reservation', () => {
    const quote = vi.fn(); const reserve = vi.fn(); const state = setup({ quote, reserve });
    const base = { ...snapshot(), sourceImage: { mimeType: 'image/png', data: IMAGE.toString('base64') } };
    expect(() => state.service.submit(submission({ mode: 'upscale', snapshot: { ...base, upscale: { scale: 4 } } }))).toThrow(/2×/);
    expect(() => state.service.submit(submission({ mode: 'director', snapshot: { ...base, director: { tool: 'made-up', options: DEFAULT_AUGMENT_OPTIONS } } }))).toThrow(/Director/);
    expect(() => state.service.submit(submission({ mode: 'director', snapshot: { ...base, director: { tool: 'emotion', options: { ...DEFAULT_AUGMENT_OPTIONS, emotionLevel: 6 } } } }))).toThrow(/Director/);
    expect(() => state.service.submit(submission({ mode: 'enhance', snapshot: { ...base, enhance: { magnitude: 11, scale: 1 } } }))).toThrow(/Enhance/);
    expect(quote).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(state.execute).not.toHaveBeenCalled();
  });

  it('reports fitting and alpha flattening without using unrelated generation dimensions', async () => {
    const oversized = new PNG({ width: 2048, height: 1024 }); oversized.data.fill(255);
    const state = setup(); const job = state.service.submit(submission({ mode: 'director', snapshot: { ...snapshot(), sourceImage: { mimeType: 'image/png', data: PNG.sync.write(oversized).toString('base64') }, director: { tool: 'colorize', options: { ...DEFAULT_AUGMENT_OPTIONS, colorizePrompt: 'blue teacup' } } } }));
    const read = state.service.read({ workspaceId: 'workspace', jobId: job.jobId });
    expect(read.input.processing).toEqual({ inputWidth: 1448, inputHeight: 724, outputWidth: 2048, outputHeight: 1024, resizedInput: true, alphaFlattened: true });
    expect(read.inputSummary).toMatchObject({ width: 2048, height: 1024 });
    await running(state); state.execution.resolve(success()); await finished(state, job.jobId);
  });
});

describe('manual batch items (step 4a)', () => {
  const queue = { batchId: 'batch-1', requestKey: 'manual-0123456789', itemIndex: 0 };
  const withReferences = () => ({ ...snapshot(), extras: { ...snapshot().extras, vibeImages: [{ base64: 'vibe', infoExtracted: 1, strength: .5 }], modelMode: 'furry' as const } });

  it('run with the manual options: references and Furry pass, the item streams its frames and hands its saved images over', async () => {
    const previews: unknown[] = [], settled: any[] = [];
    const state = setup({ onPreview: (_job, origin, preview) => previews.push({ origin, preview }), onManualSettled: outcome => settled.push(outcome) });
    expect(() => state.service.submit(submission({ requestKey: 'queued-ref', snapshot: withReferences(), queue }))).toThrow(/Precise\/Vibe/);
    const job = state.service.submit(submission({ requestKey: 'manual-ref', snapshot: withReferences(), queue, manual: true }));
    await running(state);
    const options = state.execute.mock.calls[0][2];
    expect(options).toMatchObject({ manual: true, singleRequest: true });
    // Step 4b3c: the click's mode goes with it, saved as the history record's feature (library mode filter).
    expect(options.generationMode).toBe('t2i');
    expect(state.execute.mock.calls[0][1].extras.vibeImages).toHaveLength(1);
    options.onPreview!({ progress: .5, currentStep: 1, totalSteps: 2, sampleIndex: 0, imageDataUrl: 'data:image/png;base64,AA==' });
    expect(previews).toEqual([{ origin: queue, preview: expect.objectContaining({ progress: .5 }) }]);
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ job: { status: 'succeeded', jobId: job.jobId }, queue, items: [expect.objectContaining({ id: 'history-1' })] });
  });

  it('a manual item takes its source captured at the click, also past the queue\'s 20 MiB; a queued recipe keeps that limit', async () => {
    const large = Buffer.concat([IMAGE, Buffer.alloc(25 * 1024 * 1024)]);
    const state = setup({ validateImage: () => ({ width: 64, height: 64 }) });
    expect(() => state.service.submit(submission({ requestKey: 'queued-large', mode: 'i2i', queue, snapshot: { ...snapshot(), i2i: { strength: .5, noise: 0, extraNoiseSeed: 3 }, sourceImage: { mimeType: 'image/png', data: large.toString('base64') } } }))).toThrow(/20 MiB/);
    const job = state.service.submit(submission({ requestKey: 'manual-large', mode: 'i2i', queue, manual: true, manualSource: { bytes: large, mimeType: 'image/png' }, snapshot: { ...snapshot(), i2i: { strength: .5, noise: 0, extraNoiseSeed: 3 } } }));
    await running(state);
    expect(state.execute.mock.calls[0][2].sourceBytes!.equals(large)).toBe(true);
    expect(state.service.heldInputs({ workspaceId: 'workspace', jobId: job.jobId }).source).toBe(large.length);
    state.execution.resolve(success()); await finished(state, job.jobId);
    expect(state.service.heldInputs({ workspaceId: 'workspace', jobId: job.jobId })).toEqual({ source: 0, mask: 0, references: 0 });
    expect(() => state.service.submit(submission({ requestKey: 'manual-not-bytes', mode: 'i2i', queue, manual: true, manualSource: { bytes: 'AAAA', mimeType: 'image/png' }, snapshot: { ...snapshot(), i2i: { strength: .5, noise: 0, extraNoiseSeed: 3 } } }))).toThrow(/at most 128 MiB/);
  });

  it('a manual failure keeps the request\'s own explanation; a manual item needs its queue batch', async () => {
    const state = setup();
    expect(() => state.service.submit(submission({ requestKey: 'manual-orphan', manual: true }))).toThrow(/must belong to a queued batch/);
    const job = state.service.submit(submission({ requestKey: 'manual-fail', queue, manual: true }));
    await running(state);
    state.execution.resolve({ ok: false, message: '图片生成失败（HTTP 400）：prompt too long', items: [], statusCode: 400, failureKind: 'validation' });
    await finished(state, job.jobId);
    expect(state.service.read({ workspaceId: 'workspace', jobId: job.jobId })).toMatchObject({ status: 'failed', error: { code: 'generation_failed', message: '图片生成失败（HTTP 400）：prompt too long', statusCode: 400 } });
  });
});
