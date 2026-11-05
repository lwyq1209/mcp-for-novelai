import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// asset_library {action:"export"}: one history original, read through the host's strict original read, written
// unchanged into <project root>/novelai/library-exports. Offline: every host is a recording double; every
// directory is a fresh temporary project root.
const { createNovelAiMcpServer, BridgeError } = await import('../src/mcp.mjs');
const { historyCoverFileName } = await import('../src/history-cover.mjs');
const { HISTORY_EXPORT_NAME_ATTEMPTS } = await import('../src/history-export.mjs');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWM4YWSEFTEMLQkAc/tLAYZWnK0AAAAASUVORK5CYII=';
const bytes = Buffer.from(png, 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const ORIGINAL = { kind: 'history', id: 'h1', revision: 2, assetId: 'a1' };

/** The host's asset_library image reply for a history original, exactly as strict as production. */
const original = (args, overrides = {}) => ({ kind: 'history', id: args.id, revision: args.revision, assetId: args.assetId, role: 'original', variant: args.variant ?? 'thumbnail',
  mimeType: 'image/png', width: 8, height: 8, byteLength: bytes.length, sha256: sha(bytes), sourceMimeType: 'image/png', sourceWidth: 8, sourceHeight: 8, sourceByteLength: bytes.length, sourceSha256: sha(bytes),
  contentBinding: 'recorded-sha256', data: png, ...overrides });

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), 'novelai-export-project-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, exports: join(root, 'novelai', 'library-exports') };
}
async function connect(t, { root, exports }, handler = (method, args) => original(args)) {
  const calls = [];
  const bridgeClient = { async call(method, args) { calls.push({ method, args: structuredClone(args) }); return handler(method, args); } };
  const server = createNovelAiMcpServer({ bridgeClient, projectRoot: root, projectRootSource: 'NOVELAI_PROJECT_ROOT', materialExports: exports });
  const client = new Client({ name: 'export-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: async args => { const result = await client.callTool({ name: 'asset_library', arguments: args }); return result.isError ? { error: result.structuredContent.error } : result.structuredContent; } };
}

test('export copies the registered original unchanged and returns a project-relative file', async t => {
  const dirs = await project(t);
  const { call, calls } = await connect(t, dirs);
  const result = await call({ action: 'export', ...ORIGINAL });
  assert.deepEqual(calls, [{ method: 'asset_library', args: { action: 'image', kind: 'history', id: 'h1', revision: 2, assetId: 'a1', variant: 'original' } }], 'one strict original read, nothing else');
  assert.equal(result.file, 'novelai/library-exports/history-h1-r2.png');
  assert.equal(result.fileName, 'history-h1-r2.png');
  assert.equal(result.pathBase, 'project-root');
  assert.equal(result.projectRoot, 'NOVELAI_PROJECT_ROOT');
  assert.deepEqual({ ...result, file: undefined, fileName: undefined, pathBase: undefined, projectRoot: undefined }, { ...ORIGINAL, file: undefined, fileName: undefined, pathBase: undefined, projectRoot: undefined,
    mimeType: 'image/png', width: 8, height: 8, byteLength: bytes.length, sha256: sha(bytes), exported: true, generationSubmitted: false });
  assert.ok(!JSON.stringify(result).includes(dirs.root), 'the absolute project root never reaches the model');
  assert.deepEqual(await readFile(join(dirs.root, result.file)), bytes, 'bytes are exported unchanged');
  if (process.platform !== 'win32') assert.equal((await lstat(join(dirs.root, result.file))).mode & 0o777, 0o600);
});

test('export never overwrites: a taken name, an unrelated file or a dangling symlink moves it to the next numbered name', async t => {
  const dirs = await project(t);
  const { call } = await connect(t, dirs);
  assert.equal((await call({ action: 'export', ...ORIGINAL })).file, 'novelai/library-exports/history-h1-r2.png');
  assert.equal((await call({ action: 'export', ...ORIGINAL })).file, 'novelai/library-exports/history-h1-r2-2.png', 'a second export gets a new name');
  await writeFile(join(dirs.exports, 'history-h1-r2-3.png'), 'keep me');
  const outside = join(dirs.root, 'outside-target.png');
  await symlink(outside, join(dirs.exports, 'history-h1-r2-4.png'));
  assert.equal((await call({ action: 'export', ...ORIGINAL })).file, 'novelai/library-exports/history-h1-r2-5.png');
  assert.equal(await readFile(join(dirs.exports, 'history-h1-r2-3.png'), 'utf8'), 'keep me', 'an existing file is never overwritten');
  await assert.rejects(lstat(outside), { code: 'ENOENT' }, 'a dangling symlink is never followed');
  assert.ok((await lstat(join(dirs.exports, 'history-h1-r2-4.png'))).isSymbolicLink(), 'the symlink itself is left alone');
  assert.deepEqual(await readFile(join(dirs.exports, 'history-h1-r2.png')), bytes, 'the first export is untouched');
});

test('export refuses when every name is taken, without overwriting anything', async t => {
  const dirs = await project(t);
  await mkdir(dirs.exports, { recursive: true });
  const name = historyCoverFileName('h1', 2, 'image/png');
  for (let attempt = 0; attempt < HISTORY_EXPORT_NAME_ATTEMPTS; attempt++) await writeFile(join(dirs.exports, attempt ? name.replace('.png', `-${attempt + 1}.png`) : name), `taken ${attempt}`);
  const { call } = await connect(t, dirs);
  const result = await call({ action: 'export', ...ORIGINAL });
  assert.equal(result.error.code, 'export_name_unavailable');
  assert.equal(await readFile(join(dirs.exports, name), 'utf8'), 'taken 0');
  assert.equal((await readdir(dirs.exports)).length, HISTORY_EXPORT_NAME_ATTEMPTS);
});

test('export refuses a symlinked export folder before reading the original, and writes nothing through it', async t => {
  const dirs = await project(t);
  const elsewhere = await mkdtemp(join(tmpdir(), 'novelai-export-elsewhere-'));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await mkdir(join(dirs.root, 'novelai'), { recursive: true });
  await symlink(elsewhere, dirs.exports);
  const { call, calls } = await connect(t, dirs);
  const result = await call({ action: 'export', ...ORIGINAL });
  assert.equal(result.error.code, 'invalid_input');
  assert.match(result.error.message, /real directory, not a symlink/);
  assert.deepEqual(calls, [], 'the original is not even read');
  assert.deepEqual(await readdir(elsewhere), []);
});

test('export names: plain history ids are kept, any other id is hashed (same rule as history covers)', async t => {
  const dirs = await project(t);
  const { call } = await connect(t, dirs);
  const odd = { kind: 'history', id: '../../etc/passwd 日本', revision: 1, assetId: 'a' };
  const result = await call({ action: 'export', ...odd });
  assert.equal(result.fileName, historyCoverFileName(odd.id, 1, 'image/png'));
  assert.match(result.fileName, /^history-h-[a-f0-9]{24}-r1\.png$/);
  assert.equal(result.file, `novelai/library-exports/${result.fileName}`);
});

test('export validates its arguments and the host reply before writing anything', async t => {
  const dirs = await project(t);
  let reply = args => original(args);
  const { call, calls } = await connect(t, dirs, (method, args) => reply(args));
  for (const args of [
    { action: 'export', ...ORIGINAL, variant: 'original' }, { action: 'export', ...ORIGINAL, kind: 'study' }, { action: 'export', kind: 'history', id: 'h1', revision: 2 },
    { action: 'export', ...ORIGINAL, revision: 0 }, { action: 'export', ...ORIGINAL, query: '/tmp/x' }, { action: 'export', ...ORIGINAL, name: 'x.png' },
  ]) assert.equal((await call(args)).error.code, 'invalid_arguments', JSON.stringify(args));
  assert.deepEqual(calls, [], 'no invalid export reached the host');
  for (const bad of [args => original(args, { id: 'other' }), args => original(args, { sha256: 'f'.repeat(64) }), args => original(args, { data: Buffer.from('not an image').toString('base64') })]) {
    reply = bad;
    assert.equal((await call({ action: 'export', ...ORIGINAL })).error.code, 'invalid_response');
  }
  reply = () => { throw new BridgeError('library_not_found', 'No such history revision.'); };
  assert.equal((await call({ action: 'export', ...ORIGINAL })).error.code, 'library_not_found', 'a host refusal keeps its code');
  await assert.rejects(readdir(dirs.exports), { code: 'ENOENT' }, 'nothing was written, not even the folder');
});
