import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import clsx from 'clsx';
import { Icon, MenuButton, UiPortal, type IconName, type MenuEntry } from '../ui';
import { localizedDesktopOptionLabel } from '../i18n';

/**
 * Small controls of the canvas's left column (step 4b3): a section with a header, a slider with its number, a number
 * field that commits on blur or Enter (the old CommittedNumberInput rule: typing 1024 never commits 1 first), a select
 * built on the UI kit's menu, and an anchored popover. Text comes from the callers (src/ui/canvas.strings.ts).
 */

export function Section({ title, badge, actions, children, className, changed, testId }: { title?: ReactNode; badge?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; changed?: boolean; testId?: string }) {
  return <section className={clsx('cv-sec', changed && 'cv-changed', className)} data-testid={testId}>
    {title !== undefined || actions ? <div className="cv-sh"><span className="cv-sh-t">{title}{badge}</span>{actions ? <span className="cv-sh-a">{actions}</span> : null}</div> : null}
    {children}
  </section>;
}

/** A label with its value on the right, above a control. */
export function Labeled({ label, value, children, className, htmlFor }: { label: ReactNode; value?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return <div className={clsx('cv-pf', className)}>
    <div className="cv-pf-l">{htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}{value !== undefined ? <b className="ui-num">{value}</b> : null}</div>
    {children}
  </div>;
}

/** The text a committed number field shows for a value. */
const show = (value: number) => Number.isFinite(value) ? String(value) : '';

/** A number input that keeps a draft while typing and commits normalize(draft) on blur or Enter; Escape reverts. */
export function NumberField({ value, onCommit, normalize = next => next, min, max, step = 1, label, className, disabled, id, placeholder }: {
  value: number; onCommit(next: number): void; normalize?: (next: number) => number; min?: number; max?: number; step?: number; label: string; className?: string; disabled?: boolean; id?: string; placeholder?: string;
}) {
  const [draft, setDraft] = useState(show(value));
  useEffect(() => { setDraft(show(value)); }, [value]);
  const commit = () => {
    const parsed = Number(draft);
    const next = draft.trim() !== '' && Number.isFinite(parsed) ? normalize(parsed) : value;
    setDraft(show(next));
    if (next !== value) onCommit(next);
  };
  return <input id={id} className={clsx('ui-input cv-num ui-num', className)} type="number" inputMode="decimal" aria-label={label} value={draft} min={min} max={max} step={step} disabled={disabled} placeholder={placeholder}
    onChange={event => setDraft(event.target.value)} onBlur={commit}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      else if (event.key === 'Escape') { setDraft(show(value)); event.currentTarget.blur(); }
    }} />;
}

/** A range slider whose value is shown on the right of its label (and can be typed into the small field). */
export function SliderField({ label, value, min, max, step, onChange, format, testId, normalize }: {
  label: string; value: number; min: number; max: number; step: number; onChange(next: number): void; format?: (value: number) => string; testId?: string; normalize?: (next: number) => number;
}) {
  const percent = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  const clamp = normalize ?? ((next: number) => Math.min(max, Math.max(min, next)));
  return <div className="cv-pf cv-slider-field" data-testid={testId}>
    <div className="cv-pf-l"><span>{label}</span>
      <NumberField className="cv-slider-num" label={label} value={value} min={min} max={max} step={step} normalize={clamp} onCommit={onChange} />
    </div>
    <input className="cv-range" type="range" aria-label={label} aria-valuetext={format ? format(value) : undefined} min={min} max={max} step={step} value={value}
      style={{ ['--cv-fill' as string]: `${percent}%` }} onChange={event => onChange(Number(event.target.value))} />
  </div>;
}

/** "NAI Diffusion V5 Full（最新完整模型）" → name and hint, so the trigger shows the short name. */
export function splitOptionLabel(label: string): { name: string; hint: string } {
  const match = /^(.+?)\s*[\uff08(]([^\uff09)]+)[\uff09)]$/.exec(label);
  return match ? { name: match[1].trim(), hint: match[2].trim() } : { name: label, hint: '' };
}
/** A model / sampler / preset option in the interface language (the old option labels of src/i18n.ts). */
export function optionLabel(language: unknown, value: string | number, fallback: string) {
  return splitOptionLabel(localizedDesktopOptionLabel(language, value, fallback));
}

