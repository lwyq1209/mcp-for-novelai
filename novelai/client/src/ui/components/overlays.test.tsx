import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRef } from 'react';
import { Menu, MenuButton, MenuPanel, menuPosition, nextEnabledIndex, type MenuEntry } from './Menu';
import { ConfirmDialog, Dialog, DialogPanel, trapFocusIndex } from './Dialog';
import { DEFAULT_TOAST_MS, dismissToast, getToasts, showToast, ToastHost, ToastView } from './Toast';
import { Tooltip, tooltipPosition } from './Tooltip';
import { UiPortal, uiPortalRoot } from '../Portal';

const noop = () => {};

describe('UiPortal', () => {
  it('renders nothing on the server and has no document root there', () => {
    expect(renderToStaticMarkup(<UiPortal><div>overlay</div></UiPortal>)).toBe('');
    expect(uiPortalRoot()).toBeNull();
  });
});

describe('Menu', () => {
  const entries: MenuEntry[] = [
    { kind: 'heading', id: 'h', label: 'Move to' },
    { id: 'a', label: 'Open', icon: 'external', hint: 'In canvas', onSelect: noop },
    { id: 'b', label: 'Locked', disabled: true, onSelect: noop },
    { kind: 'separator', id: 's' },
    { id: 'c', label: 'Show archived', checked: true, keepOpen: true, onSelect: noop },
    { id: 'd', label: 'Delete', icon: 'trash', danger: true, onSelect: noop },
  ];

  it('MenuPanel renders roles, hints, checked items, separators and headings', () => {
    const out = renderToStaticMarkup(<MenuPanel entries={entries} label="Image actions" activeIndex={1} />);
    expect(out).toContain('role="menu"');
    expect(out).toContain('aria-label="Image actions"');
    expect(out).toContain('min-width:240px');
    expect(out.match(/role="menuitem"/g)).toHaveLength(3);
    expect(out).toContain('role="menuitemcheckbox" aria-checked="true"');
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('ui-menu__item--danger');
    expect(out).toContain('ui-menu__item ui-menu__item--hl');
    expect(out).toContain('<small>In canvas</small>');
    expect(out).toContain('<hr class="ui-menu__sep" role="separator"/>');
    expect(out).toContain('<div class="ui-menu__heading" role="presentation">Move to</div>');
    expect(out.match(/tabindex="-1"/g)?.length).toBe(5);
  });

  it('Menu renders nothing when closed and nothing on the server when open', () => {
    const anchor = createRef<HTMLElement>();
    expect(renderToStaticMarkup(<Menu open={false} onClose={noop} anchor={anchor} entries={entries} label="m" />)).toBe('');
    expect(renderToStaticMarkup(<Menu open onClose={noop} anchor={anchor} entries={entries} label="m" />)).toBe('');
  });

  it('MenuButton hands popup attributes to the trigger', () => {
    const out = renderToStaticMarkup(
      <MenuButton entries={entries} label="More">
        {(trigger) => (
          <button type="button" aria-haspopup={trigger['aria-haspopup']} aria-expanded={trigger['aria-expanded']} onClick={trigger.onClick}>
            More
          </button>
        )}
      </MenuButton>,
    );
    expect(out).toBe('<button type="button" aria-haspopup="menu" aria-expanded="false">More</button>');
  });

  it('nextEnabledIndex moves only between selectable items and wraps', () => {
    expect(nextEnabledIndex(entries, -1, 1)).toBe(1);
    expect(nextEnabledIndex(entries, 1, 1)).toBe(4);
    expect(nextEnabledIndex(entries, 4, 1)).toBe(5);
    expect(nextEnabledIndex(entries, 5, 1)).toBe(1);
    expect(nextEnabledIndex(entries, 1, -1)).toBe(5);
    expect(nextEnabledIndex(entries, 4, -1)).toBe(1);
    expect(nextEnabledIndex(entries, entries.length, -1)).toBe(5);
  });

  it('nextEnabledIndex returns -1 without selectable items', () => {
    expect(nextEnabledIndex([], -1, 1)).toBe(-1);
    expect(nextEnabledIndex([{ kind: 'separator', id: 's' }, { id: 'x', label: 'x', disabled: true, onSelect: noop }], -1, 1)).toBe(-1);
    expect(nextEnabledIndex([{ id: 'x', label: 'x', onSelect: noop }], 0, 1)).toBe(0);
  });

  const viewport = { width: 1200, height: 800 };
  const rect = (left: number, top: number, width = 80, height = 30) => ({ left, top, width, height, right: left + width, bottom: top + height });
  const menu = { width: 240, height: 200 };

  it('menuPosition places below-start by default with a 4px gap', () => {
    expect(menuPosition(rect(100, 100), menu, viewport)).toEqual({ top: 134, left: 100, placement: 'bottom-start' });
    expect(menuPosition(rect(400, 100), menu, viewport, 'bottom-end')).toEqual({ top: 134, left: 240, placement: 'bottom-end' });
    expect(menuPosition(rect(400, 500), menu, viewport, 'top-start')).toEqual({ top: 296, left: 400, placement: 'top-start' });
  });

  it('menuPosition flips vertically and horizontally when a side does not fit', () => {
    expect(menuPosition(rect(100, 700), menu, viewport).placement).toBe('top-start');
    expect(menuPosition(rect(100, 700), menu, viewport).top).toBe(496);
    expect(menuPosition(rect(100, 20), menu, viewport, 'top-start').placement).toBe('bottom-start');
    expect(menuPosition(rect(1100, 100), menu, viewport)).toEqual({ top: 134, left: 940, placement: 'bottom-end' });
    expect(menuPosition(rect(20, 100), menu, viewport, 'bottom-end')).toEqual({ top: 134, left: 20, placement: 'bottom-start' });
  });

  it('menuPosition clamps into the viewport when neither side fits', () => {
    const tall = { width: 240, height: 780 };
    const placed = menuPosition(rect(100, 400), tall, viewport);
    expect(placed.placement).toBe('bottom-start');
    expect(placed.top).toBe(12);
    expect(menuPosition(rect(100, 400), { width: 240, height: 790 }, viewport).top).toBe(8);
    const wide = menuPosition(rect(500, 100), { width: 1190, height: 100 }, viewport);
    expect(wide.left).toBe(8);
  });
});

