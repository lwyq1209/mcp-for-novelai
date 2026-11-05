// The release side of the update signature (.github/scripts/update-signature.mjs) with a throwaway key: what it writes
// is what the app accepts, a missing key fails, and OpenSSL verifies it with the documented command. Also the macOS
// signing hook's refusal to sign ad-hoc when the certificate secrets are missing (scripts/mac-sign.mjs).
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checksumsSignatureValid, ed25519PublicKey } from "./release-files";
import { OFFICIAL_UPDATE_PUBLIC_KEY } from "./source";

const repo = path.resolve(__dirname, "..", "..", "..", "..");
const script = path.join(repo, ".github", "scripts", "update-signature.mjs");
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-signing-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const node = (args: string[], env: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

describe("update-signature.mjs", () => {
  it("signs SHA256SUMS.txt so that the app accepts it, without printing the key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const sums = path.join(dir, "SHA256SUMS.txt"), sig = path.join(dir, "SHA256SUMS.txt.sig");
    fs.writeFileSync(sums, `${"a".repeat(64)}  MCP-for-NovelAI-0.1.3-mac-arm64.zip\n`);
    const signed = node(["sign", "--in", sums, "--out", sig], { UPDATE_SIGNING_KEY: pem });
    expect(signed.status, signed.stderr).toBe(0);
    expect(`${signed.stdout}${signed.stderr}`).not.toContain("PRIVATE KEY");
    const { publicKey } = JSON.parse(signed.stdout);
    expect(fs.readFileSync(sig, "utf8")).toMatch(/^[A-Za-z0-9+/]{86}==\n$/);
    expect(checksumsSignatureValid(fs.readFileSync(sums), fs.readFileSync(sig), ed25519PublicKey(publicKey)!)).toBe(true);
    expect(node(["verify", "--in", sums, "--sig", sig, "--public-key", publicKey]).status).toBe(0);
    // Not with the official key, and not after a change.
    expect(node(["verify", "--in", sums, "--sig", sig, "--public-key", OFFICIAL_UPDATE_PUBLIC_KEY]).status).toBe(1);
    fs.appendFileSync(sums, "x");
    expect(node(["verify", "--in", sums, "--sig", sig, "--public-key", publicKey]).status).toBe(1);
  });

  it("fails without a key or with a key that is not Ed25519 (a release is never published unsigned)", () => {
    const sums = path.join(dir, "SHA256SUMS.txt");
    fs.writeFileSync(sums, "x\n");
    const missing = node(["sign", "--in", sums, "--out", path.join(dir, "s")]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/UPDATE_SIGNING_KEY is not set/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(node(["sign", "--in", sums, "--out", path.join(dir, "s")], { UPDATE_SIGNING_KEY: rsa }).stderr).toMatch(/not an Ed25519 key/);
    expect(fs.existsSync(path.join(dir, "s"))).toBe(false);
  });

  it("matches the documented OpenSSL check (where this OpenSSL has Ed25519 raw-input verification)", () => {
    const openssl = ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl", "openssl"].find(candidate => spawnSync(candidate, ["version"], { encoding: "utf8" }).stdout?.startsWith("OpenSSL 3") || spawnSync(candidate, ["version"], { encoding: "utf8" }).stdout?.match(/^OpenSSL [4-9]/));
    if (!openssl) return;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sums = path.join(dir, "SHA256SUMS.txt"), sig = path.join(dir, "SHA256SUMS.txt.sig");
    fs.writeFileSync(sums, `${"b".repeat(64)}  MCP-for-NovelAI-0.1.3-linux-x64.tar.gz\n`);
    expect(node(["sign", "--in", sums, "--out", sig], { UPDATE_SIGNING_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString() }).status).toBe(0);
    fs.writeFileSync(path.join(dir, "public.pem"), publicKey.export({ format: "pem", type: "spki" }));
    fs.writeFileSync(path.join(dir, "sig.bin"), Buffer.from(fs.readFileSync(sig, "utf8").trim(), "base64"));
    const checked = spawnSync(openssl, ["pkeyutl", "-verify", "-pubin", "-inkey", path.join(dir, "public.pem"), "-rawin", "-in", sums, "-sigfile", path.join(dir, "sig.bin")], { encoding: "utf8" });
    expect(`${checked.stdout}${checked.stderr}`).toMatch(/Signature Verified Successfully/);
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
