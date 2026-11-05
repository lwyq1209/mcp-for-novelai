#!/usr/bin/env node
// Checks one electron-builder output of novelai/client (release workflow, after `electron-builder --publish never`;
// also usable locally). Nothing here starts the app's window or reads or writes an app data folder: the packaged
// executable only runs as Node (ELECTRON_RUN_AS_NODE=1) with a throwaway NOVELAI_DATA_DIR.
//
//   node .github/scripts/packaged-app-check.mjs [--release <dir>] [--arch x64|arm64] [--app <unpacked app>] [--json <file>] [--stage <dir>] [--summary <file>]
//                                              [--mac-certificate <sha256>] [--app-id <id>] [--product-name <name>] [--update-test-build]
//
// --release  electron-builder output folder (default novelai/client/release)
// --arch     architecture of this build (default: the running Node's)
// --app      check this unpacked app (a .app bundle on macOS) instead of the one taken from the artifact:
//            macOS: the zip, extracted with ditto; Linux: the tar.gz, extracted with tar;
//            Windows: win-unpacked (the folder the NSIS installer installs)
// --stage    when every check passes, copy the expected artifacts (and only those) into this folder
// --summary  append a short Markdown summary to this file (the workflow passes $GITHUB_STEP_SUMMARY)
// --mac-certificate  the SHA-256 of the certificate the macOS app must be signed with (default: the release certificate,
//            MAC_RELEASE_CERTIFICATE_SHA256; the CI rehearsal passes its throwaway certificate's; `adhoc` for a local
//            ad-hoc build)
// --app-id, --product-name  the bundle identifier and product name to expect (default: package.json build.appId and
//            productName; update rehearsal builds use their own)
// --update-test-build  expect the update rehearsal marker in app.asar (default: it must be absent)
//
// Checks:
//  1. artifacts: exactly the expected installer files for this platform and architecture, named with the
//     version, the OS and the architecture (artifactsFor below; the release workflow uploads this list);
//  2. resources: app.asar, mcp/novelai-mcp.mjs, LICENSE, THIRD_PARTY_NOTICES.md, Chromium's LICENSES.chromium.html
//     and no app-update.yml (the build has no publish target);
//  3. sharp's native addon and libvips are unpacked from app.asar (app.asar.unpacked/node_modules/@img/…), and
//     sharp, required from inside app.asar by the packaged Electron, encodes and decodes a PNG;
//     The libvips versions.json in the package lists the same library versions as the vendored license manifest the
//     notices are generated from (scripts/licenses/sharp-libvips/manifest.json; on Windows with its differences);
//  4. the packaged MCP bundle answers over stdio with the same tools as the source server (novelai/src/mcp.mjs,
//     started with the Node running this script), reports the client as unavailable, and writes nothing to its
//     data folder;
//  5. macOS: the app is signed with the release certificate: codesign --verify --deep --strict passes, the SHA-256 of
//     its leaf certificate is MAC_RELEASE_CERTIFICATE_SHA256 and its designated requirement is identifier "<app id>"
//     and certificate leaf = H"<SHA-1 of that certificate>" (stable across versions, so the Keychain keeps "Always
//     Allow"), in the zip and in the dmg (attached read-only with -nobrowse to a scratch mount point, then detached),
//     and both are the same signature (CDHash);
//  6. app.asar has no update rehearsal marker (dist-electron/update-test-mode.json): a release build ignores every
//     NAI_UPDATE_TEST_* variable (novelai/client/electron/update/source.ts).
// Exit status 0 only when every check passes; the JSON report goes to stdout (and --json <file>).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const client = path.join(repo, 'novelai', 'client');
let PRODUCT = 'MCP for NovelAI';
const PREFIX = 'MCP-for-NovelAI';
/** SHA-256 of the self-signed certificate (CN "MCP for NovelAI (self-signed)", O lwyq1209) that signs the macOS releases;
 * the app has the same value built in (electron/update/source.ts OFFICIAL_MAC_CERT_SHA256). */
