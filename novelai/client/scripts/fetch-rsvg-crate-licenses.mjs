#!/usr/bin/env node
// Maintenance tool (needs the network and cargo; never run by the build or the tests): vendors the license files of
// the Rust crates librsvg is built from, and of the Rust standard library, into
// scripts/licenses/sharp-libvips/rsvg-crates/ with rsvg-crates.json.
//   node scripts/fetch-rsvg-crate-licenses.mjs
// Needs curl, tar and cargo on PATH. librsvg is written in Rust, and the libvips binaries of sharp-libvips link it
// statically, so the crates it is built from and the Rust standard library are inside them. For the librsvg version
// in scripts/licenses/sharp-libvips/manifest.json (written by fetch-libvips-licenses.mjs) it downloads the librsvg
// tarball, checks that sharp-libvips' build/posix.sh of that release still makes the Cargo.toml edits below and
// makes them too, regenerates the lockfile as posix.sh does (cargo update --workspace), and lists the crates the
// librsvg-c package (the C library meson builds, default features) links for each target: normal dependency edges
// without proc macros, so build scripts, build tools and proc macros (which run only at build time) are left out.
// Cargo runs with a temporary CARGO_HOME, so neither ~/.cargo nor any global configuration is used or changed.
// generate-notices.mjs reads only the vendored files. Run it again after fetch-libvips-licenses.mjs changes the
// librsvg version or sharp-libvips' Rust toolchain changes (RUST_COMMIT_PREFIX), review the result and commit it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendored = path.join(client, 'scripts', 'licenses', 'sharp-libvips');
const output = path.join(vendored, 'rsvg-crates');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const withoutPatch = version => version.replace(/\.\d+$/, '');

// The targets of the binaries this project ships: Linux x64, macOS arm64 and x64 (sharp-libvips) and Windows x64
// (build-win64-mxe, a MinGW toolchain).
const TARGETS = ['x86_64-unknown-linux-gnu', 'aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-gnu'];
// The Cargo.toml edits of sharp-libvips' build/posix.sh (verbatim) and what they do.
const EDITS = [
  { line: 'sed -i\'.bak\' "/image = /s/, \\"gif\\", \\"webp\\"//" rsvg/Cargo.toml', files: ['rsvg/Cargo.toml'], match: 'image = ', remove: ', "gif", "webp"' },
  { line: 'sed -i\'.bak\' "/cairo-rs = /s/, \\"pdf\\", \\"ps\\"//" {librsvg-c,rsvg}/Cargo.toml', files: ['librsvg-c/Cargo.toml', 'rsvg/Cargo.toml'], match: 'cairo-rs = ', remove: ', "pdf", "ps"' },
];
// The Rust toolchain the libvips binaries were compiled with: its commit appears in their panic paths
// (/rustc/<commit>/library/...), checked in the darwin and linux libvips-cpp libraries of sharp-libvips 1.3.3.
const RUST_COMMIT_PREFIX = '787af2b8';
const RUST_FILES = ['LICENSE-MIT', 'LICENSE-APACHE', 'COPYRIGHT'];
// Top-level files of a crate that carry its license or notices.
const LICENSE_FILE = /^(licen[sc]e|copying|notice|copyright|unlicense)/i;
const NOT_A_LICENSE = /\.(rs|toml|json|lock|yml|yaml|sh|py|c|h)$/i;

function download(url) {
  return execFileSync('curl', ['--silent', '--show-error', '--location', '--fail', '--retry', '3', '--max-time', '300', url], { maxBuffer: 512 << 20 });
}

const manifest = JSON.parse(readFileSync(path.join(vendored, 'manifest.json'), 'utf8'));
const rsvgVersion = manifest.versions.rsvg;
if (!rsvgVersion) throw new Error('manifest.json has no rsvg version: run fetch-libvips-licenses.mjs first.');
const tarball = `https://download.gnome.org/sources/librsvg/${withoutPatch(rsvgVersion)}/librsvg-${rsvgVersion}.tar.xz`;
const posixSh = `https://raw.githubusercontent.com/lovell/sharp-libvips/v${manifest.sharpLibvips}/build/posix.sh`;

