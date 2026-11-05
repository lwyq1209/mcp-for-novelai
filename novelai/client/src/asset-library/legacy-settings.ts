import type { AssetDetail, AssetKind, AssetLibraryApi } from './types';
import { invalidateAssetQueries } from './query';
import { hostErrorText } from '../host-errors';
import { useAppStore } from '../store';

type PresetSetting = 'stylePromptPresets' | 'positivePromptPresets' | 'promptChunks';
const kinds: Record<PresetSetting, AssetKind> = { stylePromptPresets: 'style_preset', positivePromptPresets: 'positive_preset', promptChunks: 'prompt_chunk' };

/** URLs and the host revision are read models; compare the actual saved content. */
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => !['fileUrl', 'assetRevision'].includes(key) && value[key] !== undefined).map(key => [key, canonical(value[key])]));
}
export function sameSavedPreset(left: unknown, right: unknown) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

/** Translate an existing editor's before/after snapshot into versioned item commands.
 * Only changed IDs are written; unrelated items are never replaced by the array. */
export async function saveAssetSetting<T extends { id: string }>(api: AssetLibraryApi, key: PresetSetting, before: readonly T[], next: readonly T[]) {
  const kind = kinds[key], previous = new Map(before.map(item => [item.id, item]));
  const changed = next.filter(item => !previous.has(item.id) || !sameSavedPreset(item, previous.get(item.id)));
  const removed = before.filter(item => !next.some(value => value.id === item.id));
  const updates: Array<{ payload: T; expectedRevision?: number }> = [];
  const deletions: Array<{ kind: AssetKind; id: string; expectedRevision: number }> = [];
  // Check every existing affected item before the first mutation. Revisions are
  // checked again by the host at commit time; conflicts never overwrite drafts.
  for (const payload of [...changed, ...removed]) {
    const old = previous.get(payload.id);
    if (!old) { updates.push({ payload }); continue; }
    const { item } = await api.assetLibrary({ action: 'read', kind, id: payload.id }) as AssetDetail;
    if (!sameSavedPreset(item.payload, old) || item.archived) throw Object.assign(new Error(`“${(old as any).name ?? old.id}” changed elsewhere; refresh before saving. Your edits are kept.`), { code: 'library_conflict', reason: 'library.preset_changed_elsewhere', params: { name: String((old as any).name ?? old.id) } });
    if (removed.includes(payload)) deletions.push({ kind, id: payload.id, expectedRevision: item.revision });
    else updates.push({ payload, expectedRevision: item.revision });
  }
  let completed = 0;
  try {
    for (const { payload, expectedRevision } of updates) {
      await api.assetLibrary({ action: 'save', kind, id: payload.id, payload, ...(expectedRevision === undefined ? {} : { expectedRevision }) }); completed++;
    }
    if (deletions.length) { await api.assetLibrary({ action: 'mutate', command: 'archive', items: deletions, patch: { archived: true } }); completed += deletions.length; }
  } catch (error) {
    // The host error reads in the interface language (src/host-errors).
    const language = useAppStore.getState().settings?.language;
    const reason = error instanceof Error ? hostErrorText(error, language, hostErrorText({ code: 'x', reason: 'library.save_unfinished' }, language)) : hostErrorText({ code: 'x', reason: 'library.save_unfinished' }, language);
    // Rendered now, in the interface language (step 4c1); the English message carries the same facts.
    throw Object.assign(new Error(completed ? `${reason} ${hostErrorText({ code: 'x', reason: 'library.save_partial', params: { n: completed } }, language)}` : reason), { rendered: true });
  } finally { await invalidateAssetQueries(); }
}
