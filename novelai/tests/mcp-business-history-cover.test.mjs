import nodeTest, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// material_library set_cover_from_history. Offline: fetch refused, tag cache redirected. The cover save
// goes to the REAL host material library (client/electron/material-library.ts via jiti, a temporary
// directory and library), so its revision/coverRevision CAS, image decoding and metadata stripping are exercised.
// asset_library {action:image} is answered by a strict-valid history original built from real PNG bytes.
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-business-cover-cache-'));
const removeTagCache = () => rm(tagCacheDir, { recursive: true, force: true });
after(removeTagCache);
// When a top-level load below throws, node:test can exit without running after hooks or 'exit' listeners, so
// every such load goes through loadOrClean(), which removes the cache directory before rethrowing.
const loadOrClean = async load => { try { return await load(); } catch (error) { await removeTagCache(); throw error; } };
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in business MCP tests.'); };

const { createJiti } = await loadOrClean(() => import('jiti'));
const merged = await loadOrClean(() => import('../src/mcp.mjs'));
const { historyCoverFileName } = await loadOrClean(() => import('../src/history-cover.mjs'));
const { BridgeError } = merged;

// Every server test runs against the `novelai` server (src/mcp.mjs). Until 2026-10-09 each also ran against the
// `novelai-business` alias; the alias is gone, and the [novelai] label and SERVERS table are kept for stable names.
const SERVERS = [
  { label: 'novelai', module: 'src/mcp.mjs', factory: 'createNovelAiMcpServer', create: options => merged.createNovelAiMcpServer(options) },
];
let serverUnderTest = SERVERS[0];
const test = (name, fn) => { for (const variant of SERVERS) nodeTest(`[${variant.label}] ${name}`, t => { serverUnderTest = variant; return fn(t); }); };

// A valid 8×8 RGB PNG with a pHYs chunk (metadata the host strips). The 1×1 fixture used elsewhere is
// slightly corrupt for libpng, which the host's decoder refuses; that refusal is tested below.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4YWSEFTEMLQkAc/tLAYZWnK0AAAAASUVORK5CYII=';
const corruptPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const pngBytes = Buffer.from(png, 'base64');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HISTORY = { historyId: 'hist-1', historyRevision: 3, assetId: 'asset-1' };
const observed = new Set();

