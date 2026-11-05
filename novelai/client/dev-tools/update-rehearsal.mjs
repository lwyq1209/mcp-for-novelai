#!/usr/bin/env node
// Real update rehearsal of the in-app update: two packaged REHEARSAL builds of this checkout (NAI_UPDATE_TEST_BUILD=1,
// bundle id io.github.lwyq1209.mcp-for-novelai.test, product name "MCP for NovelAI Test", signed with a THROWAWAY
// certificate on macOS), a throwaway Ed25519 update key, a fake GitHub (lib/fake-release-server.mjs), the older build
// installed into a folder of the work directory (never /Applications), a test data root, and a real click on "Update
// and restart" through DevTools. Never the real update key, the release certificate, the daily app or its data.
//
//   node dev-tools/update-rehearsal.mjs prepare  --work <dir> [--from 0.1.3-test] [--to 0.1.4-test]
//   node dev-tools/update-rehearsal.mjs rehearse --work <dir> [--scenarios success,tamper,…] [--idle-gate|--no-idle-gate] [--keep] [--resume]
//                                                [--max-hours 6] [--front-alert <file of an independent front sampler>]
//   node dev-tools/update-rehearsal.mjs serve    --work <dir> [--port <n>]     (the fake GitHub of the work dir, in the foreground)
//   node dev-tools/update-rehearsal.mjs clean    --work <dir>                  (stops nothing; removes the installed test apps and unregisters them)
//
// prepare: keys (Ed25519 PEM + raw public key; macOS also a self-signed code signing certificate made with OpenSSL),
//   then the two builds (npm run build with NAI_UPDATE_TEST_BUILD=1, electron-builder for this platform only with the
//   rehearsal identity and the version; the rehearsal marker is removed from dist-electron afterwards, so a later
//   package of this checkout is a normal one). Output: <work>/builds/<version>/, <work>/keys/.
// rehearse: each scenario installs the older build afresh into <work>/install-<n>/ and a fresh data root
//   <work>/data-<n>/ (a seeded small library and a sentinel file), starts the fake GitHub with the scenario's fault,
//   starts the installed app (macOS: `open -n -g` with LSUIElement set in the rehearsal build; it never takes the
//   focus), clicks Settings › About › Check for updates, then Update and restart, and checks the outcome:
//     success           the new version runs from the same path, reports "updated from", the data is unchanged, the old
//                       version, the downloads and pending.json are gone
//     bad-signature     SHA256SUMS.txt.sig of another key: "verify_failed / signature_invalid", nothing staged
//     tamper            a release file changed after signing: "verify_failed / checksum_mismatch", nothing staged
//     downgrade         the latest release is older / the same / a newer tag replaying this release's manifest:
//                       no install button, no_update / version_mismatch
//     interrupt         the download is cut off every time: download_failed (retryable), the partial file stays; then
//                       the fault is lifted, Try again resumes it and the update completes
//     cancel            a slow download is cancelled: idle, the partial file stays, the app keeps running
//     not-writable      the install folder's parent is read-only: only Download is offered (install_unsupported)
//     kill-waiting      the helper is killed while it waits for the app to quit: nothing is replaced; the old app,
//                       opened again, says the update did not complete and cleans up
//     kill-launched     the helper is killed right after it started the new version: the new version confirms itself
//                       and removes the old one
//   --idle-gate (the default on macOS outside CI): a scenario starts only while the screen is locked or the user has
//   been idle for at least 120 s (IOHIDSystem HIDIdleTime); the user coming back (idle < 5 s while unlocked) stops it
//   at once (the apps it started are closed) and it runs again in the next idle window. The front-app watch
//   (lib/front-watch.mjs) runs during every scenario; a test app in front stops everything (exit 5).
//   Results: <work>/results.jsonl (one line per scenario run) and the JSON printed at the end.
// clean: removes <work>/install-*, the builds' unpacked apps, and unregisters every test app of the work dir from
//   LaunchServices (lsregister -u), so Spotlight and the Dock never pick a test app.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, printUsage, runCli, sleep, pollUntil } from './lib/cli.mjs';
import { clientDir, worktreeRoot } from './lib/paths.mjs';
import { checkDataRoot } from './lib/guard.mjs';
import { writeTestSettings } from './lib/settings.mjs';
import { startFakeRelease } from './lib/fake-release-server.mjs';
import { connectPage } from './lib/cdp.mjs';
import { startFrontWatch } from './lib/front-watch.mjs';
import { DATA_MARKER_SWITCH } from './lib/processes.mjs';

export const TEST_APP_ID = 'io.github.lwyq1209.mcp-for-novelai.test';
export const TEST_PRODUCT = 'MCP for NovelAI Test';
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const ALL_SCENARIOS = ['bad-signature', 'tamper', 'downgrade', 'not-writable', 'cancel', 'success', 'interrupt', 'kill-waiting', 'kill-launched'];
const platformKey = () => process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...options });