describe('Dialog', () => {
  it('DialogPanel renders an accessible modal with icon block, body and footer', () => {
    const out = renderToStaticMarkup(
      <DialogPanel title="Delete 3 images?" description="They move to Recently deleted." icon="trash" tone="danger" titleId="t" descriptionId="d" footer={<button type="button">OK</button>}>
        <p>Body</p>
      </DialogPanel>,
    );
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby="t"');
    expect(out).toContain('aria-describedby="d"');
    expect(out).toContain('class="ui-modal ui-modal--danger ui-modal--with-icon"');
    expect(out).toContain('width:520px');
    expect(out).toContain('<span class="ui-modal__icon ui-modal__icon--danger" aria-hidden="true">');
    expect(out).toContain('<h2 id="t" class="ui-modal__title">Delete 3 images?</h2>');
    expect(out).toContain('<p id="d" class="ui-modal__desc">They move to Recently deleted.</p>');
    expect(out).toContain('<div class="ui-modal__bd"><p>Body</p></div>');
    expect(out).toContain('<div class="ui-modal__ft"><button type="button">OK</button></div>');
  });

  it('DialogPanel omits description, icon and empty sections', () => {
    const out = renderToStaticMarkup(<DialogPanel title="Plain" titleId="t" descriptionId="d" width={640} busy />);
    expect(out).not.toContain('aria-describedby');
    expect(out).not.toContain('ui-modal__icon');
    expect(out).not.toContain('ui-modal__bd');
    expect(out).not.toContain('ui-modal__ft');
    expect(out).toContain('width:640px');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('class="ui-modal"');
  });

  it('Dialog and ConfirmDialog are portal-only (empty on the server)', () => {
    expect(renderToStaticMarkup(<Dialog open onClose={noop} title="x" />)).toBe('');
    expect(renderToStaticMarkup(<ConfirmDialog open title="x" confirmLabel="Yes" cancelLabel="No" onConfirm={noop} onCancel={noop} />)).toBe('');
  });

  it('trapFocusIndex cycles in both directions and enters from outside', () => {
    expect(trapFocusIndex(3, 0, false)).toBe(1);
    expect(trapFocusIndex(3, 2, false)).toBe(0);
    expect(trapFocusIndex(3, 0, true)).toBe(2);
    expect(trapFocusIndex(3, 1, true)).toBe(0);
    expect(trapFocusIndex(3, -1, false)).toBe(0);
    expect(trapFocusIndex(3, -1, true)).toBe(2);
    expect(trapFocusIndex(3, 7, false)).toBe(0);
    expect(trapFocusIndex(1, 0, false)).toBe(0);
    expect(trapFocusIndex(1, 0, true)).toBe(0);
    expect(trapFocusIndex(0, -1, false)).toBe(-1);
    expect(trapFocusIndex(0, 0, true)).toBe(-1);
  });
});

