#!/usr/bin/env node
// Generates THIRD_PARTY_NOTICES.md (novelai/client) from what the app actually distributes:
//   1. Electron, the application runtime (node_modules/electron);
//   2. the client's runtime dependencies: every non-development package of package-lock.json, which
//      electron-builder copies into app.asar/node_modules for the main process, and the packages the renderer
//      bundle (dist/assets) contains, development dependencies there because Vite bundles them (found by bundling
//      the renderer entry with esbuild, counting only packages whose code reaches the output);
//   3. the platform-specific sharp/libvips binaries among them, listed for every platform in the lockfile, with the
//      libraries inside libvips and their license files, vendored in scripts/licenses/sharp-libvips by
//      scripts/fetch-libvips-licenses.mjs (so nothing here depends on which platform package is installed), and the
//      Rust crates and Rust standard library compiled into librsvg, vendored there by
//      scripts/fetch-rsvg-crate-licenses.mjs;
//   4. the packages esbuild puts into the MCP server bundle (scripts/bundles.mjs, read from its metafile);
//   5. the small runtime helpers the build tools emit into the bundles;
//   6. data compiled into the app, with its source as far as it is known.
// License texts come from each installed package (its LICENSE/COPYING/NOTICE file, or the License section of
// its README when the package has no such file); identical texts are printed once. The output depends only on the
// lockfile, the installed packages and this script, never on the date or the platform, so it can be checked:
//   node scripts/generate-notices.mjs          write THIRD_PARTY_NOTICES.md
//   node scripts/generate-notices.mjs --check  exit 1 when the file is not what would be written
// (npm run notices / npm run notices:check; electron/third-party-notices.test.ts runs the check too.)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { bundleDefinitions } from './bundles.mjs';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const novelai = path.resolve(client, '..');
export const NOTICES_FILE = path.join(client, 'THIRD_PARTY_NOTICES.md');

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const lf = text => text.replace(/\r\n?/g, '\n');
const tidy = text => lf(text).split('\n').map(line => line.replace(/\s+$/, '')).join('\n').replace(/^\n+|\n+$/g, '');

/** A package's project page: its repository on the web, else its homepage, else its npm page. */
function projectUrl(manifest, name) {
  let repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (repository) {
    repository = repository.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^(?:ssh:\/\/)?git@([^:/]+)[:/]/, 'https://$1/');
    if (/^github:/.test(repository)) repository = `https://github.com/${repository.slice(7)}`;
    else if (/^[\w.-]+\/[\w.-]+$/.test(repository)) repository = `https://github.com/${repository}`;
    if (/^https?:\/\//.test(repository)) return repository.replace(/^http:\/\//, 'https://');
  }
  if (typeof manifest.homepage === 'string' && /^https?:\/\//.test(manifest.homepage)) return manifest.homepage;
  return `https://www.npmjs.com/package/${name}`;
}

function licenseOf(manifest, fallback) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license?.type) return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map(entry => entry.type ?? entry).join(' OR ');
  return fallback ?? 'UNKNOWN';
}