/** The update file of a rehearsal version on this platform (the release names, electron/update/release-files.ts). */
export function assetName(version, platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `MCP-for-NovelAI-${version}-mac-${arch}.zip`;
  if (platform === 'win32') return `MCP-for-NovelAI-${version}-win-x64-setup.exe`;
  return `MCP-for-NovelAI-${version}-linux-x64.tar.gz`;
}

/** A work folder: inside this checkout's .tmp/ or the OS temp folder, never anything else. */
function workDir(value) {
  if (!value || value === true) throw new ToolError('usage', '--work <dir> is required.');
  const dir = path.resolve(String(value));
  const tmp = path.join(worktreeRoot, '.tmp') + path.sep, osTmp = fs.realpathSync(os.tmpdir()) + path.sep;
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir) + path.sep;
  if (!real.startsWith(fs.realpathSync(path.join(worktreeRoot, '.tmp')) + path.sep) && !real.startsWith(osTmp) && !dir.startsWith(tmp)) throw new ToolError('refused', `The work folder must be inside ${tmp} or the OS temp folder.`);
  return dir;
}

// ── keys and builds ─────────────────────────────────────────────────────────────────────────────────────────────
function makeKeys(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'keys.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const signer = JSON.parse(run(process.execPath, [path.join(worktreeRoot, '.github', 'scripts', 'update-signature.mjs'), 'keygen', '--out', path.join(dir, 'update-key.pem')]).trim());
  const keys = { updatePrivateKey: path.join(dir, 'update-key.pem'), updatePublicKey: signer.publicKey };
  if (process.platform === 'darwin') {
    const openssl = ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl'].find(candidate => fs.existsSync(candidate));
    fs.writeFileSync(path.join(dir, 'cert.cnf'), '[req]\ndistinguished_name = dn\nx509_extensions = ext\nprompt = no\n[dn]\nCN = MCP for NovelAI Test (self-signed, temporary)\nO = rehearsal\n[ext]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\nsubjectKeyIdentifier = hash\n');
    run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'cert-key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '30', '-config', path.join(dir, 'cert.cnf')]);
    const password = createHash('sha256').update(fs.readFileSync(path.join(dir, 'cert-key.pem'))).digest('hex').slice(0, 24);
    // 3DES and SHA-1 MAC: the PKCS#12 form `security import` reads on every macOS.
    const legacy = /LibreSSL/.test(run(openssl, ['version'])) ? [] : ['-keypbe', 'PBE-SHA1-3DES', '-certpbe', 'PBE-SHA1-3DES', '-macalg', 'sha1'];
    run(openssl, ['pkcs12', '-export', '-inkey', path.join(dir, 'cert-key.pem'), '-in', path.join(dir, 'cert.pem'), '-out', path.join(dir, 'cert.p12'), '-passout', `pass:${password}`, ...legacy]);
    const der = Buffer.from(run(openssl, ['x509', '-in', path.join(dir, 'cert.pem'), '-outform', 'DER'], { encoding: 'buffer' }));
    Object.assign(keys, { certificateP12: path.join(dir, 'cert.p12'), certificatePassword: password, certificateSha256: createHash('sha256').update(der).digest('hex') });
  }
  fs.writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return keys;
}

