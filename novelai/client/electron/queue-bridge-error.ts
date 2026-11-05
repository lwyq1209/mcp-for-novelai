import { BridgeError } from './bridge-server';
import { BatchError } from './batch-service';
import { WorkspaceError } from '../src/workspace/protocol';

/** Upper bound of the serialized details a queue error may carry over the bridge (UTF-8 bytes of its JSON). */
export const QUEUE_ERROR_DETAILS_BYTES = 8 * 1024;
const MAX_DEPTH = 16;
const GENERIC_MESSAGE = 'The queue operation did not complete; read the same request to check its state and do not resubmit automatically.';
const CODE = /^[a-z_]+$/;
/** Thrown inside the copy when the value is not plain JSON data; the whole details object is then dropped. */
const NOT_PLAIN = Symbol('not plain JSON data');

const plainObject = (value: object) => { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; };
/** One property read; an accessor that throws, or a revoked Proxy, reads as undefined. */
const read = (value: unknown, key: 'code' | 'message' | 'details'): unknown => { try { return (value as Record<string, unknown> | null | undefined)?.[key]; } catch { return undefined; } };
/** The queue's own explanatory refusals; a value whose prototype cannot be read (a revoked Proxy) is not one. */
const queueRefusal = (error: unknown) => { try { return error instanceof BatchError || error instanceof WorkspaceError; } catch { return false; } };

/**
 * A detached copy of plain JSON data, or undefined. Mirrors JSON.stringify for functions, undefined and symbols
 * (dropped from objects, null in arrays) and non-finite numbers (null). Anything else that is not plain data — a
 * cycle, a BigInt, a class instance (Date, Buffer, Map, Error…), a Proxy that throws (for example a revoked one), an
 * accessor that throws, an own `__proto__` key (as JSON.parse creates; it is never copied as data), nesting deeper
 * than 16 — or a copy larger than QUEUE_ERROR_DETAILS_BYTES drops the whole details object. Never throws.
 */
export function plainQueueErrorDetails(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !plainObject(value)) return undefined;
    const ancestors = new Set<object>();
    const copy = (item: unknown, depth: number): unknown => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
      if (typeof item === 'number') return Number.isFinite(item) ? item : null;
      if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return undefined;
      if (typeof item !== 'object' || depth > MAX_DEPTH || ancestors.has(item)) throw NOT_PLAIN;
      if (!Array.isArray(item) && !plainObject(item)) throw NOT_PLAIN;
      ancestors.add(item);
      try {
        if (Array.isArray(item)) return item.map(entry => copy(entry, depth + 1) ?? null);
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(item)) {
          // Assigning it would set the copy's prototype instead of copying data.
          if (key === '__proto__') throw NOT_PLAIN;
          const entry = copy((item as Record<string, unknown>)[key], depth + 1);
          if (entry !== undefined) result[key] = entry;
        }
        return result;
      } finally { ancestors.delete(item); }
    };
    const details = copy(value, 0) as Record<string, unknown>;
    return Buffer.byteLength(JSON.stringify(details), 'utf8') <= QUEUE_ERROR_DETAILS_BYTES ? details : undefined;
  } catch { return undefined; }
}

/**
 * The bridge error for a failed queue-recipe method (main.ts queueMethods). The code is the error's own
 * lowercase snake_case code, otherwise queue_operation_failed. Only BatchError and WorkspaceError — the
 * queue's own explanatory refusals — keep their message and their details (when plain JSON data, see
 * plainQueueErrorDetails); everything else gets the generic message and no details. Each field is read on its
 * own: details that cannot be read only drop the details, and a code or message that cannot be read falls back
 * to queue_operation_failed or the generic message. Never throws.
 */
export function queueBridgeError(error: unknown): BridgeError {
  const own = read(error, 'code');
  const code = typeof own === 'string' && CODE.test(own) ? own : 'queue_operation_failed';
  if (!queueRefusal(error)) return new BridgeError(code, GENERIC_MESSAGE);
  const message = read(error, 'message');
  return new BridgeError(code, typeof message === 'string' ? message : GENERIC_MESSAGE, 400, plainQueueErrorDetails(read(error, 'details')));
}
