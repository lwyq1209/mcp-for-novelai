import { open, realpath, lstat, mkdir, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridgeClient } from './bridge-client.mjs';
import { openNoFollow } from './platform-fs.mjs';
import { projectDirectories, resolveProjectRoot } from './data-paths.mjs';
import { ContractValidationError, validateMaterialRequest } from '../contracts/validate.mjs';

// <project root>/novelai/library-{inbox,exports}; the project root is NOVELAI_PROJECT_ROOT, else <data root>/workspace.
const PROJECT_DIRECTORIES = projectDirectories(resolveProjectRoot().root);
export const MATERIAL_INBOX = PROJECT_DIRECTORIES.materialInbox + sep;
export const MATERIAL_EXPORTS = PROJECT_DIRECTORIES.materialExports + sep;
const sampleActions = new Set(['samples', 'sample_image', 'set_cover', 'set_local_cover', 'cover', 'clear_cover']);
const actions = new Set(['list', 'read', 'save', 'archive', 'export', 'import', 'search_tags', 'tag_details', ...sampleActions]);
const filename = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,118}\.json$/.test(value);
/** A Danbooru cover of a material backup must carry its rating. The schema alone would only say that the import does
 * not match (a union of request shapes), so name the cover and what is missing. */
function checkBackupCovers(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.covers)) return;
  data.covers.forEach((item, index) => {
    const cover = item && typeof item === 'object' ? item.cover : undefined;
    if (cover && typeof cover === 'object' && !Array.isArray(cover) && cover.source !== 'local' && !Object.hasOwn(cover, 'rating'))
      throw new ContractValidationError(`arguments/data/covers/${index}/cover is a Danbooru cover without its rating (g, s, q or e); this version imports only covers that carry their rating. Nothing was imported.`);
  });
}

async function readInput(file, directory, limit = 1024 * 1024) {
  if (!filename(file)) throw new Error('Use a direct JSON filename in novelai/library-inbox.');
  const base = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Library inbox cannot be a symlink.');
  const target = resolve(base, file);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Library input exceeds the supported file limit.');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Use an object with entry for save or data for import.');
    return value;
  } finally { await handle.close(); }
}

