// The release side of the update signature with a throwaway key. update-signature.mjs: the format, verify and the
// OpenSSL check docs/updates.md documents, and its CLI also when it is run through a symbolic link or a relative path.
// sign-release.mjs (the maintainer's OFFLINE signing, against a fake gh serving a local folder): what it uploads is
// what the app accepts, and it signs nothing that is not a draft, not the app's key, not listed or not as downloaded.
// Also the macOS signing hook's refusal to sign ad-hoc when the certificate secrets are missing (scripts/mac-sign.mjs).
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumsSignatureValid, ed25519PublicKey, updateAssetName, verifyReleaseManifest } from "./release-files";
import { OFFICIAL_UPDATE_PUBLIC_KEY } from "./source";

const repo = path.resolve(__dirname, "..", "..", "..", "..");
const script = path.join(repo, ".github", "scripts", "update-signature.mjs");
const signer = path.join(repo, ".github", "scripts", "sign-release.mjs");
const fakeGh = path.join(repo, "novelai", "client", "dev-tools", "lib", "fake-gh.mjs");
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-signing-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const node = (args: string[], env: Record<string, string | undefined> = {}, file = script, cwd?: string) => spawnSync(process.execPath, [file, ...args], { encoding: "utf8", cwd, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env } });
const keygen = (name = "key.pem") => {
  const out = node(["keygen", "--out", path.join(dir, name)]);
  expect(out.status, out.stderr).toBe(0);
  return { file: path.join(dir, name), publicKey: JSON.parse(out.stdout).publicKey as string };
};

