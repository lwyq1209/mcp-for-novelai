import {
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import clsx from 'clsx';
import { Icon } from '../Icon';
import { Kbd } from './Kbd';

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** id of the control; generated when omitted and the child has no id. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

type ControlProps = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' };

/**
 * Label + control + hint/error. A single element child receives the id,
 * aria-describedby (hint and error) and aria-invalid when there is an error.
 */
export function Field({ label, hint, error, htmlFor, children, className }: FieldProps) {
  const generated = useId();
  const child = isValidElement(children) ? (children as ReactElement<ControlProps>) : null;
  const controlId = htmlFor ?? child?.props.id ?? `ui-field-${generated.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [child?.props['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  const control = child
    ? cloneElement(child, {
        id: controlId,
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children;
  return (
    <div className={clsx('ui-field', className)}>
      <label className="ui-field__label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint ? (
        <div className="ui-field__hint" id={hintId}>
          {hint}
        </div>
      ) : null}
      {error ? (
        <div className="ui-field__error" id={errorId}>
          <Icon name="alert" size={12} />
          {error}
        </div>
      ) : null}
    </div>
  );
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { invalid, className, type = 'text', ...rest },
  ref,
) {
  return (
    <input
      aria-invalid={invalid || undefined}
      {...rest}
      ref={ref}
      type={type}
      className={clsx('ui-input', invalid && 'ui-input--invalid', className)}
    />
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { invalid, className, ...rest },
  ref,
) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      {...rest}
      ref={ref}
      className={clsx('ui-input', 'ui-textarea', invalid && 'ui-input--invalid', className)}
    />
  );
});

export interface SearchInputProps {
  value: string;
  onChange(text: string): void;
  placeholder: string;
  /** Accessible name of the search box. */
  label: string;
  /** Keyboard hint shown while the box is empty, e.g. '⌘K'. */
  shortcut?: string;
  /** Clear action; defaults to onChange(''). The clear button needs clearLabel. */
  onClear?(): void;
  clearLabel?: string;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
  id?: string;
}

export function SearchInput({ value, onChange, placeholder, label, shortcut, onClear, clearLabel, inputRef, className, id }: SearchInputProps) {
  const clear = () => (onClear ? onClear() : onChange(''));
  const showClear = value.length > 0 && Boolean(clearLabel);
  return (
    <div className={clsx('ui-search', className)}>
      <Icon name="search" size={16} className="ui-search__icon" />
      <input
        ref={inputRef}
        id={id}
        type="search"
        role="searchbox"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        autoComplete="off"
        spellCheck={false}
        className="ui-input ui-search__input"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value.length > 0) {
            event.preventDefault();
            event.stopPropagation();
            clear();
          }
        }}
      />
      {showClear ? (
        <button type="button" className="ui-search__clear" aria-label={clearLabel} title={clearLabel} onClick={clear}>
          <Icon name="x" size={14} />
        </button>
      ) : shortcut && value.length === 0 ? (
        <Kbd className="ui-search__kbd">{shortcut}</Kbd>
      ) : null}
    </div>
  );
}
