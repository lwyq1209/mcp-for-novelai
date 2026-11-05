#!/usr/bin/env node
// Explicit optional data installation; never runs third-party source code.
// Installs into <data root>/runtime/tag-dictionary, where the client reads it; the data root is
// NOVELAI_DATA_DIR or <appData>/mcp-for-novelai (src/data-paths.mjs). Needs a built client.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolveDataPaths } from '../src/data-paths.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { TAG_DICTIONARY, parseTagDictionary } = require(resolve(root, 'client/dist-electron/electron/search-tag-dictionary.js'));
const directory = resolveDataPaths().tagDictionary;
await mkdir(directory, { recursive: true, mode: 0o700 });
const target = resolve(directory, 'tags_enhanced.csv');
let bytes;
try { bytes = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!bytes || createHash('sha256').update(bytes).digest('hex') !== TAG_DICTIONARY.sha256) {
  const response = await fetch(TAG_DICTIONARY.url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Dictionary download failed: HTTP ${response.status}`);
  const reader = response.body.getReader(); const parts = []; let count = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; count += value.length; if (count > TAG_DICTIONARY.bytes) { await reader.cancel(); throw new Error('Dictionary is larger than the pinned source.'); } parts.push(value); } }
  finally { reader.releaseLock(); }
  bytes = Buffer.concat(parts);
}
if (bytes.length !== TAG_DICTIONARY.bytes || createHash('sha256').update(bytes).digest('hex') !== TAG_DICTIONARY.sha256) throw new Error('Dictionary checksum mismatch. Existing installation preserved.');
const entries = parseTagDictionary(bytes);
if (entries.length < 40000) throw new Error('Dictionary validation failed. Existing installation preserved.');
await writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
await rename(`${target}.tmp`, target);
const report = { ...TAG_DICTIONARY, installedAt: new Date().toISOString(), indexedEntries: entries.length, englishOutput: true, translationsAreThirdParty: true };
await writeFile(resolve(directory, 'source.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ installed: true, ...report }));
