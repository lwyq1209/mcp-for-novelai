import { forwardRef, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';
import { Spinner } from './Progress';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'dangerGhost' | 'ghost' | 'agent';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconAfter?: IconName;
  block?: boolean;
  /** Shows a spinner, sets aria-busy and disables the button. */
  busy?: boolean;
  /**
   * Off for a moment but keeps the keyboard focus (no native disabled, which drops focus to the page): aria-disabled,
   * the off look, and clicks (pointer, Enter, Space) do nothing. busy with softDisabled stays focusable the same way.
   */
  softDisabled?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string | null> = {
  default: null,
  primary: 'ui-btn--primary',
  danger: 'ui-btn--danger',
  dangerGhost: 'ui-btn--danger-ghost',
  ghost: 'ui-btn--ghost',
  agent: 'ui-btn--agent',
};

const iconSize = (size: ButtonSize) => (size === 'sm' ? 14 : size === 'lg' ? 18 : 16);

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, iconAfter, block, busy = false, softDisabled = false, className, type = 'button', disabled, children, onClick, ...rest },
  ref,
) {
  const glyph = iconSize(size);
  // A soft-disabled button keeps its focus: it is not natively disabled, it only ignores activation. A real
  // disabled wins (lasting states such as no token).
  const inert = softDisabled && !disabled;
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled || (busy && !inert)}
      aria-disabled={inert || undefined}
      aria-busy={busy || undefined}
      onClick={inert ? (event) => { event.preventDefault(); event.stopPropagation(); } : onClick}
      className={clsx(
        'ui-btn',
        VARIANT_CLASS[variant],
        size !== 'md' && `ui-btn--${size}`,
        block && 'ui-btn--block',
        busy && 'ui-btn--busy',
        inert && 'ui-btn--off',
        className,
      )}
    >
      {busy ? <Spinner size={glyph} tone="current" /> : icon ? <Icon name={icon} size={glyph} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} size={glyph} /> : null}
    </button>
  );
});

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconName;
  /** Used as both aria-label and title. */
  label: string;
  size?: 'sm' | 'md';
  /** Toggle state; sets aria-pressed. */
  active?: boolean;
  tone?: 'plain' | 'overlay';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, size = 'md', active, tone = 'plain', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      className={clsx(
        'ui-iconbtn',
        size === 'sm' && 'ui-iconbtn--sm',
        tone === 'overlay' && 'ui-iconbtn--overlay',
        active && 'ui-iconbtn--on',
        className,
      )}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  );
});
