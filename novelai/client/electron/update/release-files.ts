// The signed update manifest of a release and the file names the update takes from it (pure; no network, no files).
//
// A release carries SHA256SUMS.txt (one "<sha256>  <file name>" line per release file, as `sha256sum` writes it) and
// SHA256SUMS.txt.sig: the base64 text of the raw 64-byte Ed25519 signature over the exact bytes of SHA256SUMS.txt,
// made in the release workflow with the update signing key (.github/scripts/update-signature.mjs). The app trusts a
// release only through this signature, checked with the public key built into it (source.ts). Which file this
// platform installs follows the release workflow's fixed file names (updateAssetName), and those names carry the
// version, so the signed manifest also says which version it is for: every MCP-for-NovelAI file in it must carry the
// version of the release tag (manifestVersionProblem), or nothing is installed.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { parseVersion, compareVersions, formatVersion } from "../ipc/update";

export const RELEASE_FILE_PREFIX = "MCP-for-NovelAI";
export const CHECKSUMS_FILE = "SHA256SUMS.txt";
export const SIGNATURE_FILE = "SHA256SUMS.txt.sig";
/** SHA256SUMS.txt of a release lists a handful of files; anything larger is not one. */
export const CHECKSUMS_MAX_BYTES = 64 * 1024;
/** The signature file: 88 base64 characters and a line end. */
export const SIGNATURE_MAX_BYTES = 1024;

/**
 * The release file this platform and architecture installs (the names of the release workflow and of
 * .github/scripts/packaged-app-check.mjs artifactsFor): the macOS zip (the same app as the dmg), the Windows NSIS
 * installer, the Linux tar.gz. null where no release file exists (Windows and Linux are built for x64 only).
 */
export function updateAssetName(platform: NodeJS.Platform, arch: string, version: string): string | null {
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `${RELEASE_FILE_PREFIX}-${version}-mac-${arch}.zip`;
  if (platform === "win32" && arch === "x64") return `${RELEASE_FILE_PREFIX}-${version}-win-x64-setup.exe`;
  if (platform === "linux" && arch === "x64") return `${RELEASE_FILE_PREFIX}-${version}-linux-x64.tar.gz`;
  return null;
}

/** A release file name as the workflow writes them: letters, digits, dot, dash and underscore, no path. */
export const RELEASE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * A release tag the update accepts: "v" and a semantic version without build metadata (v0.1.3, v0.2.0-beta.1).
 * Returns the version (0.1.3), or null for anything else (no other characters, no "+", no path or URL parts).
 */
export function versionOfTag(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.length > 64 || !/^v[0-9A-Za-z.-]+$/.test(tag)) return null;
  const parsed = parseVersion(tag);
  if (!parsed) return null;
  const version = formatVersion(parsed);
  return `v${version}` === tag ? version : null;
}

export class ManifestError extends Error {
  constructor(readonly code: "manifest_invalid" | "signature_invalid" | "version_mismatch" | "asset_missing", message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

/**
 * The lines of SHA256SUMS.txt: file name → lowercase SHA-256 hex. Strict: UTF-8 text without a BOM, LF line ends,
 * "<64 hex>  <name>" or "<64 hex> *<name>" per line, release file names only, no name twice, at least one line.
 */
export function parseChecksums(bytes: Buffer): Map<string, string> {
  if (bytes.length === 0 || bytes.length > CHECKSUMS_MAX_BYTES) throw new ManifestError("manifest_invalid", "SHA256SUMS.txt is empty or too large.");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes) || text.startsWith("\ufeff") || text.includes("\r") || text.includes("\0")) throw new ManifestError("manifest_invalid", "SHA256SUMS.txt is not plain text with LF line ends.");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const files = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match || !RELEASE_FILE_NAME.test(match[2])) throw new ManifestError("manifest_invalid", "SHA256SUMS.txt has a line that is not a checksum of a release file.");
    if (files.has(match[2])) throw new ManifestError("manifest_invalid", "SHA256SUMS.txt names a file twice.");
    files.set(match[2], match[1].toLowerCase());
  }
  if (!files.size) throw new ManifestError("manifest_invalid", "SHA256SUMS.txt lists no files.");
  return files;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The Ed25519 public key of its raw 32 bytes in base64 (as built into the app), or null when it is not one. */
