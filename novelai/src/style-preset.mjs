/**
 * A style preset as prepare_recipe uses it (issue #1): prepare_recipe {stylePresetId} reads the preset from the
 * library once and writes its style, its negative text and its recommended sampling settings into the call, so the
 * recipe that is frozen holds plain text and values and no link to the preset (a later edit of the preset changes no
 * recipe; a revision passes stylePresetId again and takes the preset as it is then).
 *
 * - Style: the enabled artists, then the preset's prompt, then the call's own stylePrompt, joined with ", ".
 *   An artist of weight 1 is written as its name, any other weight as weight::name:: (negative weights too).
 * - Negative: the preset's negativePrompt, then its textNegativePrompt (the text that keeps writing out of the image;
 *   left out with allowText:true, and only then: the prompts are never searched for speech bubbles), then the call's
 *   own negativePrompt.
 * - Sampling settings: a setting the preset recommends is used where the call has none; the call's own value wins.
 *
 * Pure functions; the one host read is readStylePreset (asset_library read, the method recipe sources already use).
 */
import { BridgeError } from './bridge-client.mjs';

/** The sampling settings a style preset may recommend (contracts StylePresetParamsSchema). */
export const STYLE_PRESET_PARAM_FIELDS = Object.freeze(['model', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule', 'ucPreset', 'qualityPreset']);
/** The fields a call may leave out when it names a style preset: the two texts always, a setting when the preset has it. */
export const STYLE_PRESET_TEXT_FIELDS = Object.freeze(['stylePrompt', 'negativePrompt']);
const NOTES_MAX = 600;

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** A part of a prompt without the blanks and commas around it ('' when nothing is left). */
const part = value => typeof value === 'string' ? value.replace(/^[\s,]+|[\s,]+$/g, '') : '';
/** Prompt parts joined with ", ", empty ones left out. */
export const joinPromptParts = (...parts) => parts.map(part).filter(Boolean).join(', ');

/** The artists of a preset that can be written: a name and a finite weight. */
const artistsOf = payload => (Array.isArray(payload?.artists) ? payload.artists : []).filter(artist => record(artist) && typeof artist.name === 'string' && part(artist.name) && Number.isFinite(artist.weight));
/** One artist as prompt text: the name at weight 1, else weight::name:: (the weight with at most four decimals). */
export function artistPromptText(artist) {
  const name = part(artist.name), weight = Number(artist.weight.toFixed(4));
  return weight === 1 ? name : `${weight}::${name}::`;
}
/** The style text of a preset: its enabled artists, then its prompt. */
export const stylePresetStyleText = payload => joinPromptParts(...artistsOf(payload).filter(artist => artist.enabled === true).map(artistPromptText), payload?.prompt);

/**
 * The call with the preset written into it. Returns {args, applied}: `args` are prepare_recipe arguments without
 * stylePresetId and allowText (what recipePlan validates and freezes), `applied` is the readback's stylePreset entry:
 * the texts as frozen, which negative parts took effect, the names of the settings taken from the preset (params) and
 * of the settings the preset recommends that the call wrote itself (overridden).
 */
export function applyStylePreset(args, item) {
  const payload = item.payload, allowText = args.allowText === true;
  const artists = artistsOf(payload), enabled = artists.filter(artist => artist.enabled === true);
  const stylePrompt = joinPromptParts(...enabled.map(artistPromptText), payload.prompt, args.stylePrompt);
  const styleNegative = part(payload.negativePrompt), textNegative = part(payload.textNegativePrompt), own = part(args.negativePrompt);
  const negativePrompt = joinPromptParts(styleNegative, allowText ? '' : textNegative, own);
  const recommended = record(payload.params) ? payload.params : {}, params = {}, overridden = [];
  for (const field of STYLE_PRESET_PARAM_FIELDS) {
    if (recommended[field] === undefined || recommended[field] === null) continue;
    if (Object.hasOwn(args, field)) overridden.push(field);
    else params[field] = recommended[field];
  }
  const { stylePresetId: _id, allowText: _allowText, ...rest } = args;
  const notes = typeof payload.notes === 'string' ? payload.notes.trim() : '';
  return {
    args: { ...rest, ...params, stylePrompt, negativePrompt },
    applied: {
      id: item.id, revision: item.revision, name: typeof item.name === 'string' && item.name ? item.name : payload.name,
      ...(item.archived === true ? { archived: true } : {}),
      stylePrompt, negativePrompt,
      ...(artists.length ? { artists: { used: enabled.length, off: artists.length - enabled.length } } : {}),
      ...(part(args.stylePrompt) ? { yourStylePrompt: 'appended' } : {}),
      negative: {
        style: styleNegative ? 'applied' : 'none',
        text: !textNegative ? 'none' : allowText ? 'skipped' : 'applied',
        ...(own ? { yours: 'appended' } : {}),
      },
      ...(Object.keys(params).length ? { params: Object.keys(params) } : {}),
      ...(overridden.length ? { overridden } : {}),
      ...(notes ? { notes: notes.length > NOTES_MAX ? `${notes.slice(0, NOTES_MAX)}…` : notes } : {}),
    },
  };
}

/**
 * The style preset `id` as the library holds it now: {id, revision, name, archived, payload}. Refused, with nothing
 * saved: an id that names no style preset (also one in Recently Deleted) and a reply that is not that preset.
 */
export async function readStylePreset(bridge, id, { signal, method = 'asset_library' } = {}) {
  const at = { field: 'stylePresetId', stylePresetId: id, saved: false };
  let reply;
  try { reply = await bridge.call(method, { action: 'read', kind: 'style_preset', id }, signal); }
  catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    const details = { ...at, ...(record(error.details) ? { hostDetails: error.details } : {}) };
    if (error.code === 'library_not_found') throw new BridgeError(error.code, `stylePresetId ${JSON.stringify(id)} is not a style preset in the library: ${error.message} asset_library list {kinds:["style_preset"]} gives the ids. Nothing was saved.`, { ...details, reason: 'style_preset_not_found' });
    throw new BridgeError(error.code, `The style preset ${JSON.stringify(id)} could not be read (${error.message}). Nothing was saved.`, details);
  }
  const item = reply?.item;
  if (!record(item) || item.kind !== 'style_preset' || item.id !== id || !Number.isSafeInteger(item.revision) || item.revision < 1 || !record(item.payload) || typeof item.payload.prompt !== 'string')
    throw new BridgeError('invalid_response', `The library did not return the style preset ${JSON.stringify(id)} as a complete record. Nothing was saved.`, at);
  return { id: item.id, revision: item.revision, name: item.name, archived: item.archived === true, payload: item.payload };
}