describe('Toast store', () => {
  afterEach(() => {
    for (const toast of getToasts()) dismissToast(toast.id);
    vi.useRealTimers();
  });

  it('auto-dismisses after the default duration', () => {
    vi.useFakeTimers();
    const id = showToast({ message: 'Saved' });
    expect(getToasts()).toEqual([{ id, message: 'Saved', tone: 'neutral', action: undefined, durationMs: DEFAULT_TOAST_MS }]);
    expect(Object.hasOwn(getToasts()[0], 'key')).toBe(false);
    vi.advanceTimersByTime(DEFAULT_TOAST_MS - 1);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it('honours custom durations, keeps durationMs 0 open and stacks in order', () => {
    vi.useFakeTimers();
    const sticky = showToast({ message: 'Failed', tone: 'danger', durationMs: 0 });
    const quick = showToast({ message: 'Copied', tone: 'ok', durationMs: 1000 });
    expect(sticky).not.toBe(quick);
    expect(getToasts().map((toast) => toast.id)).toEqual([sticky, quick]);
    vi.advanceTimersByTime(1000);
    expect(getToasts().map((toast) => toast.id)).toEqual([sticky]);
    vi.advanceTimersByTime(60_000);
    expect(getToasts().map((toast) => toast.id)).toEqual([sticky]);
  });

  it('a toast under the same key replaces the shown one in place, with a fresh timer (step 4b2)', () => {
    vi.useFakeTimers();
    const other = showToast({ message: 'Other' });
    const placeholder = showToast({ message: 'Actual cost updating', key: 'manual-settled:b1', durationMs: 0 });
    vi.advanceTimersByTime(10_000);
    const result = showToast({ message: 'Done, spent 0 Anlas', tone: 'ok', key: 'manual-settled:b1' });
    expect(result).toBe(placeholder);
    expect(getToasts().map((toast) => [toast.id, toast.message])).toEqual([[placeholder, 'Done, spent 0 Anlas']]);
    expect(getToasts().find((toast) => toast.id === other)).toBeUndefined(); // the unkeyed one timed out meanwhile
    vi.advanceTimersByTime(DEFAULT_TOAST_MS - 1);
    expect(getToasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
    // Another key, or a key whose toast was dismissed, stacks a new one.
    const a = showToast({ message: 'A', key: 'k1' }), b = showToast({ message: 'B', key: 'k2' });
    expect(a).not.toBe(b);
    dismissToast(a);
    expect(showToast({ message: 'A again', key: 'k1' })).not.toBe(a);
    expect(getToasts().map((toast) => toast.message)).toEqual(['B', 'A again']);
  });

  it('manual dismissal removes the toast and cancels its timer', () => {
    vi.useFakeTimers();
    const id = showToast({ message: 'Moved', durationMs: 2000 });
    expect(vi.getTimerCount()).toBe(1);
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    dismissToast(id);
    dismissToast('unknown');
    expect(getToasts()).toHaveLength(0);
  });

  it('ToastView uses status / alert roles, tone icons, action and close label', () => {
    const status = renderToStaticMarkup(
      <ToastView toast={{ id: 't1', message: 'Moved 3 images', tone: 'ok', durationMs: 0, action: { label: 'Undo', onClick: noop } }} closeLabel="Close" onDismiss={noop} />,
    );
    expect(status).toContain('role="status"');
    expect(status).toContain('class="ui-toast ui-toast--ok"');
    expect(status).toContain('ui-toast__icon');
    expect(status).toContain('>Undo</button>');
    expect(status).toContain('aria-label="Close"');
    const alert = renderToStaticMarkup(<ToastView toast={{ id: 't2', message: 'Failed', tone: 'danger', durationMs: 0 }} closeLabel="Close" onDismiss={noop} />);
    expect(alert).toContain('role="alert"');
    const neutral = renderToStaticMarkup(<ToastView toast={{ id: 't3', message: 'Hi', tone: 'neutral', durationMs: 0 }} closeLabel="Close" onDismiss={noop} />);
    expect(neutral).toContain('class="ui-toast"');
    expect(neutral).not.toContain('ui-toast__icon');
  });

  it('a language-bound toast text and action label are drawn in the language of each render (step 4c1)', () => {
    const toast = { id: 't4', message: (lang: 'zh' | 'en') => lang === 'zh' ? '已删除' : 'Deleted', tone: 'ok' as const, durationMs: 0, action: { label: (lang: 'zh' | 'en') => lang === 'zh' ? '撤销' : 'Undo', onClick: noop } };
    const zh = renderToStaticMarkup(<ToastView toast={toast} closeLabel="关闭" onDismiss={noop} lang="zh" />);
    const en = renderToStaticMarkup(<ToastView toast={toast} closeLabel="Close" onDismiss={noop} lang="en" />);
    expect(zh).toContain('已删除'); expect(zh).toContain('>撤销</button>');
    expect(en).toContain('Deleted'); expect(en).toContain('>Undo</button>'); expect(en).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('ToastHost renders nothing on the server', () => {
    expect(renderToStaticMarkup(<ToastHost closeLabel="Close" />)).toBe('');
  });
});

describe('Tooltip', () => {
  it('describes the child by a hidden copy and keeps the child attributes', () => {
    const out = renderToStaticMarkup(
      <Tooltip content="Copies the prompt">
        <button type="button" aria-describedby="own" className="b">Copy</button>
      </Tooltip>,
    );
    const id = out.match(/aria-describedby="own ([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain('class="b"');
    expect(out).toContain(`<span id="${id}" hidden="">Copies the prompt</span>`);
    expect(out).not.toContain('role="tooltip"');
  });

  it('tooltipPosition centres above, flips below and clamps horizontally', () => {
    const viewport = { width: 1000, height: 700 };
    const anchor = { left: 480, top: 300, width: 40, height: 30, right: 520, bottom: 330 };
    expect(tooltipPosition(anchor, { width: 200, height: 40 }, viewport)).toEqual({ top: 252, left: 400, placement: 'top' });
    expect(tooltipPosition(anchor, { width: 200, height: 40 }, viewport, 'bottom')).toEqual({ top: 338, left: 400, placement: 'bottom' });
    const nearTop = { ...anchor, top: 10, bottom: 40 };
    expect(tooltipPosition(nearTop, { width: 200, height: 40 }, viewport).placement).toBe('bottom');
    const nearLeft = { ...anchor, left: 0, right: 40 };
    expect(tooltipPosition(nearLeft, { width: 200, height: 40 }, viewport).left).toBe(8);
    const nearRight = { ...anchor, left: 980, right: 1000 };
    expect(tooltipPosition(nearRight, { width: 200, height: 40 }, viewport).left).toBe(792);
  });
});
