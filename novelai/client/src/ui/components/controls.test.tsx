import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { Button, IconButton } from './Button';
import { Seg, rovingValue, segNextValue } from './Seg';
import { Chip } from './Chip';
import { Dot, Tag } from './Tag';
import { Toggle } from './Toggle';
import { Checkbox } from './Checkbox';
import { Kbd } from './Kbd';
import { Progress, Spinner, progressPercent } from './Progress';

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe('Button', () => {
  it('defaults to a type=button md default button', () => {
    const out = html(<Button>Save</Button>);
    expect(out).toBe('<button type="button" class="ui-btn">Save</button>');
  });
  it('maps variants, sizes and block to modifier classes', () => {
    expect(html(<Button variant="primary">a</Button>)).toContain('class="ui-btn ui-btn--primary"');
    expect(html(<Button variant="danger">a</Button>)).toContain('ui-btn--danger"');
    expect(html(<Button variant="dangerGhost">a</Button>)).toContain('ui-btn--danger-ghost');
    expect(html(<Button variant="ghost">a</Button>)).toContain('ui-btn--ghost');
    expect(html(<Button variant="agent">a</Button>)).toContain('ui-btn--agent');
    expect(html(<Button size="sm">a</Button>)).toContain('ui-btn--sm');
    expect(html(<Button size="lg" block>a</Button>)).toContain('class="ui-btn ui-btn--lg ui-btn--block"');
  });
  it('renders leading and trailing icons and passes other attributes through', () => {
    const out = html(<Button icon="plus" iconAfter="down" type="submit" title="t" data-x="1" className="mine">Add</Button>);
    expect(out).toContain('type="submit"');
    expect(out).toContain('title="t"');
    expect(out).toContain('data-x="1"');
    expect(out).toContain('mine');
    expect(out.match(/class="ui-glyph"/g)).toHaveLength(2);
    expect(out.indexOf('<svg')).toBeLessThan(out.indexOf('Add'));
    expect(out.lastIndexOf('<svg')).toBeGreaterThan(out.indexOf('Add'));
  });
  it('busy shows a spinner instead of the icon, disables and sets aria-busy', () => {
    const out = html(<Button busy icon="plus">Run</Button>);
    expect(out).toContain('disabled=""');
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain('ui-spinner');
    expect(out).not.toContain('ui-glyph');
    expect(html(<Button>Run</Button>)).not.toContain('aria-busy');
  });
  it('softDisabled keeps the focus: aria-disabled and the off look, no native disabled, activation ignored', () => {
    const onClick = vi.fn();
    const out = html(<Button softDisabled onClick={onClick}>Pause</Button>);
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain('ui-btn--off');
    expect(out).not.toMatch(/\sdisabled=""/);
    // busy with softDisabled stays focusable too; a real disabled wins over softDisabled.
    const busy = html(<Button busy softDisabled>Pause</Button>);
    expect(busy).not.toMatch(/\sdisabled=""/);
    expect(busy).toContain('aria-busy="true"');
    expect(html(<Button disabled softDisabled>Pause</Button>)).toContain('disabled=""');
    // The click handler the button gets ignores activation (pointer, Enter and Space all fire click on a button).
    const element = (Button as unknown as { render: (props: object, ref: null) => ReactElement<{ onClick(event: unknown): void }> }).render({ softDisabled: true, onClick, children: 'x' }, null);
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    element.props.onClick(event);
    expect(onClick).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe('IconButton', () => {
  it('uses label as aria-label and title', () => {
    const out = html(<IconButton icon="x" label="Close" />);
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Close"');
    expect(out).toContain('title="Close"');
    expect(out).toContain('class="ui-iconbtn"');
    expect(out).not.toContain('aria-pressed');
  });
  it('reflects active, size and overlay tone', () => {
    const out = html(<IconButton icon="star" label="Favourite" active size="sm" tone="overlay" />);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('ui-iconbtn--sm');
    expect(out).toContain('ui-iconbtn--overlay');
    expect(out).toContain('ui-iconbtn--on');
    expect(html(<IconButton icon="star" label="Favourite" active={false} />)).toContain('aria-pressed="false"');
  });
});

describe('Seg', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B', disabled: true },
    { value: 'c', label: 'C' },
    { value: 'd', icon: 'grid' as const, ariaLabel: 'Grid', title: 'Grid view' },
  ];
  it('renders a labelled radiogroup with one checked radio and roving tabindex', () => {
    const out = html(<Seg value="c" options={options} onChange={() => {}} label="View" full size="sm" />);
    expect(out).toContain('role="radiogroup"');
    expect(out).toContain('aria-label="View"');
    expect(out).toContain('ui-seg ui-seg--full ui-seg--sm');
    expect(out.match(/role="radio"/g)).toHaveLength(4);
    expect(out.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(out).toMatch(/aria-checked="true" tabindex="0" class="ui-seg__item ui-seg__item--on">C/);
    expect(out.match(/tabindex="0"/g)).toHaveLength(1);
    expect(out).toContain('aria-label="Grid" title="Grid view"');
    expect(out).toMatch(/disabled="" tabindex="-1"/);
  });
  it('segNextValue skips disabled options and wraps', () => {
    expect(segNextValue(options, 'a', 'ArrowRight')).toBe('c');
    expect(segNextValue(options, 'c', 'ArrowLeft')).toBe('a');
    expect(segNextValue(options, 'a', 'ArrowLeft')).toBe('d');
    expect(segNextValue(options, 'd', 'ArrowRight')).toBe('a');
    expect(segNextValue(options, 'a', 'ArrowDown')).toBe('c');
    expect(segNextValue(options, 'c', 'ArrowUp')).toBe('a');
    expect(segNextValue(options, 'c', 'Home')).toBe('a');
    expect(segNextValue(options, 'a', 'End')).toBe('d');
  });
  it('segNextValue handles unknown keys, missing current and all-disabled lists', () => {
    expect(segNextValue(options, 'a', 'Enter')).toBeNull();
    expect(segNextValue(options, 'b', 'ArrowRight')).toBe('a');
    expect(segNextValue(options, 'zz' as string, 'ArrowLeft')).toBe('d');
    expect(segNextValue([{ value: 'x', disabled: true }], 'x', 'ArrowRight')).toBeNull();
    expect(segNextValue([], 'x', 'Home')).toBeNull();
    expect(segNextValue([{ value: 'only' }], 'only', 'ArrowRight')).toBe('only');
  });
  it('rovingValue falls back to the first enabled option', () => {
    expect(rovingValue(options, 'c')).toBe('c');
    expect(rovingValue(options, 'b')).toBe('a');
    expect(rovingValue([{ value: 'x', disabled: true }], 'x')).toBeNull();
  });
});

describe('Chip', () => {
  it('renders active state, count and caret', () => {
    const out = html(<Chip active icon="filter" count={12} caret>Model</Chip>);
    expect(out).toContain('type="button"');
    expect(out).toContain('class="ui-chip ui-chip--on"');
    expect(out).toContain('<span class="ui-chip__count ui-num">12</span>');
    expect(out).toContain('ui-chip__caret');
    expect(html(<Chip>Plain</Chip>)).toBe('<button type="button" class="ui-chip">Plain</button>');
  });
});

describe('Tag and Dot', () => {
  it('renders tones as modifiers', () => {
    expect(html(<Tag>v5</Tag>)).toBe('<span class="ui-tag">v5</span>');
    for (const tone of ['agent', 'accent', 'ok', 'warn', 'danger'] as const) {
      expect(html(<Tag tone={tone}>x</Tag>)).toContain(`class="ui-tag ui-tag--${tone}"`);
    }
    const out = html(<Tag tone="agent" icon="agent" title="From agent">Agent</Tag>);
    expect(out).toContain('title="From agent"');
    expect(out).toContain('ui-glyph');
  });
  it('dot is decorative and can pulse', () => {
    expect(html(<Dot />)).toBe('<span aria-hidden="true" class="ui-dot"></span>');
    expect(html(<Dot tone="ok" />)).toContain('ui-dot ui-dot--ok');
    expect(html(<Dot live />)).toContain('ui-dot ui-dot--live');
  });
});

describe('Toggle', () => {
  it('is a labelled switch', () => {
    const out = html(<Toggle checked label="Reduce motion" onChange={() => {}} />);
    expect(out).toContain('role="switch"');
    expect(out).toContain('aria-checked="true"');
    expect(out).toContain('aria-label="Reduce motion"');
    expect(out).toContain('ui-toggle ui-toggle--on');
    const off = html(<Toggle checked={false} disabled label="x" onChange={() => {}} />);
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain('disabled=""');
  });
  it('reports the inverted value', () => {
    const onChange = vi.fn();
    const element = Toggle({ checked: false, label: 'x', onChange }) as ReactElement<{ onClick(): void }>;
    element.props.onClick();
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Checkbox', () => {
  it('renders plain, overlay and mixed states', () => {
    const plain = html(<Checkbox checked label="Select image" onChange={() => {}} />);
    expect(plain).toContain('role="checkbox"');
    expect(plain).toContain('aria-checked="true"');
    expect(plain).toContain('aria-label="Select image"');
    expect(plain).toContain('class="ui-check ui-check--plain ui-check--on"');
    const overlay = html(<Checkbox checked={false} variant="overlay" label="x" onChange={() => {}} />);
    expect(overlay).toContain('class="ui-check"');
    expect(overlay).toContain('aria-checked="false"');
    expect(overlay).not.toContain('ui-glyph');
    const mixed = html(<Checkbox checked={false} indeterminate label="All" onChange={() => {}} />);
    expect(mixed).toContain('aria-checked="mixed"');
    expect(mixed).toContain('ui-check--on');
  });
  it('stops propagation so an enclosing card does not activate', () => {
    const onChange = vi.fn();
    const stopPropagation = vi.fn();
    const element = Checkbox({ checked: false, label: 'x', onChange }) as ReactElement<{ onClick(event: unknown): void }>;
    element.props.onClick({ stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(true);
    const mixed = Checkbox({ checked: false, indeterminate: true, label: 'x', onChange }) as ReactElement<{ onClick(event: unknown): void }>;
    mixed.props.onClick({ stopPropagation });
    expect(onChange).toHaveBeenLastCalledWith(true);
    const checked = Checkbox({ checked: true, label: 'x', onChange }) as ReactElement<{ onClick(event: unknown): void }>;
    checked.props.onClick({ stopPropagation });
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe('Kbd, Progress and Spinner', () => {
  it('renders kbd', () => {
    expect(html(<Kbd>⌘K</Kbd>)).toBe('<kbd class="ui-kbd">⌘K</kbd>');
  });
  it('renders a labelled progressbar with a 0–100 value', () => {
    const out = html(<Progress value={0.426} label="Batch progress" tone="accent" />);
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('aria-label="Batch progress"');
    expect(out).toContain('aria-valuemin="0"');
    expect(out).toContain('aria-valuemax="100"');
    expect(out).toContain('aria-valuenow="43"');
    expect(out).toContain('ui-progress ui-progress--accent');
    expect(out).toContain('width:43%');
    expect(html(<Progress value={1} label="x" />)).toContain('class="ui-progress"');
  });
  it('clamps progress values', () => {
    expect(progressPercent(-1)).toBe(0);
    expect(progressPercent(2)).toBe(100);
    expect(progressPercent(Number.NaN)).toBe(0);
    expect(progressPercent(0.5)).toBe(50);
  });
  it('spinner is hidden without a label and a status with one', () => {
    const hidden = html(<Spinner />);
    expect(hidden).toContain('aria-hidden="true"');
    expect(hidden).toContain('width:18px');
    const labelled = html(<Spinner size={24} label="Loading" />);
    expect(labelled).toContain('role="status"');
    expect(labelled).toContain('aria-label="Loading"');
    expect(labelled).not.toContain('aria-hidden');
  });
});
