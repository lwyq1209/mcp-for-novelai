// The fake GitHub of the update rehearsals (lib/fake-release-server.mjs): the latest-release API, the download redirect
// and Range requests, the signed SHA256SUMS.txt (checked with the raw public key, as the app does), and every fault.
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPOSITORY, startFakeRelease } from '../lib/fake-release-server.mjs';
import { assetName, dataFingerprint } from '../update-rehearsal.mjs';
import { tempDir } from './helpers.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

async function release(t, faults = {}) {
  const dir = tempDir(t);
  const file = assetName('0.1.4-test');
  fs.writeFileSync(path.join(dir, file), Buffer.alloc(300_000, 7));
  const server = await startFakeRelease({ dir, tag: 'v0.1.4-test', privateKeyPem: pem, faults });
  t.after(() => server.close());
  return { server, file, bytes: fs.readFileSync(path.join(dir, file)) };
}
const get = (server, route, headers = {}) => fetch(`${server.url}${route}`, { headers, redirect: 'manual' });
const download = async (server, tag, name, headers = {}) => {
  const first = await get(server, `/${REPOSITORY}/releases/download/${tag}/${name}`);
  assert.equal(first.status, 302);
  const location = first.headers.get('location');
  return { location, response: await fetch(new URL(location, server.url), { headers }) };
};

test('serves the latest release, redirects downloads to its asset host and signs SHA256SUMS.txt', async t => {
  const { server, file, bytes } = await release(t);
  const latest = await (await get(server, `/repos/${REPOSITORY}/releases/latest`)).json();
  assert.equal(latest.tag_name, 'v0.1.4-test');
  assert.equal(latest.prerelease, false);
  const sums = Buffer.from(await (await download(server, 'v0.1.4-test', 'SHA256SUMS.txt')).response.arrayBuffer());
  assert.equal(sums.toString(), `${createHash('sha256').update(bytes).digest('hex')}  ${file}\n`);
  const signature = Buffer.from((await (await download(server, 'v0.1.4-test', 'SHA256SUMS.txt.sig')).response.text()).trim(), 'base64');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert.equal(verify(null, sums, key, signature), true);
  const { location, response } = await download(server, 'v0.1.4-test', file, { range: 'bytes=1000-' });
  assert.match(location, /^\/__assets\/v0\.1\.4-test\/.+\?token=[0-9a-f]+$/);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 1000-${bytes.length - 1}/${bytes.length}`);
  assert.equal(Buffer.from(await response.arrayBuffer()).length, bytes.length - 1000);
});

test('faults: another key, a tampered file, another latest tag, a foreign redirect, a cut-off and an HTTP error', async t => {
  const { server, file, bytes } = await release(t, { badSignature: true, tamper: true, latestTag: 'v0.1.2-test', foreignRedirect: true });
  assert.equal((await (await get(server, `/repos/${REPOSITORY}/releases/latest`)).json()).tag_name, 'v0.1.2-test');
  const first = await get(server, `/${REPOSITORY}/releases/download/v0.1.4-test/${file}`);
  assert.match(first.headers.get('location'), /^http:\/\/localhost:\d+\/__assets\//);
  const tampered = Buffer.from(await (await fetch(`${server.url}/__assets/v0.1.4-test/${file}`)).arrayBuffer());
  assert.equal(tampered.length, bytes.length);
  assert.notDeepEqual(tampered, bytes);
  const sums = Buffer.from(await (await fetch(`${server.url}/__assets/v0.1.4-test/SHA256SUMS.txt`)).arrayBuffer());
  const signature = Buffer.from((await (await fetch(`${server.url}/__assets/v0.1.4-test/SHA256SUMS.txt.sig`)).text()).trim(), 'base64');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  assert.equal(verify(null, sums, key, signature), false);
  server.setFaults({ dropAfterBytes: 100_000, dropTimes: 1 });
  await assert.rejects(fetch(`${server.url}/__assets/v0.1.4-test/${file}`).then(response => response.arrayBuffer()));
  assert.equal(Buffer.from(await (await fetch(`${server.url}/__assets/v0.1.4-test/${file}`)).arrayBuffer()).length, bytes.length);
  server.setFaults({ status: 503 });
  assert.equal((await fetch(`${server.url}/__assets/v0.1.4-test/${file}`)).status, 503);
  assert.equal((await fetch(`${server.url}/__assets/v0.1.4-test/SHA256SUMS.txt`)).status, 200);
  assert.ok(server.requests().some(entry => entry.dropped));
});

test('the rehearsal names the release files and fingerprints the user data of a data root', t => {
  assert.equal(assetName('0.1.4-test', 'darwin', 'arm64'), 'MCP-for-NovelAI-0.1.4-test-mac-arm64.zip');
  assert.equal(assetName('0.1.4-test', 'win32', 'x64'), 'MCP-for-NovelAI-0.1.4-test-win-x64-setup.exe');
  assert.equal(assetName('0.1.4-test', 'linux', 'x64'), 'MCP-for-NovelAI-0.1.4-test-linux-x64.tar.gz');
  assert.equal(typeof dataFingerprint, 'function');
});
