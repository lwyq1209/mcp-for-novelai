import { describe, expect, it } from 'vitest';
import type { AssetItem } from '../asset-library/types';
import { uiText } from '../ui/i18n';
import { restoredContent } from '../../electron/asset-library-restore';
import type { LibraryItem } from '../../electron/library/types';
import { RESTORED_PAYLOAD_KEYS, restorableKind, restoreChanges, versionDifferences, versionFields, versionUse } from './versions';

const item = (kind: AssetItem['kind'], name: string, payload: Record<string, unknown>, revision = 1) => ({ kind, id: 'x', revision, name, payload } as unknown as AssetItem);

describe('version history fields (step 4c1)', () => {
  it('shows the authored fields of each kind and what differs from the current version', () => {
    const old = item('tag', 'cat ears', { tag: { text: 'cat_ears', source: 'danbooru', target: 'base' }, notes: 'first', group: '' }, 1);
    const now = item('tag', 'Cat ears', { tag: { text: 'cat_ears', source: 'danbooru', target: 'character' }, notes: '', group: 'animals' }, 3);
    expect(versionFields(old).map(field => field.key)).toEqual(['name', 'tag.text', 'tag.source', 'tag.target', 'notes']);
    expect(versionDifferences(old, now).map(({ key, label, value, current, restores }) => ({ key, label, value, current, restores }))).toEqual([
      { key: 'name', label: 'edit.name', value: 'cat ears', current: 'Cat ears', restores: true },
      { key: 'tag.target', label: 'edit.target', value: 'base', current: 'character', restores: true },
      { key: 'notes', label: 'edit.notes', value: 'first', current: '', restores: true },
      // A restore keeps the group (review rework): it is told apart.
      { key: 'group', label: 'edit.group', value: '', current: 'animals', restores: false },
    ]);
    expect(versionDifferences(now, now)).toEqual([]);
  });

  it('combos show their members as one prompt; presets their prompt; history its project and custom tags', () => {
    const combo = item('combo', 'c', { components: [{ text: 'smile', source: 'english', target: 'base', weight: 1.2, category: null }, { text: 'night', source: 'english', target: 'base', weight: 1, category: null }] });
    expect(versionFields(combo).find(field => field.key === 'components')).toMatchObject({ value: '1.2::smile ::, night', mono: true });
    expect(versionFields(item('style_preset', 's', { prompt: 'watercolor', group: 'g' })).map(field => field.key)).toEqual(['name', 'prompt', 'group']);
    const history = item('history', 'img', { groupId: 'cafe', customTags: ['best', 'keep'] });
    expect(versionFields(history, new Map([['history:cafe', 'Cafe']])).slice(1)).toEqual([
      { key: 'groupId', label: 'ver.f.project', value: 'Cafe', mono: false, restores: false },
      { key: 'customTags', label: 'ver.f.customTags', value: 'best, keep', mono: false, restores: false },
    ]);
    // Every label is a string of both languages.
    for (const field of [...versionFields(combo), ...versionFields(history)]) { expect(uiText('zh', field.label)).not.toBe(field.label); expect(uiText('en', field.label)).not.toMatch(/[\u4e00-\u9fff]/); }
  });

  it('restores what the host restores; 用这一版 is the drawer’s main action', () => {
    expect(['tag', 'combo', 'note', 'style_preset', 'positive_preset', 'prompt_chunk', 'reference_preset', 'study'].every(kind => restorableKind(kind as AssetItem['kind']))).toBe(true);
    expect(restorableKind('history')).toBe(false);
    expect(restorableKind('artist_favorite')).toBe(false);
    expect([versionUse('tag'), versionUse('combo'), versionUse('style_preset'), versionUse('artist_favorite'), versionUse('note'), versionUse('history'), versionUse('study')]).toEqual(['tray', 'tray', 'canvas', 'canvas', null, null, null]);
  });

  it('says which differences a restore puts back, the same keys the host restores (review rework)', () => {
    // The host's restoredContent, given a version whose every payload key differs, changes exactly RESTORED_PAYLOAD_KEYS.
    const payloads: Record<string, Record<string, unknown>> = {
      tag: { name: 'a', notes: 'a', group: 'a', tag: { text: 'a', source: 'english', target: 'base' }, links: [{ studyId: 'a' }] },
      combo: { name: 'a', notes: 'a', group: 'a', components: [], links: [] }, note: { name: 'a', notes: 'a', group: 'a', links: [] },
      style_preset: { name: 'a', prompt: 'a', group: 'a' }, positive_preset: { name: 'a', prompt: 'a' }, prompt_chunk: { name: 'a', content: 'a' },
      reference_preset: { name: 'a', kind: 'precise', infoExtracted: 1, strength: 1, preciseType: 'a', fidelity: 1, informationExtracted: 1, group: 'a' },
    };
    const changed = (value: unknown): unknown => typeof value === 'string' ? `${value}-old` : typeof value === 'number' ? value + 1 : Array.isArray(value) ? [...value, 'old'] : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, changed(inner)])) : value;
    for (const [kind, payload] of Object.entries(payloads)) {
      const current = { kind, id: 'x', revision: 2, payload } as unknown as LibraryItem, previous = { ...current, revision: 1, payload: changed(payload) } as LibraryItem;
      const restored = restoredContent(current, previous);
      const put = Object.keys(payload).filter(key => JSON.stringify(restored[key]) === JSON.stringify((previous.payload as Record<string, unknown>)[key]));
      expect(put.sort(), kind).toEqual([...RESTORED_PAYLOAD_KEYS[kind as AssetItem['kind']]!].sort());
    }
    expect(RESTORED_PAYLOAD_KEYS.study).toEqual(['notes', 'study.name']);
  });

  it('a version differing only in its group has nothing to restore; hidden restorable content still counts', () => {
    const now = item('tag', 'rv', { name: 'rv', tag: { text: 'rv_text', source: 'english', target: 'base' }, notes: '', group: 'GroupB' }, 2);
    const groupOnly = item('tag', 'rv', { name: 'rv', tag: { text: 'rv_text', source: 'english', target: 'base' }, notes: '', group: 'GroupA' }, 1);
    const differences = versionDifferences(groupOnly, now);
    expect(differences.map(difference => [difference.key, difference.restores])).toEqual([['group', false]]);
    expect(restoreChanges(groupOnly, now, differences)).toEqual({ changes: false, unlisted: false });
    // The same tag object in another key order is the same content.
    expect(restoreChanges(item('tag', 'rv', { name: 'rv', tag: { target: 'base', text: 'rv_text', source: 'english' }, notes: '' }), now).changes).toBe(false);
    // Links (not shown) differ: a restore changes them, and that is said.
    const linked = item('tag', 'rv', { ...groupOnly.payload, links: [{ studyId: 's', excerpt: 'e' }] }, 1);
    expect(restoreChanges(linked, now)).toEqual({ changes: true, unlisted: true });
    // A shown restorable difference explains its key.
    const renamed = item('tag', 'old', { ...now.payload, name: 'old' }, 1);
    expect(restoreChanges(renamed, now)).toEqual({ changes: true, unlisted: false });
  });
});
