import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';
import { UiPortal } from '../Portal';
import { Button } from './Button';

export type DialogTone = 'default' | 'danger' | 'warn';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Index to focus when Tab (shift=false) or Shift+Tab (shift=true) is pressed
 * on element `current` of `count` focusables, wrapping at both ends. A current
 * of -1 (focus outside the list) enters at the first / last element. Returns
 * -1 when there is nothing to focus.
 */
export function trapFocusIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return shift ? (current - 1 + count) % count : (current + 1) % count;
}

export interface DialogPanelProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  tone?: DialogTone;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
  titleId: string;
  descriptionId: string;
  busy?: boolean;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
}

/** Presentational dialog box (no portal, scrim or focus handling). */
export const DialogPanel = forwardRef<HTMLDivElement, DialogPanelProps>(function DialogPanel(
  { title, description, icon, tone = 'default', children, footer, width = 520, titleId, descriptionId, busy, onKeyDown },
  ref,
) {
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      aria-busy={busy || undefined}
      tabIndex={-1}
      className={clsx('ui-modal', tone !== 'default' && `ui-modal--${tone}`, icon && 'ui-modal--with-icon')}
      style={{ width }}
      onKeyDown={onKeyDown}
    >
      <div className="ui-modal__hd">
        {icon ? (
          <span className={clsx('ui-modal__icon', tone !== 'default' && `ui-modal__icon--${tone}`)} aria-hidden="true">
            <Icon name={icon} size={18} />
          </span>
        ) : null}
        <div className="ui-modal__heading">
          <h2 id={titleId} className="ui-modal__title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="ui-modal__desc">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {children ? <div className="ui-modal__bd">{children}</div> : null}
      {footer ? <div className="ui-modal__ft">{footer}</div> : null}
    </div>
  );
});

export interface DialogProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  tone?: DialogTone;
  children?: ReactNode;
  footer?: ReactNode;
  /** Default 520. */
  width?: number;
  /** While true, Escape and scrim clicks do not close. */
  busy?: boolean;
  /** Default true. */
  closeOnScrim?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.closest('[hidden]'));
}

function DialogSurface({ onClose, busy = false, closeOnScrim = true, initialFocusRef, ...panel }: Omit<DialogProps, 'open'>) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const box = useRef<HTMLDivElement | null>(null);
  const scrimDown = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const node = box.current;
    if (node) {
      const target = initialFocusRef?.current ?? focusables(node)[0] ?? node;
      target.focus({ preventScroll: true });
    }
    return () => {
      if (previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
    // Focus is taken once per opening, not again when props change.
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busyRef.current) onClose();
      return;
    }
    if (event.key !== 'Tab' || !box.current) return;
    const list = focusables(box.current);
    event.preventDefault();
    const next = trapFocusIndex(list.length, list.indexOf(document.activeElement as HTMLElement), event.shiftKey);
    (next >= 0 ? list[next] : box.current).focus();
  };

  return (
    <div
      className="ui-scrim"
      onPointerDown={(event) => {
        scrimDown.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromScrim = scrimDown.current && event.target === event.currentTarget;
        scrimDown.current = false;
        if (fromScrim && closeOnScrim && !busyRef.current) onClose();
      }}
    >
      <DialogPanel
        {...panel}
        ref={box}
        busy={busy}
        titleId={`${id}-title`}
        descriptionId={`${id}-desc`}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

/** Modal dialog with scrim, focus trap, Escape and focus restore. */
export function Dialog({ open, ...rest }: DialogProps) {
  if (!open) return null;
  return (
    <UiPortal>
      <DialogSurface {...rest} />
    </UiPortal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  tone?: DialogTone;
  icon?: IconName;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
  busy?: boolean;
  confirmVariant?: 'primary' | 'danger';
  children?: ReactNode;
  width?: number;
}

export function ConfirmDialog({
  open,
  title,
  description,
  tone = 'default',
  icon,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  busy = false,
  confirmVariant,
  children,
  width,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const variant = confirmVariant ?? (tone === 'danger' ? 'danger' : 'primary');
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      tone={tone}
      icon={icon}
      busy={busy}
      width={width}
      // Destructive confirmations start on the safe choice.
      initialFocusRef={variant === 'danger' ? cancelRef : undefined}
      footer={
        <>
          <Button ref={cancelRef} onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
