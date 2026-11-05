import { useRef, useState, type ReactNode } from 'react';
import type { AssetDetail, AssetItem } from '../asset-library/types';
import { assetQueryKey, useLocalAssetQuery } from '../asset-library/query';
import { libraryErrorText } from './errors';
import { Button, Field, Icon, IconButton, Seg, Spinner, Tag, TextArea, TextInput, showToast } from '../ui';
import { formatNumber, useUiText, type UiText } from '../ui/i18n';
import type { MaterialComponent, MaterialEntry, MaterialSource, MaterialTarget } from '../workspace/material-library-types';
import { localCoverUploadRequest, LOCAL_COVER_ACCEPT, validateLocalCoverFile } from '../workspace/local-cover-upload';
import { materialPrompt } from '../workspace/material-library-ui';
import type { LibraryApi } from './api';
import { Thumb } from './Thumb';
import { HistoryCoverPicker } from './HistoryCoverPicker';
import { cardExcerpt, itemTitle } from './present';

/**
 * The drawer of tags, combos, notes, presets and artist picks (prototype 09, 10): cover, the main action, the content
 * and, for tags, use, Danbooru facts, cover and examples (loaded only when asked, General rating; user decision 8).
 * Edits save with the revision they started from; a conflict shows the host's text and nothing is retried.
 */
export interface MaterialDetailProps {
  api: LibraryApi;
  detail: AssetDetail;
  onAddToTray?(item: AssetItem): void;
  onUseOnCanvas?(item: AssetItem): void;
  onDelete(): void;
  editing: boolean;
  onEditing(editing: boolean): void;
}

const TARGETS: MaterialTarget[] = ['style', 'base', 'character'];
const SOURCES: MaterialSource[] = ['danbooru', 'nai', 'english'];
type Draft = { name: string; group: string; notes: string; text: string; source: MaterialSource; target: MaterialTarget; prompt: string; components: MaterialComponent[]; strength: number; infoExtracted: number; fidelity: number };
/** Unsaved edits survive closing the drawer during this run (key: kind:id:revision). */
const drafts = new Map<string, Draft>();
export const hasUnsavedDraft = (item: Pick<AssetItem, 'kind' | 'id' | 'revision'>) => drafts.has(`${item.kind}:${item.id}:${item.revision}`);

function draftOf(item: AssetItem): Draft {
  const payload = item.payload ?? {};
  return { name: item.name ?? '', group: String(payload.group ?? ''), notes: String(payload.notes ?? ''), text: String(payload.tag?.text ?? ''), source: payload.tag?.source ?? 'danbooru', target: payload.tag?.target ?? 'base',
    prompt: String(item.kind === 'prompt_chunk' ? payload.content ?? '' : payload.prompt ?? ''), components: structuredClone(payload.components ?? []), strength: Number(payload.strength ?? 1), infoExtracted: Number(payload.infoExtracted ?? 1), fidelity: Number(payload.fidelity ?? 1) };
}
const isMaterial = (kind: AssetItem['kind']) => kind === 'tag' || kind === 'combo' || kind === 'note';
/** A tag's Danbooru check in four words (the host's evidence.resolution: canonical, alias, not_found, unknown). */
export function tagResolution(evidence: { resolution?: unknown; tagStatus?: unknown } | null | undefined): 'canonical' | 'alias' | 'not_found' | 'unknown' {
  const value = evidence?.resolution;
  if (value === 'canonical' || value === 'alias' || value === 'not_found') return value;
  return evidence?.tagStatus === 'not_found' ? 'not_found' : 'unknown';
}
export const isEditable = (kind: AssetItem['kind']) => kind !== 'artist_favorite' && kind !== 'history' && kind !== 'study';

