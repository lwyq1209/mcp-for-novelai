import { useId, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon } from '../Icon';

export interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}

/** Button-driven collapsible section (replaces details.tech of the prototype). */
export function Disclosure({ summary, children, defaultOpen = false, className }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = `ui-disclosure-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className={clsx('ui-disclosure', open && 'ui-disclosure--open', className)}>
      <button
        type="button"
        className="ui-disclosure__summary"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="right" size={14} className="ui-disclosure__caret" />
        {summary}
      </button>
      <div id={regionId} className="ui-disclosure__body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
