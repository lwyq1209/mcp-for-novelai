import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { MaterialBackup } from '../workspace/material-library-types';
import { uiText } from '../ui/i18n';
import { importLibraryBackup, LIBRARY_BACKUP_MAX_BYTES, parseLibraryBackup, previewLibraryBackup, readExistingMaterials, withoutEntries } from './library-backup';
import { backupParseText } from './LibraryBackupImport';

// Entries and covers as the host exports them (they pass the host's import contract).
const entry = (id: string, kind: 'tag' | 'combo' | 'note', name: string, text?: string) => ({ schemaVersion: 1, id, kind, name, revision: 1, group: '', notes: '', archived: false, createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', ...(kind === 'tag' ? { tag: { text: text ?? name, source: 'english', target: 'base', category: null } } : {}), ...(kind === 'combo' ? { components: [] } : {}) }) as unknown as MaterialBackup['entries'][number];
const cover = (tagText: string) => ({ sha256: 'a'.repeat(64), mimeType: 'image/webp', width: 8, height: 8, byteLength: 10, tagText, tagCategory: null, savedAt: '2026-11-04T00:00:00.000Z', source: 'local', fileName: 'c.png', sourceSha256: 'b'.repeat(64), tagSource: 'english', postId: null, sourceUrl: null, verification: 'local', checkedAt: null, rating: null }) as never;
const backup = (): MaterialBackup => ({ schemaVersion: 1, entries: [entry('a', 'tag', 'Cat ears', 'cat_ears'), entry('b', 'tag', 'smile'), entry('c', 'combo', 'Night'), entry('d', 'note', 'Lighting')], covers: [{ entryId: 'a', cover: cover('cat_ears'), data: 'x' }, { entryId: 'b', cover: cover('smile'), data: 'y' }] });

describe('the material JSON backup the library and Settings share (step 4c1)', () => {
  it('checks the file as the host import takes it', () => {
    expect(parseLibraryBackup(JSON.stringify(backup()))).toMatchObject({ ok: true });
    expect(parseLibraryBackup('{not json')).toEqual({ ok: false, reason: 'bad_json' });
    expect(parseLibraryBackup(JSON.stringify({ schemaVersion: 2, entries: [] }))).toEqual({ ok: false, reason: 'bad_format' });
    expect(parseLibraryBackup(JSON.stringify({ schemaVersion: 1, entries: [{ ...entry('h', 'note', 'x'), kind: 'history' }] }))).toEqual({ ok: false, reason: 'bad_entry', n: 1, name: 'x' });
    expect(parseLibraryBackup(JSON.stringify({ schemaVersion: 1, entries: [], covers: {} }))).toEqual({ ok: false, reason: 'bad_format' });
    expect(parseLibraryBackup(JSON.stringify({ ...backup(), extra: 1 }))).toEqual({ ok: false, reason: 'bad_format' });
    expect(parseLibraryBackup(JSON.stringify({ schemaVersion: 1, entries: [], covers: backup().covers }))).toEqual({ ok: false, reason: 'too_many_covers' });
    expect(parseLibraryBackup(' '.repeat(LIBRARY_BACKUP_MAX_BYTES + 1))).toEqual({ ok: false, reason: 'too_big' });
  });

  it('a hand-made file is checked with the host\'s own contract and refused in words, before any preview (review rework)', () => {
    // The review's file C: entries without ids or the other saved fields.
    const handMade = { schemaVersion: 1, entries: [{ kind: 'tag', name: 'Cat ears', tag: { text: 'cat_ears', source: 'english', target: 'base', category: null } }, { kind: 'note', name: 'rv-noid-note-1', notes: 'hand made 1' }] };
    expect(parseLibraryBackup(JSON.stringify(handMade))).toEqual({ ok: false, reason: 'bad_entry', n: 1, name: 'Cat ears' });
    const second = backup(); (second.entries[1] as { tag: unknown }).tag = { text: 'smile', source: 'somewhere', target: 'base', category: null };
    expect(parseLibraryBackup(JSON.stringify(second))).toEqual({ ok: false, reason: 'bad_entry', n: 2, name: 'smile' });
    const badCover = backup(); (badCover.covers![1] as { cover: unknown }).cover = { sha256: 'x' };
    expect(parseLibraryBackup(JSON.stringify(badCover))).toEqual({ ok: false, reason: 'bad_cover', n: 2 });
    // The words, in both languages: the entry, never the validator's report.
    for (const lang of ['zh', 'en'] as const) {
      const t = ((key: string, params?: Record<string, string | number>) => uiText(lang, key as never, params)) as never;
      const named = backupParseText({ ok: false, reason: 'bad_entry', n: 1, name: 'Cat ears' }, t), cover = backupParseText({ ok: false, reason: 'bad_cover', n: 2 }, t);
      expect(named).toContain('Cat ears'); expect(named).toContain('1'); expect(cover).toContain('2');
      expect(named + cover).not.toMatch(/instancePath|must have|required property|\/entries/);
      expect(/[\u4e00-\u9fff]/.test(named)).toBe(lang === 'zh');
    }
  });

  it('leaves entries out by position: entries without (or sharing) an id are never left out with another (review rework)', () => {
    const data = backup(); data.entries[1] = { ...data.entries[1], id: 'a' }; data.entries[3] = { ...data.entries[3], id: 'a' };
    const rest = withoutEntries(data, [0]);
    expect(rest.entries.map(value => value.name)).toEqual(['smile', 'Night', 'Lighting']);
    // A cover whose id a kept entry still has stays (the host matches it against that entry); one without any goes.
    expect(rest.covers?.map(value => value.entryId)).toEqual(['a']);
  });

  it('counts by kind and covers, finds entries like existing ones (kind, name, tag text), and the limit', () => {
    const existing = [{ kind: 'tag', name: 'cat ears', text: 'CAT_EARS' }, { kind: 'tag', name: 'smile', text: 'grin' }, { kind: 'combo', name: 'night' }];
    const preview = previewLibraryBackup(backup(), existing);
    expect(preview).toEqual({ total: 4, byKind: { tag: 2, combo: 1, note: 1 }, covers: 2, duplicates: [0, 2], existing: 3, overLimit: false, overLimitWithout: false });
    expect(previewLibraryBackup(backup(), existing, 6)).toMatchObject({ overLimit: true, overLimitWithout: false });
    // Leaving the duplicates out also leaves their covers out (the host checks every cover against an entry).
    const rest = withoutEntries(backup(), preview.duplicates);
    expect(rest.entries.map(value => value.id)).toEqual(['b', 'd']);
    expect(rest.covers?.map(value => value.entryId)).toEqual(['b']);
    expect(withoutEntries(backup(), [0, 1]).covers).toBeUndefined();
  });

  it('reads the library’s materials page by page and imports through the host’s one import', async () => {
    const pages = [{ items: Array.from({ length: 500 }, (_, i) => ({ kind: 'tag', name: `t${i}`, payload: { tag: { text: `t${i}` } } })), hasMore: true }, { items: [{ kind: 'note', name: 'n' }], hasMore: false }];
    const api = { assetLibrary: vi.fn(async () => pages.shift()), materialLibrary: vi.fn(async () => ({ count: 2, coverWarnings: [{}] })) };
    expect(await readExistingMaterials(api)).toHaveLength(501);
    expect(api.assetLibrary).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'ui-list', kinds: ['tag', 'combo', 'note'], archived: 'include', offset: 500, limit: 500 }));
    expect(await importLibraryBackup(api, backup())).toEqual({ count: 2, covers: 1 });
    expect(api.materialLibrary).toHaveBeenCalledWith({ action: 'import', data: backup() });
  });

  it('Settings › Storage uses the same check, preview and import (no second import path)', () => {
    const source = readFileSync(new URL('../settings/sections/StorageSection.tsx', import.meta.url), 'utf8');
    for (const name of ['parseLibraryBackup', 'LibraryBackupImport', 'exportLibraryBackup']) expect(source).toContain(name);
    expect(source).not.toContain("action: 'import'");
    expect(source).not.toContain('JSON.parse');
  });
});
