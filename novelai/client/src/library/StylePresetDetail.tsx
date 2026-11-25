import { useEffect, useState, type ReactNode } from 'react';
import type { AssetDetail, AssetItem } from '../asset-library/types';
import { NAI_MODELS, NAI_SAMPLERS, NAI_UC_PRESETS, type StylePromptPreset } from '../types';
import { STYLE_PRESET_PREVIEW_LIMIT } from '../preset-previews';
import { STYLE_PRESET_ARTIST_LIMIT, splitArtists, splitTextNegative, stylePresetParamsPatch, stylePresetStyleText, joinPromptParts, type StylePresetArtist, type StylePresetParams } from '../style-preset';
import { Button, Dialog, Field, Icon, IconButton, SearchInput, Seg, Spinner, Tag, TextArea, TextInput, Toggle, showToast } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import { Select, optionLabel } from '../canvas/controls';
import { StylePresetImagesManager } from '../canvas/StylePresetImages';
import type { LibraryApi } from './api';
import { useLibraryItems } from './data';
import { libraryErrorText } from './errors';
import { itemTitle } from './present';
import { Thumb } from './Thumb';

/**
 * A Style preset in the library (issue #1): what it holds beside its name and group, shown and edited.
 * - Shown: the Style as it is applied (enabled artists, then the text), the artists, the two negative texts, the
 *   recommended settings and the sample images. Samples are added from the library (a history image or an imported
 *   image, copied into the preset) or from local files, labelled and removed here; each such change saves at once.
 * - Edited (the drawer's edit form): the artist list, the rest of the Style, the negative texts and the settings.
 *   The artists are written into a prompt only when the preset is used; they are never written back into the text.
 */
export interface StylePresetDraft { artists: StylePresetArtist[]; negativePrompt: string; textNegativePrompt: string; params: Record<string, string | number> }
const PARAM_KEYS = ['model', 'steps', 'cfgScale', 'cfgRescale', 'sampler', 'noiseSchedule', 'ucPreset', 'qualityPreset'] as const;
type ParamKey = typeof PARAM_KEYS[number];
/** The number settings and their ranges (the ranges the app generates with). */
const NUMBER_PARAMS: Partial<Record<ParamKey, { min: number; max: number; step: number; whole?: boolean; label: 'cv.steps' | 'cv.cfg' | 'cv.cfgRescale'; error: 'spd.error.steps' | 'spd.error.cfg' | 'spd.error.rescale' }>> = {
  steps: { min: 1, max: 50, step: 1, whole: true, label: 'cv.steps', error: 'spd.error.steps' },
  cfgScale: { min: 0, max: 10, step: 0.1, label: 'cv.cfg', error: 'spd.error.cfg' },
  cfgRescale: { min: 0, max: 1, step: 0.01, label: 'cv.cfgRescale', error: 'spd.error.rescale' },
};

/** `stored`: the payload of a library item (of any kind: only a Style preset's fields are read). */
export function stylePresetDraftOf(stored: Record<string, any> | null | undefined): StylePresetDraft {
  const payload = stored as Partial<StylePromptPreset> | null | undefined;
  return {
    artists: (Array.isArray(payload?.artists) ? payload!.artists : []).map(artist => ({ name: String(artist.name ?? ''), weight: Number(artist.weight), enabled: artist.enabled !== false })),
    negativePrompt: String(payload?.negativePrompt ?? ''), textNegativePrompt: String(payload?.textNegativePrompt ?? ''),
    // In the form a number is the text being typed ('' = not set); it is read as a number when saved.
    params: Object.fromEntries(Object.entries(stylePresetParamsPatch({ prompt: '', params: payload?.params })).map(([key, value]) => [key, key in NUMBER_PARAMS ? String(value) : value as string | number])),
  };
}
/** The first thing wrong with a draft, as a text to show; '' when it can be saved. */
export function stylePresetDraftError(draft: StylePresetDraft, t: UiText): string {
  if (draft.artists.some(artist => !artist.name.trim())) return t('spd.error.artistName');
  if (draft.artists.some(artist => !Number.isFinite(artist.weight))) return t('spd.error.weight');
  for (const [key, rule] of Object.entries(NUMBER_PARAMS) as [ParamKey, NonNullable<typeof NUMBER_PARAMS[ParamKey]>][]) {
    const text = String(draft.params[key] ?? '').trim();
    if (!text) continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value < rule.min || value > rule.max || (rule.whole && !Number.isInteger(value))) return t(rule.error);
  }
  return '';
}
/** The settings of a draft as they are stored: the ones that are set, numbers as numbers. */
export function stylePresetDraftParams(draft: StylePresetDraft): StylePresetParams {
  const params: Record<string, unknown> = {};
  for (const key of PARAM_KEYS) {
    const value = draft.params[key];
    if (value === undefined || String(value).trim() === '') continue;
    params[key] = key in NUMBER_PARAMS ? Number(value) : value;
  }
  return params as StylePresetParams;
}
/**
 * The update fields of a draft: only what differs from the stored preset (a field the preset never had and the draft
 * leaves empty is not written), each as a whole value.
 */
