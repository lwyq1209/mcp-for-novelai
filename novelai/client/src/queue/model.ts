import { batchSourceOf, isBatchTerminal, type BatchItem, type BatchJob, type BatchMode, type BatchStatus } from '../workspace/batch-types';
import { queueProgress } from '../workspace/queue-monitor';
import type { CaptureRequest } from '../shell/capture';
import type { IconName } from '../ui';
import type { UiStringKey } from '../ui/strings';

/**
 * Read model of the queue page (step 4b2, prototype 17–19): pure functions over the host's batches. Presentation only;
 * nothing here calls the host or decides what the host does.
 */

/** What the host adds to a recipe batch (electron/queue-recipe-service.ts decorate); every field optional. */
export interface QueueBatchOutput { historyGroup?: string; historyGroupId?: string; historyGroupName?: string; fileNamePrefix?: string }
export type QueueBatch = BatchJob & { output?: QueueBatchOutput; recipePlanHash?: string };

export type QueueGroup = 'active' | 'waiting' | 'ended';
export type QueueFilter = 'all' | 'open' | 'ended';
export const QUEUE_FILTERS: readonly QueueFilter[] = ['all', 'open', 'ended'];
export const QUEUE_GROUPS: readonly QueueGroup[] = ['active', 'waiting', 'ended'];
/** Ended batches shown before 显示更多, and how many more each click shows; unfinished batches are always shown. */
export const QUEUE_ENDED_WINDOW = 10;

const ACTIVE: readonly BatchStatus[] = ['running', 'pausing', 'cancelling'];
export function batchGroup(status: BatchStatus): QueueGroup {
  if (ACTIVE.includes(status)) return 'active';
  return isBatchTerminal(status) ? 'ended' : 'waiting';
}

const time = (value: string | null | undefined) => { const ms = value ? Date.parse(value) : NaN; return Number.isFinite(ms) ? ms : 0; };

export interface QueueSection { group: QueueGroup; batches: QueueBatch[] }
export interface QueueListModel { sections: QueueSection[]; hiddenEnded: number }
/**
 * The list: 进行中 / 等待中 in queue order (oldest first, the next to start on top), 已结束 newest first, only the most
 * recent `endedLimit` of those. Host order (newest first) breaks ties.
 */
export function queueList(batches: readonly QueueBatch[], filter: QueueFilter, endedLimit: number = QUEUE_ENDED_WINDOW): QueueListModel {
  const by: Record<QueueGroup, QueueBatch[]> = { active: [], waiting: [], ended: [] };
  batches.forEach(batch => by[batchGroup(batch.status)].push(batch));
  const oldestFirst = (list: QueueBatch[]) => list.map((batch, index) => ({ batch, index })).sort((a, b) => time(a.batch.createdAt) - time(b.batch.createdAt) || b.index - a.index).map(entry => entry.batch);
  const newestFirst = (list: QueueBatch[]) => list.map((batch, index) => ({ batch, index })).sort((a, b) => time(b.batch.finishedAt ?? b.batch.updatedAt) - time(a.batch.finishedAt ?? a.batch.updatedAt) || a.index - b.index).map(entry => entry.batch);
  const ended = newestFirst(by.ended);
  const shownEnded = ended.slice(0, Math.max(0, endedLimit));
  const sections: QueueSection[] = [];
  if (filter !== 'ended') {
    if (by.active.length) sections.push({ group: 'active', batches: oldestFirst(by.active) });
    if (by.waiting.length) sections.push({ group: 'waiting', batches: oldestFirst(by.waiting) });
  }
  if (filter !== 'open' && shownEnded.length) sections.push({ group: 'ended', batches: shownEnded });
  return { sections, hiddenEnded: filter === 'open' ? 0 : ended.length - shownEnded.length };
}

/** The batch selected when nothing (or something gone) is: the running one, else the oldest unfinished, else the newest. */
export function defaultBatchId(batches: readonly QueueBatch[]): string | null {
  const list = queueList(batches, 'all', 1);
  return list.sections[0]?.batches[0]?.batchId ?? null;
}
/**
 * The selection kept while its batch is still listed, else the default. The page pins whatever it shows (the default
 * included, review rework 4b2 P1): a batch that ends stays shown as ended; nothing moves to another batch by itself
 * unless the shown one is no longer listed at all.
 */
