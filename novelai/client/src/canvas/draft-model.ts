import { useSyncExternalStore } from 'react';
import { getWorkspaceRuntime, subscribeWorkspaceRuntime } from '../workspace/runtime';
import type { WorkspaceController, WorkspaceDraft, WorkspaceView } from '../workspace/controller';
import type { UiStringKey } from '../ui/strings';

/**
 * The canvas's view of drafts (step 4b3, DESIGN §6): the live workspace controller's view (revision, draft, undo), the
 * left-column group each changed field belongs to, and a tag-level diff for the review sheet. Pure functions and
 * hooks only; applying, discarding and undoing go through the controller as before (apply_edit / undo_edit).
 */

const noSubscribe = () => () => {};
const noView = () => null;

export function useWorkspaceController(): WorkspaceController | null {
  return useSyncExternalStore(subscribeWorkspaceRuntime, getWorkspaceRuntime, getWorkspaceRuntime) as WorkspaceController | null;
}
export function useWorkspaceView(controller: WorkspaceController | null = useWorkspaceController()): WorkspaceView | null {
  return useSyncExternalStore(controller ? controller.subscribe : noSubscribe, controller ? controller.getView : noView, controller ? controller.getView : noView);
}

/** An agent's draft (a source the window staged itself is applied at once and never shown as a draft). */
export const agentDraftOf = (view: WorkspaceView | null): WorkspaceDraft | null => view?.draft && view.draft.origin !== 'client' ? view.draft : null;
export const isStale = (view: WorkspaceView | null, draft: WorkspaceDraft | null) => !!view && !!draft && draft.baseRevision !== view.revision;

/** The left-column groups a draft field marks. */
export type DraftGroup = 'model' | 'prompt' | 'style' | 'chars' | 'refs' | 'size' | 'seed' | 'params' | 'output' | 'i2i' | 'source'
  | 'inpaint' | 'inpaintPrompt' | 'inpaintStyle' | 'inpaintParams' | 'mask' | 'enhance' | 'upscale' | 'director';

const PARAM_GROUP: Record<string, DraftGroup> = {
  model: 'model', positivePrompt: 'prompt', negativePrompt: 'prompt', stylePrompt: 'style', width: 'size', height: 'size',
  seed: 'seed', seedMode: 'seed', fileNamePrefix: 'output', effort: 'model',
};

/** The group of one change field (as summarizeChanges names it: params.x, i2iParams.x, inpaintRecipe.x, a top-level key). */
export function draftGroup(field: string): DraftGroup {
  const [head, sub] = field.split('.');
  if (head === 'params') return PARAM_GROUP[sub] ?? 'params';
  if (head === 'inpaintRecipe') return !sub ? 'inpaint' : sub === 'positivePrompt' || sub === 'negativePrompt' ? 'inpaintPrompt' : sub === 'stylePrompt' ? 'inpaintStyle' : 'inpaintParams';
  if (head === 'charCaptions') return 'chars';
  if (head === 'vibeImages' || head === 'preciseReferences') return 'refs';
  if (head === 'i2iParams') return 'i2i';
  if (head === 'inpaintMask') return 'mask';
  if (head === 'inpaintPositivePrompt') return 'inpaintPrompt';
  if (head === 'inpaintModel' || head === 'inpaintStrength' || head === 'inpaintNoise') return 'inpaint';
  if (head === 'enhanceMagnitude' || head === 'enhanceScale') return 'enhance';
  if (head === 'upscaleScale') return 'upscale';
  if (head === 'directorTool' || head === 'augmentOptions') return 'director';
  if (head === 'workbenchImage' || head === 'i2iOriginalImage') return 'source';
  if (head === 'batchCount' || head === 'batchIntervalSeconds' || head === 'generationGroupId') return 'output';
  return 'params';
}

/** The groups the current agent draft marks (empty without one). */
export function useDraftGroups(): Set<DraftGroup> {
  const draft = agentDraftOf(useWorkspaceView());
  return new Set((draft?.changes ?? []).map(change => draftGroup(change.field)));
}
/** The value an agent draft gives one field, or undefined. */
export function useDraftValue(field: string): unknown {
  const draft = agentDraftOf(useWorkspaceView());
  return draft?.changes.find(change => change.field === field)?.after;
}

