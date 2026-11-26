// The launcher client/bin/nai (POSIX sh) in the layouts it ships in: an app bundle (macOS), an installation folder
// (Linux) and a client checkout, each started through chains of symbolic links from other folders. The app's
// executable is a stand-in script that runs the command-line file with this Node and reports what it was given, so
// the test checks which executable and which file the launcher picked, its arguments and exit code, and that
// ELECTRON_RUN_AS_NODE reaches that process only. With a built client (npm --prefix novelai/client run build) and its
// Electron, the real bundle also runs through a link and recognizes the app it belongs to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = join(root, 'client');
const LAUNCHER = join(client, 'bin', 'nai');
const posix = process.platform !== 'win32';
const temp = async (t) => { const dir = await realpath(await mkdtemp(join(tmpdir(), 'novelai-cli-launcher-'))); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

/** The stand-in command-line file: prints what it got and exits with the code it was asked for. */
const STUB = `import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ exe: process.env.NAI_TEST_EXE, script: fileURLToPath(import.meta.url), args, runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }) + '\\n');
process.exit(args[0] === 'exit' ? Number(args[1]) : 0);
`;
/** A stand-in for the app's executable: records its own path, then runs the file like Electron as Node would. */
const fakeExecutable = node => `#!/bin/sh\nNAI_TEST_EXE=$0 exec ${JSON.stringify(node)} "$@"\n`;

async function place(file, text, mode = 0o644) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, text); await chmod(file, mode); }
async function launcher(at) { await mkdir(dirname(at), { recursive: true }); await copyFile(LAUNCHER, at); await chmod(at, 0o755); }
const runVia = (file, args, env = {}) => {
  const result = spawnSync(file, args, { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env }, timeout: 30_000 });
  let json; try { json = JSON.parse(result.stdout); } catch { json = undefined; }
  return { ...result, json };
};

