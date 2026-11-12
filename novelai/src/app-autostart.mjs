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
 *    (30 s) after the failure; the call is then sent once more. After a start by this call, a canvas call
 *    (CANVAS_RETRY_METHODS) the host refuses with workspace_not_ready (refused before anything is run: the window is
 *    still loading) is sent again every 500 ms within the same 30 s; any other answer, and that code for any other
 *    method, is returned at once.
 *
 * Concurrent calls of one server share one wait. NOVELAI_MCP_AUTOSTART=0 turns starting off (waiting for an app that
 * is already starting stays); test processes never start anything unless a test injects its own launcher.
 *
 * While the app installs an update (<data root>/runtime/updating.json, written by the app when it hands over to its
 * update helper: client/electron/update/journal.ts), nothing is started: a start then could run the old version in the
 * middle of the swap, or be ended by the Windows installer. Such a call answers unavailable, details.autostart
 * "updating"; the new version removes the marker once it runs, the helper when it gives up, and it expires after
 * 5 minutes or as soon as the helper is gone.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, readlink, rename, unlink, writeFile } from 'node:fs/promises';
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
/** <data root>/runtime/<UPDATING_FILE>: the app is installing an update (see above). */
export const UPDATING_FILE = 'updating.json';
const UPDATING_MS = 5 * 60_000, HELPER_PID_GRACE_MS = 30_000;

/**
 * Whether the app of this data root is installing an update right now: its marker is well-formed, not expired (nor
 * set more than 5 minutes ahead), and its helper lives (<data root>/updates/<id>/helper-pid) — or, before the helper
 * wrote its pid, the marker is at most 30 s old. The same rule as the app's (client/electron/update/journal.ts).
 */
export async function updateInProgress(dataRoot, { now = Date.now(), isAlive = pid => alive(pid) } = {}) {
  let value;
  try { value = JSON.parse(await readFile(join(dataRoot, 'runtime', UPDATING_FILE), 'utf8')); } catch { return false; }
  if (!value || value.schema !== 1 || typeof value.id !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.id)) return false;
  const started = Date.parse(value.startedAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(started) || !Number.isFinite(expires) || expires <= now || expires - started > UPDATING_MS || started > now + 60_000) return false;
  let helper = null;
  try { const text = (await readFile(join(dataRoot, 'updates', value.id, 'helper-pid'), 'utf8')).trim(); helper = /^\d+$/.test(text) ? Number(text) : null; } catch { helper = null; }
  if (helper === null) return now - started <= HELPER_PID_GRACE_MS;
  return isAlive(helper);
}

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

/** When a process started (ms since the epoch, from `ps -o lstart=`), or null when that cannot be read. */
export function processStartTime(pid) {
  return new Promise(resolve => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }, (error, stdout) => {
      const at = error ? NaN : Date.parse(String(stdout).trim().replace(/\s+/g, ' '));
      resolve(Number.isFinite(at) ? at : null);
    });
  });
}

/**
 * Whether an app runs on this data root (its userData), from Chromium's single-instance lock: on macOS and Linux the
 * symlink SingletonLock -> <host>-<pid>; on Windows the file `lockfile`, which the running instance holds open with
 * delete-on-close. On macOS and Linux the pid must be alive and must be the process that made the lock: a lock left
 * by a crash whose pid now belongs to another process (one that started after the lock was made) is 'absent'.
 * 'running' or 'absent'; anything unreadable is 'absent' (a start then meets the app's own single-instance lock).
 */
export async function appInstanceState(dataRoot, { platform = process.platform, isAlive = alive, startTime = processStartTime, fs = { lstat, readlink } } = {}) {
  try {
    if (platform === 'win32') { await fs.lstat(join(dataRoot, 'lockfile')); return 'running'; }
    const lock = join(dataRoot, 'SingletonLock');
    const target = await fs.readlink(lock);
    const pid = Number(/-(\d+)$/.exec(String(target))?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) return 'absent';
    // The lock is made by its process after that process started (ps gives whole seconds: 5 s of slack).
    const [made, started] = await Promise.all([fs.lstat(lock).then(info => info.mtimeMs, () => null), startTime(pid)]);
    if (made !== null && started !== null && started > made + 5000) return 'absent';
    return 'running';
  } catch { return 'absent'; }
}

