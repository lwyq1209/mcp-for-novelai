import { describe, expect, it } from 'vitest';
import { batch, item } from './test-batch';
import {
  ETA_MIN_GAPS, QUEUE_ENDED_WINDOW, STATUS_TEXT, STATUS_TONE, batchFlags, batchGroup, batchNotes, batchTitle, cancelImpact, defaultBatchId, etaMinutes,
  finishedImages, itemsTsv, queueList, queueStats, selectedBatchId, shortId, trackCompletion, type QueueBatch,
} from './model';
import { uiText } from '../ui/i18n';

const t = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('zh', key, params);

describe('queue page model: groups, filter, ended window, selection', () => {
  const running = batch('r', 'running', [item(0, 'succeeded'), item(1, 'running'), item(2, 'pending')], { createdAt: '2026-11-03T08:10:00.000Z' });
  const queuedNew = batch('q2', 'queued', [item(0, 'pending')], { createdAt: '2026-11-03T08:30:00.000Z' });
  const queuedOld = batch('q1', 'queued', [item(0, 'pending')], { createdAt: '2026-11-03T08:20:00.000Z' });
  const paused = batch('p', 'paused', [item(0, 'pending')], { createdAt: '2026-11-03T08:25:00.000Z' });
  const blocked = batch('x', 'blocked', [item(0, 'skipped')], { finishedAt: '2026-11-03T08:40:00.000Z' });
  const done = batch('d', 'succeeded', [item(0, 'succeeded')], { finishedAt: '2026-11-03T08:50:00.000Z' });
  // Host order: newest first.
  const all = [done, blocked, queuedNew, paused, queuedOld, running];

  it('groups by status: running/pausing/cancelling, queued/paused, terminal (partial and the legacy blocked are ended)', () => {
    expect((['running', 'pausing', 'cancelling'] as const).map(batchGroup)).toEqual(['active', 'active', 'active']);
    expect((['queued', 'paused'] as const).map(batchGroup)).toEqual(['waiting', 'waiting']);
    expect((['succeeded', 'partial', 'cancelled', 'blocked'] as const).map(batchGroup)).toEqual(['ended', 'ended', 'ended', 'ended']);
  });
  it('labels a partly done batch in both languages, in the warning tone, and lists it with the ended ones', () => {
    expect(STATUS_TEXT.partial).toBe('q.s.partial');
    expect(uiText('zh', STATUS_TEXT.partial)).toBe('部分完成');
    expect(uiText('en', STATUS_TEXT.partial)).toBe('Partly done');
    expect(STATUS_TONE.partial).toBe('warn');
    const partial = batch('pp', 'partial', [item(0, 'succeeded'), item(1, 'failed'), item(2, 'succeeded')], { finishedAt: '2026-11-03T08:55:00.000Z' });
    expect(partial.finishedAt).not.toBeNull();
    expect(queueList([partial, ...all], 'ended').sections).toEqual([{ group: 'ended', batches: [partial, done, blocked] }]);
    expect(queueList([partial, ...all], 'open').sections.flatMap(section => section.batches)).not.toContain(partial);
    expect(batchFlags(partial)).toEqual(['failed']);
  });
  it('lists unfinished batches oldest first (queue order) and ended ones newest first; filters', () => {
    const list = queueList(all, 'all');
    expect(list.sections.map(section => [section.group, section.batches.map(value => value.batchId)])).toEqual([
      ['active', ['r']], ['waiting', ['q1', 'p', 'q2']], ['ended', ['d', 'x']],
    ]);
    expect(queueList(all, 'open').sections.map(section => section.group)).toEqual(['active', 'waiting']);
    expect(queueList(all, 'ended').sections.map(section => section.group)).toEqual(['ended']);
    expect(queueList([], 'all')).toEqual({ sections: [], hiddenEnded: 0 });
  });
  it('shows only the most recent ended batches and counts the rest', () => {
    const ended = Array.from({ length: QUEUE_ENDED_WINDOW + 5 }, (_, index) => batch(`e${index}`, 'succeeded', [item(0, 'succeeded')], { finishedAt: new Date(Date.UTC(2026, 10, 3, 9, 60 - index)).toISOString() }));
    const list = queueList([running, ...ended], 'all');
    expect(list.sections.at(-1)!.batches).toHaveLength(QUEUE_ENDED_WINDOW);
    expect(list.sections.at(-1)!.batches[0].batchId).toBe('e0');
    expect(list.hiddenEnded).toBe(5);
    expect(queueList([running, ...ended], 'all', 100).hiddenEnded).toBe(0);
    expect(queueList([running, ...ended], 'open').hiddenEnded).toBe(0);
  });
  it('selects the running batch, else the oldest unfinished, else the newest; keeps a selection while it is listed', () => {
    expect(defaultBatchId(all)).toBe('r');
    expect(defaultBatchId([done, blocked, queuedNew, paused, queuedOld])).toBe('q1');
    expect(defaultBatchId([blocked, done])).toBe('d');
    expect(defaultBatchId([])).toBeNull();
    expect(selectedBatchId(all, 'x')).toBe('x');
    expect(selectedBatchId(all, 'gone')).toBe('r');
  });
  it('counts running and waiting batches and the images finished today', () => {
    const now = new Date('2026-11-03T12:00:00.000Z');
    const yesterday = batch('y', 'succeeded', [item(0, 'succeeded'), item(1, 'succeeded')], { finishedAt: '2026-11-01T12:00:00.000Z' });
    const stats = queueStats([...all, yesterday], now);
    expect(stats.running).toBe(1);
    expect(stats.waiting).toBe(3);
    // r (1 succeeded, updated today) + d (1); the batch of an earlier day does not count.
    expect(stats.doneToday).toBe(2);
  });
});

