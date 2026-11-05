/**
 * Step 4b1: Recently Deleted receipts and entries carry the sizes of the files that move (bytes.moved) and how many
 * of them have no known size (bytes.unknownSize), for the window's "moves N files (X MB)". Files left in place are
 * not counted. Real repository, real trash, real files in throwaway folders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openLibraryRepository, type LibraryRepository } from './library/repository';
import { createLibraryTrash, TRASH_RECEIPT_BYTES } from './library-trash';

/**
 * Cases that write hundreds of library entries (more than one 500-item request) run in about 1–3 s alone but can pass
 * 30 s when two full suites share the disk: they get an explicit longer limit; what they check is unchanged.
 */
const HEAVY_IO_TIMEOUT_MS = 120_000;

const roots: string[] = [], repositories: LibraryRepository[] = [];
afterEach(() => {
  for (const repo of repositories.splice(0)) { try { repo.close(); } catch { /* closed */ } }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture({ memory = false }: { memory?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-trash-bytes-')); roots.push(root);
  const library = path.join(root, 'library'), output = path.join(root, 'output');
  fs.mkdirSync(library, { recursive: true }); fs.mkdirSync(output, { recursive: true });
  const repo = openLibraryRepository({ filePath: memory ? ':memory:' : path.join(root, 'library.sqlite'), libraryDirectory: library, userDataRoot: root });
  repositories.push(repo);
  const trash = createLibraryTrash({ repository: repo, userDataRoot: root, libraryDirectory: library, managedRoots: () => [output], toFileUrl: file => `fixture:${file}`, log: () => undefined });
  const history = (id: string, bytes: number, file = path.join(output, '2026-11-03', `${id}.png`), write = true) => {
    if (write) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.alloc(bytes, 7)); }
    return repo.put('history', id, { id, filePath: file, fileUrl: `fixture:${file}`, date: '2026-11-03', createdAt: '2026-11-03T00:00:00.000Z', params: { positivePrompt: `teacup ${id}` }, actualSeed: 7, model: 'nai-diffusion-4-5-full', width: 8, height: 8 });
  };
  return { root, output, repo, trash, history };
}

describe('Recently Deleted file sizes', () => {
  it('a preview, the deletion and the listed entry name the bytes that move; left-in-place files are not counted', async () => {
    const f = fixture();
    f.history('a', 1200); f.history('b', 3400);
    const shared = path.join(f.output, '2026-11-03', 'shared.png');
    f.history('c', 500, shared); f.history('d', 0, shared, false); // d uses c's file: it stays in place when c goes
    const selection = ['a', 'b', 'c'].map(id => ({ kind: 'history' as const, id, expectedRevision: 1 }));
    const preview = await f.trash.deleteItems(selection, { preview: true });
    const rows = Object.fromEntries(preview.deleted.map((row: any) => [row.id, row]));
    expect(rows.a).toMatchObject({ files: { moved: 1, kept: 0, missing: 0 }, bytes: { moved: 1200, unknownSize: 0 } });
    expect(rows.b).toMatchObject({ bytes: { moved: 3400, unknownSize: 0 } });
    expect(rows.c).toMatchObject({ files: { moved: 0, kept: 1 }, bytes: { moved: 0, unknownSize: 0 } });
    expect(fs.existsSync(path.join(f.output, '2026-11-03', 'a.png'))).toBe(true);
    const receipt = await f.trash.deleteItems(selection);
    expect(Object.fromEntries(receipt.deleted.map((row: any) => [row.id, row.bytes]))).toEqual({ a: { moved: 1200, unknownSize: 0 }, b: { moved: 3400, unknownSize: 0 }, c: { moved: 0, unknownSize: 0 } });
    const listed = f.trash.list({ limit: 10 }).entries as any[];
    expect(Object.fromEntries(listed.map(entry => [entry.id, entry.bytes]))).toEqual({ a: { moved: 1200, unknownSize: 0 }, b: { moved: 3400, unknownSize: 0 }, c: { moved: 0, unknownSize: 0 } });
  });

  it('a missing file moves nothing and is not counted', async () => {
    const f = fixture();
    f.history('gone', 0, path.join(f.output, 'never-written.png'), false);
    const preview = await f.trash.deleteItems([{ kind: 'history', id: 'gone', expectedRevision: 1 }], { preview: true });
    expect(preview.deleted[0]).toMatchObject({ files: { moved: 0, missing: 1 }, bytes: { moved: 0, unknownSize: 0 } });
  });

  it('an entry deleted before the field has no bytes (the window then shows counts only)', async () => {
    const f = fixture();
    f.history('old', 900);
    const receipt = await f.trash.deleteItems([{ kind: 'history', id: 'old', expectedRevision: 1 }]);
    const trashId = (receipt.deleted[0] as any).trashId as string;
    const entry = f.repo.trashEntry(trashId)!;
    const { bytes: _bytes, ...older } = entry.summary as Record<string, unknown>;
    f.repo.updateTrashEntry(trashId, { summary: older });
    expect(f.trash.list({ limit: 5 }).entries[0]).not.toHaveProperty('bytes');
  });

  it('500 deletions keep the receipt budget with the size field, and the totals sum the bytes', { timeout: HEAVY_IO_TIMEOUT_MS }, async () => {
    const f = fixture({ memory: true });
    const selection = Array.from({ length: 500 }, (_, index) => f.history(`h${String(index).padStart(3, '0')}`, 10)).map(item => ({ kind: 'history' as const, id: item.id, expectedRevision: 1 }));
    const preview = await f.trash.deleteItems(selection, { preview: true });
    const receipt = await f.trash.deleteItems(selection);
    for (const value of [preview, receipt]) {
      expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(TRASH_RECEIPT_BYTES + 24 * 1024);
      expect((value as any).totals).toMatchObject({ entries: 500, files: { moved: 500 }, bytes: { moved: 5000, unknownSize: 0 } });
    }
  });
});
