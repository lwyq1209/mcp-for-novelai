/**
 * The local files of `nai`: JSON inputs (a file, or stdin with "-"), JSON outputs (recipe drafts, prepare receipts),
 * the images tools return, and local files copied into an inbox for the tools that read inbox names. nai runs with the
 * caller's own rights, so it writes where it is told like any command-line tool: missing parent folders are created,
 * an existing file is replaced, links are followed. A file is written next to its target and renamed over it, so it is
 * never left half written. Images get the extension of their type.
 */
import { randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readlink, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Largest JSON input (a recipe, an entry, a backup, tool arguments). */
export const JSON_INPUT_LIMIT = 16 * 1024 * 1024;
export const IMAGE_EXTENSIONS = Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' });

export class CliFileError extends Error {
  constructor(code, message, exit = 'usage') { super(message); this.name = 'CliFileError'; this.code = code; this.exit = exit; }
}

/** A file name in a message: in quotes, as it was given. Not JSON.stringify: that doubles the backslashes of a Windows
 * path (and the envelope's own JSON encoding doubles them again). */
export const shown = file => `"${file}"`;

/** All bytes of a stream, at most `limit` (else input_too_large). */
async function readStream(stream, limit, describe) {
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw new CliFileError('input_too_large', `${describe} is larger than ${limit / 1024 / 1024} MiB. Nothing was sent.`);
      chunks.push(chunk);
    }
  } finally { stream.destroy?.(); }
  return Buffer.concat(chunks);
}

async function readBounded(source, label, cwd) {
  if (source === '-') return (await readStream(process.stdin, JSON_INPUT_LIMIT, `${label} from stdin`)).toString('utf8');
  const file = path.resolve(cwd, source);
  // A pipe, a process substitution <(…) or /dev/stdin is read as a stream; only a folder is refused.
  const kind = await stat(file).catch(error => { throw new CliFileError('file_unavailable', `${label} ${shown(source)} cannot be read (${error?.code ?? 'error'}). Nothing was sent.`); });
  if (kind.isDirectory()) throw new CliFileError('file_unavailable', `${label} ${shown(source)} is a folder. Nothing was sent.`);
  if (!kind.isFile()) {
    try { return (await readStream(createReadStream(file), JSON_INPUT_LIMIT, `${label} ${shown(source)}`)).toString('utf8'); }
    catch (error) { if (error instanceof CliFileError) throw error; throw new CliFileError('file_unavailable', `${label} ${shown(source)} cannot be read (${error?.code ?? 'error'}). Nothing was sent.`); }
  }
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY);
    const info = await handle.stat();
    if (!info.isFile()) throw new CliFileError('file_unavailable', `${label} ${shown(source)} is not a regular file. Nothing was sent.`);
    if (info.size > JSON_INPUT_LIMIT) throw new CliFileError('input_too_large', `${label} ${shown(source)} is larger than ${JSON_INPUT_LIMIT / 1024 / 1024} MiB. Nothing was sent.`);
    const buffer = Buffer.alloc(JSON_INPUT_LIMIT + 1); let length = 0;
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > JSON_INPUT_LIMIT) throw new CliFileError('input_too_large', `${label} ${shown(source)} is larger than ${JSON_INPUT_LIMIT / 1024 / 1024} MiB. Nothing was sent.`);
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error instanceof CliFileError) throw error;
    throw new CliFileError('file_unavailable', `${label} ${shown(source)} cannot be read (${error?.code ?? 'error'}). Nothing was sent.`);
  } finally { await handle?.close().catch(() => undefined); }
}

/** Where a JSON parse failed, from the engine's message: "line L, column C" or "position N"; never the content itself. */
function jsonErrorPlace(error, text) {
  const message = String(error?.message ?? '');
  const lineColumn = /\(line (\d+) column (\d+)\)/.exec(message);
  if (lineColumn) return ` at line ${lineColumn[1]}, column ${lineColumn[2]}`;
  const position = /at position (\d+)/.exec(message);
  if (position) return ` at position ${position[1]}`;
  if (/Unexpected end of JSON input/.test(message) || !text.trim()) return ' (it ends too early)';
  return '';
}
const parseJson = (text, label) => {
  const clean = text.replace(/^\uFEFF/, '');
  try { return JSON.parse(clean); }
  catch (error) { throw new CliFileError('invalid_json', `${label} is not valid JSON${jsonErrorPlace(error, clean)}. Nothing was sent.`); }
};