describe('queue page model: titles, flags, notes and the cancel impact', () => {
  it('titles a batch by its project, else 手动 for a manual batch, else the mode', () => {
    expect(batchTitle(batch('a', 'queued', [], { output: { historyGroup: 'cafe', historyGroupName: 'cafe-scene' } }), t)).toBe('cafe-scene');
    expect(batchTitle(batch('a', 'queued', [], { output: { historyGroup: 'cafe' } }), t)).toBe('cafe');
    expect(batchTitle(batch('a', 'queued', [], { source: { kind: 'manual', persistent: false } }), t)).toBe('手动');
    expect(batchTitle(batch('a', 'queued', [], { mode: 'i2i' }), t)).toBe('图生图批次');
    expect(batchTitle(batch('a', 'queued', [], { mode: 'i2i' }), (key, params) => uiText('en', key, params))).toBe('Img2Img batch');
  });
  it('flags unknown results and failures; a paused batch has no flag of its own (the queue never pauses one itself)', () => {
    expect(batchFlags(batch('a', 'paused', [item(0, 'pending')], { error: { code: 'queue_halted', message: 'x' } }))).toEqual([]);
    expect(batchFlags(batch('a', 'succeeded', [item(0, 'unknown'), item(1, 'failed')]))).toEqual(['unknown', 'failed']);
    expect(batchFlags(batch('a', 'succeeded', [item(0, 'succeeded')]))).toEqual([]);
  });
  it('picks the notes for each state, with the test ids the dev tools read', () => {
    const kinds = (value: QueueBatch) => batchNotes(value).map(note => [note.kind, note.testId ?? null, note.code ?? null]);
    expect(kinds(batch('r', 'running', [item(0, 'running')]))).toEqual([['pause', null, null]]);
    expect(kinds(batch('r', 'pausing', [item(0, 'running')]))).toEqual([['pause', null, null]]);
    // A legacy reason left on a stored batch is shown as the host's reason, never as an automatic pause.
    expect(kinds(batch('h', 'paused', [item(0, 'pending')], { error: { code: 'queue_halted', message: 'x' } }))).toEqual([['error', 'queue-error-h', 'queue_halted']]);
    expect(kinds(batch('p', 'paused', [item(0, 'pending')]))).toEqual([['paused', null, null]]);
    expect(kinds(batch('p', 'paused', [item(0, 'pending')], { error: { code: 'recovered_paused', message: 'x' } }))).toEqual([['error', 'queue-error-p', 'recovered_paused']]);
    const blocked = batchNotes(batch('b', 'blocked', [item(0, 'skipped')], { error: { code: 'recipe_source_missing', message: 'gone' } }));
    expect(blocked.map(note => [note.kind, note.tone, note.testId])).toEqual([['error', 'danger', 'queue-error-b']]);
    expect(kinds(batch('c', 'cancelling', [item(0, 'running')], { cancelRequested: true, error: { code: 'cancel_unconfirmed', message: 'x' } }))).toEqual([['cancelling', null, null], ['error', 'queue-error-c', 'cancel_unconfirmed']]);
    // A partly done batch: its unknown and failed images, no batch reason; one ended early says why, as a warning.
    const partial = batchNotes(batch('pp', 'partial', [item(0, 'failed', { error: { code: 'rate_limited', message: 'x' } }), item(1, 'succeeded')]));
    expect(partial.map(note => [note.kind, note.tone, note.code])).toEqual([['failed', 'danger', 'rate_limited']]);
    expect(batchNotes(batch('ps', 'partial', [item(0, 'succeeded'), item(1, 'skipped')], { error: { code: 'scheduler_stopped', message: 'x' } })).map(note => [note.kind, note.tone, note.code])).toEqual([['error', 'warn', 'scheduler_stopped']]);
    const mixed = batchNotes(batch('m', 'partial', [item(0, 'succeeded'), item(1, 'unknown'), item(2, 'failed'), item(3, 'failed')]));
    expect(mixed.map(note => [note.kind, note.testId, note.count])).toEqual([['unknown', 'queue-unknown-m', 1], ['failed', 'queue-failed-m', 2]]);
    expect(mixed[1].item?.index).toBe(2);
    expect(kinds(batch('q', 'queued', [item(0, 'pending')]))).toEqual([['queued', null, null]]);
    expect(kinds(batch('d', 'succeeded', [item(0, 'succeeded')]))).toEqual([]);
  });
  it('tells cancel what it skips and whether an image is being generated', () => {
    expect(cancelImpact(batch('r', 'running', [item(0, 'succeeded'), item(1, 'running'), item(2, 'pending'), item(3, 'pending')]))).toEqual({ pending: 2, inFlight: true });
    expect(cancelImpact(batch('q', 'queued', [item(0, 'pending'), item(1, 'pending')]))).toEqual({ pending: 2, inFlight: false });
    expect(cancelImpact(batch('p', 'paused', [item(0, 'succeeded'), item(1, 'pending')]))).toEqual({ pending: 1, inFlight: false });
  });
});

