import type { AssetItem, AssetKind } from '../asset-library/types';
import type { MaterialComponent } from '../workspace/material-library-types';
import { materialPrompt } from '../workspace/material-library-ui';
import type { UiStringKey } from '../ui/strings';

/**
 * Version history of a library item (step 4c1): the fields a version shows and compares, per kind, read from the saved
 * record of that version. The host keeps every saved revision (asset_library versions / read with revision) and
 * restores the authored content of one as a new revision (restore-content, electron/asset-library-restore.ts): only
 * the payload keys of RESTORED_PAYLOAD_KEYS. Organizing fields shown here (the group of tags, combos, notes, Style and
 * reference presets) are compared too but kept as they are by a restore, so each field says whether a restore changes
 * it (review rework). History images and artist picks are never restored; their project, custom tags and name are
 * shown for reading only. Pure functions only.
 */
export interface VersionField { key: string; label: UiStringKey; value: string; mono?: boolean; /** A restore puts this field back. */ restores: boolean }

/**
 * What restore-content puts back, per kind: payload keys ("study.name" is the study's name). The same lists as the
 * host's restoredContent (versions.test.ts checks them against it).
 */
export const RESTORED_PAYLOAD_KEYS: Partial<Record<AssetKind, readonly string[]>> = {
  tag: ['name', 'notes', 'tag', 'links'], combo: ['name', 'notes', 'components', 'links'], note: ['name', 'notes', 'links'],
  style_preset: ['name', 'prompt'], positive_preset: ['name', 'prompt'], prompt_chunk: ['name', 'content'],
  reference_preset: ['name', 'kind', 'infoExtracted', 'strength', 'preciseType', 'fidelity', 'informationExtracted'],
  study: ['notes', 'study.name'],
};
/** The payload key a shown field is read from. */
const rootOf = (kind: AssetKind, key: string) => key === 'name' && kind === 'study' ? 'study.name' : key.startsWith('tag.') ? 'tag' : key;
const restores = (kind: AssetKind, key: string) => RESTORED_PAYLOAD_KEYS[kind]?.includes(rootOf(kind, key)) ?? false;

const text = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value);
const prompt = (components: unknown) => { try { return materialPrompt((Array.isArray(components) ? components : []) as MaterialComponent[]); } catch { return text(components); } };
const list = (value: unknown) => Array.isArray(value) ? value.map(text).join(', ') : text(value);

/** What a version of an item says, field by field (empty fields left out, except the name). */
export function versionFields(item: Pick<AssetItem, 'kind' | 'name' | 'payload'>, projects: ReadonlyMap<string, string> = new Map()): VersionField[] {
  const payload = item.payload ?? {};
  const fields: Array<VersionField | null> = [{ key: 'name', label: 'edit.name', value: item.kind === 'study' ? text(payload.study?.name ?? item.name) : text(item.name), restores: restores(item.kind, 'name') }];
  const add = (key: string, label: UiStringKey, value: string, mono = false) => { fields.push(value ? { key, label, value, mono, restores: restores(item.kind, key) } : null); };
  switch (item.kind) {
    case 'tag':
      add('tag.text', 'edit.text', text(payload.tag?.text), true); add('tag.source', 'edit.source', text(payload.tag?.source)); add('tag.target', 'edit.target', text(payload.tag?.target));
      add('group', 'edit.group', text(payload.group)); add('notes', 'edit.notes', text(payload.notes)); break;
    case 'combo':
      add('components', 'edit.members', prompt(payload.components), true); add('group', 'edit.group', text(payload.group)); add('notes', 'edit.notes', text(payload.notes)); break;
    case 'note':
      add('group', 'edit.group', text(payload.group)); add('notes', 'side.notes', text(payload.notes)); break;
    case 'style_preset':
      add('prompt', 'edit.prompt', text(payload.prompt), true); add('group', 'edit.group', text(payload.group)); break;
    case 'positive_preset':
      add('prompt', 'edit.prompt', text(payload.prompt), true); break;
    case 'prompt_chunk':
      add('content', 'edit.content', text(payload.content), true); break;
    case 'reference_preset':
      add('strength', 'ver.f.strength', text(payload.strength)); add(payload.kind === 'vibe' ? 'infoExtracted' : 'fidelity', payload.kind === 'vibe' ? 'ver.f.info' : 'ver.f.fidelity', text(payload.kind === 'vibe' ? payload.infoExtracted : payload.fidelity));
      add('preciseType', 'ver.f.preciseType', payload.kind === 'vibe' ? '' : text(payload.preciseType)); add('group', 'edit.group', text(payload.group)); break;
    case 'study':
      add('notes', 'edit.notes', text(payload.notes)); break;
    case 'history':
      add('groupId', 'ver.f.project', payload.groupId ? projects.get(`history:${payload.groupId}`) ?? text(payload.groupId) : ''); add('customTags', 'ver.f.customTags', list(payload.customTags)); break;
    case 'artist_favorite':
      add('prompt', 'artist.prompt', text(payload.prompt), true); add('basePrompt', 'ver.f.basePrompt', text(payload.basePrompt), true); break;
  }
  return fields.filter((field): field is VersionField => !!field);
}