/** A JSON value from a file path (relative to `cwd`) or "-" (stdin). */
export async function readJsonFile(source, { label = 'The file', cwd = process.cwd() } = {}) {
  return parseJson(await readBounded(source, label, cwd), source === '-' ? `${label} (stdin)` : `${label} ${shown(source)}`);
}

/** A JSON value written on the command line: inline JSON, @file (relative to `cwd`) or - (stdin). */
export async function readJsonArgument(value, label, cwd = process.cwd()) {
  if (value === '-') return readJsonFile('-', { label, cwd });
  if (value.startsWith('@')) {
    if (value.length === 1) throw new CliFileError('usage', `${label}: name a file after @.`);
    return readJsonFile(value.slice(1), { label, cwd });
  }
  if (value.length > JSON_INPUT_LIMIT) throw new CliFileError('input_too_large', `${label} is larger than ${JSON_INPUT_LIMIT / 1024 / 1024} MiB. Nothing was sent.`);
  return parseJson(value, label);
}

/**
 * Writes `data` to `file` (relative to the working directory the caller resolved): its folder is created when
 * missing, an existing file is replaced, a link is followed to the file it names. The bytes go into a temporary file
 * beside the target first and are renamed over it, so the target holds either the old or the new content.
 */
export async function writeOutputFile(file, data, { mode = 0o644, display = file } = {}) {
  let target = path.resolve(file);
  try {
    // Follow a link (also a chain) to the file it names; a dangling or missing target is written where it points.
    for (let hops = 0; hops < 40; hops++) {
      const info = await lstat(target).catch(() => null);
      if (!info?.isSymbolicLink()) break;
      target = path.resolve(path.dirname(target), await readlink(target));
    }
    if ((await stat(target).catch(() => null))?.isDirectory()) throw new CliFileError('output_unavailable', `The output ${shown(display)} is a folder.`, 'output');
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, data, { mode });
    try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    return path.resolve(file);
  } catch (error) {
    if (error instanceof CliFileError) throw error;
    throw new CliFileError('output_unavailable', `The output ${shown(display)} cannot be written (${error?.code ?? 'error'}).`, 'output');
  }
}

/** JSON text as nai writes it into files: indented, with a final newline. */
export const jsonFileText = value => `${JSON.stringify(value, null, 2)}\n`;

/** The image folder, created with every missing parent. */
export async function ensureImageDirectory(directory) {
  try { await mkdir(directory, { recursive: true }); }
  catch (error) { throw new CliFileError('output_unavailable', `The image folder ${shown(directory)} cannot be created (${error?.code ?? 'error'}).`, 'output'); }
  if (!(await stat(directory).catch(() => null))?.isDirectory()) throw new CliFileError('output_unavailable', `The image folder ${shown(directory)} is not a folder.`, 'output');
  return directory;
}

const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const safeLabel = label => String(label).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';

/**
 * Writes image blocks ({mimeType, data} base64) to files: with `out`, there (several images: <stem>-<n><ext>; the
 * extension follows the image type), else <directory>/<label>-<time>-<random>[-<n>]<ext>. Returns [{file, mimeType,
 * bytes}] in block order, with absolute paths.
 */