/** Saves the edit of one item through its own entry point (material_library for tags/combos/notes, asset_library update otherwise). */
export async function saveEdit(api: LibraryApi, item: AssetItem, draft: Draft) {
  if (isMaterial(item.kind)) {
    const payload = item.payload ?? {};
    const entry = { kind: item.kind, name: draft.name.trim(), group: draft.group.trim(), notes: draft.notes,
      ...(item.kind === 'tag' ? { tag: { ...payload.tag, text: draft.text.trim(), source: draft.source, target: draft.target } } : {}),
      ...(item.kind === 'combo' ? { components: draft.components } : {}), ...(payload.links ? { links: payload.links } : {}) };
    return api.materialLibrary!({ action: 'save', id: item.id, expectedRevision: item.revision, entry });
  }
  const patch: Record<string, unknown> = { name: draft.name.trim() };
  if (item.kind === 'style_preset') Object.assign(patch, { group: draft.group.trim(), prompt: draft.prompt });
  if (item.kind === 'positive_preset') patch.prompt = draft.prompt;
  if (item.kind === 'prompt_chunk') patch.content = draft.prompt;
  if (item.kind === 'reference_preset') Object.assign(patch, { group: draft.group.trim(), strength: draft.strength, ...(item.payload?.kind === 'vibe' ? { infoExtracted: draft.infoExtracted } : { fidelity: draft.fidelity }) });
  return api.assetLibrary({ action: 'mutate', command: 'update', items: [{ kind: item.kind, id: item.id, expectedRevision: item.revision }], patch });
}

export function MaterialDetail({ api, detail, onAddToTray, onUseOnCanvas, onDelete, editing, onEditing }: MaterialDetailProps) {
  const { t } = useUiText();
  const item = detail.item;
  const key = `${item.kind}:${item.id}:${item.revision}`;
  if (editing && isEditable(item.kind)) return <EditForm key={key} api={api} item={item} onDone={() => onEditing(false)} />;
  const payload = item.payload ?? {};
  const image = item.kind === 'tag' || item.preview || item.kind === 'artist_favorite';
  const primary = item.kind === 'tag' || item.kind === 'combo'
    ? onAddToTray && !item.archived && <Button variant="primary" icon="combo" onClick={() => onAddToTray(item)}>{t('tag.toTray')}</Button>
    : item.kind !== 'note' && onUseOnCanvas && !item.archived && <Button variant="primary" icon="canvas" onClick={() => onUseOnCanvas(item)}>{t('pre.useOnCanvas')}</Button>;
  return <div className="lib-detail">
    {image && <div className="lib-dr-cover"><Thumb api={api} item={item} icon={item.kind === 'tag' ? 'tag' : 'image'} alt={itemTitle(item)} /></div>}
    <div className="lib-dr-actions">
      {primary}
      {isEditable(item.kind) && <Button icon="edit" onClick={() => onEditing(true)}>{t('c.edit')}{hasUnsavedDraft(item) && <Tag tone="warn">{t('edit.unsaved')}</Tag>}</Button>}
      <IconButton icon="trash" className="lib-danger-icon" label={t('d.delete')} onClick={onDelete} />
    </div>
    {item.kind === 'tag' && <TagSections api={api} item={item} t={t} />}
    {item.kind === 'combo' && <Section title={t('edit.members')}><ul className="lib-members">{(payload.components ?? []).map((member: MaterialComponent, index: number) => <li key={index}><span className="ui-mono">{member.text}</span><span className="ui-faint ui-num">×{member.weight}</span><Tag>{t(`tag.target.${member.target}`)}</Tag></li>)}</ul>
      <Copyable t={t} text={safePrompt(payload.components ?? [])} /></Section>}
    {(item.kind === 'style_preset' || item.kind === 'positive_preset' || item.kind === 'prompt_chunk') && <Section title={item.kind === 'prompt_chunk' ? t('edit.content') : t('edit.prompt')}><Copyable t={t} text={String(item.kind === 'prompt_chunk' ? payload.content ?? '' : payload.prompt ?? '')} /></Section>}
    {item.kind === 'reference_preset' && <Section title={t('pre.kind.reference_preset')}><p className="lib-text">{cardExcerpt(item, t).text}</p></Section>}
    {item.kind === 'artist_favorite' && <Section title={t('artist.prompt')}>
      <ul className="lib-members">{(payload.artists ?? []).map((artist: { name: string; weight: number }, index: number) => <li key={index}><span className="ui-mono">{artist.name}</span><span className="ui-faint ui-num">×{artist.weight}</span></li>)}</ul>
      {payload.prompt && <Copyable t={t} text={String(payload.prompt)} />}
    </Section>}
    {payload.group && item.kind !== 'tag' && <Section title={t('edit.group')}><p className="lib-text">{String(payload.group)}</p></Section>}
    {payload.notes && <Section title={item.kind === 'note' ? t('side.notes') : t('tag.notes')}><p className="lib-text lib-notes">{String(payload.notes)}</p></Section>}
  </div>;
}