let createMaterialLibraryService, openLibraryRepository, fixtureDir;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'novelai-business-cover-host-'));
  const electron = join(fixtureDir, 'electron.mjs'), axios = join(fixtureDir, 'axios.mjs');
  await writeFile(electron, `const forbidden = () => { throw new Error('cover fixture cannot access native UI or account paths'); };
export const app = { getPath: forbidden, getVersion: forbidden }; export const dialog = {};
export const nativeImage = { createFromBuffer: forbidden, createFromPath: forbidden };`);
  await writeFile(axios, `const forbidden = () => { throw new Error('cover fixture cannot access the network'); };
export default { get: forbidden, post: forbidden, request: forbidden, create: forbidden };`);
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false, alias: { electron, axios } });
  ({ createMaterialLibraryService } = await jiti.import(fileURLToPath(new URL('../client/electron/material-library.ts', import.meta.url))));
  ({ openLibraryRepository } = await jiti.import(fileURLToPath(new URL('../client/electron/library/repository.ts', import.meta.url))));
});
after(async () => {
  globalThis.fetch = originalFetch;
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

/** The history original exactly as the host asset_library image action returns it (strictly valid). */
const historyOriginal = (args, patch = {}) => ({ kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, role: 'original', variant: 'original',
  mimeType: 'image/png', sourceMimeType: 'image/png', width: 8, height: 8, sourceWidth: 8, sourceHeight: 8, byteLength: pngBytes.length, sourceByteLength: pngBytes.length,
  sha256: sha(pngBytes), sourceSha256: sha(pngBytes), contentBinding: 'recorded-sha256', data: png, ...patch });

async function coverHost(t) {
  const directory = await mkdtemp(join(tmpdir(), 'novelai-business-cover-'));
  let repository;
  t.after(async () => { repository?.close(); await rm(directory, { recursive: true, force: true }); });
  const refused = async () => { throw new Error('no network in the cover fixture'); };
  repository = openLibraryRepository({ filePath: join(directory, 'library.sqlite'), libraryDirectory: directory });
  const service = createMaterialLibraryService({ directory, repository, tags: { search: refused, details: refused }, gallery: { search: refused, detail: refused, image: refused } });
  const calls = [], faults = {};
  const bridge = { async call(method, args) {
    observed.add(method);
    calls.push({ method, args: structuredClone(args) });
    const fault = faults[method];
    if (typeof fault === 'function' && fault.length === 0) { delete faults[method]; return fault(); }
    try {
      let result;
      if (method === 'asset_library') result = historyOriginal(args);
      else if (typeof service.methods[method] === 'function') result = JSON.parse(JSON.stringify(await service.methods[method](JSON.parse(JSON.stringify(args)))));
      else throw new BridgeError('unknown_method', 'No such host method.');
      if (fault === 'reply-lost') { delete faults[method]; throw new BridgeError('timeout', 'The client request was interrupted or timed out. Its outcome is unknown.'); }
      if (typeof fault === 'function') { delete faults[method]; return fault(result); }
      return result;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      const code = typeof error?.code === 'string' && !/^E[A-Z]+$/.test(error.code) ? error.code : 'bridge_error';
      throw new BridgeError(code, code === 'bridge_error' ? '桥接操作未完成。' : String(error.message), error.details);
    }
  } };
  const server = serverUnderTest.create({ bridgeClient: bridge });
  const client = new Client({ name: 'business-cover-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { service, calls, faults, call: (name, args) => client.callTool({ name, arguments: args }), count: method => calls.filter(call => call.method === method).length };
}
const errorOf = result => { assert.equal(result.isError, true, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent.error; };
const ok = result => { assert.ok(!result.isError, JSON.stringify(result.structuredContent ?? result)); return result.structuredContent; };
const saveTag = async (h, name = 'soft light') => ok(await h.call('material_library', { action: 'save', entry: { kind: 'tag', name, tag: { text: name, source: 'english', target: 'style' } } }));

test('set_cover_from_history reads the exact history original once and saves it through the real host local-cover path', async t => {
  const h = await coverHost(t);
  const entry = await saveTag(h);
  assert.equal(entry.revision, 1);
  const before = h.calls.length;
  const result = ok(await h.call('material_library', { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY }));
  assert.deepEqual(h.calls.slice(before).map(call => call.method), ['asset_library', 'material_samples']);
  assert.deepEqual(h.calls[before].args, { action: 'image', kind: 'history', id: 'hist-1', revision: 3, assetId: 'asset-1', variant: 'original' });
  const saved = h.calls[before + 1].args;
  assert.deepEqual({ ...saved, data: undefined }, { action: 'set_local_cover', entryId: entry.id, revision: 1, expectedCoverRevision: 0, fileName: 'history-hist-1-r3.png', data: undefined });
  assert.equal(saved.data, png, 'the unchanged history original is what the host decodes');
  assert.equal(result.entryId, entry.id); assert.equal(result.coverRevision, 1); assert.equal(result.generationSubmitted, false);
  assert.equal(result.cover.source, 'local'); assert.equal(result.fileName, 'history-hist-1-r3.png'); assert.equal(result.cover.mimeType, 'image/webp'); assert.equal(result.cover.verification, 'local');
  assert.deepEqual(Object.keys(result.cover).sort(), ['byteLength', 'height', 'mimeType', 'savedAt', 'sha256', 'source', 'sourceSha256', 'verification', 'width'], 'only allowlisted cover fields');
  assert.deepEqual(Object.keys(result).sort(), ['cover', 'coverRevision', 'entryId', 'fileName', 'generationSubmitted', 'instruction', 'source']);
  assert.equal(result.cover.sourceSha256, sha(pngBytes), 'the host recorded the digest of the bytes it received');
  assert.deepEqual(result.source, { kind: 'history', historyId: 'hist-1', historyRevision: 3, assetId: 'asset-1', mimeType: 'image/png', width: 8, height: 8, byteLength: pngBytes.length, sha256: sha(pngBytes) });
  assert.notEqual(result.cover.sha256, sha(pngBytes), 'the stored cover is the host-normalized WebP, not the original bytes');
  assert.ok(!JSON.stringify(result).includes(png), 'no image bytes in the result');
  const cover = await h.call('material_library', { action: 'cover', entryId: entry.id });
  assert.ok(!cover.isError); assert.equal(cover.content[1].type, 'image'); assert.equal(cover.content[1].mimeType, 'image/webp');
});

test('set_cover_from_history keeps CAS, never retries, requires a read after an unknown outcome and changes nothing on an invalid history reply', async t => {
  const h = await coverHost(t);
  const entry = await saveTag(h);
  const args = { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY };
  ok(await h.call('material_library', args));
  // Stale coverRevision / entry revision: the host refuses, the old cover stays, nothing is resent.
  const saves = h.count('material_samples');
  const stale = errorOf(await h.call('material_library', args));
  assert.equal(stale.code, 'cover_conflict'); assert.equal(stale.details.coverChanged, false); assert.equal(stale.details.entryId, entry.id); assert.equal(stale.details.historyId, 'hist-1');
  assert.equal(errorOf(await h.call('material_library', { ...args, revision: 2, expectedCoverRevision: 1 })).code, 'material_conflict');
  assert.equal(h.count('material_samples'), saves + 2, 'one host call per request, no retries');
  // Unknown outcome: the save happened but the reply was lost. The error says to read first, and a read shows the change.
  h.faults.material_samples = 'reply-lost';
  const unknown = errorOf(await h.call('material_library', { ...args, expectedCoverRevision: 1 }));
  assert.equal(unknown.code, 'cover_save_unknown'); assert.equal(unknown.details.coverChanged, 'unknown'); assert.match(unknown.message, /Do not resend; read the entry/);
  assert.equal(h.count('material_samples'), saves + 3);
  const read = ok(await h.call('material_library', { action: 'read', id: entry.id }));
  assert.equal(JSON.stringify(read).includes('"coverRevision":2'), true, JSON.stringify(read).slice(0, 400));
  // Invalid history replies: nothing reaches the cover store.
  const invalid = { wrongSha: { sha256: 'a'.repeat(64), sourceSha256: 'a'.repeat(64) }, wrongId: { id: 'hist-2' }, wrongRevision: { revision: 4 }, wrongAsset: { assetId: 'asset-2' }, thumbnail: { variant: 'thumbnail' },
    notImage: { data: Buffer.from('not an image!!').toString('base64'), byteLength: 14, sourceByteLength: 14, sha256: sha(Buffer.from('not an image!!')), sourceSha256: sha(Buffer.from('not an image!!')) },
    incomplete: { status: 'partial' } };
  for (const [name, patch] of Object.entries(invalid)) {
    const before = h.count('material_samples');
    h.faults.asset_library = () => historyOriginal({ id: 'hist-1', revision: 3, assetId: 'asset-1' }, patch);
    const error = errorOf(await h.call('material_library', { ...args, expectedCoverRevision: 2 }));
    assert.ok(['invalid_response', 'asset_response_incomplete'].includes(error.code), `${name}: ${error.code}`);
    assert.equal(h.count('material_samples'), before, `${name}: no cover save`);
  }
  h.faults.asset_library = () => { throw new BridgeError('asset_not_found', 'No such history image.'); };
  assert.equal(errorOf(await h.call('material_library', { ...args, expectedCoverRevision: 2 })).code, 'asset_not_found');
  // A history id that is not a plain file name is hashed into a host-valid provenance name.
  const odd = ok(await h.call('material_library', { ...args, expectedCoverRevision: 2, historyId: 'a/b:c d' }));
  assert.match(odd.fileName, /^history-h-[a-f0-9]{24}-r3\.png$/); assert.equal(odd.fileName, historyCoverFileName('a/b:c d', 3, 'image/png'));
  // Dimensions in the history reply are the host's report (not decoded by the validator); the stored cover's come from the host's own decode.
  h.faults.asset_library = () => historyOriginal({ id: 'hist-1', revision: 3, assetId: 'asset-1' }, { width: 9, sourceWidth: 9 });
  const reported = ok(await h.call('material_library', { ...args, expectedCoverRevision: 3 }));
  assert.equal(reported.source.width, 9); assert.equal(reported.cover.width, 8); assert.equal(reported.coverRevision, 4);
  // An original the host cannot decode safely is refused by the host itself; the old cover stays.
  const corrupt = Buffer.from(corruptPng, 'base64');
  h.faults.asset_library = () => historyOriginal({ id: 'hist-1', revision: 3, assetId: 'asset-1' }, { data: corruptPng, width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, byteLength: corrupt.length, sourceByteLength: corrupt.length, sha256: sha(corrupt), sourceSha256: sha(corrupt) });
  const undecodable = errorOf(await h.call('material_library', { ...args, expectedCoverRevision: 4 }));
  assert.equal(undecodable.code, 'cover_invalid_image'); assert.equal(undecodable.details.coverChanged, false);
  // Only tags have covers: the host refuses a note.
  const note = ok(await h.call('material_library', { action: 'save', entry: { kind: 'note', name: 'n' } }));
  assert.equal(errorOf(await h.call('material_library', { ...args, entryId: note.id, expectedCoverRevision: 0 })).code, 'invalid_argument');
});

test('N-5: the cover result passes only allowlisted, well-formed cover fields; nothing else from the host reply', async t => {
  const h = await coverHost(t);
  const entry = await saveTag(h);
  h.faults.material_samples = reply => ({ ...reply, entryId: 'someone-else', coverRevision: '1 /Users/Alice/x', debug: '/Users/Alice/Library/y/z', cover: { ...reply.cover,
    storedAt: '/Users/Alice/Library/Application Support/novelai/covers/abc.webp', message: 'saved to /Users/Alice/Library/x/y', fileName: '/Users/Alice/private/f.png', tagText: 'soft light',
    extra: { path: '/Users/Alice/z' }, mimeType: 'text/html', sourceSha256: '/Users/Alice/leak' } });
  const result = ok(await h.call('material_library', { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY }));
  assert.ok(!JSON.stringify(result).includes('/Users/Alice'), JSON.stringify(result));
  assert.deepEqual(Object.keys(result.cover).sort(), ['byteLength', 'height', 'savedAt', 'sha256', 'source', 'verification', 'width'], 'malformed mimeType/sourceSha256 and unknown fields are dropped');
  assert.equal(result.entryId, entry.id, 'the entry identity is the one requested, not the reply'); assert.equal(result.coverRevision, null, 'a malformed coverRevision is not passed on');
  assert.equal(result.debug, undefined); assert.equal(result.fileName, 'history-hist-1-r3.png');
});

test('N-3: host error details cannot smuggle paths or credentials under identity keys; this server\'s own details echo the submitted identity verbatim', async t => {
  const h = await coverHost(t);
  const entry = await saveTag(h);
  h.faults.asset_library = () => { throw new BridgeError('library_conflict', 'conflict at /Users/Alice/Library/secret/a.png token=abc', { assetId: '/Users/Alice/Library/Application Support/novelai/history/secret.png', historyId: 'api_key=sk-live-123', requestKey: { path: '/Users/Alice/.ssh/id_rsa', note: 'password: hunter2' }, other: '/Users/Alice/Library/y/z' }); };
  const injected = errorOf(await h.call('material_library', { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY }));
  assert.equal(injected.code, 'library_conflict');
  assert.deepEqual(injected.details, { assetId: '<path>', historyId: 'api_key=[redacted]', requestKey: { path: '<path>', note: 'password: [redacted]' }, other: '<path>' });
  assert.equal(injected.message, 'conflict at <path> token=[redacted]');
  // Our own refusal details carry the model's own submitted identities byte-for-byte, however they look.
  const odd = 'h /Users/Alice/private token=abc';
  ok(await h.call('material_library', { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY }));
  const conflict = errorOf(await h.call('material_library', { action: 'set_cover_from_history', entryId: entry.id, revision: 1, expectedCoverRevision: 0, ...HISTORY, historyId: odd }));
  assert.equal(conflict.code, 'cover_conflict'); assert.equal(conflict.details.historyId, odd); assert.equal(conflict.details.entryId, entry.id); assert.equal(conflict.details.assetId, HISTORY.assetId);
});

test('set_cover_from_history rejects invalid arguments before any host call', async t => {
  const h = await coverHost(t);
  const good = { action: 'set_cover_from_history', entryId: '12345678-1234-1234-1234-123456789abc', revision: 1, expectedCoverRevision: 0, ...HISTORY };
  const cases = [
    (({ assetId: _a, ...rest }) => rest)(good), (({ historyRevision: _r, ...rest }) => rest)(good), { ...good, entryId: 'not-a-uuid' }, { ...good, historyRevision: 0 }, { ...good, historyId: '' }, { ...good, historyId: '   ' },
    { ...good, assetId: 'x'.repeat(513) }, { ...good, expectedCoverRevision: -1 }, { ...good, data: png }, { ...good, file: 'a.png' }, { ...good, fileName: 'a.png' }, { ...good, variant: 'thumbnail' }, { ...good, url: 'https://x' },
  ];
  for (const args of cases) assert.equal(errorOf(await h.call('material_library', args)).code, 'invalid_arguments', JSON.stringify(args).slice(0, 120));
  assert.deepEqual(h.calls, []);
});

nodeTest('every host method observed across this file is on the business whitelist', () => {
  assert.deepEqual([...observed].sort(), ['asset_library', 'material_library', 'material_samples']);
});
