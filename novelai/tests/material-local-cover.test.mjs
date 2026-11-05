import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { materialToolAction, materialToolResponse } from '../src/material-tools.mjs';
import { validateContract } from '../contracts/validate.mjs';

const LIMIT = 20 * 1024 * 1024;
const base = { action:'set_local_cover', entryId:'12345678-1234-1234-1234-123456789abc', revision:7, expectedCoverRevision:0, file:'用户指定.png' };
async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nai-local-cover-')));
  t.after(() => fs.rm(directory, { recursive:true, force:true }));
  const inbox = join(directory, 'inbox'); await fs.mkdir(inbox);
  const calls = [], stored = { entryId:base.entryId, entryRevision:7, coverRevision:1, coverStatus:'ready', cover:{source:'local',rating:null} };
  const bridge = { async call(method, args, signal) { calls.push({method,args,signal}); return stored; } };
  return { directory, inbox, calls, stored, bridge };
}
function patchOpen(t, wrap) {
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args) => wrap(await original(...args), args));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('all invalid parameters and identities fail before filesystem reads and make zero bridge calls', async t => {
  const f = await fixture(t); let touched = 0;
  t.mock.method(fs, 'lstat', async () => { touched++; throw Error('must not read'); }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const invalid = [
    {data:'raw'}, {fileName:'a.png'}, {rating:'q'}, {postId:1}, {id:base.entryId}, {path:'/secret'}, {url:'https://example.invalid/x.png'},
    {entryId:''}, {entryId:' '}, {entryId:'../secret'}, {entryId:3}, {entryId:undefined}, {revision:0}, {revision:1.5}, {revision:'7'}, {revision:undefined},
    {revision:Infinity}, {revision:Number.MAX_SAFE_INTEGER+1}, {expectedCoverRevision:-1}, {expectedCoverRevision:0.5}, {expectedCoverRevision:undefined},
    {expectedCoverRevision:Number.MAX_SAFE_INTEGER+1},
    ...[undefined, null, '', ' ', '../a.png', '/tmp/a.png', 'sub/a.png', 'sub\\a.png', 'C:\\a.png', 'C:a.png', '\\\\host\\a.png', 'https://example.invalid/a.png', '.hidden.png', 'a.png\n', 'a\u0000.png', 'a\u007f.png', 'a\u0085.png', 'a\u200b.png', ' a.png', 'a.png ', 'a\t.png', 'a.json', 'a.svg', 'a.png.exe', 'a'.repeat(252)+'.png'].map(file=>({file})),
  ];
  for (const patch of invalid) await assert.rejects(materialToolAction({...base,...patch},f));
  assert.equal(touched,0); assert.equal(f.calls.length,0);
});

test('supported filename types forward bytes without model-provided MIME/rating, and exact 20 MiB succeeds', async t => {
  const f = await fixture(t);
  for (const file of ['照片.png','照片.JPG','照片.jpeg','照片.webp','照片.GIF','我的 封面.png','Screenshot 2026-09-24.png']) {
    await fs.writeFile(join(f.inbox,file),Buffer.from('host decodes this'));
    await materialToolAction({...base,file},f);
    assert.equal(f.calls.at(-1).args.fileName,file);
    assert.deepEqual(Object.keys(f.calls.at(-1).args).sort(),['action','data','entryId','expectedCoverRevision','fileName','revision']);
  }
  await fs.writeFile(join(f.inbox,base.file),Buffer.alloc(LIMIT,42));
  await materialToolAction(base,f);
  assert.equal(Buffer.from(f.calls.at(-1).args.data,'base64').length,LIMIT);
});

test('missing/empty/oversize/directory/symlink input and symlink inbox fail without leaking paths or invoking bridge', async t => {
  const f = await fixture(t);
  await fs.writeFile(join(f.inbox,'empty.png'),'');
  await fs.writeFile(join(f.inbox,'oversize.png'),Buffer.alloc(LIMIT+1));
  await fs.mkdir(join(f.inbox,'directory.png'));
  await fs.writeFile(join(f.directory,'outside.png'),'outside');
  await fs.symlink(join(f.directory,'outside.png'),join(f.inbox,'linked.png'));
  await fs.symlink(join(f.inbox,'missing.png'),join(f.inbox,'broken.png'));
  await fs.symlink(f.inbox,join(f.directory,'linked-inbox'));
  for (const file of ['missing.png','empty.png','oversize.png','directory.png','linked.png','broken.png']) {
    await assert.rejects(materialToolAction({...base,file},f),error=>!error.message.includes(f.directory) && !error.message.includes(file));
  }
  // A nonempty image avoids a false positive caused by the empty-file guard.
  await fs.writeFile(join(f.inbox,'valid.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNYffb96rPvGSAUAEJCCZ0WY1CJAAAAAElFTkSuQmCC','base64'));
  for (const suffix of ['', '/', '///']) await assert.rejects(materialToolAction({...base,file:'valid.png'},{...f,inbox:join(f.directory,'linked-inbox')+suffix}));
  assert.equal(f.calls.length,0);
  await materialToolAction({...base,file:'valid.png'},{...f,inbox:f.inbox+'/'});
  assert.equal(f.calls.length,1, 'normal directory with the production trailing slash still works');
});

test('FIFO is opened NONBLOCK and rejected promptly in a timeout-bounded child process', async t => {
  if (process.platform==='win32') return t.skip('POSIX FIFO fixture');
  const f = await fixture(t), file='pipe.png';
  execFileSync('mkfifo',[join(f.inbox,file)]);
  const script = `import { materialToolAction } from ${JSON.stringify(new URL('../src/material-tools.mjs',import.meta.url).href)};
  let calls=0; try { await materialToolAction(${JSON.stringify({...base,file})},{inbox:${JSON.stringify(f.inbox)},bridge:{call(){calls++;}}});process.exitCode=2; }
  catch(e){console.log(JSON.stringify({calls,message:e.message}));if(calls)process.exitCode=3;}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{timeout:5000,encoding:'utf8'});
  assert.equal(result.error,undefined); assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).calls,0);
});

test('growth after fstat is bounded to 20 MiB + one sentinel and closes the file', async t => {
  const f=await fixture(t); await fs.writeFile(join(f.inbox,base.file),'x');
  let readBytes=0, closed=false, flags;
  patchOpen(t,async(handle,args)=>{
    flags=args[1]; const stat=handle.stat.bind(handle), read=handle.read.bind(handle), close=handle.close.bind(handle);
    // Grow only after the reader's own fstat; win32 openNoFollow's identity check uses stat({bigint:true}) first.
    t.mock.method(handle,'stat',async(...options)=>{const before=await stat(...options);if(!options[0]?.bigint)await fs.appendFile(join(f.inbox,base.file),Buffer.alloc(LIMIT+4096));return before;});
    t.mock.method(handle,'read',async(...params)=>{const result=await read(...params);readBytes+=result.bytesRead;return result;});
    t.mock.method(handle,'close',async()=>{closed=true;return close();});return handle;
  });
  await assert.rejects(materialToolAction(base,f));
  // win32 has neither flag: openNoFollow lstat-refuses links/non-regular files, then opens O_RDONLY and checks dev/ino.
  if (process.platform === 'win32') assert.equal(flags, constants.O_RDONLY);
  else { assert.ok(flags & constants.O_NOFOLLOW); assert.ok(flags & constants.O_NONBLOCK); }
  assert.equal(readBytes,LIMIT+1); assert.equal(closed,true); assert.equal(f.calls.length,0);
});

test('abort before IO and during bounded reading closes input and never bridges or echoes abort reason', async t => {
  const f=await fixture(t), controller=new AbortController();
  controller.abort(new Error(`/private/path secret bytes`));
  await assert.rejects(materialToolAction(base,{...f,signal:controller.signal}),e=>e.name==='AbortError'&&!e.message.includes('/private'));
  await fs.writeFile(join(f.inbox,base.file),Buffer.alloc(200000));
  const during=new AbortController(); let reads=0,closed=false;
  patchOpen(t,async handle=>{
    const read=handle.read.bind(handle),close=handle.close.bind(handle);
    t.mock.method(handle,'read',async(...args)=>{const result=await read(...args);reads++;during.abort();return result;});
    t.mock.method(handle,'close',async()=>{closed=true;return close();});return handle;
  });
  await assert.rejects(materialToolAction(base,{...f,signal:during.signal}),{name:'AbortError'});
  assert.equal(reads,1);assert.equal(closed,true);assert.equal(f.calls.length,0);
});

test('read errors are sanitized, close the handle, and never dispatch', async t => {
  const f=await fixture(t);await fs.writeFile(join(f.inbox,base.file),'x');
  let closed=false;
  patchOpen(t,async handle=>{
    const close=handle.close.bind(handle);
    t.mock.method(handle,'read',async()=>{throw new Error(`EIO ${f.directory} PRIVATE_BYTES`);});
    t.mock.method(handle,'close',async()=>{closed=true;return close();});return handle;
  });
  await assert.rejects(materialToolAction(base,f),e=>!e.message.includes(f.directory)&&!e.message.includes('PRIVATE_BYTES'));
  assert.equal(closed,true);assert.equal(f.calls.length,0);
});

test('abort after opening input closes it without reading or bridging', async t => {
  const f=await fixture(t),controller=new AbortController();await fs.writeFile(join(f.inbox,base.file),'x');
  let closed=false,reads=0;
  patchOpen(t,async handle=>{
    const close=handle.close.bind(handle);
    t.mock.method(handle,'read',async()=>{reads++;throw Error('must not read');});
    t.mock.method(handle,'close',async()=>{closed=true;return close();});controller.abort();return handle;
  });
  await assert.rejects(materialToolAction(base,{...f,signal:controller.signal}),{name:'AbortError'});
  assert.equal(reads,0);assert.equal(closed,true);assert.equal(f.calls.length,0);
});

test('abort at close is checked before bridge; unknown receipt after dispatch never retries', async t => {
  const f=await fixture(t),controller=new AbortController();await fs.writeFile(join(f.inbox,base.file),'x');
  patchOpen(t,async handle=>{const close=handle.close.bind(handle);t.mock.method(handle,'close',async()=>{await close();controller.abort();});return handle;});
  await assert.rejects(materialToolAction(base,{...f,signal:controller.signal}),{name:'AbortError'});
  assert.equal(f.calls.length,0);
  let attempts=0;f.bridge.call=async()=>{attempts++;throw new Error('unknown save receipt');};
  await assert.rejects(materialToolAction(base,f),/unknown save receipt/);assert.equal(attempts,1);
});

test('Danbooru g/s/q/e remain unchanged across samples, image and set_cover; legacy file rules stay separate', async t => {
  const f=await fixture(t);
  for(const rating of ['g','s','q','e']) for(const action of ['samples','sample_image','set_cover']) {
    const params={action,entryId:base.entryId,rating,...(action==='samples'?{}:{postId:123}),...(action==='set_cover'?{revision:7,expectedCoverRevision:0}:{})};
    await materialToolAction(params,f);
    assert.deepEqual(f.calls.at(-1).args,{...params,action:{samples:'list',sample_image:'image',set_cover:'set_cover'}[action]});
  }
  const before=f.calls.length;
  for(const action of ['read','set_cover','cover','clear_cover','samples','sample_image','list']) await assert.rejects(materialToolAction({...base,action},f));
  for(const action of ['save','import']) await assert.rejects(materialToolAction({action,file:base.file},f));
  assert.equal(f.calls.length,before);
});
