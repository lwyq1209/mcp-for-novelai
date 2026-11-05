import clsx from 'clsx';

export interface ToggleProps {
  checked: boolean;
  onChange(next: boolean): void;
  /** Accessible name of the switch. */
  label: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Toggle({ checked, onChange, label, disabled, className, id }: ToggleProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={clsx('ui-toggle', checked && 'ui-toggle--on', className)}
      onClick={() => onChange(!checked)}
    />
  );
}
