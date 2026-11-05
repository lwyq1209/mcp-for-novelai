import type { AssetItem, AssetKind } from '../asset-library/types';
import type { BatchItem, BatchJob, BatchMode, BatchSource, BatchStatus } from '../workspace/batch-types';
import type { MaterialComponent, MaterialEntry, MaterialTarget } from '../workspace/material-library-types';
import type { LibraryApi } from './api';
import type { DeleteReceipt, ReceiptRow, TrashEntry, TrashPage } from './impacts';
import { captureArt, captureArtSvg, type ArtTheme } from './capture-art';
import { batchFactsOf, factsMatch, imageFacts, localDayKey, modelOfFacts, sourceOfFacts, type ImageFilterArgs } from './image-facts';

/**
 * In-memory library for UI capture runs (step 4b1): the sample data of the step-4 prototype (data.js) served through
 * the LibraryApi shape the page uses. Deterministic for a given language and `now`; it never touches window.naiDesktop,
 * the DOM or the network. Mutations answer without changing anything (screenshots need no real edits).
 */
export type CaptureLang = 'zh' | 'en';
export interface CaptureFixture {
  api: LibraryApi;
  batches: BatchJob[];
  importFile(): Promise<File>;
}

type Pair = readonly [string, string];
type AgentKey = 'claude' | 'codex' | 'pi' | 'cursor' | 'manual';

const MIB = 1024 * 1024;
const MINUTE = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const RETENTION_DAYS = 30;
const MODEL = 'nai-diffusion-5-full';
const NOT_AVAILABLE = () => Promise.reject(new Error('Not available in UI capture'));

const AGENT_CLIENTS: Record<Exclude<AgentKey, 'manual'>, string> = { claude: 'claude-code', codex: 'codex-mcp-client', pi: 'pi', cursor: 'cursor-vscode' };
const SIZES = { p: [832, 1216], l: [1216, 832], s: [1024, 1024], t: [768, 1344] } as const;
type SizeKey = keyof typeof SIZES;

const PROMPTS: Record<ArtTheme, string> = {
  cafe: '1girl, solo, cafe interior, window light, holding cup, smile, apron, brown hair, medium hair, looking at viewer, upper body, warm lighting',
  night: '1girl, solo, rooftop, night, city lights, wind, school uniform, black hair, long hair, from below, cinematic lighting, starry sky',
  library: '2girls, library, bookshelf, reading, sunlight, dust particles, cardigan, glasses, sitting, quiet',
  rain: '1boy, solo, rain, umbrella, street, neon lights, hoodie, white hair, looking back, reflection, puddle',
  beach: '1girl, solo, beach, sunset, white sundress, straw hat, ocean, wind, smile, from side, lens flare',
  forest: '1girl, solo, forest, fantasy, elf, pointy ears, green eyes, magic circle, glowing particles, cloak',
  sakura: '1girl, solo, cherry blossoms, school uniform, pink hair, petals, spring, wind, smile, hand up',
  studio: '1girl, solo, simple background, character sheet, full body, standing, hoodie, purple eyes, multiple views',
};
const STYLE = 'soft lighting, pastel colors, detailed background, very aesthetic';
const NEG = 'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, cropped, worst quality, jpeg artifacts, signature, watermark';

const GROUPS: Array<{ id: string; name: Pair; agent: AgentKey; count: number }> = [
  { id: 'cafe', name: ['cafe-scene', 'cafe-scene'], agent: 'claude', count: 48 },
  { id: 'rooftop', name: ['rooftop-night', 'rooftop-night'], agent: 'codex', count: 20 },
  { id: 'styletest', name: ['style-tests', 'style-tests'], agent: 'pi', count: 36 },
  { id: 'summer', name: ['夏日海边', 'summer-beach'], agent: 'cursor', count: 14 },
  { id: 'manual', name: ['手动', 'Manual'], agent: 'manual', count: 102 },
];
const COLLECTIONS: Array<{ id: string; name: Pair; count: number }> = [
  { id: 'c1', name: ['夏日企划', 'Summer project'], count: 24 },
  { id: 'c2', name: ['封面候选', 'Cover picks'], count: 9 },
  { id: 'c3', name: ['角色设定', 'Character sheets'], count: 13 },
  { id: 'c4', name: ['灵感', 'Inspiration'], count: 0 },
];

// History images: [day, theme, group, size, mode] (data.js plan)
const PLAN: Array<[number, ArtTheme, string, SizeKey, BatchMode]> = [
  [0, 'cafe', 'cafe', 'p', 't2i'], [0, 'cafe', 'cafe', 'p', 't2i'], [0, 'cafe', 'cafe', 'p', 't2i'], [0, 'cafe', 'cafe', 'l', 't2i'],
  [0, 'cafe', 'cafe', 'p', 't2i'], [0, 'cafe', 'cafe', 'p', 'i2i'], [0, 'cafe', 'cafe', 'p', 't2i'], [0, 'sakura', 'manual', 'p', 't2i'],
  [0, 'sakura', 'manual', 's', 't2i'], [0, 'night', 'rooftop', 'l', 't2i'], [0, 'night', 'rooftop', 'p', 't2i'], [0, 'night', 'rooftop', 't', 't2i'],
  [0, 'cafe', 'cafe', 'p', 'inpaint'],
  [1, 'studio', 'styletest', 's', 't2i'], [1, 'studio', 'styletest', 's', 't2i'], [1, 'studio', 'styletest', 's', 't2i'], [1, 'studio', 'styletest', 's', 't2i'],
  [1, 'library', 'manual', 'l', 't2i'], [1, 'library', 'manual', 'p', 'i2i'], [1, 'rain', 'manual', 'p', 't2i'], [1, 'rain', 'manual', 'l', 't2i'],
  [1, 'forest', 'styletest', 'p', 't2i'], [1, 'forest', 'styletest', 'p', 't2i'], [1, 'forest', 'styletest', 'l', 'upscale'],
  [2, 'beach', 'summer', 'l', 't2i'], [2, 'beach', 'summer', 'p', 't2i'], [2, 'beach', 'summer', 'p', 't2i'], [2, 'beach', 'summer', 'l', 't2i'],
  [2, 'beach', 'summer', 's', 'enhance'], [2, 'sakura', 'manual', 'p', 't2i'], [2, 'night', 'manual', 'p', 't2i'], [2, 'rain', 'manual', 't', 't2i'],
  [3, 'library', 'manual', 'p', 't2i'], [3, 'forest', 'manual', 'l', 't2i'], [3, 'studio', 'manual', 's', 't2i'], [3, 'cafe', 'manual', 'p', 't2i'],
  [3, 'night', 'manual', 'p', 't2i'], [3, 'beach', 'manual', 'p', 't2i'], [3, 'sakura', 'manual', 'l', 't2i'], [3, 'rain', 'manual', 'p', 't2i'],
];
const TIMES = [
  ['17:42', '17:41', '17:40', '17:38', '17:37', '17:31', '17:30', '16:05', '16:02', '11:20', '11:19', '11:18', '10:02'],
  ['22:14', '22:13', '22:13', '22:12', '20:40', '20:31', '19:02', '19:01', '18:11', '18:10', '18:09'],
  ['15:22', '15:21', '15:20', '15:19', '15:30', '13:02', '12:40', '09:15'],
  ['21:00', '20:12', '19:40', '18:22', '14:10', '13:45', '11:30', '10:05'],
];
const DAY_STAMPS = ['1103', '1102', '1101', '1030'];
const LIBRARY_CHARACTERS = ['girl, glasses, cardigan, reading', 'girl, ponytail, looking at another'];