export function selectedBatchId(batches: readonly QueueBatch[], wanted: string | null): string | null {
  return wanted && batches.some(batch => batch.batchId === wanted) ? wanted : defaultBatchId(batches);
}

/**
 * The batch to offer as 「下一个进行中的批次」 while the shown one has ended (or is not running): the running one, else
 * the next unfinished one in queue order; null when the shown batch is that batch or nothing is unfinished.
 */
export function nextActiveBatch(batches: readonly QueueBatch[], shownId: string | null): QueueBatch | null {
  const shown = batches.find(batch => batch.batchId === shownId);
  if (shown && batchGroup(shown.status) === 'active') return null;
  const next = queueList(batches, 'open').sections[0]?.batches[0] ?? null;
  return next && next.batchId !== shownId ? next : null;
}

/** What decides a detail's buttons: its status, whether a cancel is requested, and the buttons offered. */
export const actionStateKey = (batch: Pick<BatchJob, 'status' | 'cancelRequested'>, actions: readonly string[]) => `${batch.status}|${batch.cancelRequested ? 1 : 0}|${actions.join(',')}`;
/** Buttons stay off this long after the batch's state (or its buttons) changed, so a click aimed at the old button
 * never lands on the new one (review rework 4b2 P1). */
export const ACTION_SETTLE_MS = 600;

/** Capture runs (capture-fixture.ts BATCHES): the batch each queue scene shows. */
export const CAPTURE_SELECTION: Partial<Record<CaptureRequest['page'], string>> = {
  queue: 'b1', 'shell-queue': 'b1', 'queue-halted': 'b4', 'queue-unknown': 'b7', 'queue-blocked': 'b5', 'queue-failed': 'b8',
};
export const captureShowsEmpty = (capture: CaptureRequest | null | undefined) => capture?.page === 'queue-empty';

const isToday = (value: string | null | undefined, now: Date) => {
  const ms = time(value);
  if (!ms) return false;
  const date = new Date(ms);
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
};
/**
 * The list header: batches generating, batches waiting, and images finished today. Items carry no time of their own,
 * so "today" is the day the batch last changed (finishedAt, else updatedAt).
 */
export function queueStats(batches: readonly QueueBatch[], now: Date = new Date()) {
  let running = 0, waiting = 0, doneToday = 0;
  for (const batch of batches) {
    const group = batchGroup(batch.status);
    if (group === 'active') running++;
    else if (group === 'waiting') waiting++;
    if (isToday(batch.finishedAt ?? batch.updatedAt, now)) doneToday += batch.items.filter(item => item.status === 'succeeded').length;
  }
  return { running, waiting, doneToday };
}

// ── Labels ─────────────────────────────────────────────────────────────────
export const STATUS_TEXT: Record<BatchStatus, UiStringKey> = {
  queued: 'q.s.queued', running: 'q.s.running', pausing: 'q.s.pausing', paused: 'q.s.paused', cancelling: 'q.s.cancelling',
  succeeded: 'q.s.succeeded', cancelled: 'q.s.cancelled', blocked: 'q.s.blocked',
};
export type StatusTone = 'neutral' | 'agent' | 'ok' | 'warn' | 'danger';
export const STATUS_TONE: Record<BatchStatus, StatusTone> = {
  queued: 'neutral', running: 'agent', pausing: 'warn', paused: 'warn', cancelling: 'warn', succeeded: 'ok', cancelled: 'neutral', blocked: 'danger',
};
export const MODE_TEXT: Record<BatchMode, UiStringKey> = { t2i: 'mode.t2i', i2i: 'mode.i2i', inpaint: 'mode.inpaint', enhance: 'mode.enhance', upscale: 'mode.upscale', director: 'mode.director' };
export const MODE_ICON: Record<BatchMode, IconName> = { t2i: 'sparkle', i2i: 'image', inpaint: 'brush', enhance: 'wand', upscale: 'expand', director: 'palette' };
const modeText = (mode: string): UiStringKey => Object.hasOwn(MODE_TEXT, mode) ? MODE_TEXT[mode as BatchMode] : 'mode.t2i';
export const modeLabelKey = modeText;
export const modeIcon = (mode: string): IconName => Object.hasOwn(MODE_ICON, mode) ? MODE_ICON[mode as BatchMode] : 'image';

