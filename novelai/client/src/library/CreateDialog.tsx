import { useRef, useState } from 'react';
import type { AssetItem } from '../asset-library/types';
import { libraryErrorText } from './errors';
import { Button, Dialog, Field, Icon, Seg, TextArea, TextInput, showToast } from '../ui';
import type { DanbooruTagResult } from '../workspace/danbooru-types';
import { useUiText } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import type { MaterialSource, MaterialTarget } from '../workspace/material-library-types';
import type { LibraryApi } from './api';
import { createItem, type NewKind } from './MaterialDetail';

/** 添加标签's Danbooru search: asked explicitly, eight candidates (the canvas picker's request). */
export const danbooruTagSearch = (api: LibraryApi, query: string) => api.materialTags!({ action: 'search', query: query.trim(), limit: 8 }) as Promise<DanbooruTagResult>;
/** A picked candidate fills in the tag text as Danbooru writes it; an artist (category 1) belongs in Style. */
export const pickDanbooruTag = (item: { name: string; category: number }): { text: string; target?: MaterialTarget } => ({ text: item.name, ...(item.category === 1 ? { target: 'style' as const } : {}) });

const TITLES: Record<NewKind, UiStringKey> = { tag: 'edit.newTag', combo: 'edit.newCombo', note: 'edit.newNote', style_preset: 'edit.newStyle', positive_preset: 'edit.newPositive', prompt_chunk: 'edit.newChunk' };

/**
 * 添加标签 / 新建心得 / 新建组合 / 新建预设: a small form; the host saves it (a Danbooru tag is checked by the host
 * while it saves). The new item opens in the drawer.
 */
export function CreateDialog({ api, kind, onClose, onCreated }: { api: LibraryApi; kind: NewKind; onClose(): void; onCreated(item: { kind: AssetItem['kind']; id: string }): void }) {
  const { t, lang } = useUiText();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [source, setSource] = useState<MaterialSource>('danbooru');
  const [target, setTarget] = useState<MaterialTarget>('base');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement | null>(null);
  // 添加标签 with a Danbooru search (step 4c1, 4b1 leftover): asked explicitly (it needs the internet), never as you type.
  const [dan, setDan] = useState<{ busy: boolean; asked: string; result: DanbooruTagResult | null; error: string }>({ busy: false, asked: '', result: null, error: '' });
  const searchDanbooru = async () => {
    const q = text.trim();
    if (!q || dan.busy || !api.materialTags) return;
    setDan({ busy: true, asked: q, result: null, error: '' });
    try { setDan({ busy: false, asked: q, result: await danbooruTagSearch(api, q), error: '' }); }
    catch (failure) { setDan({ busy: false, asked: q, result: null, error: libraryErrorText(failure, t, lang) }); }
  };
  const tag = kind === 'tag';
  const ready = tag ? !!text.trim() : !!name.trim();
  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setError('');
    try {
      const created = await createItem(api, kind, { name: tag ? (name.trim() || text.trim()) : name, text, source, target, notes: kind === 'prompt_chunk' || kind === 'style_preset' || kind === 'positive_preset' ? '' : body, prompt: body });
      showToast({ message: t('edit.saved'), tone: 'ok' });
      onCreated(created);
    } catch (failure) { setError(libraryErrorText(failure, t, lang)); setBusy(false); }
  };
  return <Dialog open onClose={onClose} busy={busy} title={t(TITLES[kind])} width={480} initialFocusRef={first}
    footer={<><Button onClick={onClose} disabled={busy}>{t('c.cancel')}</Button><Button variant="primary" busy={busy} disabled={!ready} onClick={() => void submit()}>{t('c.save')}</Button></>}>
    <form className="lib-edit" onSubmit={event => { event.preventDefault(); void submit(); }}>
      {tag && <>
        <Field label={t('edit.text')}><TextInput ref={first} className="ui-mono" value={text} placeholder="smile" onChange={event => setText(event.target.value)} /></Field>
        {source === 'danbooru' && api.materialTags && <div className="lib-create-dan" data-testid="create-danbooru">
          <Button size="sm" variant="ghost" icon="search" busy={dan.busy} disabled={!text.trim()} onClick={() => void searchDanbooru()} data-testid="create-danbooru-search">{text.trim() ? t('edit.danSearch', { q: text.trim() }) : t('edit.danSearchEmpty')}</Button>
          {dan.error && <p className="lib-error" role="alert"><Icon name="alert" size={14} /><span>{t('edit.danFailed', { reason: dan.error })}</span></p>}
          {dan.result && !dan.result.items.length && <p className="ui-muted">{t('edit.danNone')}</p>}
          {dan.result && dan.result.items.length > 0 && <div className="lib-create-dan-list" role="list">
            {dan.result.items.map(item => <button key={item.name} type="button" role="listitem" className={`lib-create-dan-item${text.trim() === item.name ? ' is-on' : ''}`} onClick={() => { const picked = pickDanbooruTag(item); setText(picked.text); if (picked.target) setTarget(picked.target); }} data-testid={`create-danbooru-${item.name}`}>
              <span className="ui-mono">{item.name}</span><span className="ui-faint ui-num">{[t('tag.posts', { n: item.postCount }), item.category === 1 ? t('edit.danArtist') : ''].filter(Boolean).join(' · ')}</span>
            </button>)}
            <p className="ui-faint lib-create-dan-hint">{t('edit.danHint')}</p>
          </div>}
        </div>}
        <Field label={t('edit.source')}><Seg<MaterialSource> full label={t('edit.source')} value={source} onChange={setSource} options={(['danbooru', 'nai', 'english'] as const).map(value => ({ value, label: t(`src.${value}`) }))} /></Field>
        <Field label={t('edit.target')}><Seg<MaterialTarget> full label={t('edit.target')} value={target} onChange={setTarget} options={(['style', 'base', 'character'] as const).map(value => ({ value, label: t(`tag.target.${value}`) }))} /></Field>
      </>}
      <Field label={t('edit.name')}><TextInput ref={tag ? undefined : first} value={name} placeholder={tag ? text : undefined} onChange={event => setName(event.target.value)} /></Field>
      {kind !== 'combo' && <Field label={kind === 'note' ? t('side.notes') : kind === 'prompt_chunk' ? t('edit.content') : kind === 'tag' ? t('edit.notes') : t('edit.prompt')}>
        <TextArea rows={kind === 'note' ? 8 : 4} value={body} onChange={event => setBody(event.target.value)} /></Field>}
      {error && <p className="lib-error" role="alert">{error}</p>}
    </form>
  </Dialog>;
}