/** The License section of a README: from its heading to the next heading or link-reference block. */
function readmeLicenseSection(directory) {
  const readme = readdirSync(directory).find(name => /^readme(\.md|\.markdown|\.txt)?$/i.test(name));
  if (!readme) return null;
  const lines = lf(readFileSync(path.join(directory, readme), 'utf8')).split('\n');
  const start = lines.findIndex((line, index) => /^(#{1,6}\s*)?(the\s+)?licen[sc]e\s*$/i.test(line.trim()) && (line.trim().startsWith('#') || /^[-=]{3,}\s*$/.test(lines[index + 1] ?? '')));
  if (start < 0) return null;
  const body = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (index === start + 1 && /^[-=]{3,}\s*$/.test(line)) continue;
    if (/^#{1,6}\s/.test(line) || /^\[[^\]]+\]:\s/.test(line) || (/^[-=]{3,}\s*$/.test(lines[index + 1] ?? '') && line.trim())) break;
    body.push(line);
  }
  const text = tidy(body.join('\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/<a href="([^"]+)">[^<]*<\/a>/g, '$1'));
  return text ? `(License section of ${readme})\n\n${text}` : null;
}

const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i;
/** Some license files carry more than the package's own license; keep the part that applies. */
const EXCERPTS = { vite: text => text.split(/^# Licenses of bundled dependencies/m)[0] };

/** License and notice texts of an installed package directory, with the files they came from. */
function licenseTexts(directory, name) {
  const files = readdirSync(directory).filter(file => LICENSE_FILE.test(file) && !/\.(js|cjs|mjs|ts|json)$/i.test(file)).sort();
  const texts = files.map(file => ({ source: file, text: tidy((EXCERPTS[name] ?? (text => text))(readFileSync(path.join(directory, file), 'utf8'))) })).filter(entry => entry.text);
  if (texts.length) return texts;
  const section = readmeLicenseSection(directory);
  return section ? [{ source: 'README', text: section }] : [];
}

/** One package as installed: name, version, license, project page and its license texts. */
function installedPackage(directory, lockEntry = {}) {
  const manifest = readJson(path.join(directory, 'package.json'));
  return { name: manifest.name, version: manifest.version, license: licenseOf(manifest, lockEntry.license), url: projectUrl(manifest, manifest.name), texts: licenseTexts(directory, manifest.name) };
}

const nameFromLockPath = key => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** The lockfile key a dependency `name` of the package at `from` resolves to (Node's lookup through node_modules). */
function resolveLockKey(packages, from, name) {
  for (let base = from; ; base = base.includes('/node_modules/') ? base.slice(0, base.lastIndexOf('/node_modules/')) : '') {
    const key = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
  }
}

/** Lockfile keys reachable from the client's own dependencies through regular (not optional) dependency edges. */
function requiredKeys(packages) {
  const seen = new Set(), queue = [''];
  while (queue.length) {
    const key = queue.shift();
    for (const name of Object.keys({ ...packages[key].dependencies, ...packages[key].peerDependencies })) {
      const target = resolveLockKey(packages, key, name);
      if (target && !seen.has(target) && !packages[target].dev && !packages[target].optional) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}

/**
 * Client lockfile entries that electron-builder ships (non-development), split into the common ones every installer
 * contains and the platform-specific ones (optional packages and what only they require).
 */
function clientRuntimePackages() {
  const lock = readJson(path.join(client, 'package-lock.json'));
  const required = requiredKeys(lock.packages);
  const common = [], platform = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || entry.dev) continue;
    const name = nameFromLockPath(key);
    if (entry.optional || !required.has(key)) { platform.push({ name, version: entry.version, license: entry.license ?? 'UNKNOWN', os: entry.os, cpu: entry.cpu }); continue; }
    const directory = path.join(client, key);
    if (!existsSync(path.join(directory, 'package.json'))) throw new Error(`${name} ${entry.version} is in the lockfile but not installed: run npm install in novelai/client first.`);
    common.push(installedPackage(directory, entry));
  }
  return { common: dedupe(common), platform: platform.sort((a, b) => a.name.localeCompare(b.name)) };
}

function dedupe(packages) {
  const seen = new Map();
  for (const item of packages) seen.set(`${item.name}@${item.version}`, item);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The renderer's assets that are not code (styles, images, fonts): left out of the package search. */
const RENDERER_ASSETS = { name: 'renderer-assets', setup(builder) {
  builder.onResolve({ filter: /\.(?:css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/ }, args => ({ path: args.path, namespace: 'renderer-asset' }));
  builder.onLoad({ filter: /.*/, namespace: 'renderer-asset' }, () => ({ contents: '', loader: 'js' }));
} };

/**
 * Package folders whose code is in the renderer bundle: the renderer entry (src/main.tsx, as index.html loads it)
 * bundled the way Vite does for production (code splitting, process.env.NODE_ENV "production"), counting a package
 * only when some of its code reaches the output. Sorted, absolute.
 */
export async function rendererPackageDirectories() {
  const { metafile } = await build({ entryPoints: [path.join(client, 'src', 'main.tsx')], absWorkingDir: client, bundle: true, write: false, metafile: true,
    outdir: path.join(client, 'dist', 'assets'), platform: 'browser', format: 'esm', splitting: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent', plugins: [RENDERER_ASSETS] });
  const directories = new Set();
  for (const output of Object.values(metafile.outputs)) for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    const match = bytesInOutput > 0 && /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
    if (match) directories.add(path.resolve(client, match[1]));
  }
  return [...directories].sort();
}

/** Packages esbuild puts into the MCP server and tag-module bundles, read from their metafiles. */
async function bundledPackages() {
  const result = {};
  for (const [key, options] of Object.entries(bundleDefinitions(client))) {
    const { metafile } = await build({ ...options, write: false, metafile: true, logLevel: 'silent' });
    const directories = new Set();
    for (const input of Object.keys(metafile.inputs)) {
      const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'));
      if (match) directories.add(path.resolve(novelai, match[1]));
    }
    result[key] = dedupe([...directories].map(directory => installedPackage(directory)));
  }
  return result;
}

const VENDORED = path.join(client, 'scripts', 'licenses', 'sharp-libvips');

/**
 * The libraries in sharp's prebuilt libvips and their license files, from scripts/licenses/sharp-libvips (written by
 * scripts/fetch-libvips-licenses.mjs). Refuses files whose sha256 changed and a lockfile whose sharp-libvips
 * version is not the vendored one.
 */
function vendoredLibvips(platform) {
  const manifest = readJson(path.join(VENDORED, 'manifest.json'));
  const locked = new Set(platform.filter(item => item.name.startsWith('@img/sharp-libvips-')).map(item => item.version));
  if (locked.size !== 1 || !locked.has(manifest.sharpLibvips))
    throw new Error(`The lockfile's sharp-libvips version (${[...locked].join(', ') || 'none'}) is not the vendored ${manifest.sharpLibvips}: run node scripts/fetch-libvips-licenses.mjs and review the result.`);
  const read = (file, expected) => {
    const bytes = readFileSync(path.join(VENDORED, file));
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`scripts/licenses/sharp-libvips/${file} does not match its sha256 in manifest.json.`);
    return tidy(bytes.toString('utf8'));
  };
  const licensingFile = read(manifest.notices.file, manifest.notices.sha256);
  const licensing = tidy(licensingFile.replace(/^# Third-party notices\s*/, ''));
  const stated = name => {
    const match = licensing.split('\n').map(line => line.split('|').map(cell => cell.trim())).find(cells => cells[1] === name);
    if (!match) throw new Error(`sharp-libvips states no license for ${name}.`);
    return match[2].replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  };
  const notices = [];
  const components = manifest.components.map(component => ({
    ...component,
    texts: component.files.map(file => {
      const text = read(file.file, file.sha256);
      if (path.basename(file.file) === 'NOTICE') notices.push({ text: text.replace(/\s+/g, ' '), owner: `${component.name} ${component.version}, NOTICE` });
      return { source: path.basename(file.file), text };
    }),
  }));
  return { manifest, licensing, stated, components, notices };
}

/**
 * The Rust crates librsvg is built from and the Rust standard library, from scripts/licenses/sharp-libvips/
 * rsvg-crates.json and rsvg-crates/ (written by scripts/fetch-rsvg-crate-licenses.mjs). Refuses files whose sha256
 * changed and a list made for another librsvg version than the vendored libvips one.
 */
function vendoredRsvgCrates(libvips) {
  const list = readJson(path.join(VENDORED, 'rsvg-crates.json'));
  if (list.rsvg !== libvips.manifest.versions.rsvg)
    throw new Error(`scripts/licenses/sharp-libvips/rsvg-crates.json is for librsvg ${list.rsvg}, the libvips binaries contain ${libvips.manifest.versions.rsvg}: run node scripts/fetch-rsvg-crate-licenses.mjs and review the result.`);
  const read = ({ file, sha256 }) => {
    const bytes = readFileSync(path.join(VENDORED, file));
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`scripts/licenses/sharp-libvips/${file} does not match its sha256 in rsvg-crates.json.`);
    return { source: path.basename(file), text: tidy(bytes.toString('utf8')) };
  };
  return {
    ...list,
    crates: list.crates.map(item => ({ ...item, texts: item.files.map(read) })),
    rustStd: { ...list.rustStd, texts: list.rustStd.files.map(read) },
  };
}

/** Short names of the Rust targets, matching the platform packages of §3. */
const RUST_TARGETS = {
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-pc-windows-gnu': 'win32-x64',
};

/**
 * The renderer uses only the Material Design set of react-icons (§2.2 says so): refuse any other react-icons import
 * in src/, so that the note cannot go stale. Returns the imported sets ('/md').
 */
export function checkReactIconSets(root = path.join(client, 'src')) {
  const sets = new Set();
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) continue;
      for (const match of readFileSync(full, 'utf8').matchAll(/["'`]react-icons(\/[^"'`]*)?["'`]/g)) sets.add(match[1] ?? '');
    }
  };
  walk(root);
  const others = [...sets].filter(set => set !== '/md').sort();
  if (others.length) throw new Error(`${path.relative(client, root).replaceAll('\\', '/')}/ imports react-icons${others.map(set => set || ' (the package root)').join(', react-icons')}, not only react-icons/md: update the react-icons note in §2.2 of generate-notices.mjs (and its icon set's license).`);
  return [...sets];
}

const BUILD_TOOLS = [
  { name: 'vite', use: 'Module-preload and dynamic-import helpers in the renderer bundle (dist/assets).' },
  { name: 'rolldown', use: 'Module runtime helpers in the renderer bundle (Vite 8 bundles with Rolldown).' },
  { name: 'esbuild', use: 'CommonJS/ES module interop helpers in the MCP server bundle and the tag-module bundle.' },
];

const entries = (file, pattern) => (readFileSync(path.join(client, file), 'utf8').match(pattern) ?? []).length;
const DATA = () => [
  {
    item: `\`electron/data/tag-dictionary.ts\` — offline Chinese → Danbooru tag dictionary for prompt autocomplete (${entries('electron/data/tag-dictionary.ts', /\{ tag: "/g)} entries: English tag name, approximate post count, category, Chinese label and synonyms)`,
    source: 'Provided with the MIT-licensed source code of the upstream Langbai NovelAI Studio (https://github.com/2786886095/novelai-image-desktop); the English tag names and categories are Danbooru tags.',
  },
  {
    item: `\`src/related-tags.ts\` — related-tag suggestions (${entries('src/related-tags.ts', /\{ tag: "/g)} English tags with Chinese labels, grouped by anchor tag)`,
    source: 'Provided with the MIT-licensed source code of the upstream Langbai NovelAI Studio (https://github.com/2786886095/novelai-image-desktop), where it is described as curated Danbooru co-occurrence.',
  },
  {
    item: '`src/prompt-data.ts` — Chinese glosses for common Danbooru tags and tag categories',
    source: 'Provided with the MIT-licensed source code of the upstream Langbai NovelAI Studio (https://github.com/2786886095/novelai-image-desktop).',
  },
  {
    item: 'NovelAI quality tags, negative-prompt (UC) presets and model names in `electron/nai-payload.ts`, `src/prompt-normalize.ts` and `src/types.ts`',
    source: 'The texts NovelAI\'s own image generator adds to its requests, reproduced in the code so that requests match it; they have not been checked line by line against NovelAI here.',
  },
  {
    item: 'Optional Chinese tag dictionary DanbooruSearchOnline (`tags_enhanced.csv`)',
    source: '**Not included in the app or its installers.** `novelai/scripts/install-tag-dictionary.mjs` downloads a pinned copy into the data folder only when the user runs it: https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline (repository license GPL-3.0; third-party, partly machine-generated data).',
  },
];

function fence(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(match => match[0].length));
  const marker = '`'.repeat(longest + 1);
  return `${marker}text\n${text}\n${marker}`;
}

/** Collect every distinct license text once; each package refers to its texts by number (L1, L2 … or `prefix`1 …). */
function textRegistry(prefix = 'L') {
  const byHash = new Map();
  return {
    /** Links to the item's texts (registered in order of first use), each followed by its source file unless `plain`. */
    refs(item, owner = `${item.name} ${item.version}`, plain = false) {
      return item.texts.map(({ source, text }) => {
        const hash = createHash('sha256').update(text).digest('hex');
        if (!byHash.has(hash)) byHash.set(hash, { id: `${prefix}${byHash.size + 1}`, text, owners: [] });
        const entry = byHash.get(hash);
        if (!entry.owners.includes(owner)) entry.owners.push(owner);
        const link = `[${entry.id}](#${entry.id.toLowerCase()})`;
        return plain ? link : `${link} (${source})`;
      });
    },
    all: () => [...byHash.values()],
  };
}

const row = cells => `| ${cells.map(cell => String(cell).replaceAll('|', '\\|')).join(' | ')} |`;

function packageTable(items, registry) {
  const lines = [row(['Package', 'Version', 'License', 'Project', 'License text']), row(['---', '---', '---', '---', '---'])];
  for (const item of items) {
    const refs = registry.refs(item);
    if (!refs.length) throw new Error(`${item.name} ${item.version}: no license text found in the installed package.`);
    lines.push(row([item.name, item.version, item.license, item.url, refs.join(', ')]));
  }
  return lines.join('\n');
}

/** The notices document. Throws when a shipped package has no readable license text. */
export async function generateNotices() {
  const registry = textRegistry();
  const electron = installedPackage(path.join(client, 'node_modules', 'electron'));
  const { common, platform } = clientRuntimePackages();
  const renderer = dedupe((await rendererPackageDirectories()).map(directory => installedPackage(directory)));
  const bundles = await bundledPackages();
  const tools = BUILD_TOOLS.map(tool => ({ ...installedPackage(path.join(client, 'node_modules', tool.name)), use: tool.use }));
  const sharp = common.find(item => item.name === 'sharp');
  if (!sharp) throw new Error('sharp is not a runtime dependency any more: update the image library section of generate-notices.mjs.');
  const libvips = vendoredLibvips(platform);
  const rsvgCrates = vendoredRsvgCrates(libvips);
  checkReactIconSets();
  const gnu = name => tidy(readFileSync(path.join(client, 'scripts', 'licenses', name), 'utf8'));
  const lgpl = { texts: [{ source: 'LGPL-3.0', text: gnu('LGPL-3.0.txt') }, { source: 'GPL-3.0', text: gnu('GPL-3.0.txt') }] };

  const out = [];
  out.push(`# Third-party notices

MCP for NovelAI is licensed under the MIT License (see \`LICENSE\`). The application, its installers and its MCP server
bundle also contain the third-party software and data listed below, each under its own license; the MIT License of
this project does not relicense them.

This file is generated by \`novelai/client/scripts/generate-notices.mjs\` from the lockfile and the installed packages
(\`npm --prefix novelai/client run notices\`); do not edit it by hand. License texts are reproduced from each package's
own license files at the end of this file (§7); identical texts are printed once.

1. Electron (application runtime)
2. Client runtime dependencies (\`app.asar/node_modules\` and the renderer bundle \`dist/assets\`)
3. Image processing binaries (sharp and libvips, platform-specific)
4. MCP server bundle (\`resources/mcp/novelai-mcp.mjs\`)
5. Build tool runtime code
6. Data
7. License texts`);

  out.push(`## 1. Electron

${row(['Component', 'Version', 'License', 'Project', 'License text'])}
${row(['---', '---', '---', '---', '---'])}
${row([electron.name, electron.version, electron.license, 'https://github.com/electron/electron', registry.refs(electron).join(', ')])}

Electron contains Chromium, Node.js, V8 and further open-source components under their own licenses, among them
FFmpeg under the GNU LGPL. Their notices are in \`LICENSES.chromium.html\`, which ships with the app: on Windows and
Linux in the installation folder (next to \`LICENSE.electron.txt\`), on macOS in
\`MCP for NovelAI.app/Contents/Resources\`. The app uses Electron's own binaries unmodified; their source code is that
of Electron v${electron.version} (https://github.com/electron/electron/tree/v${electron.version} and the Chromium and other
sources its \`DEPS\` file names). It is not attached to this project's releases.`);

  out.push(`## 2. Client runtime dependencies

Every installer contains the client's third-party code in two places, listed in §2.1 and §2.2 (a package in both is
listed in both).

### 2.1 Main process (\`app.asar/node_modules\`)

The runtime dependencies of the main process (from \`novelai/client/package-lock.json\`, the packages its
dependencies require); electron-builder copies them into \`app.asar/node_modules\`. ${common.length} packages:

${packageTable(common, registry)}

Notes:
- jszip is dual-licensed (MIT OR GPL-3.0-or-later); this application uses it under the MIT License.

### 2.2 Renderer bundle (\`dist/assets\`)

The user interface is bundled by Vite into \`dist/assets\` inside \`app.asar\`. Its third-party code comes from these
packages, found by bundling the renderer entry \`src/main.tsx\` and counting a package only when some of its code
reaches the output. A package only the bundle needs is a development dependency of the client, so electron-builder
does not copy it into \`app.asar/node_modules\`; one the main process needs as well is also in §2.1. ${renderer.length} packages:

${packageTable(renderer, registry)}

Notes:
- Of react-icons the renderer uses only the Material Design icons (\`react-icons/md\`), which are Google's Material
  Design icons under the Apache License 2.0; react-icons' own LICENSE lists the licenses of its icon sets.`);

  // Registered here, after sections 1 and 2, so that the text numbers follow the order of the document.
  const sharpApache = registry.refs(sharp, `${sharp.name} ${sharp.version} and its @img/sharp-<platform> packages`, true);
  const libvipsRefs = registry.refs(lgpl, `libvips ${libvips.manifest.versions.vips} and the LGPL libraries built with it`, true);
  const platformRows = platform.map(item => row([item.name, item.version, item.license, [item.os?.join('/'), item.cpu?.join('/')].filter(Boolean).join(' ') || 'only as a dependency of a WebAssembly variant']));
  const libvipsRegistry = textRegistry('V');
  const componentRows = libvips.components.map(component => row([component.name, component.version, libvips.stated(component.name), component.source,
    libvipsRegistry.refs({ texts: component.texts }, `${component.name} ${component.version}`).join(', ')]));
  // The Rust code in librsvg (§3.3, §3.4): crate texts in their own registry; crates without a license file get
  // the standard text of their declared license (MIT from scripts/licenses/MIT.txt, MPL-2.0 as vendored for cairo
  // in §3.2, Apache-2.0 as in sharp's LICENSE in §7).
  const rustRegistry = textRegistry('R');
  const mitText = { source: 'MIT', text: tidy(readFileSync(path.join(client, 'scripts', 'licenses', 'MIT.txt'), 'utf8')) };
  const mplText = libvips.components.find(component => component.key === 'cairo')?.texts.find(text => text.source === 'MPL-2.0.txt');
  const apacheText = sharp.texts.find(text => /^Apache License\s+Version 2\.0, January 2004/.test(text.text));
  if (!mplText || !apacheText) throw new Error('The MPL-2.0 text (cairo/MPL-2.0.txt) or the Apache-2.0 text (sharp\'s LICENSE) is missing.');
  const standardTexts = (item, owner) => {
    const license = item.license.replace(/\//g, ' OR ');
    if (license === 'MIT') return rustRegistry.refs({ texts: [mitText] }, owner, true).map(ref => `${ref} (MIT, standard text)`);
    if (license === 'MPL-2.0') return libvipsRegistry.refs({ texts: [mplText] }, owner, true).map(ref => `${ref} (MPL-2.0, in §3.2)`);
    if (license === 'MIT OR Apache-2.0') return [...rustRegistry.refs({ texts: [mitText] }, owner, true).map(ref => `${ref} (MIT, standard text)`),
      ...registry.refs({ texts: [apacheText] }, owner, true).map(ref => `${ref} (Apache-2.0, in §7)`)];
    throw new Error(`${item.name} ${item.version} ships no license file and its declared license ${item.license} has no standard text here: add one to generate-notices.mjs.`);
  };
  const targetNames = targets => targets.length === rsvgCrates.targets.length ? 'all' : targets.map(target => RUST_TARGETS[target] ?? target).join(', ');
  const withoutFiles = [];
  const crateRows = rsvgCrates.crates.map(item => {
    const owner = `${item.name} ${item.version}`;
    let refs = rustRegistry.refs(item, owner);
    if (!refs.length) {
      refs = standardTexts(item, `${owner} (ships no license file)`);
      withoutFiles.push(item);
    }
    return row([item.name, item.version, item.license, targetNames(item.targets), item.source, refs.join(', ')]);
  });
  const std = rsvgCrates.rustStd;
  const stdRow = row(['Rust standard library', `${std.version} (commit ${std.commit})`, 'MIT OR Apache-2.0 (as stated in its COPYRIGHT)', 'all', std.source,
    rustRegistry.refs(std, `Rust standard library ${std.version} (${std.commit})`).join(', ')]);
  const mplCrates = rsvgCrates.crates.filter(item => /\bMPL-2\.0\b/.test(item.license));
  const licenseCounts = Object.entries(rsvgCrates.crates.reduce((counts, item) => ({ ...counts, [item.license]: (counts[item.license] ?? 0) + 1 }), {}))
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([license, count]) => `${license} ${count}`);
  const windowsDifferences = Object.entries(libvips.manifest.windows.differences).map(([key, version]) => `${key} ${version} instead of ${libvips.manifest.versions[key]}`);
  out.push(`## 3. Image processing binaries (sharp and libvips)

sharp ${sharp.version} (Apache-2.0, https://github.com/lovell/sharp) loads prebuilt native binaries from platform
packages; npm installs the ones matching the operating system and CPU it installs for. The installers this project
builds contain: Windows x64 (NSIS installer) \`@img/sharp-win32-x64\`, which carries libvips itself; Linux x64
(tar.gz) \`@img/sharp-linux-x64\` with \`@img/sharp-libvips-linux-x64\`; macOS, one installer per architecture (dmg
and zip), the darwin pair of its architecture: \`@img/sharp-darwin-arm64\` with \`@img/sharp-libvips-darwin-arm64\` in
the arm64 installer (Apple silicon) and \`@img/sharp-darwin-x64\` with \`@img/sharp-libvips-darwin-x64\` in the x64
installer (Intel). The lockfile names these variants (and what only they require):

${row(['Package', 'Version', 'License', 'Platform'])}
${row(['---', '---', '---', '---'])}
${platformRows.join('\n')}

The \`@img/sharp-<platform>\` packages contain sharp's compiled addon under the same Apache-2.0 license as sharp
(${sharpApache.join(', ')}; their own LICENSE files are identical). The \`@img/sharp-libvips-<platform>\` packages (and the libvips part of the Windows and
WebAssembly packages) contain libvips ${libvips.manifest.versions.vips} and the libraries listed in §3.1, built by the sharp-libvips
project ${libvips.manifest.sharpLibvips}. libvips and several of those libraries are licensed under the GNU Lesser General
Public License version 3 or later (LGPL-3.0-or-later); its text and the GNU GPL it incorporates are in
${libvipsRefs.join(' and ')} (from https://www.gnu.org/licenses/). In the native packages libvips is a separate shared
library (\`lib/libvips-*\`) that sharp loads at run time.

Source code: libvips ${libvips.manifest.versions.vips} at https://github.com/libvips/libvips/tree/v${libvips.manifest.versions.vips}; the build scripts and
the exact library versions of these binaries at ${libvips.manifest.release}
(releases: https://github.com/lovell/sharp-libvips/releases/tag/v${libvips.manifest.sharpLibvips}); sharp at
https://github.com/lovell/sharp/tree/v${sharp.version}. The source archive of every library is linked in §3.1.

Every release of this project (https://github.com/lwyq1209/mcp-for-novelai/releases) provides this source code with
its installers, as \`third-party-sources-<version>.tar.gz\`: the source archive of every library in §3.1 (each checked
against the license files reproduced in §3.2), the build scripts of sharp-libvips ${libvips.manifest.sharpLibvips} and of
${libvips.manifest.windows.builtBy.replace(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/(.+)$/, '$1 $2')}, and the MPL-2.0 Rust crates of §3.3, with a list of
the archives, their upstream URLs and sha256.

### 3.1 Libraries in the libvips binaries

Versions as built by sharp-libvips ${libvips.manifest.sharpLibvips} (\`versions.properties\`). The Windows libvips in
\`${libvips.manifest.windows.package}\` comes from ${libvips.manifest.windows.builtBy}${windowsDifferences.length ? ` and differs in: ${windowsDifferences.join(', ')} (same license files)` : ''}.
"License" is the license sharp-libvips states for each library; the license files of each library's source archive
are reproduced in §3.2.

${row(['Library', 'Version', 'License (as stated by sharp-libvips)', 'Source archive', 'License files'])}
${row(['---', '---', '---', '---', '---'])}
${componentRows.join('\n')}

Notes:
- cairo's own files offer it under LGPL-2.1 or MPL-1.1 (\`COPYING\`); sharp-libvips states MPL-2.0. Both cairo files
  and the MPL-2.0 text (https://www.mozilla.org/media/MPL/2.0/index.txt) are reproduced.
- libnsgif is compiled into libvips from libvips' own source tree (\`libvips/foreign/libnsgif\`).
- FreeType is built with its default modules, which include the BDF and PCF font drivers. As FreeType's
  \`LICENSE.TXT\` says, these drivers (\`src/bdf\`, \`src/pcf\`) and its hash functions (\`src/base/fthash.c\`,
  \`include/freetype/internal/fthash.h\`) are under their own X11-style license; their license texts (the drivers'
  READMEs and the license comment of \`fthash.c\`) are reproduced in §3.2.
- librsvg is written in Rust: the Rust crates it is built from and the Rust standard library are compiled into the
  libvips binaries too. They are listed in §3.3.
- The Windows libvips (\`@img/sharp-win32-x64\`, built by build-win64-mxe with an LLVM-based MinGW toolchain) also contains
  code of LLVM's C++ runtime libraries libc++ and libc++abi 22.1.7 (https://github.com/llvm/llvm-project/tree/llvmorg-22.1.7),
  under the Apache License 2.0 with LLVM Exceptions (Apache-2.0 WITH LLVM-exception). It is embedded in the binary
  by compiling, which that exception exempts from the license's notice and attribution conditions.

Acknowledgements these licenses require:
- This software is based in part on the work of the Independent JPEG Group. (mozjpeg, IJG License)
- Portions of this software are copyright © ${libvips.manifest.freetypeYear} The FreeType Project (https://freetype.org). All rights reserved. (FreeType ${libvips.manifest.versions.freetype}, FreeType License)
${libvips.notices.map(notice => `- ${notice.text} (${notice.owner})`).join('\n')}

Licensing of the bundled libraries, as stated by sharp-libvips (its \`THIRD-PARTY-NOTICES.md\` of v${libvips.manifest.sharpLibvips}):

${libvips.licensing}

### 3.2 License files of these libraries

Each file as it is in the library's source archive (sha256 in \`scripts/licenses/sharp-libvips/manifest.json\`);
identical files are printed once.

${libvipsRegistry.all().map(entry => `#### ${entry.id}\n\nUsed by: ${entry.owners.join(', ')}\n\n${fence(entry.text)}`).join('\n\n')}

### 3.3 Rust code in librsvg

librsvg ${rsvgCrates.rsvg} is written in Rust. The libvips binaries link it statically, so the Rust crates it is built from
and the Rust standard library are compiled into them, besides librsvg's own crates (librsvg and librsvg-c, under
librsvg's \`COPYING.LIB\` in §3.1). The crates are those sharp-libvips' build (${rsvgCrates.posixSh}) links: the
librsvg tarball (${rsvgCrates.tarball}) with the Cargo.toml edits of that script and its regenerated lockfile, the
\`${rsvgCrates.package}\` package with its default features, normal dependencies only (no build scripts, build tools or proc
macros, which run only while building). "Targets" names the binaries a crate is in: linux-x64, darwin-arm64, darwin-x64
and win32-x64 (Rust targets ${rsvgCrates.targets.join(', ')}), "all" for every one. The Windows libvips is built by
build-win64-mxe (${libvips.manifest.windows.builtBy}), whose crate set may differ slightly from this list, which is
computed from sharp-libvips' build.

"License" is the license each crate declares in its Cargo.toml; the license files of each crate's package (crates.io)
are reproduced in §3.4. ${rsvgCrates.crates.length} crates (${licenseCounts.join(', ')}):

${row(['Crate', 'Version', 'License (declared)', 'Targets', 'Source', 'License files'])}
${row(['---', '---', '---', '---', '---', '---'])}
${crateRows.join('\n')}
${stdRow}

Notes:
${withoutFiles.length ? `- These crates ship no license file: ${withoutFiles.map(item => `${item.name} ${item.version} (${item.license}; authors: ${item.authors.join(', ') || 'none listed'})`).join('; ')}.
  Their copyright holders are the authors listed in their Cargo.toml. In place of a license file the table links the
  standard text of the declared license: for MIT the SPDX MIT License text without a copyright line (the copyright
  is that of the crate's listed authors), for MPL-2.0 the text in §3.2, for Apache-2.0 the text in §7.\n` : ''}${mplCrates.length ? `- ${mplCrates.map(item => `${item.name} ${item.version}`).join(', ')} ${mplCrates.length === 1 ? 'is' : 'are'} under the Mozilla Public License 2.0; ${mplCrates.length === 1 ? 'its' : 'their'} source code is
  available at the crates.io source link given in the table.\n` : ''}- The Rust standard library is that of the Rust toolchain the binaries were compiled with (commit ${std.commit},
  \`src/version\` ${std.version}); its \`COPYRIGHT\`, \`LICENSE-MIT\` and \`LICENSE-APACHE\` at that commit are reproduced.
  The standard library is itself built from further crates; they are listed in \`library/Cargo.lock\` at that commit
  (https://github.com/rust-lang/rust/blob/${std.commit}/library/Cargo.lock) and, as its \`COPYRIGHT\` says, in the
  \`COPYRIGHT-library.html\` of that toolchain; their license texts are not reproduced here.

### 3.4 License files of the Rust crates

Each file as it is in the crate's package (sha256 in \`scripts/licenses/sharp-libvips/rsvg-crates.json\`); identical
files are printed once.

${rustRegistry.all().map(entry => `#### ${entry.id}\n\nUsed by: ${entry.owners.join(', ')}\n\n${fence(entry.text)}`).join('\n\n')}`);

  out.push(`## 4. MCP server bundle

\`resources/mcp/novelai-mcp.mjs\` is a single file built with esbuild from \`novelai/src/mcp.mjs\`. Besides this
project's own code it contains the following packages (from the esbuild metafile); the file carries no license
texts of its own, so this section is its notice. ${bundles.mcp.length} packages:

${packageTable(bundles.mcp, registry)}

The tag-module bundle \`dist-electron/vendor/tag-details.cjs\` (built from \`novelai/src/tag-details.mjs\`) contains
${bundles.tagDetails.length ? `these packages:\n\n${packageTable(bundles.tagDetails, registry)}` : 'only this project\'s own code.'}`);

  out.push(`## 5. Build tool runtime code

The bundlers add small runtime helpers of their own to the code they emit:

${row(['Tool', 'Version', 'License', 'Project', 'Use', 'License text'])}
${row(['---', '---', '---', '---', '---', '---'])}
${tools.map(tool => row([tool.name, tool.version, tool.license, tool.url, tool.use, registry.refs(tool).join(', ')])).join('\n')}`);

  out.push(`## 6. Data

Data compiled into the app, and where it comes from as far as known. The upstream project is Langbai NovelAI Studio
(https://github.com/2786886095/novelai-image-desktop, MIT, Copyright (c) 2026 Langbai).

${DATA().map(entry => `- ${entry.item}.\n  Source: ${entry.source}`).join('\n')}

Tag names, categories and post counts of Danbooru (https://danbooru.donmai.us) are facts looked up there; the app
queries Danbooru at run time for current values and does not ship Danbooru's database.`);

  const texts = registry.all();
  out.push(`## 7. License texts

${texts.map(entry => `### ${entry.id}\n\nUsed by: ${entry.owners.join(', ')}\n\n${fence(entry.text)}`).join('\n\n')}`);
  return `${out.join('\n\n')}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const next = await generateNotices();
  if (check) {
    const current = existsSync(NOTICES_FILE) ? lf(readFileSync(NOTICES_FILE, 'utf8')) : '';
    if (current !== next) {
      console.error('THIRD_PARTY_NOTICES.md is out of date: run npm --prefix novelai/client run notices and commit the result.');
      process.exit(1);
    }
    console.log('THIRD_PARTY_NOTICES.md is up to date.');
    return;
  }
  writeFileSync(NOTICES_FILE, next);
  console.log(`Wrote ${path.relative(process.cwd(), NOTICES_FILE) || NOTICES_FILE} (${Buffer.byteLength(next)} bytes).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
