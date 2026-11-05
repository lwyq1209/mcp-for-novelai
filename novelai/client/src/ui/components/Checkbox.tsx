import clsx from 'clsx';
import { Icon } from '../Icon';

export interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange(next: boolean): void;
  /** Accessible name of the checkbox. */
  label: string;
  /** overlay: on top of thumbnails; plain: on panel backgrounds. */
  variant?: 'plain' | 'overlay';
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Checkbox({ checked, indeterminate = false, onChange, label, variant = 'plain', disabled, className, id }: CheckboxProps) {
  const mixed = indeterminate && !checked;
  const on = checked || mixed;
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={mixed ? 'mixed' : checked}
      aria-label={label}
      disabled={disabled}
      className={clsx('ui-check', variant === 'plain' && 'ui-check--plain', on && 'ui-check--on', className)}
      onClick={(event) => {
        // Keep the click from also activating an enclosing card or tile.
        event.stopPropagation();
        onChange(mixed ? true : !checked);
      }}
    >
      {checked ? <Icon name="check" size={12} /> : mixed ? <Icon name="minus" size={12} /> : null}
    </button>
  );
}
