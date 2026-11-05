// Step 3a: how the MCP server finds the client (<data root>/runtime/bridge.json; data root = NOVELAI_DATA_DIR or
// <appData>/mcp-for-novelai, the same module the client uses) and where its inbox/export folders are
// (NOVELAI_PROJECT_ROOT, else <data root>/workspace). Each case runs in a child process with its own environment
// and throwaway folders; a local HTTP server stands in for the client's bridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = name => pathToFileURL(join(root, 'src', name)).href;
const temp = async (t, prefix) => { const dir = await mkdtemp(join(tmpdir(), prefix)); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
/** Runs an ES module snippet with exactly this environment (nothing inherited but PATH) and parses its last stdout line. */
async function child(code, env) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', code], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '', ...env } });
  return JSON.parse(stdout.trim().split('\n').at(-1));
}
/** A stand-in for the client bridge: POST /rpc with the bearer token, answering list_queue. */
async function fakeBridge(t, dataDir) {
  const token = 'a'.repeat(64), seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, authorized: request.headers.authorization === `Bearer ${token}`, body: JSON.parse(body || '{}') });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, result: { batches: [] } }));
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const runtime = join(dataDir, 'runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'bridge.json'), JSON.stringify({ schemaVersion: 1, url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid }));
  return seen;
}

test('the bridge client reads <NOVELAI_DATA_DIR>/runtime/bridge.json by default', async t => {
  const data = await temp(t, 'nai-data-root-');
  const code = `const { createBridgeClient } = await import(${JSON.stringify(moduleUrl('bridge-client.mjs'))});
    try { console.log(JSON.stringify({ ok: true, result: await createBridgeClient().call('list_queue', {}) })); }
    catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }`;
  assert.deepEqual(await child(code, { NOVELAI_DATA_DIR: data }), { ok: false, code: 'unavailable' }, 'no client: unavailable, nothing else is looked at');
  const seen = await fakeBridge(t, data);
  assert.deepEqual(await child(code, { NOVELAI_DATA_DIR: data }), { ok: true, result: { batches: [] } });
  assert.deepEqual(seen, [{ method: 'POST', url: '/rpc', authorized: true, body: { method: 'list_queue', args: {} } }]);
  // A leftover NOVELAI_BRIDGE_RUNTIME_DIR from the old layout is ignored.
  const other = await temp(t, 'nai-old-runtime-');
  assert.deepEqual(await child(code, { NOVELAI_DATA_DIR: data, NOVELAI_BRIDGE_RUNTIME_DIR: other }), { ok: true, result: { batches: [] } });
  assert.equal(seen.length, 2);
});

test('without NOVELAI_DATA_DIR the data root is mcp-for-novelai in the platform app-data folder', async () => {
  const home = '/nonexistent-home-for-test';
  const code = `const m = await import(${JSON.stringify(moduleUrl('data-paths.mjs'))});
    console.log(JSON.stringify(['darwin', 'linux', 'win32'].map(platform => m.resolveDataPaths({ platform, env: platform === 'win32' ? { APPDATA: 'C:\\\\Users\\\\u\\\\AppData\\\\Roaming' } : {}, homedir: platform === 'win32' ? 'C:\\\\Users\\\\u' : ${JSON.stringify(home)} }).bridgeFile)));`;
  assert.deepEqual(await child(code, {}), [
    `${home}/Library/Application Support/mcp-for-novelai/runtime/bridge.json`,
    `${home}/.config/mcp-for-novelai/runtime/bridge.json`,
    'C:\\Users\\u\\AppData\\Roaming\\mcp-for-novelai\\runtime\\bridge.json',
  ]);
});

test('the stdio server started from source finds the client through the same data root', async t => {
  const data = await temp(t, 'nai-data-root-stdio-');
  const seen = await fakeBridge(t, data);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'src', 'mcp.mjs')], cwd: tmpdir(), stderr: 'pipe', env: { PATH: process.env.PATH ?? '', NOVELAI_DATA_DIR: data } });
  const client = new Client({ name: 'data-root', version: '1' });
  await client.connect(transport);
  t.after(() => client.close());
  const listed = await client.callTool({ name: 'list_queue', arguments: {} });
  assert.equal(listed.isError, undefined, JSON.stringify(listed.structuredContent));
  assert.equal(listed.structuredContent.total, 0);
  assert.deepEqual(seen.map(entry => entry.body.method), ['list_queue']);
});