export function stylePresetPatch(draft: StylePresetDraft, stored: Record<string, any> | null | undefined): Record<string, unknown> {
  const before = stylePresetDraftOf(stored), patch: Record<string, unknown> = {};
  const artists = draft.artists.map(artist => ({ name: artist.name.trim(), weight: artist.weight, enabled: artist.enabled }));
  if (JSON.stringify(artists) !== JSON.stringify(before.artists)) patch.artists = artists;
  for (const key of ['negativePrompt', 'textNegativePrompt'] as const) if (draft[key] !== before[key]) patch[key] = draft[key];
  const params = stylePresetDraftParams(draft);
  if (JSON.stringify(params) !== JSON.stringify(stylePresetDraftParams(before))) patch.params = params;
  return patch;
}

function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return <section className="lib-sect"><div className="lib-sect-h"><h3>{title}</h3>{aside}</div>{children}</section>;
}
function Copyable({ text, t }: { text: string; t: UiText }) {
  if (!text) return null;
  return <div className="lib-ptext ui-mono">{text}<IconButton className="lib-ptext-cp" size="sm" icon="copy" label={t('c.copy')} onClick={() => { void navigator.clipboard?.writeText(text).then(() => showToast({ message: t('c.copied'), tone: 'ok', durationMs: 1800 })); }} /></div>;
}
/** The names of the settings and of their values, as the canvas names them. */
function useParamTexts() {
  const { t, language } = useUiText();
  const name = (value: string | number, fallback: string) => optionLabel(language, value, fallback).name;
  const labels: Record<ParamKey, string> = { model: t('cv.model'), steps: t('cv.steps'), cfgScale: t('cv.cfg'), cfgRescale: t('cv.cfgRescale'), sampler: t('cv.sampler'), noiseSchedule: t('cv.noise'), ucPreset: t('cv.uc'), qualityPreset: t('cv.quality') };
  const options: Partial<Record<ParamKey, Array<{ value: string | number; label: string }>>> = {
    model: NAI_MODELS.map(item => ({ value: item.value, label: name(item.value, item.label) })),
    sampler: NAI_SAMPLERS.map(item => ({ value: item.value, label: name(item.value, item.label) })),
    noiseSchedule: ['native', 'karras', 'exponential'].map(value => ({ value, label: name(value, value[0].toUpperCase() + value.slice(1)) })),
    ucPreset: NAI_UC_PRESETS.map(item => ({ value: item.value, label: name(item.value, item.label) })),
    qualityPreset: (['standard', 'light', 'none'] as const).map(value => ({ value, label: t(`cv.quality.${value}`) })),
  };
  const shown = (key: ParamKey, value: unknown) => options[key]?.find(option => option.value === value)?.label ?? String(value);
  return { labels, options, shown };
}

/** The read view of a Style preset: what applying it writes, and its sample images. */
export function StylePresetView({ api, detail }: { api: LibraryApi; detail: AssetDetail }) {
  const { t } = useUiText();
  const item = detail.item, payload = (item.payload ?? {}) as StylePromptPreset;
  const artists = Array.isArray(payload.artists) ? payload.artists : [];
  const params = stylePresetParamsPatch(payload) as Record<string, unknown>;
  const texts = useParamTexts();
  return <>
    <Section title={t('spd.style')}>{stylePresetStyleText(payload) ? <Copyable t={t} text={stylePresetStyleText(payload)} /> : <p className="lib-text ui-muted">{t('spd.style.none')}</p>}</Section>
    {artists.length > 0 && <Section title={t('spd.artists')} aside={<span className="ui-faint ui-num">{artists.filter(artist => artist.enabled).length}/{artists.length}</span>}>
      <ul className="lib-members">{artists.map((artist, index) => <li key={index} className={artist.enabled ? undefined : 'lib-sp-off'}><span className="ui-mono">{artist.name}</span><span className="ui-faint ui-num">×{artist.weight}</span>{!artist.enabled && <Tag>{t('spd.artist.off')}</Tag>}</li>)}</ul>
    </Section>}
    {payload.negativePrompt?.trim() && <Section title={t('spd.negative')}><Copyable t={t} text={payload.negativePrompt} /></Section>}
    {payload.textNegativePrompt?.trim() && <Section title={t('spd.textNegative')}><Copyable t={t} text={payload.textNegativePrompt} /><p className="lib-text ui-faint">{t('spd.textNegativeHint')}</p></Section>}
    {Object.keys(params).length > 0 && <Section title={t('spd.params')}>
      <dl className="lib-sp-params">{(Object.keys(params) as ParamKey[]).map(key => <div key={key}><dt>{texts.labels[key]}</dt><dd className="ui-num">{texts.shown(key, params[key])}</dd></div>)}</dl>
    </Section>}
    <StylePresetSamples api={api} detail={detail} />
  </>;
}