test('launcher in a macOS app bundle: links (relative, chained, through a linked folder) reach the bundle\'s executable and command-line file', { skip: !posix }, async t => {
  const base = await temp(t);
  const contents = join(base, 'Apps', 'Fake NovelAI.app', 'Contents');
  const exeName = process.platform === 'darwin' ? 'Fake Exe' : 'MCP for NovelAI';
  await place(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>${exeName}</string></dict></plist>\n`);
  await place(join(contents, 'MacOS', exeName), fakeExecutable(process.execPath), 0o755);
  await place(join(contents, 'Resources', 'mcp', 'novelai-cli.mjs'), STUB);
  await launcher(join(contents, 'Resources', 'bin', 'nai'));
  // ~/.local/bin/nai -> other/nai2 -> (relative) ../Apps/…/bin/nai, and a linked folder on the way.
  await mkdir(join(base, 'local', 'bin'), { recursive: true }); await mkdir(join(base, 'other'));
  await symlink(join('..', 'Apps', 'Fake NovelAI.app', 'Contents', 'Resources', 'bin', 'nai'), join(base, 'other', 'nai2'));
  await symlink(join(base, 'other', 'nai2'), join(base, 'local', 'bin', 'nai'));
  await symlink(join(base, 'local', 'bin'), join(base, 'linked-bin'));
  for (const entry of [join(base, 'local', 'bin', 'nai'), join(base, 'linked-bin', 'nai'), join(contents, 'Resources', 'bin', 'nai')]) {
    const result = runVia(entry, ['tags', 'two words', '--pretty']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.json, { exe: join(contents, 'MacOS', exeName), script: join(contents, 'Resources', 'mcp', 'novelai-cli.mjs'), args: ['tags', 'two words', '--pretty'], runAsNode: '1' });
  }
  // CDPATH does not redirect the launcher's cd; `sh nai` in the launcher's own folder works too.
  const cdpath = runVia(join(base, 'local', 'bin', 'nai'), ['x'], { CDPATH: '/usr:/' });
  assert.equal(cdpath.status, 0, cdpath.stdout + cdpath.stderr); assert.equal(cdpath.json.script, join(contents, 'Resources', 'mcp', 'novelai-cli.mjs'));
  const bySh = spawnSync('sh', ['nai', 'y'], { cwd: join(contents, 'Resources', 'bin'), encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(bySh.status, 0, bySh.stdout + bySh.stderr); assert.equal(JSON.parse(bySh.stdout).script, join(contents, 'Resources', 'mcp', 'novelai-cli.mjs'));
  // The exit code of nai is the launcher's.
  assert.equal(runVia(join(base, 'local', 'bin', 'nai'), ['exit', '3']).status, 3);
  // Started from PATH by name.
  const byName = spawnSync('nai', ['x'], { encoding: 'utf8', env: { PATH: `${join(base, 'local', 'bin')}:${process.env.PATH ?? ''}` } });
  assert.equal(JSON.parse(byName.stdout).script, join(contents, 'Resources', 'mcp', 'novelai-cli.mjs'));
  // The caller's environment keeps no ELECTRON_RUN_AS_NODE (it exists only in the started process).
  const shell = spawnSync('/bin/sh', ['-c', `"${join(base, 'local', 'bin', 'nai')}" x >/dev/null; printf %s "\${ELECTRON_RUN_AS_NODE-unset}"`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
  assert.equal(shell.stdout, 'unset');
});

test('launcher in a Linux installation folder and in a client checkout; a checkout that was not built says so', { skip: !posix }, async t => {
  const base = await temp(t);
  const install = join(base, 'opt', 'MCP-for-NovelAI');
  await place(join(install, 'mcp-for-novelai'), fakeExecutable(process.execPath), 0o755);
  await place(join(install, 'resources', 'mcp', 'novelai-cli.mjs'), STUB);
  await launcher(join(install, 'resources', 'bin', 'nai'));
  await mkdir(join(base, 'bin')); await symlink(join(install, 'resources', 'bin', 'nai'), join(base, 'bin', 'nai'));
  const linux = runVia(join(base, 'bin', 'nai'), ['env']);
  if (!join(install, 'resources').endsWith('/Contents/Resources')) assert.deepEqual(linux.json, { exe: join(install, 'mcp-for-novelai'), script: join(install, 'resources', 'mcp', 'novelai-cli.mjs'), args: ['env'], runAsNode: '1' });

  // A Windows installation (Git Bash / MSYS run the sh launcher): the executable is <productName>.exe.
  const productName = JSON.parse(readFileSync(join(client, 'package.json'), 'utf8')).build.productName;
  const windows = join(base, 'Programs', productName);
  await place(join(windows, `${productName}.exe`), fakeExecutable(process.execPath), 0o755);
  await place(join(windows, 'resources', 'mcp', 'novelai-cli.mjs'), STUB);
  await launcher(join(windows, 'resources', 'bin', 'nai'));
  await symlink(join(windows, 'resources', 'bin', 'nai'), join(base, 'bin', 'nai-win'));
  const win = runVia(join(base, 'bin', 'nai-win'), ['queue', 'list']);
  assert.deepEqual(win.json, { exe: join(windows, `${productName}.exe`), script: join(windows, 'resources', 'mcp', 'novelai-cli.mjs'), args: ['queue', 'list'], runAsNode: '1' });
  assert.ok(readFileSync(LAUNCHER, 'utf8').includes(`"$install/${productName}.exe"`), 'the launcher names the productName of package.json');

  const checkout = join(base, 'repo', 'novelai', 'client');
  await place(join(checkout, 'node_modules', 'electron', 'path.txt'), 'dist-electron-exe');
  await place(join(checkout, 'node_modules', 'electron', 'dist', 'dist-electron-exe'), fakeExecutable(process.execPath), 0o755);
  await place(join(checkout, 'dist-mcp', 'novelai-cli.mjs'), STUB);
  await launcher(join(checkout, 'bin', 'nai'));
  await symlink(join(checkout, 'bin', 'nai'), join(base, 'bin', 'nai-dev'));
  const source = runVia(join(base, 'bin', 'nai-dev'), ['queue', 'list']);
  assert.deepEqual(source.json, { exe: join(checkout, 'node_modules', 'electron', 'dist', 'dist-electron-exe'), script: join(checkout, 'dist-mcp', 'novelai-cli.mjs'), args: ['queue', 'list'], runAsNode: '1' });

  const unbuilt = join(base, 'fresh', 'client');
  await place(join(unbuilt, 'package.json'), '{}'); await mkdir(join(unbuilt, 'electron'));
  await launcher(join(unbuilt, 'bin', 'nai'));
  const missing = runVia(join(unbuilt, 'bin', 'nai'), ['env']);
  assert.equal(missing.status, 4); assert.equal(missing.json.error.code, 'nai_not_built');
  const stray = join(base, 'stray', 'bin', 'nai');
  await launcher(stray);
  const lost = runVia(stray, ['env']);
  assert.equal(lost.status, 4); assert.equal(lost.json.error.code, 'nai_not_found'); assert.doesNotMatch(lost.stdout, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the Windows launcher nai.cmd keeps CRLF line ends, its own scope (setlocal) and both layouts', () => {
  const text = readFileSync(join(client, 'bin', 'nai.cmd'), 'latin1');
  assert.ok(text.includes('\r\n') && !/[^\r]\n/.test(text), 'CRLF only (LF-only .cmd files mis-parse labels)');
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /\r\nsetlocal\r\n/);
  for (const needle of ['\\mcp\\novelai-cli.mjs', '\\dist-mcp\\novelai-cli.mjs', 'MCP for NovelAI.exe', 'node_modules\\electron\\path.txt', 'set "ELECTRON_RUN_AS_NODE=1"', '%*', 'exit /b %ERRORLEVEL%']) assert.ok(text.includes(needle), needle);
  // The executable bit of the POSIX launcher is part of the checkout.
  if (posix) assert.equal(statSync(LAUNCHER).mode & 0o777, 0o755, 'bin/nai is 755');
});

const built = existsSync(join(client, 'dist-mcp', 'novelai-cli.mjs')) && existsSync(join(client, 'node_modules', 'electron', 'path.txt'))
  && existsSync(join(client, 'node_modules', 'electron', 'dist', readFileSync(join(client, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()))
  && existsSync(join(client, 'dist-electron', 'electron', 'bootstrap.js'));
test('the real bundle through a link: Electron as Node, and it recognizes the built client it belongs to (no app is started)', { skip: !posix || !built ? 'needs a built client with its Electron' : false }, async t => {
  const base = await temp(t);
  await mkdir(join(base, 'bin')); await symlink(LAUNCHER, join(base, 'bin', 'nai'));
  const result = await new Promise((done, fail) => {
    const child = spawn(join(base, 'bin', 'nai'), ['--data-dir', join(base, 'data'), 'env'], { cwd: base, env: { PATH: process.env.PATH ?? '', HOME: base, NOVELAI_MCP_AUTOSTART: '0' } });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.on('error', fail); child.on('close', code => done({ code, stdout }));
  });
  assert.equal(result.code, 0, result.stdout);
  const env = JSON.parse(result.stdout);
  assert.deepEqual([env.runtime, env.app, env.autostart, env.dataRoot], ['electron-as-node', { startable: true, kind: 'source' }, 'off', join(base, 'data')]);
  assert.equal(existsSync(join(base, 'data')), false);
  await readFile(join(client, 'dist-mcp', 'novelai-cli.mjs'), 'utf8').then(text => assert.match(text, /^#!\/usr\/bin\/env node\n\/\/ nai, the command line of MCP for NovelAI/));
});