export async function saveImages(blocks, { directory, out = null, label = 'image' } = {}) {
  if (!blocks.length) return [];
  const saved = [];
  // --out naming a folder (one that exists, or a path ending in a separator): the images go into it, named as usual.
  if (out && (/[\\/]$/.test(out) || (await stat(out).catch(() => null))?.isDirectory())) { directory = out; out = null; }
  if (!out) await ensureImageDirectory(directory);
  const run = `${stamp()}-${randomBytes(3).toString('hex')}`;
  for (const [index, block] of blocks.entries()) {
    const extension = IMAGE_EXTENSIONS[block.mimeType];
    if (!extension) throw new CliFileError('invalid_image', `An image of type ${shown(block.mimeType)} cannot be saved.`, 'output');
    const bytes = Buffer.from(block.data, 'base64');
    const suffix = blocks.length > 1 ? `-${index + 1}` : '';
    const file = out ? (({ dir, name }) => path.join(dir, `${name}${suffix}${extension}`))(path.parse(path.resolve(out))) : path.join(directory, `${safeLabel(label)}-${run}${suffix}${extension}`);
    await writeOutputFile(file, bytes, { display: file });
    saved.push({ file, mimeType: block.mimeType, bytes: bytes.length });
  }
  return saved;
}

/** Largest file copied into an inbox from a pipe (a material backup may be up to 64 MiB). */
const STAGE_STREAM_LIMIT = 64 * 1024 * 1024;

/**
 * Puts a local file into an inbox for a tool that reads inbox names, and returns the name to pass: {name,
 * copiedFrom?, reused?}. A file that exists here (relative to `cwd`, a bare name too) is the one meant: unless it is
 * already in the inbox, it is copied in (the inbox is created when missing) under its own name, or <stem>-<n><ext>
 * when the inbox holds another file of that name; nothing in the inbox is replaced, and a file there with the same
 * bytes is used again (reused). A pipe or process substitution is read and written in like a file. Only a bare name
 * that is no file here names a file in the inbox; a name that matches nothing is passed on, so the tool reports it.
 * `sanitize` makes the name one the tool takes.
 */
export async function stageIntoInbox(inbox, given, { cwd = process.cwd(), sanitize = name => name } = {}) {
  const bare = !/[\\/]/.test(given);
  const source = path.resolve(cwd, given);
  const info = await stat(source).catch(() => null);
  if (!info) return { name: bare ? given : path.basename(given) };
  if (info.isDirectory()) throw new CliFileError('file_unavailable', `${shown(given)} is a folder, not a file.`);
  const regular = info.isFile();
  const realInbox = await realpath(inbox).catch(() => null);
  if (regular && realInbox && path.dirname(await realpath(source)) === realInbox) return { name: path.basename(source) };
  await mkdir(inbox, { recursive: true });
  // A pipe can be read once: its bytes are kept and written into the inbox.
  let bytes = regular ? null : await readStream(createReadStream(source), STAGE_STREAM_LIMIT, shown(given));
  const { name: stem, ext } = path.parse(sanitize(path.basename(source)));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = `${stem}${attempt ? `-${attempt}` : ''}${ext}`, target = path.join(inbox, name);
    try {
      if (regular) await copyFile(source, target, constants.COPYFILE_EXCL); else await writeFile(target, bytes, { flag: 'wx' });
      return { name, copiedFrom: source };
    } catch (error) { if (error?.code !== 'EEXIST') throw new CliFileError('file_unavailable', `${shown(given)} cannot be copied into the inbox (${error?.code ?? 'error'}).`); }
    // The same file copied in before (same bytes): use it again instead of another copy.
    const there = await stat(target).catch(() => null);
    if (there?.isFile() && (!regular || there.size === info.size)) {
      bytes ??= await readFile(source);
      if (bytes.equals(await readFile(target))) return { name, copiedFrom: source, reused: true };
    }
  }
  throw new CliFileError('file_unavailable', `The inbox has no free name for ${shown(given)}.`);
}

/** Whether `file` already exists (anything, a link too). */
export async function exists(file) {
  try { await lstat(file); return true; } catch (error) { return error?.code !== 'ENOENT'; }
}

/** Whether two paths name the same file: the same resolved path, or the same device and inode (links, other names). */
export async function sameFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try { const [one, two] = await Promise.all([stat(a), stat(b)]); return one.dev === two.dev && one.ino === two.ino; }
  catch { return false; }
}
