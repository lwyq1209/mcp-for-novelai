import { useEffect, useMemo, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { Button, Checkbox, Icon, Spinner, TextInput, showToast } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { hostErrorText } from '../host-errors';
import type { AssetDetail, AssetItem, AssetKind } from '../asset-library/types';
import { applyLibraryItem, artistFavoriteRecipe } from '../asset-library/apply';
import { appendPromptChunk } from '../prompt-chunks';
import { componentsFromEntry, materialPrompt } from '../workspace/material-library-ui';
import type { MaterialComponent, MaterialEntry } from '../workspace/material-library-types';
import { persistWorkspaceState } from '../store';
import type { DanbooruTagResult } from '../workspace/danbooru-types';
import { supportsNAIPreciseReference, supportsNAIVibeTransfer, type PromptTemplate } from '../types';
import { useLibraryItems } from '../library/data';
import { Thumb } from '../library/Thumb';
import { NameDialog } from '../library/dialogs';
import { createItem } from '../library/MaterialDetail';
import { cardExcerpt, itemTitle, modelName, samplerName, tagTarget } from '../library/present';
import { openInLibrary } from '../library/intent';
import type { LibraryApi } from '../library/api';
import type { LibraryCategory } from '../library/model';
import { navigate } from '../shell/route';
import { imageFromAssetDetail, stageImageInput } from '../app/ImageActions';
import type { GenerationSourceMode } from '../workspace/source-selection';
import { StylePresetImagesManager } from './StylePresetImages';
import type { PositivePromptPreset } from '../types';
import { Popover } from './controls';
import type { RecipeScope } from './scope';
import { planCombo, readComboFields, writeComboFields, type ComboScope } from './combo-apply';
import { showStepToast } from './guarded-undo';

/**
 * The canvas's library picker (step 4b3c; DESIGN §3.3: "画布里的「素材库」按钮只是弹出选择器，往提示词里插入"). It replaces
 * the old material rail on the canvas and the prompt box's old preset and snippet buttons. Reads go through the
 * library page's own queries (the window's ui-list); nothing here edits the library except the explicit saves
 * (保存当前为正文预设, a Danbooru tag 存入素材库). Managing, versions and the other library work stay in the library.
 */

const api = () => window.naiDesktop as unknown as LibraryApi;
const EMPTY_TEMPLATES: PromptTemplate[] = [];
const EMPTY_POSITIVE: PositivePromptPreset[] = [];

export type PickerField = 'positive' | 'negative' | 'character';
export type PromptTab = 'tags' | 'combos' | 'chunks' | 'presets' | 'templates' | 'artists';
const TAB_KINDS: Record<Exclude<PromptTab, 'templates'>, AssetKind> = { tags: 'tag', combos: 'combo', chunks: 'prompt_chunk', presets: 'positive_preset', artists: 'artist_favorite' };
const TAB_CATEGORY: Record<Exclude<PromptTab, 'templates'>, LibraryCategory> = { tags: 'tags', combos: 'combos', chunks: 'presets', presets: 'presets', artists: 'artists' };

/** The list request of one kind in the picker (the library page's ui-list, newest first, archived left out). */
export function pickerRequest(kind: AssetKind, query: string): Record<string, unknown> {
  const images = kind === 'history' || kind === 'study';
  return { action: 'ui-list', kinds: [kind], query: query.trim(), archived: 'exclude', sortBy: images ? 'createdAt' : 'updatedAt', sortDirection: 'desc' };
}

/** The text a tag or combo inserts: its members with their weights (the composer's materialPrompt), Style members too. */
export function insertionText(item: AssetItem): string {
  if (item.kind === 'tag' || item.kind === 'combo') return materialPrompt(componentsFromEntry({ ...(item.payload as MaterialEntry), id: item.id, revision: item.revision }));
  if (item.kind === 'prompt_chunk') return String(item.payload?.content ?? '');
  return String(item.payload?.prompt ?? '');
}

/** A Danbooru candidate as prompt text: artists are written artist:<name>, as the composer does. */
export const danbooruText = (name: string, category: number) => category === 1 && !/^artist:/i.test(name) ? `artist:${name}` : name;

function useDebounced(value: string, ms = 220) {
  const [shown, setShown] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setShown(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return shown;
}

function ListState({ loading, error, empty, query, none }: { loading: boolean; error: Error | null; empty: boolean; query: string; none?: string }) {
  const { t, language } = useUiText();
  if (loading) return <p className="cv-pop-empty ui-faint"><Spinner size={12} /> {t('cv.lib.loading')}</p>;
  if (error) return <p className="cv-pop-empty cv-hint--warn" role="alert">{t('cv.lib.loadFailed', { reason: hostErrorText(error, language) })}</p>;
  if (empty) return <p className="cv-pop-empty ui-faint">{query.trim() ? t('cv.lib.noMatch') : none ?? t('cv.lib.none')}</p>;
  return null;
}

/**
 * The prompt's 素材库 picker: tags, combos, snippets and prompt presets for the field it was opened from, the prompt
 * templates (positive prompt) and artist picks (the base positive prompt only). Tags and snippets are added at the end
 * (appendPromptChunk); a prompt preset replaces the field; a combo goes by the use of its members (combo-apply.ts) or,
 * on request, all into this field; an artist pick shows its recipe first and applies it on 应用这套配方. Every step can
 * be undone from its toast while the fields it touched are unchanged since (guarded-undo.ts).
 */
export function PromptLibraryPicker({ open, anchor, onClose, field, scope = 'base', comboScope, value, read, onChange, onTemplate, characterId, characterNumber, initialTab = 'tags' }: {
  open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void; field: PickerField; scope?: RecipeScope;
  /** Where a combo's members go (default: the recipe scope; legacyInpaint when the field is the legacy inpaint prompt). */
  comboScope?: ComboScope;
  value: string;
  /** The field's value now (for the undo); default: value as rendered. */
  read?: () => string;
  onChange(next: string): void;
  onTemplate?(template: PromptTemplate): void; characterId?: string; characterNumber?: number; initialTab?: PromptTab;
}) {
  const { t } = useUiText();
  const templates = useAppStore(state => state.settings?.promptTemplates ?? EMPTY_TEMPLATES);
  const combos: ComboScope = comboScope ?? (scope === 'inpaint' ? 'inpaint' : 'base');
  const tabs = useMemo(() => pickerTabs(field, combos, !!onTemplate), [field, combos, onTemplate]);
  const [tab, setTab] = useState<PromptTab>(initialTab);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [imagesFor, setImagesFor] = useState('');
  const current = tabs.includes(tab) ? tab : 'tags';
  const fieldName = field === 'character' ? t('cv.lib.f.character', { n: characterNumber ?? 1 }) : t(field === 'negative' ? 'cv.lib.f.negative' : 'cv.lib.f.positive');
  const readField = read ?? (() => value);
  const apply = (next: string, message: string) => {
    const before = readField();
    onChange(next);
    showStepToast(t, message, { read: readField, after: next, restore: () => onChange(before) });
  };
  const pick = (item: AssetItem) => {
    const name = itemTitle(item);
    // A preset replaces the field and closes the picker; tags and snippets can be added one after another.
    if (item.kind === 'positive_preset') { apply(insertionText(item), t('cv.lib.replaced', { name })); onClose(); }
    else apply(appendPromptChunk(readField(), insertionText(item)), t('cv.lib.inserted', { name }));
  };
  const insertAll = (item: AssetItem) => {
    const text = safeText(item);
    if (!text) { showToast({ message: t('cv.combo.badWeight'), tone: 'warn' }); return; }
    apply(appendPromptChunk(readField(), text), t('cv.lib.inserted', { name: itemTitle(item) }));
  };
  return <>
    <Popover open={open} anchor={anchor} onClose={onClose} label={t('cv.lib.title')} width={392} className="cv-lib-pop">
      <div className="cv-lib-head">
        <div className="cv-lib-title"><b>{t('cv.lib.title')}</b><span className="ui-faint">{t('cv.lib.into', { field: fieldName })}</span></div>
        <div className="cv-lib-tabs" role="tablist" aria-label={t('cv.lib.tabs')}>
          {tabs.map(value => <button key={value} type="button" role="tab" aria-selected={current === value} className={clsx('cv-lib-tab', current === value && 'is-on')} onClick={() => setTab(value)} data-testid={`cv-lib-tab-${value}`}>{t(`cv.lib.t.${value}`)}</button>)}
        </div>
        {current !== 'templates' && <TextInput className="cv-lib-search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('cv.lib.search')} aria-label={t('cv.lib.search')} data-testid="cv-lib-search" />}
      </div>
      {current === 'templates'
        ? <TemplateList templates={templates} onPick={template => { onTemplate?.(template); onClose(); }} />
        : current === 'combos'
          ? <ComboList key="combos" query={query} scope={combos} openedFrom={field === 'character' ? characterId : undefined} onInsertAll={insertAll} />
          : current === 'artists'
            ? <ArtistList key="artists" query={query} onApplied={onClose} />
            : <KindList key={current} tab={current} query={query} onImages={id => { onClose(); setImagesFor(id); }} onPick={pick} />}
      {current === 'tags' && <DanbooruSearch query={query} onInsert={(text, name) => apply(appendPromptChunk(readField(), text), t('cv.lib.inserted', { name }))} />}
      <div className="cv-pop-foot">
        {current === 'presets' && <Button size="sm" variant="ghost" icon="plus" onClick={() => { onClose(); setSaving(true); }}>{t('cv.lib.saveCurrent')}</Button>}
        {current === 'templates'
          ? <Button size="sm" variant="ghost" icon="settings" onClick={() => { onClose(); navigate('settings', 'canvas'); }}>{t('cv.lib.tplManage')}</Button>
          : <Button size="sm" variant="ghost" icon="library" onClick={() => { onClose(); openInLibrary({ view: { type: 'category', category: TAB_CATEGORY[current] } }); }}>{t('cv.lib.manage')}</Button>}
      </div>
    </Popover>
    {imagesFor && <StylePresetImagesManager kind="positive" presetId={imagesFor} onClose={() => setImagesFor('')} />}
    {saving && <NameDialog title={t('cv.lib.saveTitle')} label={t('cv.lib.saveName')} initial={value.trim().slice(0, 28)} confirmLabel={t('c.save')} onClose={() => setSaving(false)} onSubmit={async name => {
      if (!value.trim()) { showToast({ message: t('cv.lib.needText'), tone: 'warn' }); return; }
      await createItem(api(), 'positive_preset', { name, prompt: value.trim() });
      await useAppStore.getState().refreshSettings();
      setSaving(false);
      showToast({ message: t('cv.lib.saved', { name }), tone: 'ok' });
    }} />}
  </>;
}

/**
 * The picker's tabs for a field: templates on the positive prompt; artist picks only on the Txt2Img positive prompt
 * (they replace the Txt2Img recipe, so not from Inpaint, legacy or separate, nor from the negative or a character).
 */
export function pickerTabs(field: PickerField, scope: ComboScope, templates: boolean): PromptTab[] {
  const list: PromptTab[] = ['tags', 'combos', 'chunks', 'presets'];
  if (field === 'positive' && templates) list.push('templates');
  if (field === 'positive' && scope === 'base') list.push('artists');
  return list;
}

/** The members of a combo item (the composer's componentsFromEntry). */
export const comboMembers = (item: AssetItem): MaterialComponent[] => componentsFromEntry({ ...(item.payload as MaterialEntry), id: item.id, revision: item.revision });

/** Which character a combo's character members go to: the one the picker was opened from, else the only one, else none. */
export function defaultComboCharacter(openedFrom: string | undefined, captions: readonly { id: string }[]): string {
  if (openedFrom && captions.some(caption => caption.id === openedFrom)) return openedFrom;
  return captions.length === 1 ? captions[0].id : '';
}

/**
 * Applies a combo by the use of its members and offers to undo it (the rules: combo-apply.ts). Returns whether it did.
 * The toast names what changed.
 */
export function applyComboByUse(t: UiText, name: string, members: readonly MaterialComponent[], scope: ComboScope, characterId: string | null): boolean {
  const state = useAppStore.getState();
  const plan = planCombo(members, scope, characterId, state);
  if (!plan.ok) { showToast({ message: t(plan.refusal), tone: 'warn' }); return false; }
  const used = members.some(member => member.target === 'character') ? characterId : null;
  const characterNumber = used ? state.charCaptions.findIndex(caption => caption.id === used) + 1 : 0;
  writeComboFields(scope, used, plan.after);
  const parts = [
    plan.style ? t('cv.combo.part.style') : '',
    plan.positive ? t(scope === 'legacyInpaint' ? 'cv.combo.part.inpaintPositive' : 'cv.combo.part.positive') : '',
    plan.character ? t('cv.combo.part.character', { n: characterNumber }) : '',
  ].filter(Boolean);
  showStepToast(t, parts.length ? t('cv.combo.done', { name, parts: parts.join(t('c.listSep')) }) : t('cv.combo.nothing', { name }),
    { read: () => readComboFields(scope, used), after: plan.after, restore: () => writeComboFields(scope, used, plan.before) });
  return true;
}

/** The members' uses in a few words: "Style 1 · 全图 2 · 角色 1". */
function comboUses(t: UiText, members: readonly MaterialComponent[]) {
  return (['style', 'base', 'character'] as const).map(target => [target, members.filter(member => member.target === target).length] as const)
    .filter(([, n]) => n > 0).map(([target, n]) => `${t(`tag.target.${target}`)} ${n}`).join(' · ');
}

function ComboList({ query, scope, openedFrom, onInsertAll }: { query: string; scope: ComboScope; openedFrom?: string; onInsertAll(item: AssetItem): void }) {
  const { t } = useUiText();
  const shownQuery = useDebounced(query);
  const list = useLibraryItems(api(), pickerRequest('combo', shownQuery));
  const captions = useAppStore(state => state.charCaptions);
  const [characterId, setCharacterId] = useState(() => defaultComboCharacter(openedFrom, captions));
  useEffect(() => { if (characterId && !captions.some(caption => caption.id === characterId)) setCharacterId(defaultComboCharacter(openedFrom, captions)); }, [captions]);
  const chooser = scope === 'base' && captions.length > 0;
  return <div className="cv-pop-scroll cv-lib-list" data-testid="cv-lib-list-combos">
    <p className="cv-lib-hint ui-faint">{t(scope === 'inpaint' ? 'cv.combo.hintInpaint' : scope === 'legacyInpaint' ? 'cv.combo.hintLegacy' : 'cv.combo.hint')}</p>
    {chooser && <div className="cv-lib-chars" role="radiogroup" aria-label={t('cv.combo.charsTo')} data-testid="cv-combo-chars">
      <span className="ui-faint">{t('cv.combo.charsTo')}</span>
      {captions.map((caption, index) => <button key={caption.id} type="button" role="radio" aria-checked={characterId === caption.id} className={clsx('cv-lib-tab', characterId === caption.id && 'is-on')}
        title={caption.prompt} onClick={() => setCharacterId(caption.id)} data-testid={`cv-combo-char-${index + 1}`}>{t('cv.char.n', { n: index + 1 })}</button>)}
    </div>}
    <ListState loading={list.loading} error={list.error} empty={!list.items.length} query={shownQuery} />
    {list.items.map(item => {
      const members = comboMembers(item);
      return <div key={item.id} className="cv-pop-item">
        <button type="button" className="cv-pop-main" title={t('cv.combo.byUseTip')} onClick={() => applyComboByUse(t, itemTitle(item), members, scope, characterId || null)} data-testid={`cv-lib-item-${item.id}`}>
          <b>{itemTitle(item)}</b><span className="ui-mono">{safeText(item)}</span><small className="cv-lib-uses ui-faint">{comboUses(t, members)}</small>
        </button>
        <button type="button" className="cv-hact cv-lib-all" title={t('cv.combo.allTip')} onClick={() => onInsertAll(item)} data-testid={`cv-combo-all-${item.id}`}>{t('cv.combo.all')}</button>
      </div>;
    })}
    {list.hasMore && <Button size="sm" variant="ghost" className="cv-lib-more" busy={list.loadingMore} onClick={list.loadMore}>{t('cv.lib.more')}</Button>}
  </div>;
}

/** An artist pick's recipe as the canvas would get it (asset-library/apply.ts), or null without a complete one. */
export function artistRecipeOf(item: AssetItem) { return artistFavoriteRecipe(item.payload); }

/**
 * Applies an artist pick's recipe (the whole Txt2Img settings: model, prompt, Style, parameters and the fixed seed) and
 * offers to undo it: the undo puts the complete settings from before back while they are still the applied ones.
 */
export function applyArtistRecipe(t: UiText, item: AssetItem): boolean {
  const recipe = artistRecipeOf(item);
  if (!recipe) { showToast({ message: t('cv.lib.artistNoRecipe'), tone: 'warn' }); return false; }
  const state = useAppStore.getState();
  const before = state.params;
  try { state.applyParams(recipe); }
  catch (error) { showToast({ message: t('cv.lib.failed', { reason: hostErrorText(error, state.settings?.language) }), tone: 'danger' }); return false; }
  const after = useAppStore.getState().params;
  showStepToast(t, t('cv.lib.artistDone', { name: itemTitle(item) }), {
    read: () => useAppStore.getState().params, after,
    restore: () => { useAppStore.setState({ params: before }); persistWorkspaceState(); },
  });
  return true;
}

function ArtistList({ query, onApplied }: { query: string; onApplied(): void }) {
  const { t } = useUiText();
  const shownQuery = useDebounced(query);
  const list = useLibraryItems(api(), pickerRequest('artist_favorite', shownQuery));
  const [chosen, setChosen] = useState('');
  return <div className="cv-pop-scroll cv-lib-list" data-testid="cv-lib-list-artists">
    <ListState loading={list.loading} error={list.error} empty={!list.items.length} query={shownQuery} />
    {list.items.map(item => <div key={item.id} className={clsx('cv-lib-artist', chosen === item.id && 'is-open')}>
      <div className="cv-pop-item">
        <button type="button" className="cv-pop-main" aria-expanded={chosen === item.id} onClick={() => setChosen(value => value === item.id ? '' : item.id)} data-testid={`cv-lib-item-${item.id}`}>
          <b>{itemTitle(item)}</b><span className="ui-mono">{cardExcerpt(item, t).text}</span>
        </button>
        <Icon name={chosen === item.id ? 'down' : 'right'} size={13} className="cv-lib-chev" />
      </div>
      {chosen === item.id && <ArtistSummary item={item} onApply={() => { if (applyArtistRecipe(t, item)) onApplied(); }} onCancel={() => setChosen('')} />}
    </div>)}
    {list.hasMore && <Button size="sm" variant="ghost" className="cv-lib-more" busy={list.loadingMore} onClick={list.loadMore}>{t('cv.lib.more')}</Button>}
  </div>;
}

/** What 应用这套配方 sets: model, the prompt's start, Style, the main parameters and the seed. */
function ArtistSummary({ item, onApply, onCancel }: { item: AssetItem; onApply(): void; onCancel(): void }) {
  const { t } = useUiText();
  const recipe = artistRecipeOf(item);
  if (!recipe) return <div className="cv-lib-summary" data-testid="cv-artist-summary"><p className="cv-hint--warn">{t('cv.lib.artistNoRecipe')}</p></div>;
  const row = (label: string, value: string) => <div className="cv-lib-sumrow"><dt>{label}</dt><dd className="ui-mono">{value}</dd></div>;
  return <div className="cv-lib-summary" data-testid="cv-artist-summary">
    <p className="cv-lib-hint ui-faint">{t('cv.lib.artistReplaces')}</p>
    <dl>
      {row(t('cv.model'), modelName(String(recipe.model ?? '')))}
      {row(t('cv.tab.pos'), elideText(String(recipe.positivePrompt ?? ''), 90) || '—')}
      {row(t('cv.style'), elideText(String(recipe.stylePrompt ?? ''), 90) || '—')}
      {row(t('cv.lib.artistParams'), [recipe.width && recipe.height ? `${recipe.width}×${recipe.height}` : '', recipe.steps !== undefined ? t('cv.lib.artistSteps', { n: Number(recipe.steps) }) : '', recipe.cfgScale !== undefined ? t('cv.lib.artistCfg', { n: Number(recipe.cfgScale) }) : '', samplerName(recipe.sampler)].filter(Boolean).join(' · '))}
      {row(t('cv.seed'), String(recipe.seed ?? ''))}
    </dl>
    <div className="cv-lib-sumacts">
      <Button size="sm" variant="ghost" onClick={onCancel}>{t('c.cancel')}</Button>
      <Button size="sm" variant="primary" icon="check" onClick={onApply} data-testid="cv-artist-apply">{t('cv.lib.artistApplyRecipe')}</Button>
    </div>
  </div>;
}

const elideText = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

function KindList({ tab, query, onPick, onImages }: { tab: Exclude<PromptTab, 'templates' | 'combos' | 'artists'>; query: string; onPick(item: AssetItem): void; onImages(id: string): void }) {
  const { t } = useUiText();
  const shownQuery = useDebounced(query);
  const list = useLibraryItems(api(), pickerRequest(TAB_KINDS[tab], shownQuery));
  const replaces = tab === 'presets';
  // A prompt preset's reference pictures (visual notes, never sent), as the old prompt preset control showed them.
  const positive = useAppStore(state => state.settings?.positivePromptPresets ?? EMPTY_POSITIVE);
  const [hovered, setHovered] = useState('');
  const images = (id: string) => positive.find(preset => preset.id === id)?.previewImages ?? [];
  const shown = replaces && hovered ? images(hovered) : [];
  const text = (item: AssetItem) => item.kind === 'tag' ? safeText(item) : cardExcerpt(item, t).text;
  return <div className="cv-pop-scroll cv-lib-list" data-testid={`cv-lib-list-${tab}`}>
    <ListState loading={list.loading} error={list.error} empty={!list.items.length} query={shownQuery} />
    {list.items.map(item => {
      const use = item.kind === 'tag' ? tagTarget(item, t) : '';
      return <div key={`${item.kind}:${item.id}`} className="cv-pop-item" onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(value => value === item.id ? '' : value)}>
        <button type="button" className="cv-pop-main" onClick={() => onPick(item)} title={t(replaces ? 'cv.lib.replaceTip' : 'cv.lib.addTip')} data-testid={`cv-lib-item-${item.id}`}>
          <b>{itemTitle(item)}</b>{text(item) !== itemTitle(item) && <span className="ui-mono">{text(item)}</span>}
        </button>
        {use && <span className="ui-tag cv-lib-use">{use}</span>}
        <span className="cv-lib-act ui-faint">{t(replaces ? 'cv.lib.replace' : 'cv.lib.add')}</span>
        {replaces && <button type="button" className="cv-iconbtn" title={t('cv.style.images', { n: images(item.id).length })} aria-label={t('cv.style.images', { n: images(item.id).length })} onClick={() => onImages(item.id)}>
          <Icon name="image" size={14} /><small className="ui-num">{images(item.id).length}</small>
        </button>}
      </div>;
    })}
    {list.hasMore && <Button size="sm" variant="ghost" className="cv-lib-more" busy={list.loadingMore} onClick={list.loadMore}>{t('cv.lib.more')}</Button>}
    {shown.length > 0 && <div className="cv-pop-preview cv-lib-preview">{shown.map(image => <img key={image.id} src={image.fileUrl} alt={image.name} />)}</div>}
  </div>;
}

/** A tag's or combo's text, or its excerpt when a weight is out of range (materialPrompt refuses those). */
function safeText(item: AssetItem) {
  try { return insertionText(item); } catch { return ''; }
}

function TemplateList({ templates, onPick }: { templates: PromptTemplate[]; onPick(template: PromptTemplate): void }) {
  const { t } = useUiText();
  return <div className="cv-pop-scroll cv-lib-list" data-testid="cv-lib-list-templates">
    <p className="cv-lib-hint ui-faint">{t('cv.lib.tplHint')}</p>
    {!templates.length && <p className="cv-pop-empty ui-faint">{t('cv.lib.tplNone')}</p>}
    {templates.map(template => <div key={template.id} className="cv-pop-item">
      <button type="button" className="cv-pop-main" onClick={() => onPick(template)} data-testid={`cv-lib-template-${template.id}`}>
        <b>{template.name}</b><span className="ui-mono">{[template.prefix.trim(), '…', template.suffix.trim()].filter(Boolean).join(' ')}</span>
      </button>
      <span className="cv-lib-act ui-faint">{t('cv.lib.wrap')}</span>
    </div>)}
  </div>;
}

/** The old rail's 查找 Danbooru 标签 inside the tag tab: online candidates to insert, or to save as a library tag. */
function DanbooruSearch({ query, onInsert }: { query: string; onInsert(text: string, name: string): void }) {
  const { t, language } = useUiText();
  const [artists, setArtists] = useState(false);
  const [state, setState] = useState<{ busy: boolean; result: DanbooruTagResult | null; error: string; asked: string }>({ busy: false, result: null, error: '', asked: '' });
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const q = query.trim();
  const search = async () => {
    if (!q) return;
    setState({ busy: true, result: null, error: '', asked: q });
    try {
      const result = await window.naiDesktop.materialTags({ action: 'search', query: q, limit: 8, ...(artists ? { category: 'artist' } : {}) }) as DanbooruTagResult;
      setState({ busy: false, result, error: '', asked: q });
    } catch (error) { setState({ busy: false, result: null, error: hostErrorText(error, language), asked: q }); }
  };
  const save = async (name: string, category: number) => {
    try {
      await createItem(api(), 'tag', { name, text: name, source: 'danbooru', target: category === 1 ? 'style' : 'base' });
      setSaved(current => new Set([...current, name]));
      showToast({ message: t('cv.lib.danSaved', { name }), tone: 'ok' });
    } catch (error) { showToast({ message: t('cv.lib.failed', { reason: hostErrorText(error, language) }), tone: 'danger' }); }
  };
  if (!q) return null;
  const result = state.asked === q ? state.result : null;
  return <div className="cv-lib-dan" data-testid="cv-lib-danbooru">
    <div className="cv-lib-dan-row">
      <Button size="sm" variant="ghost" icon="search" busy={state.busy} onClick={() => void search()} data-testid="cv-lib-danbooru-search">{t('cv.lib.dan', { q })}</Button>
      <label className="cv-check"><Checkbox checked={artists} label={t('cv.lib.danArtists')} onChange={setArtists} /><span>{t('cv.lib.danArtists')}</span></label>
    </div>
    {state.asked === q && state.error && <p className="cv-pop-empty cv-hint--warn" role="alert">{t('cv.lib.danFailed', { reason: state.error })}</p>}
    {result && !result.items.length && <p className="cv-pop-empty ui-faint">{t('cv.lib.danNone')}</p>}
    {result && result.items.length > 0 && <div className="cv-lib-dan-list">
      {result.items.map(item => <div key={item.name} className="cv-pop-item">
        <button type="button" className="cv-pop-main" onClick={() => onInsert(danbooruText(item.name, item.category), item.name)} title={t('cv.lib.addTip')}>
          <b>{item.name}</b><span>{[t('tag.posts', { n: item.postCount }), item.category === 1 ? t('cv.lib.danArtist') : ''].filter(Boolean).join(' · ')}</span>
        </button>
        <button type="button" className="cv-iconbtn" disabled={saved.has(item.name)} aria-label={t('cv.lib.danSaveOf', { name: item.name })} title={t('cv.lib.danSave')} onClick={() => void save(item.name, item.category)}>
          <Icon name={saved.has(item.name) ? 'check' : 'star'} size={14} />
        </button>
      </div>)}
      <p className="cv-lib-hint ui-faint">{t('cv.lib.danHint')}</p>
    </div>}
  </div>;
}

/**
 * The references' 参考预设 picker: the library's reference presets with their pictures; one adds that reference with the
 * values of the chosen version (applyLibraryItem, as the old rail did). Managing them lives in the library (预设 › 参考).
 */
export function ReferencePresetPicker({ open, anchor, onClose }: { open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void }) {
  const { t, language } = useUiText();
  const [query, setQuery] = useState('');
  const shownQuery = useDebounced(query);
  const list = useLibraryItems(api(), pickerRequest('reference_preset', shownQuery), open);
  const add = async (item: AssetItem) => {
    const model = useAppStore.getState().params.model;
    const supported = item.payload?.kind === 'vibe' ? supportsNAIVibeTransfer(model) : supportsNAIPreciseReference(model);
    if (!supported) { showToast({ message: t('cv.lib.refNoModel'), tone: 'warn' }); return; }
    onClose();
    try {
      await applyLibraryItem(item, 'base', useAppStore.getState(), window.naiDesktop);
      showToast({ message: t('cv.lib.refDone', { name: itemTitle(item) }), tone: 'ok' });
    } catch (error) { showToast({ message: t('cv.lib.failed', { reason: hostErrorText(error, language) }), tone: 'danger' }); }
  };
  return <Popover open={open} anchor={anchor} onClose={onClose} label={t('cv.lib.refTitle')} width={360} placement="bottom-end" className="cv-lib-pop">
    <div className="cv-lib-head">
      <div className="cv-lib-title"><b>{t('cv.lib.refTitle')}</b></div>
      <TextInput className="cv-lib-search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('cv.lib.search')} aria-label={t('cv.lib.search')} />
    </div>
    <div className="cv-pop-scroll cv-lib-list" data-testid="cv-lib-list-references">
      <ListState loading={list.loading} error={list.error} empty={!list.items.length} query={shownQuery} />
      {list.items.map(item => <div key={item.id} className="cv-pop-item cv-lib-ref">
        <button type="button" className="cv-pop-main cv-lib-ref-main" onClick={() => void add(item)} data-testid={`cv-lib-item-${item.id}`}>
          <Thumb api={api()} item={item} alt="" />
          <span className="cv-lib-ref-tx"><b>{itemTitle(item)}</b><span>{cardExcerpt(item, t).text}</span></span>
        </button>
        <span className="cv-lib-act ui-faint">{t('cv.lib.add')}</span>
      </div>)}
      {list.hasMore && <Button size="sm" variant="ghost" className="cv-lib-more" busy={list.loadingMore} onClick={list.loadMore}>{t('cv.lib.more')}</Button>}
    </div>
    <div className="cv-pop-foot">
      <Button size="sm" variant="ghost" icon="library" onClick={() => { onClose(); openInLibrary({ view: { type: 'category', category: 'presets' } }); }}>{t('cv.lib.refManage')}</Button>
    </div>
  </Popover>;
}

/**
 * The source card's 从素材库选 picker: the library's images (history), newest first; one becomes the mode's source
 * through stageImageInput (applied at once with undo, as every other entry).
 */
export function HistorySourcePicker({ open, anchor, onClose, mode }: { open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void; mode: GenerationSourceMode }) {
  const { t, language } = useUiText();
  const [query, setQuery] = useState('');
  const shownQuery = useDebounced(query);
  const list = useLibraryItems(api(), pickerRequest('history', shownQuery), open);
  const [busy, setBusy] = useState('');
  const use = async (item: AssetItem) => {
    setBusy(item.id);
    try {
      const detail = await api().assetLibrary({ action: 'ui-read', kind: item.kind, id: item.id }) as AssetDetail;
      const image = imageFromAssetDetail(detail);
      if (!image) throw new Error(t('cv.src.unreadable'));
      onClose();
      await stageImageInput(image, mode);
    } catch (error) { showToast({ message: hostErrorText(error, language), tone: 'danger' }); }
    finally { setBusy(''); }
  };
  return <Popover open={open} anchor={anchor} onClose={onClose} label={t('cv.lib.srcTitle')} width={392} className="cv-lib-pop">
    <div className="cv-lib-head">
      <div className="cv-lib-title"><b>{t('cv.lib.srcTitle')}</b></div>
      <TextInput className="cv-lib-search" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('cv.lib.srcSearch')} aria-label={t('cv.lib.srcSearch')} />
    </div>
    <div className="cv-pop-scroll" data-testid="cv-lib-list-history">
      <ListState loading={list.loading} error={list.error} empty={!list.items.length} query={shownQuery} none={t('cv.lib.srcNone')} />
      <div className="cv-lib-grid">{list.items.map(item => <button key={item.id} type="button" className={clsx('cv-lib-tile', busy === item.id && 'is-busy')} disabled={!!busy}
        aria-label={t('cv.lib.srcOpen', { name: itemTitle(item) })} title={itemTitle(item)} onClick={() => void use(item)} data-testid={`cv-lib-image-${item.id}`}>
        <Thumb api={api()} item={item} alt="" />
      </button>)}</div>
      {list.hasMore && <Button size="sm" variant="ghost" className="cv-lib-more" busy={list.loadingMore} onClick={list.loadMore}>{t('cv.lib.more')}</Button>}
    </div>
    <div className="cv-pop-foot">
      <Button size="sm" variant="ghost" icon="library" onClick={() => { onClose(); openInLibrary({ view: { type: 'category', category: 'history' } }); }}>{t('cv.lib.browse')}</Button>
    </div>
  </Popover>;
}
