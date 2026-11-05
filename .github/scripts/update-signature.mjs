#!/usr/bin/env node
// The update signature of a release: SHA256SUMS.txt.sig is the base64 text (one line) of the raw 64-byte Ed25519
// signature over the exact bytes of SHA256SUMS.txt. The app verifies it with the public key built into it
// (novelai/client/electron/update/source.ts, raw 32 bytes in base64) before it downloads or installs anything.
//
//   node .github/scripts/update-signature.mjs release --dir <release files> [--expect-public-key <base64 raw key>] [--key-env UPDATE_SIGNING_KEY]
//   node .github/scripts/update-signature.mjs sign --in SHA256SUMS.txt --out SHA256SUMS.txt.sig [--key-env UPDATE_SIGNING_KEY]
//   node .github/scripts/update-signature.mjs verify --in SHA256SUMS.txt --sig SHA256SUMS.txt.sig --public-key <base64 raw key>
//   node .github/scripts/update-signature.mjs public-key [--key-env UPDATE_SIGNING_KEY]
//   node .github/scripts/update-signature.mjs keygen --out <private key file>       (rehearsals only: a throwaway key)
//
// sign reads the private key (PKCS#8 PEM) from the environment variable --key-env names (UPDATE_SIGNING_KEY by default)
// and never prints or writes it; a missing or unusable key is an error (exit 1), so a release cannot go out unsigned.
// sign also checks its own signature with the key's public half and prints that public key (base64 raw), so the
// workflow can compare it with the key built into the app. Output: one JSON line.
//
// release (the release workflow's step): signs <dir>/SHA256SUMS.txt into <dir>/SHA256SUMS.txt.sig, fails unless the
// signing key's public half is the one built into the app (OFFICIAL_UPDATE_PUBLIC_KEY in
// novelai/client/electron/update/source.ts; --expect-public-key for a rehearsal with a throwaway key), verifies the
// result, and verifies it once more with OpenSSL (`openssl pkeyutl -verify -rawin`, the check docs/updates.md gives)
// when an OpenSSL 3 or later is installed.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || rest[index + 1] === undefined) throw new Error(`usage: update-signature.mjs sign|verify|public-key|keygen [--option value]… (got ${rest[index]})`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { command, options };
}

function keyFromEnv(options) {
  const name = options['key-env'] ?? 'UPDATE_SIGNING_KEY';
  const pem = process.env[name];
  if (!pem || !pem.trim()) throw new Error(`${name} is not set: the release cannot be signed.`);
  return privateKeyFromPem(pem);
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

function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'release') {
    if (!options.dir) throw new Error('release needs --dir');
    const sums = path.join(options.dir, 'SHA256SUMS.txt'), out = path.join(options.dir, 'SHA256SUMS.txt.sig');
    const expected = options['expect-public-key'] ?? builtInPublicKey();
    const key = keyFromEnv(options);
    const signer = rawPublicKey(key);
    if (signer !== expected) throw new Error(`the signing key is not the one built into the app (its public key is ${signer}, the app has ${expected})`);
    const bytes = readFileSync(sums);
    const text = signatureText(bytes, key);
    if (!signatureValid(bytes, text, publicKeyFromRaw(expected))) throw new Error('the new signature does not verify');
    writeFileSync(out, text);
    const openssl = opensslVerifies(sums, out, expected);
    if (openssl === false) throw new Error('OpenSSL does not verify the new signature');
    console.log(JSON.stringify({ ok: true, signed: 'SHA256SUMS.txt', signature: 'SHA256SUMS.txt.sig', publicKey: expected, openssl: openssl === null ? 'not available' : 'verified' }));
    return;
  }
  if (command === 'sign') {
    if (!options.in || !options.out) throw new Error('sign needs --in and --out');
    const key = keyFromEnv(options);
    const bytes = readFileSync(options.in);
    const text = signatureText(bytes, key);
    const publicKey = rawPublicKey(key);
    if (!signatureValid(bytes, text, publicKeyFromRaw(publicKey))) throw new Error('the new signature does not verify');
    writeFileSync(options.out, text);
    console.log(JSON.stringify({ ok: true, signed: path.basename(options.in), signature: path.basename(options.out), publicKey }));
    return;
  }
  if (command === 'verify') {
    if (!options.in || !options.sig || !options['public-key']) throw new Error('verify needs --in, --sig and --public-key');
    const ok = signatureValid(readFileSync(options.in), readFileSync(options.sig, 'utf8'), publicKeyFromRaw(options['public-key']));
    console.log(JSON.stringify({ ok, verified: path.basename(options.in) }));
    process.exitCode = ok ? 0 : 1;
    return;
  }
  if (command === 'public-key') { console.log(JSON.stringify({ ok: true, publicKey: rawPublicKey(keyFromEnv(options)) })); return; }
  if (command === 'keygen') {
    if (!options.out) throw new Error('keygen needs --out');
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(options.out, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    console.log(JSON.stringify({ ok: true, privateKeyFile: options.out, publicKey: rawPublicKey(privateKey) }));
    return;
  }
  throw new Error('usage: update-signature.mjs sign|verify|public-key|keygen');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`update-signature: ${error instanceof Error ? error.message : error}`); process.exitCode = 1; }
}
