#!/usr/bin/env node
// Builds third-party-sources-<version>.tar.gz for a release (release workflow; also usable locally, needs the network,
// curl, tar and gzip): the source code of the libraries inside sharp's prebuilt libvips, which the app ships and some
// of which are under the LGPL, as THIRD_PARTY_NOTICES.md §3 describes them.
//
//   node .github/scripts/third-party-sources.mjs --version <version> --out <dir>
//
// Contents (one folder third-party-sources-<version>/):
//   sources/   every source archive in novelai/client/scripts/licenses/sharp-libvips/manifest.json (libvips and the
//              libraries it is built from, librsvg included), the build scripts of sharp-libvips at the version the
//              manifest names and of libvips/build-win64-mxe (which builds the Windows libvips) at its tag, and the
//              MPL-2.0 Rust crates compiled into librsvg (rsvg-crates.json), each downloaded from its upstream URL;
//   SOURCES.md and sources.json: what each archive is, where it came from, its size and sha256.
// Verification: the manifests hold the sha256 of the license files reproduced in the notices, not of the archives. Every
// archive that a manifest names is unpacked and each of those license files must have the recorded sha256, so the
// archive is the one the notices were made from; the sha256 of every downloaded archive is recorded. Any failed download
// or mismatch fails the run (exit status 1) and writes no archive.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const client = path.join(repo, 'novelai', 'client');
const vendored = path.join(client, 'scripts', 'licenses', 'sharp-libvips');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parseArgs(argv) {
  const options = { version: null, out: null };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!['--version', '--out'].includes(flag) || !value) throw new Error('usage: third-party-sources.mjs --version <version> --out <dir>');
    options[flag.slice(2)] = value;
  }
  if (!options.version || !options.out) throw new Error('usage: third-party-sources.mjs --version <version> --out <dir>');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error(`not a version: ${options.version}`);
  return options;
}

