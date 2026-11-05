import { plainClientText } from '../src/agent-clients';

/**
 * How the main window first appears. Normally show() (it comes to the front, as it always did). An app that an agent's
 * MCP server started (novelai/src/app-launch.mjs: STARTED_BY_AGENT_ARG on its command line, macOS through LaunchServices
 * in the background) never puts its first window over the user's windows and never takes the focus (agentWindowMode):
 * on macOS and Linux the window is not shown at all (it is created and its page loads, so the canvas tools work) — macOS
 * shows the ordinary Dock icon, and clicking it (the activate event) shows the window; on Linux the app runs in the
 * background without a taskbar entry until the user opens it again (a second launch without the switch). On Windows the
 * window appears minimized in the taskbar without being activated (showMinimizedInactive); clicking its button restores
 * it. Opening the app again (second-instance without the switch) always shows the window. A dev-tools test client
 * started in the background (dev-tools/test-client.mjs, the default since step 4c1; --foreground turns it off) sets
 * NAI_DEV_TOOLS_BACKGROUND=1: the window is shown without activating the app or taking the focus (showInactive), so a
 * test run never pulls the window in front of what the user is doing; on macOS it also runs as an accessory app from
 * before ready (prepareBackgroundApp). Nothing else changes; no app.focus or Dock call.
 */
export const BACKGROUND_WINDOW_ENV = 'NAI_DEV_TOOLS_BACKGROUND';

export const backgroundWindowRequested = (env: NodeJS.ProcessEnv = process.env) => env[BACKGROUND_WINDOW_ENV] === '1';

/**
 * Before ready, for a background test client on macOS only: the app runs as an accessory app (no Dock icon, no menu bar),
 * so macOS never activates it as it launches (review rework 2026-11: one sample caught a background test client in
 * front about 0.9 s after its launch, with only showInactive() called). Its window still appears (inactive) and takes
 * DevTools input and screenshots. Every other start, and every other platform, changes nothing.
 */
export function prepareBackgroundApp(app: { setActivationPolicy?(policy: 'regular' | 'accessory' | 'prohibited'): void }, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (!backgroundWindowRequested(env) || platform !== 'darwin' || typeof app.setActivationPolicy !== 'function') return false;
  app.setActivationPolicy('accessory');
  return true;
}

/**
 * The fallback for a background test client on macOS (review rework 2): should it still become the active app (it runs
 * on an LSUIElement copy of Electron and as an accessory app, so this is not expected), it hides at once and says so in
 * its log (dev-tools test-client logs: client.log, app.log). Every other start, and every other platform, adds nothing.
 */
export function hideWhenActivated(app: { on(event: 'did-become-active', listener: () => void): unknown; hide?(): void }, log: (message: string) => void = message => console.warn(message), env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (!backgroundWindowRequested(env) || platform !== 'darwin') return false;
  app.on('did-become-active', () => {
    app.hide?.();
    log(`[dev-tools] ${new Date().toISOString()} the background test client became the active app; it was hidden at once (${BACKGROUND_WINDOW_ENV}=1).`);
  });
  return true;
}

/** The switch an agent's MCP server puts on the command line of the app it starts (novelai/src/app-launch.mjs). */
export const STARTED_BY_AGENT_ARG = '--started-by-agent';

/**
 * Whether this command line is a start by an agent's MCP server: null for any other start; {client} otherwise, with
 * the client the switch names (`--started-by-agent=<URI-encoded clientInfo name>`, plain text), or null without one.
 */
export function agentStartOf(argv: readonly string[] = process.argv): { client: { name: string } | null } | null {
  for (const arg of argv) {
    if (typeof arg !== 'string') continue;
    if (arg === STARTED_BY_AGENT_ARG) return { client: null };
    if (!arg.startsWith(`${STARTED_BY_AGENT_ARG}=`)) continue;
    let name: string | null = null;
    try { name = plainClientText(decodeURIComponent(arg.slice(STARTED_BY_AGENT_ARG.length + 1)), 100); } catch { name = null; }
    return { client: name ? { name } : null };
  }
  return null;
}