/** One field that differs between a version and the current one: this version's value and the current value. */
export interface VersionDifference { key: string; label: UiStringKey; value: string; current: string; mono?: boolean; restores: boolean }
/** The fields of `version` that differ from `current` (a field one of them lacks counts as empty). */
export function versionDifferences(version: Pick<AssetItem, 'kind' | 'name' | 'payload'>, current: Pick<AssetItem, 'kind' | 'name' | 'payload'>, projects?: ReadonlyMap<string, string>): VersionDifference[] {
  const mine = versionFields(version, projects), theirs = new Map(versionFields(current, projects).map(field => [field.key, field]));
  const keys = [...new Set([...mine.map(field => field.key), ...theirs.keys()])];
  const byKey = new Map(mine.map(field => [field.key, field]));
  return keys.flatMap(key => {
    const a = byKey.get(key), b = theirs.get(key), field = a ?? b!;
    return (a?.value ?? '') === (b?.value ?? '') ? [] : [{ key, label: field.label, value: a?.value ?? '', current: b?.value ?? '', mono: field.mono, restores: field.restores }];
  });
}

const stable = (value: unknown): string => value === undefined ? '' : JSON.stringify(value, (_key, inner) => inner && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]])) : inner);
const payloadValue = (payload: Record<string, any> | undefined, key: string) => key === 'study.name' ? payload?.study?.name : payload?.[key];

/**
 * What a restore of `version` would change in `current`: whether anything at all (the restorable payload keys compared
 * whole, also those not shown, like a tag's links or category), and whether some of it is not among the shown
 * differences.
 */
export function restoreChanges(version: Pick<AssetItem, 'kind' | 'name' | 'payload'>, current: Pick<AssetItem, 'kind' | 'name' | 'payload'>, shown: readonly VersionDifference[] = versionDifferences(version, current)): { changes: boolean; unlisted: boolean } {
  const keys = RESTORED_PAYLOAD_KEYS[current.kind] ?? [];
  const differing = keys.filter(key => stable(payloadValue(version.payload, key)) !== stable(payloadValue(current.payload, key)));
  const explained = new Set(shown.filter(difference => difference.restores).map(difference => rootOf(current.kind, difference.key)));
  return { changes: differing.length > 0, unlisted: differing.some(key => !explained.has(key)) };
}

/** Kinds whose old content the host restores as a new version (asset-library-restore.ts canRestoreContent). */
export const restorableKind = (kind: AssetKind) => kind !== 'history' && kind !== 'artist_favorite';
/** What 用这一版 does for a kind: the same as the current version's main action in the drawer. */
export function versionUse(kind: AssetKind): 'canvas' | 'tray' | null {
  if (kind === 'tag' || kind === 'combo') return 'tray';
  if (kind === 'style_preset' || kind === 'positive_preset' || kind === 'prompt_chunk' || kind === 'reference_preset' || kind === 'artist_favorite') return 'canvas';
  return null;
}
