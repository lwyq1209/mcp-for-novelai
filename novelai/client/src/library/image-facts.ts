import { agentClientLabel } from '../agent-clients';
import type { BatchJob } from '../workspace/batch-types';
import { batchSourceOf } from '../workspace/batch-types';

/**
 * What the library knows about where an image came from, how it was made and when (step 4b1, moved here for the host
 * list filters of oss/lib-1103). Pure and free of UI code: the window (model.ts: tiles, the drawer) and the host
 * (electron/library-window.ts: the mode / model / date / source filters and the day counts) read an image through these
 * same functions, so a filter in the host matches exactly what a tile shows.
 */
export type GenerationMode = 't2i' | 'i2i' | 'inpaint' | 'enhance' | 'upscale' | 'director';
export const GENERATION_MODES: readonly GenerationMode[] = ['t2i', 'i2i', 'inpaint', 'enhance', 'upscale', 'director'];
export type ImageSource = { kind: 'agent'; label: string; batchId?: string } | { kind: 'manual' } | { kind: 'imported' };

/** What one queue batch tells about its images: the agent's display name (empty for manual), its mode, agent or not. */
export interface BatchFact { label: string; mode: GenerationMode; agent: boolean }
export type BatchFacts = ReadonlyMap<string, BatchFact>;

/** The facts of one batch the queue lists (manual batches only for this run of the app). */
export function batchFactOf(batch: Pick<BatchJob, 'mode' | 'source'>): BatchFact {
  const source = batchSourceOf(batch);
  return { label: source.kind === 'agent' ? agentClientLabel(source.client) : '', mode: batch.mode, agent: source.kind === 'agent' };
}
/** Batch id → its facts. */
export function batchFactsOf(batches: ReadonlyArray<Pick<BatchJob, 'batchId' | 'mode' | 'source'>>): Map<string, BatchFact> {
  return new Map(batches.map(batch => [batch.batchId, batchFactOf(batch)]));
}

/**
 * The fields of a library item these functions read. The window takes them from the item's payload (imageFacts); the
 * host reads the same fields with SQL (electron/library-window.ts) and builds the same object.
 */
export interface ImageFacts {
  kind: string;
  /** `Boolean(payload.generationOrigin)`: agent images carry it (step 4a), manual images do not. */
  hasOrigin: boolean;
  /** `payload.generationOrigin?.mode`. */
  originMode: unknown;
  /** `payload.queueOrigin?.batchId` when it is a string. */
  batchId: string | undefined;
  /** `payload.model` (used to recognise the post tools). */
  model: unknown;
  /** `payload.model ?? payload.params?.model` (the model filter). */
  shownModel: unknown;
  /** `payload.params?.positivePrompt === 'upscale'`. */
  upscalePrompt: boolean;
  /**
   * item.createdAt: the library's created_at, the column every list is sorted by (review rework: the day groups, the
   * day counts and the date filters all read this one field, so a day is one group in the list order).
   */
  createdAt: string;
}

export function imageFacts(item: { kind: string; createdAt: string; payload?: Record<string, any> | null }): ImageFacts {
  const payload = item.payload ?? {};
  return {
    kind: item.kind,
    hasOrigin: Boolean(payload.generationOrigin),
    // A manual image (no generationOrigin) names its click's mode in feature (step 4b3c); the source stays manual.
    originMode: payload.generationOrigin?.mode ?? payload.feature,
    batchId: typeof payload.queueOrigin?.batchId === 'string' ? payload.queueOrigin.batchId : undefined,
    model: payload.model,
    shownModel: payload.model ?? payload.params?.model,
    upscalePrompt: payload.params?.positivePrompt === 'upscale',
    createdAt: item.createdAt,
  };
}

/**
 * Where an image came from. Agent images carry a generationOrigin (and the queue item they ran for); manual images
 * from the canvas do not (step 4a). The agent's name comes from its batch when the queue still lists it.
 */
export function sourceOfFacts(facts: ImageFacts, batches: BatchFacts = new Map()): ImageSource {
  if (facts.kind === 'study') return { kind: 'imported' };
  const batch = facts.batchId ? batches.get(facts.batchId) : undefined;
  if (facts.hasOrigin || batch?.agent) return { kind: 'agent', label: batch?.agent && batch.label ? batch.label : 'Agent', ...(facts.batchId ? { batchId: facts.batchId } : {}) };
  return { kind: 'manual' };
}

/** The generation mode of a history image: exact for agent images (and manual batches still listed), inferred for
 * the post tools from the saved model, null when the record does not tell. */
export function modeOfFacts(facts: ImageFacts, batches: BatchFacts = new Map()): GenerationMode | null {
  if (facts.kind !== 'history') return null;
  const origin = facts.originMode;
  if (typeof origin === 'string' && (GENERATION_MODES as readonly string[]).includes(origin)) return origin as GenerationMode;
  const batch = facts.batchId ? batches.get(facts.batchId) : undefined;
  if (batch) return batch.mode;
  const model = String(facts.model ?? '');
  if (model.startsWith('director-')) return 'director';
  if (model.endsWith('-inpainting')) return 'inpaint';
  if (facts.upscalePrompt && model && !model.startsWith('nai-diffusion')) return 'upscale';
  return null;
}

export function modelOfFacts(facts: ImageFacts): string | null {
  if (facts.kind !== 'history') return null;
  return typeof facts.shownModel === 'string' && facts.shownModel ? facts.shownModel : null;
}

/** The local calendar day of a time ("2026-11-03"), or "unknown". */
export function localDayKey(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * The source filter: '' any; 'agent' any agent; 'agent:<name>' one agent by its display name; 'manual'; 'imported'
 * (imported images, in collections).
 */
export function sourceMatches(source: ImageSource, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'manual') return source.kind === 'manual';
  if (filter === 'imported') return source.kind === 'imported';
  if (filter === 'agent') return source.kind === 'agent';
  if (filter.startsWith('agent:')) return source.kind === 'agent' && source.label === filter.slice('agent:'.length);
  return false;
}

/** The host list's image filters (ui-list): each one alone narrows the list, together they intersect. */
export interface ImageFilterArgs { mode?: GenerationMode; model?: string; source?: string; createdFrom?: number; createdBefore?: number }
export function imageFilterActive(filters: ImageFilterArgs) {
  return !!(filters.mode || filters.model || filters.source || filters.createdFrom !== undefined || filters.createdBefore !== undefined);
}
export function factsMatch(facts: ImageFacts, filters: ImageFilterArgs, batches: BatchFacts = new Map()): boolean {
  if (filters.mode && modeOfFacts(facts, batches) !== filters.mode) return false;
  if (filters.model && modelOfFacts(facts) !== filters.model) return false;
  if (filters.createdFrom !== undefined || filters.createdBefore !== undefined) {
    const time = new Date(facts.createdAt).getTime();
    if (!Number.isFinite(time)) return false;
    if (filters.createdFrom !== undefined && !(time >= filters.createdFrom)) return false;
    if (filters.createdBefore !== undefined && !(time < filters.createdBefore)) return false;
  }
  if (filters.source && !sourceMatches(sourceOfFacts(facts, batches), filters.source)) return false;
  return true;
}
