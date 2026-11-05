import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';

export interface EmptyStateProps {
  icon: IconName;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, body, action, className }: EmptyStateProps) {
  return (
    <div className={clsx('ui-empty', className)}>
      <div className="ui-empty__icon" aria-hidden="true">
        <Icon name={icon} size={24} />
      </div>
      <h4 className="ui-empty__title">{title}</h4>
      {body ? <p className="ui-empty__body">{body}</p> : null}
      {action ? <div className="ui-empty__action">{action}</div> : null}
    </div>
  );
}
