// "Update and restart" end to end in one process (updater.ts): a loopback release server with a throwaway signing key,
// the Linux staging with a stand-in tar, and stand-ins for the helper start and the quit. Covers the happy path, a
// queue that is busy, every verification failure (nothing staged, the app keeps running), cancellation and a helper
// that does not answer.
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUpdater, type HelperLaunch, type UpdaterOptions, type UpdateProgress } from "./updater";
import type { InstallDeps } from "./install";
import type { UpdateSource } from "./source";
import { readPending } from "./journal";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const asset = Buffer.from("the new version's archive ".repeat(2000));
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const sumsFor = (version: string, file = asset) => Buffer.from(`${sha(file)}  MCP-for-NovelAI-${version}-linux-x64.tar.gz\n${"0".repeat(64)}  MCP-for-NovelAI-${version}-win-x64-setup.exe\n`);
const sigFor = (bytes: Buffer, key = privateKey) => Buffer.from(`${sign(null, bytes, key).toString("base64")}\n`);

let root: string, server: http.Server, origin: string;
let files: Map<string, Buffer>;
let requests: string[];
let latestTag: string;
let slowAsset = false;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nai-updater-")));
  fs.mkdirSync(path.join(root, "apps", "mcp-for-novelai"), { recursive: true });
  latestTag = "v0.1.4";
  files = new Map([["SHA256SUMS.txt", sumsFor("0.1.4")], ["SHA256SUMS.txt.sig", sigFor(sumsFor("0.1.4"))], ["MCP-for-NovelAI-0.1.4-linux-x64.tar.gz", asset]]);
  requests = [];
  slowAsset = false;
  server = http.createServer((request, response) => {
    requests.push(request.url!);
    if (request.url === "/latest") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ tag_name: latestTag, html_url: "https://github.com/lwyq1209/mcp-for-novelai/releases/tag/x" })); return; }
    const file = files.get(path.posix.basename(request.url!));
    if (!file) { response.writeHead(404); response.end(); return; }
    if (slowAsset && request.url!.endsWith(".tar.gz")) { response.writeHead(200, { "content-length": file.length }); response.write(file.subarray(0, 10)); return; }
    response.end(file);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  try { fs.chmodSync(path.join(root, "apps"), 0o755); } catch { /* unchanged */ }
  fs.rmSync(root, { recursive: true, force: true });
});

function source(): UpdateSource {
  return {
    kind: "test", latestApiUrl: `${origin}/latest`, downloadUrl: (tag, file) => `${origin}/dl/${tag}/${file}`,
    allowsDownloadUrl: url => url.origin === origin, releasePageUrl: tag => `${origin}/page/${tag}`, publicKey: rawKey, macCertificateSha256: "0".repeat(64),
  };
}
const tarDeps: InstallDeps = {
  fs: { mkdtemp: p => fsp.mkdtemp(p), mkdir: (d, o) => fsp.mkdir(d, o), rm: (t, o) => fsp.rm(t, o), rename: (a, b) => fsp.rename(a, b), readdir: d => fsp.readdir(d), lstat: t => fsp.lstat(t), readFile: f => fsp.readFile(f), writeFile: (f, d, o) => fsp.writeFile(f, d, o), access: (t, m) => fsp.access(t, m) },
  async run(command, args) {
    if (command !== "/usr/bin/tar" && command !== "/bin/tar") return { code: 127, stdout: "", stderr: "" };
    const folder = path.join(args[3], "MCP-for-NovelAI-0.1.4-linux-x64");
    fs.mkdirSync(path.join(folder, "resources"), { recursive: true });
    fs.writeFileSync(path.join(folder, "mcp-for-novelai"), "#!/bin/sh\n", { mode: 0o755 });
    return { code: 0, stdout: "", stderr: "" };
  },
  packagedVersion: async () => "0.1.4",
  exists: file => file === "/usr/bin/tar",
};