function buildVersion(version, out, keys) {
  fs.mkdirSync(out, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = { ...process.env, NAI_UPDATE_TEST_BUILD: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
  const marker = path.join(clientDir, 'dist-electron', 'update-test-mode.json');
  try {
    const build = spawnSync(npm, ['run', 'build'], { cwd: clientDir, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) throw new ToolError('build_failed', 'npm run build failed.', { tail: `${build.stdout}${build.stderr}`.slice(-4000) });
    if (!fs.existsSync(marker)) throw new ToolError('build_failed', 'The rehearsal build has no update-test-mode.json.');
    const target = process.platform === 'darwin' ? ['--mac', 'zip'] : process.platform === 'win32' ? ['--win', 'nsis'] : ['--linux', 'tar.gz'];
    const args = [path.join(clientDir, 'node_modules', 'electron-builder', 'cli.js'), ...target, `--${process.arch}`, '--publish', 'never', `-c.extraMetadata.version=${version}`, `-c.appId=${TEST_APP_ID}`, `-c.productName=${TEST_PRODUCT}`, `-c.directories.output=${out}`, '-c.compression=normal',
      ...(process.platform === 'darwin' ? ['-c.mac.extendInfo.LSUIElement=1'] : [])];
    const signing = process.platform === 'darwin' ? { NAI_MAC_SIGNING: 'certificate', MAC_CSC_LINK: keys.certificateP12, MAC_CSC_KEY_PASSWORD: keys.certificatePassword } : {};
    // electron-builder's CLI run with this Node (no shell: the product name has spaces).
    const packaged = spawnSync(process.execPath, args, { cwd: clientDir, env: { ...env, ...signing }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(path.join(out, 'electron-builder.log'), `${packaged.stdout}${packaged.stderr}`);
    if (packaged.status !== 0) throw new ToolError('build_failed', `electron-builder failed for ${version}.`, { tail: `${packaged.stdout}${packaged.stderr}`.slice(-4000) });
  } finally {
    fs.rmSync(marker, { force: true });
  }
  const file = path.join(out, assetName(version));
  if (!fs.existsSync(file)) throw new ToolError('build_failed', `${assetName(version)} was not made.`);
  // The unpacked app electron-builder leaves next to the archive: removed (and unregistered) at once.
  for (const name of fs.readdirSync(out)) {
    const full = path.join(out, name);
    if (fs.statSync(full).isDirectory()) { unregisterApps(full); fs.rmSync(full, { recursive: true, force: true }); }
  }
  return { version, file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), bytes: fs.statSync(file).size };
}

/** Every .app bundle under a folder (macOS), unregistered from LaunchServices. */
export function unregisterApps(root) {
  if (process.platform !== 'darwin' || !fs.existsSync(root)) return [];
  const apps = [];
  const walk = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.endsWith('.app')) { apps.push(full); continue; }
      if (depth < 4) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  for (const app of apps) spawnSync(LSREGISTER, ['-u', app], { stdio: 'ignore' });
  return apps;
}

// ── install, start, stop ────────────────────────────────────────────────────────────────────────────────────────
function install(build, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'darwin') {
    run('/usr/bin/ditto', ['-x', '-k', build.file, dir]);
    const app = path.join(dir, `${TEST_PRODUCT}.app`);
    return { target: app, executable: path.join(app, 'Contents', 'MacOS', TEST_PRODUCT) };
  }
  if (process.platform === 'linux') {
    const scratch = fs.mkdtempSync(path.join(dir, 'x-'));
    run('tar', ['-xzf', build.file, '-C', scratch]);
    const [top] = fs.readdirSync(scratch);
    const target = path.join(dir, 'mcp-for-novelai');
    fs.renameSync(path.join(scratch, top), target);
    fs.rmSync(scratch, { recursive: true, force: true });
    return { target, executable: path.join(target, 'mcp-for-novelai') };
  }
  const target = path.join(dir, 'mcp-for-novelai');
  const setup = spawnSync(build.file, ['/S', `/D=${target}`], { stdio: 'ignore', windowsHide: true, timeout: 10 * 60_000 });
  if (setup.status !== 0) throw new ToolError('install_failed', `The test installer exited ${setup.status}.`);
  return { target, executable: path.join(target, `${TEST_PRODUCT}.exe`) };
}

function appEnvironment(dataRoot, feed, keys) {
  return { NOVELAI_DATA_DIR: dataRoot, NAI_UPDATE_TEST_FEED: feed, NAI_UPDATE_TEST_PUBLIC_KEY: keys.updatePublicKey, ...(keys.certificateSha256 ? { NAI_UPDATE_TEST_MAC_CERT_SHA256: keys.certificateSha256 } : {}), NAI_DEV_TOOLS_BACKGROUND: '1', NOVELAI_MCP_AUTOSTART: '0' };
}
const appArguments = (dataRoot, port) => ['--use-mock-keychain', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', `--remote-debugging-port=${port}`, `${DATA_MARKER_SWITCH}=${dataRoot}`];

/** Starts the installed app the way the helper restarts it (macOS through LaunchServices in the background). */
function startApp(installed, dataRoot, feed, keys, port) {
  const env = appEnvironment(dataRoot, feed, keys);
  if (process.platform === 'darwin') {
    const args = ['-n', '-g', '-a', installed.target, ...Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--args', ...appArguments(dataRoot, port)];
    const opened = spawnSync('/usr/bin/open', args, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER } });
    if (opened.status !== 0) throw new ToolError('start_failed', `open failed: ${opened.stderr}`);
    return;
  }
  const child = spawn(installed.executable, appArguments(dataRoot, port), { env: { ...process.env, ...env }, detached: true, stdio: 'ignore' });
  child.unref();
}

/** The pids of every process of this data root's test app (its marker argument, an executable inside `root`). */
export function appProcesses(dataRoot, root) {
  const marker = `${DATA_MARKER_SWITCH}=${dataRoot}`;
  if (process.platform === 'win32') {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout ?? '';
    return out.split(/\r?\n/).map(line => line.split('\t')).filter(([pid, exe, command]) => pid && exe && command && exe.toLowerCase().startsWith(root.toLowerCase()) && command.includes(marker) && !command.includes('--type=')).map(([pid]) => Number(pid));
  }
  const out = run('ps', ['-axww', '-o', 'pid=,command=']);
  return out.split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).filter(([, , command]) => command.startsWith(root) && command.includes(marker) && !command.includes('--type=')).map(([, pid]) => Number(pid));
}

async function stopApps(dataRoot, root, { timeoutMs = 30_000 } = {}) {
  const pids = appProcesses(dataRoot, root);
  for (const pid of pids) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid)], { stdio: 'ignore' });
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  await pollUntil(() => appProcesses(dataRoot, root).length === 0, { timeoutMs, intervalMs: 200 });
  return { stopped: pids, left: appProcesses(dataRoot, root) };
}

