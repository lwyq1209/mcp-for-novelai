// Builds a sample library in a NEW, EMPTY test data root with the client's own compiled repository
// (dist-electron/electron/library/repository.js), the way the migration notes recommend:
//   - the library is built in place at its final data root (records name their files by absolute path);
//   - repository opened with userDataRoot + libraryDirectory (study and cover files are projected as assets);
//   - every record is checked by validateLibraryPayload (history also by validateGeneratedHistoryPayload);
//   - revisions are continuous (a record with two revisions gets revision 1 and then 2);
//   - history groups (projects), style/reference groups and favourite collections are putCollection-ed with their
//     names before items join them (otherwise the repository names an implicit collection by its id);
//   - integrityCheck() at the end; Recently Deleted entries go through the client's own trash module.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from './cli.mjs';
import { checkDataRoot } from './guard.mjs';
import { hashString, placeholderPng } from './images.mjs';
import { buildOutputs, clientDir, clientRequire, dataPaths, missingBuildOutputs } from './paths.mjs';

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (min, max) => min + Math.floor(next() * (max - min + 1)), pick: list => list[Math.floor(next() * list.length)], chance: p => next() < p, uuid: () => { const bytes = Array.from({ length: 16 }, () => Math.floor(next() * 256)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.map(byte => byte.toString(16).padStart(2, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; } };
}

const pad = (value, length = 2) => String(value).padStart(length, '0');
const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes); return file; };
function folderSize(folder) {
  let bytes = 0, files = 0;
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.isFile()) { bytes += fs.statSync(full).size; files++; } } };
  if (fs.existsSync(folder)) walk(folder);
  return { bytes, files };
}

const MODELS = ['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-3'];
const SIZES = [[832, 1216], [1216, 832], [1024, 1024], [1024, 1536], [1536, 1024], [1088, 1920], [640, 640]];
const SUBJECTS = ['1girl, solo, school uniform, cherry blossoms', 'lighthouse, night sky, stars, ocean', 'cafe interior, warm light, coffee cup', 'cyberpunk city, neon, rain, reflections', 'forest path, morning fog, sunlight', 'cat, window sill, afternoon', 'knight, armor, castle, dramatic lighting', 'mountain lake, autumn, red leaves', 'witch, broom, full moon, night', 'robot, workshop, sparks', '1boy, hoodie, headphones, city', 'dragon, clouds, flying', 'still life, flowers, vase, watercolor', 'beach, summer, umbrella, blue sky', 'library, bookshelves, reading, cozy'];
const STYLES = ['', 'watercolor', 'oil painting, impasto', 'flat color, lineart', 'very aesthetic, masterpiece', 'pixel art', 'ink wash'];
const NEGATIVE = 'lowres, bad anatomy, bad hands, text, error, missing fingers, worst quality';
const GROUP_NAMES = ['Cafe Series', 'Night Scenes', 'Portraits', '风景练习', 'Agent Trials', 'Character Sheet'];
const AGENTS = [{ name: 'claude-code', version: '2.1.0' }, { name: 'codex', version: '0.9.1' }, { name: 'pi', version: '1.5.0' }];
const TAG_TEXTS = ['blue sky', 'smile', 'cherry blossoms', 'night sky', 'school uniform', 'sunlight', 'rain', 'reflection', 'watercolor', 'from above', 'looking at viewer', 'wind', 'stars', 'ocean', 'city lights', 'flower', 'red scarf', 'glasses', 'ponytail', 'twintails', 'hood up', 'backlighting', 'depth of field', 'soft lighting', 'cinematic lighting', 'close-up', 'wide shot', 'dutch angle', 'sitting', 'standing', 'holding umbrella', 'cat ears', 'hair ribbon', 'white dress', 'black jacket', 'autumn leaves', 'snow', 'sunset', 'neon lights', 'bokeh'];

