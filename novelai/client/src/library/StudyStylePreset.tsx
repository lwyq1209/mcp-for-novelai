import { useState } from 'react';
import type { AssetItem } from '../asset-library/types';
import type { ImageMetadataReport } from '../png-meta';
import { NAI_MODELS, NAI_SAMPLERS } from '../types';
import { splitArtists, splitTextNegative, stylePresetStyleText, type StylePresetArtist, type StylePresetParams } from '../style-preset';
import { Button, Dialog, Field, Icon, TextArea, TextInput, Toggle, showToast } from '../ui';
import { useUiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { libraryErrorText } from './errors';
import { itemTitle } from './present';

/**
 * A Style preset made from an imported image (保存为 Style 预设, issue #1): what the image's own settings say about
 * its style, as a draft the user checks before saving.
 * - Artists: every artist tag of the image's style text and of its prompt (the prompt's other tags are the picture,
 *   not the style, and are left out). The rest of the style text is the preset's prompt.
 * - Negative: the image's negative prompt, with the tags that keep writing out of an image (text, speech bubble …)
 *   held apart, so a later image with speech bubbles can leave them out.
 * - Settings: the model, steps, guidance, sampler, noise schedule, UC preset and quality tags the image was made
 *   with, where they are values the app generates with.
 * The image itself becomes the preset's first sample, labelled as the reference.
 */
export interface ImageStyleDraft { artists: StylePresetArtist[]; prompt: string; negativePrompt: string; textNegativePrompt: string; params: StylePresetParams }
const within = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
export function stylePresetFromReport(report: ImageMetadataReport): ImageStyleDraft {
  const imported = report.imported as Record<string, unknown>;
  const style = splitArtists(String(imported.stylePrompt ?? '')), content = splitArtists(String(imported.positivePrompt ?? ''));
  const seen = new Set<string>(), artists: StylePresetArtist[] = [];
  for (const artist of [...style.artists, ...content.artists]) { const key = artist.name.toLowerCase(); if (!seen.has(key)) { seen.add(key); artists.push(artist); } }
  const negative = splitTextNegative(String(imported.negativePrompt ?? ''));
  const params: Record<string, unknown> = {};
  if (NAI_MODELS.some(model => model.value === imported.model)) params.model = imported.model;
  if (within(imported.steps, 1, 50) && Number.isInteger(imported.steps)) params.steps = imported.steps;
  if (within(imported.cfgScale, 0, 10)) params.cfgScale = imported.cfgScale;
  if (within(imported.cfgRescale, 0, 1)) params.cfgRescale = imported.cfgRescale;
  if (NAI_SAMPLERS.some(sampler => sampler.value === imported.sampler)) params.sampler = imported.sampler;
  if (['native', 'karras', 'exponential'].includes(imported.noiseSchedule as string)) params.noiseSchedule = imported.noiseSchedule;
  if ([0, 1, 2, 3].includes(imported.ucPreset as number)) params.ucPreset = imported.ucPreset;
  if (['standard', 'light', 'none'].includes(imported.qualityPreset as string)) params.qualityPreset = imported.qualityPreset;
  return { artists, prompt: style.prompt, ...negative, params: params as StylePresetParams };
}

/** Saves the draft as a new Style preset with the image as its first sample; returns the new preset's id. */
export async function saveImageStylePreset(api: LibraryApi, image: Pick<AssetItem, 'id' | 'revision'>, fields: { name: string; group: string; draft: ImageStyleDraft; withParams: boolean; referenceLabel: string }) {
  const { draft } = fields;
  const patch = { name: fields.name.trim(), group: fields.group.trim(), prompt: draft.prompt,
    ...(draft.artists.length ? { artists: draft.artists } : {}), ...(draft.negativePrompt ? { negativePrompt: draft.negativePrompt } : {}), ...(draft.textNegativePrompt ? { textNegativePrompt: draft.textNegativePrompt } : {}),
    ...(fields.withParams && Object.keys(draft.params).length ? { params: draft.params } : {}) };
  const created = await api.assetLibrary({ action: 'create', kind: 'style_preset', patch }) as { item: { id: string; revision: number } };
  // The preset exists from here on; a sample that cannot be added is reported, the preset stays.
  let sampleError: unknown;
  try { await api.assetLibrary({ action: 'mutate', command: 'add-preview', items: [{ kind: 'style_preset', id: created.item.id, expectedRevision: created.item.revision }], image: { kind: 'study', id: image.id, revision: image.revision }, label: fields.referenceLabel }); }
  catch (error) { sampleError = error; }
  return { id: created.item.id, sampleError };
}

export function StudyStylePresetDialog({ api, item, report, onClose }: { api: LibraryApi; item: AssetItem; report: ImageMetadataReport; onClose(): void }) {
  const { t, lang } = useUiText();
  const [draft, setDraft] = useState(() => stylePresetFromReport(report));
  const [name, setName] = useState(() => itemTitle(item).replace(/\.(png|jpe?g|webp)$/i, '').slice(0, 60));
  const [group, setGroup] = useState('');
  const [withParams, setWithParams] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const paramCount = Object.keys(draft.params).length;
  const applied = stylePresetStyleText(draft);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setFailure('');
    try {
      const saved = await saveImageStylePreset(api, item, { name, group, draft, withParams, referenceLabel: t('spd.sample.reference') });
      showToast(saved.sampleError ? { message: t('ssp.savedNoSample', { name: name.trim(), reason: libraryErrorText(saved.sampleError, t, lang) }), tone: 'warn' } : { message: t('ssp.saved', { name: name.trim() }), tone: 'ok' });
      onClose();
    } catch (error) { setFailure(libraryErrorText(error, t, lang)); setBusy(false); }
  };
  return <Dialog open onClose={onClose} busy={busy} icon="palette" width={560} title={t('ssp.title')} description={t('ssp.desc')}
    footer={<><Button onClick={onClose} disabled={busy}>{t('c.cancel')}</Button><Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void save()} data-testid="study-style-save">{t('c.save')}</Button></>}>
    <div className="lib-ssp" data-testid="study-style-preset">
      <div className="lib-row lib-ssp-head">
        <Field label={t('edit.name')}><TextInput autoFocus value={name} onChange={event => setName(event.target.value)} /></Field>
        <Field label={t('edit.group')}><TextInput value={group} onChange={event => setGroup(event.target.value)} /></Field>
      </div>
      {draft.artists.length > 0 && <Field label={t('ssp.artists', { n: draft.artists.length })}><p className="lib-ptext ui-mono">{draft.artists.map(artist => artist.weight === 1 ? artist.name : `${artist.weight}::${artist.name}::`).join(', ')}</p></Field>}
      <Field label={draft.artists.length ? t('spd.prompt') : t('edit.prompt')} hint={applied ? undefined : t('ssp.noStyle')}><TextArea rows={3} className="ui-mono" value={draft.prompt} onChange={event => setDraft({ ...draft, prompt: event.target.value })} /></Field>
      <Field label={t('spd.negative')}><TextArea rows={3} className="ui-mono" value={draft.negativePrompt} onChange={event => setDraft({ ...draft, negativePrompt: event.target.value })} /></Field>
      <Field label={t('spd.textNegative')} hint={t('spd.textNegativeHint')}><TextArea rows={2} className="ui-mono" value={draft.textNegativePrompt} onChange={event => setDraft({ ...draft, textNegativePrompt: event.target.value })} /></Field>
      {paramCount > 0 && <label className="lib-ssp-toggle"><span>{t('ssp.withParams', { n: paramCount })}</span><Toggle checked={withParams} label={t('ssp.withParams', { n: paramCount })} onChange={setWithParams} /></label>}
      <p className="lib-text ui-faint">{t('ssp.sample')}</p>
      {failure && <p className="lib-error" role="alert"><Icon name="alert" size={14} /><span>{failure}</span></p>}
    </div>
  </Dialog>;
}