type Sample = NonNullable<StylePromptPreset['previewImages']>[number];
/** The sample images of a preset: each with its label, added from the library or local files, labelled, removed. */
function StylePresetSamples({ api, detail }: { api: LibraryApi; detail: AssetDetail }) {
  const { t, lang } = useUiText();
  const item = detail.item, samples: Sample[] = Array.isArray(item.payload?.previewImages) ? item.payload.previewImages : [];
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [local, setLocal] = useState(false);
  const [labelling, setLabelling] = useState<{ id: string; text: string } | null>(null);
  const target = [{ kind: 'style_preset', id: item.id, expectedRevision: item.revision }];
  const full = samples.length >= STYLE_PRESET_PREVIEW_LIMIT;
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try { await work(); } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); } finally { setBusy(false); }
  };
  // The picture of a sample: the URL the host made for this read (a saved one is from an earlier run).
  const src = (index: number, sample: Sample) => detail.assets.find(asset => asset.role === `preview:${index}`)?.fileUrl ?? sample.fileUrl;
  const saveLabel = () => { const edit = labelling; if (!edit) return; setLabelling(null); void run(() => api.assetLibrary({ action: 'mutate', command: 'label-preview', items: target, previewId: edit.id, label: edit.text.trim() })); };
  return <Section title={t('spd.samples')} aside={<span className="ui-faint ui-num">{samples.length}/{STYLE_PRESET_PREVIEW_LIMIT}</span>}>
    {samples.length === 0 && <p className="lib-text ui-muted">{t('spd.samples.none')}</p>}
    {samples.length > 0 && <div className="lib-sp-samples" data-testid="style-preset-samples">{samples.map((sample, index) => <figure key={sample.id} className="lib-sp-sample">
      <img src={src(index, sample)} alt={sample.label || sample.name} loading="lazy" decoding="async" draggable={false} />
      <figcaption>
        {labelling?.id === sample.id
          ? <TextInput autoFocus maxLength={60} aria-label={t('spd.sample.label')} placeholder={t('spd.sample.labelPh')} value={labelling.text} onChange={event => setLabelling({ id: sample.id, text: event.target.value })}
              onBlur={saveLabel} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveLabel(); } else if (event.key === 'Escape') { event.stopPropagation(); setLabelling(null); } }} />
          : <button type="button" className="lib-sp-label" disabled={busy || item.archived} title={t('spd.sample.editLabel')} onClick={() => setLabelling({ id: sample.id, text: sample.label ?? '' })}>{sample.label ? <span>{sample.label}</span> : <span className="ui-faint">{t('spd.sample.noLabel')}</span>}<Icon name="edit" size={12} /></button>}
        <IconButton size="sm" icon="x" label={t('spd.sample.remove')} disabled={busy || item.archived} onClick={() => void run(() => api.assetLibrary({ action: 'mutate', command: 'remove-preview', items: target, previewId: sample.id }))} />
      </figcaption>
    </figure>)}</div>}
    {!item.archived && <div className="lib-row">
      <Button size="sm" icon="library" disabled={busy || full} title={full ? t('spd.sample.full', { max: STYLE_PRESET_PREVIEW_LIMIT }) : undefined} onClick={() => setPicking(true)} data-testid="style-preset-add-sample">{t('spd.sample.add')}</Button>
      <Button size="sm" variant="ghost" icon="folder" disabled={busy} onClick={() => setLocal(true)}>{t('spd.sample.addLocal')}</Button>
      {busy && <Spinner size={14} />}
    </div>}
    {picking && <SamplePicker api={api} name={itemTitle(item)} onClose={() => setPicking(false)}
      onPick={(image, label) => api.assetLibrary({ action: 'mutate', command: 'add-preview', items: target, image, ...(label ? { label } : {}) }).then(() => { setPicking(false); showToast({ message: t('spd.sample.added'), tone: 'ok' }); })} />}
    {local && <StylePresetImagesManager presetId={item.id} onClose={() => setLocal(false)} />}
  </Section>;
}