interface Harness { updater: ReturnType<typeof createUpdater>; launches: HelperLaunch[]; quits: number; events: UpdateProgress[]; busy: { value: boolean }; holds: boolean[] }
function harness(overrides: Partial<UpdaterOptions> = {}, helperAnswers = true): Harness {
  const h: Harness = { updater: null as any, launches: [], quits: 0, events: [], busy: { value: false }, holds: [] };
  h.updater = createUpdater({
    source: source(), currentVersion: "0.1.3", platform: "linux", arch: "x64", execPath: path.join(root, "apps", "mcp-for-novelai", "mcp-for-novelai"), packaged: true, pid: 4242,
    updatesDir: path.join(root, "data", "updates"), installDeps: tarDeps,
    env: { PATH: "/usr/bin", HOME: "/home/u", ELECTRON_RUN_AS_NODE: "1", NOVELAI_DATA_DIR: path.join(root, "data"), DISPLAY: ":1", BASH_ENV: "/tmp/hook", "BASH_FUNC_mv%%": "() { :; }", OPENAI_API_KEY: "secret", HTTPS_PROXY: "http://p" },
    fetchLatest: async () => { const response = await fetch(`${origin}/latest`); const data = await response.json(); return { tag: data.tag_name, releaseUrl: data.html_url }; },
    requestConfig: () => ({}), queueBusy: () => h.busy.value, holdQueue: hold => { h.holds.push(hold); }, quit: () => { h.quits++; },
    async startHelper(launch) {
      h.launches.push(launch);
      if (helperAnswers) fs.writeFileSync(path.join(launch.cwd, "helper-state"), "waiting\n");
      return { ok: true };
    },
    emit: progress => h.events.push(progress), log: () => {}, launchEnv: () => [`NOVELAI_DATA_DIR=${path.join(root, "data")}`], launchArgs: () => [], background: false, sleep: async () => {},
    ...overrides,
  });
  return h;
}
const staging = () => fs.readdirSync(path.join(root, "apps")).filter(name => name.startsWith(".mcp-for-novelai-update-"));

