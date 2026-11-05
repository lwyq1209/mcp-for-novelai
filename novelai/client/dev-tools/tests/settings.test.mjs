import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CREDENTIAL_PREFIX, decryptForMockKeychain, encryptForMockKeychain, writeTestSettings } from '../lib/settings.mjs';
import { tempDir } from './helpers.mjs';

test('mock-keychain encryption matches an independent known answer (PBKDF2-SHA1 + AES-128-CBC, IV of spaces, v10)', () => {
  // Computed with Python hashlib.pbkdf2_hmac('sha1', b'mock_password', b'saltysalt', 1003, 16) and
  // `openssl enc -aes-128-cbc -K af0f762aaf6d7d11581b7aa8ce7218de -iv 2020…20`, then "v10" + ciphertext, base64.
  assert.equal(encryptForMockKeychain('fake-dev-tools-known-answer'), `${CREDENTIAL_PREFIX}djEwQ7szIoP5OGlq/RdPMoG+Y3LvrClo3U/Ja/Gt7O+CX6w=`);
  assert.equal(decryptForMockKeychain(`${CREDENTIAL_PREFIX}djEwQ7szIoP5OGlq/RdPMoG+Y3LvrClo3U/Ja/Gt7O+CX6w=`), 'fake-dev-tools-known-answer');
  assert.equal(decryptForMockKeychain('plain'), null);
});

test('fake mode: custom loopback endpoint, no official fallback, direct connection, fake token only', t => {
  if (process.platform !== 'darwin') return t.skip('the token is pre-written only on macOS (mock keychain)');
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ settings: { theme: 'dark', outputDir: path.join(dir, 'out') }, token: 'enc:v1:whatever-was-here' }));
  const written = writeTestSettings(dir, { fakeNovelaiUrl: 'http://127.0.0.1:4555/', locale: 'en-US', fakeToken: 'fake-dev-tools-abc' });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(written.tokenWritten, true);
  assert.equal(decryptForMockKeychain(saved.token), 'fake-dev-tools-abc');
  assert.deepEqual({ ...saved.settings, outputDir: undefined }, { theme: 'dark', outputDir: undefined, hasOnboarded: true, autoCheckUpdates: false, autoBackupEnabled: false, language: 'en-US', allowCustomEndpoint: true, allowCustomEndpointFallback: false, apiBaseUrl: 'http://127.0.0.1:4555', imageBaseUrl: 'http://127.0.0.1:4555', proxyMode: 'direct' });
  assert.equal(saved.account.anlasBalance, 10000);
});

test('without the fake service: official endpoints and NO token (a fake token never reaches NovelAI)', t => {
  const dir = tempDir(t);
  writeTestSettings(dir, { fakeNovelaiUrl: 'http://127.0.0.1:4555' });
  writeTestSettings(dir, {});
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.token, undefined);
  assert.equal(saved.account, undefined);
  assert.equal(saved.settings.allowCustomEndpoint, false);
  assert.equal(saved.settings.imageBaseUrl, 'https://image.novelai.net');
});

test('--no-token and --first-run: no token or cached account, the guide opens, still pointed at the fake service', t => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ settings: { hasOnboarded: true }, token: 'enc:v1:old', account: { anlasBalance: 5 } }));
  const written = writeTestSettings(dir, { fakeNovelaiUrl: 'http://127.0.0.1:4555', noToken: true, firstRun: true });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(saved.token, undefined);
  assert.equal(saved.account, undefined);
  assert.equal(saved.settings.hasOnboarded, false);
  assert.equal(saved.settings.imageBaseUrl, 'http://127.0.0.1:4555');
  assert.equal(saved.settings.allowCustomEndpointFallback, false);
  assert.deepEqual({ tokenWritten: written.tokenWritten, fakeToken: written.fakeToken, noToken: written.noToken, firstRun: written.firstRun }, { tokenWritten: false, fakeToken: null, noToken: true, firstRun: true });
  // Without the flags the next start writes the token again and marks onboarding done.
  writeTestSettings(dir, { fakeNovelaiUrl: 'http://127.0.0.1:4555' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).settings.hasOnboarded, true);
});

test('only loopback http URLs are accepted as the fake endpoint', t => {
  const dir = tempDir(t);
  for (const url of ['https://image.novelai.net', 'http://192.168.1.2:80', 'http://example.com']) assert.throws(() => writeTestSettings(dir, { fakeNovelaiUrl: url }), /loopback/);
  assert.throws(() => writeTestSettings(dir, { locale: 'fr-FR' }), /locale/);
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false);
});
