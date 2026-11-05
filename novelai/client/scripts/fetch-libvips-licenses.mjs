#!/usr/bin/env node
// Maintenance tool (needs the network; never run by the build or the tests): vendors what THIRD_PARTY_NOTICES.md says
// about the libraries inside sharp's prebuilt libvips, and their copyright and license files, into
// scripts/licenses/sharp-libvips/.
//   node scripts/fetch-libvips-licenses.mjs
// Needs curl and tar on PATH. For the sharp-libvips version in package-lock.json it reads that release's
// versions.properties and THIRD-PARTY-NOTICES.md and the versions.json of the Windows package (whose libvips is
// built separately), downloads each library's source archive from the URL sharp-libvips' own build script
// (build/posix.sh) uses, copies the license files listed below, and writes manifest.json with every file's source
// and sha256. generate-notices.mjs reads only these vendored files, so the notices never depend on the platform the
// app is built on. Run it again after a sharp upgrade that changes the sharp-libvips version, review the result
// and commit it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(client, 'scripts', 'licenses', 'sharp-libvips');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const withoutPatch = version => version.replace(/\.\d+$/, '');

// key (versions.json) → name in sharp-libvips' licensing table, source archive (as in build/posix.sh) and the
// license files to keep (paths inside the archive; `as` renames).
const COMPONENTS = [
  { key: 'aom', name: 'aom', url: v => `https://storage.googleapis.com/aom-releases/libaom-${v}.tar.gz`, files: ['LICENSE', 'PATENTS'] },
  { key: 'archive', name: 'libarchive', url: v => `https://github.com/libarchive/libarchive/releases/download/v${v}/libarchive-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'cairo', name: 'cairo', url: v => `https://cairographics.org/releases/cairo-${v}.tar.xz`, files: ['COPYING', 'COPYING-MPL-1.1', 'COPYING-LGPL-2.1'],
    extra: [{ as: 'MPL-2.0.txt', url: 'https://www.mozilla.org/media/MPL/2.0/index.txt', note: 'Mozilla Public License 2.0, the license sharp-libvips names for cairo' }] },
  { key: 'cgif', name: 'cgif', url: v => `https://github.com/dloebl/cgif/archive/v${v}.tar.gz`, files: ['LICENSE'] },
  { key: 'exif', name: 'libexif', url: v => `https://github.com/libexif/libexif/releases/download/v${v}/libexif-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'expat', name: 'expat', url: v => `https://github.com/libexpat/libexpat/releases/download/R_${v.replaceAll('.', '_')}/expat-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'ffi', name: 'libffi', url: v => `https://github.com/libffi/libffi/releases/download/v${v}/libffi-${v}.tar.gz`, files: ['LICENSE'] },
  { key: 'fontconfig', name: 'fontconfig', url: v => `https://gitlab.freedesktop.org/fontconfig/fontconfig/-/archive/${v}/fontconfig-${v}.tar.gz`, files: ['COPYING'] },
  { key: 'freetype', name: 'freetype', url: v => `https://github.com/freetype/freetype/archive/VER-${v.replaceAll('.', '-')}.tar.gz`, files: ['LICENSE.TXT', 'docs/FTL.TXT',
    // LICENSE.TXT: the BDF and PCF drivers (compiled in by default) and fthash carry their own X11-style license.
    { from: 'src/bdf/README', as: 'bdf-README' }, { from: 'src/pcf/README', as: 'pcf-README' },
    { from: 'src/base/fthash.c', as: 'fthash.c-license.txt', excerpt: 'permission-comment' }] },
  { key: 'fribidi', name: 'fribidi', url: v => `https://github.com/fribidi/fribidi/releases/download/v${v}/fribidi-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'glib', name: 'glib', url: v => `https://download.gnome.org/sources/glib/${withoutPatch(v)}/glib-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'harfbuzz', name: 'harfbuzz', url: v => `https://github.com/harfbuzz/harfbuzz/archive/${v}.tar.gz`, files: ['COPYING'] },
  { key: 'heif', name: 'libheif', url: v => `https://github.com/strukturag/libheif/releases/download/v${v}/libheif-${v}.tar.gz`, files: ['COPYING'] },
  { key: 'highway', name: 'highway', url: v => `https://github.com/google/highway/archive/${v}.tar.gz`, files: ['LICENSE'] },
  { key: 'imagequant', name: 'libimagequant', url: v => `https://github.com/lovell/libimagequant/archive/v${v}.tar.gz`, files: ['COPYRIGHT'] },
  { key: 'lcms', name: 'lcms', url: v => `https://github.com/mm2/Little-CMS/releases/download/lcms${v}/lcms2-${v}.tar.gz`, files: ['LICENSE'] },
  { key: 'mozjpeg', name: 'mozjpeg', url: v => `https://github.com/mozilla/mozjpeg/archive/${v}.tar.gz`, files: ['LICENSE.md', 'README.ijg'] },
  { key: 'pango', name: 'pango', url: v => `https://download.gnome.org/sources/pango/${withoutPatch(v)}/pango-${v}.tar.xz`, files: ['COPYING'] },
  { key: 'pixman', name: 'pixman', url: v => `https://cairographics.org/releases/pixman-${v}.tar.gz`, files: ['COPYING'] },
  { key: 'png', name: 'libpng', url: v => `https://github.com/pnggroup/libpng/archive/v${v}.tar.gz`, files: ['LICENSE'] },
  { key: 'proxy-libintl', name: 'proxy-libintl', url: v => `https://github.com/frida/proxy-libintl/archive/${v}.tar.gz`, files: ['COPYING'] },
  { key: 'rsvg', name: 'librsvg', url: v => `https://download.gnome.org/sources/librsvg/${withoutPatch(v)}/librsvg-${v}.tar.xz`, files: ['COPYING.LIB'] },
  { key: 'tiff', name: 'libtiff', url: v => `https://gitlab.com/libtiff/libtiff/-/archive/v${v}/libtiff-v${v}.tar.gz`, files: ['LICENSE.md'] },
  { key: 'uhdr', name: 'libultrahdr', url: v => `https://github.com/google/libultrahdr/archive/v${v}.tar.gz`, files: ['LICENSE', { from: 'adobe-hdr-gain-map-license/NOTICE', as: 'NOTICE' }] },
  { key: 'vips', name: 'libvips', url: v => `https://github.com/libvips/libvips/releases/download/v${v}/vips-${v.replace(/-[0-9A-Za-z]+$/, '')}.tar.xz`, files: ['LICENSE'] },
  // libnsgif is compiled into libvips from its own source tree (libvips/foreign/libnsgif).
  { key: 'vips', name: 'libnsgif', id: 'libnsgif', url: v => `https://github.com/libvips/libvips/releases/download/v${v}/vips-${v.replace(/-[0-9A-Za-z]+$/, '')}.tar.xz`, files: ['libvips/foreign/libnsgif/COPYING'] },
  { key: 'webp', name: 'libwebp', url: v => `https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-${v}.tar.gz`, files: ['COPYING', 'PATENTS'] },
  { key: 'xml2', name: 'libxml2', url: v => `https://download.gnome.org/sources/libxml2/${withoutPatch(v)}/libxml2-${v}.tar.xz`, files: ['Copyright'] },
  { key: 'zlib-ng', name: 'zlib-ng', url: v => `https://github.com/zlib-ng/zlib-ng/archive/${v}.tar.gz`, files: ['LICENSE.md'] },
];

// Excerpts of source files whose license is a comment: `permission-comment` keeps the first /* … */ block that
// contains "Permission is hereby granted", byte for byte, followed by a newline.
const EXCERPTS = {
  'permission-comment': {
    describe: 'the first /* … */ comment containing "Permission is hereby granted"',
    take(bytes, from) {
      const match = [...bytes.toString('utf8').matchAll(/\/\*[\s\S]*?\*\//g)].find(block => block[0].includes('Permission is hereby granted'));
      if (!match) throw new Error(`${from} has no comment containing "Permission is hereby granted".`);
      return Buffer.from(`${match[0]}\n`, 'utf8');
    },
  },
};

// curl rather than fetch: some source hosts refuse Node's fetch (gitlab.freedesktop.org answers HTTP 406).
function download(url) {
  return execFileSync('curl', ['--silent', '--show-error', '--location', '--fail', '--retry', '3', '--max-time', '300', url], { maxBuffer: 512 << 20 });
}

const lock = JSON.parse(readFileSync(path.join(client, 'package-lock.json'), 'utf8'));
const libvipsVersions = new Set(Object.entries(lock.packages).filter(([key]) => /node_modules\/@img\/sharp-libvips-/.test(key)).map(([, entry]) => entry.version));
if (libvipsVersions.size !== 1) throw new Error(`Expected one sharp-libvips version in the lockfile, found ${[...libvipsVersions].join(', ') || 'none'}.`);
const [sharpLibvips] = libvipsVersions;
const sharpVersion = lock.packages['node_modules/sharp'].version;
const release = `https://raw.githubusercontent.com/lovell/sharp-libvips/v${sharpLibvips}`;

const work = mkdtempSync(path.join(tmpdir(), 'nai-libvips-licenses-'));
try {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const properties = (download(`${release}/versions.properties`)).toString('utf8');
  const versions = Object.fromEntries([...properties.matchAll(/^VERSION_([A-Z0-9_]+)=(\S+)$/gm)].map(([, key, value]) => [key.toLowerCase().replaceAll('_', '-'), value]));
  const noticesBytes = download(`${release}/THIRD-PARTY-NOTICES.md`);
  writeFileSync(path.join(output, 'THIRD-PARTY-NOTICES.md'), noticesBytes);

  // The Windows packages carry libvips from libvips/build-win64-mxe; their versions.json can differ slightly.
  const win = path.join(work, 'win');
  mkdirSync(win);
  writeFileSync(path.join(win, 'package.tgz'), download(`https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-${sharpVersion}.tgz`));
  execFileSync('tar', ['-xzf', path.join(win, 'package.tgz'), '-C', win, 'package/versions.json']);
  const winVersions = JSON.parse(readFileSync(path.join(win, 'package', 'versions.json'), 'utf8'));
  const windowsDifferences = Object.fromEntries(Object.entries(winVersions).filter(([key, value]) => versions[key] !== value));

  const archives = new Map();
  const components = [];
  let freetypeYear = null;
  for (const component of COMPONENTS) {
    const version = versions[component.key];
    if (!version) throw new Error(`versions.properties has no ${component.key}`);
    const url = component.url(version);
    let directory = archives.get(url);
    if (!directory) {
      directory = path.join(work, `src-${archives.size}`);
      mkdirSync(directory);
      const file = path.join(work, `archive-${archives.size}${url.endsWith('.xz') ? '.tar.xz' : '.tar.gz'}`);
      writeFileSync(file, download(url));
      execFileSync('tar', ['-xf', file, '-C', directory, '--strip-components=1']);
      archives.set(url, directory);
      console.log(`fetched ${url}`);
    }
    const id = component.id ?? component.key;
    mkdirSync(path.join(output, id), { recursive: true });
    const files = [];
    for (const entry of component.files) {
      const from = typeof entry === 'string' ? entry : entry.from;
      const as = typeof entry === 'string' ? path.basename(entry) : entry.as;
      const excerpt = typeof entry === 'string' || !entry.excerpt ? null : EXCERPTS[entry.excerpt];
      const original = readFileSync(realpathSync(path.join(directory, from)));
      const bytes = excerpt ? excerpt.take(original, from) : original;
      writeFileSync(path.join(output, id, as), bytes);
      files.push({ file: `${id}/${as}`, from: `${url} → ${from}${excerpt ? ` (excerpt: ${excerpt.describe})` : ''}`, sha256: sha256(bytes) });
    }
    for (const extra of component.extra ?? []) {
      const bytes = download(extra.url);
      writeFileSync(path.join(output, id, extra.as), bytes);
      files.push({ file: `${id}/${extra.as}`, from: extra.url, note: extra.note, sha256: sha256(bytes) });
    }
    if (component.key === 'freetype') freetypeYear = /Copyright \(C\) \d{4}-(\d{4})/.exec(readFileSync(path.join(directory, 'include', 'freetype', 'freetype.h'), 'utf8'))?.[1] ?? null;
    components.push({ id, key: component.key, name: component.name, version, source: url, files });
  }
  const manifest = {
    note: 'Written by scripts/fetch-libvips-licenses.mjs; read by scripts/generate-notices.mjs. Do not edit by hand.',
    sharpLibvips,
    release: `https://github.com/lovell/sharp-libvips/tree/v${sharpLibvips}`,
    versions,
    windows: { package: `@img/sharp-win32-x64@${sharpVersion}`, builtBy: `https://github.com/libvips/build-win64-mxe/releases/tag/v${versions.vips}`, differences: windowsDifferences },
    freetypeYear,
    notices: { file: 'THIRD-PARTY-NOTICES.md', from: `${release}/THIRD-PARTY-NOTICES.md`, sha256: sha256(noticesBytes) },
    components,
  };
  writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${components.length} components to ${path.relative(process.cwd(), output)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
