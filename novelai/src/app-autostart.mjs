/**
 * Automatic start of the app (Agents start MCP for NovelAI themselves; the user never has to). Wraps the raw bridge
 * client (src/bridge-client.mjs) below the guard, so every host call of every tool goes through it:
 *
 * 1. A host call fails with a failure that certainly reached no host (undeliveredReason: no bridge.json, or a
 *    refused connection to the address it names). Every other failure — a host answer, a timeout, a connection
 *    dropped after sending, a garbled reply — is returned as it is: never a start, never a resend.
 * 2. If the app is already starting for this data root (Chromium's single-instance lock of the data root names a
 *    live process, or another MCP server claimed a start less than a minute ago), the call only waits for it.
 *    Otherwise, when automatic start is allowed (autostartPolicy) and this server knows its own app
 *    (src/app-launch.mjs), it starts that app in the background — at most once a minute per server process, and
 *    only one server per data root at a time (the claim file) — and waits.
 * 3. Waiting ends when a new bridge.json appears (another one than the refused one), at most AUTOSTART_LIMITS.waitMs
 *    (30 s) after the failure; the call is then sent once more. After a start by this call, a canvas call the host
 *    refuses with workspace_not_ready (refused before anything is run: the window is still loading) is sent again
 *    every 500 ms within the same 30 s; any other answer is returned at once.
 *
 * Concurrent calls of one server share one wait. NOVELAI_MCP_AUTOSTART=0 turns starting off (waiting for an app that
 * is already starting stays); test processes never start anything unless a test injects its own launcher.
 */
import { lstat, mkdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError, readBridgeFingerprint, refusedConnection, undeliveredReason } from './bridge-client.mjs';
import { isTestProcess, resolveDataPaths } from './data-paths.mjs';
import { createAppLauncher } from './app-launch.mjs';

export const AUTOSTART_ENV = 'NOVELAI_MCP_AUTOSTART';
export const AUTOSTART_LIMITS = Object.freeze({
  /** Longest wait for the app after a failed call, start included. */
  waitMs: 30_000,
  /** How often the bridge file is checked while waiting. */
  pollMs: 250,
  /** Least time between two starts by one server process. */
  cooldownMs: 60_000,
  /** A claim by another server younger than this means its start is under way. */
  claimMs: 60_000,
  /** Interval of the workspace_not_ready resends after a start. */
  canvasRetryMs: 500,
});
/** <data root>/runtime/<CLAIM_FILE>: which server started the app last, and when (its age is what counts). */
export const CLAIM_FILE = 'mcp-autostart.json';

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
/**
 * Whether this server may start the app: {launch, reason}. reason 'off' (NOVELAI_MCP_AUTOSTART=0, also false/off/no),
 * 'off_in_tests' (a node --test or Vitest process, or a run of tests/run-tests.mjs, unless the test injected its own
 * launcher), or null.
 */
export function autostartPolicy({ env = process.env, proc = process, launcherInjected = false } = {}) {
  if (OFF_VALUES.has(String(env[AUTOSTART_ENV] ?? '').trim().toLowerCase())) return { launch: false, reason: 'off' };
  if (!launcherInjected && (isTestProcess(env, proc) || Boolean(String(env.NOVELAI_TEST_RUN_DATA_DIR ?? '').trim()))) return { launch: false, reason: 'off_in_tests' };
  return { launch: true, reason: null };
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; } };

/**
 * Whether an app runs on this data root (its userData), from Chromium's single-instance lock: on macOS and Linux the
 * symlink SingletonLock -> <host>-<pid> while that process lives; on Windows the file `lockfile`, which the running
 * instance holds open with delete-on-close. 'running' or 'absent'; anything unreadable is 'absent' (a start then
 * meets the app's own single-instance lock).
 */
