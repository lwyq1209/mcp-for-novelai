/**
 * Where a queued batch saves its images (issue #1): an optional history group, created on first use and reused by
 * name, and an optional file-name prefix. Both are part of the enqueue plan and frozen into every image's snapshot
 * (extras.historyGroupId / extras.fileNamePrefix). The MCP server (novelai/src/recipe-queue.mjs) applies the
 * same rules before any host call; a test pins the two together.
 */
export interface QueueOutputRequest { historyGroup?: string; fileNamePrefix?: string }
export interface QueueOutput extends QueueOutputRequest { historyGroupId?: string; historyGroupName?: string }
interface HistoryGroupLike { id: string; name: string }

/** Both limits count UTF-16 code units (an emoji counts 2), like the host's own group-name and file-name truncation. */
export const QUEUE_HISTORY_GROUP_MAX = 80;
export const QUEUE_FILE_PREFIX_MAX = 40;
// C0, DEL and C1 controls.
const CONTROL = /\p{Cc}/u;
// Lone surrogates and the invisible format characters that disguise a name: bidi controls, zero-width space, word
// joiner and invisible operators, BOM, soft hyphen, deprecated format controls, shorthand-format and musical
// format controls. Kept as \u escapes: written literally they would hide in the source (Trojan Source).
const INVISIBLE = /[\p{Cs}\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}]/u;
// ZWJ/ZWNJ only between visible characters (emoji sequences, scripts), never at an end or next to whitespace.
const STRAY_JOINER = /^[\u200c\u200d]|[\u200c\u200d]$|\s[\u200c\u200d]|[\u200c\u200d]\s/u;
// Tag characters only inside the three recommended (RGI) subdivision flags: England, Scotland, Wales. Any other tag
// run could carry hidden text.
const FLAG_TAG_SEQUENCE = /\u{1f3f4}\u{e0067}\u{e0062}(?:\u{e0065}\u{e006e}\u{e0067}|\u{e0073}\u{e0063}\u{e0074}|\u{e0077}\u{e006c}\u{e0073})\u{e007f}/gu;
const STRAY_TAG = /[\u{e0000}-\u{e007f}]/u;
const disguised = (value: string) => INVISIBLE.test(value) || STRAY_JOINER.test(value) || STRAY_TAG.test(value.replace(FLAG_TAG_SEQUENCE, ''));
// Windows device names, also with an extension (s: an extension may hold any character).
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/is;
// File-system-safe on macOS and Windows: no whitespace, control or path characters, no leading dot or dash.
const FILE_PREFIX = /^(?![.-])[^\s\x00-\x1f\x7f\\/:*?"<>|]+$/u;

/** The one history-group name normalization: ensureHistoryGroup (ipc/store.ts) imports it. Controls and whitespace runs become one space. */
export const normalizeHistoryGroupName = (name: string) => name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * The folder a history group saves into: path-illegal characters become "-", whitespace runs "_", leading dots are
 * dropped, at most 80 code units. Moved here unchanged from ipc/nai.ts, which still uses it for every save.
 */
export function sanitizeGroupFolderName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return cleaned || "group";
}
/**
 * Two folders with equal keys are one folder on macOS (case folding incl. ß/ss and ligatures, NFC/NFD) or Windows
 * (case, trailing dots and spaces). upper-then-lower approximates full case folding; it can only over-report.
 */
// A lone surrogate reaches the disk as U+FFFD; lower-upper-lower then NFC folds ẞ/ß/ss and composed Greek too.
const folderKey = (folder: string) => folder.replace(/\p{Cs}/gu, '\ufffd').normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC').replace(/[. ]+$/, '');
/** An existing group saves into sanitizeGroupFolderName(its name); a new one into that of its normalized name. */
const existingFolderKey = (group: HistoryGroupLike) => folderKey(sanitizeGroupFolderName(group.name));
const requestedFolderKey = (name: string) => folderKey(sanitizeGroupFolderName(normalizeHistoryGroupName(name)));
const nameKey = (name: string) => normalizeHistoryGroupName(name).normalize('NFC').toLowerCase();