const INBOX_CODE = `const guards = await import(${JSON.stringify(moduleUrl('business-guards.mjs'))});
  const material = await import(${JSON.stringify(moduleUrl('material-tools.mjs'))});
  const study = await import(${JSON.stringify(moduleUrl('study-tools.mjs'))});
  const { createNovelAiMcpServer } = await import(${JSON.stringify(moduleUrl('mcp.mjs'))});
  const { Client } = await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/client/index.js'))});
  const { InMemoryTransport } = await import(${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/inMemory.js'))});
  const server = createNovelAiMcpServer({ bridgeClient: { async call(method, args) { return { schemaVersion: 1, entries: [] }; } } });
  const client = new Client({ name: 'inbox', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  const exported = (await client.callTool({ name: 'material_library', arguments: { action: 'export' } })).structuredContent;
  console.log(JSON.stringify({ projectRoot: guards.PROJECT_ROOT, source: guards.PROJECT_ROOT_SOURCE, materialInbox: material.MATERIAL_INBOX, materialExports: material.MATERIAL_EXPORTS, studyInbox: study.STUDY_INBOX, studyExports: study.STUDY_EXPORTS, exported }));
  process.exit(0);`;

test('inbox and export folders: NOVELAI_PROJECT_ROOT/novelai/... when set, else <data root>/workspace/novelai/...; results name the root', async t => {
  const data = await temp(t, 'nai-inbox-data-'), project = await temp(t, 'nai-inbox-project-');
  const sep = process.platform === 'win32' ? '\\' : '/';
  const withProject = await child(INBOX_CODE, { NOVELAI_DATA_DIR: data, NOVELAI_PROJECT_ROOT: project });
  assert.equal(withProject.projectRoot, project); assert.equal(withProject.source, 'NOVELAI_PROJECT_ROOT');
  assert.deepEqual([withProject.materialInbox, withProject.materialExports, withProject.studyInbox, withProject.studyExports],
    ['library-inbox', 'library-exports', 'study-inbox', 'study-exports'].map(name => join(project, 'novelai', name) + sep));
  assert.match(withProject.exported.file, /^novelai\/library-exports\/[a-f0-9-]{36}\.json$/);
  assert.equal(withProject.exported.pathBase, 'project-root'); assert.equal(withProject.exported.projectRoot, 'NOVELAI_PROJECT_ROOT');
  assert.ok(!JSON.stringify(withProject.exported).includes(project), 'the absolute project root is not echoed');
  assert.equal((await readdir(join(project, 'novelai', 'library-exports'))).length, 1);
  assert.deepEqual(await readdir(data), [], 'the data root is untouched when the project root is set');

  const fallback = await child(INBOX_CODE, { NOVELAI_DATA_DIR: data });
  const workspace = join(data, 'workspace');
  assert.equal(fallback.projectRoot, workspace); assert.equal(fallback.source, 'data-dir-workspace');
  assert.deepEqual([fallback.materialInbox, fallback.studyInbox], [join(workspace, 'novelai', 'library-inbox') + sep, join(workspace, 'novelai', 'study-inbox') + sep]);
  assert.match(fallback.exported.file, /^novelai\/library-exports\/[a-f0-9-]{36}\.json$/);
  assert.equal(fallback.exported.projectRoot, 'data-dir-workspace');
  assert.equal((await readdir(join(workspace, 'novelai', 'library-exports'))).length, 1);
  // A blank NOVELAI_PROJECT_ROOT counts as unset.
  assert.equal((await child(INBOX_CODE, { NOVELAI_DATA_DIR: data, NOVELAI_PROJECT_ROOT: '  ' })).source, 'data-dir-workspace');
});