/** Chooses a history image or an imported image as a sample; the host copies it into the preset. */
function SamplePicker({ api, name, onClose, onPick }: { api: LibraryApi; name: string; onClose(): void; onPick(image: Record<string, unknown>, label: string): Promise<unknown> }) {
  const { t, lang } = useUiText();
  const [kind, setKind] = useState<'history' | 'study'>('history');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState('');
  const [label, setLabel] = useState('');
  useEffect(() => { const timer = setTimeout(() => setShown(query), 250); return () => clearTimeout(timer); }, [query]);
  const list = useLibraryItems(api, { action: 'ui-list', kinds: [kind], query: shown.trim(), archived: 'exclude', sortBy: 'createdAt', sortDirection: 'desc' }, true);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const pick = async (image: AssetItem) => {
    if (busy) return;
    setBusy(image.id); setFailure('');
    try {
      if (kind === 'history' && !image.preview?.assetId) throw Object.assign(new Error('This image has no registered original.'), { code: 'image_unavailable', reason: 'library.history_image_unregistered' });
      await onPick(kind === 'history' ? { kind, id: image.id, revision: image.revision, assetId: image.preview!.assetId } : { kind, id: image.id, revision: image.revision }, label.trim());
    } catch (error) { setFailure(libraryErrorText(error, t, lang)); setBusy(''); }
  };
  return <Dialog open onClose={onClose} busy={!!busy} icon="image" width={720} title={t('spd.sample.pickTitle', { name })} description={t('spd.sample.pickDesc')}
    footer={<Button onClick={onClose} disabled={!!busy}>{t('c.cancel')}</Button>}>
    <div className="lib-hcover" data-testid="style-preset-sample-picker">
      <div className="lib-row">
        <Seg<'history' | 'study'> size="sm" label={t('spd.sample.from')} value={kind} onChange={setKind} options={[{ value: 'history', label: t('spd.sample.history') }, { value: 'study', label: t('spd.sample.imports') }]} />
        <SearchInput value={query} onChange={setQuery} placeholder={t('lib.search')} label={t('lib.searchShort')} clearLabel={t('lib.clearSearch')} />
      </div>
      <Field label={t('spd.sample.label')}><TextInput maxLength={60} value={label} placeholder={t('spd.sample.labelPh')} onChange={event => setLabel(event.target.value)} /></Field>
      {failure && <p className="lib-error" role="alert"><Icon name="alert" size={14} /><span>{failure}</span></p>}
      {list.loading && !list.items.length && <p className="lib-wait" role="status"><Spinner size={14} /> {t('c.loading')}</p>}
      {!list.loading && !list.items.length && <p className="ui-muted">{t('empty.search.t')}</p>}
      <div className="lib-hcover-grid">
        {list.items.map(image => <button key={image.id} type="button" className="lib-all-img" disabled={!!busy} title={itemTitle(image)} aria-label={t('spd.sample.use', { name: itemTitle(image) })} onClick={() => void pick(image)} data-testid={`style-preset-sample-${image.id}`}>
          <Thumb api={api} item={image} alt="" />{busy === image.id && <span className="lib-hcover-busy"><Spinner size={16} /></span>}
        </button>)}
      </div>
      {list.hasMore && <Button size="sm" variant="ghost" busy={list.loadingMore} onClick={list.loadMore}>{t('tag.coverMore')}</Button>}
    </div>
  </Dialog>;
}

/**
 * The edit fields of a Style preset beside its name and group: the artists, the rest of the Style (`prompt`), the
 * Style as it will be applied, the two negative texts and the recommended settings.
 */
