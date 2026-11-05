import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_WINDOW_ENV, backgroundWindowRequested, hideWhenActivated, prepareBackgroundApp, revealOnSecondInstance, showMainWindow } from './window-show';

const win = () => ({ show: vi.fn(), showInactive: vi.fn() });

describe('the main window’s first show (step 4c1: background test clients)', () => {
  it('without the variable (every normal start) it is show(), exactly as before', () => {
    for (const env of [{}, { [BACKGROUND_WINDOW_ENV]: '' }, { [BACKGROUND_WINDOW_ENV]: '0' }, { [BACKGROUND_WINDOW_ENV]: 'true' }]) {
      const w = win(); showMainWindow(w, env);
      expect(w.show).toHaveBeenCalledTimes(1); expect(w.showInactive).not.toHaveBeenCalled();
      expect(backgroundWindowRequested(env)).toBe(false);
    }
  });
  it('NAI_DEV_TOOLS_BACKGROUND=1 (dev-tools test-client start, the default) shows it without activating', () => {
    const w = win(); showMainWindow(w, { [BACKGROUND_WINDOW_ENV]: '1' });
    expect(w.showInactive).toHaveBeenCalledTimes(1); expect(w.show).not.toHaveBeenCalled();
  });
  it('main.ts shows the window only through it, and never activates the app or the Dock itself', () => {
    const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/ready-to-show[\s\S]{0,200}showMainWindow\(mainWindow\)/);
    expect(source).not.toMatch(/app\.focus\(|app\.dock\.show\(|\.moveTop\(|steal/);
    // A second launch goes through revealOnSecondInstance only; main.ts itself never calls show() or focus().
    expect(source).not.toMatch(/mainWindow\.show\(\)|mainWindow\.focus\(\)/);
    expect(source).toMatch(/app\.on\("second-instance", \(\) => revealOnSecondInstance\(mainWindow\)\);/);
  });
});

describe('a background test client on macOS runs as an accessory app (review rework: its launch never activates it)', () => {
  it('only with NAI_DEV_TOOLS_BACKGROUND=1 on darwin; every normal start and every other platform changes nothing', () => {
    const app = () => ({ setActivationPolicy: vi.fn() });
    const on = app();
    expect(prepareBackgroundApp(on, { [BACKGROUND_WINDOW_ENV]: '1' }, 'darwin')).toBe(true);
    expect(on.setActivationPolicy).toHaveBeenCalledTimes(1); expect(on.setActivationPolicy).toHaveBeenCalledWith('accessory');
    for (const [env, platform] of [[{}, 'darwin'], [{ [BACKGROUND_WINDOW_ENV]: '0' }, 'darwin'], [{ [BACKGROUND_WINDOW_ENV]: 'true' }, 'darwin'], [{ [BACKGROUND_WINDOW_ENV]: '1' }, 'win32'], [{ [BACKGROUND_WINDOW_ENV]: '1' }, 'linux']] as const) {
      const off = app();
      expect(prepareBackgroundApp(off, env, platform as NodeJS.Platform)).toBe(false);
      expect(off.setActivationPolicy).not.toHaveBeenCalled();
    }
    expect(prepareBackgroundApp({}, { [BACKGROUND_WINDOW_ENV]: '1' }, 'darwin')).toBe(false);
  });
  it('main.ts calls it at load, before ready (outside any whenReady callback)', () => {
    const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const call = source.indexOf('\nprepareBackgroundApp(app);'), ready = source.indexOf('app.whenReady()');
    expect(call).toBeGreaterThan(0); expect(ready).toBeGreaterThan(call);
  });
});

describe('a background test client that becomes active anyway hides at once and logs it (review rework 2)', () => {
  it('only with NAI_DEV_TOOLS_BACKGROUND=1 on darwin', () => {
    const app = () => { const listeners: Array<() => void> = []; return { listeners, on: vi.fn((event: string, listener: () => void) => { if (event === 'did-become-active') listeners.push(listener); }), hide: vi.fn() }; };
    const on = app(), lines: string[] = [];
    expect(hideWhenActivated(on, line => lines.push(line), { [BACKGROUND_WINDOW_ENV]: '1' }, 'darwin')).toBe(true);
    expect(on.on).toHaveBeenCalledWith('did-become-active', expect.any(Function));
    on.listeners[0]();
    expect(on.hide).toHaveBeenCalledTimes(1); expect(lines[0]).toMatch(/became the active app; it was hidden at once/);
    for (const [env, platform] of [[{}, 'darwin'], [{ [BACKGROUND_WINDOW_ENV]: '1' }, 'win32']] as const) {
      const off = app(); expect(hideWhenActivated(off, () => {}, env, platform as NodeJS.Platform)).toBe(false); expect(off.on).not.toHaveBeenCalled();
    }
    const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(source.indexOf('\nhideWhenActivated(app);')).toBeGreaterThan(0);
    expect(source.indexOf('app.whenReady()')).toBeGreaterThan(source.indexOf('\nhideWhenActivated(app);'));
  });
});

describe('a second launch on the same data root (review rework: a background test client never takes the front)', () => {
  const second = (minimized = false) => ({ isMinimized: vi.fn(() => minimized), restore: vi.fn(), show: vi.fn(), focus: vi.fn() });
  it('normally restores, shows and focuses the running window, exactly as before', () => {
    for (const env of [{}, { [BACKGROUND_WINDOW_ENV]: '0' }]) {
      const w = second(true); revealOnSecondInstance(w, env);
      expect(w.restore).toHaveBeenCalledTimes(1); expect(w.show).toHaveBeenCalledTimes(1); expect(w.focus).toHaveBeenCalledTimes(1);
    }
    const w = second(false); revealOnSecondInstance(w, {}); expect(w.restore).not.toHaveBeenCalled(); expect(w.show).toHaveBeenCalledTimes(1);
  });
  it('in background mode (NAI_DEV_TOOLS_BACKGROUND=1) it does nothing: no restore, show or focus', () => {
    const w = second(true); revealOnSecondInstance(w, { [BACKGROUND_WINDOW_ENV]: '1' });
    expect(w.restore).not.toHaveBeenCalled(); expect(w.show).not.toHaveBeenCalled(); expect(w.focus).not.toHaveBeenCalled();
    expect(() => revealOnSecondInstance(null, {})).not.toThrow();
  });
});
