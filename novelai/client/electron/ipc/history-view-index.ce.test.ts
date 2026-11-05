// Frozen counterexample CE-I — history view order/dates re-scan the library on every change (2026-11-01).
// Install as novelai/client/electron/ipc/history-view-index.ce.test.ts. Base: main d917b22.
// Observed (main-process CPU profile of the daily client, ~8000 history items, one queued image):
// getHistoryItems -> repository.historyOrder ~370 ms and getHistoryDates -> historyDates ~60 ms per
// library change notification. Synthetic 8000 items on d917b22: median ~31 ms (all dates) / ~47 ms (one day).
// Requirement: after one new image, the incremental read (order) plus the date list stay under 8 ms
// (median of 5), with exactly the answers the repository's SQL views give, also after archive/remove.
// Step 3e: checked by what the reads do instead of how long they take on this machine: the in-memory view index
// answers them (ready), is never rebuilt, and refreshes exactly the one new image per round.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: (key: string) => key === 'userData' ? path.join(fixture.root, 'user-data') : key === 'pictures' ? path.join(fixture.root, 'pictures') : fixture.root },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString('utf8') },
}));

const closers: Array<() => void> = [];
beforeEach(() => { fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-history-index-ce-')); vi.resetModules(); });
afterEach(() => { closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } }); fs.rmSync(fixture.root, { recursive: true, force: true }); });

const N = 8000, DAYS = 30;
const dayOf = (index: number) => `2026-09-${String(1 + (index % DAYS)).padStart(2, '0')}`;
const payload = (id: string, date: string, groupId?: string) => ({
  id, date, createdAt: `${date}T12:00:00.000Z`, ...(groupId ? { groupId } : {}),
  filePath: path.join(fixture.root, 'out', date, `${id}.png`),
  params: { positivePrompt: `1girl, ${'artist:somebody, detailed, '.repeat(120)} ${id}`, negativePrompt: 'lowres, '.repeat(60), width: 832, height: 1216, steps: 28, seed: 1 },
  characterPrompts: [{ prompt: 'x '.repeat(400) }], generationOrigin: { jobId: id, mode: 't2i' },
});

it('CE-I after one new image, order + dates for a view come from the incrementally refreshed index and match the SQL views', async () => {
  const { openLibraryRepository } = await import('../library/repository');
  const repo = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite') });
  closers.push(() => repo.close());
  const { activateLibrary, deactivateLibrary } = await import('../library-runtime');
  activateLibrary(repo, { userDataRoot: path.join(fixture.root, 'user-data'), libraryDirectory: path.join(fixture.root, 'library') });
  closers.unshift(() => deactivateLibrary());
  const store = await import('./store');

  repo.transaction(() => { for (let index = 0; index < N; index++) repo.put('history', `h${index}`, payload(`h${index}`, dayOf(index), index % 7 === 0 ? 'g1' : undefined)); });
  // Start-up reads (not measured): full list, dates, and one incremental read per view.
  store.getHistory(); store.getHistoryDates();
  store.getHistoryItems({ ids: ['h0'] } as any); store.getHistoryItems({ ids: ['h0'], date: '2026-09-03' } as any);

  const expectedOrder = (date?: string) => repo.all('history').filter(item => !item.archived && (!date || item.payload.date === date)).map(item => item.id);
  const expectedDates = () => [...new Set(repo.all('history').filter(item => !item.archived).map(item => String(item.payload.date)))].sort().reverse();

  for (const view of [{ label: 'all', date: undefined as string | undefined }, { label: 'day', date: '2026-09-03' }]) {
    let last: any, dates: string[] = [];
    for (let round = 0; round < 5; round++) {
      const id = `fresh-${view.label}-${round}`;
      repo.put('history', id, payload(id, '2026-09-03'));
      const before = repo.historyViewIndexStats();
      last = store.getHistoryItems({ ids: [id], date: view.date } as any);
      dates = store.getHistoryDates();
      // … without re-scanning the library on every change: the index answered, was not rebuilt, refreshed one id.
      expect(repo.historyViewIndexStats(), `${view.label} round ${round}`).toMatchObject({ ready: true, stale: false, builds: before.builds, refreshedIds: before.refreshedIds + 1 });
    }
    // Same answers as the repository's SQL views.
    expect(last.order).toEqual(expectedOrder(view.date));
    expect(dates).toEqual(expectedDates());
  }

  // Index maintenance: archive one, remove one, move one to another day.
  const h3 = repo.get('history', 'h3')!; repo.put('history', 'h3', h3.payload, { expectedRevision: h3.revision, archived: true });
  repo.remove('history', 'h33');
  const h63 = repo.get('history', 'h63')!; repo.put('history', 'h63', { ...h63.payload, date: '2026-08-31' }, { expectedRevision: h63.revision });
  for (const date of [undefined, '2026-09-04', '2026-08-31']) {
    expect(store.getHistoryItems({ ids: ['h3', 'h33', 'h63'], date } as any).order).toEqual(expectedOrder(date));
  }
  expect(store.getHistoryDates()).toEqual(expectedDates());
}, 300_000);