export const validHistoryGroupName = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= QUEUE_HISTORY_GROUP_MAX
  && value === value.trim() && !CONTROL.test(value) && !disguised(value) && !value.startsWith('.') && !value.endsWith('.')
  && !WINDOWS_RESERVED.test(value) && !WINDOWS_RESERVED.test(sanitizeGroupFolderName(normalizeHistoryGroupName(value)));
// A prefix is a device name on its own when a user template is just {name}.
export const validFileNamePrefix = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= QUEUE_FILE_PREFIX_MAX
  && FILE_PREFIX.test(value) && !CONTROL.test(value) && !disguised(value) && !WINDOWS_RESERVED.test(value);

/** The requested output of one enqueue, or undefined when none was given. Throws a plain message on invalid input. */
export function parseQueueOutput(raw: unknown): QueueOutputRequest | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Queue output must be an object.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['historyGroup', 'fileNamePrefix'].includes(key))) throw new Error('Unknown queue output field.');
  if (value.historyGroup === undefined && value.fileNamePrefix === undefined) throw new Error('Queue output needs historyGroup or fileNamePrefix.');
  if (value.historyGroup !== undefined && !validHistoryGroupName(value.historyGroup)) throw new Error(`historyGroup must be 1–${QUEUE_HISTORY_GROUP_MAX} UTF-16 code units (an emoji counts 2) without control characters, bidi, zero-width or stray joiner/tag characters, surrounding whitespace, a leading or trailing dot, or a Windows device name (CON, NUL, COM1…).`);
  if (value.fileNamePrefix !== undefined && !validFileNamePrefix(value.fileNamePrefix)) throw new Error(`fileNamePrefix must be 1–${QUEUE_FILE_PREFIX_MAX} UTF-16 code units (an emoji counts 2) without whitespace, control, bidi, zero-width or stray joiner/tag characters or path characters (\\ / : * ? " < > |), must not start with "." or "-" and must not be a Windows device name.`);
  return { ...(value.historyGroup !== undefined ? { historyGroup: value.historyGroup as string } : {}), ...(value.fileNamePrefix !== undefined ? { fileNamePrefix: value.fileNamePrefix as string } : {}) };
}

/** A refusal before the enqueue's receipt: the key stays unused. */
export class QueueHistoryGroupConflict extends Error { readonly code = 'history_group_conflict'; }

/**
 * enqueue output.historyGroup → the group to save into. The exactly named group first, then a case-insensitive
 * match, then names compared the way ensureHistoryGroup stores them (whitespace runs collapsed, NFC,
 * case-insensitive): an existing group of that name is reused as it is. Otherwise a new
 * group must not share its folder with an existing group (case, Unicode normalization and trailing dots/spaces
 * ignored, as macOS and Windows do), or two projects would number into one folder again.
 */
export function resolveQueueHistoryGroup(name: string, groups: HistoryGroupLike[], ensure: (name: string) => HistoryGroupLike): HistoryGroupLike {
  // Most exact first, so of several groups that normalize alike the one named exactly as asked is used.
  const same = groups.find(group => group.name === name) ?? groups.find(group => group.name.toLowerCase() === name.toLowerCase())
    ?? groups.find(group => nameKey(group.name) === nameKey(name));
  if (same) return same;
  const folder = requestedFolderKey(name), shared = groups.find(group => existingFolderKey(group) === folder);
  // Offer the existing group's name only in a form this tool accepts and that reuses that very group.
  const usable = normalizeHistoryGroupName(shared?.name ?? '');
  if (shared) throw new QueueHistoryGroupConflict(validHistoryGroupName(usable)
    ? `The history group "${name}" would save into the same folder as the existing group "${usable}". Use "${usable}" to share it, or a name that differs in more than spaces, case or path characters.`
    : `The history group "${name}" would save into the same folder as an existing group whose name this tool cannot use. Choose a clearly different name.`);
  return ensure(name);
}
