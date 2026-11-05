import { useEffect, useState } from 'react';
import { plainErrorMessage } from '../host-errors/bridge';
import type { QueueRetentionRequest, QueueRetentionStatus } from '../types';

/** The window's calls to the queue retention (Settings › Queue, the queue page's warning); null without a bridge. */
export async function queueRetentionCall<T = unknown>(request?: QueueRetentionRequest): Promise<T | null> {
  const api = typeof window === 'undefined' ? undefined : window.naiDesktop;
  if (!api?.queueRetention) return null;
  const response = await api.queueRetention(request);
  if (!response?.ok) throw Object.assign(new Error(plainErrorMessage(response?.error, 'The queue retention could not be read.')), { code: response?.error?.code, reason: response?.error?.reason });
  return response.result as T;
}

/** What the queue retention cleaned and the state of its records (the host's status, followed through its runs). */
export function useQueueRetention(enabled = true): [QueueRetentionStatus | null, (next: QueueRetentionStatus) => void] {
  const [status, setStatus] = useState<QueueRetentionStatus | null>(null);
  useEffect(() => {
    const api = typeof window === 'undefined' ? undefined : window.naiDesktop;
    if (!enabled || !api?.queueRetention) return;
    let live = true;
    void queueRetentionCall<QueueRetentionStatus>().then(value => { if (live && value) setStatus(value); }, () => undefined);
    const remove = api.onQueueRetention?.(next => { if (live) setStatus(next); });
    return () => { live = false; remove?.(); };
  }, [enabled]);
  return [status, setStatus];
}
