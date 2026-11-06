#!/usr/bin/env node
// The update signature of a release: SHA256SUMS.txt.sig is the base64 text (one line) of the raw 64-byte Ed25519
// signature over the exact bytes of SHA256SUMS.txt. The app verifies it with the public key built into it
// (novelai/client/electron/update/source.ts, raw 32 bytes in base64) before it downloads or installs anything.
//
// Releases are signed OFFLINE by the maintainer with .github/scripts/sign-release.mjs (the private key never is in CI or
// on GitHub). This file holds the signature format and the checks anyone can run:
//
//   node .github/scripts/update-signature.mjs verify --in SHA256SUMS.txt --sig SHA256SUMS.txt.sig [--public-key <base64 raw key>]
//   node .github/scripts/update-signature.mjs public-key --key <private key file>
//   node .github/scripts/update-signature.mjs keygen --out <private key file>       (rehearsals and tests: a throwaway key)
//
// verify uses the key built into the app unless --public-key names another; exit 0 only for a valid signature (exit 1
// otherwise, with {"ok":false}). Output: one JSON line. No command prints a private key.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawPublicKey(key) {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(SPKI_PREFIX)) throw new Error('not an Ed25519 key');
  return der.subarray(12).toString('base64');
}

export function publicKeyFromRaw(raw) {
  const bytes = Buffer.from(String(raw), 'base64');
  if (bytes.length !== 32 || !/^[A-Za-z0-9+/]{43}=$/.test(String(raw))) throw new Error('the public key must be 32 bytes in base64');
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

/** The private key from PEM text; only Ed25519 is accepted. */
export function privateKeyFromPem(pem) {
  let key;
  try { key = createPrivateKey({ key: pem, format: 'pem' }); } catch { throw new Error('the signing key is not a PEM private key'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the signing key is not an Ed25519 key');
  return key;
}

/** The signature file text for `bytes`. */
export function signatureText(bytes, privateKey) {
  return `${sign(null, bytes, privateKey).toString('base64')}\n`;
}

export function signatureValid(bytes, text, publicKey) {
  const value = String(text).replace(/\r?\n$/, '');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  try { return verify(null, bytes, publicKey, Buffer.from(value, 'base64')); } catch { return false; }
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The update key built into the app (its source file is the one place it is written down). */
export function builtInPublicKey() {
  const source = readFileSync(path.join(REPO, 'novelai', 'client', 'electron', 'update', 'source.ts'), 'utf8');
  const match = /^export const OFFICIAL_UPDATE_PUBLIC_KEY = "([A-Za-z0-9+/]{43}=)";$/m.exec(source);
  if (!match) throw new Error('OFFICIAL_UPDATE_PUBLIC_KEY not found in electron/update/source.ts');
  return match[1];
}

/** OpenSSL's own verification of a signature file; null when no OpenSSL with Ed25519 raw input is installed. */
export function opensslVerifies(file, signatureFile, publicKeyRaw) {
  const version = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  if (version.status !== 0 || !/^OpenSSL ([3-9]|\d{2,})\./.test(version.stdout ?? '')) return null;
  const scratch = mkdtempSync(path.join(tmpdir(), 'nai-update-signature-'));
  try {
    writeFileSync(path.join(scratch, 'key.pem'), publicKeyFromRaw(publicKeyRaw).export({ format: 'pem', type: 'spki' }));
    writeFileSync(path.join(scratch, 'sig.bin'), Buffer.from(readFileSync(signatureFile, 'utf8').trim(), 'base64'));
    const checked = spawnSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', path.join(scratch, 'key.pem'), '-rawin', '-in', file, '-sigfile', path.join(scratch, 'sig.bin')], { encoding: 'utf8' });
    return checked.status === 0 && /Signature Verified Successfully/.test(`${checked.stdout}${checked.stderr}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

/** Whether this module is the script node was started with, also through a symbolic link or a relative path. */
export function isEntryScript(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(importMetaUrl)); } catch { return false; }
}

export function parseOptions(rest, usage) {
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || rest[index + 1] === undefined) throw new Error(`${usage} (got ${rest[index]})`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return options;
}

const USAGE = 'usage: update-signature.mjs verify --in <SHA256SUMS.txt> --sig <SHA256SUMS.txt.sig> [--public-key <base64>] | public-key --key <file> | keygen --out <file>';

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest, USAGE);
  if (command === 'verify') {
    if (!options.in || !options.sig) throw new Error('verify needs --in and --sig');
    const publicKey = options['public-key'] ?? builtInPublicKey();
    const ok = signatureValid(readFileSync(options.in), readFileSync(options.sig, 'utf8'), publicKeyFromRaw(publicKey));
    console.log(JSON.stringify({ ok, verified: path.basename(options.in), publicKey }));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === 'public-key') {
    if (!options.key) throw new Error('public-key needs --key');
    console.log(JSON.stringify({ ok: true, publicKey: rawPublicKey(privateKeyFromPem(readFileSync(options.key, 'utf8'))) }));
    return;
  }
  if (command === 'keygen') {
    if (!options.out) throw new Error('keygen needs --out');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(options.out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ ok: true, privateKeyFile: options.out, publicKey: rawPublicKey(privateKey) }));
    return;
  }
  throw new Error(USAGE);
}

if (isEntryScript(import.meta.url)) {
  try { main(); } catch (error) { console.error(`update-signature: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
