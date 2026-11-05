/**
 * Host errors the window shows (step 4a, user decision 10): every error the host hands to the renderer carries its
 * `code`, an English `message`, and — when the code alone does not say which case it is — a `reason` (a message id of
 * the renderer's catalog, src/host-errors) with `params` for its placeholders. The renderer shows the catalog text of
 * reason (or code) in the interface language and falls back to the message. Messages to MCP clients stay English;
 * reason and params never travel over the bridge (they are not part of an error's details).
 */
export type HostErrorParams = Record<string, string | number>;
export interface HostErrorFields { code: string; message: string; reason?: string; params?: HostErrorParams }

const REASON = /^[a-z][a-z0-9_.]{0,79}$/;
const CODE = /^[a-z_]+$/;

/** Names the case of an error for the window (its catalog message id and placeholder values). */
export function withReason<T extends object>(error: T, reason: string, params?: HostErrorParams): T {
  return Object.assign(error, { reason, ...(params ? { params: { ...params } } : {}) });
}

/** An Error with a code, an English message and its window reason. */
export function hostError(code: string, message: string, reason?: string, params?: HostErrorParams): Error & { code: string } {
  const error = Object.assign(new Error(message), { code });
  return reason ? withReason(error, reason, params) : error;
}

const plainParams = (value: unknown): HostErrorParams | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries: Array<[string, string | number]> = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(key)) continue;
    if (typeof item === 'string') entries.push([key, item.slice(0, 2000)]);
    else if (typeof item === 'number' && Number.isFinite(item)) entries.push([key, item]);
  }
  return entries.length ? Object.fromEntries(entries.slice(0, 16)) : undefined;
};

/** What an IPC reply carries of an error: its code (or the fallback), message, and reason/params when it has them. */
export function hostErrorFields(error: unknown, fallbackCode: string, fallbackMessage: string): HostErrorFields {
  const value = error as { code?: unknown; message?: unknown; reason?: unknown; params?: unknown } | null | undefined;
  let code = fallbackCode, message = fallbackMessage, reason: string | undefined, params: HostErrorParams | undefined;
  try {
    if (typeof value?.code === 'string' && CODE.test(value.code)) code = value.code;
    if (error instanceof Error && error.message) message = error.message;
    if (typeof value?.reason === 'string' && REASON.test(value.reason)) reason = value.reason;
    params = plainParams(value?.params);
  } catch { /* An unreadable error keeps the fallback. */ }
  return { code, message, ...(reason ? { reason } : {}), ...(params ? { params } : {}) };
}