/** macOS: LaunchServices' type of the running test app (UIElement: never the active app, no Dock icon). */
function applicationType(dataRoot, root) {
  if (process.platform !== 'darwin') return null;
  const [pid] = appProcesses(dataRoot, root);
  if (!pid) return null;
  try {
    const asn = /ASN:[0-9a-fx-]+/i.exec(run('lsappinfo', ['find', `pid=${pid}`]))?.[0];
    return asn ? /"ApplicationType"="([^"]*)"/.exec(run('lsappinfo', ['info', '-only', 'applicationtype', asn]))?.[1] ?? null : null;
  } catch { return null; }
}

// ── the user's presence (macOS) ─────────────────────────────────────────────────────────────────────────────────
export function presence() {
  if (process.platform !== 'darwin') return { locked: false, idleSeconds: Infinity };
  let idle = 0, locked = false;
  try { idle = Number(/"HIDIdleTime" = (\d+)/.exec(run('ioreg', ['-c', 'IOHIDSystem']))?.[1] ?? 0) / 1e9; } catch { idle = 0; }
  try { locked = /"CGSSessionScreenIsLocked"=Yes/.test(run('ioreg', ['-n', 'Root', '-d1'])); } catch { locked = false; }
  return { locked, idleSeconds: idle };
}
const userAway = (needed = 120) => { const now = presence(); return now.locked || now.idleSeconds >= needed; };

// ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────
function prepareData(dataRoot) {
  fs.rmSync(dataRoot, { recursive: true, force: true });
  checkDataRoot(dataRoot, { create: true });
  const seeded = spawnSync(process.execPath, [path.join(clientDir, 'dev-tools', 'seed-library.mjs'), '--data', dataRoot, '--history', '4', '--tags', '3', '--combos', '1', '--notes', '1', '--style-presets', '1', '--positive-presets', '1', '--chunks', '1', '--reference-presets', '0', '--favorites', '1', '--collections', '1', '--imports', '1', '--quiet'], { encoding: 'utf8' });
  if (seeded.status !== 0) throw new ToolError('seed_failed', 'seed-library failed.', { tail: `${seeded.stdout}${seeded.stderr}`.slice(-2000) });
  writeTestSettings(dataRoot, { noToken: true, fakeNovelaiUrl: 'http://127.0.0.1:9', locale: 'zh-CN' });
  fs.writeFileSync(path.join(dataRoot, 'rehearsal-sentinel.txt'), `${dataRoot}\n`);
}

/** The library's user data (not its search index, metadata or file journal, which the app maintains itself). */
const USER_TABLES = ['items', 'versions', 'assets', 'asset_links', 'collections', 'memberships', 'covers', 'relations', 'history_tags'];
/** Row counts of the library's user tables, the sentinel's hash, and the user settings that must survive. */
export function dataFingerprint(dataRoot) {
  const db = new DatabaseSync(path.join(dataRoot, 'library.sqlite'), { readOnly: true });
  try {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    const tables = USER_TABLES.filter(name => present.has(name));
    const counts = Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n]));
    const settings = JSON.parse(fs.readFileSync(path.join(dataRoot, 'settings.json'), 'utf8')).settings ?? {};
    return { counts, sentinel: createHash('sha256').update(fs.readFileSync(path.join(dataRoot, 'rehearsal-sentinel.txt'))).digest('hex'), language: settings.language, hasOnboarded: settings.hasOnboarded };
  } finally { db.close(); }
}

