import { createHash } from 'node:crypto';
import { crc32, gunzipSync, inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { inspectImageMetadata, parseImageMeta, parseStableDiffusionParameters } from '../src/png-meta';
import type { StudyField, StudyStatus } from '../src/workspace/image-study-types';
import { withReason, type HostErrorParams } from './host-error';

export const STUDY_PARSE_LIMITS = { bytes: 20 * 1024 * 1024, pixels: 64 * 1024 * 1024, metadataBytes: 2 * 1024 * 1024, depth: 32, nodes: 20_000, fields: 4000, previewBytes: 2 * 1024 * 1024, edge: 1200 };
export interface ParsedImageStudy {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number;
  preview: Uint8Array; previewSha256: string; metadataStatus: StudyStatus; metadataKind: string;
  sources: string[]; warnings: string[]; prompts: StudyField[]; parameters: StudyField[];
  raw: Record<string, Record<string, string>>;
}
/** reason/params: the window's catalog message (src/host-errors/library.ts); the message is English. */
export class ImageStudyError extends Error { declare reason?: string; declare params?: HostErrorParams; constructor(public code: string, message: string, reason?: string, params?: HostErrorParams) { super(message); if (reason) withReason(this, reason, params); } }
const fail = (code: string, message: string, reason?: string, params?: HostErrorParams): never => { throw new ImageStudyError(code, message, reason, params); };
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const STEALTH_MAGIC = Buffer.from('stealth_pngcomp');
function fieldLabel(key: string): string {
  if (/^Description$/i.test(key)) return '图片原始描述';
  if (/^Comment\.prompt$|^parameters\.positive$/i.test(key)) return '完整正面';
  if (/^Comment\.uc$|^parameters\.negative$/i.test(key)) return '完整负面';
  const structured = key.match(/^Comment\.(v4_prompt|v4_negative_prompt)\.caption\.(.+)$/);
  if (structured) {
    const negative = structured[1] === 'v4_negative_prompt', suffix = negative ? '负面' : '正面';
    if (structured[2] === 'base_caption') return `基础${suffix}`;
    const character = structured[2].match(/^char_captions\[(\d+)\]\.(.+)$/);
    if (character) return `角色 ${Number(character[1]) + 1} ${character[2] === 'char_caption' ? suffix : character[2] === 'centers' ? `${suffix}位置原值` : character[2]}`;
  }
  const name = key.replace(/^Comment\.|^parameters\./i, '');
  const labels: Record<string, string> = { seed: 'Seed', steps: 'Steps', scale: 'CFG', 'CFG scale': 'CFG', cfg_rescale: 'CFG Rescale', width: '宽度原值', height: '高度原值', model: '模型原值', Source: '模型来源声明', Software: '软件来源声明', sampler: '采样器', noise_schedule: '噪声调度', sm: 'SMEA', sm_dyn: '动态 SMEA', quality_boost: '质量增强原值', qualityPresetId: '质量预设原值', ucPreset: 'UC 预设原值', uc_preset: 'UC 预设原值', Size: '尺寸原值', Seed: 'Seed', Steps: 'Steps', Sampler: '采样器' };
  if (labels[name]) return labels[name];
  if (/\.use_coords$/.test(name)) return '角色定位开关原值';
  if (/\.use_order$/.test(name)) return '角色顺序开关原值';
  return name;
}
function boundedStructure(value: unknown) {
  const pending: [unknown, number][] = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop()!;
    if (++nodes > STUDY_PARSE_LIMITS.nodes || depth > STUDY_PARSE_LIMITS.depth) fail('metadata_limit', 'Metadata structure exceeds its bounded depth or item count.');
    if (item && typeof item === 'object') for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
}
const json = (text: string) => { const value: unknown = JSON.parse(text); boundedStructure(value); return value; };
function mime(bytes: Buffer): ParsedImageStudy['mimeType'] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return fail('invalid_image', 'Only original PNG, JPEG or WebP images are supported.', 'study.unsupported_format');
}

/** This function runs only inside the bounded study worker in production.
 * The existing parser remains the generator-format authority; this adapter
 * adds containers and exposes original fields instead of its apply defaults. */
