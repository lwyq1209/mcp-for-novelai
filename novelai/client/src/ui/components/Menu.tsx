import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefCallback,
  type RefObject,
} from 'react';
import clsx from 'clsx';
import { Icon, type IconName } from '../Icon';
import { UiPortal } from '../Portal';

export type MenuEntry =
  | {
      kind?: 'item';
      id: string;
      label: ReactNode;
      hint?: ReactNode;
      icon?: IconName;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      keepOpen?: boolean;
      onSelect(): void;
    }
  | { kind: 'separator'; id: string }
  | { kind: 'heading'; id: string; label: ReactNode };

export type MenuItemEntry = Extract<MenuEntry, { onSelect(): void }>;
export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface Rect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}

export const MENU_GAP = 4;
export const VIEWPORT_MARGIN = 8;

export function isSelectableEntry(entry: MenuEntry | undefined): entry is MenuItemEntry {
  return Boolean(entry && (entry.kind === undefined || entry.kind === 'item') && !(entry as MenuItemEntry).disabled);
}

/**
 * Next selectable item index from `current`, wrapping. Pass current = -1 with
 * delta 1 for the first item and current = entries.length with delta -1 for the
 * last. Returns -1 when no item is selectable.
 */
export function nextEnabledIndex(entries: readonly MenuEntry[], current: number, delta: 1 | -1): number {
  const count = entries.length;
  if (count === 0) return -1;
  for (let step = 1; step <= count; step += 1) {
    const index = (((current + delta * step) % count) + count) % count;
    if (isSelectableEntry(entries[index])) return index;
  }
  return -1;
}

/**
 * Fixed-position coordinates for a menu of `menu` size next to `anchor`.
 * Flips to the other side vertically / horizontally when the requested side
 * does not fit, then clamps into the viewport (8px margin).
 */
export function menuPosition(
  anchor: Rect,
  menu: Size,
  viewport: Size,
  placement: MenuPlacement = 'bottom-start',
): { top: number; left: number; placement: MenuPlacement } {
  const [vertical, horizontal] = placement.split('-') as ['bottom' | 'top', 'start' | 'end'];
  const below = anchor.bottom + MENU_GAP;
  const above = anchor.top - MENU_GAP - menu.height;
  const fitsBelow = below + menu.height <= viewport.height - VIEWPORT_MARGIN;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  let v = vertical;
  if (v === 'bottom' && !fitsBelow && fitsAbove) v = 'top';
  else if (v === 'top' && !fitsAbove && fitsBelow) v = 'bottom';

  const startLeft = anchor.left;
  const endLeft = anchor.right - menu.width;
  const fitsStart = startLeft + menu.width <= viewport.width - VIEWPORT_MARGIN;
  const fitsEnd = endLeft >= VIEWPORT_MARGIN;
  let h = horizontal;
  if (h === 'start' && !fitsStart && fitsEnd) h = 'end';
  else if (h === 'end' && !fitsEnd && fitsStart) h = 'start';

  const clamp = (value: number, size: number, limit: number) =>
    Math.max(VIEWPORT_MARGIN, Math.min(value, limit - size - VIEWPORT_MARGIN));
  return {
    top: Math.round(clamp(v === 'bottom' ? below : above, menu.height, viewport.height)),
    left: Math.round(clamp(h === 'start' ? startLeft : endLeft, menu.width, viewport.width)),
    placement: `${v}-${h}` as MenuPlacement,
  };
}

export interface MenuPanelProps {
  entries: MenuEntry[];
  label: string;
  /** Highlighted item index (keyboard / hover). */
  activeIndex?: number;
  minWidth?: number;
  style?: CSSProperties;
  onActivate?(index: number): void;
  onHover?(index: number): void;
  onKeyDown?(event: KeyboardEvent<HTMLDivElement>): void;
}