export interface SelectOption<T extends string | number> { value: T; label: string; hint?: string; disabled?: boolean }

/** A select: a button showing the chosen label, opening a menu of the options (checked one marked). */
export function Select<T extends string | number>({ value, options, onChange, label, className, disabled, testId, placement = 'bottom-start' }: {
  value: T; options: Array<SelectOption<T>>; onChange(next: T): void; label: string; className?: string; disabled?: boolean; testId?: string; placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
}) {
  const current = options.find(option => option.value === value);
  const entries: MenuEntry[] = options.map(option => ({ id: String(option.value), label: option.label, hint: option.hint, disabled: option.disabled, checked: option.value === value, onSelect: () => onChange(option.value) }));
  return <MenuButton entries={entries} label={label} placement={placement} minWidth={220}>
    {trigger => <button {...trigger} type="button" className={clsx('ui-input cv-select', className)} aria-label={label} disabled={disabled} data-testid={testId} data-value={String(value)}>
      <span>{current?.label ?? String(value)}</span><Icon name="down" size={14} />
    </button>}
  </MenuButton>;
}

/** A small ghost action in a section header. */
export function HeadAction({ icon, children, onClick, title, disabled, testId, pressed, buttonRef }: { icon?: IconName; children: ReactNode; onClick(): void; title?: string; disabled?: boolean; testId?: string; pressed?: boolean; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return <button ref={buttonRef} type="button" className={clsx('cv-hact', pressed && 'is-on')} onClick={onClick} title={title} disabled={disabled} data-testid={testId} aria-pressed={pressed}>
    {icon ? <Icon name={icon} size={13} /> : null}{children}
  </button>;
}

/**
 * A panel anchored under (or above) a trigger, in the shared portal: closes on Escape, on a pointer press outside it
 * and its trigger, and when the window is resized. Used where a menu's plain items are not enough (preview images).
 */
export function Popover({ open, onClose, anchor, children, label, width = 320, className, placement = 'bottom-start' }: {
  open: boolean; onClose(): void; anchor: RefObject<HTMLElement | null>; children: ReactNode; label: string; width?: number; className?: string; placement?: 'bottom-start' | 'bottom-end';
}) {
  if (!open) return null;
  return <UiPortal><PopoverSurface onClose={onClose} anchor={anchor} label={label} width={width} className={className} placement={placement}>{children}</PopoverSurface></UiPortal>;
}

function PopoverSurface({ onClose, anchor, children, label, width, className, placement }: { onClose(): void; anchor: RefObject<HTMLElement | null>; children: ReactNode; label: string; width: number; className?: string; placement: 'bottom-start' | 'bottom-end' }) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    const node = panel.current;
    if (!rect || !node) return;
    const margin = 8, height = node.offsetHeight;
    const below = window.innerHeight - rect.bottom - margin - 4, above = rect.top - margin - 4;
    const up = height > below && above > below;
    const maxHeight = Math.max(160, up ? above : below);
    const top = up ? Math.max(margin, rect.top - 4 - Math.min(height, maxHeight)) : rect.bottom + 4;
    const preferred = placement === 'bottom-end' ? rect.right - width : rect.left;
    const left = Math.min(Math.max(margin, preferred), window.innerWidth - width - margin);
    setPosition(previous => previous && previous.top === top && previous.left === left && previous.maxHeight === maxHeight ? previous : { top, left, maxHeight });
  }, [anchor, placement, width]);
  useLayoutEffect(() => { place(); });
  useEffect(() => {
    const down = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panel.current?.contains(target) || anchor.current?.contains(target)) return;
      closeRef.current();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); anchor.current?.focus(); } };
    const resize = () => closeRef.current();
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', resize); };
  }, [anchor]);
  return <div ref={panel} role="dialog" aria-label={label} className={clsx('cv-pop', className)}
    style={{ position: 'fixed', width, top: position?.top ?? 0, left: position?.left ?? 0, maxHeight: position?.maxHeight, visibility: position ? undefined : 'hidden' }}>
    {children}
  </div>;
}