export const MAC_RELEASE_CERTIFICATE_SHA256 = '4001b2f773a1f258cac351597a518c9924d294e167d298297c64cd409ee67524';
export const UPDATE_TEST_MARKER = 'dist-electron/update-test-mode.json';

function parseArgs(argv) {
  const config = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8')).build;
  const options = { release: path.join(client, 'release'), arch: process.arch, app: null, json: null, stage: null, summary: null, 'mac-certificate': MAC_RELEASE_CERTIFICATE_SHA256, 'app-id': config.appId, 'product-name': config.productName, 'update-test-build': false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === '--update-test-build') { options['update-test-build'] = true; continue; }
    if (!['--release', '--arch', '--app', '--json', '--stage', '--summary', '--mac-certificate', '--app-id', '--product-name'].includes(flag) || value === undefined) throw new Error(`usage: packaged-app-check.mjs [--release <dir>] [--arch x64|arm64] [--app <unpacked app>] [--json <file>] [--stage <dir>] [--summary <file>] [--mac-certificate <sha256>|adhoc] [--app-id <id>] [--product-name <name>] [--update-test-build] (got ${flag})`);
    options[flag.slice(2)] = ['--arch', '--mac-certificate', '--app-id', '--product-name'].includes(flag) ? value : path.resolve(value);
    index += 1;
  }
  if (options['mac-certificate'] !== 'adhoc') options['mac-certificate'] = options['mac-certificate'].replace(/:/g, '').toLowerCase();
  if (options['mac-certificate'] !== 'adhoc' && !/^[0-9a-f]{64}$/.test(options['mac-certificate'])) throw new Error('--mac-certificate must be a SHA-256 (64 hex digits) or adhoc');
  if (!['x64', 'arm64'].includes(options.arch)) throw new Error(`unsupported arch ${options.arch}`);
  return options;
}

/** The installer files electron-builder makes for this platform (package.json build.artifactName and friends). */
export function artifactsFor(platform, arch, version) {
  if (platform === 'darwin') return [`${PREFIX}-${version}-mac-${arch}.dmg`, `${PREFIX}-${version}-mac-${arch}.zip`];
  if (platform === 'win32') return [`${PREFIX}-${version}-win-${arch}-setup.exe`];
  if (platform === 'linux') return [`${PREFIX}-${version}-linux-${arch}.tar.gz`];
  throw new Error(`unsupported platform ${platform}`);
}

/** Executable and resources folder of an unpacked app. */
function layout(platform, app) {
  if (platform === 'darwin') return { executable: path.join(app, 'Contents', 'MacOS', PRODUCT), resources: path.join(app, 'Contents', 'Resources'), chromiumNotices: path.join(app, 'Contents', 'Resources', 'LICENSES.chromium.html') };
  const executable = platform === 'win32' ? path.join(app, `${PRODUCT}.exe`) : path.join(app, JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8')).name);
  return { executable, resources: path.join(app, 'resources'), chromiumNotices: path.join(app, 'LICENSES.chromium.html') };
}

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });

