import { buildPayload } from './nai-payload';
import type { GenerationSnapshot } from '../src/workspace/generation-types';
import type { PromptReviewInput } from '../src/workspace/prompt-review';

/** Actual client t2i review construction. No provider, assets, settings or seed draw.
 * Slot-authorized execution seeds belong to enqueue, never this frozen review input. */
export function buildT2iReviewEffective(snapshot: Pick<GenerationSnapshot, 'params' | 'extras'>): NonNullable<PromptReviewInput['effective']> {
  const { params, extras } = snapshot;
  const random = params.seedMode === 'random' || params.seed < 0;
  const request = buildPayload(params, random ? 1 : params.seed, extras);
  if (random) request.parameters.seed = null;
  return { request, sourceRole: null, maskRole: null, sampling: { sampleCount: 1, seedPolicy: random ? 'random_on_submit' : 'fixed' } };
}