const plain = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
/** The batch's project (history group) as the host named it, or ''. */
export const batchProject = (batch: QueueBatch) => plain(batch.output?.historyGroupName) || plain(batch.output?.historyGroup);
/** The raw history group id of the batch's project, or ''. */
export const batchProjectId = (batch: QueueBatch) => plain(batch.output?.historyGroupId);
/**
 * The card and detail title: the project; without one, 手动 for a manual batch, else "<mode>批次" (an agent enqueue
 * without historyGroup).
 */
export function batchTitle(batch: QueueBatch, t: (key: UiStringKey, params?: Record<string, string | number>) => string): string {
  const project = batchProject(batch);
  if (project) return project;
  if (batchSourceOf(batch).kind === 'manual') return t('c.manual');
  return t('q.t.mode', { mode: t(modeText(batch.mode)) });
}

// ── Progress and flags ─────────────────────────────────────────────────────
const STARTED: ReadonlyArray<BatchItem['status']> = ['submitting', 'running'];
const NOT_STARTED: ReadonlyArray<BatchItem['status']> = ['pending'];
export function batchCounts(batch: QueueBatch) {
  const progress = queueProgress(batch);
  const inFlight = batch.items.filter(item => STARTED.includes(item.status)).length;
  const pending = batch.items.filter(item => NOT_STARTED.includes(item.status)).length;
  return { ...progress, inFlight, pending, ended: progress.succeeded + progress.failed + progress.unknown + progress.cancelled + progress.skipped };
}
export const isHalted = (batch: Pick<BatchJob, 'error'>) => batch.error?.code === 'queue_halted';
export type BatchFlag = 'halted' | 'unknown' | 'failed';
/** The small marks beside a card's progress: an automatic pause, unknown results, failures. */
export function batchFlags(batch: QueueBatch): BatchFlag[] {
  const counts = batchCounts(batch), flags: BatchFlag[] = [];
  if (isHalted(batch) && batch.status === 'paused') flags.push('halted');
  if (counts.unknown > 0) flags.push('unknown');
  if (counts.failed > 0) flags.push('failed');
  return flags;
}
export function progressTone(batch: QueueBatch): 'agent' | 'accent' | 'warn' {
  if (batch.status === 'paused' || batch.status === 'pausing' || batch.status === 'cancelling') return 'warn';
  return isBatchTerminal(batch.status) ? 'accent' : 'agent';
}

// ── Notes ──────────────────────────────────────────────────────────────────
export type NoteKind = 'pause' | 'paused' | 'queued' | 'cancelling' | 'halted' | 'error' | 'unknown' | 'failed';
export type NoteTone = 'neutral' | 'agent' | 'warn' | 'danger';
export interface BatchNote { kind: NoteKind; tone: NoteTone; testId?: string; code?: string; count?: number; item?: BatchItem; error?: BatchJob['error'] }
/**
 * The notes of a batch detail, in order: what the state means and what to do next. The host's own stop reason (other
 * than queue_halted, which has its own wording) is shown through hostErrorText with its code.
 */
export function batchNotes(batch: QueueBatch): BatchNote[] {
  const notes: BatchNote[] = [];
  const counts = batchCounts(batch);
  const halted = isHalted(batch);
  if (batch.status === 'running' && !batch.cancelRequested) notes.push({ kind: 'pause', tone: 'neutral' });
  else if (batch.status === 'pausing') notes.push({ kind: 'pause', tone: 'warn' });
  else if (batch.status === 'cancelling' || (batch.cancelRequested && !isBatchTerminal(batch.status))) notes.push({ kind: 'cancelling', tone: 'warn' });
  else if (batch.status === 'queued') notes.push({ kind: 'queued', tone: 'neutral' });
  else if (batch.status === 'paused' && !halted && !batch.error) notes.push({ kind: 'paused', tone: 'warn' });
  if (halted) notes.push({ kind: 'halted', tone: 'warn', testId: `queue-halted-${batch.batchId}`, code: 'queue_halted' });
  else if (batch.error) notes.push({ kind: 'error', tone: batch.status === 'blocked' ? 'danger' : 'warn', testId: `queue-error-${batch.batchId}`, code: plain(batch.error.code) || undefined, error: batch.error });
  if (counts.unknown > 0) notes.push({ kind: 'unknown', tone: 'warn', testId: `queue-unknown-${batch.batchId}`, count: counts.unknown, item: batch.items.find(item => item.status === 'unknown') });
  if (counts.failed > 0) {
    const item = batch.items.find(item => item.status === 'failed');
    notes.push({ kind: 'failed', tone: 'danger', testId: `queue-failed-${batch.batchId}`, count: counts.failed, item, code: plain(item?.error?.code) || undefined });
  }
  return notes;
}

