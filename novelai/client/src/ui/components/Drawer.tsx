import { useEffect, useRef, type ReactNode } from 'react';
import clsx from 'clsx';
import { IconButton } from './Button';

export interface DrawerProps {
  title: ReactNode;
  onClose(): void;
  closeLabel: string;
  /** Extra header buttons, placed before the close button. */
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Default 420. */
  width?: number;
  /** Accessible name of the panel; defaults to the title when it is a string. */
  label?: string;
  className?: string;
}

/**
 * In-page right-hand panel (not an overlay); the parent places it in a flex row. When it opens it takes the focus
 * (the panel itself, so the reader starts at its title); when it closes the focus goes back to where it was (the tile
 * that opened it), unless the user has moved it elsewhere meanwhile.
 */
export function Drawer({ title, onClose, closeLabel, actions, children, footer, width = 420, label, className }: DrawerProps) {
  const name = label ?? (typeof title === 'string' ? title : undefined);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !active.isConnected || !!panel.current?.contains(active);
      if (lost && previous && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <aside ref={panel} tabIndex={-1} className={clsx('ui-drawer', className)} style={{ width }} aria-label={name}>
      <div className="ui-drawer__head">
        <h2 className="ui-drawer__title">{title}</h2>
        {actions}
        <IconButton icon="x" label={closeLabel} onClick={onClose} />
      </div>
      <div className="ui-drawer__body">{children}</div>
      {footer ? <div className="ui-drawer__foot">{footer}</div> : null}
    </aside>
  );
}