/**
 * The claim file of the runtime folder: which server is starting the app right now. claim() takes it (true) unless
 * another server holds it; release() gives it up (only when it is still this server's); fresh() says whether another
 * server holds one. Every claim is one file made at once with its whole content (a hard link of a finished temporary
 * file, which fails when the claim exists), naming {pid, nonce, at}. A claim is held while its pid lives and its time
 * is at most claimMs old and not more than CLOCK_SLACK_MS in the future (a clock set back); anything else is stale. A
 * stale claim is moved aside first (a rename, which only one server can do with that file) and checked to be the one
 * that was judged stale; a claim another server made in between is put back. So of servers that claim at once, exactly
 * one gets it — also past a stale claim.
 */
export const CLOCK_SLACK_MS = 5_000;
export function createStartClaim(runtimeDir, { claimMs = AUTOSTART_LIMITS.claimMs, now = () => Date.now(), pid = process.pid, isAlive = alive } = {}) {
  const file = join(runtimeDir, CLAIM_FILE);
  let mine = null;
  /** {text, pid, at} of a claim file, or null when there is none. A body that cannot be read names no server. */
  const read = async target => {
    let info, text;
    try { [info, text] = await Promise.all([lstat(target), readFile(target, 'utf8')]); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    let body = null;
    try { body = JSON.parse(text); } catch { body = null; }
    const recorded = typeof body?.at === 'number' ? body.at : Date.parse(body?.startedAt ?? '');
    return { text, pid: Number.isSafeInteger(body?.pid) ? body.pid : null, at: Number.isFinite(recorded) ? recorded : info.mtimeMs };
  };
  // A claim without a readable pid (being written on a volume without hard links) is held by its age alone.
  const held = claim => { const age = now() - claim.at; return age <= claimMs && age >= -CLOCK_SLACK_MS && (claim.pid === null || isAlive(claim.pid)); };
  /** Makes `target` with `text` at once, or throws EEXIST. */
  const create = async (target, text) => {
    const temporary = join(runtimeDir, `.${CLAIM_FILE}.${randomUUID()}.tmp`);
    await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    try { await link(temporary, target); }
    catch (error) {
      // A volume without hard links: an exclusive create (its body may be read empty for a moment: held by its mtime then).
      if (['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error?.code)) await writeFile(target, text, { flag: 'wx', mode: 0o600 });
      else throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  };
  /** Moves `claim` aside when it is still the file there; puts back one that turned out to be another one. */
  const takeAway = async claim => {
    const aside = join(runtimeDir, `.${CLAIM_FILE}.${randomUUID()}.stale`);
    try { await rename(file, aside); } catch (error) { if (error?.code === 'ENOENT') return 'gone'; throw error; }
    const moved = await read(aside).catch(() => null);
    if (moved?.text === claim.text) { await unlink(aside).catch(() => undefined); return 'removed'; }
    // Another server's new claim: give it back (if yet another one exists meanwhile, that one stays).
    await link(aside, file).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return 'not_ours';
  };
  return {
    async fresh() { const claim = await read(file).catch(() => null); return Boolean(claim) && claim.pid !== pid && held(claim); },
    async claim() {
      await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      const text = `${JSON.stringify({ pid, nonce: randomUUID(), at: now() })}\n`;
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await create(file, text); mine = text; return true; }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const claim = await read(file);
        if (!claim) continue;
        if (held(claim) && claim.pid !== pid) return false;
        if (await takeAway(claim) === 'not_ours') return false;
      }
      return false;
    },
    async release() {
      if (!mine) return;
      const text = mine; mine = null;
      const claim = await read(file).catch(() => null);
      if (claim?.text === text) await takeAway(claim).catch(() => undefined);
    },
  };
}

const MESSAGES = {
  off: 'The NovelAI app is not running for this data folder, and automatic start is turned off (NOVELAI_MCP_AUTOSTART=0). Nothing was sent. Ask the user to open the app, then call again.',
  off_in_tests: 'The NovelAI app is not running for this data folder; automatic start is off in test runs. Nothing was sent.',
  unsupported: 'The NovelAI app is not running for this data folder, and this server cannot start it: automatic start works only when the MCP server runs with the app\'s own executable (the configurations in Settings › MCP access). Nothing was sent. Ask the user to open the app, then call again.',
  recently_started: 'The NovelAI app is not running. This server tried to start it less than a minute ago and does not try again so soon. Nothing was sent. Call again in a moment, or ask the user to open the app.',
  start_failed: reason => `The NovelAI app is not running, and starting it failed (${reason}). Nothing was sent. Ask the user to open the app, then call again.`,
  started_not_ready: 'The NovelAI app was not running; this server started it in the background, but it was not ready within 30 seconds. Nothing was sent. Call again in a moment; if it keeps failing, ask the user to open the app.',
  started_exited: 'The NovelAI app was not running; this server started it in the background, but it closed again before it was ready. Nothing was sent. Ask the user to open the app and check what it reports.',
  starting_not_ready: 'The NovelAI app is starting but was not ready within 30 seconds. Nothing was sent. Call again in a moment.',
  lost: 'The NovelAI app became ready, but its connection was gone again before this call reached it. Nothing was sent. Call again in a moment.',
  updating: 'The NovelAI app is installing an update and opens again by itself in a moment; this server does not start it meanwhile. Nothing was sent. Call again in a minute.',
};
const unavailable = (state, reason) => new BridgeError('unavailable', typeof MESSAGES[state] === 'function' ? MESSAGES[state](reason) : MESSAGES[state], { autostart: state });
export const AUTOSTART_STATES = Object.freeze(Object.keys(MESSAGES));
/**
 * The host methods whose workspace_not_ready is sent again after a start: the renderer methods of the canvas tools and
 * the canvas capture of prepare_recipe {canvas}. The host answers that code for them before anything runs
 * (client/electron/bridge-host.ts, main.ts); any other method gets it back at once.
 */
export const CANVAS_RETRY_METHODS = Object.freeze(new Set(['list_workspaces', 'read_workspace', 'get_asset', 'capture_canvas_recipe']));
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
  const updating = options.updateInProgress ?? (() => updateInProgress(paths.root));
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
    // The app is installing an update: never a start in the middle of it.
    if (await updating().catch(() => false)) throw unavailable('updating');
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
    try {
      let started;
      try { started = await launcher.launch(app, { client: caller?.client ?? null }); }
      catch (error) { started = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
      if (!started?.ok) { log(`[novelai-mcp] automatic start failed: ${started?.reason ?? 'unknown reason'}`); throw unavailable('start_failed', started?.reason ?? 'unknown reason'); }
      log(`[novelai-mcp] started the app in the background (${app.kind}, via ${started.via}${started.pid ? `, pid ${started.pid}` : ''}); waiting for it`);
      const waited = await waitForBridge({ stale, deadline, startedHere: true });
      if (waited === 'gone') throw unavailable('started_exited');
      if (waited !== 'ready') throw unavailable('started_not_ready');
      return { startedHere: true, deadline };
    } finally {
      // The start is over (ready or not): another server may start it from now on, when it is still needed.
      await claims.release?.().catch(() => undefined);
    }
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
      catch (error) {
        if (error instanceof BridgeError) throw error;
        // Cancelled while waiting: the original failure (nothing was sent). Anything else went wrong in the start itself.
        if (signal?.aborted) throw failure;
        throw unavailable('start_failed', error instanceof Error ? error.message : String(error));
      }
      for (;;) {
        try { return await send(); }
        catch (error) {
          if (undeliveredReason(error)) throw unavailable('lost');
          if (!host.startedHere || !(error instanceof BridgeError) || error.code !== 'workspace_not_ready' || !CANVAS_RETRY_METHODS.has(method)) throw error;
          // Refused before anything ran: the window of the app just started is still loading.
          if (signal?.aborted || monotonicNow() + limits.canvasRetryMs > host.deadline) throw new BridgeError(error.code, `${error.message} ${STILL_LOADING}`, error.details);
          await sleep(limits.canvasRetryMs, signal).catch(() => { throw new BridgeError(error.code, `${error.message} ${STILL_LOADING}`, error.details); });
        }
      }
    },
  };
}
