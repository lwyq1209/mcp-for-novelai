import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_PRESET_PARAM_FIELDS, applyStylePreset, artistPromptText, joinPromptParts, readStylePreset, stylePresetStyleText } from '../src/style-preset.mjs';
import { BridgeError } from '../src/bridge-client.mjs';
import { validateContract, contractSchemas } from '../contracts/validate.mjs';

// A style preset written into a prepare_recipe call (issue #1): the pure text and field rules. The whole path through
// the real recipe service is in mcp-recipes-modes.test.mjs (search "stylePresetId").
const item = (payload, patch = {}) => ({ id: 'p', revision: 2, name: 'Preset', archived: false, payload: { id: 'p', name: 'Preset', prompt: '', group: '', createdAt: 'now', ...payload }, ...patch });

test('prompt parts are joined with ", " without the blanks and commas around each part; empty parts are left out', () => {
  assert.equal(joinPromptParts(' ink, lineart, ', '', undefined, ',  flat color ,,', '\n'), 'ink, lineart, flat color');
  assert.equal(joinPromptParts('only'), 'only');
  assert.equal(joinPromptParts('', '  ', ','), '');
  // Inside a part nothing is touched (a weighted group, line breaks, doubled commas).
  assert.equal(joinPromptParts('1.2::a, b::,\n c,, d', 'e'), '1.2::a, b::,\n c,, d, e');
});

test('an artist is written plain at weight 1 and as weight::name:: otherwise, negative weights included', () => {
  const text = weight => artistPromptText({ name: ' artist:someone ', weight, enabled: true });
  assert.deepEqual([1, 1.3, 0.8, -1.5, 0, 2, 1.00001, 0.1 + 0.2].map(text),
    ['artist:someone', '1.3::artist:someone::', '0.8::artist:someone::', '-1.5::artist:someone::', '0::artist:someone::', '2::artist:someone::', 'artist:someone', '0.3::artist:someone::']);
  // The style text: enabled artists in their order, then the prompt; an artist that is off, has no name or no finite weight is not written.
  assert.equal(stylePresetStyleText({ prompt: 'ink', artists: [{ name: 'artist:a', weight: 1, enabled: true }, { name: 'artist:b', weight: 1.2, enabled: false }, { name: ' ', weight: 1, enabled: true }, { name: 'artist:c', weight: null, enabled: true }, { name: 'artist:d', weight: 0.6, enabled: true }] }), 'artist:a, 0.6::artist:d::, ink');
  assert.equal(stylePresetStyleText({ prompt: ' watercolor ' }), 'watercolor', 'a preset from before the artist list is its prompt');
});

test('the preset is written into the call: its texts before the call\'s own, its settings only where the call has none, and the two preset fields removed', () => {
  const preset = item({ prompt: 'ink', negativePrompt: '3d', textNegativePrompt: 'text, speech bubble', params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0.2, sampler: 'k_euler', noiseSchedule: 'karras', ucPreset: 1, qualityPreset: 'light' } });
  const call = { mode: 't2i', stylePresetId: 'p', positivePrompt: '1girl', seed: null, width: 832, height: 1216 };
  const { args, applied } = applyStylePreset(call, preset);
  assert.deepEqual(args, { mode: 't2i', positivePrompt: '1girl', seed: null, width: 832, height: 1216, ...preset.payload.params, stylePrompt: 'ink', negativePrompt: '3d, text, speech bubble' });
  assert.deepEqual(applied, { id: 'p', revision: 2, name: 'Preset', stylePrompt: 'ink', negativePrompt: '3d, text, speech bubble', negative: { style: 'applied', text: 'applied' }, params: [...STYLE_PRESET_PARAM_FIELDS] });
  assert.deepEqual(Object.keys(preset.payload.params).sort(), [...STYLE_PRESET_PARAM_FIELDS].sort(), 'every recommended setting is one prepare_recipe takes');
  assert.deepEqual(call, { mode: 't2i', stylePresetId: 'p', positivePrompt: '1girl', seed: null, width: 832, height: 1216 }, 'the call itself is not changed');
  // The call's own values win (also a falsy one), its own texts come last, allowText leaves out only the text part.
  const own = applyStylePreset({ ...call, allowText: true, stylePrompt: ', sketch', negativePrompt: 'hat ', cfgRescale: 0, ucPreset: 0, steps: 23 }, preset);
  assert.deepEqual([own.args.stylePrompt, own.args.negativePrompt, own.args.cfgRescale, own.args.ucPreset, own.args.steps, own.args.model], ['ink, sketch', '3d, hat', 0, 0, 23, 'nai-diffusion-5-full']);
  assert.deepEqual([own.applied.yourStylePrompt, own.applied.negative, own.applied.overridden, own.applied.params], ['appended', { style: 'applied', text: 'skipped', yours: 'appended' }, ['steps', 'cfgRescale', 'ucPreset'], ['model', 'cfgScale', 'sampler', 'noiseSchedule', 'qualityPreset']]);
  assert.equal('allowText' in own.args || 'stylePresetId' in own.args, false);
  // allowText:false is the default; the prompts are never searched for speech bubbles.
  const bubbles = applyStylePreset({ ...call, allowText: false, positivePrompt: '1girl, speech bubble, Text: hello' }, preset);
  assert.equal(bubbles.args.negativePrompt, '3d, text, speech bubble');
  // A preset with nothing but its prompt, and one without any text at all.
  assert.deepEqual(applyStylePreset(call, item({ prompt: 'watercolor' })).applied, { id: 'p', revision: 2, name: 'Preset', stylePrompt: 'watercolor', negativePrompt: '', negative: { style: 'none', text: 'none' } });
  assert.deepEqual(applyStylePreset({ ...call, stylePrompt: 'mine' }, item({})).args.stylePrompt, 'mine');
  // Long notes are cut for the readback; an archived preset says so.
  const noted = applyStylePreset(call, item({ notes: 'n'.repeat(700) }, { archived: true })).applied;
  assert.deepEqual([noted.notes.length, noted.notes.endsWith('…'), noted.archived], [601, true, true]);
});