/** Every option with its default. */
export const SEED_DEFAULTS = Object.freeze({ history: 200, tags: 40, combos: 12, notes: 8, stylePresets: 8, positivePresets: 5, chunks: 6, referencePresets: 4, favorites: 12, collections: 3, imports: 12, trash: 0, archivedRatio: 0.05, agentRatio: 0.3, imageScale: 8, seed: 20261104, days: 120, chunkSize: 1000 });

export async function seedLibrary(input) {
  const options = { ...SEED_DEFAULTS, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) };
  for (const key of ['history', 'tags', 'combos', 'notes', 'stylePresets', 'positivePresets', 'chunks', 'referencePresets', 'favorites', 'collections', 'imports', 'trash', 'imageScale', 'days', 'chunkSize']) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new ToolError('usage', `--${key} must be a non-negative integer.`);
  }
  if (options.history > 100_000) throw new ToolError('usage', '--history is at most 100000.');
  if (options.imageScale < 1) throw new ToolError('usage', '--image-scale is at least 1.');
  const missing = missingBuildOutputs(['repository']);
  if (missing.length) throw new ToolError('not_built', `The client main process is not built (${missing.join(', ')}). Run: npm --prefix novelai/client run build.`);
  const { dataRoot } = checkDataRoot(options.data, { requireEmpty: true, create: true });
  const timings = {};
  const phase = async (name, run) => { const started = performance.now(); const value = await run(); timings[name] = Math.round(performance.now() - started); return value; };
  const rng = random(options.seed);
  const now = options.now ? new Date(options.now) : new Date();
  const paths = dataPaths.dataPathsFor(dataRoot);
  const output = path.join(dataRoot, 'output');
  const libraryDirectory = paths.library;
  const { openLibraryRepository } = clientRequire(buildOutputs.repository);
  const { validateLibraryPayload, validateGeneratedHistoryPayload } = clientRequire(path.join(clientDir, 'dist-electron', 'electron', 'library', 'validation.js'));
  const sharp = clientRequire('sharp');
  const iso = date => new Date(date).toISOString();
  const counts = {};
  const count = (key, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };

  // ── History (files first: records name them by absolute path) ─────────────────────────────────────────────
  const groups = GROUP_NAMES.map((name, index) => ({ id: rng.uuid(), name, createdAt: iso(now.getTime() - (options.days + 5 - index) * 86400_000), folder: name.replace(/[^\p{L}\p{N}._-]+/gu, '_') }));
  const history = await phase('historyFiles', () => {
    const records = [];
    const perDay = new Map();
    for (let index = 0; index < options.history; index++) {
      // Newest first: a few per hour going back over `days`.
      const created = new Date(now.getTime() - Math.floor((index / Math.max(1, options.history)) * options.days * 86400_000) - rng.int(0, 3_000_000));
      const date = localDate(created);
      const roll = rng.next();
      const mode = roll < 0.6 ? 't2i' : roll < 0.7 ? 'i2i' : roll < 0.78 ? 'inpaint' : roll < 0.85 ? 'enhance' : roll < 0.93 ? 'upscale' : 'director';
      const agent = rng.chance(options.agentRatio);
      const group = rng.chance(0.55) ? rng.pick(groups) : null;
      const baseModel = rng.pick(MODELS);
      let [width, height] = rng.pick(SIZES);
      if (mode === 'upscale') { width *= 2; height *= 2; }
      if (mode === 'director' || mode === 'upscale') { width = Math.min(width, 2048); height = Math.min(height, 3072); }
      const fileWidth = Math.max(8, Math.round(width / options.imageScale)), fileHeight = Math.max(8, Math.round(height / options.imageScale));
      const seq = (perDay.get(date) ?? 0) + 1; perDay.set(date, seq);
      const model = mode === 'inpaint' ? `${baseModel === 'nai-diffusion-3' ? 'nai-diffusion-3' : baseModel}-inpainting` : mode === 'upscale' ? 'nai-diffusion-5-curated' : mode === 'director' ? `director-${rng.pick(['bg-removal', 'lineart', 'sketch', 'colorize', 'emotion', 'declutter'])}` : baseModel;
      const fileName = `${date}_${pad(seq, 3)}_${mode === 'upscale' ? 'upscale' : mode === 'director' ? model : baseModel}.png`;
      const filePath = path.join(output, date, ...(group ? [group.folder] : []), fileName);
      const id = rng.uuid();
      const actualSeed = rng.int(1, 2_147_483_646);
      const subject = rng.pick(SUBJECTS);
      const bytes = placeholderPng(fileWidth, fileHeight, { seed: hashString(id) });
      write(filePath, bytes);
      const postprocess = mode === 'upscale' || mode === 'director';
      const params = {
        promptAssemblyVersion: 1, model: postprocess ? 'nai-diffusion-5-full' : baseModel, stylePrompt: postprocess ? '' : rng.pick(STYLES),
        positivePrompt: mode === 'upscale' ? 'upscale' : mode === 'director' ? model : subject, negativePrompt: postprocess ? '' : NEGATIVE,
        width, height, steps: postprocess ? 28 : rng.pick([23, 28, 28, 28, 34]), cfgScale: rng.pick([5, 5.5, 6]), cfgRescale: 0, sampler: rng.pick(['k_euler_ancestral', 'k_euler_ancestral', 'k_dpmpp_2m_sde', 'k_euler']), noiseSchedule: 'karras',
        seed: postprocess ? 0 : actualSeed, seedMode: rng.chance(0.5) ? 'fixed' : 'random', ucPreset: rng.int(0, 3), qualityPreset: 'standard', qualityToggle: true, transparentBackground: false, smea: false, smeaDyn: false, variety: false, fileNamePrefix: '',
      };
      const batchId = agent ? `00000000-0000-4000-8000-${pad((Math.floor(index / 4) % 1e12).toString(16), 12)}` : null;
      const agentInfo = agent ? AGENTS[Math.floor(index / 4) % AGENTS.length] : null;
      const payload = {
        id, filePath, fileUrl: `nai-local://file/${encodeURIComponent(pathToFileURL(filePath).toString())}`, date, createdAt: iso(created), params, actualSeed: postprocess ? 0 : actualSeed, model, width, height,
        ...(group ? { groupId: group.id } : {}),
        ...(agent ? { generationOrigin: { jobId: `job-${batchId}-${index % 4}`, mode, originWorkspaceId: 'dev-tools-seed', submittedRevision: 1, actualSeed: postprocess ? null : actualSeed }, queueOrigin: { batchId, requestKey: `mcp-${agentInfo.name}-seed-${Math.floor(index / 4)}`, itemIndex: index % 4 } } : {}),
        ...(rng.chance(0.08) ? { annotation: { customTags: [rng.pick(['favorite pick', 'v2', 'needs fix', 'cover candidate']), rng.pick(['cafe', 'night', 'portrait', 'wip'])] } } : {}),
      };
      records.push({ id, payload, archived: rng.chance(options.archivedRatio), twoRevisions: rng.chance(0.05), group, bytes: bytes.length, mode, agent: agentInfo?.name ?? null });
    }
    return records;
  });
  count('history', history.length);

  // ── Imported images (studies), tag covers, reference preset files ─────────────────────────────────────────
  const studies = await phase('studyFiles', async () => {
    const list = [];
    for (let index = 0; index < options.imports; index++) {
      const id = rng.uuid(), [w, h] = rng.pick(SIZES), width = Math.round(w / 4), height = Math.round(h / 4);
      const original = placeholderPng(width, height, { seed: hashString(`study-${id}`), text: index % 2 ? { Comment: JSON.stringify({ prompt: rng.pick(SUBJECTS), steps: 28, scale: 5, seed: rng.int(1, 1e9), sampler: 'k_euler_ancestral', width: w, height: h }), Software: 'NovelAI' } : {} });
      const preview = await sharp(original).webp({ quality: 80 }).toBuffer();
      write(path.join(paths.studies, id, 'original.png'), original);
      write(path.join(paths.studies, id, 'preview.webp'), preview);
      const created = iso(now.getTime() - (index + 1) * 26 * 3600_000);
      const name = `reference-${pad(index + 1)}.png`;
      list.push({ id, created, name, payload: { schemaVersion: 1, parserVersion: 1, study: { id, revision: 1, name, sha256: sha256(original), mimeType: 'image/png', width, height, byteLength: original.length, sourceUrl: index % 3 === 0 ? `https://example.invalid/post/${1000 + index}` : '', sourceAuthor: index % 3 === 0 ? 'sample author' : '', createdAt: created, updatedAt: created, archived: false, metadataStatus: 'missing', metadataKind: 'unknown', sources: [], warnings: [], promptFieldCount: 0, parameterFieldCount: 0 }, notes: index === 0 ? 'Imported by dev-tools seed-library.' : '', originalName: name, previewSha256: sha256(preview), previewByteLength: preview.length, sections: { prompts: [], parameters: [], raw: {} } } });
    }
    return list;
  });
  count('imports', studies.length);

  const tags = await phase('tagFiles', async () => {
    const list = [];
    for (let index = 0; index < options.tags; index++) {
      const text = index < TAG_TEXTS.length ? TAG_TEXTS[index] : `${rng.pick(TAG_TEXTS)} ${index}`;
      const id = rng.uuid(), created = iso(now.getTime() - (10 + index) * 86400_000);
      let cover = null;
      if (index % 4 !== 3) {
        const source = placeholderPng(96, 96, { seed: hashString(`cover-${text}`) });
        const bytes = await sharp(source).webp({ quality: 84 }).toBuffer();
        const digest = sha256(bytes);
        write(path.join(libraryDirectory, 'covers', `${digest}.webp`), bytes);
        cover = { sha256: digest, mimeType: 'image/webp', width: 96, height: 96, byteLength: bytes.length, tagText: text, tagCategory: null, savedAt: created, source: 'local', fileName: `${text.replace(/\W+/g, '_')}.png`, sourceSha256: sha256(source), tagSource: 'english', postId: null, sourceUrl: null, verification: 'local', checkedAt: null, rating: null };
      }
      const target = index % 5 === 0 ? 'style' : index % 7 === 0 ? 'character' : 'base';
      const entry = revision => ({ kind: 'tag', name: text, group: index % 3 === 0 ? 'Lighting' : '', notes: revision === 2 ? 'Second revision: notes refined.' : index === 0 ? 'Works well with soft lighting.' : '', tag: { text, source: index % 6 === 5 ? 'nai' : 'english', category: null, target }, schemaVersion: 1, id, revision, archived: false, createdAt: created, updatedAt: iso(Date.parse(created) + revision * 3600_000) });
      list.push({ id, text, entry, revisions: index % 10 === 0 ? 2 : 1, archived: index % 17 === 16, cover });
    }
    return list;
  });
  count('tags', tags.length);

  const referenceFiles = await phase('referenceFiles', () => Array.from({ length: options.referencePresets }, (_, index) => {
    const id = `rp-${pad(index + 1)}`, bytes = placeholderPng(128, 128, { seed: hashString(id) });
    return { id, file: write(path.join(dataRoot, 'reference-presets', `${id}.png`), bytes) };
  }));

  // ── The library ────────────────────────────────────────────────────────────────────────────────────────────
  const repo = openLibraryRepository({ filePath: paths.libraryDatabase, userDataRoot: dataRoot, libraryDirectory });
  const put = (kind, id, payload, meta) => { validateLibraryPayload(kind, payload); return repo.put(kind, id, payload, meta); };
  let strictRefusals = 0;
  const userCollections = [];
  try {
    await phase('collections', () => repo.transaction(() => {
      for (const group of groups) repo.putCollection({ namespace: 'history', id: group.id, name: group.name, payload: { id: group.id, name: group.name, createdAt: group.createdAt } });
      for (const name of ['Default', 'Painterly', 'Lineart']) repo.putCollection({ namespace: 'style', id: name, name, payload: {} });
      for (const name of ['Characters', 'Scenes']) repo.putCollection({ namespace: 'reference', id: name, name, payload: {} });
      for (const name of ['random', 'v5-repair', 'artist-string-draw']) repo.putCollection({ namespace: 'artist-favorites', id: name, name, payload: {} });
      for (let index = 0; index < options.collections; index++) {
        const id = rng.uuid(), name = ['Favourites', 'For the cover', 'Client picks', 'Mood board', 'Later'][index % 5] + (index >= 5 ? ` ${index}` : '');
        repo.putCollection({ namespace: 'user', id, name, payload: {} });
        userCollections.push({ id, name });
      }
    }));

    await phase('historyRecords', () => {
      for (let start = 0; start < history.length; start += Math.max(1, options.chunkSize)) {
        repo.transaction(() => {
          for (const record of history.slice(start, start + Math.max(1, options.chunkSize))) {
            try { validateGeneratedHistoryPayload(record.payload); } catch { strictRefusals++; }
            const meta = { name: path.basename(record.payload.filePath), createdAt: record.payload.createdAt, updatedAt: record.payload.createdAt, source: { namespace: 'history', legacyId: record.id } };
            if (record.twoRevisions) {
              put('history', record.id, record.payload, { ...meta, revision: 1, archived: false });
              put('history', record.id, { ...record.payload, annotation: { customTags: ['revised'] } }, { ...meta, revision: 2, archived: record.archived, updatedAt: iso(Date.parse(record.payload.createdAt) + 600_000) });
            } else put('history', record.id, record.payload, { ...meta, revision: 1, archived: record.archived });
          }
        });
      }
    });

    await phase('materialRecords', () => repo.transaction(() => {
      for (const tag of tags) {
        for (let revision = 1; revision <= tag.revisions; revision++) {
          const entry = tag.entry(revision);
          put('tag', tag.id, { ...entry, archived: tag.archived && revision === tag.revisions }, { revision, name: tag.text, archived: tag.archived && revision === tag.revisions, createdAt: entry.createdAt, updatedAt: entry.updatedAt, source: { namespace: 'tag', legacyId: tag.id } });
        }
        if (tag.cover) repo.setCover('tag', tag.id, tag.cover, { coverRevision: 1 });
      }
      count('tagCovers', tags.filter(tag => tag.cover).length);
      for (let index = 0; index < options.combos; index++) {
        const id = rng.uuid(), created = iso(now.getTime() - (8 + index) * 86400_000);
        const parts = [tags[index % Math.max(1, tags.length)], tags[(index * 3 + 1) % Math.max(1, tags.length)]].filter(Boolean);
        const components = parts.map((tag, position) => ({ text: tag.text, source: 'english', weight: position ? 1 : 1.1, target: 'base', entryId: tag.id, entryRevision: tag.revisions }));
        if (!components.length) components.push({ text: 'blue sky', source: 'english', weight: 1, target: 'base' });
        const name = `Combo ${pad(index + 1)} · ${components.map(component => component.text).join(' + ')}`;
        put('combo', id, { kind: 'combo', name, group: '', notes: '', components, schemaVersion: 1, id, revision: 1, archived: false, createdAt: created, updatedAt: created }, { revision: 1, name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'combo', legacyId: id } });
      }
      count('combos', options.combos);
      for (let index = 0; index < options.notes; index++) {
        const id = rng.uuid(), created = iso(now.getTime() - (5 + index) * 86400_000), name = `Note ${pad(index + 1)}`;
        put('note', id, { kind: 'note', name, group: index % 2 ? 'Prompting' : '', notes: `Sample prompt-writing note ${index + 1}: keep the subject first, then the setting, then lighting.`, schemaVersion: 1, id, revision: 1, archived: false, createdAt: created, updatedAt: created }, { revision: 1, name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'note', legacyId: id } });
      }
      count('notes', options.notes);
      for (const study of studies) put('study', study.id, study.payload, { revision: 1, name: study.name, archived: false, createdAt: study.created, updatedAt: study.created, source: { namespace: 'study', legacyId: study.id } });
      for (let index = 0; index < options.stylePresets; index++) {
        const id = `sp-${pad(index + 1)}`, created = iso(now.getTime() - (30 + index) * 3600_000), group = ['Default', 'Painterly', 'Lineart'][index % 3];
        const payload = { id, name: `Style ${pad(index + 1)}`, prompt: rng.pick(STYLES.filter(Boolean)), group, createdAt: created };
        put('style_preset', id, payload, { revision: 1, name: payload.name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'style_preset', legacyId: id, position: index } });
      }
      count('stylePresets', options.stylePresets);
      for (let index = 0; index < options.positivePresets; index++) {
        const id = `pp-${pad(index + 1)}`, created = iso(now.getTime() - (40 + index) * 3600_000);
        const payload = { id, name: `Positive ${pad(index + 1)}`, prompt: rng.pick(SUBJECTS), createdAt: created };
        put('positive_preset', id, payload, { revision: 1, name: payload.name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'positive_preset', legacyId: id, position: index } });
      }
      count('positivePresets', options.positivePresets);
      for (let index = 0; index < options.chunks; index++) {
        const id = `pc-${pad(index + 1)}`, created = iso(now.getTime() - (50 + index) * 3600_000);
        const payload = { id, name: `Chunk ${pad(index + 1)}`, content: rng.pick(['soft light', 'rim light', 'depth of field', 'film grain', 'bokeh', 'volumetric lighting']), createdAt: created, updatedAt: created };
        put('prompt_chunk', id, payload, { revision: 1, name: payload.name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'prompt_chunk', legacyId: id, position: index } });
      }
      count('promptChunks', options.chunks);
      referenceFiles.forEach(({ id, file }, index) => {
        const created = iso(now.getTime() - (60 + index) * 3600_000);
        const payload = { id, name: `Reference ${pad(index + 1)}`, group: index % 2 ? 'Scenes' : 'Characters', kind: 'precise', filePath: file, createdAt: created, infoExtracted: 1, strength: 1, preciseType: index % 2 ? 'style' : 'character', fidelity: 1, informationExtracted: 1, width: 128, height: 128 };
        put('reference_preset', id, payload, { revision: 1, name: payload.name, archived: false, createdAt: created, updatedAt: created, source: { namespace: 'reference_preset', legacyId: id, position: index } });
      });
      count('referencePresets', referenceFiles.length);
      // Seeded text-to-image records (not post tools, not agent images) that a pick can carry as its recipe.
      const recipeImages = history.filter(record => record.mode === 't2i' && !record.agent).slice(0, 4);
      for (let index = 0; index < options.favorites; index++) {
        const collection = ['random', 'v5-repair', 'artist-string-draw'][index % 3], id = `fav-${pad(index + 1)}`, created = iso(now.getTime() - (70 + index) * 3600_000);
        const artists = [{ name: `artist_${String.fromCharCode(97 + (index % 26))}`, weight: 1 }, ...(index % 2 ? [{ name: `artist_${String.fromCharCode(98 + (index % 24))}`, weight: 0.8 }] : [])];
        const payload = { collection, id, artists, auxiliary: [], mutations: [], franchiseStyles: [], basePrompt: '1girl, portrait', prompt: artists.map(artist => `artist:${artist.name}`).join(', '), pairId: `pair-${Math.floor(index / 2)}`, variant: index % 2 ? 'mutated' : 'plain', sequence: index + 1, status: 'done', liked: index % 3 !== 2 };
        // Every third pick (the first one included) has the complete recipe of a saved image (image, generationSeed,
        // generationModel), as a pick saved from a finished render has: the canvas can apply it.
        const recipe = index % 3 === 0 ? recipeImages[(index / 3) % Math.max(1, recipeImages.length)] : undefined;
        if (recipe) Object.assign(payload, { image: structuredClone(recipe.payload), generationSeed: recipe.payload.actualSeed, generationModel: recipe.payload.model });
        put('artist_favorite', `${collection}:${id}`, payload, { revision: 1, name: id, archived: false, createdAt: created, updatedAt: created, source: { namespace: `artist-favorites:${collection}`, legacyId: id, position: index } });
      }
      count('artistFavorites', options.favorites);
      // User collections (收藏夹): a few history images, tags and imports each.
      userCollections.forEach((collection, index) => {
        const members = [...history.filter((_, i) => i % (7 + index) === index).slice(0, 12).map(record => ['history', record.id]), ...tags.slice(index, index + 3).map(tag => ['tag', tag.id]), ...studies.slice(index, index + 2).map(study => ['study', study.id])];
        for (const [kind, id] of members) repo.setMembership({ namespace: 'user', collectionId: collection.id, kind, id });
        collection.members = members.length;
      });
      count('userCollections', userCollections.length);
    }));
    const integrity = await phase('integrityCheck', () => repo.integrityCheck());
    if (integrity !== 'ok') throw new ToolError('integrity_failed', `integrityCheck() reported: ${JSON.stringify(integrity)}`);
  } finally { repo.close(); }

  // ── Recently Deleted (through the client's trash module, as a deletion in the window would do) ─────────────────
  let trashed = 0;
  if (options.trash > 0) {
    await phase('trash', async () => {
      const { createLibraryTrash } = clientRequire(path.join(clientDir, 'dist-electron', 'electron', 'library-trash.js'));
      const trashRepo = openLibraryRepository({ filePath: paths.libraryDatabase, userDataRoot: dataRoot, libraryDirectory });
      try {
        const trash = createLibraryTrash({ repository: trashRepo, userDataRoot: dataRoot, libraryDirectory, managedRoots: () => [output], recipeReferences: async () => new Map(), log: () => undefined });
        const candidates = history.filter(record => !record.archived).filter((_, index) => index % 3 === 1).slice(0, options.trash);
        for (let start = 0; start < candidates.length; start += 50) {
          const batch = candidates.slice(start, start + 50);
          const byUser = Math.floor(start / 50) % 2 === 0;
          await trash.deleteItems(batch.map(record => ({ kind: 'history', id: record.id, expectedRevision: record.twoRevisions ? 2 : 1 })), { deletedBy: byUser ? { kind: 'user' } : { kind: 'agent', client: { name: 'claude-code', version: '2.1.0' } } });
          trashed += batch.length;
        }
        if (tags.length) { const tag = tags.find(value => !value.archived); if (tag) { await trash.deleteItems([{ kind: 'tag', id: tag.id, expectedRevision: tag.revisions }], { deletedBy: { kind: 'user' } }); trashed++; } }
        await trash.idle();
      } finally { trashRepo.close(); }
    });
  }
  count('recentlyDeleted', trashed);

  const sizes = { librarySqlite: fs.statSync(paths.libraryDatabase).size, output: folderSize(output), library: folderSize(libraryDirectory), trash: folderSize(path.join(dataRoot, 'trash')), total: folderSize(dataRoot) };
  const modes = history.reduce((map, record) => ({ ...map, [record.mode]: (map[record.mode] ?? 0) + 1 }), {});
  return {
    ok: true, dataRoot, counts, history: { modes, archived: history.filter(record => record.archived).length, agent: history.filter(record => record.agent).length, grouped: history.filter(record => record.group).length, twoRevisions: history.filter(record => record.twoRevisions).length, strictValidationRefusals: strictRefusals, imageScale: options.imageScale },
    projects: groups.map(group => ({ id: group.id, name: group.name, items: history.filter(record => record.group === group).length })),
    userCollections, timingsMs: { ...timings, total: Object.values(timings).reduce((sum, value) => sum + value, 0) }, sizes,
  };
}
