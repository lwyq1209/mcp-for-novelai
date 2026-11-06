// The environments of the update helper and of the app it starts again (pure). Never the app's whole environment:
// the helper runs `mv` and `rm -rf`, so nothing that changes how a shell runs (BASH_ENV, ENV, exported shell functions,
// SHELLOPTS…) reaches it, and no credential, proxy or Electron switch reaches either of them — the same lists as the
// MCP server's automatic start of the app (novelai/src/app-launch.mjs appEnvironment).
//
// - POSIX helper: a fixed PATH and the user's HOME, TMPDIR, USER, LOGNAME, LANG and LC_* only.
// - Linux restarted app (launch.env, started with `env -i`): the session variables a desktop app needs (display, session
//   bus, XDG folders, input methods, scaling) plus the hand-over lines (NOVELAI_DATA_DIR of a custom data root,
//   NOVELAI_PROJECT_ROOT, a rehearsal build's test variables).
// - Windows helper (and so the restarted app, which gets the helper's environment through WMI): Windows' system
//   folders, user profile and processor facts, PowerShell's module path and module analysis cache (without the cache
//   a cold PowerShell analyses every installed module first: 25 s on a CI runner), plus the same hand-over lines.
// - macOS restarted app: LaunchServices gives it the user session's environment; `open --env` adds the hand-over lines.
export const HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const KEEP = {
  win32: /^(SystemRoot|windir|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|USERNAME|USERDOMAIN|COMPUTERNAME|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|ProgramData|ALLUSERSPROFILE|PUBLIC|SystemDrive|PSModulePath|PSModuleAnalysisCachePath|NUMBER_OF_PROCESSORS|PROCESSOR_[A-Z0-9_]+|OS)$/i,
  linuxApp: /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TMPDIR|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_[A-Z0-9_]+|DBUS_SESSION_BUS_ADDRESS|DESKTOP_SESSION|GNOME_DESKTOP_SESSION_ID|KDE_FULL_SESSION|KDE_SESSION_VERSION|GTK_IM_MODULE|QT_IM_MODULE|XMODIFIERS|SDL_IM_MODULE|GDK_SCALE|GDK_DPI_SCALE|QT_SCALE_FACTOR|QT_AUTO_SCREEN_SCALE_FACTOR)$/,
  posixHelper: /^(HOME|TMPDIR|USER|LOGNAME|LANG|LC_[A-Z_]+)$/,
};
/** Never passed, even when a name above would match: credentials, proxies, Electron switches, shell start-up hooks. */
const NEVER = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PROXY|^ELECTRON_|^BASH_ENV$|^ENV$|^BASH_FUNC_|^SHELLOPTS$|^BASHOPTS$|^PS4$|^IFS$|^CDPATH$|^GLOBIGNORE$/i;
/** A value that can be one line of launch.env / one environment string. */
const plainValue = (value: unknown): value is string => typeof value === "string" && !/[\0\r\n]/.test(value);

function pick(env: Record<string, string | undefined>, keep: RegExp, caseless: boolean) {
  const kept: Record<string, string> = {}, seen = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!keep.test(key) || NEVER.test(key) || !plainValue(value)) continue;
    const id = caseless ? key.toUpperCase() : key;
    if (seen.has(id)) continue;
    seen.add(id); kept[key] = value;
  }
  return kept;
}

/** NAME=value hand-over lines as an object (only plain names and one-line values). */
export function handOverObject(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of lines) { const at = line.indexOf("="); const key = line.slice(0, at); if (at > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && plainValue(line.slice(at + 1))) out[key] = line.slice(at + 1); }
  return out;
}

/** The environment the helper runs with. */
export function helperEnvironment(platform: NodeJS.Platform, env: Record<string, string | undefined>, handOver: string[]): Record<string, string> {
  if (platform === "win32") return { ...pick(env, KEEP.win32, true), ...handOverObject(handOver) };
  return { PATH: HELPER_PATH, ...pick(env, KEEP.posixHelper, false) };
}

/** Linux: the NAME=value lines of the restarted app (launch.env; the helper starts it with `env -i` and these). */
export function linuxAppEnvironment(env: Record<string, string | undefined>, handOver: string[]): string[] {
  return Object.entries({ ...pick(env, KEEP.linuxApp, false), ...handOverObject(handOver) }).map(([key, value]) => `${key}=${value}`);
}
