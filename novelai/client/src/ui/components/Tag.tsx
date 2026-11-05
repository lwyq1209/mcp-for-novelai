import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';

export type TagTone = 'neutral' | 'agent' | 'accent' | 'ok' | 'warn' | 'danger';

export interface TagProps {
  tone?: TagTone;
  icon?: IconName;
  children: ReactNode;
  title?: string;
  className?: string;
}

export function Tag({ tone = 'neutral', icon, children, title, className }: TagProps) {
  return (
    <span title={title} className={clsx('ui-tag', tone !== 'neutral' && `ui-tag--${tone}`, className)}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

export interface DotProps {
  tone?: 'neutral' | 'agent' | 'ok' | 'warn' | 'danger';
  /** Pulsing cyan dot for live / running state. */
  live?: boolean;
  className?: string;
}

export function Dot({ tone = 'neutral', live = false, className }: DotProps) {
  return (
    <span
      aria-hidden="true"
      className={clsx('ui-dot', tone !== 'neutral' && `ui-dot--${tone}`, live && 'ui-dot--live', className)}
    />
  );
}
