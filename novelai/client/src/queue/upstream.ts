import { hostErrorText } from '../host-errors';
import type { AppLanguage } from '../types';
import type { UiText } from '../ui/i18n';
import type { BatchItem } from '../workspace/batch-types';

/**
 * What NovelAI answered to a failed agent image (the item error's upstream, kept by the host for the window only,
 * cleaned: electron/upstream-reason.ts; step 4c1), in the interface language; '' when the item has none (manual
 * items, other failures, batches stored before it existed).
 */
export function upstreamText(error: BatchItem['error'] | undefined, t: UiText, language: AppLanguage): string {
  const upstream = error?.upstream;
  if (!upstream || typeof upstream !== 'object') return '';
  const status = Number.isInteger(upstream.status) ? upstream.status! : null;
  if (typeof upstream.reason === 'string' && upstream.reason) return hostErrorText({ code: 'remote_error', reason: upstream.reason, params: { ...(status ? { status } : {}), ...(upstream.params ?? {}) } }, language, '');
  const message = typeof upstream.message === 'string' ? upstream.message.trim() : '';
  if (message) return t('q.up.said', { http: status ? t('q.up.http', { status }) : '', message });
  return status ? t('q.up.status', { status }) : '';
}
