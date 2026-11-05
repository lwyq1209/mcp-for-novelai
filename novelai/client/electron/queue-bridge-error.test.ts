import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { BridgeError, startHttpBridge } from './bridge-server';
import { BatchError } from './batch-service';
import { WorkspaceError } from '../src/workspace/protocol';
import { plainQueueErrorDetails, QUEUE_ERROR_DETAILS_BYTES, queueBridgeError } from './queue-bridge-error';
import { createBridgeClient } from '../../src/mcp.mjs';

const GENERIC = 'The queue operation did not complete; read the same request to check its state and do not resubmit automatically.';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(() => runCleanups(cleanup.splice(0).reverse()));

describe('queueBridgeError (#14): the queue methods\' bridge error keeps the host refusal\'s plain JSON details', () => {
  it('keeps the code, message and details of the queue\'s own refusals', () => {
    const full = queueBridgeError(new WorkspaceError('queue_full', 'The queue already holds 200 unfinished items.', { pendingItems: 200, pendingItemLimit: 200 }));
    expect(full).toBeInstanceOf(BridgeError);
    expect(full).toMatchObject({ code: 'queue_full', message: 'The queue already holds 200 unfinished items.', status: 400, details: { pendingItems: 200, pendingItemLimit: 200 } });
    const frozen = { frozenQueue: { batches: 4096, batchLimit: 4096, bytes: 1, byteLimit: 2, reserve: 0 }, estimatedBytes: 512 };
    expect(queueBridgeError(new WorkspaceError('queue_full', 'm', frozen)).details).toEqual(frozen);
    const source = { recipeId: '12345678-1234-4234-8234-123456789abc', recipeRevision: 2, ref: { kind: 'history', id: 'h', revision: 1, assetId: 'a' }, sha256: 'a'.repeat(64), byteLength: 9, readerCode: 'image_busy' };
    expect(queueBridgeError(new WorkspaceError('recipe_source_busy', 'busy', source)).details).toEqual(source);
    const batch = queueBridgeError(new BatchError('workspace_busy', 'The single generation slot is busy.'));
    expect(batch).toMatchObject({ code: 'workspace_busy', message: 'The single generation slot is busy.', status: 400 });
    expect(batch.details).toBeUndefined();
    expect(queueBridgeError(new WorkspaceError('invalid_argument', 'no details')).details).toBeUndefined();
  });

  it('keeps the old message and code rules for everything else, and never forwards their details', () => {
    const raw = queueBridgeError(Object.assign(new Error('internal /Users/someone/secret path'), { code: 'enoent_like', details: { path: '/Users/someone/secret' } }));
    expect(raw).toMatchObject({ code: 'enoent_like', message: GENERIC }); expect(raw.details).toBeUndefined();
    for (const code of ['ENOENT', 'Bad-Code', 'queue full', 42, undefined]) expect(queueBridgeError(Object.assign(new Error('x'), { code })).code).toBe('queue_operation_failed');
    expect(queueBridgeError(new WorkspaceError('Not-Snake', 'kept message')).code).toBe('queue_operation_failed');
    expect(queueBridgeError(new WorkspaceError('Not-Snake', 'kept message')).message).toBe('kept message');
    for (const value of [null, undefined, 'text', 7, { code: 'queue_full', message: 'plain object', details: { a: 1 } }]) {
      const error = queueBridgeError(value);
      expect(error.message).toBe(GENERIC); expect(error.details).toBeUndefined();
    }
    const hostile = Object.defineProperty(new Error('x'), 'code', { get() { throw new Error('getter'); } });
    expect(queueBridgeError(hostile)).toMatchObject({ code: 'queue_operation_failed', message: GENERIC });
  });

  it('forwards details only as a detached copy of plain JSON data within 8 KiB, and never throws', () => {
    const cyclic: Record<string, unknown> = { a: 1 }; cyclic.self = cyclic;
    const weird = queueBridgeError(new WorkspaceError('queue_full', 'm', { fn: () => 1, cyclic }));
    expect(weird.details).toBeUndefined();
    expect(() => JSON.stringify(weird.details ?? null)).not.toThrow();
    // JSON.stringify's own rules for functions, undefined, symbols and non-finite numbers.
    expect(plainQueueErrorDetails({ fn: () => 1, gone: undefined, sym: Symbol('s'), list: [1, () => 2, undefined, NaN], inf: Infinity, keep: 'yes', nested: { n: null, b: false } }))
      .toEqual({ list: [1, null, null, null], inf: null, keep: 'yes', nested: { n: null, b: false } });
    // Not plain data: the whole details object is dropped.
    for (const value of [{ big: 1n }, { when: new Date(0) }, { bytes: Buffer.from('x') }, { map: new Map() }, { error: new Error('x') }, [1, 2], 'text', null, new Date(0)])
      expect(plainQueueErrorDetails(value)).toBeUndefined();
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20; depth++) deep = { deep };
    expect(plainQueueErrorDetails(deep)).toBeUndefined();
    const throwing = Object.defineProperty({}, 'boom', { enumerable: true, get() { throw new Error('getter'); } });
    expect(plainQueueErrorDetails(throwing)).toBeUndefined();
    // A repeated (not cyclic) reference is fine.
    const shared = { x: 1 };
    expect(plainQueueErrorDetails({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
    // Size bound on the UTF-8 bytes of the JSON.
    const fitting = { text: 'x'.repeat(QUEUE_ERROR_DETAILS_BYTES - '{"text":""}'.length) };
    expect(plainQueueErrorDetails(fitting)).toEqual(fitting);
    expect(plainQueueErrorDetails({ text: 'x'.repeat(QUEUE_ERROR_DETAILS_BYTES) })).toBeUndefined();
    expect(plainQueueErrorDetails({ text: '字'.repeat(Math.ceil(QUEUE_ERROR_DETAILS_BYTES / 3)) })).toBeUndefined();
    // Detached: later changes to the error's object do not change what was forwarded.
    const source = { pendingItems: 1, nested: { list: [1] } };
    const copy = plainQueueErrorDetails(source)!;
    source.pendingItems = 2; source.nested.list.push(2);
    expect(copy).toEqual({ pendingItems: 1, nested: { list: [1] } });
  });

  it('details that cannot be read drop only the details; the code and message of the refusal stay', () => {
    const getter = Object.defineProperty(new WorkspaceError('queue_full', 'real message'), 'details', { get() { throw new Error('getter'); } });
    expect(queueBridgeError(getter)).toMatchObject({ code: 'queue_full', message: 'real message', status: 400 });
    expect(queueBridgeError(getter).details).toBeUndefined();
    const { proxy, revoke } = Proxy.revocable({}, {}); revoke();
    expect(() => plainQueueErrorDetails(proxy)).not.toThrow();
    expect(plainQueueErrorDetails(proxy)).toBeUndefined();
    const revoked = queueBridgeError(new WorkspaceError('queue_full', 'real message', proxy as Record<string, unknown>));
    expect(revoked).toMatchObject({ code: 'queue_full', message: 'real message' }); expect(revoked.details).toBeUndefined();
    const { proxy: nested, revoke: revokeNested } = Proxy.revocable({}, {}); revokeNested();
    const inner = queueBridgeError(new WorkspaceError('queue_full', 'real message', { ok: 1, inner: nested }));
    expect(inner).toMatchObject({ code: 'queue_full', message: 'real message' }); expect(inner.details).toBeUndefined();
    const trap = new Proxy({ a: 1 }, { ownKeys() { throw new Error('trap'); } });
    expect(queueBridgeError(new WorkspaceError('queue_full', 'real message', trap)).details).toBeUndefined();
    // Each field on its own: an unreadable message or code falls back alone.
    const silentMessage = Object.defineProperty(new WorkspaceError('queue_full', 'x', { pendingItems: 1 }), 'message', { get() { throw new Error('message'); } });
    expect(queueBridgeError(silentMessage)).toMatchObject({ code: 'queue_full', message: GENERIC, details: { pendingItems: 1 } });
    const silentCode = Object.defineProperty(new BatchError('workspace_busy', 'kept'), 'code', { get() { throw new Error('code'); } });
    expect(queueBridgeError(silentCode)).toMatchObject({ code: 'queue_operation_failed', message: 'kept' });
    // The error itself is a revoked Proxy: nothing can be read, nothing throws.
    const { proxy: gone, revoke: revokeGone } = Proxy.revocable(new WorkspaceError('queue_full', 'x'), {}); revokeGone();
    expect(queueBridgeError(gone)).toMatchObject({ code: 'queue_operation_failed', message: GENERIC });
  });

  it('an own "__proto__" key makes the details not plain data: dropped whole, never copied, no prototype pollution', () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
    expect(Object.keys(parsed)).toContain('__proto__');
    expect(plainQueueErrorDetails(parsed)).toBeUndefined();
    expect(plainQueueErrorDetails({ nested: JSON.parse('{"__proto__":{"polluted":true}}') })).toBeUndefined();
    expect(plainQueueErrorDetails({ list: [JSON.parse('{"__proto__":{"polluted":true}}')] })).toBeUndefined();
    const bridged = queueBridgeError(new WorkspaceError('queue_full', 'real message', parsed));
    expect(bridged).toMatchObject({ code: 'queue_full', message: 'real message' }); expect(bridged.details).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // Other key names are ordinary data.
    expect(plainQueueErrorDetails({ constructor: 'c', prototype: 'p', toString: 't' })).toEqual({ constructor: 'c', prototype: 'p', toString: 't' });
  });

  it('the details reach the MCP bridge client through the real HTTP bridge', async () => {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-queue-error-'));
    cleanup.push(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const bridge = await startHttpBridge({ runtimeDir, dispatch: async (method: string) => {
      if (method === 'enqueue_queue_recipes') throw queueBridgeError(new WorkspaceError('queue_full', 'The queue already holds 200 unfinished items.', { pendingItems: 200, pendingItemLimit: 200 }));
      throw queueBridgeError(Object.assign(new Error('/Users/someone/private'), { code: 'odd_failure', details: { path: '/Users/someone/private' } }));
    } });
    cleanup.push(() => bridge.close());
    const client = createBridgeClient({ runtimeDir });
    await expect(client.call('enqueue_queue_recipes', { requestKey: 'k', items: [] })).rejects.toMatchObject({ code: 'queue_full', message: 'The queue already holds 200 unfinished items.', details: { pendingItems: 200, pendingItemLimit: 200 } });
    const other = await client.call('list_queue', {}).catch((error: any) => error);
    expect(other).toMatchObject({ code: 'odd_failure', message: GENERIC });
    expect(other.details).toBeUndefined();
  });
});