describe('queue page model: time left only from what this window saw', () => {
  const running = (ended: number, total = 10) => batch('r', 'running', Array.from({ length: total }, (_, index) => item(index, index < ended ? 'succeeded' : index === ended ? 'running' : 'pending')));
  it('treats the first reading as a baseline and needs at least two one-image gaps', () => {
    let track = trackCompletion(undefined, 3, 0);
    expect(track.at).toEqual([]);
    expect(etaMinutes(running(3), track)).toBeNull();
    track = trackCompletion(track, 4, 60_000);
    expect(etaMinutes(running(4), track)).toBeNull();
    track = trackCompletion(track, 5, 120_000);
    expect(ETA_MIN_GAPS).toBe(2);
    expect(etaMinutes(running(5), track)).toBeNull();
    track = trackCompletion(track, 6, 180_000);
    // Gaps of 60 s; 4 images left (1 running + 3 pending) → 4 minutes.
    expect(etaMinutes(running(6), track)).toBe(4);
    expect(trackCompletion(track, 6, 999_999)).toBe(track);
  });
  it('starts over when several images ended between readings or the count went down; never for a non-running batch', () => {
    let track = trackCompletion(trackCompletion(trackCompletion(trackCompletion(undefined, 0, 0), 1, 10_000), 2, 20_000), 3, 30_000);
    expect(etaMinutes(running(3, 4), track)).toBe(0);
    expect(etaMinutes(running(3), track)).toBe(1);
    track = trackCompletion(track, 6, 40_000);
    expect(track.at).toEqual([40_000]);
    expect(etaMinutes(running(6), track)).toBeNull();
    expect(trackCompletion(track, 2, 50_000)).toEqual({ ended: 2, at: [] });
    const full = { ended: 3, at: [0, 60_000, 120_000, 180_000] };
    expect(etaMinutes({ ...running(3), status: 'paused' }, full)).toBeNull();
    expect(etaMinutes({ ...running(3), cancelRequested: true }, full)).toBeNull();
    expect(etaMinutes(running(3), undefined)).toBeNull();
  });
});

describe('queue page model: images and technical details', () => {
  it('lists finished history ids in item order, capped', () => {
    const value = batch('a', 'succeeded', [item(0, 'succeeded'), item(1, 'failed'), item(2, 'succeeded'), item(3, 'succeeded')]);
    expect(finishedImages(value)).toEqual(['h-0', 'h-2', 'h-3']);
    expect(finishedImages(value, 2)).toEqual(['h-0', 'h-2']);
  });
  it('shortens long ids and writes the item table as TSV', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('0123456789abcdefghijklmnop')).toBe('0123456789…klmnop');
    expect(itemsTsv(batch('a', 'running', [item(0, 'succeeded'), item(1, 'pending')]))).toBe('1\tjob-0\t100\n2\t\t101');
  });
});

describe('review rework (4b2 P1): next batch in progress and the state that decides the buttons', () => {
  it('offers the running batch (else the next unfinished one) while another is shown, nothing when it is shown', async () => {
    const { nextActiveBatch, actionStateKey, ACTION_SETTLE_MS } = await import('./model');
    const { batch, item } = await import('./test-batch');
    const done = batch('d', 'succeeded', [item(0, 'succeeded')]);
    const run = batch('r', 'running', [item(0, 'running')]);
    const wait = batch('w', 'queued', [item(0, 'pending')]);
    expect(nextActiveBatch([run, wait, done], 'd')?.batchId).toBe('r');
    expect(nextActiveBatch([run, wait, done], 'r')).toBeNull();
    expect(nextActiveBatch([wait, done], 'd')?.batchId).toBe('w');
    expect(nextActiveBatch([done], 'd')).toBeNull();
    // A waiting batch is shown and another one runs: offered too.
    expect(nextActiveBatch([run, wait], 'w')?.batchId).toBe('r');
    expect(actionStateKey(run, ['pause', 'cancel'])).not.toBe(actionStateKey({ ...run, status: 'paused' }, ['resume', 'cancel']));
    expect(actionStateKey(run, ['pause', 'cancel'])).not.toBe(actionStateKey({ ...run, cancelRequested: true }, ['pause', 'cancel']));
    expect(ACTION_SETTLE_MS).toBeGreaterThanOrEqual(500);
  });
});