describe("update-signature.mjs", () => {
  it("keygen makes a throwaway key (mode 600, never printed); verify accepts only its signature", async () => {
    const { signatureText, privateKeyFromPem } = await import("../../../../.github/scripts/update-signature.mjs");
    const key = keygen();
    expect(key.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    if (process.platform !== "win32") expect(fs.statSync(key.file).mode & 0o777).toBe(0o600);
    expect(node(["public-key", "--key", key.file]).stdout).toContain(key.publicKey);
    expect(node(["public-key", "--key", key.file]).stdout).not.toContain("PRIVATE KEY");
    const sums = path.join(dir, "SHA256SUMS.txt"), sig = path.join(dir, "SHA256SUMS.txt.sig");
    fs.writeFileSync(sums, `${"a".repeat(64)}  MCP-for-NovelAI-0.1.3-mac-arm64.zip\n`);
    fs.writeFileSync(sig, signatureText(fs.readFileSync(sums), privateKeyFromPem(fs.readFileSync(key.file, "utf8"))));
    expect(fs.readFileSync(sig, "utf8")).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
    expect(checksumsSignatureValid(fs.readFileSync(sums), fs.readFileSync(sig), ed25519PublicKey(key.publicKey)!)).toBe(true);
    expect(node(["verify", "--in", sums, "--sig", sig, "--public-key", key.publicKey]).status).toBe(0);
    // Not with the official key (the default), and not after a change.
    const official = node(["verify", "--in", sums, "--sig", sig]);
    expect([official.status, JSON.parse(official.stdout)]).toEqual([1, { ok: false, verified: "SHA256SUMS.txt", publicKey: OFFICIAL_UPDATE_PUBLIC_KEY }]);
    fs.appendFileSync(sums, "x");
    expect(node(["verify", "--in", sums, "--sig", sig, "--public-key", key.publicKey]).status).toBe(1);
    // Nothing signs any more: the CI signing commands are gone.
    expect(node(["sign", "--in", sums, "--out", path.join(dir, "s")]).status).toBe(1);
    expect(node(["release", "--dir", dir]).status).toBe(1);
    expect(fs.existsSync(path.join(dir, "s"))).toBe(false);
  });

  it("runs its command also through a symbolic link and a relative path (P2-3), and not when imported", async () => {
    const { isEntryScript } = await import("../../../../.github/scripts/update-signature.mjs");
    const link = path.join(dir, "link.mjs");
    let linked = true;
    try { fs.symlinkSync(script, link); } catch { linked = false; }
    if (linked) {
      const viaLink = node(["keygen", "--out", path.join(dir, "a.pem")], {}, link);
      expect(viaLink.status, viaLink.stderr).toBe(0);
      expect(JSON.parse(viaLink.stdout).ok).toBe(true);
      expect(isEntryScript(pathToFileURL(script).href, link)).toBe(true);
    }
    const relative = path.relative(dir, script);
    const viaRelative = node(["keygen", "--out", "b.pem"], {}, relative, dir);
    expect(viaRelative.status, viaRelative.stderr).toBe(0);
    expect(fs.existsSync(path.join(dir, "b.pem"))).toBe(true);
    // A usage error is an error, not silence (silence was the symptom: main() never ran).
    const usage = node(["nope"], {}, relative, dir);
    expect([usage.status, usage.stderr]).toEqual([1, expect.stringMatching(/usage:/)]);
    expect(isEntryScript("file:///nowhere/x.mjs", script)).toBe(false);
    expect(isEntryScript("file:///nowhere/x.mjs", undefined)).toBe(false);
  });

  it("matches the documented OpenSSL check (where this OpenSSL has Ed25519 raw-input verification)", async () => {
    const { opensslVerifies, signatureText, privateKeyFromPem } = await import("../../../../.github/scripts/update-signature.mjs");
    const key = keygen();
    const sums = path.join(dir, "SHA256SUMS.txt"), sig = path.join(dir, "SHA256SUMS.txt.sig");
    fs.writeFileSync(sums, `${"b".repeat(64)}  MCP-for-NovelAI-0.1.3-linux-x64.tar.gz\n`);
    fs.writeFileSync(sig, signatureText(fs.readFileSync(sums), privateKeyFromPem(fs.readFileSync(key.file, "utf8"))));
    const result = opensslVerifies(sums, sig, key.publicKey);
    if (result === null) return;
    expect(result).toBe(true);
    expect(opensslVerifies(sums, sig, OFFICIAL_UPDATE_PUBLIC_KEY)).toBe(false);
  });
});

describe("sign-release.mjs (offline signing of a draft, against a fake gh)", () => {
  const version = "9.9.9", tag = `v${version}`;
  const names = ["darwin/arm64", "darwin/x64", "win32/x64", "linux/x64"].map(pair => updateAssetName(pair.split("/")[0] as NodeJS.Platform, pair.split("/")[1], version)!);
  function draft({ isDraft = true, extra = [] as string[], sizes = undefined as Record<string, number> | undefined, omit = [] as string[] } = {}) {
    const ghRoot = path.join(dir, "gh"), assets = path.join(ghRoot, tag, "assets");
    fs.mkdirSync(assets, { recursive: true });
    fs.writeFileSync(path.join(ghRoot, tag, "release.json"), JSON.stringify({ isDraft, sizes }));
    const files = [...names, `third-party-sources-${version}.tar.gz`];
    const lines = files.map(name => { const bytes = Buffer.from(`content of ${name}`); fs.writeFileSync(path.join(assets, name), bytes); return `${createHash("sha256").update(bytes).digest("hex")}  ${name}`; });
    fs.writeFileSync(path.join(assets, "SHA256SUMS.txt"), `${lines.filter(line => !omit.some(name => line.endsWith(name))).sort((a, b) => a.slice(66).localeCompare(b.slice(66))).join("\n")}\n`);
    for (const name of extra) fs.writeFileSync(path.join(assets, name), "extra");
    return { ghRoot, assets };
  }
  const sign = (key: { file: string; publicKey?: string }, ghRoot: string, extra: string[] = []) => node([tag, "--key", key.file, "--gh", fakeGh, ...(key.publicKey ? ["--expect-public-key", key.publicKey] : []), ...extra], { FAKE_GH_ROOT: ghRoot }, signer);

  it("signs the draft's SHA256SUMS.txt so that the app accepts the release, and never prints the key", () => {
    const key = keygen(), { ghRoot, assets } = draft();
    const result = sign(key, ghRoot);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, tag, version, files: 5, publicKey: key.publicKey });
    const pem = fs.readFileSync(key.file, "utf8");
    for (const line of pem.split("\n").filter(line => line && !line.startsWith("-----"))) expect(`${result.stdout}${result.stderr}`).not.toContain(line);
    expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE KEY");
    // The uploaded signature is what the app checks: it accepts the release for every platform.
    const checksums = fs.readFileSync(path.join(assets, "SHA256SUMS.txt")), signature = fs.readFileSync(path.join(assets, "SHA256SUMS.txt.sig"));
    for (const [platform, arch] of [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"], ["linux", "x64"]] as const)
      expect(verifyReleaseManifest({ tag, checksums, signature, publicKey: ed25519PublicKey(key.publicKey)!, currentVersion: "0.1.3", platform, arch }).asset).toBe(updateAssetName(platform, arch, version));
    // gh was asked for the draft, every listed file, the upload (--clobber) and the read-back.
    const calls = fs.readFileSync(path.join(ghRoot, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]);
    expect(calls.filter(call => call[1] === "download").map(call => call[call.indexOf("--pattern") + 1])).toEqual(["SHA256SUMS.txt", ...[...names, `third-party-sources-${version}.tar.gz`].sort(), "SHA256SUMS.txt", "SHA256SUMS.txt.sig"]);
    expect(calls.find(call => call[1] === "upload")).toEqual(["release", "upload", tag, expect.stringMatching(/SHA256SUMS\.txt\.sig$/), "--repo", "lwyq1209/mcp-for-novelai", "--clobber"]);
    // Signing again replaces the signature (--clobber).
    expect(sign(key, ghRoot).status).toBe(0);
  });

  it("refuses: a key that is not the app's, a readable key file, a published release, unlisted, missing, resized or changed files", () => {
    const key = keygen();
    const refused = (result: ReturnType<typeof node>, pattern: RegExp, ghRoot?: string) => {
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toMatch(pattern);
      if (ghRoot) expect(fs.existsSync(path.join(ghRoot, tag, "assets", "SHA256SUMS.txt.sig"))).toBe(false);
    };
    let world = draft();
    refused(sign({ file: key.file }, world.ghRoot), /is not the one built into the app/, world.ghRoot);
    if (process.platform !== "win32") {
      fs.chmodSync(key.file, 0o644);
      refused(sign(key, world.ghRoot), /readable by group or others/, world.ghRoot);
      fs.chmodSync(key.file, 0o600);
    }
    refused(sign({ file: path.join(dir, "none.pem"), publicKey: key.publicKey }, world.ghRoot), /cannot be read/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft({ isDraft: false });
    refused(sign(key, world.ghRoot), /is not a draft/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft({ extra: ["MCP-for-NovelAI-9.9.9-mac-arm64.dmg"] });
    refused(sign(key, world.ghRoot), /does not list: MCP-for-NovelAI-9\.9\.9-mac-arm64\.dmg/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft({ omit: [names[2]] });
    fs.rmSync(path.join(world.assets, names[2]));
    refused(sign(key, world.ghRoot), /does not list MCP-for-NovelAI-9\.9\.9-win-x64-setup\.exe/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft({ sizes: { [names[0]]: 3 } });
    refused(sign(key, world.ghRoot), /the draft reports 3/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft();
    fs.appendFileSync(path.join(world.assets, names[3]), "!");
    refused(sign(key, world.ghRoot), /SHA256SUMS\.txt says/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft();
    fs.writeFileSync(path.join(world.assets, "SHA256SUMS.txt"), fs.readFileSync(path.join(world.assets, "SHA256SUMS.txt"), "utf8").replaceAll("9.9.9", "9.9.8"));
    refused(sign(key, world.ghRoot), /not of 9\.9\.9/, world.ghRoot);
    fs.rmSync(path.join(dir, "gh"), { recursive: true });
    world = draft();
    refused(node(["v9.9", "--key", key.file, "--gh", fakeGh], { FAKE_GH_ROOT: world.ghRoot }, signer), /is not a release tag/, world.ghRoot);
    refused(node([tag, "--key", key.file, "--sign-anyway", "1"], { FAKE_GH_ROOT: world.ghRoot }, signer), /unknown option --sign-anyway/, world.ghRoot);
  });
});

describe("mac-sign.mjs", () => {
  it("signs with the certificate only when asked, and then never falls back to ad-hoc", async () => {
    const { signingRequest } = await import("../../scripts/mac-sign.mjs");
    expect(signingRequest({})).toEqual({ mode: "adhoc" });
    expect(signingRequest({ NAI_MAC_SIGNING: "certificate", MAC_CSC_LINK: "QUJD", MAC_CSC_KEY_PASSWORD: "pw" })).toEqual({ mode: "certificate", link: "QUJD", password: "pw" });
    for (const env of [{ NAI_MAC_SIGNING: "certificate" }, { NAI_MAC_SIGNING: "certificate", MAC_CSC_LINK: "QUJD" }, { NAI_MAC_SIGNING: "certificate", MAC_CSC_LINK: " ", MAC_CSC_KEY_PASSWORD: "pw" }, { NAI_MAC_SIGNING: "certificate", MAC_CSC_LINK: "QUJD", MAC_CSC_KEY_PASSWORD: "" }])
      expect(() => signingRequest(env), JSON.stringify(env)).toThrow(/needs MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD/);
  });
});