export function ed25519PublicKey(rawBase64: string): KeyObject | null {
  if (typeof rawBase64 !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(rawBase64)) return null;
  const raw = Buffer.from(rawBase64, "base64");
  if (raw.length !== 32) return null;
  try { return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" }); } catch { return null; }
}

/**
 * Whether `signatureText` (SHA256SUMS.txt.sig: base64 of the 64-byte Ed25519 signature, optionally followed by one line
 * end) is a valid signature of exactly `checksums` by `publicKey`. Anything malformed is false.
 */
export function checksumsSignatureValid(checksums: Buffer, signatureText: Buffer, publicKey: KeyObject): boolean {
  if (signatureText.length === 0 || signatureText.length > SIGNATURE_MAX_BYTES) return false;
  const text = signatureText.toString("utf8").replace(/\r?\n$/, "");
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return false;
  const signature = Buffer.from(text, "base64");
  if (signature.length !== 64) return false;
  try { return verify(null, checksums, publicKey, signature); } catch { return false; }
}

/**
 * Why the manifest does not belong to the release `version`, or null when it does: every MCP-for-NovelAI-<version>-…
 * file in it must carry exactly that version (a manifest of another release, replayed under this tag, names another).
 */
export function manifestVersionProblem(files: Map<string, string>, version: string): string | null {
  const prefix = `${RELEASE_FILE_PREFIX}-`;
  let own = 0;
  for (const name of files.keys()) {
    if (!name.startsWith(prefix)) continue;
    if (!name.startsWith(`${prefix}${version}-`)) return "The signed checksums name files of another version.";
    own++;
  }
  return own ? null : "The signed checksums name no file of this version.";
}

export interface VerifiedManifest {
  /** The release version (from its tag), without a leading v. */
  version: string;
  /** The release file this platform installs. */
  asset: string;
  /** Its SHA-256 in lowercase hex, from the signed checksums. */
  sha256: string;
}

/**
 * Checks a downloaded SHA256SUMS.txt and its signature for the release `tag`, as the app about to update from
 * `currentVersion` on `platform`/`arch`: the signature (else signature_invalid), the format (manifest_invalid), the
 * version of every listed file (version_mismatch), a version strictly newer than the running one (no downgrade, no
 * reinstall: version_mismatch) and a file for this platform (asset_missing). Returns what to download.
 */
export function verifyReleaseManifest(input: { tag: string; checksums: Buffer; signature: Buffer; publicKey: KeyObject; currentVersion: string; platform: NodeJS.Platform; arch: string }): VerifiedManifest {
  const version = versionOfTag(input.tag);
  if (!version) throw new ManifestError("version_mismatch", "The release tag is not a version.");
  // The signature first: nothing of an unsigned manifest is looked at (also not for an error message).
  if (!checksumsSignatureValid(input.checksums, input.signature, input.publicKey)) throw new ManifestError("signature_invalid", "The signature of SHA256SUMS.txt is not valid for this app's update key.");
  const files = parseChecksums(input.checksums);
  const problem = manifestVersionProblem(files, version);
  if (problem) throw new ManifestError("version_mismatch", problem);
  const next = parseVersion(version), current = parseVersion(input.currentVersion);
  if (!next || !current || compareVersions(next, current) <= 0) throw new ManifestError("version_mismatch", `Version ${version} is not newer than the running version ${input.currentVersion}.`);
  const asset = updateAssetName(input.platform, input.arch, version);
  const sha256 = asset ? files.get(asset) : undefined;
  if (!asset || !sha256) throw new ManifestError("asset_missing", "This release has no update file for this system.");
  return { version, asset, sha256 };
}