const work = mkdtempSync(path.join(tmpdir(), 'nai-rsvg-crates-'));
const env = { ...process.env, CARGO_HOME: path.join(work, 'cargo-home'), CARGO_TERM_COLOR: 'never' };
const cargo = (args, cwd) => execFileSync('cargo', args, { cwd, env, maxBuffer: 512 << 20, stdio: ['ignore', 'pipe', 'inherit'] }).toString('utf8');
try {
  const script = download(posixSh).toString('utf8');
  const rsvgPart = script.slice(script.indexOf('mkdir ${DEPS}/rsvg'), script.indexOf('mkdir ${DEPS}/cgif'));
  for (const edit of EDITS) if (!rsvgPart.split('\n').includes(edit.line)) throw new Error(`${posixSh} no longer contains the line\n  ${edit.line}\nin its librsvg part: review its build of librsvg and update this script.`);
  if (!rsvgPart.split('\n').includes('cargo update --workspace')) throw new Error(`${posixSh} no longer runs "cargo update --workspace" for librsvg: update this script.`);
  if (!rsvgPart.includes(`librsvg/$(without_patch $VERSION_RSVG)/librsvg-\${VERSION_RSVG}.tar.xz`)) throw new Error(`${posixSh} downloads librsvg from elsewhere: update this script.`);

  const source = path.join(work, 'librsvg');
  mkdirSync(source);
  writeFileSync(path.join(work, 'librsvg.tar.xz'), download(tarball));
  execFileSync('tar', ['-xf', path.join(work, 'librsvg.tar.xz'), '-C', source, '--strip-components=1']);
  console.log(`fetched ${tarball}`);
  for (const edit of EDITS) for (const file of edit.files) {
    const full = path.join(source, file);
    const lines = readFileSync(full, 'utf8').split('\n');
    let changed = 0;
    const next = lines.map(line => {
      if (!line.includes(edit.match) || !line.includes(edit.remove)) return line;
      changed++;
      return line.replace(edit.remove, '');
    });
    if (!changed) throw new Error(`${file} of librsvg ${rsvgVersion} has no "${edit.match}" line containing ${edit.remove}: the edit of posix.sh would do nothing.`);
    writeFileSync(full, next.join('\n'));
  }
  const cargoVersion = cargo(['--version'], source).trim();
  cargo(['update', '--workspace'], source);
  cargo(['fetch', '--locked'], source);

  const metadata = JSON.parse(cargo(['metadata', '--format-version', '1', '--locked', '--offline'], source));
  const workspace = new Set(metadata.workspace_members);
  const byKey = new Map(metadata.packages.map(item => [`${item.name} ${item.version}`, item]));
  const targetsOf = new Map();
  for (const target of TARGETS) {
    const tree = cargo(['tree', '--locked', '--offline', '-p', 'librsvg-c', '-e', 'normal,no-proc-macro', '--target', target, '--prefix', 'none', '-f', '{p}'], source);
    for (const line of tree.split('\n')) {
      const match = /^(\S+) v(\S+)/.exec(line.trim());
      if (!match) continue;
      const key = `${match[1]} ${match[2]}`;
      if (!targetsOf.has(key)) targetsOf.set(key, new Set());
      targetsOf.get(key).add(target);
    }
  }

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const crates = [];
  const workspaceMembers = [];
  for (const [key, targets] of [...targetsOf].sort(([a], [b]) => a.localeCompare(b))) {
    const item = byKey.get(key);
    if (!item) throw new Error(`cargo metadata does not know ${key}.`);
    if (workspace.has(item.id)) { workspaceMembers.push({ name: item.name, version: item.version, license: item.license ?? null }); continue; }
    const directory = path.dirname(item.manifest_path);
    const id = `${item.name}-${item.version}`;
    const files = [];
    for (const file of readdirSync(directory).sort()) {
      if (!LICENSE_FILE.test(file) || NOT_A_LICENSE.test(file) || !statSync(path.join(directory, file)).isFile()) continue;
      const bytes = readFileSync(path.join(directory, file));
      mkdirSync(path.join(output, id), { recursive: true });
      writeFileSync(path.join(output, id, file), bytes);
      files.push({ file: `rsvg-crates/${id}/${file}`, sha256: sha256(bytes) });
    }
    crates.push({
      name: item.name, version: item.version, license: item.license ?? (item.license_file ? `see ${item.license_file}` : null), authors: item.authors ?? [],
      targets: TARGETS.filter(target => targets.has(target)), source: `https://crates.io/crates/${item.name}/${item.version}`, files,
    });
  }

  const commitInfo = JSON.parse(download(`https://api.github.com/repos/rust-lang/rust/commits/${RUST_COMMIT_PREFIX}`).toString('utf8'));
  const commit = commitInfo.sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !commit.startsWith(RUST_COMMIT_PREFIX)) throw new Error(`GitHub does not resolve rust-lang/rust ${RUST_COMMIT_PREFIX} to one commit.`);
  const rustVersion = download(`https://raw.githubusercontent.com/rust-lang/rust/${commit}/src/version`).toString('utf8').trim();
  mkdirSync(path.join(output, 'rust-std'), { recursive: true });
  const rustFiles = RUST_FILES.map(file => {
    const bytes = download(`https://raw.githubusercontent.com/rust-lang/rust/${commit}/${file}`);
    writeFileSync(path.join(output, 'rust-std', file), bytes);
    return { file: `rsvg-crates/rust-std/${file}`, from: `https://github.com/rust-lang/rust/blob/${commit}/${file}`, sha256: sha256(bytes) };
  });

  const result = {
    note: 'Written by scripts/fetch-rsvg-crate-licenses.mjs; read by scripts/generate-notices.mjs. Do not edit by hand.',
    rsvg: rsvgVersion,
    tarball,
    posixSh,
    edits: EDITS.map(edit => edit.line),
    package: 'librsvg-c',
    edges: 'normal,no-proc-macro',
    targets: TARGETS,
    cargo: cargoVersion,
    workspaceMembers,
    rustStd: {
      commitPrefix: RUST_COMMIT_PREFIX, commit, version: rustVersion, committedAt: commitInfo.commit?.committer?.date ?? null,
      source: `https://github.com/rust-lang/rust/tree/${commit}/library`, files: rustFiles,
    },
    crates,
  };
  writeFileSync(path.join(vendored, 'rsvg-crates.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${crates.length} crates (${crates.filter(item => !item.files.length).length} without license files) and the Rust standard library ${rustVersion} (${commit}) to ${path.relative(process.cwd(), output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