/** The unpacked app to check: extracted from the artifact users download where that is practical. */
function appFromArtifact(platform, arch, release, artifacts, scratch) {
  if (platform === 'darwin') {
    const target = path.join(scratch, 'zip');
    const unzip = run('ditto', ['-x', '-k', path.join(release, artifacts[1]), target]);
    if (unzip.status !== 0) throw new Error(`ditto failed: ${unzip.stderr}`);
    return { app: path.join(target, `${PRODUCT}.app`), from: artifacts[1] };
  }
  if (platform === 'linux') {
    // electron-builder puts the app in one top-level folder named like the archive.
    const target = path.join(scratch, 'tar');
    mkdirSync(target);
    const untar = run('tar', ['-xzf', path.join(release, artifacts[0]), '-C', target]);
    if (untar.status !== 0) throw new Error(`tar -xzf failed: ${untar.stderr}`);
    return { app: path.join(target, artifacts[0].replace(/\.tar\.gz$/, '')), from: artifacts[0] };
  }
  return { app: path.join(release, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`), from: 'win-unpacked' };
}

/** Node-mode environment of the packaged executable: no inherited NOVELAI_/NAI_ switches, a throwaway data root, and
 * no automatic start of the app (the MCP server would otherwise start the packaged app for the unavailable call). */
function nodeModeEnv(data, project) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(NOVELAI_|NAI_|ELECTRON_)/i.test(key)));
  return { ...env, ELECTRON_RUN_AS_NODE: '1', NOVELAI_DATA_DIR: data, NOVELAI_PROJECT_ROOT: project, NOVELAI_MCP_AUTOSTART: '0' };
}

const SHARP_PROBE = `
const sharp = require(process.env.PACKAGED_CHECK_SHARP);
sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer()
  .then(png => sharp(png).metadata())
  .then(meta => console.log(JSON.stringify({ format: meta.format, width: meta.width, height: meta.height, vips: sharp.versions.vips, electron: process.versions.electron,
    addons: Object.keys(require.cache).filter(file => file.endsWith('.node')) })))
  .catch(error => { console.error(error && error.stack || String(error)); process.exit(1); });`;

async function listTools(command, args, env) {
  const requireSdk = createRequire(path.join(repo, 'novelai', 'package.json'));
  const { Client } = await import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(requireSdk.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const transport = new StdioClientTransport({ command, args, env, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const mcp = new Client({ name: 'packaged-app-check', version: '1' });
  const started = Date.now();
  await mcp.connect(transport);
  try {
    const handshakeMs = Date.now() - started;
    const { tools } = await mcp.listTools();
    const workspaces = await mcp.callTool({ name: 'list_workspaces', arguments: {} });
    const invalid = await mcp.callTool({ name: 'enqueue_recipes', arguments: { requestKey: 'k', items: [] } });
    return { handshakeMs, server: mcp.getServerVersion(), tools: tools.map(tool => tool.name), listWorkspaces: workspaces.structuredContent?.error?.code ?? null, invalidEnqueue: invalid.structuredContent?.error?.code ?? null, stderr: stderr.trim() };
  } finally {
    await mcp.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  PRODUCT = options['product-name'];
  const platform = process.platform;
  const version = JSON.parse(readFileSync(path.join(client, 'package.json'), 'utf8')).version;
  const report = { platform, arch: options.arch, version, checks: {} };
  const fail = (check, message) => { report.checks[check] = { ...(report.checks[check] ?? {}), ok: false, problem: message }; };
  const scratch = mkdtempSync(path.join(tmpdir(), 'nai-packaged-check-'));
  try {
    // 1. artifacts
    const expected = artifactsFor(platform, options.arch, version);
    // electron-builder leaves the NSIS uninstaller it embeds (__uninstaller-nsis-*.exe) next to the installers.
    const present = readdirSync(options.release).filter(name => /\.(dmg|zip|exe|AppImage|tar\.gz)$/.test(name) && !name.startsWith('__uninstaller')).sort();
    report.checks.artifacts = { ok: JSON.stringify(present) === JSON.stringify([...expected].sort()), expected, present, sizes: Object.fromEntries(present.map(name => [name, statSync(path.join(options.release, name)).size])) };

    const source = options.app ? { app: options.app, from: '--app' } : appFromArtifact(platform, options.arch, options.release, expected, scratch);
    const { executable, resources, chromiumNotices } = layout(platform, source.app);
    report.app = source;

    // 2. resources
    const required = { 'app.asar': path.join(resources, 'app.asar'), 'mcp/novelai-mcp.mjs': path.join(resources, 'mcp', 'novelai-mcp.mjs'), LICENSE: path.join(resources, 'LICENSE'), 'THIRD_PARTY_NOTICES.md': path.join(resources, 'THIRD_PARTY_NOTICES.md'), 'LICENSES.chromium.html': chromiumNotices, executable };
    const missing = Object.entries(required).filter(([, file]) => !existsSync(file)).map(([name]) => name);
    const updateFile = existsSync(path.join(resources, 'app-update.yml'));
    // The executable keeps its execute permission through the archive (Windows has no such bit).
    const runnable = platform === 'win32' || (existsSync(executable) && (statSync(executable).mode & 0o111) !== 0);
    report.checks.resources = { ok: missing.length === 0 && !updateFile && runnable, missing, appUpdateYml: updateFile, executableRunnable: runnable, asarBytes: existsSync(required['app.asar']) ? statSync(required['app.asar']).size : null };

    // 3. sharp
    const img = path.join(resources, 'app.asar.unpacked', 'node_modules', '@img');
    const unpacked = existsSync(img) ? readdirSync(img).sort() : [];
    const sharpPlatform = `${platform}-${options.arch}`;
    const addon = existsSync(path.join(img, `sharp-${sharpPlatform}`, 'lib')) && readdirSync(path.join(img, `sharp-${sharpPlatform}`, 'lib')).some(name => name.endsWith('.node'));
    const libvipsDir = platform === 'win32' ? path.join(img, `sharp-${sharpPlatform}`, 'lib') : path.join(img, `sharp-libvips-${sharpPlatform}`, 'lib');
    const libvips = existsSync(libvipsDir) && readdirSync(libvipsDir).some(name => /^libvips-cpp/.test(name));
    const data = path.join(scratch, 'data'), project = path.join(scratch, 'project');
    for (const dir of [data, project]) mkdirSync(dir);
    // A script file rather than -e: no command-line quoting of the probe on Windows.
    const probeFile = path.join(scratch, 'sharp-probe.cjs');
    writeFileSync(probeFile, SHARP_PROBE);
    const probe = run(executable, [probeFile], { env: { ...nodeModeEnv(data, project), PACKAGED_CHECK_SHARP: path.join(resources, 'app.asar', 'node_modules', 'sharp') }, timeout: 60_000 });
    let loaded = null;
    try { loaded = JSON.parse(probe.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    const versionsFile = platform === 'win32' ? path.join(img, `sharp-${sharpPlatform}`, 'versions.json') : path.join(img, `sharp-libvips-${sharpPlatform}`, 'versions.json');
    const manifest = JSON.parse(readFileSync(path.join(client, 'scripts', 'licenses', 'sharp-libvips', 'manifest.json'), 'utf8'));
    const noticed = { ...manifest.versions, ...(platform === 'win32' ? manifest.windows.differences : {}) };
    const shipped = existsSync(versionsFile) ? JSON.parse(readFileSync(versionsFile, 'utf8')) : null;
    const versionDifferences = shipped ? [...new Set([...Object.keys(noticed), ...Object.keys(shipped)])].sort().filter(key => noticed[key] !== shipped[key]).map(key => `${key}: notices ${noticed[key] ?? '-'}, package ${shipped[key] ?? '-'}`) : ['versions.json missing'];
    report.checks.sharp = { ok: addon && libvips && probe.status === 0 && loaded?.format === 'png' && loaded.width === 8 && versionDifferences.length === 0, unpacked, addon, libvips,
      libvipsVersions: shipped, versionDifferences, probe: loaded ?? { status: probe.status, signal: probe.signal, stderr: (probe.stderr ?? '').slice(-2000) } };

    // 4. MCP bundle (packaged executable as Node) against the source server
    try {
      const packaged = await listTools(executable, [required['mcp/novelai-mcp.mjs']], nodeModeEnv(data, project));
      const reference = await listTools(process.execPath, [path.join(repo, 'novelai', 'src', 'mcp.mjs')], nodeModeEnv(data, project));
      const dataAfter = readdirSync(data);
      report.checks.mcp = { ok: packaged.tools.length > 0 && JSON.stringify(packaged.tools) === JSON.stringify(reference.tools) && packaged.listWorkspaces === 'unavailable' && packaged.invalidEnqueue === 'invalid_arguments' && dataAfter.length === 0,
        toolCount: packaged.tools.length, sameToolsAsSource: JSON.stringify(packaged.tools) === JSON.stringify(reference.tools), tools: packaged.tools, server: packaged.server, handshakeMs: packaged.handshakeMs, listWorkspaces: packaged.listWorkspaces, invalidEnqueue: packaged.invalidEnqueue, dataDirAfter: dataAfter, stderr: packaged.stderr };
    } catch (error) {
      fail('mcp', error instanceof Error ? error.stack : String(error));
    }

    // 5. macOS signature: the release certificate, its designated requirement, the same in the zip and the dmg
    if (platform === 'darwin') {
      report.checks.signature = signatureCheck(source.app, options, path.join(scratch, 'cert-zip'));
      if (!options.app) report.checks.dmg = dmgCheck(path.join(options.release, artifactsFor(platform, options.arch, version)[0]), path.join(scratch, 'dmg'), options, report.checks.signature.cdhash, path.join(scratch, 'cert-dmg'));
    }

    // 6. update rehearsal marker
    const asarFiles = asarFileList(required['app.asar']);
    const marker = asarFiles.includes(UPDATE_TEST_MARKER);
    report.checks.updateSource = { ok: marker === options['update-test-build'], rehearsalMarker: marker, expected: options['update-test-build'] ? 'present (update rehearsal build)' : 'absent (release build)' };
  } catch (error) {
    fail('run', error instanceof Error ? error.stack : String(error));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  report.ok = Object.values(report.checks).every(check => check.ok);
  if (report.ok && options.stage) {
    mkdirSync(options.stage, { recursive: true });
    for (const name of report.checks.artifacts.expected) copyFileSync(path.join(options.release, name), path.join(options.stage, name));
    report.staged = { dir: options.stage, files: report.checks.artifacts.expected };
  }
  const text = JSON.stringify(report, null, 2);
  console.log(text);
  if (options.json) writeFileSync(options.json, `${text}\n`);
  if (options.summary) appendFileSync(options.summary, summaryMarkdown(report));
  process.exitCode = report.ok ? 0 : 1;
}

/**
 * The signature of a macOS app: valid (deep, strict); with a certificate, its leaf's SHA-256 is the expected one and
 * the designated requirement names the app id and that certificate's leaf (SHA-1); `adhoc` expects an ad-hoc signature.
 */
export function signatureCheck(app, options, scratch) {
  const verify = run('codesign', ['--verify', '--deep', '--strict', app]);
  const display = run('codesign', ['-dvvv', app]);
  const details = `${display.stdout}${display.stderr}`;
  const requirement = run('codesign', ['-d', '-r-', app]);
  const designated = /designated => (.*)/.exec(`${requirement.stdout}${requirement.stderr}`)?.[1]?.trim() ?? null;
  const cdhash = /^CDHash=([0-9a-f]+)/m.exec(details)?.[1] ?? null;
  const base = { verify: verify.status === 0 ? 'valid' : verify.stderr.trim(), designated, cdhash, details: details.split('\n').filter(line => /^(Identifier|Format|Signature|TeamIdentifier|Authority)=/.test(line)) };
  if (options['mac-certificate'] === 'adhoc') return { ok: verify.status === 0 && /Signature=adhoc/.test(details), expected: 'adhoc', ...base };
  mkdirSync(scratch, { recursive: true });
  run('codesign', ['-d', `--extract-certificates=${path.join(scratch, 'c')}`, app]);
  let sha256 = null, sha1 = null;
  try {
    const der = readFileSync(path.join(scratch, 'c0'));
    sha256 = createHash('sha256').update(der).digest('hex');
    sha1 = createHash('sha1').update(der).digest('hex');
  } catch { /* ad-hoc: no certificate */ }
  const expectedRequirement = sha1 ? `identifier "${options['app-id']}" and certificate leaf = H"${sha1}"` : null;
  return { ok: verify.status === 0 && !/Signature=adhoc/.test(details) && sha256 === options['mac-certificate'] && designated === expectedRequirement,
    expected: options['mac-certificate'], certificateSha256: sha256, expectedRequirement, ...base };
}

/** The file names in an app.asar (its JSON header), with / separators. */
export function asarFileList(asar) {
  const bytes = readFileSync(asar);
  const size = bytes.readUInt32LE(12);
  const header = JSON.parse(bytes.subarray(16, 16 + size).toString('utf8'));
  const names = [];
  const walk = (node, prefix) => { for (const [name, child] of Object.entries(node.files ?? {})) { const full = prefix ? `${prefix}/${name}` : name; if (child.files) walk(child, full); else names.push(full); } };
  walk(header, '');
  return names;
}

/** The dmg holds the same signed app: attach it read-only without Finder, check its signature and CDHash, detach. */
function dmgCheck(dmg, mountpoint, options, zipCdhash, scratch) {
  mkdirSync(mountpoint);
  const attach = run('hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint]);
  if (attach.status !== 0) return { ok: false, problem: `hdiutil attach failed: ${attach.stderr.trim()}` };
  try {
    const app = path.join(mountpoint, `${PRODUCT}.app`);
    const signature = signatureCheck(app, options, scratch);
    const bundle = existsSync(path.join(app, 'Contents', 'Resources', 'mcp', 'novelai-mcp.mjs'));
    const applications = existsSync(path.join(mountpoint, 'Applications'));
    const sameAsZip = Boolean(signature.cdhash) && signature.cdhash === zipCdhash;
    return { ok: signature.ok && bundle && applications && sameAsZip, signature, sameSignatureAsZip: sameAsZip, mcpBundle: bundle, applicationsLink: applications };
  } finally {
    const detach = run('hdiutil', ['detach', mountpoint]);
    if (detach.status !== 0) run('hdiutil', ['detach', mountpoint, '-force']);
  }
}

function summaryMarkdown(report) {
  const mib = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const lines = [`### Packaged app check: ${report.platform} ${report.arch} ${report.version} — ${report.ok ? 'passed' : 'FAILED'}`, '', '| check | result |', '| --- | --- |'];
  for (const [name, check] of Object.entries(report.checks)) lines.push(`| ${name} | ${check.ok ? 'ok' : `failed${check.problem ? `: ${String(check.problem).split('\n')[0]}` : ''}`} |`);
  const { artifacts, mcp, sharp } = report.checks;
  if (artifacts?.sizes) lines.push('', ...Object.entries(artifacts.sizes).map(([name, size]) => `- \`${name}\` ${mib(size)}`));
  if (mcp?.toolCount !== undefined) lines.push(`- MCP bundle: ${mcp.toolCount} tools, same as the source server: ${mcp.sameToolsAsSource}`);
  if (sharp?.probe?.vips) lines.push(`- sharp in the packaged app: libvips ${sharp.probe.vips}; unpacked: ${sharp.unpacked.join(', ')}`);
  if (sharp?.libvipsVersions) lines.push(`- libraries in this libvips (versions.json): ${Object.entries(sharp.libvipsVersions).map(([key, value]) => `${key} ${value}`).join(', ')}${sharp.versionDifferences.length ? `; DIFFERENT FROM THE NOTICES: ${sharp.versionDifferences.join('; ')}` : '; as in the notices'}`);
  return `${lines.join('\n')}\n\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
