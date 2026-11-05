import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/ui/tokens.css'), 'utf8');
const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));

function token(name: string): string {
  const match = root.match(new RegExp(`--ui-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match) throw new Error(`missing hex token --ui-${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('ui tokens contrast (WCAG 2.x)', () => {
  it('keeps body and secondary text at AA on the window, sidebar and panel backgrounds', () => {
    for (const text of ['text-1', 'text-2']) {
      for (const bg of ['bg-0', 'bg-1', 'bg-2']) {
        expect(contrast(token(text), token(bg)), `${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps white primary-button text at AA on accent-strong', () => {
    expect(contrast('#ffffff', token('accent-strong'))).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the agent colour and accent text readable on the sidebar background', () => {
    expect(contrast(token('agent'), token('bg-1'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('accent-text'), token('bg-1'))).toBeGreaterThanOrEqual(4.5);
  });

  it('defines the prototype values for the core palette', () => {
    expect(token('bg-0')).toBe('#0b0a10');
    expect(token('accent')).toBe('#8b5cf6');
    expect(token('accent-hi')).toBe('#9f78f8');
    expect(token('accent-strong')).toBe('#7c3aed');
    expect(token('agent')).toBe('#22d3ee');
    expect(token('danger-strong')).toBe('#ef4444');
  });

  it('prefixes every variable and has no light theme', () => {
    const declared = [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(30);
    for (const name of declared) expect(name.startsWith('--ui-')).toBe(true);
    expect(css).not.toMatch(/data-theme|prefers-color-scheme/);
    expect(css).toContain('html.motion-reduced .ui-scope *');
  });
});

describe('components.css hygiene', () => {
  const components = readFileSync(resolve(process.cwd(), 'src/ui/components.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('only defines ui- prefixed classes and never uses the legacy ui-icon class', () => {
    const classes = [...components.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]);
    for (const name of classes) expect(name.startsWith('ui-'), name).toBe(true);
    expect(components).not.toMatch(/\.ui-icon\b/);
    expect(components).not.toMatch(/details\s*>\s*summary/);
  });
  it('uses only --ui- variables', () => {
    for (const match of components.matchAll(/var\((--[\w-]+)/g)) expect(match[1].startsWith('--ui-'), match[1]).toBe(true);
  });
});
