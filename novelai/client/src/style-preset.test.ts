import { describe, expect, it } from 'vitest';
import { artistPromptText, joinPromptParts, splitArtists, splitTextNegative, stylePresetHas, stylePresetNegativeText, stylePresetParamsPatch, stylePresetStyleText } from './style-preset';

// The window's side of a Style preset's rules (issue #1). The server's tests compare these functions with its own
// (novelai/tests/style-preset.test.mjs), so the canvas and prepare_recipe stylePresetId write the same text.
const preset = {
  prompt: ' ink lineart, flat color, ',
  artists: [{ name: 'artist:alpha', weight: 1, enabled: true }, { name: 'artist:beta', weight: 1.3, enabled: true }, { name: 'artist:gamma', weight: -1.5, enabled: true }, { name: 'artist:off', weight: 1, enabled: false }],
  negativePrompt: '3d, photo', textNegativePrompt: 'text, speech bubble',
  params: { model: 'nai-diffusion-5-full' as const, steps: 28, cfgScale: 5, sampler: 'k_euler_ancestral' as const, noiseSchedule: 'karras', ucPreset: 0 as const, qualityPreset: 'standard' as const },
};

describe('a Style preset as prompt text and settings', () => {
  it('writes the enabled artists before the prompt, and the text negative only when text is not allowed', () => {
    expect(stylePresetStyleText(preset)).toBe('artist:alpha, 1.3::artist:beta::, -1.5::artist:gamma::, ink lineart, flat color');
    expect(stylePresetStyleText({ prompt: ' watercolor ' })).toBe('watercolor');
    expect(stylePresetNegativeText(preset)).toBe('3d, photo, text, speech bubble');
    expect(stylePresetNegativeText(preset, true)).toBe('3d, photo');
    expect(stylePresetNegativeText({ prompt: 'x' })).toBe('');
    expect([1, 0.8, 0, 1.00001, 0.1 + 0.2].map(weight => artistPromptText({ name: ' artist:a ', weight }))).toEqual(['artist:a', '0.8::artist:a::', '0::artist:a::', 'artist:a', '0.3::artist:a::']);
    expect(joinPromptParts(' a, ', '', undefined, ', b ,,')).toBe('a, b');
  });
  it('gives the recommended settings in the order they are applied, the model first, and says what a preset holds', () => {
    expect(Object.keys(stylePresetParamsPatch({ prompt: '', params: { qualityPreset: 'light', steps: 23, model: 'nai-diffusion-5-full' } }))).toEqual(['model', 'steps', 'qualityPreset']);
    expect(stylePresetParamsPatch({ prompt: '' })).toEqual({});
    expect(stylePresetHas(preset)).toEqual({ artists: 4, negative: true, textNegative: true, params: 7 });
    expect(stylePresetHas({ prompt: 'ink', artists: [], negativePrompt: ' ', params: {} })).toEqual({ artists: 0, negative: false, textNegative: false, params: 0 });
  });
});

describe('a preset made from existing text', () => {
  it('reads the artists out of a style text and keeps the rest in its order', () => {
    expect(splitArtists('artist:alpha, 1.3::artist:beta::, ink lineart, -1.5::artist:gamma ::, flat color,  ')).toEqual({
      artists: [{ name: 'artist:alpha', weight: 1, enabled: true }, { name: 'artist:beta', weight: 1.3, enabled: true }, { name: 'artist:gamma', weight: -1.5, enabled: true }],
      prompt: 'ink lineart, flat color',
    });
    // A weighted group of several tags, a braced artist and plain tags stay text; written again with the artists it is the same style.
    const mixed = '1.2::artist:a, artist:b::, {artist:c}, year 2023, 0.8::soft lighting::';
    expect(splitArtists(mixed)).toEqual({ artists: [], prompt: mixed });
    const style = 'artist:alpha, 0.6::artist:beta::, watercolor, 1.2::soft light, bloom::';
    const split = splitArtists(style);
    expect(stylePresetStyleText(split)).toBe(style);
    expect(splitArtists('')).toEqual({ artists: [], prompt: '' });
  });
  it('holds the negative tags that keep writing out of the image apart from the rest', () => {
    expect(splitTextNegative('lowres, text, {speech bubble}, 3d, Speech_Bubble, 2::watermark::, bad hands, dialogue, signature')).toEqual({
      negativePrompt: 'lowres, 3d, bad hands', textNegativePrompt: 'text, {speech bubble}, Speech_Bubble, 2::watermark::, dialogue, signature',
    });
    expect(splitTextNegative('lowres, texture, text block art')).toEqual({ negativePrompt: 'lowres, texture, text block art', textNegativePrompt: '' });
    expect(splitTextNegative(' , ')).toEqual({ negativePrompt: '', textNegativePrompt: '' });
  });
});