// ── the window ──────────────────────────────────────────────────────────────────────────────────────────────────
async function openPage(port, timeoutMs = 90_000) {
  const page = await connectPage({ port, timeoutMs });
  await page.waitForLoad({ timeoutMs });
  return page;
}
const progressOf = page => page.evaluate(() => window.naiDesktop.getUpdateProgress());
/** Settings › About › Check for updates; resolves the row's state once the check has answered. */
async function checkInAbout(page) {
  await page.route('settings');
  await page.click('[data-testid="settings-nav-about"]');
  await page.click('[data-testid="update-check"]');
  await pollUntil(() => page.evaluate(() => Boolean(document.querySelector('[data-testid="update-result"], [data-testid="update-install"], [data-testid="update-download"]'))), { timeoutMs: 30_000, intervalMs: 200 });
  return page.evaluate(() => ({ install: Boolean(document.querySelector('[data-testid="update-install"]')), download: Boolean(document.querySelector('[data-testid="update-download"]')), result: document.querySelector('[data-testid="update-result"]')?.textContent ?? null, note: document.querySelector('[data-testid="update-progress"]')?.textContent ?? null }));
}
async function clickInstall(page) { await page.click('[data-testid="update-install"]', { timeoutMs: 20_000 }); }
async function waitPhase(page, phases, timeoutMs = 180_000) {
  const wanted = new Set(phases);
  const value = await pollUntil(async () => { const progress = await progressOf(page).catch(() => null); return progress && wanted.has(progress.phase) ? progress : null; }, { timeoutMs, intervalMs: 250 });
  if (!value) throw new ToolError('timeout', `The update did not reach ${phases.join('/')}.`, { last: await progressOf(page).catch(() => null) });
  return value;
}
const stagingLeft = parent => fs.existsSync(parent) ? fs.readdirSync(parent).filter(name => name.startsWith('.mcp-for-novelai-update-')) : [];
function pendingState(dataRoot) {
  const updates = path.join(dataRoot, 'updates');
  let pending = null; try { pending = JSON.parse(fs.readFileSync(path.join(updates, 'pending.json'), 'utf8')); } catch { /* none */ }
  const states = {};
  if (fs.existsSync(updates)) for (const name of fs.readdirSync(updates)) { const file = path.join(updates, name, 'helper-state'); if (fs.existsSync(file)) states[name] = fs.readFileSync(file, 'utf8').trim().split('\n'); }
  return { pending, states, downloads: fs.existsSync(path.join(updates, 'downloads')) ? fs.readdirSync(path.join(updates, 'downloads')) : [] };
}
function helperPids(dataRoot) {
  if (process.platform === 'win32') return [];
  const updates = path.join(dataRoot, 'updates');
  return run('ps', ['-axww', '-o', 'pid=,command=']).split('\n').map(line => /^\s*(\d+)\s+(.*)$/.exec(line)).filter(Boolean).filter(([, , command]) => command.includes(`${updates}${path.sep}`) && command.includes('helper.sh')).map(([, pid]) => Number(pid));
}
function installedVersion(installed) {
  if (process.platform === 'darwin') return run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(installed.target, 'Contents', 'Info.plist')]).trim();
  if (process.platform === 'win32') {
    const read = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::Out.Write([System.Diagnostics.FileVersionInfo]::GetVersionInfo('${installed.executable.replace(/'/g, "''")}').ProductVersion)`], { encoding: 'utf8' });
    return String(read.stdout ?? '').replace(/^\uFEFF/, '').trim() || `(unreadable: ${String(read.stderr ?? '').trim().slice(0, 200)})`;
  }
  const asar = path.join(installed.target, 'resources', 'app.asar');
  const bytes = fs.readFileSync(asar); const size = bytes.readUInt32LE(12); const header = JSON.parse(bytes.subarray(16, 16 + size).toString('utf8'));
  const entry = header.files['package.json']; return JSON.parse(bytes.subarray(8 + bytes.readUInt32LE(4) + Number(entry.offset), 8 + bytes.readUInt32LE(4) + Number(entry.offset) + entry.size).toString('utf8')).version;
}

// ── scenarios ───────────────────────────────────────────────────────────────────────────────────────────────────
const FAULTS = { 'bad-signature': { badSignature: true }, tamper: { tamper: true }, interrupt: { dropAfterBytes: 2 * 1024 * 1024, dropTimes: 'always' }, cancel: { slowBytesPerSecond: 512 * 1024 } };

