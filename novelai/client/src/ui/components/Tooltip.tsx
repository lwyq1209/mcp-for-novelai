import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { UiPortal } from '../Portal';
import { VIEWPORT_MARGIN, type Rect, type Size } from './Menu';

export const TOOLTIP_DELAY_MS = 300;
export const TOOLTIP_GAP = 8;

/** Centred above (top) or below (bottom) the anchor; flips and clamps into the viewport. */
export function tooltipPosition(
  anchor: Rect,
  tip: Size,
  viewport: Size,
  placement: 'top' | 'bottom' = 'top',
): { top: number; left: number; placement: 'top' | 'bottom' } {
  const above = anchor.top - TOOLTIP_GAP - tip.height;
  const below = anchor.bottom + TOOLTIP_GAP;
  const fitsAbove = above >= VIEWPORT_MARGIN;
  const fitsBelow = below + tip.height <= viewport.height - VIEWPORT_MARGIN;
  let side = placement;
  if (side === 'top' && !fitsAbove && fitsBelow) side = 'bottom';
  else if (side === 'bottom' && !fitsBelow && fitsAbove) side = 'top';
  const centred = anchor.left + anchor.width / 2 - tip.width / 2;
  const left = Math.max(VIEWPORT_MARGIN, Math.min(centred, viewport.width - tip.width - VIEWPORT_MARGIN));
  return { top: Math.round(side === 'top' ? above : below), left: Math.round(left), placement: side };
}

type TriggerProps = {
  'aria-describedby'?: string;
  onPointerEnter?(event: PointerEvent<HTMLElement>): void;
  onPointerLeave?(event: PointerEvent<HTMLElement>): void;
  onFocus?(event: FocusEvent<HTMLElement>): void;
  onBlur?(event: FocusEvent<HTMLElement>): void;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void;
};

export interface TooltipProps {
  content: ReactNode;
  children: ReactElement;
  placement?: 'top' | 'bottom';
  /** No bubble and no description now; the trigger keeps its place in the tree (no remount when this changes). */
  disabled?: boolean;
}

function TooltipBubble({ anchor, content, placement }: { anchor: HTMLElement; content: ReactNode; placement: 'top' | 'bottom' }) {
  const node = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const tip = node.current;
    if (!tip) return;
    const rect = anchor.getBoundingClientRect();
    const next = tooltipPosition(
      { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
    );
    setPosition({ top: next.top, left: next.left });
  }, [anchor, placement]);
  return (
    <div
      ref={node}
      role="tooltip"
      className="ui-tip"
      style={{ position: 'fixed', top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? undefined : 'hidden' }}
    >
      {content}
    </div>
  );
}

/**
 * Shows `content` after hovering or focusing the child for 300ms; Escape hides
 * it. The child is described by a hidden copy of the content, so the
 * description is available as soon as it receives focus.
 */
export function Tooltip({ content, children, placement = 'top', disabled = false }: TooltipProps) {
  const descriptionId = `ui-tip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);
  const show = (element: HTMLElement) => {
    clear();
    if (disabled) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setAnchor(element);
    }, TOOLTIP_DELAY_MS);
  };
  const hide = () => {
    clear();
    setAnchor(null);
  };
  useEffect(() => clear, [clear]);
  useEffect(() => { if (disabled) { clear(); setAnchor(null); } }, [disabled, clear]);

  if (!isValidElement(children)) return children;
  const child = children as ReactElement<TriggerProps>;
  const own = child.props;
  const describedBy = [own['aria-describedby'], disabled ? '' : descriptionId].filter(Boolean).join(' ') || undefined;

  const trigger = cloneElement(child, {
    'aria-describedby': describedBy,
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      show(event.currentTarget);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      own.onPointerLeave?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      show(event.currentTarget);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      own.onBlur?.(event);
      hide();
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      own.onKeyDown?.(event);
      if (event.key !== 'Escape') return;
      const wasOpen = anchor !== null;
      hide();
      // Escape that dismissed a visible tooltip does not also close an enclosing dialog.
      if (wasOpen) event.stopPropagation();
    },
  });

  return (
    <>
      {trigger}
      <span id={descriptionId} hidden>
        {disabled ? null : content}
      </span>
      {anchor && !disabled ? (
        <UiPortal>
          <TooltipBubble anchor={anchor} content={content} placement={placement} />
        </UiPortal>
      ) : null}
    </>
  );
}