const IMPORTS: Array<{ id: string; theme: ArtTheme; w: number; h: number; name: string; meta: boolean; mimeType: string }> = [
  { id: 's1', theme: 'sakura', w: 832, h: 1216, name: 'pixiv_reference_01.png', meta: true, mimeType: 'image/png' },
  { id: 's2', theme: 'night', w: 1216, h: 832, name: 'rooftop_ref.webp', meta: false, mimeType: 'image/webp' },
  { id: 's3', theme: 'forest', w: 832, h: 1216, name: 'elf_study.png', meta: true, mimeType: 'image/png' },
  { id: 's4', theme: 'beach', w: 1024, h: 1024, name: 'beach_palette.jpg', meta: false, mimeType: 'image/jpeg' },
  { id: 's5', theme: 'rain', w: 832, h: 1216, name: 'neon_street.png', meta: true, mimeType: 'image/png' },
  { id: 's6', theme: 'library', w: 1216, h: 832, name: 'library_old_version.png', meta: true, mimeType: 'image/png' },
];

const TAGS: Array<[string, number, MaterialTarget, ArtTheme]> = [
  ['smile', 1640122, 'base', 'sakura'], ['looking at viewer', 4421903, 'base', 'cafe'], ['from below', 120380, 'base', 'night'], ['cinematic lighting', 61211, 'style', 'night'],
  ['cafe interior', 9120, 'base', 'cafe'], ['dust particles', 3311, 'base', 'library'], ['lens flare', 31877, 'style', 'beach'], ['watercolor (medium)', 40122, 'style', 'sakura'],
  ['white hair', 1022833, 'character', 'rain'], ['pointy ears', 488201, 'character', 'forest'], ['school uniform', 1288400, 'character', 'sakura'], ['hood up', 64120, 'character', 'rain'],
  ['upper body', 2012009, 'base', 'studio'], ['wind', 220140, 'base', 'beach'], ['night sky', 140889, 'base', 'night'], ['glowing', 280511, 'style', 'forest'],
];
const SMILE_NOTE: Pair = ['和 closed eyes 一起用会变成眯眼笑。', 'Together with closed eyes it becomes a squinting smile.'];

const COMBOS: Array<{ id: string; name: Pair; text: string; theme: ArtTheme }> = [
  { id: 'm1', name: ['柔光水彩', 'Soft watercolor'], text: 'watercolor (medium):1.2, soft lighting, pastel colors, light particles:0.8', theme: 'sakura' },
  { id: 'm2', name: ['夜景电影感', 'Cinematic night'], text: 'cinematic lighting:1.1, night sky, city lights, depth of field, lens flare:0.6', theme: 'night' },
  { id: 'm3', name: ['咖啡馆日常', 'Cafe everyday'], text: 'cafe interior, window light, warm lighting, holding cup, apron', theme: 'cafe' },
  { id: 'm4', name: ['奇幻森林', 'Fantasy forest'], text: 'forest, glowing particles:1.2, magic circle, fantasy, cloak', theme: 'forest' },
  { id: 'm5', name: ['角色三视图', 'Turnaround sheet'], text: 'character sheet, multiple views, full body, simple background, standing', theme: 'studio' },
  { id: 'm6', name: ['雨夜霓虹', 'Neon rain'], text: 'rain, neon lights, reflection, puddle, umbrella, night', theme: 'rain' },
];
const STYLE_WORDS = /lighting|colors|watercolor|particles|lens flare|depth of field/;

const NOTES: Array<{ id: string; name: Pair; text: Pair }> = [
  { id: 'n1', name: ['V5 写手部的经验', 'Hands on V5'], text: ['手部特写时把 holding cup 放在正面靠前的位置，比加负面 bad hands 有效得多。', 'For hand close-ups, put “holding cup” early in the prompt; it works far better than adding bad hands to the negative.'] },
  { id: 'n2', name: ['夜景别太暗', 'Keep night scenes readable'], text: ['night 场景加 rim light 和 city lights，人物不会糊进背景。', 'Add rim light and city lights to night scenes so the character doesn’t sink into the background.'] },
  { id: 'n3', name: ['多人站位', 'Placing two characters'], text: ['两个角色用位置格子分开左右，再在 Base 写互动动作。', 'Split two characters left and right with the position grid, then describe the interaction in Base.'] },
  { id: 'n4', name: ['扩画布后重绘边缘', 'Redraw the seam after outpainting'], text: ['离新边 64 像素内会被重画，原图其余部分逐像素不变。', 'Only the 64 px next to the new edge is repainted; the rest stays pixel-identical.'] },
  { id: 'n5', name: ['Style 预设试色', 'Trying style presets'], text: ['同一份底稿只换 Style，用同一组 seed 比较最直观。', 'Change only the Style on one base prompt and compare with the same seeds.'] },
];

const PRESETS: Array<{ id: string; sub: 'style' | 'positive' | 'chunk' | 'reference'; name: Pair; text: string; theme: ArtTheme | null }> = [
  { id: 'p1', sub: 'style', name: ['日系柔光', 'Soft anime light'], text: 'soft lighting, pastel colors, very aesthetic, detailed background', theme: 'sakura' },
  { id: 'p2', sub: 'style', name: ['厚涂', 'Painterly'], text: 'painterly, thick brush strokes, oil painting (medium), dramatic lighting', theme: 'forest' },
  { id: 'p3', sub: 'style', name: ['赛璐璐', 'Cel shading'], text: 'cel shading, flat color, clean lineart, anime screencap', theme: 'studio' },
  { id: 'p4', sub: 'positive', name: ['单人半身', 'Solo upper body'], text: '1girl, solo, upper body, looking at viewer', theme: null },
  { id: 'p5', sub: 'positive', name: ['质量收尾', 'Quality tail'], text: 'masterpiece, best quality, highres, absurdres', theme: null },
  { id: 'p6', sub: 'chunk', name: ['咖啡馆环境', 'Cafe setting'], text: 'cafe interior, window light, wooden table, plants', theme: null },
  { id: 'p7', sub: 'chunk', name: ['风吹头发', 'Hair in the wind'], text: 'wind, floating hair, hair blowing', theme: null },
  { id: 'p8', sub: 'reference', name: ['夜景氛围', 'Night mood'], text: '', theme: 'night' },
  { id: 'p9', sub: 'reference', name: ['角色 A 定妆', 'Character A look'], text: '', theme: 'rain' },
];