async function scenario(name, context, index) {
  const { work, keys, from, to, guard } = context;
  const installDir = path.join(work, `install-${index}`), dataRoot = path.join(work, `data-${index}`);
  const port = 19_300 + index;
  const result = { scenario: name, startedAt: new Date().toISOString(), ok: false, checks: {} };
  const check = (key, value, ok) => { result.checks[key] = { ok: Boolean(ok), value }; };
  prepareData(dataRoot);
  const installed = install(from, installDir);
  const parent = path.dirname(installed.target);
  const release = path.join(work, 'release'); fs.rmSync(release, { recursive: true, force: true }); fs.mkdirSync(release);
  fs.copyFileSync(to.file, path.join(release, path.basename(to.file)));
  const server = await startFakeRelease({ dir: release, tag: `v${to.version}`, privateKeyPem: fs.readFileSync(keys.updatePrivateKey, 'utf8'), faults: FAULTS[name] ?? {} });
  let page = null;
  try {
    if (name === 'not-writable' && process.platform !== 'win32') fs.chmodSync(parent, 0o555);
    guard.check();
    startApp(installed, dataRoot, server.url, keys, port);
    page = await openPage(port);
    guard.check();
    result.applicationType = applicationType(dataRoot, parent);
    const before = await pollUntil(async () => { try { return dataFingerprint(dataRoot); } catch { return null; } }, { timeoutMs: 20_000 });
    if (name === 'downgrade') {
      for (const [label, tag, expected] of [['older', `v${from.version.replace(/^(\d+)\.(\d+)\.(\d+)/, (_, a, b, c) => `${a}.${b}.${Math.max(0, Number(c) - 1)}`)}`, 'current'], ['same', `v${from.version}`, 'current'], ['replay', 'v9.9.9-test', 'replay']]) {
        server.setFaults({ latestTag: tag });
        const row = await checkInAbout(page);
        if (expected === 'current') { check(`${label}: no install button`, row, !row.install); const started = await page.evaluate(() => window.naiDesktop.startUpdate()); check(`${label}: start says no update`, started.error, started.error?.code === 'no_update'); }
        else { await clickInstall(page); const failed = await waitPhase(page, ['failed']); check(`${label}: refused`, failed.error, failed.error?.code === 'verify_failed' && failed.error?.reason === 'version_mismatch'); }
        guard.check();
      }
      check('nothing staged', stagingLeft(parent), stagingLeft(parent).length === 0);
      check('nothing downloaded', pendingState(dataRoot).downloads, !pendingState(dataRoot).downloads.some(file => file.endsWith('.zip') || file.endsWith('.exe') || file.endsWith('.gz')));
    } else if (name === 'not-writable') {
      const row = await checkInAbout(page);
      const progress = await progressOf(page);
      check('only Download is offered', row, !row.install && row.download);
      check('install unsupported', progress.install, progress.install?.supported === false && progress.install?.reason === 'not_writable');
    } else if (name === 'bad-signature' || name === 'tamper') {
      await checkInAbout(page);
      await clickInstall(page);
      const failed = await waitPhase(page, ['failed']);
      check('stopped: could not verify', failed.error, failed.error?.code === 'verify_failed' && failed.error?.reason === (name === 'tamper' ? 'checksum_mismatch' : 'signature_invalid'));
      check('nothing staged', stagingLeft(parent), stagingLeft(parent).length === 0);
      check('no pending update', pendingState(dataRoot).pending, !pendingState(dataRoot).pending);
      check('the app still runs', appProcesses(dataRoot, parent).length, appProcesses(dataRoot, parent).length > 0);
      check('the installed version is unchanged', installedVersion(installed), installedVersion(installed) === from.version);
    } else if (name === 'cancel') {
      await checkInAbout(page);
      await clickInstall(page);
      const downloading = await pollUntil(async () => { const progress = await progressOf(page); return progress.phase === 'downloading' && progress.received > 0 ? progress : null; }, { timeoutMs: 60_000, intervalMs: 200 });
      check('download progress shown', downloading, downloading && downloading.received > 0);
      await page.click('[data-testid="update-cancel"]');
      const idle = await waitPhase(page, ['idle'], 20_000);
      check('cancelled', idle.phase, idle.phase === 'idle');
      check('the partial file stays', pendingState(dataRoot).downloads, pendingState(dataRoot).downloads.some(file => file.endsWith('.part')));
      check('the app still runs', appProcesses(dataRoot, parent).length, appProcesses(dataRoot, parent).length > 0);
    } else {
      // success, interrupt, kill-waiting, kill-launched: the update is handed to the helper.
      await checkInAbout(page);
      await clickInstall(page);
      if (name === 'interrupt') {
        const failed = await waitPhase(page, ['failed']);
        check('broken download: retryable failure', failed.error, failed.error?.code === 'download_failed' && failed.error?.retryable);
        check('the partial file stays', pendingState(dataRoot).downloads, pendingState(dataRoot).downloads.some(file => file.endsWith('.part')));
        server.setFaults({});
        await clickInstall(page); // Try again
      }
      if (name === 'kill-waiting') {
        // Once it said it waits (the app quits only then), before the app has exited.
        const killed = await pollUntil(() => { const states = Object.values(pendingState(dataRoot).states)[0] ?? []; if (!states.includes('waiting')) return null; const pids = helperPids(dataRoot); if (!pids.length) return null; for (const pid of pids) process.kill(pid, 'SIGKILL'); return { pids, states }; }, { timeoutMs: 120_000, intervalMs: 20 });
        check('helper killed while waiting', killed, Boolean(killed));
      }
      if (name === 'kill-launched') {
        const killed = await pollUntil(() => { const states = Object.values(pendingState(dataRoot).states)[0] ?? []; if (!states.includes('launched')) return null; const pids = helperPids(dataRoot); for (const pid of pids) process.kill(pid, 'SIGKILL'); return { pids, states }; }, { timeoutMs: 180_000, intervalMs: 20 });
        check('helper killed after the new version started', killed, Boolean(killed));
      }
      page.close(); page = null;
      // The old app quits; for kill-waiting nothing else happens; otherwise the new version comes up on the same port.
      await pollUntil(() => { const pending = pendingState(dataRoot); return Object.values(pending.states)[0]?.length ? pending : null; }, { timeoutMs: 300_000, intervalMs: 250 });
      if (name === 'kill-waiting') {
        await pollUntil(() => appProcesses(dataRoot, parent).length === 0, { timeoutMs: 60_000, intervalMs: 250 });
        await sleep(3000);
        check('nothing replaced', installedVersion(installed), installedVersion(installed) === from.version);
        check('no app started by the helper', appProcesses(dataRoot, parent), appProcesses(dataRoot, parent).length === 0);
        // The user opens the app again.
        guard.check();
        startApp(installed, dataRoot, server.url, keys, port);
        page = await openPage(port);
        const notice = await pollUntil(() => page.evaluate(() => window.naiDesktop.getUpdateNotice()), { timeoutMs: 20_000 });
        check('the old app reports the incomplete update', notice, notice?.kind === 'failed');
        await sleep(2500);
        check('the attempt is cleaned up', { staging: stagingLeft(parent), pending: pendingState(dataRoot).pending }, stagingLeft(parent).length === 0 && !pendingState(dataRoot).pending);
      } else {
        const state = await pollUntil(() => { const states = Object.values(pendingState(dataRoot).states)[0] ?? []; return states.includes('done') || states.includes('slow') || states.some(value => /^(rolled_back|aborted|failed|rollback_failed)/.test(value)) || (name === 'kill-launched' && states.includes('launched')) ? states : null; }, { timeoutMs: 300_000, intervalMs: 250 });
        result.helperStates = state;
        guard.check();
        page = await openPage(port, 120_000);
        const notice = await pollUntil(() => page.evaluate(() => window.naiDesktop.getUpdateNotice()), { timeoutMs: 30_000 });
        check('the new version runs and says it was updated', notice, notice?.kind === 'updated' && notice.from === from.version && notice.to === to.version);
        check('installed in the same place with the new version', { target: installed.target, version: installedVersion(installed) }, installedVersion(installed) === to.version);
        const cleaned = await pollUntil(() => stagingLeft(parent).length === 0 && !pendingState(dataRoot).pending && !pendingState(dataRoot).downloads.length ? true : null, { timeoutMs: 30_000, intervalMs: 500 });
        check('old version, downloads and pending.json removed', { staging: stagingLeft(parent), pending: pendingState(dataRoot).pending, downloads: pendingState(dataRoot).downloads }, Boolean(cleaned));
        const helperLog = Object.keys(pendingState(dataRoot).states).map(id => { try { return fs.readFileSync(path.join(dataRoot, 'updates', id, 'helper.log'), 'utf8'); } catch { return ''; } }).join('\n');
        result.helperLog = helperLog.split('\n').slice(-20);
      }
    }
    page?.close(); page = null;
    await stopApps(dataRoot, parent);
    const after = dataFingerprint(dataRoot);
    check('data unchanged (library rows, sentinel, settings)', { before, after }, JSON.stringify(before) === JSON.stringify(after));
    result.resumedRequests = server.requests().filter(entry => entry.range).length;
    result.requests = server.requests().map(entry => `${entry.status} ${entry.path}${entry.range ? ` (${entry.range})` : ''}${entry.dropped ? ` dropped@${entry.dropped}` : ''}`).slice(-30);
    result.ok = Object.values(result.checks).every(item => item.ok);
  } catch (error) {
    result.error = { code: error.code ?? 'failed', message: error.message, details: error.details };
    if (error.code === 'user_back' || error.code === 'front_detected') result.interrupted = error.code;
  } finally {
    page?.close();
    try { if (process.platform !== 'win32') fs.chmodSync(parent, 0o755); } catch { /* unchanged */ }
    await stopApps(dataRoot, parent).catch(() => undefined);
    await server.close();
    result.finishedAt = new Date().toISOString();
    // The test apps of this scenario: removed and unregistered at once.
    unregisterApps(installDir);
    if (!context.keep) fs.rmSync(installDir, { recursive: true, force: true });
  }
  return result;
}

