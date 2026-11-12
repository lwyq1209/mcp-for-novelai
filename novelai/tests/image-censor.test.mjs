import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// asset_library {action:"censor"}: the image's size from the strict thumbnail read, the mask rasterized here, one
// host render (censor_image), then a new JPEG in <project root>/novelai/library-exports — or, with preview, only the
// picture. Offline: the host is a recording double (the real render is tested in client/electron/censor-image.test.ts).
const { createNovelAiMcpServer, BridgeError } = await import('../src/mcp.mjs');
const { encodeMaskPng } = await import('../src/recipe-masks.mjs');
const { CENSOR_HOST_OUTDATED_MESSAGE, validateCensor } = await import('../src/image-censor.mjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4YWSEFTEMLQkAc/tLAYZWnK0AAAAASUVORK5CYII=';
const pngBytes = Buffer.from(png, 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const HISTORY = { kind: 'history', id: 'h1', revision: 2, assetId: 'a1' };
const STUDY = { kind: 'study', id: '0f0e0d0c-0b0a-4908-8706-050403020100', revision: 1 };
const MASK = { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 2, y: 3, width: 4, height: 3 } }] };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 5, 6, 7, 0xff, 0xd9]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([8, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

/** The host's strict image reply (thumbnail read): an 8×8 PNG original. */
const thumbnail = (args, overrides = {}) => ({ kind: args.kind, id: args.id, revision: args.revision, assetId: args.assetId ?? 'study-original', role: 'original', variant: args.variant ?? 'thumbnail',
  mimeType: 'image/png', width: 8, height: 8, byteLength: pngBytes.length, sha256: sha(pngBytes), sourceMimeType: 'image/png', sourceWidth: 8, sourceHeight: 8, sourceByteLength: pngBytes.length, sourceSha256: sha(pngBytes),
  contentBinding: 'recorded-sha256', data: png, ...overrides });
/** The host's censor_image reply for the bytes it "rendered". */
const rendered = (args, bytes = args.preview ? WEBP : JPEG, overrides = {}) => ({ kind: args.kind, id: args.id, revision: args.revision, preview: args.preview, saved: false, style: args.style, sizePx: args.sizePx ?? (args.style === 'mosaic' ? 4 : null), featherPx: args.featherPx,
  image: { mimeType: args.preview ? 'image/webp' : 'image/jpeg', width: 8, height: 8, byteLength: bytes.length, sha256: sha(bytes), data: bytes.toString('base64') }, ...overrides });
const host = (method, args) => method === 'censor_image' ? rendered(args) : thumbnail(args);

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'novelai-censor-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, exports: join(root, 'novelai', 'library-exports') };
}
async function connect(t, { root, exports }, handler = host) {
  const calls = [];
  const bridgeClient = { async call(method, args) { calls.push({ method, args: structuredClone(args) }); return handler(method, args); } };
  const server = createNovelAiMcpServer({ bridgeClient, projectRoot: root, projectRootSource: 'NOVELAI_PROJECT_ROOT', materialExports: exports });
  const client = new Client({ name: 'censor-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const raw = args => client.callTool({ name: 'asset_library', arguments: args });
  return { calls, raw, call: async args => { const result = await raw(args); return result.isError ? { error: result.structuredContent.error } : result.structuredContent; } };
}
/** The 8×8 selection of MASK: columns 2–5 of rows 3–5. */
const expectedMask = () => { const selection = new Uint8Array(64); for (let y = 3; y < 6; y++) for (let x = 2; x < 6; x++) selection[y * 8 + x] = 1; return encodeMaskPng(selection, 8, 8).toString('base64'); };

test('censor writes the rendered JPEG under a new name and reports what was covered', async t => {
  const dirs = await project(t);
  const { call, calls } = await connect(t, dirs);
  const result = await call({ action: 'censor', ...HISTORY, mask: MASK });
  assert.deepEqual(calls.map(item => item.method), ['asset_library', 'censor_image'], 'one size read, one render');
  assert.deepEqual(calls[0].args, { action: 'image', ...HISTORY, variant: 'thumbnail' });
  assert.deepEqual(calls[1].args, { ...HISTORY, sourceSha256: sha(pngBytes), mask: expectedMask(), style: 'mosaic', featherPx: 0, quality: 95, preview: false });
  assert.equal(result.file, 'novelai/library-exports/censored-history-h1-r2.jpg');
  assert.equal(result.fileName, 'censored-history-h1-r2.jpg');
  assert.equal(result.pathBase, 'project-root');
  assert.deepEqual({ exported: result.exported, preview: result.preview, mimeType: result.mimeType, quality: result.quality, byteLength: result.byteLength, sha256: result.sha256, metadata: result.metadata, style: result.style, sizePx: result.sizePx, width: result.width, height: result.height, generationSubmitted: result.generationSubmitted },
    { exported: true, preview: false, mimeType: 'image/jpeg', quality: 95, byteLength: JPEG.length, sha256: sha(JPEG), metadata: 'none', style: 'mosaic', sizePx: 4, width: 8, height: 8, generationSubmitted: false });
  assert.deepEqual(result.covered, { pixels: 12, percent: 18.75, bbox: { x: 2, y: 3, width: 4, height: 3 } });
  assert.deepEqual(result.mask.layers, [{ op: 'add', kind: 'rect', pixels: 12 }]);
  assert.ok(!JSON.stringify(result).includes(dirs.root), 'the absolute project root never reaches the model');
  assert.deepEqual(await readFile(join(dirs.root, result.file)), JPEG, 'the file is the host render, byte for byte');
  assert.equal((await call({ action: 'censor', ...HISTORY, mask: MASK })).file, 'novelai/library-exports/censored-history-h1-r2-2.jpg', 'a second export never replaces the first');
});

test('censor preview returns the picture as an image and writes nothing', async t => {
  const dirs = await project(t);
  const { raw, calls } = await connect(t, dirs);
  const result = await raw({ action: 'censor', ...HISTORY, mask: { units: 'fraction', layers: [{ op: 'add', shape: { type: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25 }, growPx: 1 }] }, style: 'blur', sizePx: 12, featherPx: 4, preview: true });
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  const value = result.structuredContent;
  assert.deepEqual(result.content.map(block => block.type), ['text', 'image']);
  assert.deepEqual({ mimeType: result.content[1].mimeType, data: result.content[1].data }, { mimeType: 'image/webp', data: WEBP.toString('base64') });
  assert.deepEqual(value.previewImage, { mimeType: 'image/webp', width: 8, height: 8, byteLength: WEBP.length, imageAttached: true }, 'the bytes are not repeated in the JSON');
  assert.deepEqual({ preview: value.preview, exported: value.exported, style: value.style, sizePx: value.sizePx, featherPx: value.featherPx, file: value.file }, { preview: true, exported: false, style: 'blur', sizePx: 12, featherPx: 4, file: undefined });
  assert.ok(value.covered.pixels > 0 && value.covered.bbox);
  assert.deepEqual({ style: calls[1].args.style, sizePx: calls[1].args.sizePx, featherPx: calls[1].args.featherPx, preview: calls[1].args.preview }, { style: 'blur', sizePx: 12, featherPx: 4, preview: true });
  await assert.rejects(readdir(dirs.exports), { code: 'ENOENT' }, 'a preview does not even create the folder');
});

test('censor takes an imported image by its study identity', async t => {
  const dirs = await project(t);
  const { call, calls } = await connect(t, dirs);
  const result = await call({ action: 'censor', ...STUDY, mask: MASK, style: 'black' });
  assert.deepEqual(calls[0].args, { action: 'image', ...STUDY, variant: 'thumbnail' });
  assert.deepEqual({ kind: calls[1].args.kind, id: calls[1].args.id, revision: calls[1].args.revision, assetId: calls[1].args.assetId, style: calls[1].args.style }, { ...STUDY, assetId: undefined, style: 'black' });
  assert.equal(result.file, `novelai/library-exports/censored-study-${STUDY.id}-r1.jpg`);
  assert.equal(result.sizePx, null);
});

test('censor refuses bad arguments before any host call', async t => {
  const dirs = await project(t);
  const { call, calls } = await connect(t, dirs);
  for (const args of [
    { action: 'censor', ...HISTORY }, { action: 'censor', kind: 'history', id: 'h1', revision: 2, mask: MASK }, { action: 'censor', ...STUDY, assetId: 'a1', mask: MASK },
    { action: 'censor', kind: 'tag', id: 't', revision: 1, mask: MASK }, { action: 'censor', ...HISTORY, mask: MASK, style: 'sticker' }, { action: 'censor', ...HISTORY, mask: MASK, style: 'white', sizePx: 8 },
    { action: 'censor', ...HISTORY, mask: MASK, sizePx: 1 }, { action: 'censor', ...HISTORY, mask: MASK, quality: 101 }, { action: 'censor', ...HISTORY, mask: MASK, featherPx: 49 },
    { action: 'censor', ...HISTORY, mask: MASK, variant: 'original' }, { action: 'censor', ...HISTORY, mask: MASK, name: 'x.jpg' }, { action: 'censor', ...HISTORY, mask: MASK, revision: 0 },
    { action: 'censor', ...HISTORY, mask: { units: 'px', layers: [] } }, { action: 'censor', ...HISTORY, mask: { units: 'px', layers: [{ op: 'subtract', shape: { type: 'rect', x: 0, y: 0, width: 2, height: 2 } }] } },
  ]) assert.equal((await call(args)).error?.code, 'invalid_arguments', JSON.stringify(args));
  assert.deepEqual(calls, [], 'nothing reached the host');
  assert.throws(() => validateCensor({ action: 'export', ...HISTORY, mask: MASK }), /censor takes/);
});

test('censor refuses an empty mask, a rotated original and an outdated client without rendering or writing', async t => {
  const dirs = await project(t);
  let handler = host;
  const { call, calls } = await connect(t, dirs, (method, args) => handler(method, args));
  const outside = await call({ action: 'censor', ...HISTORY, mask: { units: 'px', layers: [{ op: 'add', shape: { type: 'rect', x: 9, y: 9, width: 4, height: 4 } }] } });
  assert.equal(outside.error.code, 'mask_empty');
  assert.deepEqual(calls.map(item => item.method), ['asset_library'], 'the render was never asked for');
  handler = (method, args) => method === 'censor_image' ? rendered(args) : thumbnail(args, { sourceOrientation: 6 });
  const rotated = await call({ action: 'censor', ...STUDY, mask: MASK });
  assert.equal(rotated.error.code, 'invalid_arguments'); assert.equal(rotated.error.details.reason, 'source_orientation_unsupported');
  handler = (method, args) => { if (method === 'censor_image') throw new BridgeError('unsupported_method', 'unknown'); return thumbnail(args); };
  const outdated = await call({ action: 'censor', ...HISTORY, mask: MASK });
  assert.equal(outdated.error.code, 'host_outdated'); assert.equal(outdated.error.message, CENSOR_HOST_OUTDATED_MESSAGE);
  handler = (method, args) => { if (method === 'censor_image') throw new BridgeError('image_changed', 'The original is not the one the mask was made for.'); return thumbnail(args); };
  assert.equal((await call({ action: 'censor', ...HISTORY, mask: MASK })).error.code, 'image_changed', 'a host refusal keeps its code');
  assert.deepEqual(await readdir(dirs.exports).catch(() => []), [], 'no file was written');
});

test('censor checks the host render before writing it', async t => {
  const dirs = await project(t);
  let reply = args => rendered(args);
  const { call } = await connect(t, dirs, (method, args) => method === 'censor_image' ? reply(args) : thumbnail(args));
  for (const bad of [
    args => rendered(args, JPEG, { saved: true }), args => rendered(args, Buffer.from('not a jpeg at all')), args => ({ ...rendered(args), image: { ...rendered(args).image, sha256: 'f'.repeat(64) } }),
    args => ({ ...rendered(args), image: { ...rendered(args).image, width: 16 } }), args => ({ ...rendered(args), image: { ...rendered(args).image, mimeType: 'image/png' } }), args => ({ ...rendered(args), preview: true }), () => ({}),
  ]) {
    reply = bad;
    assert.equal((await call({ action: 'censor', ...HISTORY, mask: MASK })).error.code, 'invalid_response');
  }
  assert.deepEqual(await readdir(dirs.exports).catch(() => []), [], 'nothing was written');
});
