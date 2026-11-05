import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_WINDOW_ENV, MINIMIZE_TRANSPARENT_MS, STARTED_BY_AGENT_ARG, agentStartOf, agentWindowMode, backgroundWindowRequested, hideWhenActivated, prepareBackgroundApp, presentAgentWindow, revealOnSecondInstance, showMainWindow, showMinimizedInactive } from './window-show';

const win = () => ({ show: vi.fn(), showInactive: vi.fn() });
/** A window that records the calls of the agent-start paths (Windows semantics: minimized windows are not "visible"). */
function agentWin({ visibleAfterShow = true, minimizedAfterShow = false, throwOnShow = false } = {}) {
  const calls: string[] = [];
  let opacity = 1, visible = false, minimized = false;
  return {
    calls,
    showInactive: () => { calls.push('showInactive'); if (throwOnShow) throw new Error('show failed'); minimized = minimizedAfterShow; visible = visibleAfterShow && !minimizedAfterShow; },
    minimize: () => { calls.push('minimize'); minimized = true; visible = false; },
    isMinimized: () => minimized, isVisible: () => visible, isDestroyed: () => false,
    setOpacity: (value: number) => { calls.push(`setOpacity(${value})`); opacity = value; },
    getOpacity: () => opacity,
  };
}

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
    expect(source).toMatch(/ready-to-show[\s\S]{0,600}if \(agentWindowPending\) \{ restoreAgentWindowOpacity = presentAgentWindow\(mainWindow\)\.restoreOpacity; return; \}\n\s+showMainWindow\(mainWindow, process\.env, \{ inactive: false \}\);/);
    expect(source).not.toMatch(/app\.focus\(|app\.dock\.show\(|\.moveTop\(|steal/);
    // A second launch goes through revealOnSecondInstance; main.ts itself calls show() only when the Dock icon reopens
    // the window an agent's start kept hidden, and never focus().
    expect(source.match(/mainWindow\.show\(\)/g) ?? []).toHaveLength(1);
    expect(source).toMatch(/if \(agentWindowPending && mainWindow && !mainWindow\.isDestroyed\(\) && !mainWindow\.isVisible\(\)\) \{ agentWindowRevealed\(\); mainWindow\.show\(\); \}/);
    expect(source).not.toMatch(/mainWindow\.focus\(\)/);
    expect(source).toMatch(/app\.on\("second-instance", \(_event, argv\) => \{\n\s+if \(!agentStartOf\(argv\)\) agentWindowRevealed\(\);\n\s+revealOnSecondInstance\(mainWindow, process\.env, argv\);/);
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

describe('an app an agent started (novelai/src/app-launch.mjs: --started-by-agent) never takes the focus', () => {
  it('reads the switch and the client it names; any other command line is a normal start', () => {
    expect(STARTED_BY_AGENT_ARG).toBe('--started-by-agent');
    expect(agentStartOf(['/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI'])).toBeNull();
    expect(agentStartOf(['electron', '/repo/novelai/client', '--started-by-agent'])).toEqual({ client: null });
    expect(agentStartOf(['exe', '--started-by-agent=claude-code'])).toEqual({ client: { name: 'claude-code' } });
    expect(agentStartOf(['exe', '--started-by-agent=Visual%20Studio%20Code%20%22x%22'])).toEqual({ client: { name: 'Visual Studio Code "x"' } });
    // Malformed or control characters: still an agent start, without a name.
    for (const arg of ['--started-by-agent=%E0%A4%A', '--started-by-agent=a%0Ab', '--started-by-agent=']) expect(agentStartOf(['exe', arg])).toEqual({ client: null });
    expect(agentStartOf(['exe', '--started-by-agent-x', '--not-started-by-agent'])).toBeNull();
  });
  it('its first window is hidden on macOS and Linux and minimized without activation on Windows; any other start is show() as before', () => {
    expect(agentWindowMode('darwin')).toBe('hidden'); expect(agentWindowMode('linux')).toBe('hidden'); expect(agentWindowMode('win32')).toBe('minimized');
    for (const platform of ['darwin', 'linux'] as const) {
      const w = agentWin();
      expect(presentAgentWindow(w, platform)).toMatchObject({ mode: 'hidden', state: 'hidden' });
      expect(w.calls).toEqual([]);
    }
    const normal = win(); showMainWindow(normal, {}, { inactive: false });
    expect(normal.show).toHaveBeenCalledTimes(1); expect(normal.showInactive).not.toHaveBeenCalled();
  });
  it('Windows: transparent, shown without activation, minimized, opaque again after the animation; never activated', () => {
    const timers: Array<[() => void, number]> = [];
    const w = agentWin();
    const shown = presentAgentWindow(w, 'win32', { setTimer: (fn, ms) => timers.push([fn, ms]) });
    expect(shown).toMatchObject({ mode: 'minimized', state: 'minimized' });
    expect(w.calls).toEqual(['setOpacity(0)', 'showInactive', 'minimize']);
    expect(timers.map(([, ms]) => ms)).toEqual([MINIMIZE_TRANSPARENT_MS]);
    timers[0][0]();
    expect(w.calls.at(-1)).toBe('setOpacity(1)');
    shown.restoreOpacity(); expect(w.calls.filter(call => call === 'setOpacity(1)')).toHaveLength(1);
    // The user restored it before the timer: opaque at once, the timer then changes nothing.
    const early = agentWin(), later: Array<() => void> = [];
    showMinimizedInactive(early, { setTimer: fn => later.push(fn) }).restoreOpacity();
    later[0](); expect(early.calls.filter(call => call === 'setOpacity(1)')).toHaveLength(1);
  });
  it('Windows: a window that is not shown normally after showInactive() is never minimized (minimize() of a hidden window activates it)', () => {
    const hidden = agentWin({ visibleAfterShow: false });
    expect(showMinimizedInactive(hidden, { setTimer: fn => fn() }).state).toBe('not_shown');
    expect(hidden.calls).toEqual(['setOpacity(0)', 'showInactive', 'setOpacity(1)']);
    const already = agentWin({ minimizedAfterShow: true });
    expect(showMinimizedInactive(already, { setTimer: () => {} }).state).toBe('minimized');
    expect(already.calls).toEqual(['setOpacity(0)', 'showInactive']);
    const failing = agentWin({ throwOnShow: true });
    expect(() => showMinimizedInactive(failing, { setTimer: () => {} })).toThrow('show failed');
    expect(failing.calls.at(-1)).toBe('setOpacity(1)');
  });
  it('a second launch by an agent never restores, shows or focuses the running window; a user\'s second launch still does', () => {
    const second = () => ({ isMinimized: vi.fn(() => true), restore: vi.fn(), show: vi.fn(), focus: vi.fn() });
    for (const argv of [['exe', '--started-by-agent'], ['electron', '/repo/client', '--started-by-agent=pi']]) {
      const w = second(); revealOnSecondInstance(w, {}, argv);
      expect(w.restore).not.toHaveBeenCalled(); expect(w.show).not.toHaveBeenCalled(); expect(w.focus).not.toHaveBeenCalled();
    }
    const user = second(); revealOnSecondInstance(user, {}, ['exe']);
    expect(user.restore).toHaveBeenCalledTimes(1); expect(user.show).toHaveBeenCalledTimes(1); expect(user.focus).toHaveBeenCalledTimes(1);
  });
  it('main.ts keeps only the first window waiting, unthrottled while it waits, and records the start for Settings › MCP access', () => {
    const source = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/const agentStart = agentStartOf\(process\.argv\);\nlet agentWindowPending = agentStart !== null;/);
    expect(source).toMatch(/if \(agentWindowPending\) \{\n\s+mainWindow\.webContents\.setBackgroundThrottling\(false\);\n\s+\/\/[^\n]*\n\s+mainWindow\.on\("restore", agentWindowRevealed\);\n\s+mainWindow\.on\("focus", agentWindowRevealed\);/);
    expect(source).toMatch(/function agentWindowRevealed\(\) \{\n\s+if \(!agentWindowPending\) return;\n\s+agentWindowPending = false;\n\s+restoreAgentWindowOpacity\(\);\n\s+if \(mainWindow && !mainWindow\.isDestroyed\(\) && !uiCapturePath\) mainWindow\.webContents\.setBackgroundThrottling\(true\);/);
    expect(source).toMatch(/if \(agentStart\) \{\n\s+agentActivity\.recordAppStart\(agentStart\.client\);/);
    expect(source).toMatch(/app\.once\("did-become-active", \(\) => logInfo\(/);
    // Not an accessory app and no LSUIElement: the Dock icon of an agent-started app is the ordinary one.
    expect(source).not.toMatch(/setActivationPolicy\(/);
  });
});
