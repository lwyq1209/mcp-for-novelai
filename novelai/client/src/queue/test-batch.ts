/** Test helpers: host-shaped batches and items for the queue page tests (not used by the app). */
import { isBatchTerminal, type BatchItem, type BatchStatus } from '../workspace/batch-types';
import type { QueueBatch } from './model';

export const item = (index: number, status: BatchItem['status'], extra: Partial<BatchItem> = {}): BatchItem => ({
  index, plannedSeed: 100 + index, actualSeed: status === 'succeeded' ? 100 + index : null, requestKey: `k-${index}`, jobId: status === 'pending' ? null : `job-${index}`, status,
  results: status === 'succeeded' ? [{ index: 0, id: `h-${index}`, width: 832, height: 1216, model: 'm', actualSeed: 100 + index }] : [],
  error: status === 'failed' ? { code: 'provider_error', message: 'Refused.' } : status === 'unknown' ? { code: 'submission_unconfirmed', message: 'Unconfirmed.' } : null, ...extra,
});
let seq = 0;
export function batch(id: string, status: BatchStatus, items: BatchItem[], extra: Partial<QueueBatch> = {}): QueueBatch {
  seq++;
  const at = new Date(Date.UTC(2026, 10, 3, 8, seq)).toISOString();
  return {
    batchId: id, workspaceId: 'w', originWorkspaceId: 'w', submittedRevision: 1, checkpointWorkspaceId: 'w', checkpointRevision: 1, requestKey: `rk-${id}`,
    execution: 'queued', mode: 't2i', count: items.length, intervalSeconds: 0, seedMode: 'random', status, activeJobId: status === 'running' ? 'job-x' : null,
    activeIndex: status === 'running' ? items.findIndex(value => value.status === 'running') : null, createdAt: at, updatedAt: at,
    finishedAt: isBatchTerminal(status) ? at : null, error: null, cancelRequested: false, items,
    source: { kind: 'agent', client: { name: 'claude-code', version: null } }, ...extra,
  };
}
