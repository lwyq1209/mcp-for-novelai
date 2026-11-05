import { QUEUE_WORKSPACE } from './queue-recipe-service';
import { queueBridgeError } from './queue-bridge-error';
import { hostErrorFields } from './host-error';
import type { BatchJob } from '../src/workspace/batch-types';
import type { GenerationResponse } from '../src/workspace/generation-types';

/**
 * The client's queue panel (「任务与 Agent」): it lists the recipe queue and pauses, resumes or cancels one batch through
 * exactly the host queue methods the MCP tools use (list_queue, pause_queue, resume_queue, cancel_queue), so the
 * host rules hold unchanged: resume continues the batch's original frozen recipes and never resends a failed or
 * unknown image. Nothing here reads or changes the canvas, and no generation is started other than by resume.
 */
export const QUEUE_UI_METHODS = ['list_queue', 'pause_queue', 'resume_queue', 'cancel_queue'] as const;
export type QueueUiMethod = typeof QUEUE_UI_METHODS[number];
export type QueueUiService = Record<QueueUiMethod, (args: Record<string, unknown>) => Promise<unknown>>;

/** The IPC body of novelai:queue:call (main.ts checks the sender first). Refusals keep the queue's own code and message. */
export function createQueueUiHandler(queue: QueueUiService) {
  return async (method: unknown, args: unknown): Promise<GenerationResponse<unknown>> => {
    if (typeof method !== 'string' || !(QUEUE_UI_METHODS as readonly string[]).includes(method)) return { ok: false, error: { code: 'method_not_found', message: 'This queue operation is not offered here.' } };
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    try { return { ok: true, result: await queue[method as QueueUiMethod](method === 'list_queue' ? {} : { batchId: input.batchId }) }; }
    // The window renders the code (and the reason/params, step 4a) in its language; the message is the English fallback.
    catch (error) { const bridged = queueBridgeError(error), own = hostErrorFields(error, bridged.code, bridged.message); return { ok: false, error: { ...own, code: bridged.code, message: bridged.message } }; }
  };
}

/** A batch event for the queue panel: recipe-queue batches only, as the batch service reports them. */
export function queueBatchEvent(job: BatchJob | null | undefined): BatchJob | null {
  return job && job.execution === 'queued' && job.originWorkspaceId === QUEUE_WORKSPACE ? job : null;
}

/**
 * A queue answer for the bridge (MCP): the same answer without what is for the window only, an item error's
 * upstream (NovelAI's cleaned answer, upstream-reason.ts; step 4c1). Every error-shaped object (one with a string code;
 * review rework: also without a message) loses that field, at any depth a queue answer has (32 levels; queue answers
 * are about 5 deep), also inside class instances; binary data and dates are copied as they are.
 */
export function withoutWindowOnlyFields<T>(value: T): T {
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 32 || !node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(child => walk(child, depth + 1));
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer || node instanceof Date) return node;
    const out: Record<string, unknown> = {};
    const errorShaped = typeof (node as Record<string, unknown>).code === 'string';
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (errorShaped && key === 'upstream') continue;
      out[key] = walk(child, depth + 1);
    }
    return out;
  };
  return walk(value, 0) as T;
}