const safePrompt = (components: MaterialComponent[]) => { try { return materialPrompt(components); } catch { return ''; } };
function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return <section className="lib-sect"><div className="lib-sect-h"><h3>{title}</h3>{aside}</div>{children}</section>;
}
function Copyable({ text, t }: { text: string; t: UiText }) {
  if (!text) return null;
  return <div className="lib-ptext ui-mono">{text}<IconButton className="lib-ptext-cp" size="sm" icon="copy" label={t('c.copy')} onClick={() => { void navigator.clipboard?.writeText(text).then(() => showToast({ message: t('c.copied'), tone: 'ok', durationMs: 1800 })); }} /></div>;
}

type Sample = { postId: number; rating: string; score: number; sourceUrl: string };
function TagSections({ api, item, t }: { api: LibraryApi; item: AssetItem; t: UiText }) {
  const { lang } = useUiText();
  const tag = item.payload?.tag ?? {}, evidence = tag.evidence;
  const [busy, setBusy] = useState('');
  const [samples, setSamples] = useState<{ page: number; hasMore: boolean; items: Sample[] } | null>(null);
  const [sampleImages, setSampleImages] = useState<Record<number, string>>({});
  const [historyCover, setHistoryCover] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const entryQuery = useLocalAssetQuery<{ entry: MaterialEntry }>(assetQueryKey(api, 'materials', 'read', item.id, item.revision), () => api.materialLibrary!({ action: 'read', id: item.id }), !!api.materialLibrary);
  const entry = entryQuery.data?.entry;
  const run = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    try { await work(); } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); } finally { setBusy(''); }
  };
  const setTarget = (target: MaterialTarget) => run('target', async () => { await saveEdit(api, item, { ...draftOf(item), target }); });
  const verify = () => run('verify', async () => {
    await api.materialLibrary!({ action: 'save', id: item.id, expectedRevision: item.revision, refreshEvidence: true, entry: { kind: 'tag', name: item.name, group: item.payload?.group ?? '', notes: item.payload?.notes ?? '', tag, ...(item.payload?.links ? { links: item.payload.links } : {}) } });
    showToast({ message: t('tag.verified'), tone: 'ok' });
  });
  const loadSamples = (page = 1) => run('samples', async () => {
    const result = await api.materialSamples!({ action: 'list', entryId: item.id, revision: item.revision, page, limit: 6, minScore: 20, rating: 'g' }) as { page: number; hasMore: boolean; items: Sample[] };
    setSamples(result); setSampleImages({});
    await Promise.allSettled(result.items.map(async sample => {
      const image = await api.materialSamples!({ action: 'image', entryId: item.id, revision: item.revision, postId: sample.postId, variant: 'preview', minScore: 20, rating: sample.rating }) as { mimeType: string; data: string };
      setSampleImages(values => ({ ...values, [sample.postId]: `data:${image.mimeType};base64,${image.data}` }));
    }));
  });
  const setCover = (postId: number, rating: string) => run('cover', async () => {
    await api.materialSamples!({ action: 'set_cover', entryId: item.id, revision: item.revision, postId, expectedCoverRevision: entry?.coverRevision ?? 0, minScore: 20, rating });
    showToast({ message: t('tag.coverSaved'), tone: 'ok' });
  });
  const upload = (file: File) => run('cover', async () => {
    validateLocalCoverFile(file);
    const request = await localCoverUploadRequest(file, { id: item.id, revision: item.revision, coverRevision: entry?.coverRevision ?? 0, name: item.name });
    await api.materialSamples!(request);
    showToast({ message: t('tag.coverSaved'), tone: 'ok' });
  });
  const clearCover = () => run('cover', async () => { await api.materialSamples!({ action: 'clear_cover', entryId: item.id, expectedCoverRevision: entry?.coverRevision ?? 0 }); showToast({ message: t('tag.coverCleared'), tone: 'ok' }); });
  const danbooru = tag.source === 'danbooru';
  const canonicalOk = evidence && (!evidence.canonicalName || evidence.canonicalName === tag.text);
  return <>
    <Section title={t('tag.useAs')}><Seg<MaterialTarget> full label={t('tag.useAs')} value={tag.target ?? 'base'} onChange={value => void setTarget(value)} options={TARGETS.map(value => ({ value, label: t(`tag.target.${value}`), disabled: !!busy }))} /></Section>
    <Section title={t('tag.danbooru')} aside={danbooru ? <IconButton size="sm" icon="external" label={t('tag.openPost')} onClick={() => void window.naiDesktop?.openExternal?.(`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(String(tag.text ?? ''))}`)} /> : undefined}>
      {!danbooru ? <p className="lib-text ui-muted">{t('tag.notDanbooru')}</p> : !evidence ? <p className="lib-text ui-muted">{t('tag.notChecked')}</p> : <div className="lib-facts">
        <p>{(() => { const resolution = tagResolution(evidence); return <Tag tone={resolution === 'not_found' ? 'warn' : resolution === 'unknown' ? 'neutral' : 'ok'} icon={resolution === 'canonical' || resolution === 'alias' ? 'check' : undefined}>{t(`tag.res.${resolution}`)}</Tag>; })()}
          <span className="ui-num">{evidence.postCount == null ? t('tag.postsUnknown') : t('tag.facts.posts', { n: Number(evidence.postCount) })}</span>
          {evidence.deprecated != null && <span>· {evidence.deprecated ? t('tag.facts.deprecated') : t('tag.facts.active')}</span>}
          <span>· {canonicalOk ? t('tag.facts.canonical') : t('tag.facts.alias', { name: String(evidence.canonicalName) })}</span></p>
        {evidence.wiki?.body && <p className="lib-wiki">{String(evidence.wiki.body).slice(0, 400)}</p>}
      </div>}
      {danbooru && <Button size="sm" variant="ghost" icon="refresh" busy={busy === 'verify'} onClick={() => void verify()}>{t('tag.verify')}</Button>}
    </Section>
    <Section title={t('tag.cover')}>
      <div className="lib-row">
        <Button size="sm" icon="upload" busy={busy === 'cover'} onClick={() => fileInput.current?.click()}>{t('tag.coverUpload')}</Button>
        <Button size="sm" icon="image" disabled={!!busy || !api.materialSamples} onClick={() => setHistoryCover(true)} data-testid="tag-cover-history">{t('tag.coverHistory')}</Button>
        {entry?.cover && <Button size="sm" variant="ghost" onClick={() => void clearCover()}>{t('tag.coverClear')}</Button>}
        {!entry?.cover && <span className="ui-faint">{t('tag.noCover')}</span>}
        <input ref={fileInput} type="file" hidden accept={LOCAL_COVER_ACCEPT} aria-label={t('tag.coverUpload')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} />
      </div>
      {historyCover && <HistoryCoverPicker api={api} tag={{ id: item.id, revision: item.revision, coverRevision: entry?.coverRevision ?? 0, name: item.name }} onClose={() => setHistoryCover(false)}
        onSaved={() => { setHistoryCover(false); showToast({ message: t('tag.coverSaved'), tone: 'ok' }); }} />}
    </Section>
    {danbooru && <Section title={t('tag.examples')} aside={<span className="ui-faint">{t('tag.examplesRating')}</span>}>
      {!samples ? <Button size="sm" variant="ghost" icon="globe" busy={busy === 'samples'} onClick={() => void loadSamples(1)}>{t('tag.loadExamples')}</Button> : <>
        {samples.items.length === 0 && <p className="lib-text ui-muted">{t('tag.examplesNone')}</p>}
        <div className="lib-samples">{samples.items.map(sample => <figure key={sample.postId} className="lib-sample">
          {sampleImages[sample.postId] ? <img src={sampleImages[sample.postId]} alt={`Danbooru #${sample.postId}`} /> : <span className="lib-sample-wait"><Spinner size={14} /></span>}
          <figcaption><span className="ui-num">#{sample.postId} · {formatNumber(sample.score, lang)}</span>
            <IconButton size="sm" icon="external" label={t('tag.openPost')} onClick={() => void window.naiDesktop?.openExternal?.(sample.sourceUrl)} />
            <IconButton size="sm" icon="image" label={t('tag.setCover')} disabled={!!busy} onClick={() => void setCover(sample.postId, sample.rating)} /></figcaption>
        </figure>)}</div>
        {samples.hasMore && <Button size="sm" variant="ghost" busy={busy === 'samples'} onClick={() => void loadSamples(samples.page + 1)}>{t('tag.examplesMore')}</Button>}
      </>}
    </Section>}
  </>;
}