const ARTISTS: Array<[string, ArtTheme]> = [
  ['artist:amane rin, artist:kouji', 'sakura'], ['artist:mizuiro, year 2024', 'beach'], ['artist:nocturne', 'night'], ['artist:fuyu, artist:hoshino', 'forest'],
  ['artist:shirokuma', 'studio'], ['artist:tokyo-ame', 'rain'], ['artist:kissa', 'cafe'], ['artist:shiori', 'library'],
];

// Queue batches (data.js BATCHES); day: 0 today, 1 yesterday, 2 = Nov 1 of the prototype.
const BATCHES: Array<{ id: string; status: BatchStatus; agent: AgentKey; group: string; mode: BatchMode; total: number; done: number; failed: number; unknown: number; interval: number; day: number; time: string; halted?: boolean }> = [
  { id: 'b1', status: 'running', agent: 'claude', group: 'cafe', mode: 't2i', total: 12, done: 7, failed: 0, unknown: 0, interval: 0, day: 0, time: '17:28' },
  { id: 'b2', status: 'queued', agent: 'manual', group: 'manual', mode: 't2i', total: 4, done: 0, failed: 0, unknown: 0, interval: 0, day: 0, time: '17:41' },
  { id: 'b3', status: 'queued', agent: 'codex', group: 'rooftop', mode: 'i2i', total: 6, done: 0, failed: 0, unknown: 0, interval: 2, day: 0, time: '17:43' },
  { id: 'b4', status: 'paused', halted: true, agent: 'pi', group: 'styletest', mode: 't2i', total: 8, done: 0, failed: 0, unknown: 0, interval: 0, day: 0, time: '16:50' },
  { id: 'b5', status: 'blocked', agent: 'claude', group: 'cafe', mode: 'inpaint', total: 2, done: 0, failed: 0, unknown: 0, interval: 0, day: 0, time: '16:31' },
  { id: 'b6', status: 'succeeded', agent: 'codex', group: 'rooftop', mode: 't2i', total: 3, done: 3, failed: 0, unknown: 0, interval: 0, day: 0, time: '11:17' },
  { id: 'b7', status: 'succeeded', agent: 'pi', group: 'styletest', mode: 't2i', total: 8, done: 7, failed: 0, unknown: 1, interval: 0, day: 1, time: '22:10' },
  { id: 'b8', status: 'succeeded', agent: 'cursor', group: 'summer', mode: 't2i', total: 5, done: 3, failed: 2, unknown: 0, interval: 1, day: 2, time: '15:18' },
  { id: 'b9', status: 'cancelled', agent: 'manual', group: 'manual', mode: 'upscale', total: 1, done: 0, failed: 0, unknown: 0, interval: 0, day: 2, time: '13:00' },
];
const GROUP_BATCH: Record<string, string> = { cafe: 'b1', rooftop: 'b6', styletest: 'b7', summer: 'b8' };

// Recently deleted (data.js TRASH); offsetMs places deletedAt before `now` so that ceil(days left) equals `left`.
const TRASH: Array<{ id: string; kind: AssetKind | 'preset' | 'collection'; name: string | Pair; by: AgentKey | 'you'; left: number; offsetMs: number; files: number; mb: number; impact: { collections?: number; recipes?: number; coversCleared?: number; members?: number } }> = [
  { id: 'x1', kind: 'history', name: 'cafe-scene_1103_03', by: 'you', left: 30, offsetMs: 2 * MINUTE, files: 2, mb: 9.8, impact: { collections: 2 } },
  { id: 'x2', kind: 'history', name: 'cafe-scene_1103_11', by: 'claude', left: 30, offsetMs: 2 * HOUR + 40 * MINUTE, files: 2, mb: 9.4, impact: { recipes: 1 } },
  { id: 'x3', kind: 'tag', name: 'bokeh', by: 'you', left: 29, offsetMs: 3 * HOUR, files: 1, mb: 0.6, impact: {} },
  { id: 'x4', kind: 'history', name: 'nai_1101_44', by: 'you', left: 28, offsetMs: 4 * HOUR, files: 2, mb: 12.6, impact: { coversCleared: 1 } },
  { id: 'x5', kind: 'collection', name: ['旧草图', 'Old sketches'], by: 'you', left: 25, offsetMs: 6 * HOUR, files: 0, mb: 0, impact: { members: 17 } },
  { id: 'x6', kind: 'study', name: 'reference_dup.png', by: 'pi', left: 17, offsetMs: 2 * HOUR, files: 1, mb: 8.7, impact: {} },
  { id: 'x7', kind: 'preset', name: ['废弃的厚涂 v1', 'Painterly v1 (old)'], by: 'you', left: 7, offsetMs: 5 * HOUR, files: 1, mb: 5.1, impact: {} },
  { id: 'x8', kind: 'note', name: ['过时的 V4 心得', 'Outdated V4 notes'], by: 'you', left: 2, offsetMs: 1 * HOUR, files: 0, mb: 0, impact: {} },
];

/** Totals shown in counts (the fixture holds only a sample of each). */
const KIND_TOTALS: Record<AssetKind, number> = { history: 1284, study: 36, tag: 212, combo: 18, note: 9, style_preset: 9, positive_preset: 5, prompt_chunk: 6, reference_preset: 4, artist_favorite: 41 };

// ── Helpers ─────────────────────────────────────────────────────────────────
const pad = (value: number, size = 2) => String(value).padStart(size, '0');
const localDay = (now: Date, daysBack: number, time: string) => {
  const [hh, mm] = time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, hh, mm, 0, 0);
};
const dateText = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Deterministic 64-hex digest stand-in (not a real SHA-256). */
function fakeHex(text: string) {
  let out = '';
  for (let round = 0; out.length < 64; round++) {
    let h = 0x811c9dc5 ^ round;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    out += (h >>> 0).toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}
function parseComponents(text: string): MaterialComponent[] {
  return text.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const match = /^(.*):(\d+(?:\.\d+)?)$/.exec(part);
    const tag = match ? match[1].trim() : part;
    return { text: tag, source: 'english', category: null, weight: match ? Number(match[2]) : 1, target: STYLE_WORDS.test(tag) ? 'style' : 'base' };
  });
}
function base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += chars[(n >> 18) & 63] + chars[(n >> 12) & 63] + (i + 1 < bytes.length ? chars[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? chars[n & 63] : '=');
  }
  return out;
}

