// One storage schema for every library write; the complete generation parameters are checked only for a new
// generation record (ipc/nai.ts before the request, ipc/store.ts addHistory when it is saved).
import { describe, expect, it } from 'vitest';
import { validateGeneratedHistoryPayload, validateLibraryPayload } from './validation';
import { DEFAULT_PARAMS } from '../../src/types';

const stamp = '2026-11-03T00:00:00.000Z';
const generated = { id: 'h', filePath: '/fixture/h.png', fileUrl: 'nai-local://h', date: '2026-11-03', createdAt: stamp, params: { ...DEFAULT_PARAMS }, actualSeed: 7, model: DEFAULT_PARAMS.model, width: 832, height: 1216 };

describe('library payload validation', () => {
  it('keeps a stored history record with sparse parameters as it is, without filling in defaults', () => {
    const sparse = { id: 'old', filePath: '/fixture/old.png', date: '2026-01-01', createdAt: stamp, params: { positivePrompt: '  cup\n', seed: 7, olderExtension: { kept: true } }, actualSeed: 7, model: 'nai-diffusion-4-5-full', width: 8, height: 8 };
    const before = structuredClone(sparse);
    validateLibraryPayload('history', sparse);
    validateLibraryPayload('artist_favorite', { collection: 'random', id: 'f', artists: [], auxiliary: [], mutations: [], franchiseStyles: [], basePrompt: '', prompt: '', pairId: 'f', variant: 'plain', sequence: 1, status: 'done', image: sparse });
    expect(sparse).toEqual(before);
    // A present value must still match its field schema; nothing is coerced.
    expect(() => validateLibraryPayload('history', { ...sparse, params: { seed: '7' } })).toThrow(/Invalid library fields/);
    const input = { id: 'c', name: 'c', content: 'x', createdAt: 123, updatedAt: stamp };
    expect(() => validateLibraryPayload('prompt_chunk', input)).toThrow(/Invalid library fields/);
    expect(input.createdAt).toBe(123);
  });

  it('requires the complete generation parameters of a new generation record only', () => {
    expect(() => validateGeneratedHistoryPayload(generated)).not.toThrow();
    const { qualityPreset: _dropped, ...partial } = generated.params;
    expect(() => validateGeneratedHistoryPayload({ ...generated, params: partial })).toThrow(/Invalid generation history fields/);
    expect(() => validateGeneratedHistoryPayload({ ...generated, fileUrl: undefined })).toThrow(/Invalid generation history fields/);
    // The same record is an ordinary stored record.
    expect(() => validateLibraryPayload('history', { ...generated, params: partial })).not.toThrow();
  });
});
