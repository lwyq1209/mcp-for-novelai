import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fsp, { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, link } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Same offline guard as mcp-business.test.mjs: fetch refused, tag cache redirected,
// modules imported only afterwards. Every filesystem fixture lives in os.tmpdir().
const tagCacheDir = await mkdtemp(join(tmpdir(), 'novelai-business-hardening-cache-'));
const removeTagCache = () => rm(tagCacheDir, { recursive: true, force: true });
nodeTest.after(removeTagCache);
// When a top-level load below throws, node:test can exit without running after hooks or 'exit' listeners, so
// every such load goes through loadOrClean(), which removes the cache directory before rethrowing.
const loadOrClean = async load => { try { return await load(); } catch (error) { await removeTagCache(); throw error; } };
process.env.NOVELAI_TAG_QUERY_CACHE_DIR = tagCacheDir;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Real network access is forbidden in business MCP tests.'); };
nodeTest.after(() => { globalThis.fetch = originalFetch; });

const merged = await loadOrClean(() => import('../src/mcp.mjs'));
const { MATERIAL_INBOX, MATERIAL_EXPORTS } = await loadOrClean(() => import('../src/material-tools.mjs'));
const { STUDY_INBOX, STUDY_EXPORTS } = await loadOrClean(() => import('../src/study-tools.mjs'));
const { BridgeError } = merged;
const { Client } = await loadOrClean(() => import('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await loadOrClean(() => import('@modelcontextprotocol/sdk/inMemory.js'));

// Every server test runs against the `novelai` server (src/mcp.mjs). Until 2026-10-09 each also ran against the
// `novelai-business` alias; the alias is gone, and the [novelai] label and SERVERS table are kept for stable names.
const SERVERS = [
  { label: 'novelai', module: 'src/mcp.mjs', factory: 'createNovelAiMcpServer', create: options => merged.createNovelAiMcpServer(options) },
];
let serverUnderTest = SERVERS[0];
const test = (name, fn) => { for (const variant of SERVERS) nodeTest(`[${variant.label}] ${name}`, t => { serverUnderTest = variant; return fn(t); }); };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The production default project root (NOVELAI_PROJECT_ROOT, else <data root>/workspace).
const { PROJECT_ROOT } = await loadOrClean(() => import('../src/business-guards.mjs'));
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9AAAAABJRU5ErkJggg==';
const pngBytes = Buffer.from(png, 'base64');
const ENTRY = '12345678-1234-1234-1234-123456789abc';
const BATCH = 'abcdef01-2345-6789-abcd-ef0123456789';
const OUTSIDE = 'outside-inbox-content';

async function connect(t, handler, options = {}) {
  const calls = [];
  const bridgeClient = { async call(method, args) { calls.push({ method, args: structuredClone(args) }); return handler(method, args); } };
  const server = serverUnderTest.create({ bridgeClient, ...options });
  const client = new Client({ name: 'hardening-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return { calls, call: (name, args) => client.callTool({ name, arguments: args }) };
}
async function tempBase(t, prefix) {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}
const hostReply = (method, args) => {
  if (method === 'material_studies' && args.action === 'import') return { study: { id: 's-1', revision: 1, name: args.name, sha256: 'x' }, duplicate: false };
  if (method === 'material_studies' && args.action === 'read') return { study: { id: 's-1', revision: 1 }, section: 'summary' };
  if (method === 'material_studies' && args.action === 'original') return { id: 's-1', sha256: 'e'.repeat(64), mimeType: 'image/png', data: png };
  if (method === 'material_library' && args.action === 'export') return { data: { schemaVersion: 1, entries: [] } };
  if (method === 'material_library' && args.action === 'import') return { count: 0, items: [] };
  if (method === 'material_samples') return { entryId: ENTRY, coverRevision: 1 };
  return { entry: { id: ENTRY, revision: 1, kind: 'note', name: 'n', archived: false } };
};
const rejected = result => result.isError === true || (Array.isArray(result.structuredContent?.items) && result.structuredContent.items.every(item => item.status === 'failed'));
const leaked = calls => JSON.stringify(calls).includes(OUTSIDE) || JSON.stringify(calls).includes(Buffer.from(OUTSIDE).toString('base64'));
const slash = path => path + sep; // the production constant form: MATERIAL_INBOX and friends end with a separator

test('P2-1: production-form directories (trailing separator) keep refusing symlinked inboxes and exports', async t => {
  assert.ok([MATERIAL_INBOX, MATERIAL_EXPORTS, STUDY_INBOX, STUDY_EXPORTS].every(path => path.endsWith(sep)), 'defaults end with a separator');
  const base = await tempBase(t, 'novelai-business-p21-');
  const elsewhere = join(base, 'elsewhere'); await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'entry.json'), JSON.stringify({ entry: { kind: 'note', name: OUTSIDE } }));
  await writeFile(join(elsewhere, 'backup.json'), JSON.stringify({ schemaVersion: 1, entries: [{ kind: 'note', name: OUTSIDE }] }));
  await writeFile(join(elsewhere, 'manifest.json'), JSON.stringify({ files: ['a.png'], sourceAuthor: OUTSIDE }));
  await writeFile(join(elsewhere, 'a.png'), Buffer.concat([pngBytes, Buffer.from(OUTSIDE)]));
  await writeFile(join(elsewhere, 'c.png'), Buffer.concat([pngBytes, Buffer.from(OUTSIDE)]));
  const exportA = join(base, 'export-target-a'), exportB = join(base, 'export-target-b');
  await mkdir(exportA); await mkdir(exportB);
  await symlink(elsewhere, join(base, 'library-inbox')); await symlink(elsewhere, join(base, 'study-inbox'));
  await symlink(exportA, join(base, 'library-exports')); await symlink(exportB, join(base, 'study-exports'));
  const linked = { materialInbox: slash(join(base, 'library-inbox')), studyInbox: slash(join(base, 'study-inbox')), materialExports: slash(join(base, 'library-exports')), studyExports: slash(join(base, 'study-exports')) };
  const { call, calls } = await connect(t, hostReply, linked);
  const attempts = [
    ['material_library', { action: 'save', file: 'entry.json' }], ['material_library', { action: 'import', file: 'backup.json' }],
    ['material_library', { action: 'set_local_cover', entryId: ENTRY, revision: 1, expectedCoverRevision: 0, file: 'c.png' }],
    ['material_studies', { action: 'import', files: ['a.png'] }], ['material_studies', { action: 'import', file: 'manifest.json' }],
    ['material_library', { action: 'export' }], ['material_studies', { action: 'read', id: 's-1', toFile: true }], ['material_studies', { action: 'original', id: 's-1' }],
  ];
  const outcomes = [];
  for (const [tool, args] of attempts) {
    const before = calls.length, result = await call(tool, args);
    outcomes.push({ tool, action: args.action, rejected: rejected(result), hostCalls: calls.slice(before).map(c => c.method), error: result.structuredContent?.error?.code ?? null });
  }
  assert.deepEqual(outcomes.filter(outcome => !outcome.rejected || outcome.hostCalls.length), [], JSON.stringify(outcomes, null, 1));
  assert.ok(!leaked(calls), 'no content from outside the inbox reached the host');
  assert.deepEqual([await readdir(exportA), await readdir(exportB)], [[], []], 'nothing written through symlinked export directories');

  // Real inboxes, but symlinked export directories: file-writing actions are refused before the host.
  const realInbox = join(base, 'real-library-inbox'), realStudy = join(base, 'real-study-inbox');
  await mkdir(realInbox); await mkdir(realStudy); await writeFile(join(realStudy, 'a.png'), pngBytes);
  const exportsOnly = await connect(t, hostReply, { ...linked, materialInbox: slash(realInbox), studyInbox: slash(realStudy) });
  for (const [tool, args] of [['material_library', { action: 'export' }], ['material_studies', { action: 'import', files: ['a.png'] }], ['material_studies', { action: 'read', id: 's-1', toFile: true }], ['material_studies', { action: 'original', id: 's-1' }]]) {
    const result = await exportsOnly.call(tool, args);
    assert.equal(result.isError, true, `${tool} ${args.action} ${JSON.stringify(result.structuredContent)}`);
  }
  assert.deepEqual(exportsOnly.calls, []);
  assert.deepEqual([await readdir(exportA), await readdir(exportB)], [[], []]);
});

test('P2-1: default directories are normalized before reaching the core, and production-form real directories still work', async t => {
  const { resolveBusinessDirectories } = await import('../src/business-guards.mjs');
  assert.equal(typeof resolveBusinessDirectories, 'function');
  const defaults = resolveBusinessDirectories();
  assert.deepEqual(defaults, { materialInbox: resolve(MATERIAL_INBOX), materialExports: resolve(MATERIAL_EXPORTS), studyInbox: resolve(STUDY_INBOX), studyExports: resolve(STUDY_EXPORTS) });
  assert.ok(Object.values(defaults).every(path => !path.endsWith(sep)));
  const base = await tempBase(t, 'novelai-business-p21-real-');
  const dirs = { materialInbox: join(base, 'library-inbox'), studyInbox: join(base, 'study-inbox'), materialExports: join(base, 'library-exports'), studyExports: join(base, 'study-exports') };
  await mkdir(dirs.materialInbox); await mkdir(dirs.studyInbox);
  await writeFile(join(dirs.materialInbox, 'entry.json'), JSON.stringify({ entry: { kind: 'note', name: 'inside' } }));
  await writeFile(join(dirs.studyInbox, 'a.png'), pngBytes);
  const { call, calls } = await connect(t, hostReply, Object.fromEntries(Object.entries(dirs).map(([key, value]) => [key, slash(value)])));
  assert.ok(!(await call('material_library', { action: 'save', file: 'entry.json' })).isError);
  assert.ok(!(await call('material_library', { action: 'export' })).isError);
  const imported = await call('material_studies', { action: 'import', files: ['a.png'] });
  assert.equal(imported.structuredContent.counts.saved, 1);
  assert.deepEqual(calls.map(c => `${c.method}:${c.args.action}`), ['material_library:save', 'material_library:export', 'material_studies:import']);
  assert.equal((await readdir(dirs.materialExports)).length, 1);
  assert.equal((await readdir(dirs.studyExports)).length, 1);
});

test('P3-4: hard links, symlinks and directories inside inboxes are refused before the host', async t => {
  const base = await tempBase(t, 'novelai-business-p34-');
  const outside = join(base, 'outside'); await mkdir(outside);
  const dirs = { materialInbox: join(base, 'library-inbox'), studyInbox: join(base, 'study-inbox'), materialExports: join(base, 'library-exports'), studyExports: join(base, 'study-exports') };
  await mkdir(dirs.materialInbox); await mkdir(dirs.studyInbox);
  await writeFile(join(outside, 'entry.json'), JSON.stringify({ entry: { kind: 'note', name: OUTSIDE } }));
  await writeFile(join(outside, 'private.png'), Buffer.concat([pngBytes, Buffer.from(OUTSIDE)]));
  await writeFile(join(outside, 'manifest.json'), JSON.stringify({ files: ['ok.png'] }));
  await link(join(outside, 'entry.json'), join(dirs.materialInbox, 'hard.json'));
  await link(join(outside, 'private.png'), join(dirs.materialInbox, 'hard.png'));
  await link(join(outside, 'private.png'), join(dirs.studyInbox, 'hard.png'));
  await link(join(outside, 'manifest.json'), join(dirs.studyInbox, 'hard-manifest.json'));
  await symlink(join(outside, 'entry.json'), join(dirs.materialInbox, 'soft.json'));
  await symlink(join(outside, 'private.png'), join(dirs.studyInbox, 'soft.png'));
  await mkdir(join(dirs.materialInbox, 'dir.json'));
  await writeFile(join(dirs.studyInbox, 'ok.png'), pngBytes);
  await writeFile(join(dirs.studyInbox, 'lists-hard.json'), JSON.stringify({ files: ['ok.png', 'hard.png'] }));
  await writeFile(join(dirs.studyInbox, 'lists-object.json'), JSON.stringify({ files: [{ file: 'hard.png', sourceAuthor: 'x' }] }));
  const { call, calls } = await connect(t, hostReply, dirs);
  const attempts = [
    ['material_library', { action: 'save', file: 'hard.json' }], ['material_library', { action: 'import', file: 'hard.json' }], ['material_library', { action: 'save', file: 'soft.json' }], ['material_library', { action: 'save', file: 'dir.json' }],
    ['material_library', { action: 'set_local_cover', entryId: ENTRY, revision: 1, expectedCoverRevision: 0, file: 'hard.png' }],
    ['material_studies', { action: 'import', files: ['hard.png'] }], ['material_studies', { action: 'import', files: ['ok.png', 'hard.png'] }], ['material_studies', { action: 'import', files: ['soft.png'] }],
    ['material_studies', { action: 'import', file: 'hard-manifest.json' }], ['material_studies', { action: 'import', file: 'lists-hard.json' }], ['material_studies', { action: 'import', file: 'lists-object.json' }],
  ];
  const outcomes = [];
  for (const [tool, args] of attempts) {
    const before = calls.length, result = await call(tool, args);
    outcomes.push({ tool, args, rejected: rejected(result), hostCalls: calls.slice(before).map(c => `${c.method}:${c.args.action}`), error: result.structuredContent?.error ?? null });
  }
  assert.deepEqual(outcomes.filter(outcome => !outcome.rejected || outcome.hostCalls.length), [], JSON.stringify(outcomes, null, 1));
  assert.ok(!leaked(calls), 'no hard-linked outside content reached the host');
  for (const outcome of outcomes) for (const text of [base, tmpdir()]) assert.ok(!JSON.stringify(outcome.error ?? '').includes(text), JSON.stringify(outcome));
  // The ordinary single-link file in the same inbox still imports.
  assert.equal((await call('material_studies', { action: 'import', files: ['ok.png'] })).structuredContent.counts.saved, 1);
});

function child(code, env, timeoutMs = 5000) {
  return new Promise(done => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', data => { stdout += data; }); proc.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); done({ hung: true, stdout, stderr }); }, timeoutMs);
    proc.on('exit', status => { clearTimeout(timer); done({ hung: false, status, stdout, stderr }); });
  });
}
const childEnv = extra => { const env = { ...process.env, ...extra }; delete env.NODE_TEST_CONTEXT; return env; };

test('P3-3: FIFOs in inboxes are refused promptly instead of blocking the server', async t => {
  const base = await tempBase(t, 'novelai-business-p33-');
  const dirs = { materialInbox: join(base, 'library-inbox'), studyInbox: join(base, 'study-inbox'), materialExports: join(base, 'library-exports'), studyExports: join(base, 'study-exports') };
  await mkdir(dirs.materialInbox); await mkdir(dirs.studyInbox);
  for (const path of [join(dirs.materialInbox, 'fifo.json'), join(dirs.materialInbox, 'fifo.png'), join(dirs.studyInbox, 'fifo.png'), join(dirs.studyInbox, 'fifo.json')]) execFileSync('mkfifo', [path]);
  await writeFile(join(dirs.studyInbox, 'lists-fifo.json'), JSON.stringify({ files: ['fifo.png'] }));
  const cases = {
    save: ['material_library', { action: 'save', file: 'fifo.json' }], import: ['material_library', { action: 'import', file: 'fifo.json' }],
    cover: ['material_library', { action: 'set_local_cover', entryId: ENTRY, revision: 1, expectedCoverRevision: 0, file: 'fifo.png' }],
    study: ['material_studies', { action: 'import', files: ['fifo.png'] }], manifest: ['material_studies', { action: 'import', file: 'fifo.json' }], listed: ['material_studies', { action: 'import', file: 'lists-fifo.json' }],
  };
  const code = `
    globalThis.fetch = async () => { throw new Error('network forbidden'); };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { ${serverUnderTest.factory}: createServer } = await import(${JSON.stringify(pathToFileURL(join(root, serverUnderTest.module)).href)});
    const hostCalls = [];
    const server = createServer({ bridgeClient: { async call(method) { hostCalls.push(method); return {}; } }, ...JSON.parse(process.env.DIRS) });
    const client = new Client({ name: 'fifo', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const [tool, args] = JSON.parse(process.env.CASE);
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60000 });
    console.log(JSON.stringify({ isError: !!result.isError, error: result.structuredContent?.error ?? null, items: result.structuredContent?.items ?? null, hostCalls }));
    process.exit(0);`;
  const results = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, value]) => [name, await child(code, childEnv({ DIRS: JSON.stringify(dirs), CASE: JSON.stringify(value), NOVELAI_TAG_QUERY_CACHE_DIR: join(base, 'cache'), NOVELAI_DATA_DIR: join(base, 'data') }))])));
  const summary = Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.hung ? 'HUNG' : (() => { try { return JSON.parse(result.stdout.trim().split('\n').at(-1)); } catch { return { unparsed: result.stdout + result.stderr }; } })()]));
  for (const [name, value] of Object.entries(summary)) {
    assert.notEqual(value, 'HUNG', `${name} blocked on a FIFO: ${JSON.stringify(summary)}`);
    assert.equal(value.isError, true, `${name}: ${JSON.stringify(value)}`);
    assert.deepEqual(value.hostCalls, [], name);
  }
});