test('every sampling value a stored preset may hold is one the call may take, and the payload the examples use is a valid stored preset', () => {
  const payload = { id: 'p', name: 'Preset', prompt: 'ink', group: '', createdAt: 'now', artists: [{ name: 'artist:a', weight: -1.5, enabled: true }], negativePrompt: '3d', textNegativePrompt: 'text', params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler', noiseSchedule: 'karras', ucPreset: 1, qualityPreset: 'light' }, notes: 'x' };
  validateContract(payload, contractSchemas.libraryPayloads.style_preset);
  assert.deepEqual(Object.keys(contractSchemas.libraryPayloads.style_preset.properties.params.properties).sort(), [...STYLE_PRESET_PARAM_FIELDS].sort());
});

test('the preset read: one asset_library read of that style preset; an unknown id and a reply that is not the preset are refused', async () => {
  const calls = [];
  const bridge = reply => ({ async call(method, args, signal) { calls.push([method, args, signal]); return typeof reply === 'function' ? reply() : reply; } });
  const stored = { kind: 'style_preset', id: 'p', revision: 3, name: 'Preset', archived: false, payload: { id: 'p', name: 'Preset', prompt: 'ink', group: '', createdAt: 'now' } };
  const signal = AbortSignal.timeout(60_000);
  assert.deepEqual(await readStylePreset(bridge({ item: stored }), 'p', { signal }), { id: 'p', revision: 3, name: 'Preset', archived: false, payload: stored.payload });
  assert.deepEqual(calls, [['asset_library', { action: 'read', kind: 'style_preset', id: 'p' }, signal]]);
  const missing = await readStylePreset(bridge(() => { throw new BridgeError('library_not_found', 'This item or revision does not exist.', { trashId: 't1' }); }), 'gone').catch(error => error);
  assert.deepEqual([missing.code, missing.details], ['library_not_found', { field: 'stylePresetId', stylePresetId: 'gone', saved: false, hostDetails: { trashId: 't1' }, reason: 'style_preset_not_found' }]);
  assert.match(missing.message, /^stylePresetId "gone" is not a style preset in the library: This item or revision does not exist\. asset_library list/);
  const down = await readStylePreset(bridge(() => { throw new BridgeError('unavailable', 'The client is not running.'); }), 'p').catch(error => error);
  assert.deepEqual([down.code, down.details.saved], ['unavailable', false]);
  for (const reply of [null, {}, { item: { ...stored, id: 'q' } }, { item: { ...stored, kind: 'positive_preset' } }, { item: { ...stored, revision: 0 } }, { item: { ...stored, payload: { name: 'no prompt' } } }])
    assert.equal((await readStylePreset(bridge(reply), 'p').catch(error => error)).code, 'invalid_response', JSON.stringify(reply));
  // Anything that is not a host error is passed on as it is.
  await assert.rejects(readStylePreset(bridge(() => { throw new TypeError('bug'); }), 'p'), TypeError);
});

test('parity: the window writes a preset as this server does (client src/style-preset.ts): the same style, negative and settings for the same preset', async () => {
  const { createJiti } = await import('jiti');
  const { fileURLToPath } = await import('node:url');
  const client = await createJiti(import.meta.url, { moduleCache: false, fsCache: false }).import(fileURLToPath(new URL('../client/src/style-preset.ts', import.meta.url)));
  assert.deepEqual([...client.STYLE_PRESET_PARAM_FIELDS].sort(), [...STYLE_PRESET_PARAM_FIELDS].sort());
  const presets = [
    { prompt: ' ink lineart, flat color, ', artists: [{ name: ' artist:alpha ', weight: 1, enabled: true }, { name: 'artist:beta', weight: 1.3, enabled: true }, { name: 'artist:gamma', weight: -1.5, enabled: true }, { name: 'artist:off', weight: 1, enabled: false }, { name: ' ', weight: 1, enabled: true }, { name: 'artist:third', weight: 0.1 + 0.2, enabled: true }],
      negativePrompt: ' 3d, photo ,', textNegativePrompt: 'text, speech bubble', params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'light' } },
    { prompt: 'watercolor' }, { prompt: '', artists: [{ name: 'artist:only', weight: 2, enabled: true }], textNegativePrompt: 'text' }, { prompt: ' , ', negativePrompt: '', params: { steps: 23 } },
  ];
  const call = { mode: 't2i', stylePresetId: 'p', positivePrompt: '1girl', seed: null, width: 832, height: 1216 };
  for (const payload of presets) for (const allowText of [false, true]) {
    const server = applyStylePreset({ ...call, allowText }, item(payload)), window = client.stylePresetApplication(payload, { allowText, withParams: true });
    const label = `${JSON.stringify(payload).slice(0, 60)} allowText ${allowText}`;
    assert.equal(window.stylePrompt, server.args.stylePrompt, label);
    assert.equal(window.negativePrompt ?? '', server.args.negativePrompt, label);
    assert.deepEqual(window.params, Object.fromEntries((server.applied.params ?? []).map(key => [key, server.args[key]])), label);
    assert.equal(client.stylePresetStyleText(payload), stylePresetStyleText(payload), label);
  }
  // Without the switch the window applies no settings; the server always takes them as defaults of the call.
  assert.deepEqual(client.stylePresetApplication(presets[0], {}).params, {});
});
