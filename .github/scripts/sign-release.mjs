#!/usr/bin/env node
// Signs a draft release for the in-app update, OFFLINE, on the maintainer's computer: the update signing key never is
// in CI or on GitHub, so neither a compromised workflow nor a compromised GitHub account can sign an update on its own
// (docs/updates.md, threat model).
//
//   node .github/scripts/sign-release.mjs <tag> --key <private key file> [--repo <owner/name>]
//
// 1. Reads the private key (Ed25519, PKCS#8 PEM) from the file; on macOS and Linux the file must not be readable by
//    group or others. Its public half must be the key built into the app (novelai/client/electron/update/source.ts),
//    or the release would carry a signature the app refuses. The key is never printed, logged or written anywhere.
// 2. The release <tag> must be a DRAFT (a published release is never changed).
// 3. Downloads its SHA256SUMS.txt (`gh release download`), checks its format and that every MCP-for-NovelAI file in it
//    carries the tag's version, as the app does, and that it lists the installer of every platform.
// 4. Every listed file must be an asset of the draft, and every other asset must be listed (no file goes out
//    unsigned). Each listed asset is downloaded and its size (the one GitHub reports) and SHA-256 (the manifest's) are
//    checked on this computer: what is signed is what this computer saw.
// 5. Signs the exact bytes of SHA256SUMS.txt, verifies the signature with the built-in public key (and with OpenSSL 3
//    when it is installed: the check docs/updates.md gives users), uploads SHA256SUMS.txt.sig
//    (`gh release upload --clobber`), downloads both files again and verifies them once more.
//
// Output: one JSON line ({"ok":true,...}); exit 1 with an error line on stderr for anything else. Needs the GitHub CLI
// (`gh`) signed in with write access to the repository. Rehearsals and tests only: --gh <executable or .mjs> runs
// another gh (a fake that serves a local folder) and --expect-public-key <base64> accepts a throwaway key.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtInPublicKey, isEntryScript, opensslVerifies, parseOptions, privateKeyFromPem, publicKeyFromRaw, rawPublicKey, signatureText, signatureValid } from './update-signature.mjs';

export const DEFAULT_REPO = 'lwyq1209/mcp-for-novelai';
const PREFIX = 'MCP-for-NovelAI';
const SIGNATURE_FILES = new Set(['SHA256SUMS.txt', 'SHA256SUMS.txt.sig']);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export class SignError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The version of a release tag (v0.1.3 → 0.1.3; pre-releases v0.2.0-beta.1 too), or null. */
export function versionOfTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.exec(String(tag));
  return match && String(tag).length <= 64 ? String(tag).slice(1) : null;
}

/** The installers the app updates from, per platform (electron/update/release-files.ts updateAssetName). */
export function updateAssets(version) {
  return [`${PREFIX}-${version}-mac-arm64.zip`, `${PREFIX}-${version}-mac-x64.zip`, `${PREFIX}-${version}-win-x64-setup.exe`, `${PREFIX}-${version}-linux-x64.tar.gz`];
}

