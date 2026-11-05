/**
 * How the main window first appears. Normally show() (it comes to the front, as it always did). A dev-tools test client
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

export function showMainWindow(win: { show(): void; showInactive(): void }, env: NodeJS.ProcessEnv = process.env) {
  if (backgroundWindowRequested(env)) win.showInactive();
  else win.show();
}

/**
 * A second launch of the app on the same data root (Electron's second-instance event). Normally the running window comes
 * to the front (restore, show, focus), as it always did. A test client started in the background never does: a test
 * that starts another instance by mistake, or while the previous one is still exiting, must not pull the window in
 * front of what the user is doing (review rework of the queue retention task, 2026-11).
 */
export function revealOnSecondInstance(win: { isMinimized(): boolean; restore(): void; show(): void; focus(): void } | null, env: NodeJS.ProcessEnv = process.env) {
  if (!win || backgroundWindowRequested(env)) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
