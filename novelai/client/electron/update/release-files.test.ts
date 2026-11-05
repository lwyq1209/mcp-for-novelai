// The signed manifest of a release (release-files.ts): file names per platform, the strict SHA256SUMS.txt format, the
// Ed25519 signature with a throwaway key pair (never the real update key), version binding, downgrades, replays.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checksumsSignatureValid, ed25519PublicKey, ManifestError, manifestVersionProblem, parseChecksums, updateAssetName, verifyReleaseManifest, versionOfTag } from "./release-files";
import { OFFICIAL_UPDATE_PUBLIC_KEY } from "./source";

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  return { publicKey: ed25519PublicKey(raw)!, privateKey, raw };
}
const signText = (bytes: Buffer, privateKey: KeyObject) => Buffer.from(`${sign(null, bytes, privateKey).toString("base64")}\n`);
const hex = (char: string) => char.repeat(64);
function sums(version: string, extra: string[] = []) {
  return Buffer.from([
    `${hex("a")}  MCP-for-NovelAI-${version}-linux-x64.tar.gz`,
    `${hex("b")}  MCP-for-NovelAI-${version}-mac-arm64.dmg`,
    `${hex("c")}  MCP-for-NovelAI-${version}-mac-arm64.zip`,
    `${hex("d")}  MCP-for-NovelAI-${version}-mac-x64.dmg`,
    `${hex("e")}  MCP-for-NovelAI-${version}-mac-x64.zip`,
    `${hex("f")}  MCP-for-NovelAI-${version}-win-x64-setup.exe`,
    `${hex("1")}  third-party-sources-${version}.tar.gz`,
    ...extra,
  ].join("\n") + "\n");
}

describe("release file names", () => {
  it("names the macOS zip per architecture, the Windows installer and the Linux archive (x64 only)", () => {
    expect(updateAssetName("darwin", "arm64", "0.1.3")).toBe("MCP-for-NovelAI-0.1.3-mac-arm64.zip");
    expect(updateAssetName("darwin", "x64", "0.1.3")).toBe("MCP-for-NovelAI-0.1.3-mac-x64.zip");
    expect(updateAssetName("win32", "x64", "0.1.3")).toBe("MCP-for-NovelAI-0.1.3-win-x64-setup.exe");
    expect(updateAssetName("linux", "x64", "0.1.3")).toBe("MCP-for-NovelAI-0.1.3-linux-x64.tar.gz");
    for (const [platform, arch] of [["win32", "arm64"], ["linux", "arm64"], ["freebsd", "x64"], ["darwin", "ia32"]] as const) expect(updateAssetName(platform as NodeJS.Platform, arch, "0.1.3")).toBeNull();
  });

  it("accepts only v<semantic version> tags, without build metadata or anything else", () => {
    expect(versionOfTag("v0.1.3")).toBe("0.1.3");
    expect(versionOfTag("v0.2.0-beta.1")).toBe("0.2.0-beta.1");
    for (const tag of ["0.1.3", "v0.1.3+build", "v0.1", "v01.1.3", "v0.1.3/../x", "v0.1.3%2f", "v0.1.3 ", " v0.1.3", "vv0.1.3", "V0.1.3", "v0.1.3\n", "", null, 3, `v${"1".repeat(70)}.0.0`])
      expect(versionOfTag(tag), String(tag)).toBeNull();
  });
});

describe("SHA256SUMS.txt", () => {
  it("reads sha256sum's format (text and binary marks) into name → lowercase hash", () => {
    const files = parseChecksums(Buffer.from(`${"A".repeat(64)}  one.zip\n${"b".repeat(64)} *two.exe\n`));
    expect([...files]).toEqual([["one.zip", "a".repeat(64)], ["two.exe", "b".repeat(64)]]);
  });

  it("refuses anything else: empty, CRLF, BOM, paths, spaces, short hashes, duplicates, oversize", () => {
    const bad = ["", `${hex("a")}  a.zip\r\n`, `\ufeff${hex("a")}  a.zip\n`, `${hex("a")}  ../a.zip\n`, `${hex("a")}  dir/a.zip\n`, `${hex("a")}  a b.zip\n`, `${"a".repeat(63)}  a.zip\n`,
      `${hex("a")}  a.zip\n${hex("b")}  a.zip\n`, `${hex("a")} a.zip\n`, `${hex("g")}  a.zip\n`, `${hex("a")}  a.zip\n\n`, `${hex("a")}  .hidden\n`, `${hex("a")}  a.zip\0\n`];
    for (const text of bad) expect(() => parseChecksums(Buffer.from(text)), JSON.stringify(text)).toThrow(ManifestError);
    expect(() => parseChecksums(Buffer.alloc(64 * 1024 + 1, 0x61))).toThrow(ManifestError);
    expect(() => parseChecksums(Buffer.from([0xff, 0xfe, 0x41]))).toThrow(ManifestError);
  });

  it("belongs to one version: every MCP-for-NovelAI file carries it", () => {
    expect(manifestVersionProblem(parseChecksums(sums("0.1.3")), "0.1.3")).toBeNull();
    expect(manifestVersionProblem(parseChecksums(sums("0.1.3")), "0.1.4")).toMatch(/another version/);
    expect(manifestVersionProblem(parseChecksums(sums("0.1.3", [`${hex("2")}  MCP-for-NovelAI-0.1.2-mac-arm64.zip`])), "0.1.3")).toMatch(/another version/);
    // 0.1.3 must not match 0.1.30.
    expect(manifestVersionProblem(parseChecksums(sums("0.1.30")), "0.1.3")).toMatch(/another version/);
    expect(manifestVersionProblem(parseChecksums(Buffer.from(`${hex("1")}  third-party-sources-0.1.3.tar.gz\n`)), "0.1.3")).toMatch(/no file/);
  });
});