const LOCAL_COVER_LIMIT = 20 * 1024 * 1024;
const localCoverFilename = value => typeof value === 'string' && value.length <= 255 && value.trim() === value
  && !/[^\S ]|[\p{Cc}\p{Cf}\\/:*?"<>|]/u.test(value) && !value.startsWith('.')
  && /\.(png|jpe?g|webp|gif)$/i.test(value);

function checkCoverSignal(signal) {
  // Do not echo arbitrary caller-provided abort reasons (which may contain paths).
  if (signal?.aborted) throw Object.assign(new Error('Local cover operation aborted; if already sent, read the entry before any further save.'), { name: 'AbortError' });
}

async function readLocalCover(file, directory, signal) {
  let handle;
  try {
    checkCoverSignal(signal);
    // Strip a lexical trailing slash before lstat: on POSIX, symlink/ follows
    // that directory symlink. Do not realpath first and erase its identity.
    const inputDirectory = resolve(directory);
    const directoryStat = await lstat(inputDirectory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('inbox');
    const base = await realpath(inputDirectory);
    checkCoverSignal(signal);
    // Fail closed on POSIX platforms lacking these protections. NONBLOCK
    // prevents a substituted FIFO from hanging before fstat can reject it.
    // win32 has neither flag; openNoFollow refuses links and non-regular files.
    if (process.platform !== 'win32' && (!constants.O_NOFOLLOW || !constants.O_NONBLOCK)) throw new Error('flags');
    handle = await openNoFollow(resolve(base, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    checkCoverSignal(signal);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > LOCAL_COVER_LIMIT) throw new Error('size/type');
    // The stat is only an early rejection, not a read bound: files may grow.
    // At most limit+1 bytes are read, including the overflow sentinel.
    const chunks = []; let total = 0;
    while (total <= LOCAL_COVER_LIMIT) {
      checkCoverSignal(signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, LOCAL_COVER_LIMIT + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      checkCoverSignal(signal);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > LOCAL_COVER_LIMIT) throw new Error('size');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (!total) throw new Error('empty');
    return Buffer.concat(chunks, total).toString('base64');
  } catch {
    checkCoverSignal(signal);
    // Filesystem errors include absolute paths; never expose them through MCP.
    throw new Error('Cannot read local cover: use a nonempty regular PNG/JPEG/WebP/GIF file of at most 20 MiB directly in novelai/library-inbox; no symlinks.');
  } finally {
    if (handle) await handle.close().catch(() => { throw new Error('Cannot close local cover input.'); });
  }
}

export async function materialToolAction(args, { bridge = createBridgeClient(), inbox = MATERIAL_INBOX, exportsDirectory = MATERIAL_EXPORTS, signal } = {}) {
  if (!args || !actions.has(args.action)) throw new Error('Choose a material library action.');
  const { action, file, ...fields } = args;
  let payload = fields;
  if (action === 'set_local_cover') {
    if (Object.keys(args).some(key => !['action', 'entryId', 'revision', 'expectedCoverRevision', 'file'].includes(key))) {
      throw new Error('set_local_cover accepts only entryId, revision, expectedCoverRevision and file; no raw data, fileName, paths or URLs.');
    }
    if (!localCoverFilename(file)) throw new Error('Use a direct PNG/JPEG/WebP/GIF filename in novelai/library-inbox, with internal spaces allowed, but no surrounding whitespace, control characters or path separators.');
    // Match existing host identity rules before touching the inbox; the real
    // contract validates required fields too. Placeholder data is never sent.
    if (typeof fields.entryId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(fields.entryId)
      || !Number.isSafeInteger(fields.revision) || fields.revision < 1
      || !Number.isSafeInteger(fields.expectedCoverRevision) || fields.expectedCoverRevision < 0) {
      throw new Error('Use the exact entryId, revision and coverRevision from list/read.');
    }
    validateMaterialRequest('material_samples', { ...fields, action, fileName: file, data: 'AA==' });
    payload = { ...fields, fileName: file, data: await readLocalCover(file, inbox, signal) };
  } else if (file !== undefined) {
    if (!['save', 'import'].includes(action) || Object.keys(fields).length) throw new Error('Use file alone with save/import; put the full entry or import data in that file.');
    payload = await readInput(file, inbox, action === 'import' ? 64 * 1024 * 1024 : 1024 * 1024);
    if ('action' in payload || 'file' in payload) throw new Error('The file cannot change the requested action.');
    if (action === 'import' && payload.schemaVersion === 1 && Array.isArray(payload.entries)) payload = { data: payload };
  }
  const method = ['search_tags', 'tag_details'].includes(action) ? 'material_tags' : sampleActions.has(action) ? 'material_samples' : 'material_library';
  const mapped = { search_tags: 'search', tag_details: 'details', samples: 'list', sample_image: 'image' }[action] ?? action;
  if (mapped === 'import') checkBackupCovers(payload.data);
  const request = validateMaterialRequest(method, { ...payload, action: mapped });
  if (action === 'set_local_cover') checkCoverSignal(signal);
  const result = await bridge.call(method, request, signal);
  if (action === 'export') {
    await mkdir(exportsDirectory, { recursive: true, mode: 0o700 });
    if ((await lstat(exportsDirectory)).isSymbolicLink()) throw new Error('Library exports cannot be a symlink.');
    const output = resolve(await realpath(exportsDirectory), `${randomUUID()}.json`), temp = `${output}.tmp`;
    await writeFile(temp, JSON.stringify(result?.data ?? result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, output);
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    return { file: output, exported: true, ...(warnings.length ? {
      complete: false, warningCount: warnings.length, warnings: warnings.slice(0, 8),
      instruction: 'Some local covers were not exported. The metadata backup was saved; inspect the affected entries before treating it as a complete image backup.',
    } : {}) };
  }
  if (action === 'save' || action === 'archive') {
    const entry = result?.entry ?? result;
    return { id: entry.id, revision: entry.revision, kind: entry.kind, name: entry.name, archived: entry.archived,
      ...(entry.tag ? { tag: { text: entry.tag.text, source: entry.tag.source, target: entry.tag.target, category: entry.tag.category,
        verification: entry.tag.evidence?.resolution ?? 'unknown' } } : {}), generationSubmitted: false };
  }
  return result;
}

export function materialToolResponse(value) {
  if (value?.data && typeof value.data === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(value.mimeType ?? '')) {
    const { data, ...metadata } = value;
    return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data, mimeType: value.mimeType }], details: metadata };
  }
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value };
}