export function StylePresetFields({ draft, prompt, onChange, onPrompt }: { draft: StylePresetDraft; prompt: string; onChange(patch: Partial<StylePresetDraft>): void; onPrompt(prompt: string): void }) {
  const { t } = useUiText();
  const texts = useParamTexts();
  const setArtist = (index: number, patch: Partial<StylePresetArtist>) => onChange({ artists: draft.artists.map((artist, i) => i === index ? { ...artist, ...patch } : artist) });
  const extract = () => {
    const found = splitArtists(prompt), room = STYLE_PRESET_ARTIST_LIMIT - draft.artists.length;
    if (!found.artists.length || room <= 0) { showToast({ message: t('spd.artist.none') }); return; }
    // What does not fit the list stays in the text.
    const taken = found.artists.slice(0, room), left = found.artists.slice(room);
    onChange({ artists: [...draft.artists, ...taken] });
    onPrompt(joinPromptParts(...left.map(artist => artist.weight === 1 ? artist.name : `${artist.weight}::${artist.name}::`), found.prompt));
    showToast({ message: t('spd.artist.extracted', { n: taken.length }), tone: 'ok' });
  };
  const splitText = () => {
    const split = splitTextNegative(draft.negativePrompt);
    if (!split.textNegativePrompt) { showToast({ message: t('spd.splitText.none') }); return; }
    onChange({ negativePrompt: split.negativePrompt, textNegativePrompt: joinPromptParts(draft.textNegativePrompt, split.textNegativePrompt) });
  };
  const setParam = (key: ParamKey, value: string | number) => onChange({ params: { ...draft.params, [key]: value } });
  const applied = stylePresetStyleText({ prompt, artists: draft.artists });
  return <>
    <Field label={t('spd.artists')} hint={t('spd.artist.hint')}><div className="lib-edit-members" data-testid="style-preset-artists">
      {draft.artists.map((artist, index) => <div key={index} className="lib-sp-artist">
        <Toggle checked={artist.enabled} label={t('spd.artist.use', { n: index + 1 })} onChange={enabled => setArtist(index, { enabled })} />
        <TextInput className="ui-mono" aria-label={t('spd.artist.name', { n: index + 1 })} placeholder="artist:" value={artist.name} onChange={event => setArtist(index, { name: event.target.value })} />
        <TextInput type="number" aria-label={t('edit.weight')} step={0.1} value={Number.isFinite(artist.weight) ? artist.weight : ''} onChange={event => setArtist(index, { weight: event.target.value === '' ? Number.NaN : Number(event.target.value) })} />
        <IconButton size="sm" icon="x" label={t('spd.artist.remove', { n: index + 1 })} onClick={() => onChange({ artists: draft.artists.filter((_, i) => i !== index) })} />
      </div>)}
      <div className="lib-row">
        <Button size="sm" variant="ghost" icon="plus" disabled={draft.artists.length >= STYLE_PRESET_ARTIST_LIMIT} onClick={() => onChange({ artists: [...draft.artists, { name: 'artist:', weight: 1, enabled: true }] })}>{t('spd.artist.add')}</Button>
        <Button size="sm" variant="ghost" icon="wand" onClick={extract}>{t('spd.artist.extract')}</Button>
      </div>
    </div></Field>
    <Field label={draft.artists.length ? t('spd.prompt') : t('edit.prompt')}><TextArea rows={5} className="ui-mono" value={prompt} onChange={event => onPrompt(event.target.value)} /></Field>
    {draft.artists.length > 0 && <Field label={t('spd.style')}><p className="lib-ptext ui-mono" data-testid="style-preset-applied">{applied || t('spd.style.none')}</p></Field>}
    <Field label={t('spd.negative')}><TextArea rows={3} className="ui-mono" value={draft.negativePrompt} onChange={event => onChange({ negativePrompt: event.target.value })} /></Field>
    <Field label={t('spd.textNegative')} hint={t('spd.textNegativeHint')}>
      <TextArea rows={2} className="ui-mono" value={draft.textNegativePrompt} onChange={event => onChange({ textNegativePrompt: event.target.value })} />
      <div className="lib-row"><Button size="sm" variant="ghost" icon="wand" onClick={splitText}>{t('spd.splitText')}</Button></div>
    </Field>
    <Field label={t('spd.params')} hint={t('spd.params.hint')}><div className="lib-sp-pgrid" data-testid="style-preset-params">
      {PARAM_KEYS.map(key => {
        const rule = NUMBER_PARAMS[key], options = texts.options[key];
        return <label key={key} className="lib-sp-param"><span>{texts.labels[key]}</span>
          {rule ? <TextInput type="number" aria-label={texts.labels[key]} min={rule.min} max={rule.max} step={rule.step} placeholder={t('spd.unset')} value={draft.params[key] ?? ''} onChange={event => setParam(key, event.target.value)} />
            : <Select<string | number> label={texts.labels[key]} value={draft.params[key] ?? ''} onChange={value => setParam(key, value)} options={[{ value: '', label: t('spd.unset') }, ...(options ?? [])]} />}
        </label>;
      })}
    </div></Field>
  </>;
}
