// The update helper's environment and the restarted app's (P3-3): never the app's whole environment.
import { describe, expect, it } from "vitest";
import { HELPER_PATH, handOverObject, helperEnvironment, linuxAppEnvironment } from "./environment";

const appEnv = {
  PATH: "/home/u/bin:/usr/bin", HOME: "/home/u", USER: "u", LOGNAME: "u", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", TMPDIR: "/tmp/u",
  DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", GTK_IM_MODULE: "fcitx",
  BASH_ENV: "/tmp/evil.sh", ENV: "/tmp/evil.sh", "BASH_FUNC_mv%%": "() { echo hijacked; }", SHELLOPTS: "xtrace", IFS: " ", PS4: "$(evil)",
  ELECTRON_RUN_AS_NODE: "1", ELECTRON_ENABLE_LOGGING: "1", NODE_OPTIONS: "--require /tmp/x.js", LD_PRELOAD: "/tmp/x.so", DYLD_INSERT_LIBRARIES: "/tmp/x.dylib",
  OPENAI_API_KEY: "sk-secret", GITHUB_TOKEN: "ghp_x", HTTPS_PROXY: "http://proxy", http_proxy: "http://proxy", AWS_SECRET_ACCESS_KEY: "x",
  NOVELAI_DATA_DIR: "/data/custom", LC_BAD: "a\nb",
};
const handOver = ["NOVELAI_DATA_DIR=/data/custom", "NOVELAI_PROJECT_ROOT=/projects/p", "bad line", "1X=no", "NAI_UPDATE_TEST_SOURCE=http://127.0.0.1:1"];

describe("the update helper's environment", () => {
  it("POSIX: a fixed PATH and the user's locale and folders only; nothing that changes how a shell runs", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(helperEnvironment(platform, appEnv, handOver)).toEqual({ PATH: HELPER_PATH, HOME: "/home/u", USER: "u", LOGNAME: "u", LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", TMPDIR: "/tmp/u" });
    }
  });

  it("Windows: the system's folders and facts plus the hand-over lines (the restarted app gets it through WMI)", () => {
    const env = { SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", Path: "C:\\Windows\\system32", PATHEXT: ".COM;.EXE", TEMP: "C:\\T", TMP: "C:\\T",
      USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\Users\\u\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules",
      "ProgramFiles(x86)": "C:\\Program Files (x86)", NUMBER_OF_PROCESSORS: "8", PROCESSOR_ARCHITECTURE: "AMD64", OS: "Windows_NT",
      PSExecutionPolicyPreference: "Unrestricted", ELECTRON_RUN_AS_NODE: "1", OPENAI_API_KEY: "x", HTTPS_PROXY: "http://p", NOVELAI_DATA_DIR: "D:\\old", BASH_ENV: "x" };
    const helper = helperEnvironment("win32", env, ["NOVELAI_DATA_DIR=D:\\data"]);
    expect(Object.keys(helper).sort()).toEqual(["APPDATA", "ComSpec", "LOCALAPPDATA", "NOVELAI_DATA_DIR", "NUMBER_OF_PROCESSORS", "OS", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PSModulePath", "Path", "ProgramFiles(x86)", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "windir"].sort());
    expect(helper.NOVELAI_DATA_DIR).toBe("D:\\data");
    // Case-insensitive names: one PATH only.
    expect(Object.keys(helperEnvironment("win32", { PATH: "a", Path: "b" }, []))).toHaveLength(1);
  });

  it("Linux: the restarted app gets the desktop session and the hand-over lines, never credentials, proxies or hooks", () => {
    const lines = linuxAppEnvironment(appEnv, handOver);
    expect(lines).toEqual(expect.arrayContaining(["PATH=/home/u/bin:/usr/bin", "HOME=/home/u", "DISPLAY=:0", "WAYLAND_DISPLAY=wayland-0", "XDG_RUNTIME_DIR=/run/user/1000",
      "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus", "GTK_IM_MODULE=fcitx", "NOVELAI_DATA_DIR=/data/custom", "NOVELAI_PROJECT_ROOT=/projects/p", "NAI_UPDATE_TEST_SOURCE=http://127.0.0.1:1"]));
    const names = lines.map(line => line.slice(0, line.indexOf("=")));
    for (const name of ["BASH_ENV", "ENV", "BASH_FUNC_mv%%", "SHELLOPTS", "IFS", "PS4", "ELECTRON_RUN_AS_NODE", "ELECTRON_ENABLE_LOGGING", "NODE_OPTIONS", "LD_PRELOAD", "OPENAI_API_KEY", "GITHUB_TOKEN", "HTTPS_PROXY", "http_proxy", "AWS_SECRET_ACCESS_KEY", "LC_BAD"])
      expect(names, name).not.toContain(name);
    expect(lines.every(line => !/[\r\n\0]/.test(line))).toBe(true);
  });

  it("reads only NAME=value hand-over lines", () => {
    expect(handOverObject(["A=1", "B=", "=x", "C", "1D=2", "E=a=b", "F=x\ny"])).toEqual({ A: "1", B: "", E: "a=b" });
  });
});