export async function parseImageStudy(input: Buffer | Uint8Array): Promise<ParsedImageStudy> {
  const bytes = Buffer.from(input);
  if (!bytes.length || bytes.length > STUDY_PARSE_LIMITS.bytes) return fail('invalid_image', 'The image is empty or exceeds 20 MiB.', 'study.image_size');
  const mimeType = mime(bytes), warnings: string[] = [], raw: ParsedImageStudy['raw'] = Object.create(null);
  let metadataBytes = 0;
  const warn = (message: string) => { if (!warnings.includes(message) && warnings.length < 24) warnings.push(message); };
  const add = (source: string, key: string, value: string) => {
    const size = Buffer.byteLength(key) + Buffer.byteLength(value);
    if (metadataBytes + size > STUDY_PARSE_LIMITS.metadataBytes || key.length > 200) { warn('Metadata text exceeds the 2 MiB limit; extraction is incomplete.'); return; }
    raw[source] ??= Object.create(null);
    if (Object.hasOwn(raw[source], key) && raw[source][key] !== value) {
      // Preserve duplicate chunks too; do not silently overwrite their text.
      let count = 2; while (Object.hasOwn(raw[source], `${key} [${count}]`)) count++;
      warn('Conflicting duplicate metadata fields were retained separately.'); key = `${key} [${count}]`;
    }
    if (!Object.hasOwn(raw[source], key)) { raw[source][key] = value; metadataBytes += size; }
  };
  // PNG chunk boundaries are inspected here only to support bounded compressed
  // containers. Text decoding and generator interpretation still use png-meta.
  if (mimeType === 'image/png') {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset), start = offset + 8, end = start + length;
      if (end + 4 > bytes.length) { warn('A PNG chunk is truncated; metadata extraction is incomplete.'); break; }
      const type = bytes.toString('ascii', offset + 4, start), data = bytes.subarray(start, end);
      if (type === 'IEND') break;
      try {
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
          if (crc32(bytes.subarray(offset + 4, end)) !== bytes.readUInt32BE(end)) throw new Error('Invalid metadata checksum');
          const zero = data.indexOf(0);
          if (zero < 1) throw new Error('Invalid keyword');
          const key = data.toString('latin1', 0, zero), budget = STUDY_PARSE_LIMITS.metadataBytes - metadataBytes;
          if (budget < 1) throw new Error('Metadata limit');
          if (type === 'zTXt') {
            if (data[zero + 1] !== 0) throw new Error('Invalid compression');
            add('png-compressed', key, inflateSync(data.subarray(zero + 2), { maxOutputLength: budget }).toString('utf8'));
          } else if (type === 'iTXt' && data[zero + 1] === 1) {
            if (data[zero + 2] !== 0) throw new Error('Invalid compression');
            const language = data.indexOf(0, zero + 3), translated = language < 0 ? -1 : data.indexOf(0, language + 1);
            if (translated < 0) throw new Error('Invalid international text');
            add('png-compressed', key, inflateSync(data.subarray(translated + 1), { maxOutputLength: budget }).toString('utf8'));
          } else {
            if (type === 'iTXt' && data[zero + 1] !== 0) throw new Error('Invalid compression');
            // A single original chunk plus signature is enough for the existing
            // parser; avoid reading every chunk repeatedly or merging sources.
            const chunk = Buffer.concat([bytes.subarray(0, 8), bytes.subarray(offset, end + 4)]);
            const decoded = Object.entries(parseImageMeta(Uint8Array.from(chunk).buffer));
            if (!decoded.length) throw new Error('Invalid text structure');
            for (const [name, value] of decoded) add('png-text', name, value);
          }
        }
      } catch { warn('A PNG text chunk could not be decoded within limits; original bytes are retained.'); }
      offset = end + 4;
    }
  } else {
    try { for (const [key, value] of Object.entries(parseImageMeta(Uint8Array.from(bytes).buffer))) add('exif', key, value); }
    catch { warn('EXIF metadata could not be completely decoded; original bytes are retained.'); }
  }
  let width: number, height: number, preview: Buffer;
  try {
    const image = sharp(bytes, { limitInputPixels: STUDY_PARSE_LIMITS.pixels, failOn: 'error', animated: false });
    const info = await image.metadata();
    if (!info.width || !info.height || info.width * info.height > STUDY_PARSE_LIMITS.pixels || (info.pages ?? 1) !== 1) return fail('invalid_image', 'The image size is invalid, exceeds 64 MP or has several frames.', 'study.image_dimensions');
    width = info.width; height = info.height;
    if (mimeType === 'image/png' && info.hasAlpha) {
      const decoded = await image.clone().ensureAlpha().raw().timeout({ seconds: 12 }).toBuffer({ resolveWithObject: true });
      // Official NovelAI alpha.T traversal: x outer, y inner; MSB first.
      const capacity = Math.floor(width * height / 8), channels = decoded.info.channels;
      const at = (byte: number) => {
        let output = 0;
        for (let bit = 0; bit < 8; bit++) { const n = byte * 8 + bit, x = Math.floor(n / height), y = n % height; output = (output << 1) | (decoded.data[(y * width + x) * channels + channels - 1] & 1); }
        return output;
      };
      const headerSize = STEALTH_MAGIC.length + 4;
      if (capacity >= headerSize && Buffer.from(Array.from({ length: STEALTH_MAGIC.length }, (_, i) => at(i))).equals(STEALTH_MAGIC)) {
        try {
          const header = Buffer.from(Array.from({ length: 4 }, (_, i) => at(i + STEALTH_MAGIC.length))), bits = header.readUInt32BE(0), size = bits / 8;
          if (!Number.isInteger(size) || size < 1 || size > capacity - headerSize || size > STUDY_PARSE_LIMITS.metadataBytes) throw new Error('Invalid stealth length');
          const compressed = Buffer.alloc(size); for (let i = 0; i < size; i++) compressed[i] = at(i + headerSize);
          const result = object(json(gunzipSync(compressed, { maxOutputLength: STUDY_PARSE_LIMITS.metadataBytes }).toString('utf8')));
          if (!result) throw new Error('Invalid stealth object');
          for (const [key, value] of Object.entries(result)) add('png-stealth', key, typeof value === 'string' ? value : JSON.stringify(value));
        } catch { warn('NovelAI stealth metadata is present but could not be fully decoded within limits.'); }
      }
    }
    preview = await image.clone().rotate().resize({ width: STUDY_PARSE_LIMITS.edge, height: STUDY_PARSE_LIMITS.edge, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).timeout({ seconds: 12 }).toBuffer();
    if (preview.length > STUDY_PARSE_LIMITS.previewBytes) return fail('invalid_image', 'The preview exceeds its size limit.', 'study.preview_too_large');
  } catch (error) { if (error instanceof ImageStudyError) throw error; return fail('invalid_image', 'The image cannot be fully decoded; the damaged original was not saved.', 'study.decode_failed'); }

  const prompts: StudyField[] = [], parameters: StudyField[] = [], kinds = new Set<string>();
  const field = (target: StudyField[], source: string, key: string, value: unknown) => {
    if (prompts.length + parameters.length >= STUDY_PARSE_LIMITS.fields) { warn('Too many metadata fields; the field view is incomplete.'); return; }
    target.push({ key: `${source}:${key}`, label: fieldLabel(key), value: typeof value === 'string' ? value : JSON.stringify(value) });
  };
  const seenFields = new Map<string, string>();
  for (const [source, meta] of Object.entries(raw)) {
    const safe: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(meta)) {
      if (seenFields.has(key) && seenFields.get(key) !== value) warn('Metadata sources conflict; each source is retained separately and none is authoritative.');
      seenFields.set(key, value); safe[key] = value;
      if (['comment', 'prompt', 'workflow'].includes(key.toLowerCase()) && /^[\s]*[\[{]/.test(value)) {
        try { json(value); } catch { delete safe[key]; warn('A JSON metadata field is malformed or exceeds structure limits; raw text is retained.'); }
      }
    }
    let report;
    try { report = inspectImageMetadata(safe); } catch { warn('Generator metadata interpretation is incomplete; raw text is retained.'); }
    let generatorEvidence = report?.kind === 'stable-diffusion';
    if (report?.kind === 'novelai') {
      let comment: Record<string, unknown> | undefined; try { comment = object(json(safe.Comment ?? safe.comment ?? '{}')); } catch { /* not evidence */ }
      generatorEvidence = /novelai/i.test(`${safe.Software ?? safe.software ?? ''} ${safe.Source ?? safe.source ?? ''}`)
        || typeof comment?.prompt === 'string' || typeof comment?.uc === 'string' || Boolean(object(comment?.v4_prompt));
    }
    if (report?.kind === 'comfyui') {
      try { generatorEvidence = Boolean(object(json(safe.prompt ?? safe.workflow ?? 'null'))) || Array.isArray(json(safe.workflow ?? 'null')); } catch { /* not evidence */ }
    }
    if (report && generatorEvidence) kinds.add(report.kind);
    for (const message of report?.warnings ?? []) if (!message.startsWith('No supported') && !message.startsWith('Embedded metadata')) {
      // Summary warnings never echo untrusted prompt/model strings.
      warn(/malformed|invalid|could not/i.test(message) ? 'Some generation metadata is malformed or incomplete; original text is retained.' : 'Some source generation fields are view-only and cannot map to a NovelAI recipe.');
    }
    for (const [key, value] of Object.entries(safe)) {
      const lower = key.toLowerCase();
      if (lower === 'description') { field(prompts, source, key, value); continue; }
      if (lower === 'comment') {
        let comment: Record<string, unknown> | undefined; try { comment = object(json(value)); } catch { /* preserved raw */ }
        if (!comment) { field(parameters, source, key, value); continue; }
        for (const [name, item] of Object.entries(comment)) {
          if (name === 'prompt' || name === 'uc') { field(prompts, source, `Comment.${name}`, item); continue; }
          if (name === 'v4_prompt' || name === 'v4_negative_prompt') {
            const structured = object(item), caption = object(structured?.caption);
            if (!structured) { field(parameters, source, `Comment.${name}`, item); continue; }
            if (caption) {
              for (const [part, content] of Object.entries(caption)) {
                if (part === 'char_captions' && Array.isArray(content)) content.forEach((character, index) => {
                  const values = object(character); if (!values) { field(prompts, source, `Comment.${name}.caption.char_captions[${index}]`, character); return; }
                  for (const [attribute, original] of Object.entries(values)) field(prompts, source, `Comment.${name}.caption.char_captions[${index}].${attribute}`, original);
                });
                else field(prompts, source, `Comment.${name}.caption.${part}`, content);
              }
            }
            for (const [part, content] of Object.entries(structured)) if (part !== 'caption') field(prompts, source, `Comment.${name}.${part}`, content);
          } else field(parameters, source, `Comment.${name}`, item);
        }
      } else if (lower === 'parameters' && /(?:^|\n)Steps:\s*\d+/m.test(value)) {
        const sd = parseStableDiffusionParameters(value);
        if (sd.prompt !== undefined) field(prompts, source, `${key}.positive`, sd.prompt);
        if (sd.negativePrompt !== undefined) field(prompts, source, `${key}.negative`, sd.negativePrompt);
        for (const [name, original] of Object.entries(sd.parameters)) field(parameters, source, `${key}.${name}`, original);
      } else if ((lower === 'prompt' || lower === 'workflow') && report?.kind === 'comfyui') {
        // The original graph stays intact. The established parser's entries
        // are descriptive source values, never its mapped GenerateParams.
        field(parameters, source, key, value);
      } else field(parameters, source, key, value);
    }
    if (report?.kind === 'comfyui') for (const entry of report.entries) if (/prompt/i.test(entry.key)) field(prompts, source, entry.key, entry.value);
  }
  const sources = Object.keys(raw), metadataKind = kinds.size === 1 ? [...kinds][0] : kinds.size > 1 ? 'mixed' : 'unknown';
  return { mimeType, width, height, preview, previewSha256: digest(preview), raw, sources, prompts, parameters, warnings,
    metadataKind, metadataStatus: warnings.length ? 'partial' : kinds.size ? 'generation' : sources.length ? 'other_metadata' : 'missing' };
}
