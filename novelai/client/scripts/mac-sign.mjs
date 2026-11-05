#!/usr/bin/env node
// macOS code signing of the packaged app (electron-builder afterPack hook: scripts/mac-sign-hook.cjs; also a CLI).
//
// Release builds are signed with the project's fixed self-signed certificate, so every version has the same designated
// requirement (identifier "<bundle id>" and certificate leaf = H"<SHA-1 of the certificate>") and the Keychain's
// "Always Allow" of the app's Safe Storage key stays valid across updates (an ad-hoc signature changes with every
// build). electron-builder cannot do this itself: it signs only with identities `security find-identity -v` lists as
// valid, and a self-signed certificate that no one trusts is not (CSSMERR_TP_NOT_TRUSTED), so it would silently skip
// signing. codesign itself signs with it; trust only matters for Gatekeeper, which treats it like an ad-hoc signature.
//
//   NAI_MAC_SIGNING=certificate  MAC_CSC_LINK (base64 of the .p12, or a path to it) and MAC_CSC_KEY_PASSWORD are
//                                required; anything missing fails the build (never a silent ad-hoc fallback).
//   otherwise                    ad-hoc (local builds: `npm run dist:mac`).
//
// Certificate signing: a throwaway keychain in a temporary folder (random password, no lock timeout), the .p12 imported
// for codesign only (-T /usr/bin/codesign, partition list apple-tool:), added to the user's keychain search list only
// while codesign runs (codesign finds identities only there) and the list restored exactly afterwards, then the keychain
// deleted. codesign --deep signs the nested code inside out; the outer bundle is signed again with the explicit
// designated requirement. Finally `codesign --verify --deep --strict`.
//
//   node scripts/mac-sign.mjs <App.app> [--bundle-id <id>]      (the same, outside electron-builder)
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, ...options });

/** The user's keychain search list, as `security list-keychains -d user` prints it. */
export function searchList() {
  return run('/usr/bin/security', ['list-keychains', '-d', 'user']).split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/** The first code-signing identity of a keychain (valid or not): {sha1, name}. */
export function identityOf(keychain) {
  const listed = run('/usr/bin/security', ['find-identity', '-p', 'codesigning', keychain]);
  const match = /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/m.exec(listed);
  if (!match) throw new Error('The certificate in MAC_CSC_LINK has no code-signing identity.');
  return { sha1: match[1], name: match[2] };
}

/** SHA-256 and SHA-1 (lowercase hex) of the leaf certificate a bundle is signed with; null for ad-hoc. */
export function bundleCertificate(app) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-cert-'));
  try {
    run('/usr/bin/codesign', ['-d', `--extract-certificates=${path.join(scratch, 'c')}`, app]);
    const der = fs.readFileSync(path.join(scratch, 'c0'));
    return { sha256: createHash('sha256').update(der).digest('hex'), sha1: createHash('sha1').update(der).digest('hex') };
  } catch { return null; } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function signAdHoc(app) {
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
}

export function signWithCertificate(app, { bundleId, link, password, log = () => {} }) {
  if (!bundleId || !/^[A-Za-z0-9.-]+$/.test(bundleId)) throw new Error('A bundle identifier is needed for the designated requirement.');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nai-mac-sign-'));
  const keychain = path.join(scratch, 'signing.keychain-db');
  const keychainPassword = randomBytes(24).toString('base64');
  let original = null;
  try {
    const p12 = path.join(scratch, 'certificate.p12');
    if (fs.existsSync(link)) fs.copyFileSync(link, p12);
    else {
      const bytes = Buffer.from(String(link).replace(/\s+/g, ''), 'base64');
      if (bytes.length < 100) throw new Error('MAC_CSC_LINK is neither a file nor a base64 .p12.');
      fs.writeFileSync(p12, bytes, { mode: 0o600 });
    }
    run('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychain]);
    run('/usr/bin/security', ['set-keychain-settings', keychain]);
    run('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychain]);
    run('/usr/bin/security', ['import', p12, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('/usr/bin/security', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', keychainPassword, keychain]);
    const identity = identityOf(keychain);
    const requirement = `=designated => identifier "${bundleId}" and certificate leaf = H"${identity.sha1.toLowerCase()}"`;
    original = searchList();
    run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychain, ...original.filter(item => item !== keychain)]);
    log(`signing ${path.basename(app)} with "${identity.name}" (${identity.sha1})`);
    run('/usr/bin/codesign', ['--force', '--deep', '--timestamp=none', '--keychain', keychain, '--sign', identity.sha1, app]);
    run('/usr/bin/codesign', ['--force', '--timestamp=none', '--keychain', keychain, '--sign', identity.sha1, '--requirements', requirement, app]);
  } finally {
    if (original) { try { run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original]); } catch (error) { log(`could not restore the keychain search list: ${error.message}`); } }
    try { run('/usr/bin/security', ['delete-keychain', keychain]); } catch { /* not created */ }
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const certificate = bundleCertificate(app);
  if (!certificate) throw new Error('The signed app carries no certificate.');
  return certificate;
}

/** What the environment asks for: {mode: 'certificate', link, password} or {mode: 'adhoc'}; throws when certificate signing lacks its secrets. */
export function signingRequest(env = process.env) {
  if (env.NAI_MAC_SIGNING !== 'certificate') return { mode: 'adhoc' };
  const link = env.MAC_CSC_LINK, password = env.MAC_CSC_KEY_PASSWORD;
  if (!link || !link.trim() || password === undefined || password === '') throw new Error('NAI_MAC_SIGNING=certificate needs MAC_CSC_LINK and MAC_CSC_KEY_PASSWORD; the macOS build is not signed ad-hoc instead.');
  return { mode: 'certificate', link, password };
}

export function signMacApp(app, { bundleId, env = process.env, log = () => {} }) {
  const request = signingRequest(env);
  if (request.mode === 'adhoc') { log(`signing ${path.basename(app)} ad-hoc`); signAdHoc(app); return { mode: 'adhoc', certificate: null }; }
  return { mode: 'certificate', certificate: signWithCertificate(app, { bundleId, link: request.link, password: request.password, log }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [app, flag, value] = process.argv.slice(2);
  try {
    if (!app || !app.endsWith('.app')) throw new Error('usage: mac-sign.mjs <App.app> [--bundle-id <id>]');
    const bundleId = flag === '--bundle-id' ? value : run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]).trim();
    console.log(JSON.stringify(signMacApp(path.resolve(app), { bundleId, log: message => console.error(`[mac-sign] ${message}`) })));
  } catch (error) { console.error(`mac-sign: ${error.message}`); process.exitCode = 1; }
}
