// Frozen counterexamples CE-3, CE-4 (main process) — library refresh storm, 2026-11-01.
// Install as novelai/client/electron/ipc/library-refresh-storm-main.ce.test.ts. Base: f30714b.
// Observed: the repository announced only a revision number, so the renderer could not tell
// what changed; and getHistoryDates()/getHistory() each decoded every history record
// (repo.all('history')), so one saved image cost two full decodes of a 7614-item history.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'userData') return path.join(fixture.root, 'user-data');
      if (key === 'pictures') return path.join(fixture.root, 'pictures');
      if (key === 'exe') return path.join(fixture.root, 'app', 'MCP for NovelAI');
      return fixture.root;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

const closers: Array<() => void> = [];
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-refresh-storm-ce-'));
  vi.resetModules();
});
afterEach(() => {
  closers.splice(0).forEach(close => { try { close(); } catch { /* already closed */ } });
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

async function openRepository() {
  const { openLibraryRepository } = await import('../library/repository');
  const repository = openLibraryRepository({ filePath: path.join(fixture.root, 'library.sqlite') });
  closers.push(() => repository.close());
  return repository;
}
const historyPayload = (id: string, date: string) => ({
  id, date, createdAt: `${date}T12:00:00.000Z`,
  filePath: path.join(fixture.root, 'output', date, `${id}.png`),
  params: { positivePrompt: `1girl, solo, scenery, ${'detailed '.repeat(40)}${id}`, negativePrompt: 'lowres', width: 832, height: 1216, steps: 28, seed: 1 },
});

it('CE-3 one committed transaction announces once, naming every changed kind and id', async () => {
  const repository = await openRepository();
  const seen: unknown[][] = [];
  repository.subscribe(((...args: unknown[]) => { seen.push(args); }) as never);

  repository.transaction(() => {
    repository.put('history', 'h1', historyPayload('h1', '2026-11-01'));
    repository.put('note', 'n1', { id: 'n1', name: 'lighting notes', notes: 'rim light' });
  });
  expect(seen).toHaveLength(1);
  const [revision, change] = seen[0] as [number, { changedKinds: string[]; ids: string[] }];
  expect(typeof revision).toBe('number');
  expect([...change.changedKinds].sort()).toEqual(['history', 'note']);
  expect([...change.ids].sort()).toEqual(['h1', 'n1']);

  repository.put('history', 'h2', historyPayload('h2', '2026-11-01'));
  expect(seen).toHaveLength(2);
  expect(seen[1][1]).toMatchObject({ changedKinds: ['history'], ids: ['h2'] });

  repository.remove('history', 'h1');
  expect(seen).toHaveLength(3);
  expect(seen[2][1]).toMatchObject({ changedKinds: ['history'], ids: ['h1'] });
});

it('CE-4 after one new image, the date list and one day of history do not re-decode the whole history', async () => {
  const repository = await openRepository();
  const { activateLibrary, deactivateLibrary } = await import('../library-runtime');
  activateLibrary(repository, { userDataRoot: path.join(fixture.root, 'user-data'), libraryDirectory: path.join(fixture.root, 'library') });
  closers.unshift(() => deactivateLibrary());
  const store = await import('./store');

  const N = 1500, DAYS = 15;
  const dayOf = (index: number) => `2026-10-${String(1 + (index % DAYS)).padStart(2, '0')}`;
  repository.transaction(() => { for (let index = 0; index < N; index++) repository.put('history', `h${index}`, historyPayload(`h${index}`, dayOf(index))); });
  // The client reads the full history once at start-up; that is not what is measured here.
  expect(store.getHistory()).toHaveLength(N);
  store.getHistoryDates();

  // One more image is saved, then the renderer refreshes the date list and the selected day.
  repository.put('history', 'fresh', historyPayload('fresh', '2026-10-03'));
  const parse = vi.spyOn(JSON, 'parse');
  let dates: string[], day: Array<{ id: string; fileUrl?: string }>, decodes: number;
  try {
    dates = store.getHistoryDates();
    day = store.getHistory('2026-10-03') as Array<{ id: string; fileUrl?: string }>;
    decodes = parse.mock.calls.length; // read before mockRestore(): Vitest 4 clears mock.calls on restore
  } finally { parse.mockRestore(); }

  // Same answers as before …
  const expectedDates = Array.from({ length: DAYS }, (_, index) => dayOf(index)).sort().reverse();
  expect(dates).toEqual(expectedDates);
  const expectedOrder = repository.all('history').filter(item => !item.archived && item.payload.date === '2026-10-03').map(item => item.id);
  expect(day.map(item => item.id)).toEqual(expectedOrder);
  expect(day).toHaveLength(N / DAYS + 1);
  expect(day.find(item => item.id === 'fresh')?.fileUrl).toBeTruthy();
  // … without decoding all N+1 records (twice) to produce them.
  expect(decodes).toBeLessThan(N / 5);
});