// ── Minimal PNG encoder (stored deflate) with NovelAI tEXt metadata ───────
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
const latin1 = (text: string) => Uint8Array.from(text, ch => ch.charCodeAt(0) & 0xff);
function zlibStored(raw: Uint8Array) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535, len = Math.min(65535, raw.length - start);
    out[o++] = b === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff; out[o++] = len >> 8; out[o++] = ~len & 0xff; out[o++] = (~len >> 8) & 0xff;
    out.set(raw.subarray(start, start + len), o); o += len;
  }
  let a = 1, s = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; s = (s + a) % 65521; }
  new DataView(out.buffer).setUint32(o, ((s << 16) | a) >>> 0);
  return out;
}
/** A small RGB gradient PNG whose tEXt chunks carry NovelAI generation metadata. */
export function encodeNovelAiPng(width: number, height: number, text: Record<string, string>): Uint8Array {
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3), t = y / Math.max(1, height - 1);
    for (let x = 0; x < width; x++) {
      const u = x / Math.max(1, width - 1), p = row + 1 + x * 3;
      raw[p] = Math.round(247 - 82 * t); raw[p + 1] = Math.round(198 - 14 * t + 10 * u); raw[p + 2] = Math.round(217 + 23 * t);
    }
  }
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    ...Object.entries(text).map(([key, value]) => chunk('tEXt', latin1(`${key}\0${value}`))),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}
const IMPORT_COMMENT = { prompt: '1girl, solo, cherry blossoms, school uniform, pink hair, petals, spring, wind, smile, hand up', uc: 'lowres, bad anatomy, bad hands, text, error', steps: 28, scale: 5, seed: 3301227, sampler: 'k_euler_ancestral', width: 832, height: 1216, noise_schedule: 'karras', cfg_rescale: 0 };

// ── Fixture ─────────────────────────────────────────────────────────────────
interface Art { seed: number; theme: ArtTheme; w: number; h: number }
interface Row { item: AssetItem; art?: Art; user: string[]; search: string; mb: number; files: number }

