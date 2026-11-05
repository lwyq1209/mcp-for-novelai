import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';

export interface SegOption<T extends string> {
  value: T;
  label?: ReactNode;
  icon?: IconName;
  title?: string;
  ariaLabel?: string;
  disabled?: boolean;
}

export interface SegProps<T extends string> {
  value: T;
  options: Array<SegOption<T>>;
  onChange(next: T): void;
  /** Accessible name of the radiogroup. */
  label: string;
  full?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Keyboard model shared by Seg and Tabs: arrows move (wrapping) between enabled
 * options, Home/End jump to the first/last enabled one. Returns null for keys
 * that are not handled or when nothing is enabled.
 */
export function segNextValue<T extends string>(
  options: ReadonlyArray<{ value: T; disabled?: boolean }>,
  current: T,
  key: string,
): T | null {
  const enabled = options.filter((option) => !option.disabled);
  if (enabled.length === 0) return null;
  if (key === 'Home') return enabled[0].value;
  if (key === 'End') return enabled[enabled.length - 1].value;
  let delta = 0;
  if (key === 'ArrowRight' || key === 'ArrowDown') delta = 1;
  else if (key === 'ArrowLeft' || key === 'ArrowUp') delta = -1;
  else return null;
  const index = enabled.findIndex((option) => option.value === current);
  if (index < 0) return delta > 0 ? enabled[0].value : enabled[enabled.length - 1].value;
  return enabled[(index + delta + enabled.length) % enabled.length].value;
}

/** The option that owns tabindex=0: the selected one, else the first enabled one. */
export function rovingValue<T extends string>(options: ReadonlyArray<{ value: T; disabled?: boolean }>, current: T): T | null {
  const selected = options.find((option) => option.value === current && !option.disabled);
  if (selected) return selected.value;
  return options.find((option) => !option.disabled)?.value ?? null;
}

export function Seg<T extends string>({ value, options, onChange, label, full, size = 'md', className }: SegProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const focusable = rovingValue(options, value);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = segNextValue(options, value, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={clsx('ui-seg', full && 'ui-seg--full', size === 'sm' && 'ui-seg--sm', className)}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttons.current.set(option.value, node);
              else buttons.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={option.ariaLabel}
            title={option.title}
            disabled={option.disabled}
            tabIndex={option.value === focusable ? 0 : -1}
            className={clsx('ui-seg__item', checked && 'ui-seg__item--on')}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {option.icon ? <Icon name={option.icon} size={14} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