function EditForm({ api, item, onDone }: { api: LibraryApi; item: AssetItem; onDone(): void }) {
  const { t, lang } = useUiText();
  const key = `${item.kind}:${item.id}:${item.revision}`;
  const [draft, setDraftState] = useState<Draft>(() => drafts.get(key) ?? draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setDraft = (patch: Partial<Draft>) => setDraftState(current => { const next = { ...current, ...patch }; drafts.set(key, next); return next; });
  const save = async () => {
    if (!draft.name.trim()) { setError(t('edit.nameRequired')); return; }
    if (item.kind === 'tag' && !draft.text.trim()) { setError(t('edit.textRequired')); return; }
    if (draft.components.some(member => !(member.weight >= 0 && member.weight <= 10))) { setError(t('edit.weightRange')); return; }
    setBusy(true); setError('');
    try { await saveEdit(api, item, draft); drafts.delete(key); showToast({ message: t('edit.saved'), tone: 'ok' }); onDone(); }
    catch (failure) { setError(libraryErrorText(failure, t, lang)); setBusy(false); }
  };
  return <form className="lib-edit lib-sect" onSubmit={event => { event.preventDefault(); void save(); }}>
    <Field label={t('edit.name')}><TextInput value={draft.name} onChange={event => setDraft({ name: event.target.value })} /></Field>
    {item.kind === 'tag' && <>
      <Field label={t('edit.text')}><TextInput className="ui-mono" value={draft.text} onChange={event => setDraft({ text: event.target.value })} /></Field>
      <Field label={t('edit.source')}><Seg<MaterialSource> full label={t('edit.source')} value={draft.source} onChange={source => setDraft({ source })} options={SOURCES.map(value => ({ value, label: t(`src.${value}`) }))} /></Field>
      <Field label={t('edit.target')}><Seg<MaterialTarget> full label={t('edit.target')} value={draft.target} onChange={target => setDraft({ target })} options={TARGETS.map(value => ({ value, label: t(`tag.target.${value}`) }))} /></Field>
    </>}
    {(item.kind === 'tag' || item.kind === 'combo' || item.kind === 'note' || item.kind === 'style_preset' || item.kind === 'reference_preset') && <Field label={t('edit.group')}><TextInput value={draft.group} onChange={event => setDraft({ group: event.target.value })} /></Field>}
    {(item.kind === 'style_preset' || item.kind === 'positive_preset' || item.kind === 'prompt_chunk') && <Field label={item.kind === 'prompt_chunk' ? t('edit.content') : t('edit.prompt')}><TextArea rows={6} value={draft.prompt} onChange={event => setDraft({ prompt: event.target.value })} /></Field>}
    {item.kind === 'reference_preset' && <div className="lib-row">
      <Field label={t('pre.ref.strength', { v: '' }).trim()}><TextInput type="number" min={0} max={1} step={0.05} value={draft.strength} onChange={event => setDraft({ strength: Number(event.target.value) })} /></Field>
      {item.payload?.kind === 'vibe' ? <Field label={t('pre.ref.info', { v: '' }).trim()}><TextInput type="number" min={0} max={1} step={0.05} value={draft.infoExtracted} onChange={event => setDraft({ infoExtracted: Number(event.target.value) })} /></Field>
        : <Field label={t('pre.ref.fidelity', { v: '' }).trim()}><TextInput type="number" min={0} max={1} step={0.05} value={draft.fidelity} onChange={event => setDraft({ fidelity: Number(event.target.value) })} /></Field>}
    </div>}
    {item.kind === 'combo' && <Field label={t('edit.members')}><div className="lib-edit-members">
      {draft.components.map((member, index) => <div key={index} className="lib-edit-member">
        <TextInput className="ui-mono" aria-label={t('edit.member', { n: index + 1 })} value={member.text} onChange={event => setDraft({ components: draft.components.map((value, i) => i === index ? { ...value, text: event.target.value, source: 'english' } : value) })} />
        <TextInput type="number" aria-label={t('edit.weight')} min={0} max={10} step={0.1} value={member.weight} onChange={event => setDraft({ components: draft.components.map((value, i) => i === index ? { ...value, weight: Number(event.target.value) } : value) })} />
        <Seg<MaterialTarget> size="sm" label={t('edit.target')} value={member.target} onChange={target => setDraft({ components: draft.components.map((value, i) => i === index ? { ...value, target } : value) })} options={TARGETS.map(value => ({ value, label: t(`tag.target.${value}`) }))} />
        <IconButton size="sm" icon="x" label={t('edit.removeMember', { n: index + 1 })} onClick={() => setDraft({ components: draft.components.filter((_, i) => i !== index) })} />
      </div>)}
      <Button size="sm" variant="ghost" icon="plus" onClick={() => setDraft({ components: [...draft.components, { text: '', source: 'english', category: null, target: 'base', weight: 1 }] })}>{t('edit.addMember')}</Button>
    </div></Field>}
    {(isMaterial(item.kind)) && <Field label={item.kind === 'note' ? t('side.notes') : t('edit.notes')}><TextArea className="lib-edit-notes" rows={item.kind === 'note' ? 10 : 4} value={draft.notes} onChange={event => setDraft({ notes: event.target.value })} /></Field>}
    {error && <p className="lib-error" role="alert"><Icon name="alert" size={14} />{error}</p>}
    <div className="lib-row lib-edit-actions">
      <Button variant="ghost" disabled={busy} onClick={() => { drafts.delete(key); onDone(); }}>{t('edit.discard')}</Button>
      <Button variant="primary" type="submit" busy={busy}>{t('c.save')}</Button>
    </div>
  </form>;
}

/** Creating a tag, combo, note, Style preset, prompt preset or snippet. */
export type NewKind = 'tag' | 'combo' | 'note' | 'style_preset' | 'positive_preset' | 'prompt_chunk';
export async function createItem(api: LibraryApi, kind: NewKind, fields: { name: string; text?: string; source?: MaterialSource; target?: MaterialTarget; notes?: string; prompt?: string; components?: MaterialComponent[] }): Promise<{ kind: AssetItem['kind']; id: string }> {
  const name = fields.name.trim();
  if (kind === 'tag' || kind === 'combo' || kind === 'note') {
    const entry = { kind, name, group: '', notes: fields.notes ?? '', ...(kind === 'tag' ? { tag: { text: (fields.text ?? name).trim(), source: fields.source ?? 'danbooru', category: null, target: fields.target ?? 'base' } } : {}), ...(kind === 'combo' ? { components: fields.components ?? [] } : {}) };
    const result = await api.materialLibrary!({ action: 'save', entry }) as { entry: { id: string } };
    return { kind, id: result.entry.id };
  }
  const now = new Date().toISOString();
  const payload = kind === 'prompt_chunk' ? { name, content: fields.prompt ?? '', createdAt: now, updatedAt: now } : kind === 'style_preset' ? { name, prompt: fields.prompt ?? '', group: '', createdAt: now } : { name, prompt: fields.prompt ?? '', createdAt: now };
  const result = await api.assetLibrary({ action: 'save', kind, payload }) as { item: { id: string } };
  return { kind, id: result.item.id };
}
