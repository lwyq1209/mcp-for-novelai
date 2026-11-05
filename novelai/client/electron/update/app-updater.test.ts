// The lock on the rehearsal switches (app-updater.ts): only a build with dist-electron/update-test-mode.json reads the
// NAI_UPDATE_TEST_* variables or hands test switches to the restarted app; a release build hands over only the data
// folder of a custom data root and the project root, as the app had them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ipc/store", () => ({ getSettings: () => ({}) }));
import { isUpdateTestBuild, restartHandOver } from "./app-updater";

const env = { NAI_UPDATE_TEST_FEED: "http://127.0.0.1:4000", NAI_UPDATE_TEST_PUBLIC_KEY: `${"A".repeat(43)}=`, NAI_UPDATE_TEST_MAC_CERT_SHA256: "ab".repeat(32), NAI_DEV_TOOLS_BACKGROUND: "1", NOVELAI_PROJECT_ROOT: "/p", SECRET_TOKEN: "x" };
const argv = ["/app/exe", "--use-mock-keychain", "--remote-debugging-port=9333", "--nai-dev-tools-data=/d", "--inspect=9229", "--updated-from=0.1.2"];
let dir: string | null = null;
afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

describe("the restart hand-over", () => {
  it("of a release build carries no rehearsal variable, no switch and no background start", () => {
    expect(restartHandOver({ testBuild: false, env, argv, customDataRoot: true, dataRoot: "/data" })).toEqual({ env: ["NOVELAI_DATA_DIR=/data", "NOVELAI_PROJECT_ROOT=/p"], args: [], background: false });
    expect(restartHandOver({ testBuild: false, env: {}, argv, customDataRoot: false, dataRoot: "/data" })).toEqual({ env: [], args: [], background: false });
  });

  it("of a rehearsal build carries its variables and test switches only (never other switches or variables)", () => {
    const handOver = restartHandOver({ testBuild: true, env, argv, customDataRoot: true, dataRoot: "/data" });
    expect(handOver.env).toEqual(["NOVELAI_DATA_DIR=/data", "NOVELAI_PROJECT_ROOT=/p", `NAI_UPDATE_TEST_FEED=${env.NAI_UPDATE_TEST_FEED}`, `NAI_UPDATE_TEST_PUBLIC_KEY=${env.NAI_UPDATE_TEST_PUBLIC_KEY}`, `NAI_UPDATE_TEST_MAC_CERT_SHA256=${env.NAI_UPDATE_TEST_MAC_CERT_SHA256}`, "NAI_DEV_TOOLS_BACKGROUND=1"]);
    expect(handOver.args).toEqual(["--use-mock-keychain", "--remote-debugging-port=9333", "--nai-dev-tools-data=/d"]);
    expect(handOver.background).toBe(true);
  });

  it("is a rehearsal build only with the marker file next to the compiled main process", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-marker-"));
    const electronDir = path.join(dir, "electron");
    fs.mkdirSync(electronDir);
    expect(isUpdateTestBuild(electronDir)).toBe(false);
    fs.writeFileSync(path.join(dir, "update-test-mode.json"), "{}");
    expect(isUpdateTestBuild(electronDir)).toBe(true);
  });

  it("is not one in this checkout's normal build (npm run build writes no marker)", () => {
    const built = path.join(process.cwd(), "dist-electron", "electron");
    if (!fs.existsSync(built)) return;
    expect(isUpdateTestBuild(built)).toBe(false);
  });
});