// ── Cancel confirmation ────────────────────────────────────────────────────
/** What cancelling skips (not-yet-started images) and whether an image is being generated (and may be charged). */
export function cancelImpact(batch: QueueBatch) {
  const counts = batchCounts(batch);
  return { pending: counts.pending, inFlight: counts.inFlight > 0 || (batch.activeIndex !== null && batch.status !== 'paused' && batch.status !== 'queued') };
}

// ── Time left ──────────────────────────────────────────────────────────────
/**
 * Moments (ms) at which this window saw the batch's finished count go up by exactly one, so each gap is one image.
 * The first reading is only a baseline: the time before it is unknown.
 */
export interface CompletionTrack { ended: number; at: number[] }
export function trackCompletion(previous: CompletionTrack | undefined, ended: number, now: number): CompletionTrack {
  if (!previous || ended < previous.ended) return { ended, at: [] };
  if (ended === previous.ended) return previous;
  // More than one image ended between two readings: the gap no longer measures one image, start over from here.
  if (ended - previous.ended > 1) return { ended, at: [now] };
  return { ended, at: [...previous.at, now].slice(-20) };
}
/** Minimum gaps observed before a time left is shown. */
export const ETA_MIN_GAPS = 2;
/**
 * Minutes left for a running batch, from the mean gap between images this window saw finish; null when it can't be
 * estimated reliably (not running, fewer than ETA_MIN_GAPS gaps, nothing left). 0 means under a minute.
 */
export function etaMinutes(batch: QueueBatch, track: CompletionTrack | undefined): number | null {
  if (batch.status !== 'running' || batch.cancelRequested || !track || track.at.length < ETA_MIN_GAPS + 1) return null;
  const counts = batchCounts(batch);
  const left = counts.pending + counts.inFlight;
  if (left <= 0) return null;
  const gaps: number[] = [];
  for (let index = 1; index < track.at.length; index++) gaps.push(track.at[index] - track.at[index - 1]);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  if (!Number.isFinite(mean) || mean <= 0) return null;
  const minutes = (mean * left) / 60_000;
  return minutes < 1 ? 0 : Math.round(minutes);
}

// ── Images ─────────────────────────────────────────────────────────────────
/** The history ids of a batch's finished images, in item order (cards stack the first few). */
export function finishedImages(batch: QueueBatch, limit = Infinity): string[] {
  const ids: string[] = [];
  for (const item of batch.items) {
    if (item.status !== 'succeeded') continue;
    for (const result of Array.isArray(item.results) ? item.results : []) {
      if (result && typeof result.id === 'string' && result.id) ids.push(result.id);
      if (ids.length >= limit) return ids;
    }
  }
  return ids;
}
export const ITEM_TEXT: Record<BatchItem['status'], UiStringKey> = {
  pending: 'q.item.pending', submitting: 'q.item.submitting', running: 'q.item.running', succeeded: 'q.s.succeeded',
  failed: 'q.item.failed', unknown: 'q.item.unknown', cancelled: 'q.item.cancelled', skipped: 'q.item.skipped',
};

/** Shortens a long id for display (the copy button copies it whole). */
export function shortId(value: string, head = 10, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
/** The rows of the technical details' item list as tab-separated text (index, jobId, seed). */
export function itemsTsv(batch: QueueBatch): string {
  return batch.items.map(item => [item.index + 1, item.jobId ?? '', item.actualSeed ?? item.plannedSeed ?? ''].join('\t')).join('\n');
}
