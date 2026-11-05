import clsx from 'clsx';

export interface ProgressProps {
  /** 0..1; values outside the range are clamped. */
  value: number;
  tone?: 'agent' | 'accent' | 'warn';
  label: string;
  className?: string;
}

export function progressPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export function Progress({ value, tone = 'agent', label, className }: ProgressProps) {
  const percent = progressPercent(value);
  return (
    <div
      className={clsx('ui-progress', tone !== 'agent' && `ui-progress--${tone}`, className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i className="ui-progress__bar" style={{ width: `${percent}%` }} />
    </div>
  );
}

export interface SpinnerProps {
  size?: number;
  /** When set the spinner is announced (role="status"); otherwise it is aria-hidden. */
  label?: string;
  /** agent = cyan (prototype); current = follows the text colour (inside buttons). */
  tone?: 'agent' | 'current';
  className?: string;
}

export function Spinner({ size = 18, label, tone = 'agent', className }: SpinnerProps) {
  const a11y = label ? { role: 'status' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span
      {...a11y}
      className={clsx('ui-spinner', tone === 'current' && 'ui-spinner--current', className)}
      style={{ width: size, height: size }}
    />
  );
}
