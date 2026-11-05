import { describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BatchJob } from '../workspace/batch-types';
import { captureRequest } from './capture';
import { DEFAULT_SHELL_PAGE, isShellRoute, navigate, openSettingsSection, settingsSectionOf, useShellRoute, visibleRoute } from './route';
import { queueSummary, TopBar } from './TopBar';
import { ModeSwitch } from '../canvas/ModeSwitch';
import { useAppStore } from '../store';

const batch = (status: BatchJob['status'], statuses: string[], count = statuses.length): BatchJob => ({ batchId: Math.random().toString(36), status, count, items: statuses.map(value => ({ status: value })), createdAt: '', updatedAt: '' } as unknown as BatchJob);

describe('the frame of the new interface (step 4b1)', () => {
  it('opens on the library; settings is a page with sections, and the old section names open the matching one (step 4b2)', () => {
    expect(DEFAULT_SHELL_PAGE).toBe('library');
    expect(useShellRoute.getState().page).toBe('library');
    navigate('settings', 'api');
    expect(useShellRoute.getState()).toMatchObject({ page: 'settings', settingsSection: 'account' });
    expect(visibleRoute(useShellRoute.getState().page)).toBe('settings');
    navigate('settings', 'backup');
    expect(useShellRoute.getState().settingsSection).toBe('storage');
    expect(['performance', 'prompt'].map(settingsSectionOf)).toEqual(['canvas', 'canvas']);
    expect(['language', 'appearance', 'about', 'mcp', 'nonsense'].map(settingsSectionOf)).toEqual(['appearance', 'appearance', 'about', 'mcp', 'account']);
    navigate('queue');
    expect(visibleRoute(useShellRoute.getState().page)).toBe('queue');
    // The settings remember their section while another page is open.
    openSettingsSection();
    expect(useShellRoute.getState()).toMatchObject({ page: 'settings', settingsSection: 'storage' });
    navigate('library');
    expect(isShellRoute('canvas')).toBe(true);
    expect(isShellRoute('settings')).toBe(true);
    expect(isShellRoute('tools')).toBe(false);
  });

  it('shows the current batch of the shared queue (running first, else the oldest unfinished), manual or agent', () => {
    expect(queueSummary([])).toEqual({ active: 0, running: false, done: 0, total: 0 });
    const running = batch('running', [...Array(7).fill('succeeded'), ...Array(5).fill('pending')]);
    expect(queueSummary([batch('queued', ['pending', 'pending']), running, batch('succeeded', ['succeeded'])])).toEqual({ active: 2, running: true, done: 7, total: 12 });
    expect(queueSummary([batch('queued', ['pending']), batch('paused', ['failed', 'pending', 'pending'])])).toEqual({ active: 2, running: false, done: 1, total: 3 });
  });

  it('switches the language with two plain toggle buttons (Tab reaches both; the current one is pressed)', () => {
    useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language: 'zh-CN' } as never });
    const html = renderToStaticMarkup(<TopBar route="library" onNavigate={() => undefined} onOpenAccount={() => undefined} monitor={null} capture />);
    const group = /<div class="as-langsw" role="group"[^>]*>(.*?)<\/div>/.exec(html)?.[1] ?? '';
    expect([...group.matchAll(/<button type="button" aria-pressed="(true|false)"/g)].map(match => match[1])).toEqual(['true', 'false']);
    expect(group).not.toContain('role="radio"');
  });

  it('opens a new page in capture runs only, for safe known names, with an optional language', () => {
    expect(captureRequest('?uiCapture=referencePresets&uiCapturePage=library-detail-zh')).toEqual({ page: 'library-detail', lang: 'zh' });
    expect(captureRequest('?uiCapture=x&uiCapturePage=06-library-delete-confirm-en')).toEqual({ page: 'library-delete-confirm', lang: 'en' });
    expect(captureRequest('?uiCapture=x&uiCapturePage=trash')).toEqual({ page: 'trash', lang: null });
    // A normal start has no uiCapture; unknown or unsafe names keep the existing capture behaviour.
    expect(captureRequest('?uiCapturePage=library')).toBeNull();
    expect(captureRequest('')).toBeNull();
    expect(captureRequest('?uiCapture=generate&uiCapturePage=01-generate')).toBeNull();
    expect(captureRequest('?uiCapture=x&uiCapturePage=library%3Cscript%3E')).toBeNull();
    // Step 4b2: the settings page and the guide have capture names too; an old settings name opens the new page.
    expect(captureRequest('?uiCapture=settings&uiCapturePage=23-settings-mcp-codex-en')).toEqual({ page: 'settings-mcp-codex', lang: 'en' });
    expect(captureRequest('?uiCapture=onboarding&uiCapturePage=32-onboarding-2-connected-zh')).toEqual({ page: 'onboarding-2-connected', lang: 'zh' });
    expect(captureRequest('?uiCapture=x&uiCapturePage=18-queue-halted')).toEqual({ page: 'queue-halted', lang: null });
    expect(captureRequest('?uiCapture=x&uiCapturePage=settings-api')).toBeNull();
  });

  it('switches the canvas modes from the mode switch of the left column (step 4b3)', () => {
    useAppStore.setState({ activeTab: 'postprocess', postprocessMode: 'director' } as never);
    const html = renderToStaticMarkup(<ModeSwitch />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="true"[^>]*>(?:<[^>]+>)*后期|aria-checked="true"[^>]*>(?:<[^>]+>)*Post/);
    expect(html).toContain('Director');
  });

  it('keeps the canvas mounted and hidden, never unmounted', () => {
    const shell = readFileSync(new URL('./AppShell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain("<section className={clsx('as-page', page === 'canvas' && 'is-active')}");
    expect(shell).not.toMatch(/page === 'canvas' && \{canvas\}|page === 'canvas' \? canvas/);
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('<WorkspaceBridge />');
    expect(app).toContain('document.documentElement.classList.add("theme-dark")');
    expect(app).not.toContain('settingsSectionText.appearance.themeLight');
  });

  it('a hidden page shows nothing even when an old style makes its content visibility:visible (review rework)', () => {
    const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');
    const rule = (selector: string) => {
      const match = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      return Object.fromEntries((match?.[2] ?? '').split(';').map(part => part.split(':').map(value => value.trim())).filter(([name]) => name));
    };
    const hidden = rule('.as-page'), shown = rule('.as-page.is-active');
    // Transparent as a whole (opacity cannot be undone by a descendant) and laid out as before (the canvas keeps its size).
    expect(hidden).toMatchObject({ position: 'absolute', inset: '0', visibility: 'hidden', opacity: '0', isolation: 'isolate', 'z-index': '0' });
    expect(hidden.display).toBe('flex');
    // The shown page lies above the hidden ones and is opaque.
    expect(shown).toMatchObject({ visibility: 'visible', opacity: '1', 'z-index': '1', background: 'var(--ui-bg-0)' });
    // (Step 4c2: the old rule that showed through, .persistent-tools-view, was removed with the old workbench.)
    // The canvas stays mounted while hidden (display is never none for a page).
    expect(css).not.toMatch(/\.as-page[^{]*\{[^}]*display:\s*none/);
  });
});
