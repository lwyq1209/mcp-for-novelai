import { forwardRef, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  icon?: IconName;
  /** Shows a trailing down caret (filter chips that open a menu). */
  caret?: boolean;
  count?: number;
}

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active = false, icon, caret, count, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={clsx('ui-chip', active && 'ui-chip--on', className)}
    >
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
      {count !== undefined ? <span className="ui-chip__count ui-num">{count}</span> : null}
      {caret ? <Icon name="down" size={14} className="ui-chip__caret" /> : null}
    </button>
  );
});
