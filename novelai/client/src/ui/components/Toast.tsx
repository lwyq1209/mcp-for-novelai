import { stripHostErrorSuffixes } from '../../host-errors/bridge';
import type { ReactNode } from 'react';
import { create } from 'zustand';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';
import { UiPortal } from '../Portal';
import { Button, IconButton } from './Button';

export type ToastTone = 'neutral' | 'ok' | 'warn' | 'danger';

/**
 * A toast's text: as it is, or rendered in the interface language each time the toast is drawn, so a toast still
 * shown when the language changes reads in the new one (step 4c1; used by the long-lived toasts).
 */
export type ToastText = ReactNode | ((lang: 'zh' | 'en') => ReactNode);
export const toastText = (value: ToastText, lang: 'zh' | 'en'): ReactNode => typeof value === 'function' ? value(lang) : value;

export interface ToastAction {
  label: string | ((lang: 'zh' | 'en') => string);
  onClick(): void;
}

export interface ToastOptions {
  message: ToastText;
  tone?: ToastTone;
  action?: ToastAction;
  /** Default 4500; 0 keeps the toast until dismissed. */
  durationMs?: number;
  /**
   * A toast shown under the same key replaces this one in place (its text, tone, action and timer) instead of
   * stacking: a placeholder and then its result read as one message.
   */
  key?: string;
}

export interface ToastRecord {
  id: string;
  key?: string;
  message: ToastText;
  tone: ToastTone;
  action?: ToastAction;
  durationMs: number;
}

export const DEFAULT_TOAST_MS = 4500;

interface ToastState {
  toasts: ToastRecord[];
}

const useToastStore = create<ToastState>(() => ({ toasts: [] }));
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let sequence = 0;

export function showToast({ message, tone = 'neutral', action, durationMs = DEFAULT_TOAST_MS, key }: ToastOptions): string {
  const shown = key ? useToastStore.getState().toasts.find((toast) => toast.key === key) : undefined;
  const id = shown?.id ?? `ui-toast-${(sequence += 1)}`;
  // A host error's invisible structure suffix is never shown or copied (host-errors/bridge.ts).
  const record: ToastRecord = { id, ...(key ? { key } : {}), message: typeof message === 'string' ? stripHostErrorSuffixes(message) : message, tone, action, durationMs };
  useToastStore.setState((state) => ({ toasts: shown ? state.toasts.map((toast) => (toast.id === id ? record : toast)) : [...state.toasts, record] }));
  const timer = timers.get(id);
  if (timer !== undefined) { clearTimeout(timer); timers.delete(id); }
  if (durationMs > 0) timers.set(id, setTimeout(() => dismissToast(id), durationMs));
  return id;
}

export function dismissToast(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  useToastStore.setState((state) => {
    const toasts = state.toasts.filter((toast) => toast.id !== id);
    return toasts.length === state.toasts.length ? state : { toasts };
  });
}

/** Current toasts, oldest first. */
export function useToasts(): ToastRecord[] {
  return useToastStore((state) => state.toasts);
}

/** Snapshot for non-React callers and tests. */
export function getToasts(): ToastRecord[] {
  return useToastStore.getState().toasts;
}

const TONE_ICON: Record<ToastTone, IconName | null> = { neutral: null, ok: 'check', warn: 'alert', danger: 'alert' };

export function ToastView({ toast, closeLabel, onDismiss, lang = 'zh' }: { toast: ToastRecord; closeLabel: string; onDismiss(id: string): void; lang?: 'zh' | 'en' }) {
  const icon = TONE_ICON[toast.tone];
  return (
    <div
      role={toast.tone === 'danger' ? 'alert' : 'status'}
      className={clsx('ui-toast', toast.tone !== 'neutral' && `ui-toast--${toast.tone}`)}
    >
      {icon ? <Icon name={icon} size={16} className="ui-toast__icon" /> : null}
      <div className="ui-toast__msg">{typeof toast.message === 'function' ? stripText(toast.message(lang)) : toast.message}</div>
      {toast.action ? (
        <Button
          size="sm"
          variant="ghost"
          className="ui-toast__action"
          onClick={() => {
            toast.action?.onClick();
            onDismiss(toast.id);
          }}
        >
          {typeof toast.action.label === 'function' ? toast.action.label(lang) : toast.action.label}
        </Button>
      ) : null}
      <IconButton icon="x" size="sm" label={closeLabel} onClick={() => onDismiss(toast.id)} />
    </div>
  );
}

const stripText = (value: ReactNode) => typeof value === 'string' ? stripHostErrorSuffixes(value) : value;

/** Mount once near the app root; stacks toasts bottom-centre. lang: the interface language, for language-bound texts. */
export function ToastHost({ closeLabel, lang = 'zh' }: { closeLabel: string; lang?: 'zh' | 'en' }) {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return (
    <UiPortal>
      <div className="ui-toast-stack">
        {toasts.map((toast) => (
          <ToastView key={toast.id} toast={toast} closeLabel={closeLabel} onDismiss={dismissToast} lang={lang} />
        ))}
      </div>
    </UiPortal>
  );
}