// curl rather than fetch: some source hosts refuse Node's fetch (gitlab.freedesktop.org answers HTTP 406).
function download(url, file) {
  if (!url.startsWith('https://')) throw new Error(`refusing a non-https source URL: ${url}`);
  execFileSync('curl', ['--silent', '--show-error', '--location', '--fail', '--proto', '=https', '--retry', '3', '--max-time', '900', '--output', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  return readFileSync(file);
}

// The excerpt fetch-libvips-licenses.mjs vendors for license comments: the first /* … */ block that contains
// "Permission is hereby granted", followed by a newline.
function permissionComment(bytes, from) {
  const match = [...bytes.toString('utf8').matchAll(/\/\*[\s\S]*?\*\//g)].find(block => block[0].includes('Permission is hereby granted'));
  if (!match) throw new Error(`${from} has no comment containing "Permission is hereby granted".`);
  return Buffer.from(`${match[0]}\n`, 'utf8');
}

const extension = url => (/\.(tar\.xz|tar\.gz|tar\.bz2|tgz|crate|zip)$/.exec(new URL(url).pathname)?.[1] ?? 'tar.gz');

/** The archives to collect, each with the license files a manifest recorded from it ({path, sha256, excerpt}). */
function plannedArchives() {
  const manifest = JSON.parse(readFileSync(path.join(vendored, 'manifest.json'), 'utf8'));
  const crates = JSON.parse(readFileSync(path.join(vendored, 'rsvg-crates.json'), 'utf8'));
  const archives = new Map();
  const add = (url, name, entry) => {
    const archive = archives.get(url) ?? { url, file: `${name}.${extension(url)}`, describes: [], checks: [] };
    if (!archive.describes.includes(entry.describes)) archive.describes.push(entry.describes);
    archive.checks.push(...(entry.checks ?? []));
    archives.set(url, archive);
  };
  for (const component of manifest.components) {
    const checks = component.files.filter(file => file.from.startsWith(`${component.source} → `)).map(file => {
      const rest = file.from.slice(component.source.length + 3);
      const excerpt = / \(excerpt: [^)]*\)$/.test(rest);
      return { path: rest.replace(/ \(excerpt: [^)]*\)$/, ''), sha256: file.sha256, excerpt };
    });
    add(component.source, `${component.key}-${component.version}`, { describes: `${component.name} ${component.version}`, checks });
  }
  if (!archives.has(crates.tarball)) throw new Error(`rsvg-crates.json names a librsvg tarball the manifest does not: ${crates.tarball}`);
  archives.get(crates.tarball).describes.push(`librsvg ${crates.rsvg} (the source the Rust crate list was made from)`);
  add(`https://github.com/lovell/sharp-libvips/archive/refs/tags/v${manifest.sharpLibvips}.tar.gz`, `sharp-libvips-${manifest.sharpLibvips}`,
    { describes: `sharp-libvips ${manifest.sharpLibvips}: the build scripts of the macOS and Linux libvips binaries` });
  const windowsTag = /\/releases\/tag\/(v[^/]+)$/.exec(manifest.windows.builtBy)?.[1];
  if (!windowsTag) throw new Error(`cannot read the build-win64-mxe tag from ${manifest.windows.builtBy}`);
  add(`https://github.com/libvips/build-win64-mxe/archive/refs/tags/${windowsTag}.tar.gz`, `build-win64-mxe-${windowsTag.slice(1)}`,
    { describes: `build-win64-mxe ${windowsTag}: the build scripts of the Windows libvips (${manifest.windows.package})` });
  for (const crate of crates.crates.filter(item => /\bMPL-2\.0\b/.test(item.license))) {
    const checks = crate.files.map(file => ({ path: path.posix.basename(file.file), sha256: file.sha256, excerpt: false }));
    add(`https://static.crates.io/crates/${crate.name}/${crate.name}-${crate.version}.crate`, `crate-${crate.name}-${crate.version}`,
      { describes: `Rust crate ${crate.name} ${crate.version} (${crate.license}), compiled into librsvg`, checks });
  }
  return { manifest, crates, archives: [...archives.values()] };
}

/** Unpacks one archive (without its top folder) and checks the recorded license files. */
function verify(archive, file, work) {
  if (archive.checks.length === 0) return { verified: 0 };
  const dir = mkdtempSync(path.join(work, 'unpack-'));
  try {
    execFileSync('tar', ['-xf', file, '-C', dir, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'inherit'] });
    for (const check of archive.checks) {
      const original = readFileSync(realpathSync(path.join(dir, check.path)));
      const bytes = check.excerpt ? permissionComment(original, check.path) : original;
      const actual = sha256(bytes);
      if (actual !== check.sha256) throw new Error(`${archive.url}: ${check.path} has sha256 ${actual}, the notices recorded ${check.sha256}`);
    }
    return { verified: archive.checks.length };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sourcesMarkdown(version, plan, records, electronVersion) {
  const mib = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `# Third-party source code for MCP for NovelAI ${version}

The installers of MCP for NovelAI ${version} contain sharp's prebuilt libvips binaries (npm packages
\`@img/sharp-libvips-<platform>\` and \`@img/sharp-win32-x64\`, sharp-libvips ${plan.manifest.sharpLibvips}). libvips and several
of the libraries built into them are licensed under the GNU LGPL; the licenses of all of them are in
THIRD_PARTY_NOTICES.md (§3), which ships with the app. This archive holds their source code, downloaded unchanged
from the upstream locations the build scripts use. The binaries themselves are unmodified builds of sharp-libvips
${plan.manifest.sharpLibvips} (macOS, Linux) and of ${plan.manifest.windows.builtBy} (Windows).

Verified: each archive marked with a number was unpacked and that many of its license files have exactly the sha256
recorded in the notices (\`novelai/client/scripts/licenses/sharp-libvips/\` of the project's repository at this
release).

| File | Contents | Upstream URL | Size | sha256 | Verified |
| --- | --- | --- | --- | --- | --- |
${records.map(record => `| \`sources/${record.file}\` | ${record.describes.join('; ')} | ${record.url} | ${mib(record.size)} | \`${record.sha256}\` | ${record.verified || '—'} |`).join('\n')}

Not in this archive:
- Electron ${electronVersion} and the Chromium, Node.js, V8, FFmpeg and other components inside it, which are used
  unmodified: their source is that of Electron v${electronVersion} (https://github.com/electron/electron/tree/v${electronVersion}
  and the sources its DEPS file names); their notices are in LICENSES.chromium.html, which ships with the app.
- The Rust standard library compiled into librsvg (Rust ${plan.crates.rustStd.version}, ${plan.crates.rustStd.source}) and the
  crates it is built from (its \`library/Cargo.lock\`), and the Rust crates under permissive licenses (THIRD_PARTY_NOTICES.md
  §3.3, with a crates.io link for each).
- The npm packages of the app (THIRD_PARTY_NOTICES.md §2), available from the npm registry at the versions listed there.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = plannedArchives();
  const electronVersion = JSON.parse(readFileSync(path.join(client, 'package-lock.json'), 'utf8')).packages['node_modules/electron'].version;
  const name = `third-party-sources-${options.version}`;
  const out = path.resolve(options.out);
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), 'nai-third-party-sources-'));
  try {
    const root = path.join(work, name);
    const sources = path.join(root, 'sources');
    mkdirSync(sources, { recursive: true });
    const records = [];
    for (const archive of plan.archives) {
      const file = path.join(sources, archive.file);
      const bytes = download(archive.url, file);
      const { verified } = verify(archive, file, work);
      records.push({ file: archive.file, url: archive.url, describes: archive.describes, size: bytes.length, sha256: sha256(bytes), verified });
      console.error(`${verified ? `verified ${verified}` : 'recorded'}  ${archive.file}  ${archive.url}`);
    }
    writeFileSync(path.join(root, 'sources.json'), `${JSON.stringify({ version: options.version, sharpLibvips: plan.manifest.sharpLibvips, electron: electronVersion, archives: records }, null, 2)}\n`);
    writeFileSync(path.join(root, 'SOURCES.md'), sourcesMarkdown(options.version, plan, records, electronVersion));

    // GNU tar (the release runner) gets reproducible metadata; other tars pack the folder as it is.
    const gnu = /GNU tar/.test(spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '');
    const tarFile = path.join(work, `${name}.tar`);
    execFileSync('tar', [...(gnu ? ['--sort=name', '--owner=0', '--group=0', '--numeric-owner', '--mtime=@0'] : []), '-cf', tarFile, '-C', work, name]);
    execFileSync('gzip', ['-n', '-6', tarFile]);
    const archiveFile = path.join(out, `${name}.tar.gz`);
    rmSync(archiveFile, { force: true });
    execFileSync('mv', [`${tarFile}.gz`, archiveFile]);
    const bytes = readFileSync(archiveFile);
    console.log(JSON.stringify({ ok: true, file: archiveFile, size: statSync(archiveFile).size, sha256: sha256(bytes), archives: records.length,
      verifiedLicenseFiles: records.reduce((sum, record) => sum + record.verified, 0), unverifiedArchives: records.filter(record => !record.verified).map(record => record.file) }, null, 2));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