/** The label of a change field in the interface copy. */
export function fieldLabelKey(field: string): { key: UiStringKey; inpaint: boolean; name?: string } {
  const [head, sub] = field.split('.');
  const known = (name: string) => (`cv.f.${name}`) as UiStringKey;
  const map: Record<string, string> = { width: 'size', height: 'size', seedMode: 'seed', smeaDyn: 'smea', qualityToggle: 'qualityPreset' };
  if ((head === 'params' || head === 'inpaintRecipe' || head === 'i2iParams') && sub) {
    const name = map[sub] ?? sub;
    return { key: KNOWN_FIELDS.has(name) ? known(name) : 'cv.f.other', inpaint: head === 'inpaintRecipe', ...(KNOWN_FIELDS.has(name) ? {} : { name: sub }) };
  }
  return { key: KNOWN_FIELDS.has(head) ? known(head) : 'cv.f.other', inpaint: false, ...(KNOWN_FIELDS.has(head) ? {} : { name: head }) };
}
const KNOWN_FIELDS = new Set([
  'positivePrompt', 'negativePrompt', 'stylePrompt', 'size', 'seed', 'model', 'effort', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule',
  'ucPreset', 'qualityPreset', 'transparentBackground', 'variety', 'smea', 'fileNamePrefix', 'params', 'charCaptions', 'vibeImages',
  'preciseReferences', 'i2iParams', 'strength', 'noise', 'extraNoiseSeed', 'inpaintMask', 'inpaintModel', 'inpaintStrength', 'inpaintNoise',
  'inpaintPositivePrompt', 'inpaintRecipe', 'enhanceMagnitude', 'enhanceScale', 'upscaleScale', 'directorTool', 'augmentOptions', 'workbenchImage',
]);

/** One row of the review: width and height merge into one size row, seed and its mode into one seed row. */
export interface ReviewRow { id: string; label: { key: UiStringKey; inpaint: boolean; name?: string }; before: unknown; after: unknown; kind: 'text' | 'size' | 'seed' | 'value' }
export function reviewRows(draft: WorkspaceDraft, current: { width?: number; height?: number; seed?: number; seedMode?: string } = {}): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const changes = draft.changes;
  const find = (field: string) => changes.find(change => change.field === field);
  const used = new Set<string>();
  for (const change of changes) {
    if (used.has(change.field)) continue;
    const [head, sub] = change.field.split('.');
    if ((head === 'params' || head === 'inpaintRecipe') && (sub === 'width' || sub === 'height')) {
      const w = find(`${head}.width`), h = find(`${head}.height`);
      if (w) used.add(w.field); if (h) used.add(h.field);
      const base = head === 'params' ? current : {};
      rows.push({ id: `${head}.size`, label: { key: 'cv.f.size', inpaint: head === 'inpaintRecipe' }, kind: 'size',
        before: { width: w ? w.before : base.width, height: h ? h.before : base.height }, after: { width: w ? w.after : base.width, height: h ? h.after : base.height } });
      continue;
    }
    if ((head === 'params' || head === 'inpaintRecipe') && (sub === 'seed' || sub === 'seedMode')) {
      const seed = find(`${head}.seed`), mode = find(`${head}.seedMode`);
      if (seed) used.add(seed.field); if (mode) used.add(mode.field);
      const base = head === 'params' ? current : {};
      rows.push({ id: `${head}.seed`, label: { key: 'cv.f.seed', inpaint: head === 'inpaintRecipe' }, kind: 'seed',
        before: { seed: seed ? seed.before : base.seed, seedMode: mode ? mode.before : base.seedMode }, after: { seed: seed ? seed.after : base.seed, seedMode: mode ? mode.after : base.seedMode } });
      continue;
    }
    used.add(change.field);
    const text = typeof change.before === 'string' || typeof change.after === 'string';
    rows.push({ id: change.field, label: fieldLabelKey(change.field), before: change.before, after: change.after, kind: text && /Prompt$/.test(sub ?? head) ? 'text' : 'value' });
  }
  return rows;
}

/** Comma-separated prompt parts (the unit the old weight editor and the review compare). */
export const promptParts = (text: string) => text.split(',').map(part => part.trim()).filter(Boolean);

export interface DiffPart { text: string; op: 'same' | 'del' | 'ins' }
/** The parts of a prompt before and after, with the removed and added ones marked (longest common subsequence). */
export function promptDiff(before: string, after: string): { before: DiffPart[]; after: DiffPart[] } {
  const a = promptParts(before), b = promptParts(after);
  const n = a.length, m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const left: DiffPart[] = [], right: DiffPart[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { left.push({ text: a[i], op: 'same' }); right.push({ text: b[j], op: 'same' }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { left.push({ text: a[i], op: 'del' }); i++; }
    else { right.push({ text: b[j], op: 'ins' }); j++; }
  }
  while (i < n) left.push({ text: a[i++], op: 'del' });
  while (j < m) right.push({ text: b[j++], op: 'ins' });
  return { before: left, after: right };
}

/** Long unchanged runs shrink to "…" so the review shows where a prompt changed (prototype 14). */
export function elide(parts: DiffPart[], keep = 1): Array<DiffPart | { text: '…'; op: 'gap' }> {
  const out: Array<DiffPart | { text: '…'; op: 'gap' }> = [];
  const near = (index: number) => parts.slice(Math.max(0, index - keep), index + keep + 1).some(part => part.op !== 'same');
  let gap = false;
  parts.forEach((part, index) => {
    if (part.op !== 'same' || near(index) || parts.length <= 6) { out.push(part); gap = false; }
    else if (!gap) { out.push({ text: '…', op: 'gap' }); gap = true; }
  });
  return out;
}
