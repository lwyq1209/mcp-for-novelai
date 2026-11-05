// settings.json of a TEST data root only (checked by guard.mjs before anything here runs).
//
// The client stores its token encrypted with Electron safeStorage ("enc:v1:" + base64 of the OSCrypt ciphertext).
// test-client always starts Electron with Chromium's --use-mock-keychain switch: on macOS OSCrypt then uses an
// in-process fake keychain whose password is the fixed "mock_password" (Chromium 148
// components/os_crypt/sync/os_crypt_mac.mm GetKeychain, crypto/apple/fake_keychain_v2.mm), so the real login keychain
// is never read or written. The same derivation is done here to write a FAKE token that only that mock-keychain run
// can read: PBKDF2-HMAC-SHA1(password, "saltysalt", 1003 iterations, 16 bytes), AES-128-CBC, IV of 16 spaces,
// prefix "v10". A real client (real keychain) cannot decrypt it; it reads as a locked credential.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from './paths.mjs';

export const CREDENTIAL_PREFIX = 'enc:v1:';
const MOCK_KEYCHAIN_PASSWORD = 'mock_password';
const OFFICIAL = { apiBaseUrl: 'https://api.novelai.net', imageBaseUrl: 'https://image.novelai.net' };

/** Whether this platform's fake token can be written before start (macOS mock keychain). */
export const canPrewriteToken = () => process.platform === 'darwin';

function mockKeychainKey() {
  return crypto.pbkdf2Sync(MOCK_KEYCHAIN_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
}
const IV = Buffer.alloc(16, 0x20);

/** safeStorage.encryptString under --use-mock-keychain (macOS), as stored by the client's credential vault. */
export function encryptForMockKeychain(plaintext) {
  const cipher = crypto.createCipheriv('aes-128-cbc', mockKeychainKey(), IV);
  const body = Buffer.concat([Buffer.from('v10', 'utf8'), cipher.update(plaintext, 'utf8'), cipher.final()]);
  return CREDENTIAL_PREFIX + body.toString('base64');
}

/** The inverse, for the tool's own tests and for checking a value these tools wrote (never used on real data). */
export function decryptForMockKeychain(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(CREDENTIAL_PREFIX)) return null;
  const body = Buffer.from(stored.slice(CREDENTIAL_PREFIX.length), 'base64');
  if (body.subarray(0, 3).toString('utf8') !== 'v10') return null;
  const decipher = crypto.createDecipheriv('aes-128-cbc', mockKeychainKey(), IV);
  return Buffer.concat([decipher.update(body.subarray(3)), decipher.final()]).toString('utf8');
}

/** A clearly fake token: only ever sent to the fake service of a test data root. */
export const newFakeToken = () => `fake-dev-tools-${crypto.randomBytes(12).toString('hex')}`;

const settingsFile = dataRoot => path.join(dataRoot, dataPaths.SETTINGS_FILE_NAME);

/** Reads settings.json of a test data root as JSON (never decrypts or returns the token). */
function readExisting(dataRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(dataRoot), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function atomicWrite(file, text) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.dev-tools-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/**
 * Writes the test settings of a data root before the client starts. Always: no automatic update checks or backups,
 * optional language; onboarding done unless `firstRun` (then hasOnboarded is false: the app opens its first-run guide).
 * With `fakeNovelaiUrl` (http://127.0.0.1:<port>): custom endpoints on, no fallback to the official hosts, direct
 * connection (no proxy), and a fake token for the fake service (macOS: encrypted for the mock keychain) unless
 * `noToken` (then no token and no cached account: the app starts as a user who has not connected yet, still pointed at
 * the fake service). Without `fakeNovelaiUrl`: the official endpoints and NO token, so a fake token left from an
 * earlier fake run is never sent to NovelAI.
 */
export function writeTestSettings(dataRoot, { fakeNovelaiUrl, locale, fakeToken = newFakeToken(), anlas = 10_000, noToken = false, firstRun = false } = {}) {
  if (fakeNovelaiUrl !== undefined) {
    const url = new URL(fakeNovelaiUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error(`--fake-novelai must be a loopback http URL (got ${fakeNovelaiUrl}).`);
  }
  if (locale !== undefined && !['zh-CN', 'en-US'].includes(locale)) throw new Error('--locale must be zh-CN or en-US.');
  const existing = readExisting(dataRoot);
  const settings = { ...(existing.settings && typeof existing.settings === 'object' ? existing.settings : {}) };
  Object.assign(settings, { hasOnboarded: !firstRun, autoCheckUpdates: false, autoBackupEnabled: false });
  if (locale) settings.language = locale;
  const next = { ...existing, settings };
  let tokenWritten = false;
  if (fakeNovelaiUrl !== undefined) {
    const base = fakeNovelaiUrl.replace(/\/+$/, '');
    Object.assign(settings, { allowCustomEndpoint: true, allowCustomEndpointFallback: false, apiBaseUrl: base, imageBaseUrl: base, proxyMode: 'direct' });
    if (noToken) { delete next.token; delete next.account; }
    else if (canPrewriteToken()) {
      next.token = encryptForMockKeychain(fakeToken);
      next.account = { tierName: 'Opus', tierLevel: 3, anlasBalance: anlas, hasActiveSubscription: true };
      tokenWritten = true;
    } else { delete next.token; delete next.account; }
  } else {
    Object.assign(settings, { allowCustomEndpoint: false, allowCustomEndpointFallback: false, ...OFFICIAL });
    delete next.token; delete next.account;
  }
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  atomicWrite(settingsFile(dataRoot), `${JSON.stringify(next, null, 2)}\n`);
  return { file: settingsFile(dataRoot), tokenWritten, fakeToken: fakeNovelaiUrl !== undefined && !noToken ? fakeToken : null, endpoint: fakeNovelaiUrl ?? OFFICIAL.imageBaseUrl, firstRun, noToken: noToken || fakeNovelaiUrl === undefined };
}