/** Presentational menu surface (no positioning or focus logic). */
export const MenuPanel = forwardRef<HTMLDivElement, MenuPanelProps>(function MenuPanel(
  { entries, label, activeIndex = -1, minWidth = 240, style, onActivate, onHover, onKeyDown },
  ref,
) {
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      className="ui-menu"
      style={{ minWidth, ...style }}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) => {
        if (entry.kind === 'separator') return <hr key={entry.id} className="ui-menu__sep" role="separator" />;
        if (entry.kind === 'heading')
          return (
            <div key={entry.id} className="ui-menu__heading" role="presentation">
              {entry.label}
            </div>
          );
        const checkable = entry.checked !== undefined;
        return (
          <button
            key={entry.id}
            type="button"
            role={checkable ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checkable ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            tabIndex={-1}
            data-index={index}
            className={clsx(
              'ui-menu__item',
              entry.danger && 'ui-menu__item--danger',
              entry.disabled && 'ui-menu__item--disabled',
              index === activeIndex && 'ui-menu__item--hl',
            )}
            onClick={() => {
              if (!entry.disabled) onActivate?.(index);
            }}
            onPointerMove={() => {
              if (!entry.disabled && index !== activeIndex) onHover?.(index);
            }}
          >
            {checkable ? (
              <span className="ui-menu__check" aria-hidden="true">
                {entry.checked ? <Icon name="check" size={16} /> : null}
              </span>
            ) : entry.icon ? (
              <Icon name={entry.icon} size={16} />
            ) : null}
            <span className="ui-menu__text">
              {entry.label}
              {entry.hint ? <small>{entry.hint}</small> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
});

export interface MenuProps {
  open: boolean;
  onClose(): void;
  anchor: RefObject<HTMLElement | null>;
  entries: MenuEntry[];
  label: string;
  placement?: MenuPlacement;
  minWidth?: number;
}

function toRect(rect: DOMRect): Rect {
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

function MenuSurface({ onClose, anchor, entries, label, placement = 'bottom-start', minWidth }: Omit<MenuProps, 'open'>) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(() => nextEnabledIndex(entries, -1, 1));
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const close = useCallback(
    (restoreFocus: boolean) => {
      onCloseRef.current();
      if (restoreFocus) anchor.current?.focus();
    },
    [anchor],
  );

  const place = useCallback(() => {
    const anchorNode = anchor.current;
    const node = panel.current;
    if (!anchorNode || !node) return;
    const next = menuPosition(
      toRect(anchorNode.getBoundingClientRect()),
      { width: node.offsetWidth, height: node.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
    );
    setPosition((previous) => (previous && previous.top === next.top && previous.left === next.left ? previous : { top: next.top, left: next.left }));
  }, [anchor, placement]);

  useLayoutEffect(() => {
    place();
  }, [place, entries.length]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      close(false);
    };
    const onViewportChange = () => place();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [anchor, close, place]);

  // Keep the highlighted item focused; fall back to the menu itself.
  useEffect(() => {
    if (!position) return;
    const node = panel.current;
    if (!node) return;
    const target = active >= 0 ? node.querySelector<HTMLElement>(`[data-index="${active}"]`) : null;
    (target ?? node).focus({ preventScroll: true });
  }, [active, position]);

  const select = (index: number) => {
    const entry = entries[index];
    if (!isSelectableEntry(entry)) return;
    entry.onSelect();
    if (!entry.keepOpen) close(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        setActive((current) => nextEnabledIndex(entries, current, 1));
        break;
      case 'ArrowUp':
        setActive((current) => nextEnabledIndex(entries, current < 0 ? entries.length : current, -1));
        break;
      case 'Home':
        setActive(nextEnabledIndex(entries, -1, 1));
        break;
      case 'End':
        setActive(nextEnabledIndex(entries, entries.length, -1));
        break;
      case 'Enter':
      case ' ':
        if (active >= 0) select(active);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(true);
        break;
      default:
        return;
    }
    // Handled here: keep it from also reaching an enclosing dialog (React tree).
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <MenuPanel
      ref={panel}
      entries={entries}
      label={label}
      activeIndex={active}
      minWidth={minWidth}
      style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? undefined : 'hidden' }}
      onActivate={select}
      onHover={setActive}
      onKeyDown={onKeyDown}
    />
  );
}

/** Popup menu anchored to `anchor`, rendered in the shared portal. */
export function Menu({ open, ...rest }: MenuProps) {
  if (!open) return null;
  return (
    <UiPortal>
      <MenuSurface {...rest} />
    </UiPortal>
  );
}

export interface MenuTriggerProps {
  ref: RefCallback<HTMLElement>;
  onClick(): void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

export interface MenuButtonProps {
  entries: MenuEntry[];
  label: string;
  placement?: MenuPlacement;
  minWidth?: number;
  children: (trigger: MenuTriggerProps) => ReactNode;
}

/** Owns the open state and wires a caller-rendered trigger to a Menu. */
export function MenuButton({ entries, label, placement, minWidth, children }: MenuButtonProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const ref = useCallback<RefCallback<HTMLElement>>((node) => {
    anchor.current = node;
  }, []);
  return (
    <>
      {children({ ref, onClick: () => setOpen((value) => !value), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor} entries={entries} label={label} placement={placement} minWidth={minWidth} />
    </>
  );
}