/**
 * How the first window of an app an agent started appears: 'minimized' on Windows (in the taskbar, not activated),
 * 'hidden' elsewhere. macOS: Electron's showInactive() orders the window in front of other apps' windows (it only skips
 * the activation), so it is not used. Windows: a hidden window's minimize() shows it with SW_SHOWMINIMIZED, which
 * activates it, so showMinimizedInactive takes another path. Linux: no way is known to put a window into the taskbar
 * minimized without a visible map first (X11 maps it, then iconifies it; setOpacity does nothing there).
 */
export type AgentWindowMode = 'hidden' | 'minimized';
export const agentWindowMode = (platform: NodeJS.Platform = process.platform): AgentWindowMode => platform === 'win32' ? 'minimized' : 'hidden';

export interface AgentWindowTarget {
  showInactive(): void;
  minimize(): void;
  isMinimized(): boolean;
  isVisible(): boolean;
  isDestroyed?(): boolean;
  setOpacity(opacity: number): void;
  getOpacity(): number;
}
/** How long the window stays fully transparent after it was minimized, so no part of the minimize animation shows. */
export const MINIMIZE_TRANSPARENT_MS = 1000;

/**
 * Windows: shows the window minimized in the taskbar without activating it and without a visible frame. It is made fully
 * transparent, shown without activation (SW_SHOWNOACTIVATE), minimized (SC_MINIMIZE, which leaves the activation alone
 * for a window that is not the active one) and made opaque again after MINIMIZE_TRANSPARENT_MS (at once when the user
 * restores it first: `restoreOpacity()`). A window that is not normally visible after showInactive() is not minimized
 * (minimize() of a hidden window would activate it): it stays as it is. Returns {state, restoreOpacity}.
 */
export function showMinimizedInactive(win: AgentWindowTarget, { transparentMs = MINIMIZE_TRANSPARENT_MS, setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms) }: { transparentMs?: number; setTimer?: (fn: () => void, ms: number) => unknown } = {}) {
  const opacity = win.getOpacity();
  let restored = false;
  const restoreOpacity = () => { if (restored || win.isDestroyed?.()) return; restored = true; win.setOpacity(opacity); };
  win.setOpacity(0);
  let state: 'minimized' | 'not_shown';
  try {
    win.showInactive();
    if (win.isMinimized()) state = 'minimized';
    else if (win.isVisible()) { win.minimize(); state = win.isMinimized() ? 'minimized' : 'not_shown'; }
    else state = 'not_shown';
  } catch (error) { restoreOpacity(); throw error; }
  setTimer(restoreOpacity, transparentMs);
  return { state, restoreOpacity };
}

/**
 * The first window of an app an agent started: nothing on macOS and Linux (it stays hidden), showMinimizedInactive on
 * Windows. Returns what it did, and on Windows the opacity restorer.
 */
export function presentAgentWindow(win: AgentWindowTarget, platform: NodeJS.Platform = process.platform, options: Parameters<typeof showMinimizedInactive>[1] = {}) {
  if (agentWindowMode(platform) === 'hidden') return { mode: 'hidden' as const, state: 'hidden' as const, restoreOpacity: () => {} };
  return { mode: 'minimized' as const, ...showMinimizedInactive(win, options) };
}

/** `inactive`: shown without activating (a background dev-tools test client). */
export function showMainWindow(win: { show(): void; showInactive(): void }, env: NodeJS.ProcessEnv = process.env, { inactive = false }: { inactive?: boolean } = {}) {
  if (inactive || backgroundWindowRequested(env)) win.showInactive();
  else win.show();
}

/**
 * A second launch of the app on the same data root (Electron's second-instance event, `argv` its command line). Normally
 * the running window comes to the front (restore, show, focus), as it always did. Never for a second launch by an
 * agent's MCP server (agentStartOf: two agents starting the app at once, or one starting it while it is still coming
 * up), and never for a test client started in the background: a test that starts another instance by mistake, or while
 * the previous one is still exiting, must not pull the window in front of what the user is doing (review rework of the
 * queue retention task, 2026-11).
 */
export function revealOnSecondInstance(win: { isMinimized(): boolean; restore(): void; show(): void; focus(): void } | null, env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = []) {
  if (!win || backgroundWindowRequested(env) || agentStartOf(argv)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
