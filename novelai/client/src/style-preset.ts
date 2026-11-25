import type { GenerateParams, StylePromptPreset } from './types';

/**
 * How a Style preset becomes prompt text and settings (issue #1), for the window: the canvas applies a preset with
 * these, and the library shows the result. The MCP server has the same rules for prepare_recipe stylePresetId
 * (novelai/src/style-preset.mjs); a test of the server compares the two on the same presets.
 *
 * - Style: the enabled artists, then the preset's prompt, joined with ", ". An artist of weight 1 is written as its
 *   name, any other weight as weight::name:: (negative weights too).
 * - Negative: the preset's negativePrompt, then its textNegativePrompt (the text that keeps writing out of the image),
 *   which is left out only when text is allowed.
 * - The artists are never written back into `prompt`: it holds the rest of the style.
 */
export type StylePresetArtist = NonNullable<StylePromptPreset['artists']>[number];
export type StylePresetParams = NonNullable<StylePromptPreset['params']>;
/** The sampling settings a Style preset may recommend, in the order they are applied (the model first). */
export const STYLE_PRESET_PARAM_FIELDS = ['model', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule', 'ucPreset', 'qualityPreset'] as const satisfies readonly (keyof GenerateParams)[];
export const STYLE_PRESET_ARTIST_LIMIT = 64;

/** A part of a prompt without the blanks and commas around it ('' when nothing is left). */
const part = (value: unknown) => typeof value === 'string' ? value.replace(/^[\s,]+|[\s,]+$/g, '') : '';
/** Prompt parts joined with ", ", empty ones left out. */
export const joinPromptParts = (...parts: unknown[]) => parts.map(part).filter(Boolean).join(', ');

type Styled = Pick<StylePromptPreset, 'prompt'> & Partial<Pick<StylePromptPreset, 'artists' | 'negativePrompt' | 'textNegativePrompt' | 'params'>>;
/** The artists of a preset that can be written: a name and a finite weight. */
const writable = (preset: Styled) => (Array.isArray(preset.artists) ? preset.artists : []).filter(artist => artist && typeof artist.name === 'string' && part(artist.name) && Number.isFinite(artist.weight));
/** One artist as prompt text: the name at weight 1, else weight::name:: (the weight with at most four decimals). */
export function artistPromptText(artist: Pick<StylePresetArtist, 'name' | 'weight'>) {
  const name = part(artist.name), weight = Number(artist.weight.toFixed(4));
  return weight === 1 ? name : `${weight}::${name}::`;
}
/** The style text of a preset: its enabled artists, then its prompt. */
export const stylePresetStyleText = (preset: Styled) => joinPromptParts(...writable(preset).filter(artist => artist.enabled === true).map(artistPromptText), preset.prompt);
/** The negative text of a preset: the style's own, then the text-suppressing part unless text is allowed. */
export const stylePresetNegativeText = (preset: Styled, allowText = false) => joinPromptParts(preset.negativePrompt, allowText ? '' : preset.textNegativePrompt);
/** The settings a preset recommends, as a patch of generation parameters in the order they are applied. */
export function stylePresetParamsPatch(preset: Styled): Partial<GenerateParams> {
  const recommended = (preset.params ?? {}) as Record<string, unknown>;
  return Object.fromEntries(STYLE_PRESET_PARAM_FIELDS.filter(key => recommended[key] !== undefined && recommended[key] !== null).map(key => [key, recommended[key]])) as Partial<GenerateParams>;
}
/**
 * What applying a preset to a recipe writes: the Style always; the negative prompt when the preset has negative text
 * that takes effect (a preset without any leaves the recipe's own); the recommended settings only when asked for.
 */
export function stylePresetApplication(preset: Styled, options: { withParams?: boolean; allowText?: boolean } = {}) {
  const negativePrompt = stylePresetNegativeText(preset, options.allowText === true);
  return { stylePrompt: stylePresetStyleText(preset), ...(negativePrompt ? { negativePrompt } : {}), params: options.withParams === true ? stylePresetParamsPatch(preset) : {} };
}
/** What a preset holds beside its style text, for the lists that show it. */
export const stylePresetHas = (preset: Styled) => ({
  artists: writable(preset).length, negative: Boolean(part(preset.negativePrompt)), textNegative: Boolean(part(preset.textNegativePrompt)), params: Object.keys(stylePresetParamsPatch(preset)).length,
});

/**
 * An artist list read out of a style text, for a preset made from an existing Style: every top-level part that is an
 * artist tag ("artist:name", also weighted as 1.2::artist:name:: or with one tag in braces or brackets) becomes an
 * artist; everything else stays, in its order, as the remaining prompt. A weighted group of several tags stays text.
 */
export function splitArtists(style: string): { artists: StylePresetArtist[]; prompt: string } {
  const artists: StylePresetArtist[] = [], rest: string[] = [];
  // A weighted group (weight::…::) is one part, whatever commas it holds; every other part ends at a comma.
  const pieces = style.match(/\s*-?\d*\.?\d+::[\s\S]*?::\s*|[^,]+/g) ?? [];
  for (const piece of pieces) {
    const text = piece.trim();
    if (!text) continue;
    const weighted = /^(-?\d*\.?\d+)::\s*(artist:[^,]+?)\s*::$/i.exec(text);
    const plain = /^artist:[^,:]+$/i.test(text);
    if (weighted && Number.isFinite(Number(weighted[1])) && artists.length < STYLE_PRESET_ARTIST_LIMIT) artists.push({ name: weighted[2], weight: Number(weighted[1]), enabled: true });
    else if (plain && artists.length < STYLE_PRESET_ARTIST_LIMIT) artists.push({ name: text, weight: 1, enabled: true });
    else rest.push(text);
  }
  return { artists, prompt: rest.join(', ') };
}

/** Negative tags that keep writing out of an image; a Style preset holds them apart (textNegativePrompt). */
const TEXT_NEGATIVE_TAGS = new Set(['text', 'no text', 'english text', 'japanese text', 'chinese text', 'korean text', 'speech bubble', 'thought bubble', 'dialogue', 'dialogue box', 'comic', 'manga', 'sound effects', 'signature', 'watermark', 'username', 'artist name', 'logo', 'subtitles', 'caption', 'text focus', 'copyright name', 'character name', 'web address', 'dated', 'twitter username', 'patreon username', 'patreon logo', 'artist logo']);
/**
 * A negative prompt split for a Style preset: the tags that keep writing out of the image (text, speech bubble …)
 * and everything else, each in its order. A tag is compared without its weight braces and case.
 */
export function splitTextNegative(negative: string): { negativePrompt: string; textNegativePrompt: string } {
  const kept: string[] = [], text: string[] = [];
  for (const piece of negative.split(',')) {
    const tag = piece.trim();
    if (!tag) continue;
    const bare = tag.replace(/^-?\d*\.?\d+::|::$/g, '').replace(/^[{[\s]+|[}\]\s]+$/g, '').replace(/_/g, ' ').toLowerCase();
    (TEXT_NEGATIVE_TAGS.has(bare) ? text : kept).push(tag);
  }
  return { negativePrompt: kept.join(', '), textNegativePrompt: text.join(', ') };
}