export async function appInstanceState(dataRoot, { platform = process.platform, isAlive = alive, fs = { lstat, readlink } } = {}) {
  try {
    if (platform === 'win32') { await fs.lstat(join(dataRoot, 'lockfile')); return 'running'; }
    const target = await fs.readlink(join(dataRoot, 'SingletonLock'));
    const pid = Number(/-(\d+)$/.exec(String(target))?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 && isAlive(pid) ? 'running' : 'absent';
  } catch { return 'absent'; }
}

/** The claim file of the runtime folder: claim() takes it (true) unless another server holds a fresh one; fresh()
 * says whether another server's claim is younger than claimMs. */
export function createStartClaim(runtimeDir, { claimMs = AUTOSTART_LIMITS.claimMs, now = () => Date.now(), pid = process.pid } = {}) {
  const file = join(runtimeDir, CLAIM_FILE);
  // Its age decides; an unreadable body (being written right now, or damaged) names no server.
  const read = async () => {
    let info;
    try { info = await lstat(file); } catch { return null; }
    let pid = null;
    try { pid = JSON.parse(await readFile(file, 'utf8'))?.pid ?? null; } catch { pid = null; }
    return { ageMs: now() - info.mtimeMs, pid };
  };
  const write = () => writeFile(file, `${JSON.stringify({ pid, startedAt: new Date(now()).toISOString() })}\n`, { flag: 'wx', mode: 0o600 });
  return {
    async fresh() { const claim = await read(); return Boolean(claim) && claim.pid !== pid && claim.ageMs < claimMs; },
    async claim() {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await write(); return true; }
        catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          const claim = await read();
          if (claim && claim.pid !== pid && claim.ageMs < claimMs) return false;
          await unlink(file).catch(() => undefined);
        }
      }
      return false;
    },
  };
}

const MESSAGES = {
  off: 'The NovelAI app is not running for this data folder, and automatic start is turned off (NOVELAI_MCP_AUTOSTART=0). Nothing was sent. Ask the user to open the app, then call again.',
  off_in_tests: 'The NovelAI app is not running for this data folder; automatic start is off in test runs. Nothing was sent.',
  unsupported: 'The NovelAI app is not running for this data folder, and this server cannot start it: automatic start works only when the MCP server runs with the app\'s own executable (the configurations in Settings › MCP access). Nothing was sent. Ask the user to open the app, then call again.',
  recently_started: 'The NovelAI app is not running. This server started it less than a minute ago and does not start it again so soon. Nothing was sent. Call again in a moment, or ask the user to open the app.',
  start_failed: reason => `The NovelAI app is not running, and starting it failed (${reason}). Nothing was sent. Ask the user to open the app, then call again.`,
  started_not_ready: 'The NovelAI app was not running; this server started it in the background, but it was not ready within 30 seconds. Nothing was sent. Call again in a moment; if it keeps failing, ask the user to open the app.',
  started_exited: 'The NovelAI app was not running; this server started it in the background, but it closed again before it was ready. Nothing was sent. Ask the user to open the app and check what it reports.',
  starting_not_ready: 'The NovelAI app is starting but was not ready within 30 seconds. Nothing was sent. Call again in a moment.',
  lost: 'The NovelAI app became ready, but its connection was gone again before this call reached it. Nothing was sent. Call again in a moment.',
};
const unavailable = (state, reason) => new BridgeError('unavailable', typeof MESSAGES[state] === 'function' ? MESSAGES[state](reason) : MESSAGES[state], { autostart: state });
export const AUTOSTART_STATES = Object.freeze(Object.keys(MESSAGES));
/** The text added to a workspace_not_ready answer that outlasted the wait after a start. */
export const STILL_LOADING = 'The app was just started by this MCP server and is still loading; call again in a few seconds.';

const abortable = (promise, signal) => !signal ? promise : new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const onAbort = () => reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
});
const delay = (ms, signal) => abortable(new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }), signal);

/**
 * The bridge client with the automatic start around it. Options other than the bridge client exist for tests: the
 * data root and runtime folder, the launcher ({resolve(), launch(app, {client})}), the policy, the clocks, the
 * instance and bridge probes, and the limits. The stdio server uses the defaults.
 */
