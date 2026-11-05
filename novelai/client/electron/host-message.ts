import { hostErrorFields, type HostErrorFields, type HostErrorParams } from './host-error';

/**
 * Host messages the window composes (step 4a, user decision 10): a result text in the shape of a host error
 * (code, English message, reason, params) that may name other host texts in `details` — the inner error of
 * "Could not read the backup: {detail}", the warnings of an import. The renderer renders each detail in its language
 * and puts it into the placeholder of the same name (src/host-errors/compose.ts). Details nest one level only: a
 * detail never has details of its own, and an array keeps at most MAX_DETAILS entries.
 */
export type HostDetail = HostErrorFields;
export type HostDetails = Record<string, HostDetail | HostDetail[]>;
export interface HostMessage extends HostErrorFields { details?: HostDetails }

export const MAX_DETAILS = 20;
const MAX_TEXT = 2000;

const clip = (value: string) => value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;

/** One detail: only code, message (clipped), reason and params, whatever else the value carries. */
export function hostDetail(value: unknown, fallbackCode = 'host_error', fallbackMessage = 'The operation did not complete.'): HostDetail {
  const plain = typeof value === 'string' && value ? new Error(value)
    : value && typeof value === 'object' && !(value instanceof Error) && typeof (value as { message?: unknown }).message === 'string'
      ? Object.assign(new Error((value as { message: string }).message), value) : value;
  const fields = hostErrorFields(plain, fallbackCode, fallbackMessage);
  return { ...fields, message: clip(fields.message) };
}

const detailsOf = (details: Record<string, unknown> | undefined): HostDetails | undefined => {
  if (!details) return undefined;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, Array.isArray(value) ? value.slice(0, MAX_DETAILS).map(item => hostDetail(item)) : hostDetail(value)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

/** A host text with its code, English message, optional reason and params, and one level of details. */
export function hostMessage(code: string, message: string, reason?: string, params?: HostErrorParams, details?: Record<string, unknown>): HostMessage {
  const composed = detailsOf(details);
  return { code, message: clip(message), ...(reason ? { reason } : {}), ...(params ? { params: { ...params } } : {}), ...(composed ? { details: composed } : {}) };
}

/** The English message of an unknown error (for composing an English host message). */
export function errorText(error: unknown, fallback = 'Unknown error.'): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' && (error as { message: string }).message) return (error as { message: string }).message;
  return typeof error === 'string' && error ? error : fallback;
}