// POSIX paths and permissions (the Windows installer path is covered by the Windows CI rehearsal).
describe.runIf(process.platform !== "win32")("Update and restart", () => {
  it("downloads, verifies, stages next to the app, hands over to the helper and quits", async () => {
    const h = harness();
    const result = await h.updater.start();
    expect(result.phase).toBe("installing");
    expect(h.quits).toBe(1);
    expect(requests).toEqual(["/latest", "/dl/v0.1.4/SHA256SUMS.txt", "/dl/v0.1.4/SHA256SUMS.txt.sig", "/dl/v0.1.4/MCP-for-NovelAI-0.1.4-linux-x64.tar.gz"]);
    expect(h.events.map(event => event.phase)).toEqual(expect.arrayContaining(["checking", "downloading", "verifying", "preparing", "installing"]));
    const [launch] = h.launches;
    const pending = readPending(path.join(root, "data", "updates"))!;
    expect(pending).toMatchObject({ platform: "linux", from: "0.1.3", to: "0.1.4", target: path.join(root, "apps", "mcp-for-novelai") });
    expect(launch.command).toBe(fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh");
    expect(launch.args).toEqual(["-p", path.join(pending.stateDir, "helper.sh"), "linux", pending.stateDir, "4242", pending.target, pending.staging, "0.1.3", "0.1.4", "mcp-for-novelai", "0", "-"]);
    expect(fs.readFileSync(launch.args[1], "utf8")).toMatch(/^#!\/bin\/sh/);
    // The helper runs with a minimal environment; the restarted app gets the session it needs and the data folder.
    expect(launch.env).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/home/u" });
    const appEnv = fs.readFileSync(path.join(pending.stateDir, "launch.env"), "utf8").trim().split("\n");
    expect(appEnv).toEqual(expect.arrayContaining(["PATH=/usr/bin", "HOME=/home/u", "DISPLAY=:1", `NOVELAI_DATA_DIR=${path.join(root, "data")}`]));
    expect(appEnv.some(line => /^(ELECTRON_RUN_AS_NODE|BASH_ENV|BASH_FUNC_|OPENAI_API_KEY|HTTPS_PROXY)/.test(line))).toBe(false);
    // The queue was held from the hand-over on; the marker says an update is being installed.
    expect(h.holds).toEqual([true]);
    const marker = JSON.parse(fs.readFileSync(path.join(root, "data", "runtime", "updating.json"), "utf8"));
    expect(marker).toMatchObject({ schema: 1, id: pending.id, pid: 4242, from: "0.1.3", to: "0.1.4" });
    expect(Date.parse(marker.expiresAt) - Date.parse(marker.startedAt)).toBe(5 * 60_000);
    expect(fs.existsSync(path.join(pending.staging!, "new", "mcp-for-novelai", "mcp-for-novelai"))).toBe(true);
    expect(fs.readFileSync(path.join(root, "data", "updates", "downloads", "MCP-for-NovelAI-0.1.4-linux-x64.tar.gz")).equals(asset)).toBe(true);
  });

  it("waits while the queue is busy, then installs on the next click", async () => {
    const h = harness();
    h.busy.value = true;
    const ready = await h.updater.start();
    expect([ready.phase, ready.queueBusy]).toEqual(["ready", true]);
    expect(h.quits).toBe(0);
    expect(h.launches).toEqual([]);
    expect(staging().length).toBe(1);
    // A click while it is still busy does nothing.
    expect((await h.updater.start()).queueBusy).toBe(true);
    h.busy.value = false;
    h.updater.queueChanged();
    expect(h.events.at(-1)).toMatchObject({ phase: "ready", queueBusy: false });
    expect((await h.updater.start()).phase).toBe("installing");
    expect(h.quits).toBe(1);
  });

  it("stops at a signature of another key, a downgrade or a replayed manifest, a tampered file: nothing staged, the app keeps running", async () => {
    const attempt = async () => { const h = harness(); const result = await h.updater.start(); return { result, h }; };
    files.set("SHA256SUMS.txt.sig", sigFor(sumsFor("0.1.4"), generateKeyPairSync("ed25519").privateKey));
    let { result, h } = await attempt();
    expect([result.phase, result.error?.code, result.error?.reason]).toEqual(["failed", "verify_failed", "signature_invalid"]);
    expect(requests.some(url => url.endsWith(".tar.gz"))).toBe(false);

    // The latest release is older than the running app (a downgrade): no update at all.
    latestTag = "v0.1.2";
    ({ result } = await attempt());
    expect(result.error?.code).toBe("no_update");

    // A newer tag serving an older, correctly signed manifest (replay).
    latestTag = "v0.1.9";
    files.set("SHA256SUMS.txt", sumsFor("0.1.4")); files.set("SHA256SUMS.txt.sig", sigFor(sumsFor("0.1.4")));
    ({ result } = await attempt());
    expect([result.error?.code, result.error?.reason]).toEqual(["verify_failed", "version_mismatch"]);

    // A release file changed after it was signed.
    latestTag = "v0.1.4";
    files.set("MCP-for-NovelAI-0.1.4-linux-x64.tar.gz", Buffer.concat([asset, Buffer.from("x")]));
    ({ result, h } = await attempt());
    expect([result.error?.code, result.error?.reason]).toEqual(["verify_failed", "checksum_mismatch"]);
    expect(h.quits).toBe(0);
    expect(staging()).toEqual([]);
    expect(readPending(path.join(root, "data", "updates"))).toBeNull();
  });

  it("withdraws the update and does not quit when a batch arrives while it is handed over (the hold lifted again)", async () => {
    let checks = 0;
    const h = harness({
      queueBusy: () => { checks++; return h.busy.value; },
      async startHelper(launch) {
        h.launches.push(launch);
        // An agent enqueues a batch while the helper is starting (before it writes its first state); once.
        if (h.launches.length === 1) h.busy.value = true;
        setTimeout(() => fs.writeFileSync(path.join(launch.cwd, "helper-state"), "waiting\n"), 300);
        return { ok: true };
      },
      sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 50))),
    });
    const result = await h.updater.start();
    expect({ phase: result.phase, queueBusy: result.queueBusy, quits: h.quits }).toEqual({ phase: "ready", queueBusy: true, quits: 0 });
    expect(checks).toBeGreaterThanOrEqual(3);
    expect(h.holds).toEqual([true, false]);
    // Withdrawn: the helper finds its state folder and pending.json gone and stops; the marker is gone too.
    expect(readPending(path.join(root, "data", "updates"))).toBeNull();
    expect(fs.existsSync(h.launches[0].cwd)).toBe(false);
    expect(fs.existsSync(path.join(root, "data", "runtime", "updating.json"))).toBe(false);
    // The staged version stays; once the queue is idle the next click installs it.
    expect(staging().length).toBe(1);
    h.busy.value = false;
    expect((await h.updater.start()).phase).toBe("installing");
    expect(h.quits).toBe(1);
    expect(h.holds).toEqual([true, false, true]);
  });

  it("checks the downloaded file once more before the hand-over and installs nothing when it changed", async () => {
    const h = harness();
    h.busy.value = true;
    expect((await h.updater.start()).phase).toBe("ready");
    fs.appendFileSync(path.join(root, "data", "updates", "downloads", "MCP-for-NovelAI-0.1.4-linux-x64.tar.gz"), "x");
    h.busy.value = false;
    const result = await h.updater.start();
    expect([result.phase, result.error?.code, result.error?.reason]).toEqual(["failed", "verify_failed", "package_invalid"]);
    expect(h.quits).toBe(0);
    expect(h.launches).toEqual([]);
    expect(h.holds).toEqual([]);
    expect(staging()).toEqual([]);
  });

  it("offers only the download page where the app cannot replace itself", async () => {
    if (process.getuid?.() === 0) return;
    fs.chmodSync(path.join(root, "apps"), 0o555);
    const h = harness();
    expect(await h.updater.support()).toEqual({ supported: false, reason: "not_writable" });
    const result = await h.updater.start();
    expect([result.phase, result.error?.code, result.error?.reason]).toEqual(["failed", "install_unsupported", "not_writable"]);
    expect(requests).toEqual([]);
  });

  it("cancels a download (the partial file stays for a later try) and removes nothing else", async () => {
    slowAsset = true;
    const h = harness();
    const pending = h.updater.start();
    const until = Date.now() + 5000;
    while (!requests.some(url => url.endsWith(".tar.gz")) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await h.updater.cancel()).phase).toBe("idle");
    expect((await pending).phase).toBe("idle");
    expect(fs.existsSync(path.join(root, "data", "updates", "downloads", "MCP-for-NovelAI-0.1.4-linux-x64.tar.gz.part"))).toBe(true);
    expect(h.quits).toBe(0);
  });

  it("does not quit when the helper does not answer, and withdraws the update", async () => {
    const h = harness({}, false);
    const realNow = Date.now;
    let fake = realNow();
    Date.now = () => (fake += 1000);
    try {
      const result = await h.updater.start();
      expect([result.phase, result.error?.code]).toEqual(["failed", "install_failed"]);
    } finally { Date.now = realNow; }
    expect(h.quits).toBe(0);
    expect(readPending(path.join(root, "data", "updates"))).toBeNull();
    expect(fs.existsSync(h.launches[0].cwd)).toBe(false);
    expect(h.holds).toEqual([true, false]);
    expect(fs.existsSync(path.join(root, "data", "runtime", "updating.json"))).toBe(false);
  });
});