describe("the Ed25519 signature", () => {
  it("verifies a signature of the exact bytes with the raw public key, and nothing else", () => {
    const { publicKey, privateKey } = keyPair();
    const bytes = sums("0.1.3");
    const signature = signText(bytes, privateKey);
    expect(checksumsSignatureValid(bytes, signature, publicKey)).toBe(true);
    expect(checksumsSignatureValid(bytes, Buffer.from(signature.toString().trim()), publicKey)).toBe(true);
    // One changed byte of the manifest, of the signature, another key, malformed signature files.
    const tampered = Buffer.from(bytes); tampered[3] ^= 1;
    expect(checksumsSignatureValid(tampered, signature, publicKey)).toBe(false);
    const flipped = Buffer.from(sign(null, bytes, privateKey)); flipped[10] ^= 1;
    expect(checksumsSignatureValid(bytes, Buffer.from(flipped.toString("base64")), publicKey)).toBe(false);
    expect(checksumsSignatureValid(bytes, signature, keyPair().publicKey)).toBe(false);
    for (const text of ["", "x", signature.toString().slice(0, 40), `${signature.toString().trim()}\n\n`, ` ${signature.toString().trim()}`, Buffer.from(sign(null, bytes, privateKey)).toString("hex")])
      expect(checksumsSignatureValid(bytes, Buffer.from(text), publicKey), text).toBe(false);
  });

  it("builds the official key from its raw base64 form and refuses malformed keys", () => {
    expect(ed25519PublicKey(OFFICIAL_UPDATE_PUBLIC_KEY)?.asymmetricKeyType).toBe("ed25519");
    for (const value of ["", "AAAA", `${OFFICIAL_UPDATE_PUBLIC_KEY}A`, OFFICIAL_UPDATE_PUBLIC_KEY.replace("=", "")]) expect(ed25519PublicKey(value)).toBeNull();
  });
});

describe("verifyReleaseManifest", () => {
  const { publicKey, privateKey } = keyPair();
  const input = (overrides: Partial<Parameters<typeof verifyReleaseManifest>[0]> = {}) => {
    const checksums = overrides.checksums ?? sums("0.1.3");
    return { tag: "v0.1.3", checksums, signature: signText(checksums, privateKey), publicKey, currentVersion: "0.1.2", platform: "darwin" as NodeJS.Platform, arch: "arm64", ...overrides };
  };
  const code = (value: Parameters<typeof verifyReleaseManifest>[0]) => { try { verifyReleaseManifest(value); return "ok"; } catch (error) { return (error as ManifestError).code; } };

  it("returns the file of this platform with its signed hash", () => {
    expect(verifyReleaseManifest(input())).toEqual({ version: "0.1.3", asset: "MCP-for-NovelAI-0.1.3-mac-arm64.zip", sha256: hex("c") });
    expect(verifyReleaseManifest(input({ platform: "win32", arch: "x64" })).asset).toBe("MCP-for-NovelAI-0.1.3-win-x64-setup.exe");
    expect(verifyReleaseManifest(input({ platform: "linux", arch: "x64" })).sha256).toBe(hex("a"));
  });

  it("stops at a bad signature before reading the manifest", () => {
    expect(code(input({ signature: signText(sums("0.1.3"), keyPair().privateKey) }))).toBe("signature_invalid");
    expect(code(input({ signature: Buffer.from("garbage") }))).toBe("signature_invalid");
    // A malformed manifest with a valid signature is still refused (signed garbage).
    const garbage = Buffer.from("not a manifest\n");
    expect(code(input({ checksums: garbage, signature: signText(garbage, privateKey) }))).toBe("manifest_invalid");
  });

  it("refuses a downgrade, the same version, a tag that does not match the signed files (replay) and other tags", () => {
    expect(code(input({ currentVersion: "0.1.3" }))).toBe("version_mismatch");
    expect(code(input({ currentVersion: "0.2.0" }))).toBe("version_mismatch");
    // An older release's correctly signed manifest served under a newer tag.
    const old = sums("0.1.3");
    expect(code(input({ tag: "v9.9.9", checksums: old, signature: signText(old, privateKey) }))).toBe("version_mismatch");
    expect(code(input({ tag: "0.1.3" }))).toBe("version_mismatch");
    expect(code(input({ tag: "v0.1.3+x" }))).toBe("version_mismatch");
  });

  it("says when the release has no file for this system", () => {
    const partial = Buffer.from(`${hex("a")}  MCP-for-NovelAI-0.1.3-linux-x64.tar.gz\n`);
    expect(code(input({ checksums: partial, signature: signText(partial, privateKey) }))).toBe("asset_missing");
    expect(code(input({ platform: "win32", arch: "arm64" }))).toBe("asset_missing");
  });
});
