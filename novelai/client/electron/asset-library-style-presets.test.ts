// Issue #1: style presets written through the public asset_library contract (what an agent reaches over the bridge):
// create, the structured fields of update, and sample images copied from library images (add-preview, label-preview,
// remove-preview). Real SQLite repository, real study service and image reader; temporary directories only.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it } from 'vitest';
import { runCleanups, type Cleanup } from '../src/test-support/temp-dirs';
import { openLibraryRepository } from './library/repository';
import { activateLibrary, deactivateLibrary } from './library-runtime';
import { createAssetLibraryService } from './asset-library-service';
import { createImageStudyService } from './image-studies';
import { parseImageStudy } from './image-study-parser';
import { validateLibraryRequest } from './library/validation';

const cleanups: Cleanup[] = [];
afterEach(() => runCleanups(cleanups.splice(0).reverse()));
const png = (background: string, width = 96, height = 144) => sharp({ create: { width, height, channels: 3, background } }).png().toBuffer();

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nai-style-preset-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const libraryDirectory = path.join(root, 'library'), userDataRoot = path.join(root, 'user-data'), output = path.join(root, 'output');
  for (const directory of [libraryDirectory, userDataRoot, output]) await fs.mkdir(directory);
  const repository = openLibraryRepository({ filePath: path.join(userDataRoot, 'library.sqlite'), libraryDirectory, userDataRoot });
  cleanups.push(() => repository.close());
  activateLibrary(repository, { libraryDirectory, userDataRoot }); cleanups.push(() => deactivateLibrary());
  const studies = createImageStudyService({ directory: path.join(libraryDirectory, 'studies'), repository, parse: parseImageStudy });
  cleanups.push(() => studies.dispose());
  const service = createAssetLibraryService({ repository, study: args => studies.material_studies(args), toFileUrl: file => `fixture:${file}` });
  /** As the bridge calls it: the public contract first, then the service. */
  const call = async (args: Record<string, unknown>) => { validateLibraryRequest('asset_library', args); return service.asset_library(args); };
  const history = async (id: string, background: string) => {
    const filePath = path.join(output, `${id}.png`), bytes = await png(background);
    await fs.writeFile(filePath, bytes);
    const item = repository.put('history', id, { id, filePath, params: { positivePrompt: 'SFW fixture' } });
    return { image: { kind: 'history', id, revision: item.revision, assetId: repository.versionAssets(item)[0].id }, bytes, filePath };
  };
  const study = async (background: string, name: string) => {
    const bytes = await png(background), result = await studies.material_studies({ action: 'import', name, data: bytes.toString('base64') }) as any;
    return { image: { kind: 'study', id: result.study.id as string, revision: result.study.revision as number }, bytes };
  };
  const preset = (id: string) => repository.get('style_preset', id)!;
  const folder = (id: string) => path.join(userDataRoot, 'style-prompt-previews', id);
  return { repository, call, history, study, preset, folder, userDataRoot };
}
const STRUCTURED = {
  artists: [{ name: 'artist:fixture_artist', weight: 1.2, enabled: true }, { name: 'artist:other', weight: -1.5, enabled: false }],
  negativePrompt: '3d, photo', textNegativePrompt: 'text, speech bubble',
  params: { model: 'nai-diffusion-5-full', steps: 28, cfgScale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral', noiseSchedule: 'karras', ucPreset: 0, qualityPreset: 'standard' },
  notes: 'One character: Base only.',
};

it('create makes a style preset from the given fields, in its group; what is not a field of a style preset is refused and nothing is made', async () => {
  const f = await fixture();
  const { item, revision } = await f.call({ action: 'create', kind: 'style_preset', patch: { name: ' Ink ', prompt: 'ink lineart', group: 'Line', ...STRUCTURED } });
  expect(item).toMatchObject({ kind: 'style_preset', revision: 1, name: 'Ink', archived: false, payload: { id: item.id, name: 'Ink', prompt: 'ink lineart', group: 'Line', ...STRUCTURED } });
  expect(revision).toBe(f.repository.getRevision());
  expect(f.repository.memberships('style_preset', item.id)).toMatchObject([{ namespace: 'style', collectionId: 'Line' }]);
  expect((await f.call({ action: 'list', kinds: ['style_preset'] })).items.map((value: any) => value.id)).toEqual([item.id]);
  // Only a name: an empty style to fill in later.
  const bare = await f.call({ action: 'create', kind: 'style_preset', patch: { name: 'Bare' } });
  expect(bare.item.payload).toEqual({ id: bare.item.id, name: 'Bare', prompt: '', group: '', createdAt: expect.any(String) });
  const before = f.repository.getRevision();
  for (const patch of [
    {}, { name: ' ' }, { name: 'x', unknown: true }, { name: 'x', previewImages: [] }, { name: 'x', id: 'chosen' },
    { name: 'x', artists: [{ name: 'artist:a', weight: 1 }] }, { name: 'x', artists: [{ name: 'artist:a', weight: '1', enabled: true }] }, { name: 'x', artists: [{ name: ' ', weight: 1, enabled: true }] },
    { name: 'x', artists: [{ name: 'artist:a', weight: 1, enabled: true, raw: 'artist:a' }] }, { name: 'x', artists: Array.from({ length: 65 }, () => ({ name: 'artist:a', weight: 1, enabled: true })) },
    { name: 'x', params: { model: 'no-such-model' } }, { name: 'x', params: { steps: 51 } }, { name: 'x', params: { steps: 27.5 } }, { name: 'x', params: { cfgScale: 11 } }, { name: 'x', params: { cfgRescale: -0.1 } },
    { name: 'x', params: { noiseSchedule: 'linear' } }, { name: 'x', params: { ucPreset: 4 } }, { name: 'x', params: { width: 832 } }, { name: 'x', negativePrompt: 3 },
  ]) await expect(f.call({ action: 'create', kind: 'style_preset', patch }), JSON.stringify(patch).slice(0, 120)).rejects.toMatchObject({ code: 'invalid_argument' });
  // Other kinds are not made here.
  for (const kind of ['positive_preset', 'prompt_chunk', 'history', 'tag']) await expect(f.call({ action: 'create', kind, patch: { name: 'x' } })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(f.repository.getRevision()).toBe(before);
  expect(f.repository.all('style_preset')).toHaveLength(2);
});

it('update writes the structured fields, each replacing the stored value as a whole, and keeps everything else', async () => {
  const f = await fixture();
  const { item } = await f.call({ action: 'create', kind: 'style_preset', patch: { name: 'Ink', prompt: 'ink lineart', ...STRUCTURED } });
  const update = async (patch: Record<string, unknown>) => (await f.call({ action: 'mutate', command: 'update', items: [{ kind: 'style_preset', id: item.id, expectedRevision: f.preset(item.id).revision }], patch })).items[0];
  // One setting changed: params is given whole, so the other settings are gone unless they are repeated.
  expect((await update({ params: { steps: 23 } })).payload).toEqual({ ...item.payload, params: { steps: 23 } });
  // An artist switched off and the notes rewritten; the style text and the negative texts stay.
  const artists = [{ ...STRUCTURED.artists[0], enabled: false }, STRUCTURED.artists[1]];
  expect((await update({ artists, notes: 'Two characters: use character boxes.' })).payload).toEqual({ ...item.payload, params: { steps: 23 }, artists, notes: 'Two characters: use character boxes.' });
  // Cleared with empty values.
  const cleared = await update({ artists: [], params: {}, negativePrompt: '', textNegativePrompt: '', notes: '' });
  expect(cleared.payload).toEqual({ ...item.payload, artists: [], params: {}, negativePrompt: '', textNegativePrompt: '', notes: '' });
  expect(cleared.revision).toBe(4);
  expect(f.repository.readVersions('style_preset', item.id).map(value => value.revision)).toEqual([1, 2, 3, 4]);
  // The same checks as create; sample images are never written through update; other kinds do not take these fields.
  const refused = async (patch: Record<string, unknown>, kind = 'style_preset', id = item.id) => expect(f.call({ action: 'mutate', command: 'update', items: [{ kind, id, expectedRevision: f.repository.get(kind as any, id)!.revision }], patch }), JSON.stringify(patch)).rejects.toMatchObject({ code: 'invalid_argument' });
  for (const patch of [{ params: { steps: 0 } }, { artists: [{ name: 'artist:a', weight: 1 }] }, { previewImages: [] }, { suffixPrompt: 'x' }]) await refused(patch);
  f.repository.put('positive_preset', 'pp', { id: 'pp', name: 'Mug', prompt: 'a red mug', createdAt: '2026-11-25T00:00:00.000Z' });
  await refused({ artists: [] }, 'positive_preset', 'pp');
  await refused({ negativePrompt: 'x' }, 'positive_preset', 'pp');
  expect(f.preset(item.id).revision).toBe(4);
});

it('add-preview copies a history original or an imported image into the preset as a labelled sample that outlives its source; label-preview and remove-preview change one', async () => {
  const f = await fixture();
  const { item } = await f.call({ action: 'create', kind: 'style_preset', patch: { name: 'Ink', prompt: 'ink lineart' } });
  const target = () => [{ kind: 'style_preset', id: item.id, expectedRevision: f.preset(item.id).revision }];
  const red = await f.history('bench-one', 'red'), blue = await f.study('blue', 'reference.png');
  const first = await f.call({ action: 'mutate', command: 'add-preview', items: target(), image: red.image, label: 'one character' });
  expect(first.items).toMatchObject([{ kind: 'style_preset', id: item.id, revision: 2 }]);
  expect(first.previews).toEqual([{ previewId: expect.any(String), name: 'bench-one.png', label: 'one character' }]);
  const second = await f.call({ action: 'mutate', command: 'add-preview', items: target(), image: blue.image });
  expect(second.previews).toEqual([first.previews[0], { previewId: expect.any(String), name: 'reference.png' }]);
  // The stored samples: the preset's own files, with the source's bytes.
  const saved = f.preset(item.id).payload.previewImages;
  expect(saved).toEqual([
    { id: first.previews[0].previewId, name: 'bench-one.png', filePath: path.join(f.folder(item.id), `${first.previews[0].previewId}.png`), fileUrl: expect.stringMatching(/^fixture:/), createdAt: expect.any(String), label: 'one character' },
    { id: second.previews[1].previewId, name: 'reference.png', filePath: path.join(f.folder(item.id), `${second.previews[1].previewId}.png`), fileUrl: expect.stringMatching(/^fixture:/), createdAt: expect.any(String) },
  ]);
  expect(await fs.readFile(saved[0].filePath)).toEqual(red.bytes);
  expect(await fs.readFile(saved[1].filePath)).toEqual(blue.bytes);
  // The source image goes; the sample stays.
  await fs.rm(red.filePath);
  expect(await fs.readFile(saved[0].filePath)).toEqual(red.bytes);
  // Labels: set, changed, removed with an empty one.
  const labelled = await f.call({ action: 'mutate', command: 'label-preview', items: target(), previewId: second.previews[1].previewId, label: 'reference' });
  expect(labelled.previews.map((value: any) => value.label)).toEqual(['one character', 'reference']);
  const unlabelled = await f.call({ action: 'mutate', command: 'label-preview', items: target(), previewId: first.previews[0].previewId, label: '' });
  expect(unlabelled.previews).toEqual([{ previewId: first.previews[0].previewId, name: 'bench-one.png' }, { previewId: second.previews[1].previewId, name: 'reference.png', label: 'reference' }]);
  expect(Object.hasOwn(f.preset(item.id).payload.previewImages[0], 'label')).toBe(false);
  // Removed from the list; the file stays for the older revisions that name it.
  const removed = await f.call({ action: 'mutate', command: 'remove-preview', items: target(), previewId: first.previews[0].previewId });
  expect(removed.previews).toEqual([{ previewId: second.previews[1].previewId, name: 'reference.png', label: 'reference' }]);
  expect(removed.items[0].revision).toBe(6);
  expect((await fs.readdir(f.folder(item.id))).sort()).toEqual(saved.map((value: any) => path.basename(value.filePath)).sort());
  expect(f.repository.get('style_preset', item.id, 3)!.payload.previewImages).toHaveLength(2);
});

it('add-preview refuses what it cannot add and leaves no file behind: a full preset, a stale revision, an image that is not that library image, another kind of item', async () => {
  const f = await fixture();
  const { item } = await f.call({ action: 'create', kind: 'style_preset', patch: { name: 'Ink' } });
  const target = (expectedRevision = f.preset(item.id).revision) => [{ kind: 'style_preset', id: item.id, expectedRevision }];
  const green = await f.history('bench', 'green'), files = () => fs.readdir(f.folder(item.id)).catch(() => []);
  const add = (args: Record<string, unknown> = {}) => f.call({ action: 'mutate', command: 'add-preview', items: target(), image: green.image, ...args });
  // The identity of the image, as the image action takes it.
  const { assetId: _assetId, ...withoutAsset } = green.image;
  await expect(add({ image: withoutAsset })).rejects.toMatchObject({ code: 'invalid_argument', reason: 'library.preview_image_identity' });
  await expect(add({ image: { kind: 'study', id: 'some-study', revision: 1, assetId: 'x' } })).rejects.toMatchObject({ code: 'invalid_argument', reason: 'library.preview_image_identity' });
  await expect(add({ image: { ...green.image, revision: 9 } })).rejects.toMatchObject({ code: 'library_not_found' });
  await expect(add({ image: { ...green.image, assetId: 'path:unknown' } })).rejects.toMatchObject({ code: 'library_conflict' });
  for (const image of [{ ...green.image, kind: 'style_preset' }, { ...green.image, filePath: green.filePath }, 'bench.png']) await expect(add({ image })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(add({ label: 'x'.repeat(61) })).rejects.toMatchObject({ code: 'invalid_argument' });
  // A stale revision; an item that is no style preset; more than one item.
  await expect(f.call({ action: 'mutate', command: 'add-preview', items: target(9), image: green.image })).rejects.toMatchObject({ code: 'library_conflict' });
  f.repository.put('positive_preset', 'pp', { id: 'pp', name: 'Mug', prompt: 'a red mug', createdAt: '2026-11-25T00:00:00.000Z' });
  await expect(f.call({ action: 'mutate', command: 'add-preview', items: [{ kind: 'positive_preset', id: 'pp', expectedRevision: 1 }], image: green.image })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(f.call({ action: 'mutate', command: 'add-preview', items: [...target(), ...target()], image: green.image })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(await files()).toEqual([]);
  expect(f.preset(item.id).revision).toBe(1);
  // Six samples, then full.
  for (let index = 0; index < 6; index++) await add({ label: `sample ${index + 1}` });
  expect(await files()).toHaveLength(6);
  await expect(add()).rejects.toMatchObject({ code: 'invalid_argument', reason: 'library.preview_limit', params: { max: 6 } });
  expect(await files()).toHaveLength(6);
  expect(f.preset(item.id).payload.previewImages.map((image: any) => image.label)).toEqual([1, 2, 3, 4, 5, 6].map(index => `sample ${index}`));
  // A previewId the preset does not have.
  for (const command of ['label-preview', 'remove-preview']) await expect(f.call({ action: 'mutate', command, items: target(), previewId: 'no-such-sample', ...(command === 'label-preview' ? { label: 'x' } : {}) })).rejects.toMatchObject({ code: 'library_not_found', reason: 'library.preview_not_found' });
  expect(f.preset(item.id).revision).toBe(7);
});