export function createAutostartBridge(bridgeClient, options = {}) {
  const paths = options.dataPaths ?? resolveDataPaths();
  const env = options.env ?? process.env;
  const launcher = options.launcher ?? createAppLauncher({ env, log: options.log });
  const policy = options.policy ?? autostartPolicy({ env, launcherInjected: Boolean(options.launcher) });
  const limits = { ...AUTOSTART_LIMITS, ...options.limits };
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const sleep = options.sleep ?? delay;
  const instance = options.instanceState ?? (() => appInstanceState(paths.root));
  const bridgeFingerprint = options.bridgeFingerprint ?? (() => readBridgeFingerprint(paths.runtime));
  const claims = options.claims ?? createStartClaim(paths.runtime, { claimMs: limits.claimMs });
  const log = options.log ?? (message => { try { process.stderr.write(`${message}\n`); } catch { /* no stderr */ } });
  let lastStartAt = null;
  let pending = null;
  /** Starts counted for tests and diagnostics. */
  const stats = { starts: 0, waits: 0 };

  /**
   * Waits until a bridge.json other than `stale` exists: 'ready', 'timeout', or 'gone' — the start under way is no
   * longer (not started here: no live instance and no fresh claim; started here: the instance was seen and is gone).
   */
  async function waitForBridge({ stale, deadline, startedHere }) {
    let absent = 0, seen = false;
    for (;;) {
      const fingerprint = await bridgeFingerprint();
      if (fingerprint && fingerprint !== stale) return 'ready';
      const running = (await instance()) === 'running';
      seen ||= running;
      if (!startedHere || seen) {
        absent = running || (!startedHere && await claims.fresh()) ? 0 : absent + 1;
        if (absent >= 3) return 'gone';
      }
      if (monotonicNow() + limits.pollMs > deadline) return 'timeout';
      await sleep(limits.pollMs);
    }
  }

  /** One wait per server: {startedHere, deadline}, or an unavailable error. */
  async function ensureHost(failure, caller) {
    const stale = refusedConnection(failure);
    const deadline = monotonicNow() + limits.waitMs;
    stats.waits++;
    // The app came up between the failure and now: nothing to start.
    const now = await bridgeFingerprint();
    if (now && now !== stale) return { startedHere: false, deadline };
    // Already starting (the app's own lock, or another server's fresh claim): wait, never start a second one.
    if ((await instance()) === 'running' || await claims.fresh()) {
      const waited = await waitForBridge({ stale, deadline, startedHere: false });
      if (waited === 'ready') return { startedHere: false, deadline };
      if (waited === 'timeout') throw unavailable('starting_not_ready');
    }
    if (!policy.launch) throw unavailable(policy.reason ?? 'off');
    const app = launcher.resolve();
    if (!app?.ok) throw unavailable('unsupported');
    if (lastStartAt !== null && monotonicNow() - lastStartAt < limits.cooldownMs) throw unavailable('recently_started');
    // Only one server per data root starts it; the others wait for that start.
    if (!await claims.claim().catch(() => true)) {
      const waited = await waitForBridge({ stale, deadline, startedHere: false });
      if (waited === 'ready') return { startedHere: false, deadline };
      throw unavailable('starting_not_ready');
    }
    lastStartAt = monotonicNow();
    stats.starts++;
    const started = await launcher.launch(app, { client: caller?.client ?? null });
    if (!started?.ok) { log(`[novelai-mcp] automatic start failed: ${started?.reason ?? 'unknown reason'}`); throw unavailable('start_failed', started?.reason ?? 'unknown reason'); }
    log(`[novelai-mcp] started the app in the background (${app.kind}, via ${started.via}${started.pid ? `, pid ${started.pid}` : ''}); waiting for it`);
    const waited = await waitForBridge({ stale, deadline, startedHere: true });
    if (waited === 'gone') throw unavailable('started_exited');
    if (waited !== 'ready') throw unavailable('started_not_ready');
    return { startedHere: true, deadline };
  }

  return {
    stats,
    async call(method, args, signal, caller) {
      const send = () => bridgeClient.call(...[method, args, signal, ...(caller ? [caller] : [])]);
      let failure;
      try { return await send(); }
      catch (error) { if (!undeliveredReason(error)) throw error; failure = error; }
      // Nothing reached a host. Start or wait for the app (one wait per server), then send the call once more.
      pending ??= ensureHost(failure, caller).finally(() => { pending = null; });
      let host;
      try { host = await abortable(pending, signal); }
      catch (error) { if (error instanceof BridgeError) throw error; throw failure; }
      for (;;) {
        try { return await send(); }
        catch (error) {
          if (undeliveredReason(error)) throw unavailable('lost');
          if (!host.startedHere || !(error instanceof BridgeError) || error.code !== 'workspace_not_ready') throw error;
          // Refused before anything ran: the window of the app just started is still loading.
          if (signal?.aborted || monotonicNow() + limits.canvasRetryMs > host.deadline) throw new BridgeError(error.code, `${error.message} ${STILL_LOADING}`, error.details);
          await sleep(limits.canvasRetryMs, signal).catch(() => { throw new BridgeError(error.code, `${error.message} ${STILL_LOADING}`, error.details); });
        }
      }
    },
  };
}