/** Watches the user (idle gate) and the front app while a scenario runs; check() throws when either says stop. */
async function scenarioGuard({ idleGate, work, frontAlert }) {
  const watch = await startFrontWatch({});
  let stopReason = null;
  const timer = setInterval(() => {
    if (!idleGate) return;
    const now = presence();
    if (!now.locked && now.idleSeconds < 5) stopReason = stopReason ?? 'user_back';
  }, 500);
  return {
    check() {
      // An independent sampler's alert file (--front-alert), if one runs: any line stops everything.
      if (frontAlert && fs.existsSync(frontAlert) && fs.readFileSync(frontAlert, 'utf8').trim()) throw new ToolError('front_detected', `The front-app sampler saw a test app in front (${frontAlert}).`);
      const hits = watch.hits();
      if (hits.length) { fs.appendFileSync(path.join(work, 'front-alert.jsonl'), `${JSON.stringify(hits)}\n`); throw new ToolError('front_detected', `A test app came to the front (${JSON.stringify(hits[0])}).`); }
      if (stopReason) throw new ToolError('user_back', 'The user came back; the scenario stops.');
    },
    async stop() { clearInterval(timer); return watch.stop(); },
  };
}

async function rehearse(options) {
  const work = workDir(options.work);
  const state = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  const keys = JSON.parse(fs.readFileSync(path.join(work, 'keys', 'keys.json'), 'utf8'));
  const idleGate = options['no-idle-gate'] ? false : options['idle-gate'] ? true : process.platform === 'darwin' && !process.env.CI;
  const wanted = options.scenarios ? String(options.scenarios).split(',') : ALL_SCENARIOS;
  for (const name of wanted) if (!ALL_SCENARIOS.includes(name)) throw new ToolError('usage', `Unknown scenario ${name}.`);
  const results = [];
  const resultsFile = path.join(work, 'results.jsonl');
  const doneBefore = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.ok).map(entry => entry.scenario) : []);
  let index = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const deadline = Date.now() + Number(options['max-hours'] ?? 6) * 3600_000;
  for (const name of wanted) {
    if (options.resume && doneBefore.has(name)) continue;
    for (let attempt = 0; ; attempt++) {
      if (idleGate) {
        if (!userAway()) process.stderr.write(`[rehearsal] ${name}: waiting until the screen is locked or the user is idle for 120 s\n`);
        while (!userAway()) { if (Date.now() > deadline) throw new ToolError('no_idle_window', 'No idle window in time; the remaining scenarios did not run.', { results }); await sleep(5000); }
      }
      const guard = await scenarioGuard({ idleGate, work, frontAlert: options['front-alert'] ? path.resolve(String(options['front-alert'])) : null });
      const result = await scenario(name, { work, keys, from: state.from, to: state.to, guard, keep: options.keep === true }, index++);
      const front = await guard.stop();
      result.frontWatch = { hits: front.hits.length, samples: front.samples, maxGapMs: front.maxGapMs };
      result.idleGate = idleGate;
      fs.appendFileSync(resultsFile, `${JSON.stringify(result)}\n`);
      results.push(result);
      process.stderr.write(`[rehearsal] ${name}: ${result.ok ? 'ok' : result.interrupted ?? 'FAILED'}\n`);
      if (result.interrupted === 'front_detected' || front.hits.length) throw new ToolError('front_detected', 'A test app came to the front; every further start is stopped.', { results });
      if (result.interrupted === 'user_back' && attempt < 20) continue;
      break;
    }
  }
  return { ok: results.every(result => result.ok), results: results.map(result => ({ scenario: result.scenario, ok: result.ok, interrupted: result.interrupted, error: result.error?.message, failed: Object.entries(result.checks).filter(([, value]) => !value.ok).map(([key, value]) => ({ check: key, value: value.value })), frontHits: result.frontWatch?.hits })) };
}

