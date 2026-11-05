import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';
import { rovingValue, segNextValue } from './Seg';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  value: T;
  tabs: Array<TabItem<T>>;
  onChange(next: T): void;
  /** Accessible name of the tablist. */
  label: string;
  /** When set, tabs get id `${idBase}-tab-${value}` and aria-controls `${idBase}-panel-${value}`. */
  idBase?: string;
  className?: string;
}

export function tabIds(idBase: string, value: string): { tab: string; panel: string } {
  return { tab: `${idBase}-tab-${value}`, panel: `${idBase}-panel-${value}` };
}

export function Tabs<T extends string>({ value, tabs, onChange, label, idBase, className }: TabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const focusable = rovingValue(tabs, value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
    const next = segNextValue(tabs, value, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next);
    buttons.current.get(next)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} aria-orientation="horizontal" className={clsx('ui-tabs', className)} onKeyDown={onKeyDown}>
      {tabs.map((tab) => {
        const selected = tab.value === value;
        const ids = idBase ? tabIds(idBase, tab.value) : null;
        return (
          <button
            key={tab.value}
            ref={(node) => {
              if (node) buttons.current.set(tab.value, node);
              else buttons.current.delete(tab.value);
            }}
            type="button"
            role="tab"
            id={ids?.tab}
            aria-controls={ids?.panel}
            aria-selected={selected}
            disabled={tab.disabled}
            tabIndex={tab.value === focusable ? 0 : -1}
            className={clsx('ui-tabs__tab', selected && 'ui-tabs__tab--on')}
            onClick={() => {
              if (!selected) onChange(tab.value);
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