/** archivedTotal: how many items the sample says are archived in all (12 sample items; more adds archived images). */
export function createCaptureFixture(lang: CaptureLang, now: Date, options: { archivedTotal?: number } = {}): CaptureFixture {
  const L = (pair: Pair) => (lang === 'zh' ? pair[0] : pair[1]);
  const nowMs = now.getTime();
  const rows: Row[] = [];
  const iso = (date: Date | number) => new Date(date).toISOString();
  const add = (kind: AssetKind, id: string, name: string, createdAt: string, payload: Record<string, any>, extra: { art?: Art; role?: string; user?: string[]; search?: string; mb?: number; files?: number } = {}) => {
    const art = extra.art;
    const item = {
      kind, id, revision: 1, name, archived: false, createdAt, updatedAt: createdAt, source: { namespace: kind }, payload,
      ...(art ? { preview: { assetId: `a-${id}`, role: extra.role ?? 'original', cacheKey: id, mimeType: 'image/svg+xml', width: art.w, height: art.h } } : {}),
    } as unknown as AssetItem;
    rows.push({ item, art, user: extra.user ?? [], search: `${name}\n${extra.search ?? ''}`.toLowerCase(), mb: extra.mb ?? 0, files: extra.files ?? (art ? 1 : 0) });
  };

  // History h1…h40
  const dayCount = [0, 0, 0, 0];
  const groupIndex: Record<string, number> = {};
  PLAN.forEach(([day, theme, group, size, mode], i) => {
    const g = GROUPS.find(value => value.id === group)!;
    const [w, h] = SIZES[size];
    const created = localDay(now, day, TIMES[day][dayCount[day]++] ?? '12:00');
    const id = `h${i + 1}`;
    const name = `${group === 'manual' ? 'nai' : g.name[1]}_${DAY_STAMPS[day]}_${pad(i + 1)}`;
    const seed = 1844674 + i * 99173;
    const art: Art = { seed: 1000 + i * 37, theme, w, h };
    const batchId = GROUP_BATCH[group];
    const itemIndex = batchId ? (groupIndex[group] = (groupIndex[group] ?? -1) + 1) : 0;
    const user = i === 0 || i === 4 ? ['c1', 'c2'] : i === 2 ? ['c1'] : [];
    if ([0, 2, 4, 9, 24].includes(i) && !user.includes('c2')) user.push('c2');
    const payload: Record<string, any> = {
      id, filePath: `/fixture/${name}.png`, fileUrl: captureArt(art.seed, w, h, theme), date: dateText(created), createdAt: iso(created),
      ...(group !== 'manual' ? { groupId: group } : {}),
      params: { model: MODEL, stylePrompt: STYLE, positivePrompt: PROMPTS[theme], negativePrompt: NEG, width: w, height: h, steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', seed, seedMode: 'fixed', ucPreset: 0, qualityPreset: 'standard', qualityToggle: true, transparentBackground: false, variety: false, smea: false, smeaDyn: false, fileNamePrefix: '' },
      actualSeed: seed, model: MODEL, width: w, height: h,
      ...(batchId ? { generationOrigin: { jobId: `job-${batchId}-${itemIndex}`, mode, originWorkspaceId: 'fixture', submittedRevision: 1, actualSeed: seed }, queueOrigin: { batchId, requestKey: `fixture-${batchId}`, itemIndex } } : {}),
      ...(theme === 'library' ? { characterSnapshot: { version: 1, captions: LIBRARY_CHARACTERS.map(prompt => ({ prompt, negativePrompt: '', useCoords: false, x: 0.5, y: 0.5 })) } } : {}),
      ...(i < 7 ? { annotation: { customTags: ['cafe', 'v2'] } } : {}),
    };
    add('history', id, name, iso(created), payload, { art, user, search: `${PROMPTS[theme]}\n${STYLE}`, mb: 2.1 + (i % 5) * 0.37 });
  });

  // Imported images s1…s6
  IMPORTS.forEach((value, i) => {
    const created = iso(nowMs - (i + 1) * 26 * HOUR);
    const byteLength = Math.round((value.mimeType === 'image/png' ? 1.6 : 0.4) * MIB) + i * 7919;
    add('study', value.id, value.name, created, {
      schemaVersion: 1, parserVersion: 1,
      study: { id: value.id, revision: 1, name: value.name, sha256: fakeHex(value.name), mimeType: value.mimeType, width: value.w, height: value.h, byteLength, sourceUrl: '', sourceAuthor: '', createdAt: created, updatedAt: created, archived: false, metadataStatus: value.meta ? 'generation' : 'missing', metadataKind: value.meta ? 'novelai' : '', sources: [], warnings: [], promptFieldCount: value.meta ? 2 : 0, parameterFieldCount: value.meta ? 9 : 0 },
      notes: '', previewSha256: fakeHex(`preview:${value.name}`), previewByteLength: 48_000 + i * 1031,
    }, { art: { seed: 5000 + i * 53, theme: value.theme, w: value.w, h: value.h }, search: value.name, mb: byteLength / MIB });
  });

  // Tags t1…t16
  const materials = new Map<string, MaterialEntry>();
  TAGS.forEach(([text, postCount, target, theme], i) => {
    const id = `t${i + 1}`, created = iso(nowMs - (10 + i) * DAY), cover = i % 5 !== 3;
    const entry: MaterialEntry = {
      schemaVersion: 1, id, revision: 1, kind: 'tag', name: text, group: '', notes: i === 0 ? L(SMILE_NOTE) : '', archived: false, createdAt: created, updatedAt: created,
      tag: { text, source: 'danbooru', category: 'general', target, evidence: { checkedAt: created, canonicalName: text, resolution: 'canonical', tagStatus: 'found', category: 'general', postCount, deprecated: false, aliasStatus: 'checked', wiki: { status: 'found', body: `The general tag "${text}".` }, sources: ['danbooru'] } },
    };
    materials.set(id, entry);
    add('tag', id, text, created, entry as unknown as Record<string, any>, { ...(cover ? { art: { seed: 7000 + i * 31, theme, w: 1024, h: 1024 }, role: 'cover' } : {}), search: entry.notes, mb: cover ? 0.3 : 0 });
  });
  // Combos m1…m6
  COMBOS.forEach((value, i) => {
    const created = iso(nowMs - (8 + i) * DAY);
    const entry: MaterialEntry = { schemaVersion: 1, id: value.id, revision: 1, kind: 'combo', name: L(value.name), group: '', notes: '', archived: false, createdAt: created, updatedAt: created, components: parseComponents(value.text) };
    materials.set(value.id, entry);
    add('combo', value.id, entry.name, created, entry as unknown as Record<string, any>, { search: value.text });
  });
  // Notes n1…n5
  NOTES.forEach((value, i) => {
    const created = iso(nowMs - (5 + i) * DAY);
    const entry: MaterialEntry = { schemaVersion: 1, id: value.id, revision: 1, kind: 'note', name: L(value.name), group: '', notes: L(value.text), archived: false, createdAt: created, updatedAt: created };
    materials.set(value.id, entry);
    add('note', value.id, entry.name, created, entry as unknown as Record<string, any>, { search: entry.notes });
  });
  // Presets p1…p9
  PRESETS.forEach((value, i) => {
    const created = iso(nowMs - (20 + i) * DAY), name = L(value.name);
    const art: Art | undefined = value.theme ? { seed: 9000 + i * 29, theme: value.theme, w: value.sub === 'reference' ? 832 : 1024, h: value.sub === 'reference' ? 1216 : 1024 } : undefined;
    if (value.sub === 'style') add('style_preset', value.id, name, created, { id: value.id, name, prompt: value.text, group: '', createdAt: created }, { art, role: 'preview', search: value.text, mb: 0.6 });
    else if (value.sub === 'positive') add('positive_preset', value.id, name, created, { id: value.id, name, prompt: value.text, createdAt: created }, { search: value.text });
    else if (value.sub === 'chunk') add('prompt_chunk', value.id, name, created, { id: value.id, name, content: value.text, createdAt: created, updatedAt: created }, { search: value.text });
    else {
      const vibe = value.id === 'p8';
      add('reference_preset', value.id, name, created, {
        id: value.id, name, group: '', kind: vibe ? 'vibe' : 'precise', filePath: `/fixture/${value.id}.png`, fileUrl: captureArt(art!.seed, art!.w, art!.h, art!.theme), createdAt: created,
        infoExtracted: 1, strength: vibe ? 0.6 : 0.8, preciseType: 'character', fidelity: vibe ? 1 : 0.9, informationExtracted: 1, width: art!.w, height: art!.h,
      }, { art, mb: 1.2 });
    }
  });
  // Artist favorites a1…a8
  ARTISTS.forEach(([text, theme], i) => {
    const id = `a${i + 1}`, created = iso(nowMs - (30 + i) * DAY);
    const artists = text.split(',').map(part => part.trim()).filter(part => part.startsWith('artist:')).map(part => ({ name: part.slice('artist:'.length), weight: 1 }));
    add('artist_favorite', id, text, created, { collection: 'random', id, artists, prompt: text, basePrompt: '' }, { art: { seed: 9500 + i * 23, theme, w: 1024, h: 1024 }, role: 'preview', search: text });
  });

  const byKey = new Map(rows.map(row => [`${row.item.kind}:${row.item.id}`, row]));
  const rowOf = (kind: unknown, id: unknown) => byKey.get(`${String(kind)}:${String(id)}`);
  const collectionName = (collectionId: string) => {
    const [namespace, id] = collectionId.split(':');
    const source = namespace === 'user' ? COLLECTIONS : GROUPS;
    const found = source.find(value => value.id === id);
    return found ? L(found.name) : id;
  };
  const inCollection = (row: Row, collectionId: string) => {
    const [namespace, id] = collectionId.split(':');
    if (namespace === 'user') return row.user.includes(id);
    if (namespace === 'history') return row.item.kind === 'history' && row.item.payload.groupId === id;
    return false;
  };
  const displayTotal = (collectionId: string) => {
    const [namespace, id] = collectionId.split(':');
    return (namespace === 'user' ? COLLECTIONS : GROUPS).find(value => value.id === id)?.count;
  };

  function list(args: Record<string, any>) {
    const kinds: AssetKind[] | undefined = Array.isArray(args.kinds) && args.kinds.length ? args.kinds : undefined;
    const collectionId = typeof args.collectionId === 'string' ? args.collectionId : undefined;
    const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
    let matched = rows.filter(row => (!kinds || kinds.includes(row.item.kind))
      && (!collectionId || inCollection(row, collectionId))
      && (!query || row.search.includes(query))
      && (!args.queueBatchId || row.item.payload.queueOrigin?.batchId === args.queueBatchId));
    const direction = args.sortDirection === 'asc' ? 1 : -1;
    const sortBy = args.sortBy === 'name' ? 'name' : args.sortBy === 'createdAt' ? 'createdAt' : 'updatedAt';
    matched = [...matched].sort((a, b) => sortBy === 'name'
      ? (args.sortDirection === 'desc' ? -1 : 1) * a.item.name.localeCompare(b.item.name)
      : direction * (Date.parse(a.item[sortBy]) - Date.parse(b.item[sortBy])));
    let total = matched.length;
    if (!query && !args.queueBatchId) {
      if (collectionId) { if (!kinds || kinds.includes('history')) total = Math.max(total, displayTotal(collectionId) ?? total); }
      else total = Math.max(total, (kinds ?? (Object.keys(KIND_TOTALS) as AssetKind[])).reduce((sum, kind) => sum + (KIND_TOTALS[kind] ?? 0), 0));
    }
    const offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Number(args.limit) || 100);
    return { items: matched.slice(offset, offset + limit).map(row => row.item), total, offset, limit, hasMore: false, revision: 1 };
  }

  const memberships = (row: Row) => row.user.map(collectionId => ({ namespace: 'user', collectionId, kind: row.item.kind, id: row.item.id }));
  const receiptRow = (row: Row): ReceiptRow & { archived: boolean } => ({
    kind: row.item.kind, id: row.item.id, revision: row.item.revision, name: row.item.name, archived: false,
    files: { moved: row.files, kept: 0, missing: 0 }, bytes: { moved: Math.round(row.mb * MIB), unknownSize: 0 },
    impacts: { collections: row.user.map(id => ({ collectionId: `user:${id}`, name: collectionName(`user:${id}`) })), coversCleared: [], recipes: [], referencedBy: [], sharedFiles: [] },
  });
  const totalsOf = (deleted: ReceiptRow[]) => ({
    entries: deleted.length,
    files: { moved: deleted.reduce((s, r) => s + (r.files?.moved ?? 0), 0), kept: deleted.reduce((s, r) => s + (r.files?.kept ?? 0), 0), missing: 0 },
    bytes: { moved: deleted.reduce((s, r) => s + (r.bytes?.moved ?? 0), 0), unknownSize: 0 },
  });
  let trashCounter = 0;

  // The archived sample items (prototype 07): 7 images, 3 tags, 2 style presets; only delete-archived and delete name them.
  const archivedRows: Array<ReceiptRow & { archived: boolean }> = (() => {
    const tagNames = ['chromatic aberration', 'film grain', 'motion blur'];
    const presetNames: Pair[] = [['旧粉彩', 'Old pastel'], ['颗粒测试', 'Grain test']];
    const historyMb = [2.9, 3.1, 2.7, 3.3, 2.8, 3.0, 2.5];
    return [
      ...historyMb.map((mb, i) => ({ kind: 'history' as AssetKind, id: `ha${i + 1}`, name: `nai_1028_${pad(i + 1)}`, mb, files: 1, colls: i < 2 })),
      ...tagNames.map((name, i) => ({ kind: 'tag' as AssetKind, id: `ta${i + 1}`, name, mb: 0, files: 0, colls: false })),
      ...presetNames.map((name, i) => ({ kind: 'style_preset' as AssetKind, id: `pa${i + 1}`, name: L(name), mb: 0.65, files: 1, colls: false })),
    ].map(value => ({
      kind: value.kind, id: value.id, revision: 1, name: value.name, archived: true,
      files: { moved: value.files, kept: 0, missing: 0 }, bytes: { moved: Math.round(value.mb * MIB), unknownSize: 0 },
      impacts: { collections: value.colls ? [{ collectionId: 'user:c1', name: collectionName('user:c1') }] : [], coversCleared: [], recipes: [], referencedBy: [], sharedFiles: [] },
    }));
  })();
  const archivedTotal = Math.max(archivedRows.length, Math.floor(Number(options.archivedTotal) || 0));
  // More archived images than the sample's 12 (清空已归档 of a larger library).
  for (let i = archivedRows.length; i < archivedTotal; i++) archivedRows.push({ kind: 'history', id: `hx${i + 1}`, revision: 1, name: `nai_1027_${String(i + 1).padStart(3, '0')}`, archived: true,
    files: { moved: 1, kept: 0, missing: 0 }, bytes: { moved: Math.round((2.4 + (i % 7) / 10) * MIB), unknownSize: 0 }, impacts: { collections: [], coversCleared: [], recipes: [], referencedBy: [], sharedFiles: [] } });
  const archivedByKey = new Map(archivedRows.map(row => [`${row.kind}:${row.id}`, row]));

  function deleteItems(args: Record<string, any>): DeleteReceipt & { revision: number } {
    const preview = args.preview === true;
    if (typeof args.collectionId === 'string') {
      const members = displayTotal(args.collectionId) ?? 0;
      return { preview, deleted: [], collections: [{ collectionId: args.collectionId, name: collectionName(args.collectionId), members, ...(preview ? {} : { trashId: `x-new-${++trashCounter}` }) }], revision: 1 } as DeleteReceipt & { revision: number };
    }
    const refs: Array<{ kind?: string; id?: string }> = Array.isArray(args.items) ? args.items : [];
    const selected: Row[] = refs.map(ref => rowOf(ref?.kind, ref?.id)).filter((row: Row | undefined): row is Row => !!row);
    const deleted = [...selected.map(receiptRow), ...refs.map(ref => archivedByKey.get(`${ref?.kind}:${ref?.id}`)).filter((row): row is ReceiptRow & { archived: boolean } => !!row).map(row => ({ ...row, impacts: { ...row.impacts } }))];
    const coverScene = selected.length >= 6 && selected.every(row => row.item.kind === 'history' && /^h[1-7]$/.test(row.item.id));
    if (coverScene) {
      // Prototype screen 06: one file shared with another image, two recipes, one tag cover.
      const kept = deleted[deleted.length - 1];
      kept.files = { moved: 0, kept: 1, missing: 0 }; kept.bytes = { moved: 0, unknownSize: 0 };
      kept.impacts!.sharedFiles = [{ role: 'original', usedBy: ['history:h40'] }];
      deleted[0].impacts!.recipes = [{ recipeId: 'r1', recipeRevision: 1, sourceRevision: 1 } as { recipeId: string }];
      deleted[1].impacts!.recipes = [{ recipeId: 'r2', recipeRevision: 1, sourceRevision: 1 } as { recipeId: string }];
      deleted[0].impacts!.coversCleared = [{ kind: 'tag', id: 't5', name: 'cafe interior' }];
      const moving = deleted.filter(row => row !== kept), natural = moving.reduce((s, r) => s + (r.bytes?.moved ?? 0), 0);
      for (const row of moving) row.bytes = { moved: Math.round(((row.bytes?.moved ?? 0) / natural) * 15.6 * MIB), unknownSize: 0 };
    }
    if (!preview) for (const row of deleted) row.trashId = `x-new-${++trashCounter}`;
    return { preview, deleted, totals: totalsOf(deleted), revision: 1 };
  }

  /** As the host: the receipt lists the archived rows it has room for; in a preview remaining counts every archived item. */
  function deleteArchived(args: Record<string, any>): DeleteReceipt & { revision: number } {
    const preview = args.preview === true;
    const deleted: ReceiptRow[] = archivedRows.map((row, i) => ({ ...row, ...(preview ? {} : { trashId: `x-arch-${i + 1}` }) }));
    const handled = Math.min(archivedTotal, 500);
    return { preview, deleted, ...(handled > deleted.length ? { omitted: { count: handled - deleted.length } } : {}), totals: { ...totalsOf(deleted), entries: handled }, remaining: preview ? archivedTotal : archivedTotal - handled, revision: 1 };
  }

  const trash: TrashEntry[] = TRASH.map(value => {
    const deletedMs = nowMs - (RETENTION_DAYS - value.left) * DAY - value.offsetMs;
    const kind = value.kind === 'preset' ? 'style_preset' : value.kind;
    const name = typeof value.name === 'string' ? value.name : L(value.name);
    const deletedBy: TrashEntry['deletedBy'] = value.by === 'you' ? { kind: 'user' } : { kind: 'agent', client: { name: AGENT_CLIENTS[value.by as Exclude<AgentKey, 'manual'>], version: null } };
    const common = { trashId: value.id, revision: 1, name, deletedAt: iso(deletedMs), expiresAt: iso(deletedMs + RETENTION_DAYS * DAY), deletedBy };
    if (kind === 'collection') return { ...common, kind, collectionId: 'user:c-old', members: value.impact.members ?? 0, files: { moved: 0, kept: 0, missing: 0 }, bytes: { moved: 0, unknownSize: 0 } };
    return {
      ...common, kind, id: `${value.id}-item`,
      files: { moved: value.files, kept: 0, missing: 0 }, bytes: { moved: Math.round(value.mb * MIB), unknownSize: 0 },
      impacts: { collections: value.impact.collections ?? 0, coversCleared: value.impact.coversCleared ?? 0, recipes: value.impact.recipes ?? 0, referencedBy: 0, sharedFiles: 0 },
    };
  });

  /** The window's ui-list (oss/lib-1103) on the sample: the same filters as the host (image-facts.ts) and its summary. */
  function uiList(args: Record<string, any>) {
    if (args.archived === 'only') return { items: [], total: 0, offset: 0, limit: Number(args.limit) || 100, hasMore: false, revision: 1, ...(args.summary ? { summary: { days: [], models: [], agents: [], months: [] } } : {}) };
    const base = list({ ...args, offset: 0, limit: 10_000 }) as { items: AssetItem[]; total: number };
    const filters: ImageFilterArgs = { mode: args.mode, model: args.model, source: args.source, createdFrom: args.createdFrom, createdBefore: args.createdBefore };
    const facts = batchFactsOf(batches);
    const filtered = base.items.filter(item => factsMatch(imageFacts(item), filters, facts));
    const narrowed = !!(args.mode || args.model || args.source || args.createdFrom !== undefined || args.createdBefore !== undefined);
    const offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Number(args.limit) || 100);
    const total = narrowed ? filtered.length : base.total;
    const count = (values: Map<string, number>, value: string) => values.set(value, (values.get(value) ?? 0) + 1);
    const days = new Map<string, number>(), models = new Map<string, number>(), agents = new Map<string, number>(), months = new Map<string, number>();
    for (const item of filtered) if (item.kind === 'history' || item.kind === 'study') count(days, localDayKey(imageFacts(item).createdAt));
    for (const item of base.items) {
      const value = imageFacts(item), model = modelOfFacts(value), source = sourceOfFacts(value, facts);
      if (model) count(models, model);
      if (source.kind === 'agent' && source.label !== 'Agent') count(agents, source.label);
      if (item.kind === 'history' || item.kind === 'study') { const day = localDayKey(value.createdAt); if (day !== 'unknown') count(months, day.slice(0, 7)); }
    }
    const ordered = (values: Map<string, number>) => [...values.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      items: filtered.slice(offset, offset + limit), total, offset, limit, hasMore: false, revision: 1,
      ...(args.summary ? { summary: {
        // The sample's headings count the images the prototype shows each day.
        days: [...days.entries()].map(([day, value]) => ({ day, count: value })),
        models: ordered(models).map(([model, value]) => ({ model, count: value })), agents: ordered(agents).map(([label, value]) => ({ label, count: value })),
        months: [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([month, value]) => ({ month, count: value })),
      } } : {}),
    };
  }

  const assetLibrary = async (args: Record<string, any>): Promise<any> => {
    switch (args?.action) {
      case 'list': return list(args);
      case 'ui-list': return uiList(args);
      case 'ui-archived': return { items: archivedRows.map(row => ({ kind: row.kind, id: row.id, revision: row.revision, name: row.name })), total: archivedRows.length, revision: 1 };
      case 'ui-trash-totals': return {
        entries: trash.length, collections: trash.filter(entry => entry.kind === 'collection').length,
        files: { moved: trash.reduce((sum, entry) => sum + (entry.files?.moved ?? 0), 0), kept: 0, missing: 0 },
        bytes: { moved: trash.reduce((sum, entry) => sum + (entry.bytes?.moved ?? 0), 0), unknownSize: 0 },
      };
      case 'collections': return {
        collections: [
          ...COLLECTIONS.map(value => ({ id: `user:${value.id}`, name: L(value.name), namespace: 'user', revision: 1 })),
          ...GROUPS.filter(value => value.id !== 'manual').map(value => ({ id: `history:${value.id}`, name: L(value.name), namespace: 'history', revision: 1 })),
        ],
        revision: 1,
      };
      case 'read': case 'ui-read': {
        const row = rowOf(args.kind, args.id);
        if (!row) throw new Error(`Not found: ${String(args.kind)}:${String(args.id)}`);
        const assets = row.art ? [{ id: `a-${row.item.id}`, role: 'original', fileUrl: captureArt(row.art.seed, row.art.w, row.art.h, row.art.theme), mimeType: 'image/svg+xml', ...(row.mb ? { byteLength: Math.round(row.mb * MIB) } : {}) }] : [];
        return { item: row.item, assets, links: [], memberships: memberships(row) };
      }
      case 'thumbnail': {
        const row = rowOf(args.kind, args.id);
        if (!row?.art) throw new Error('No preview');
        return { status: 'ready', cacheKey: row.item.id, dataUrl: captureArt(row.art.seed, Math.round(row.art.w / 2), Math.round(row.art.h / 2), row.art.theme) };
      }
      case 'recently-deleted': {
        const offset = Math.max(0, Number(args.offset) || 0), limit = Math.max(1, Number(args.limit) || 100);
        const page: TrashPage = { entries: trash.slice(offset, offset + limit), total: trash.length, offset, limit, hasMore: false, nextOffset: null, retentionDays: RETENTION_DAYS, revision: 1 };
        return page;
      }
      case 'mutate':
        if (args.command === 'delete') return deleteItems(args);
        if (args.command === 'delete-archived') return deleteArchived(args);
        if (['add-to-collection', 'remove-from-collection', 'archive', 'update', 'set-custom-tags'].includes(args.command)) return {};
        return NOT_AVAILABLE();
      case 'create-collection': case 'rename-collection': case 'restore': case 'purge': return {};
      default: return NOT_AVAILABLE();
    }
  };

  const materialLibrary = async (args: Record<string, any>): Promise<any> => {
    if (args?.action !== 'read') return NOT_AVAILABLE();
    const entry = materials.get(String(args.id));
    if (!entry) throw new Error(`Not found: ${String(args.id)}`);
    const hasCover = !!byKey.get(`${entry.kind}:${entry.id}`)?.art;
    return { entry: { ...entry, ...(hasCover ? { coverRevision: 1, cover: { sha256: fakeHex(`cover:${entry.id}`) }, coverStatus: 'ready' } : { coverRevision: 0, cover: null, coverStatus: 'none' }) } };
  };
  const sampleTheme = (entryId: unknown): ArtTheme => byKey.get(`tag:${String(entryId)}`)?.art?.theme ?? 'sakura';
  const materialSamples = async (args: Record<string, any>): Promise<any> => {
    if (args?.action === 'list') {
      const base = 7_100_000 + (Number(String(args.entryId).replace(/\D/g, '')) || 0) * 1000;
      return { entryId: args.entryId, entryRevision: 1, page: 1, limit: 6, minScore: 20, rating: 'g', hasMore: false, filteredCount: 0,
        items: Array.from({ length: 6 }, (_, i) => ({ postId: base + i * 17, rating: 'g', score: 180 - i * 23, sourceUrl: `https://danbooru.donmai.us/posts/${base + i * 17}` })) };
    }
    if (args?.action === 'image') {
      const postId = Number(args.postId) || 0;
      return { postId, mimeType: 'image/svg+xml', data: base64(captureArtSvg(postId % 100_000, 768, 1024, sampleTheme(args.entryId))), rating: 'g' };
    }
    return NOT_AVAILABLE();
  };

  const api: LibraryApi = { assetLibrary, materialLibrary, materialSamples, onAssetLibraryChange: () => () => {} };

  // Queue batches as BatchJob
  const historyByBatch = (batchId: string) => rows.filter(row => row.item.kind === 'history' && row.item.payload.queueOrigin?.batchId === batchId).map(row => row.item);
  const batches: BatchJob[] = BATCHES.map((value, b) => {
    const created = localDay(now, value.day, value.time).getTime();
    const images = historyByBatch(value.id);
    const terminal = ['succeeded', 'cancelled', 'blocked'].includes(value.status);
    const items: BatchItem[] = Array.from({ length: value.total }, (_, index) => {
      let status: BatchItem['status'] = 'pending';
      if (index < value.done) status = 'succeeded';
      else if (index < value.done + value.unknown) status = 'unknown';
      else if (index < value.done + value.unknown + value.failed) status = 'failed';
      else if (value.status === 'running' && index === value.done) status = 'running';
      else if (value.status === 'cancelled') status = 'cancelled';
      else if (value.status === 'blocked' || value.status === 'succeeded') status = 'skipped';
      const plannedSeed = 2_000_000 + b * 10_007 + index * 131;
      const started = status !== 'pending' && status !== 'skipped' && status !== 'cancelled';
      const image = status === 'succeeded' ? images[index] : undefined;
      return {
        index, plannedSeed, actualSeed: status === 'succeeded' ? plannedSeed : null, requestKey: `fixture-${value.id}-${index}`,
        jobId: started ? `job-${value.id}-${index}` : null, status,
        results: status === 'succeeded' ? [{ index: 0, id: image?.id ?? `${value.id}-${index}`, width: image?.payload.width ?? 832, height: image?.payload.height ?? 1216, model: MODEL, actualSeed: plannedSeed }] : [],
        error: status === 'failed' ? { code: 'provider_error', message: 'The provider refused the request.' } : status === 'unknown' ? { code: 'submission_unconfirmed', message: 'Whether the image was submitted could not be confirmed.' } : null,
      };
    });
    const source: BatchSource = value.agent === 'manual' ? { kind: 'manual', persistent: false } : { kind: 'agent', client: { name: AGENT_CLIENTS[value.agent], version: null } };
    const finished = created + Math.max(1, value.done + value.failed + value.unknown) * MINUTE;
    const error = value.halted ? { code: 'queue_halted', message: 'An earlier batch failed or has an unknown result; the agent batches after it are paused until resumed.' }
      : value.status === 'blocked' ? { code: 'recipe_source_missing', message: 'The source image was deleted, so this batch can’t continue.' } : null;
    return {
      batchId: value.id, workspaceId: 'fixture', originWorkspaceId: 'fixture', submittedRevision: 1, checkpointWorkspaceId: 'fixture', checkpointRevision: 1,
      requestKey: `fixture-${value.id}`, execution: 'queued', mode: value.mode, count: value.total, intervalSeconds: value.interval, seedMode: 'random',
      status: value.status, activeJobId: value.status === 'running' ? `job-${value.id}-${value.done}` : null, activeIndex: value.status === 'running' ? value.done : null,
      createdAt: iso(created), updatedAt: iso(value.status === 'running' ? Math.max(created, nowMs - MINUTE) : terminal ? finished : created),
      finishedAt: terminal ? iso(finished) : null, error, cancelRequested: false, items, source,
      // The project the agent enqueued into (the host adds output to listed batches; manual batches have none).
      ...(value.agent !== 'manual' ? (() => { const project = GROUPS.find(group => group.id === value.group)!; return { output: { historyGroup: L(project.name), historyGroupId: project.id, historyGroupName: L(project.name) } }; })() : {}),
    } as BatchJob;
  });

  const importFile = async () => {
    const png = encodeNovelAiPng(208, 304, { Software: 'NovelAI', Source: 'NovelAI Diffusion V4.5 4BDE2A90', Comment: JSON.stringify(IMPORT_COMMENT) });
    return new File([png as BlobPart], 'pixiv_reference_01.png', { type: 'image/png', lastModified: nowMs });
  };

  return { api, batches, importFile };
}
