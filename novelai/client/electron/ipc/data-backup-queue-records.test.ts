// Queue retention (review rework P1): every backup carries the cleaned queue records (the record file and both anchors),
// and an import adds them to the ones here: damaged records are restored when the backup completes them, and a library
// restore never touches them.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => key === 'exe' ? path.join(fixture.root, 'app', 'MCP for NovelAI') : path.join(fixture.root, key),
    getVersion: () => 'fixture',
    isPackaged: false,
  },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unavailable'); }, decryptString: () => { throw new Error('unavailable'); } },
}));

const closers: Array<() => void> = [];
afterEach(async () => {
  closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } });
  vi.resetModules();
  await fs.rm(fixture.root, { recursive: true, force: true });
});
const hex = (n: number) => n.toString(16).padStart(64, '0');
const record = (n: number) => ({ kind: 'batch' as const, v: 1 as const, keyHash: hex(n), batchId: randomUUID(), mode: 't2i', status: 'succeeded' as const, stopCode: null, count: 1,
  counts: { succeeded: 1, failed: 0, unknown: 0, cancelled: 0, skipped: 0 }, requestHash: hex(100 + n), recipePlanHash: hex(200 + n), intervalSeconds: 0, createdAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z', cleanedAt: '2026-11-05T00:00:00.000Z' });

describe('backups carry the cleaned queue records', () => {
  it('exports them with every backup, restores a deleted record file from it, and leaves them alone on a library restore', async () => {
    fixture.root = await fs.mkdtemp(path.join(os.tmpdir(), 'nai-backup-queue-records-'));
    const userData = path.join(fixture.root, 'userData'), libraryDirectory = path.join(fixture.root, 'library'), runtime = path.join(userData, 'runtime');
    await fs.mkdir(runtime, { recursive: true }); await fs.mkdir(libraryDirectory, { recursive: true });
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ settings: { hasOnboarded: true, outputDir: path.join(fixture.root, 'out'), backupDir: path.join(userData, 'backups'), language: 'zh-CN' } }));
    const { openLibraryRepository } = await import('../library/repository');
    const repository = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite'), libraryDirectory, userDataRoot: userData });
    closers.push(() => repository.close());
    const { activateLibrary, deactivateLibrary } = await import('../library-runtime');
    activateLibrary(repository, { libraryDirectory, userDataRoot: userData });
    closers.unshift(() => deactivateLibrary());
    const { createQueueTombstones } = await import('../queue-tombstones');
    const open = () => createQueueTombstones(runtime, { anchorDir: path.join(userData, 'queue-anchor'), log: () => {} });
    const tombstones = open(); await tombstones.append([record(1), record(2)]);
    const backup = await import('./data-backup');
    backup.setQueueCleanedRecordsBackup({ files: () => open().exportFiles(), restore: files => open().restore(files) });

    for (const categories of [['configuration'], ['imageHistory', 'artistLibrary', 'referencePresets', 'promptPresets']] as const) {
      const exported = await backup.exportDataBackup({ destination: 'internal', categories: [...categories] });
      expect(exported.ok, exported.message).toBe(true);
      const zip = await JSZip.loadAsync(await fs.readFile(exported.path!));
      expect(Object.keys(zip.files).filter(name => name.startsWith('queue-cleaned/') && !zip.files[name].dir).sort()).toEqual(['queue-cleaned/anchor-a.json', 'queue-cleaned/anchor-b.json', 'queue-cleaned/cleaned-v1.jsonl']);
    }
    const full = await backup.exportDataBackup({ destination: 'internal', categories: ['imageHistory', 'artistLibrary', 'referencePresets', 'promptPresets'] });
    // Lost: the record file. Restored by importing the backup (the library restore itself never changes the records).
    await fs.rm(path.join(runtime, 'queue-cleaned', 'cleaned-v1.jsonl'));
    const damaged = open(); await damaged.load(); expect(damaged.health()).toMatchObject({ state: 'broken', problem: 'records_missing' });
    const restored: any = await backup.importDataBackup({ path: full.path!, categories: ['imageHistory', 'artistLibrary', 'referencePresets', 'promptPresets'] });
    expect(restored.ok, restored.message).toBe(true);
    expect(restored.queueRecords).toEqual({ status: 'restored', added: 0 });
    const healthy = open(); await healthy.load();
    expect(healthy.health()).toMatchObject({ state: 'ok', readable: 2 });
    await expect(healthy.byKeyHash(hex(2))).resolves.toMatchObject({ keyHash: hex(2) });
    // Healthy records and the same backup again: nothing changes, no fail closed from the library restore.
    const again: any = await backup.importDataBackup({ path: full.path!, categories: ['imageHistory', 'artistLibrary', 'referencePresets', 'promptPresets'] });
    expect(again.ok, again.message).toBe(true); expect(again.queueRecords).toEqual({ status: 'unchanged', added: 0 });
    const after = open(); await after.load(); expect(after.health()).toMatchObject({ state: 'ok', readable: 2 });
  });
});