async function prepare(options) {
  const work = workDir(options.work);
  const from = String(options.from ?? '0.1.3-test'), to = String(options.to ?? '0.1.4-test');
  const keys = makeKeys(path.join(work, 'keys'));
  const builds = {};
  for (const version of [from, to]) builds[version] = buildVersion(version, path.join(work, 'builds', version), keys);
  const prepared = { from: builds[from], to: builds[to], keys: { updatePublicKey: keys.updatePublicKey, certificateSha256: keys.certificateSha256 ?? null } };
  fs.writeFileSync(path.join(work, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`);
  return { ok: true, ...prepared };
}

async function serve(options) {
  const work = workDir(options.work);
  const state = JSON.parse(fs.readFileSync(path.join(work, 'prepared.json'), 'utf8'));
  const keys = JSON.parse(fs.readFileSync(path.join(work, 'keys', 'keys.json'), 'utf8'));
  const release = path.join(work, 'release'); fs.rmSync(release, { recursive: true, force: true }); fs.mkdirSync(release);
  fs.copyFileSync(state.to.file, path.join(release, path.basename(state.to.file)));
  const server = await startFakeRelease({ dir: release, tag: `v${state.to.version}`, privateKeyPem: fs.readFileSync(keys.updatePrivateKey, 'utf8'), port: Number(options.port ?? 0) });
  process.stdout.write(`${JSON.stringify({ ok: true, url: server.url, tag: server.tag })}\n`);
  await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  await server.close();
}

function clean(options) {
  const work = workDir(options.work);
  const unregistered = unregisterApps(work);
  for (const name of fs.readdirSync(work)) if (/^install-\d+$/.test(name)) fs.rmSync(path.join(work, name), { recursive: true, force: true });
  return { ok: true, unregistered };
}

export async function main(argv) {
  if (helpRequested(argv)) { printUsage(import.meta.url); return undefined; }
  const { positional, options } = parseArgs(argv, { booleans: ['idle-gate', 'no-idle-gate', 'keep', 'resume'] });
  const [command] = positional;
  if (command === 'prepare') { allowOptions(options, ['work', 'from', 'to']); return prepare(options); }
  if (command === 'rehearse') { allowOptions(options, ['work', 'scenarios', 'idle-gate', 'no-idle-gate', 'keep', 'resume', 'max-hours', 'front-alert']); return rehearse(options); }
  if (command === 'serve') { allowOptions(options, ['work', 'port']); await serve(options); return undefined; }
  if (command === 'clean') { allowOptions(options, ['work']); return clean(options); }
  throw new ToolError('usage', 'usage: update-rehearsal.mjs prepare|rehearse|serve|clean --work <dir> (see --help)');
}

if (isMain(import.meta.url)) await runCli(main);