test('P3-1: unrecognized errors become internal_error and echoed messages lose paths and credentials', async t => {
  const plain = () => { throw new Error("open '/Users/someone/novelai/.runtime/bridge.json' failed; token=abc123"); };
  const coded = () => { throw Object.assign(new Error('/Users/someone/private/path host_down'), { code: 'host_down' }); };
  const errno = () => { throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/someone/secret.json'"), { code: 'ENOENT', syscall: 'open' }); };
  for (const thrower of [plain, coded, errno]) {
    const { call } = await connect(t, thrower);
    for (const [tool, args] of [['read_queue', { batchId: BATCH }], ['material_library', { action: 'list' }], ['material_studies', { action: 'list' }]]) {
      const error = (await call(tool, args)).structuredContent.error;
      assert.deepEqual(error, { code: 'internal_error', message: 'The business tool failed. Read current state before continuing.' }, `${tool}: ${JSON.stringify(error)}`);
    }
  }
  const projectFile = join(PROJECT_ROOT, 'novelai', 'library', 'entry.json');
  const recognized = () => { throw new BridgeError('host_rejected', `open '/Users/someone/x/y.json' and '${projectFile}' failed; token=abc123; Authorization: Bearer abc.def.ghi; api_key: k-123 (see https://danbooru.donmai.us/tags.json?api_key=zz&login=me)`, { note: "path '/Users/someone/a.png'", apiKey: 'dropped' }); };
  const { call } = await connect(t, recognized);
  const error = (await call('material_library', { action: 'list' })).structuredContent.error;
  assert.equal(error.code, 'host_rejected');
  for (const secret of ['/Users/someone', 'abc123', 'abc.def.ghi', 'k-123', 'zz', 'login=me', PROJECT_ROOT]) assert.ok(!JSON.stringify(error).includes(secret), `${secret} echoed: ${JSON.stringify(error)}`);
  assert.match(error.message, /novelai\/library\/entry\.json/, 'project paths become project-relative');
  assert.match(error.message, /<path>/);
  assert.match(error.message, /https:\/\/danbooru\.donmai\.us\/tags\.json/);
  assert.deepEqual(Object.keys(error.details), ['note']);
  assert.ok(!error.details.note.includes('/Users/someone'));
  // Per-item study import failures pass through the same scrub.
  const base = await tempBase(t, 'novelai-business-p31-');
  const dirs = { materialInbox: join(base, 'li'), studyInbox: join(base, 'si'), materialExports: join(base, 'le'), studyExports: join(base, 'se') };
  await mkdir(dirs.studyInbox); await writeFile(join(dirs.studyInbox, 'a.png'), pngBytes);
  const study = await connect(t, recognized, dirs);
  const item = (await study.call('material_studies', { action: 'import', files: ['a.png'] })).structuredContent.items[0];
  assert.equal(item.code, 'host_rejected');
  for (const secret of ['/Users/someone', 'abc123', 'abc.def.ghi', base]) assert.ok(!JSON.stringify(item).includes(secret), JSON.stringify(item));
  // Useful core explanations are kept.
  const core = await connect(t, hostReply, dirs);
  assert.deepEqual((await core.call('material_library', { action: 'save', file: '../entry.json' })).structuredContent.error, { code: 'request_rejected', message: 'Use a direct JSON filename in novelai/library-inbox.' });
});

test('P3-2: export and report paths inside the project are returned project-relative', async t => {
  const base = await tempBase(t, 'novelai-business-p32-');
  const project = join(base, 'project');
  const dirs = { materialInbox: join(project, 'novelai', 'library-inbox'), studyInbox: join(project, 'novelai', 'study-inbox'), materialExports: join(project, 'novelai', 'library-exports'), studyExports: join(project, 'novelai', 'study-exports') };
  await mkdir(dirs.materialInbox, { recursive: true }); await mkdir(dirs.studyInbox, { recursive: true });
  await writeFile(join(dirs.studyInbox, 'a.png'), pngBytes);
  const sha = (await import('node:crypto')).createHash('sha256').update(pngBytes).digest('hex');
  const reply = (method, args) => method === 'material_studies' && args.action === 'original' ? { id: 's-1', sha256: sha, mimeType: 'image/png', data: png } : hostReply(method, args);
  const { call } = await connect(t, reply, { ...dirs, projectRoot: project });
  const results = {
    export: (await call('material_library', { action: 'export' })).structuredContent,
    report: (await call('material_studies', { action: 'import', files: ['a.png'] })).structuredContent,
    original: (await call('material_studies', { action: 'original', id: 's-1' })).structuredContent,
    read: (await call('material_studies', { action: 'read', id: 's-1', toFile: true })).structuredContent,
  };
  const relative = { export: results.export.file, report: results.report.reportFile, original: results.original.file, read: results.read.file };
  assert.match(relative.export, /^novelai\/library-exports\/[a-f0-9-]{36}\.json$/, JSON.stringify(results));
  assert.match(relative.report, /^novelai\/study-exports\/[a-f0-9-]{36}\.json$/);
  assert.match(relative.original, /^novelai\/study-exports\/[a-f0-9-]{36}\.png$/);
  assert.match(relative.read, /^novelai\/study-exports\/[a-f0-9-]{36}\.json$/);
  for (const value of Object.values(results)) { assert.equal(value.pathBase, 'project-root'); assert.ok(!JSON.stringify(value).includes(base)); }
  assert.deepEqual(await readFile(join(project, relative.original)), pngBytes, 'the relative path resolves against the project root');
  // Paths outside the project root stay absolute (only possible with injected directories).
  const other = await connect(t, reply, { ...dirs, projectRoot: join(base, 'elsewhere') });
  const outside = (await other.call('material_library', { action: 'export' })).structuredContent;
  assert.equal(outside.file.startsWith(dirs.materialExports), true);
  assert.equal(outside.pathBase, undefined);
});

test('P3-5: production tag_details path (no NODE_TEST_CONTEXT) writes only the redirected cache', async t => {
  const base = await tempBase(t, 'novelai-business-p35-');
  const cache = join(base, 'tag-cache');
  // The default cache would be <data root>/runtime/public-tag-query-cache-v1; the data root is a throwaway base/data.
  const defaultCache = join(base, 'data', 'runtime', 'public-tag-query-cache-v1');
  const code = `
    const fetched = [];
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async url => { const u = new URL(String(url)); fetched.push(u.origin + u.pathname);
      if (u.origin !== 'https://danbooru.donmai.us') throw new Error('unexpected host');
      if (u.pathname === '/tags.json') return json([{ id: 1, name: 'collared_shirt', category: 0, post_count: 5, is_deprecated: false }]);
      if (u.pathname === '/wiki_pages.json') return json([{ id: 2, title: 'collared_shirt', body: 'fixture', is_deleted: false }]);
      return json([]); };
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { ${serverUnderTest.factory}: createServer } = await import(${JSON.stringify(pathToFileURL(join(root, serverUnderTest.module)).href)});
    const server = createServer({ bridgeClient: { async call() { throw new Error('no host'); } } });
    const client = new Client({ name: 'p35', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    const first = await client.callTool({ name: 'tag_details', arguments: { name: 'collared_shirt' } });
    const second = await client.callTool({ name: 'tag_details', arguments: { name: 'collared_shirt' } });
    console.log(JSON.stringify({ testContext: process.env.NODE_TEST_CONTEXT ?? null, first: first.structuredContent, second: second.structuredContent, fetched }));
    process.exit(0);`;
  const result = await child(code, childEnv({ NOVELAI_TAG_QUERY_CACHE_DIR: cache, NOVELAI_DATA_DIR: join(base, 'data') }), 15000);
  assert.equal(result.hung, false, result.stderr);
  const output = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(output.testContext, null);
  assert.equal(output.first.items[0].resolution, 'canonical');
  // tag and alias requests run concurrently, so compare as a set; three fetches in total means the second lookup came from the cache.
  assert.deepEqual([...output.fetched].sort(), ['https://danbooru.donmai.us/tag_aliases.json', 'https://danbooru.donmai.us/tags.json', 'https://danbooru.donmai.us/wiki_pages.json'], 'second lookup is served from the cache');
  assert.equal(output.second.items[0].evidence?.retrieval, 'cache', JSON.stringify(output.second));
  const entries = (await readdir(cache)).sort();
  for (const name of ['coordination.sqlite', 'failures', 'responses']) assert.ok(entries.includes(name), `cache missing ${name}: ${entries}`);
  assert.equal((await readdir(join(cache, 'responses'))).length, 3);
  assert.deepEqual(await readdir(join(base)).then(list => list.sort()), ['tag-cache'], 'no data directory (bridge runtime or default tag cache) was created');
  assert.equal(existsSync(defaultCache), false, 'the default tag cache was not created');
});

test('N1: message fields inside host success payloads are scrubbed; library content fields are not', async t => {
  const hostText = "EACCES: permission denied, open '/Users/alice/Library/Application Support/novelai/covers/abc.png'; token=abc123";
  const { call } = await connect(t, (method, args) => method === 'material_library' && args.action === 'import'
    ? { count: 1, items: [{ id: ENTRY, name: 'n', notes: 'kept /Users/keep/this note', evidence: { errors: [{ stage: 'tag', code: 'x', message: 'fetch /Users/alice/secret/cache.db failed' }] } }],
      coverWarnings: [{ entryId: ENTRY, code: 'cover_storage_failed', message: hostText }], error: { code: 'material_storage_failed', message: hostText, messageDetail: `retry from ${hostText}` } }
    : { study: { id: 's-1', revision: 1 }, section: 'summary', warnings: [{ message: '文件「/Users/alice/x.png」无效' }] });
  const result = (await call('material_library', { action: 'import', data: { schemaVersion: 1, entries: [] } })).structuredContent;
  const text = JSON.stringify(result);
  for (const secret of ['/Users/alice', 'Application Support', 'abc123']) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
  assert.equal(result.coverWarnings[0].message, "EACCES: permission denied, open '<path>'; token=[redacted]");
  assert.equal(result.error.message, result.coverWarnings[0].message);
  assert.equal(result.items[0].evidence.errors[0].message, 'fetch <path> failed');
  assert.equal(result.items[0].notes, 'kept /Users/keep/this note', 'library content is data, not an error message');
  const study = (await call('material_studies', { action: 'read', id: 's-1' })).structuredContent;
  assert.equal(study.warnings[0].message, '文件「<path>」无效');
});

nodeTest('N2/F6: scrub redacts explicit key/value credentials (bare or JSON-quoted keys), Bearer, JWT and real-looking paths, and leaves prose alone', () => {
  return import('../src/business-guards.mjs').then(({ scrubText }) => {
    const redact = {
      'api_key=sk-12345 failed': 'api_key=[redacted] failed',
      'x-api-key: abc123': 'x-api-key: [redacted]',
      'secret : s3cr3t': 'secret : [redacted]',
      'token：supersecret': 'token：[redacted]',
      'token="p@ss word"': 'token=[redacted]',
      '密码：hunter2 错误': '密码：[redacted] 错误',
      '令牌＝abcd1234': '令牌＝[redacted]',
      '{"apiKey":"sk-abc","x":1}': '{"apiKey":"[redacted]","x":1}',
      '"password": "hunter2"': '"password": "[redacted]"',
      "{'token': 'abc123'}": "{'token': '[redacted]'}",
      'Authorization: Bearer abc.def-123': 'Authorization: [redacted]',
      'Authorization: Basic dXNlcjpwYXNz': 'Authorization: [redacted]',
      'sent Bearer abc.def-123 upstream': 'sent Bearer [redacted] upstream',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig': 'jwt [redacted]',
      'see https://danbooru.donmai.us/tags.json?api_key=zz&login=me and http://127.0.0.1:3000/rpc': 'see https://danbooru.donmai.us/tags.json?[redacted] and http://127.0.0.1:3000/rpc',
      '路径：/Users/alice/private/a.png 不存在': '路径：<path> 不存在',
      '文件「/Users/alice/private/a.png」无效': '文件「<path>」无效',
      'open:/Users/alice/x': 'open:<path>',
      "open '/Users/alice/Library/Application Support/x/a.png' now": "open '<path>' now",
      '文件「/Users/alice/private/a.png」无效；路径：/Users/alice/b token：zzz': '文件「<path>」无效；路径：<path> token：[redacted]',
      'a|/Users/Alice/x/y': 'a|<path>',
      '*/Users/Alice/x/y': '*<path>',
      '(/private/tmp/a/b)': '(<path>)',
      'open /Users/alice/Library/Application Support/novelai/x.png failed': 'open <path> failed',
      'see ~/Library/Application Support/x/y now': 'see <path> now',
      'open "/Users/alice/My Photos/night shot.png" now': 'open "<path>" now',
      '文件「/Users/a/My Photos/b c.png」无效': '文件「<path>」无效',
      'see ~/Library/x and C:\\Users\\x\\a.png and file:///Users/x/a.png': 'see <path> and <path> and <path>',
    };
    // Prose, prompt syntax, counts and single-segment slashes stay exactly as written. The last two are
    // documented non-goals (prose phrasing, not key/value), deliberately left untouched.
    const keep = ['token is missing', 'the password was changed successfully', 'tokens: 225 over the limit', 'prompt exceeds max tokens: 512', 'Token count 300 exceeds 225',
      'The session token is being refreshed', 'token was rejected by the server', 'Secret garden: a painting', 'Prompt exceeds the token limit', 'Use basic prompts only', 'Basic settings are fine',
      'Bearer token required', 'artist:/abc/ style', 'Danbooru endpoint /tags.json returned 500', 'progress 3/20 (/20 max)', 'ratio 16/9 and 1/2 cup, and/or w/o', 'HTTP/1.1 500',
      'see https://docs.novelai.net/en/image/undesiredcontent/ for details', 'see docs/business-mcp.md', '2026/09/27/night', '比例：16/9/4', 'yes/no/maybe',
      '1girl, {{masterpiece}}, 1.5::rain::, -0.8::feet::', 'Use PNG/JPEG/WebP in novelai/library-inbox; save/import only.', 'cannot open /etc',
      'tokens: exceeded for this prompt', 'max_token=512', 'Bearer authentication failed',
      'the token is abc123def', '密码是hunter2'];
    for (const [input, expected] of Object.entries(redact)) assert.equal(scrubText(input), expected, input);
    for (const input of keep) assert.equal(scrubText(input), input, input);
  });
});

nodeTest('F7/N-3: identity fields pass unscrubbed only as the submitted value or in their expected format; host-injected values are scrubbed', async () => {
  const { scrubDeep, IDENTITY_KEYS, trustedIdentities } = await import('../src/business-guards.mjs');
  const { mcpHostRequestKey } = await import('../src/recipe-queue.mjs');
  const requestKey = 'night token: v1 /Users/Alice/drafts/night', hostKey = mcpHostRequestKey(requestKey);
  const uuid = '12345678-1234-4234-8234-123456789abc', hash = 'a'.repeat(64);
  const trusted = trustedIdentities({ requestKey, historyId: 'h /Users/Alice/x/y', unrelated: 'x' });
  assert.deepEqual(trusted, { requestKey, historyId: 'h /Users/Alice/x/y' });
  // Our own details: the submitted requestKey and well-formed identities come back byte-for-byte.
  const own = { requestKey, hostRequestKey: hostKey, recipeId: uuid, recipeRevision: 3, inputHash: hash, historyId: 'h /Users/Alice/x/y', historyRevision: 2,
    existingBatch: { batchId: uuid, requestKey: hostKey, items: [{ jobId: uuid }] }, items: [{ recipeId: uuid, recipeRevision: 1, inputHash: hash }] };
  assert.deepEqual(scrubDeep(own, undefined, trusted), own);
  // Host-injected values under identity keys: nested objects, paths and credential-like strings are scrubbed.
  const injected = { assetId: '/Users/Alice/Library/Application Support/novelai/history/secret.png', historyId: 'api_key=sk-live-123', requestKey: { path: '/Users/Alice/.ssh/id_rsa', note: 'password: hunter2' },
    batchId: 'job at /Users/Alice/x/y', inputHash: 'token=abc123', recipeRevision: '3 /Users/Alice/x/y', jobId: { secret: 'cookie=abc' }, other: '/Users/Alice/Library/y/z' };
  assert.deepEqual(scrubDeep(injected, undefined, trusted), { assetId: '<path>', historyId: 'api_key=[redacted]', requestKey: { path: '<path>', note: 'password: [redacted]' },
    batchId: 'job at <path>', inputHash: 'token=[redacted]', recipeRevision: '3 <path>', jobId: { secret: 'cookie=[redacted]' }, other: '<path>' });
  // Without the call's own submission, even the F7 example is just text.
  assert.equal(scrubDeep({ requestKey }).requestKey, 'night token: [redacted] <path>');
  assert.ok(IDENTITY_KEYS.has('requestKey') && IDENTITY_KEYS.has('assetId'));
});

nodeTest('p3 C: a path continues across a space only into real path text; URLs, dates, ratios and short word pairs after it stay', async () => {
  const { scrubText } = await import('../src/business-guards.mjs');
  const roots = ['/Users/Alice/workspaces/comics/agent-p3'];
  const cases = {
    // Still one path: spaced directory names are wiped as a whole.
    'open /Users/Alice/Library/Application Support/novelai/a.png failed': 'open <path> failed',
    'see ~/Library/Application Support/x/y now': 'see <path> now',
    'open /Users/a/My Docs/a.png z': 'open <path> z',
    'copied /Users/a/b.png to /Users/a/c.png ok': 'copied <path> to <path> ok',
    // Known limit, kept as is: a relative path right after an absolute one is merged into it.
    'copied /Users/a/b docs/x.md next': 'copied <path> next',
    // Not a continuation.
    'at /Users/a/b https://docs.novelai.net/x/y': 'at <path> https://docs.novelai.net/x/y',
    'at /Users/a/b ftp://host/x done': 'at <path> ftp://host/x done',
    'at /Users/a/b 2026/09/27 retry': 'at <path> 2026/09/27 retry',
    'at /Users/a/b 2026/9/7': 'at <path> 2026/9/7',
    'read /Users/a/b 3/20 files done': 'read <path> 3/20 files done',
    'ratio /Users/a/b 16/9 wide': 'ratio <path> 16/9 wide',
    'failed to open /Users/a/b and/or retry later': 'failed to open <path> and/or retry later',
    'open /Users/a/b w/o cache': 'open <path> w/o cache',
    'open /Users/a/b yes/no, then': 'open <path> yes/no, then',
    '文件 /Users/a/b 和/或 重试': '文件 <path> 和/或 重试',
    'see ~/x/y and/or 3/4': 'see <path> and/or 3/4',
    // Whole-token rule: closing punctuation after, opening punctuation before, any case.
    'failed to open /Users/a/b and/or.': 'failed to open <path> and/or.',
    'open /Users/a/b and/or: retry': 'open <path> and/or: retry',
    'open /Users/a/b (and/or) retry': 'open <path> (and/or) retry',
    'open /Users/a/b And/Or, then': 'open <path> And/Or, then',
    'read /Users/a/b 3/20, done': 'read <path> 3/20, done',
    'at /Users/a/b (2026/09/27) retry': 'at <path> (2026/09/27) retry',
    'end /Users/a/b 2026/09/27': 'end <path> 2026/09/27',
    'read /Users/a/b input/output error': 'read <path> input/output error',
    'open /Users/a/b read/write denied': 'open <path> read/write denied',
    'flag /Users/a/b true/false': 'flag <path> true/false',
    'flag /Users/a/b on/off or/and': 'flag <path> on/off or/and',
    'read /Users/a/b I/O error, size N/A': 'read <path> I/O error, size N/A',
    'open /Users/a/b n/a.': 'open <path> n/a.',
    'open /Users/a/b I/O/x failed': 'open <path> failed',
    '文件 /Users/a/b 或/和 是/否 及/或 重试': '文件 <path> 或/和 是/否 及/或 重试',
    // Still path text: more path after a date, fraction or pair, a longer date-like run, or a non-whitelisted pair.
    'open /Users/x/Photos 2024/12/a.png failed': 'open <path> failed',
    'open /Users/x/Backup 2026/09/27/novelai/a.png failed': 'open <path> failed',
    'open /Users/x/Backup 3/20.png failed': 'open <path> failed',
    'open /Users/x/项目 资料/草稿 失败': 'open <path> 失败',
    'open /Users/x/Foo Bar/baz failed': 'open <path> failed',
    'open /Users/x/sites and/orx failed': 'open <path> failed',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(scrubText(input, roots), expected, input);
  // A pair outside the whitelist or a pair continuing into more path text is still a path tail.
  assert.equal(scrubText('open /Users/a/My Pictures/x failed', roots), 'open <path> failed');
  assert.equal(scrubText('open /Users/a/b and/or/x failed', roots), 'open <path> failed');
  // Adversarial inputs stay linear (CPU time of this process, so other busy processes do not count).
  const started = process.cpuUsage();
  for (const input of ['/a/b' + ' x/'.repeat(50000) + '!', '/a/b' + ' 1/2'.repeat(50000), '/a/b' + ' ab/cd'.repeat(40000), '/a/b' + ' https://x/'.repeat(20000)]) scrubText(input, roots);
  const used = process.cpuUsage(started);
  assert.ok((used.user + used.system) / 1000 < 2000);
});

nodeTest('p3 D: a submitted requestKey is trusted only under requestKey; the same value under another identity key is scrubbed', async () => {
  const { scrubDeep, trustedIdentities } = await import('../src/business-guards.mjs');
  const requestKey = 'api_key=sk-live-MODEL /Users/Alice/model-typed/a.png';
  const trusted = trustedIdentities({ requestKey });
  assert.deepEqual(scrubDeep({ requestKey }, undefined, trusted), { requestKey }, 'the same key echoes back verbatim');
  assert.deepEqual(scrubDeep({ recipeId: requestKey, batchId: requestKey, historyId: requestKey, assetId: requestKey }, undefined, trusted), {
    recipeId: 'api_key=[redacted] <path>', batchId: 'api_key=[redacted] <path>', historyId: 'api_key=[redacted] <path>', assetId: 'api_key=[redacted] <path>' });
  const history = trustedIdentities({ historyId: 'h /Users/Alice/x/y' });
  assert.equal(scrubDeep({ assetId: 'h /Users/Alice/x/y' }, undefined, history).assetId, 'h <path>');
});

test('N4: a study manifest listing more than 20 files is refused before any listed name is checked', async t => {
  const base = await tempBase(t, 'novelai-business-n4-');
  const dirs = { materialInbox: join(base, 'li'), studyInbox: join(base, 'si'), materialExports: join(base, 'le'), studyExports: join(base, 'se') };
  await mkdir(dirs.studyInbox); await mkdir(join(base, 'outside'));
  await writeFile(join(base, 'outside', 'x.png'), Buffer.concat([pngBytes, Buffer.from(OUTSIDE)]));
  await link(join(base, 'outside', 'x.png'), join(dirs.studyInbox, 'hard.png'));
  const { call, calls } = await connect(t, hostReply, dirs);
  // Every lstat of a name directly in the study inbox is counted (the server's named fs/promises imports see the mock).
  const lstatted = [], lstat = fsp.lstat;
  t.mock.method(fsp, 'lstat', (...args) => { if (dirname(String(args[0])) === dirs.studyInbox) lstatted.push(basename(String(args[0]))); return lstat(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  // 21 entries with the hard link first: the count rule answers, not the per-file rule.
  await writeFile(join(dirs.studyInbox, 'over.json'), JSON.stringify({ files: ['hard.png', ...Array.from({ length: 20 }, (_, i) => `n${i}.png`)] }));
  const over = (await call('material_studies', { action: 'import', file: 'over.json' })).structuredContent.error;
  assert.equal(over.code, 'invalid_input'); assert.match(over.message, /lists 21 files; import takes 1–20/);
  await writeFile(join(dirs.studyInbox, 'huge.json'), JSON.stringify({ files: Array.from({ length: 60000 }, (_, i) => `n${i}.png`) }));
  lstatted.length = 0;
  const huge = (await call('material_studies', { action: 'import', file: 'huge.json' })).structuredContent.error;
  assert.equal(huge.code, 'invalid_input'); assert.match(huge.message, /lists 60000 files/);
  assert.deepEqual(lstatted.filter(name => /^n\d+\.png$/.test(name)), [], 'no per-name lstat walk');
  // At the limit the per-file preflight still runs (and the counter sees it).
  await writeFile(join(dirs.studyInbox, 'twenty.json'), JSON.stringify({ files: ['hard.png', ...Array.from({ length: 19 }, (_, i) => `n${i}.png`)] }));
  lstatted.length = 0;
  const twenty = (await call('material_studies', { action: 'import', file: 'twenty.json' })).structuredContent.error;
  assert.equal(twenty.code, 'invalid_input'); assert.match(twenty.message, /hard links/);
  assert.ok(lstatted.includes('hard.png'), `the listed names were lstat-ed: ${JSON.stringify(lstatted)}`);
  assert.deepEqual(calls, []);
  assert.ok(!leaked(calls));
});