/** SHA256SUMS.txt as the app parses it (strict), checked for the release `version`. Returns name → sha256. */
export function checkManifest(bytes, version) {
  const text = bytes.toString('utf8');
  if (!bytes.length || bytes.length > 64 * 1024 || !Buffer.from(text, 'utf8').equals(bytes) || text.startsWith('\ufeff') || /[\r\0]/.test(text)) throw new SignError('manifest_invalid', 'SHA256SUMS.txt is not plain text with LF line ends.');
  const files = new Map();
  for (const line of (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match || !NAME.test(match[2])) throw new SignError('manifest_invalid', `SHA256SUMS.txt has a line that is not a checksum of a release file: ${JSON.stringify(line.slice(0, 120))}`);
    if (files.has(match[2])) throw new SignError('manifest_invalid', `SHA256SUMS.txt names ${match[2]} twice.`);
    files.set(match[2], match[1]);
  }
  for (const name of files.keys()) {
    if (SIGNATURE_FILES.has(name)) throw new SignError('manifest_invalid', `SHA256SUMS.txt lists ${name}.`);
    if (name.startsWith(`${PREFIX}-`) && !name.startsWith(`${PREFIX}-${version}-`)) throw new SignError('version_mismatch', `SHA256SUMS.txt names ${name}, which is not of ${version}.`);
  }
  const missing = updateAssets(version).filter(name => !files.has(name));
  if (missing.length) throw new SignError('asset_missing', `SHA256SUMS.txt does not list ${missing.join(', ')}.`);
  return files;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/** The private key from its file: a regular file, not readable by others (POSIX), Ed25519. Never echoes its content. */
export function readSigningKey(file, platform = process.platform) {
  let stat;
  try { stat = statSync(file); } catch { throw new SignError('key_unreadable', `The key file ${file} cannot be read.`); }
  if (!stat.isFile()) throw new SignError('key_unreadable', `The key file ${file} is not a file.`);
  if (platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new SignError('key_permissions', `The key file ${file} is readable by group or others (chmod 600 it).`);
  let pem;
  try { pem = readFileSync(file, 'utf8'); } catch { throw new SignError('key_unreadable', `The key file ${file} cannot be read.`); }
  try { return privateKeyFromPem(pem); } catch (error) { throw new SignError('key_invalid', error.message); } finally { pem = null; }
}

/** Runs gh (or the --gh replacement) without a shell; its output is returned, never the key (gh never sees it). */
function ghRunner(gh) {
  const [command, prefix] = /\.m?js$/.test(gh) ? [process.execPath, [gh]] : [gh, []];
  return (args, { json = false } = {}) => {
    const result = spawnSync(command, [...prefix, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) throw new SignError('gh_failed', `gh could not run: ${result.error.message}`);
    if (result.status !== 0) throw new SignError('gh_failed', `gh ${args.slice(0, 2).join(' ')} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim().slice(-800)}`);
    if (!json) return result.stdout;
    try { return JSON.parse(result.stdout); } catch { throw new SignError('gh_failed', `gh ${args.slice(0, 2).join(' ')} did not answer JSON.`); }
  };
}

export async function signRelease({ tag, keyFile, repo = DEFAULT_REPO, gh = 'gh', expectPublicKey, log = () => {} }) {
  const version = versionOfTag(tag);
  if (!version) throw new SignError('usage', `${tag} is not a release tag (v<major>.<minor>.<patch>).`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new SignError('usage', `${repo} is not <owner>/<name>.`);
  const expected = expectPublicKey ?? builtInPublicKey();
  publicKeyFromRaw(expected);
  const key = readSigningKey(keyFile);
  const publicKey = rawPublicKey(key);
  if (publicKey !== expected) throw new SignError('wrong_key', `The key's public half (${publicKey}) is not the one built into the app (${expected}); the app would refuse this signature.`);
  const run = ghRunner(gh);
  const view = () => {
    const release = run(['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,assets'], { json: true });
    if (release?.tagName !== tag) throw new SignError('gh_failed', `gh answered for ${release?.tagName}, not ${tag}.`);
    if (release.isDraft !== true) throw new SignError('not_draft', `Release ${tag} is not a draft; a published release is never changed.`);
    return new Map((release.assets ?? []).map(asset => [asset.name, asset]));
  };
  const scratch = mkdtempSync(path.join(tmpdir(), 'nai-sign-release-'));
  try {
    const assets = view();
    /** One file of the draft into a new folder of its own (gh's --pattern is a glob: names are plain, checked first). */
    let folders = 0;
    const download = name => {
      if (!NAME.test(name)) throw new SignError('manifest_invalid', `${name} is not a release file name.`);
      const dir = path.join(scratch, String(folders++));
      mkdirSync(dir, { mode: 0o700 });
      run(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', dir]);
      const file = path.join(dir, name);
      if (!existsSync(file) || !statSync(file).isFile()) throw new SignError('gh_failed', `gh did not download ${name}.`);
      return file;
    };
    const manifestFile = download('SHA256SUMS.txt');
    const manifest = readFileSync(manifestFile);
    const files = checkManifest(manifest, version);
    const unlisted = [...assets.keys()].filter(name => !files.has(name) && !SIGNATURE_FILES.has(name));
    if (unlisted.length) throw new SignError('asset_unlisted', `The draft has files SHA256SUMS.txt does not list: ${unlisted.join(', ')}.`);
    const checked = [];
    for (const [name, sha256] of files) {
      const asset = assets.get(name);
      if (!asset) throw new SignError('asset_missing', `SHA256SUMS.txt lists ${name}, which the draft does not have.`);
      const file = download(name);
      const size = statSync(file).size;
      if (!Number.isSafeInteger(asset.size) || size !== asset.size) throw new SignError('asset_size', `${name}: downloaded ${size} bytes, the draft reports ${asset.size}.`);
      const actual = await sha256File(file);
      if (actual !== sha256) throw new SignError('asset_checksum', `${name}: SHA-256 ${actual}, SHA256SUMS.txt says ${sha256}.`);
      rmSync(path.dirname(file), { recursive: true, force: true });
      checked.push({ name, size });
      log(`checked ${name} (${size} bytes)`);
    }
    const signature = signatureText(manifest, key);
    if (!signatureValid(manifest, signature, publicKeyFromRaw(expected))) throw new SignError('verify_failed', 'The new signature does not verify with the built-in public key.');
    const sigFile = path.join(path.dirname(manifestFile), 'SHA256SUMS.txt.sig');
    writeFileSync(sigFile, signature);
    const openssl = opensslVerifies(manifestFile, sigFile, expected);
    if (openssl === false) throw new SignError('verify_failed', 'OpenSSL does not verify the new signature.');
    // Still the same draft and the same manifest just before the upload.
    view();
    run(['release', 'upload', tag, sigFile, '--repo', repo, '--clobber']);
    // What GitHub serves now: both files again, verified once more.
    const servedManifest = readFileSync(download('SHA256SUMS.txt'));
    const servedSignature = readFileSync(download('SHA256SUMS.txt.sig'), 'utf8');
    if (!servedManifest.equals(manifest)) throw new SignError('changed', 'SHA256SUMS.txt of the draft changed while it was signed; sign it again.');
    if (!signatureValid(servedManifest, servedSignature, publicKeyFromRaw(expected))) throw new SignError('verify_failed', 'The uploaded signature does not verify.');
    view();
    return { ok: true, tag, repo, version, files: checked.length, bytes: checked.reduce((sum, file) => sum + file.size, 0), publicKey: expected, openssl: openssl === null ? 'not installed' : 'verified', sha256SumsSha256: createHash('sha256').update(manifest).digest('hex') };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const USAGE = 'usage: sign-release.mjs <tag> --key <private key file> [--repo <owner/name>]';

async function main() {
  const [tag, ...rest] = process.argv.slice(2);
  if (!tag || tag.startsWith('--')) throw new SignError('usage', USAGE);
  const options = parseOptions(rest, USAGE);
  for (const name of Object.keys(options)) if (!['key', 'repo', 'gh', 'expect-public-key'].includes(name)) throw new SignError('usage', `${USAGE} (unknown option --${name})`);
  if (!options.key) throw new SignError('usage', USAGE);
  const result = await signRelease({ tag, keyFile: options.key, repo: options.repo, gh: options.gh, expectPublicKey: options['expect-public-key'], log: line => console.error(`sign-release: ${line}`) });
  console.log(JSON.stringify(result));
}

if (isEntryScript(import.meta.url)) {
  main().catch(error => {
    console.error(`sign-release: ${error instanceof Error ? error.message : error}`);
    console.log(JSON.stringify({ ok: false, code: error?.code ?? 'failed' }));
    process.exitCode = 1;
  });
}
