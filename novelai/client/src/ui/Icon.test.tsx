import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark, Icon, ICON_NAMES } from './Icon';

describe('Icon', () => {
  it('renders every icon name as a decorative ui-glyph svg', () => {
    expect(ICON_NAMES.length).toBeGreaterThanOrEqual(70);
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html).toMatch(/^<svg class="ui-glyph"/);
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke-width="1.6"');
      expect(html).toContain('stroke-linecap="round"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('focusable="false"');
      expect(html).not.toContain('role="img"');
      expect(html).toMatch(/<(path|rect|circle)/);
    }
  });

  it('includes the prototype set plus edit and expand', () => {
    for (const name of ['library', 'agent', 'plug', 'trash', 'starFill', 'gridS', 'terminal', 'maximize', 'edit', 'expand'] as const) {
      expect(ICON_NAMES).toContain(name);
    }
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it('applies size and className and exposes a label when titled', () => {
    const html = renderToStaticMarkup(<Icon name="info" size={20} className="extra" title="Information" />);
    expect(html).toContain('class="ui-glyph extra"');
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Information"');
    expect(html).not.toContain('aria-hidden');
  });
});

describe('BrandMark', () => {
  const gradientIds = (html: string) => [...html.matchAll(/linearGradient id="([^"]+)"/g)].map((match) => match[1]);

  it('gives each instance its own gradient id that the star references', () => {
    const html = renderToStaticMarkup(
      <>
        <BrandMark size={18} />
        <BrandMark size={64} full />
      </>,
    );
    const ids = gradientIds(html);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(html).toContain(`fill="url(#${id})"`);
    }
  });

  it('draws the dark tile and cyan plug only in the full variant', () => {
    const star = renderToStaticMarkup(<BrandMark size={18} />);
    const full = renderToStaticMarkup(<BrandMark size={96} full />);
    expect(star).toContain('aria-hidden="true"');
    expect(star).not.toContain('<rect');
    expect(star).not.toContain('#22d3ee"/><circle');
    expect(full).toContain('<rect width="512" height="512" rx="116" fill="#13111d"');
    expect(full).toContain('stroke="#22d3ee"');
    expect(full).toContain('width="96"');
  });
});
