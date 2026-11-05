import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import { sameSavedPreset } from '../asset-library/legacy-settings';
import { assetQueryClient, assetQueryKey, invalidateAssetQueries, readAssetQuery, useLocalAssetQuery, watchAssetLibraryChanges } from '../asset-library/query';
import type { AssetDetail } from '../asset-library/types';
import { Select, SliderField } from '../canvas/controls';
import { hostMessageText } from '../host-errors/compose';
import { animateIn, skipMotion } from '../motion';
import { catalogCategoryName, catalogGameName, catalogGroupName } from '../reference-preset-names';
import { useAppStore } from '../store';
import type {
  PreciseReferenceType,
  ReferenceImportCommitResult,
  ReferenceImportDecision,
  ReferenceImportPreview,
  ReferencePreset,
  ReferencePresetKind,
  ReferencePresetLibrary,
} from '../types';
import { Button, ConfirmDialog, Dialog, Disclosure, EmptyState, Field, Icon, SearchInput, Seg, Spinner, Tag, TextInput, type SegOption } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import './reference-presets.css';

const EMPTY_LIBRARY: ReferencePresetLibrary = { groups: [], presets: [] };
const LOCAL_GRID_COLUMNS_KEY = 'mcp-for-novelai.reference-presets.columns.v1';
const LOCAL_PAGE_SIZE_KEY = 'mcp-for-novelai.reference-presets.page-size.v1';
export const GRID_COLUMN_OPTIONS = [2, 3, 4, 5] as const;
export const LOCAL_PAGE_SIZE_OPTIONS = [12, 24, 48, 60] as const;
/** The group filter value for every group (the empty string is Ungrouped). */
const ALL_GROUPS = '__all__';

const STATUS_KEYS: Record<'new' | 'identical' | 'conflict' | 'invalid', UiStringKey> = {
  new: 'rpi.status.new', identical: 'rpi.status.identical', conflict: 'rpi.status.conflict', invalid: 'rpi.status.invalid',
};
const STATUS_TONES = { new: 'ok', identical: 'neutral', conflict: 'warn', invalid: 'danger' } as const;

/** The outcome of an import commit: the host's summary, each failed entry and whether to choose the package again. */
export function ImportResult({ result }: { result: ReferenceImportCommitResult }) {
  const { t, language } = useUiText();
  return <div className={clsx('rpi-result', !result.ok && 'is-bad')} role={result.ok ? 'status' : 'alert'} data-testid="rpi-result">
    <p><strong>{hostMessageText(result, language)}</strong></p>
    {result.entries.filter(entry => entry.status === 'failed').map(entry => <p key={entry.entryId}>{t('rpi.failedEntry', { name: entry.name, reason: hostMessageText(entry, language) })}</p>)}
    {result.requiresReview && <p>{t('rpi.requiresReview')}</p>}
  </div>;
}

/**
 * The .nairp import preview (rebuilt in step 4c2, same flow as before): each entry with what the package holds and
 * what this device already has, a choice per entry (new: import or skip; conflict: save a copy or keep the local one;
 * identical and invalid: skipped), then one commit of exactly those choices and its result.
 */
export function ReferenceImportReview({ preview, onClose, onCommitted }: { preview: ReferenceImportPreview; onClose: () => void; onCommitted: () => Promise<void> }) {
  const { t, language } = useUiText();
  const [decisions, setDecisions] = useState<Record<string, ReferenceImportDecision>>(() => Object.fromEntries((preview.entries ?? []).map(entry => [entry.entryId, entry.defaultAction])));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReferenceImportCommitResult | null>(null);
  const [error, setError] = useState('');
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const listSeparator = t('rpi.listSep');
  const entries = preview.entries ?? [], toImport = Object.values(decisions).filter(action => action !== 'skip').length;
  const commit = () => {
    setBusy(true); setError('');
    void window.naiDesktop.commitReferenceImport({ importId: preview.importId!, libraryRevision: preview.libraryRevision!, decisions: entries.map(entry => ({ entryId: entry.entryId, action: decisions[entry.entryId] })) })
      .then(async outcome => { setResult(outcome); await onCommitted(); })
      .catch(failure => setError(hostMessageText(failure, language, t('rpi.commitFailed'))))
      .finally(() => setBusy(false));
  };
  return <Dialog open onClose={onClose} busy={busy} icon="upload" width={780} title={t('rpi.title')} initialFocusRef={closeRef}
    description={t(result ? 'rpi.summaryResult' : 'rpi.summaryPreview', { name: preview.packageName ?? '', n: entries.length })}
    footer={<><Button ref={closeRef} disabled={busy} onClick={onClose}>{t(result ? 'rpi.close' : 'rpi.cancel')}</Button>
      {!result && <Button variant="primary" busy={busy} onClick={commit} data-testid="rpi-confirm">{busy ? t('rpi.importing') : t('rpi.confirm', { n: toImport, m: entries.length - toImport })}</Button>}</>}>
    <div className="rpi-body" data-testid="reference-import">
      <p className="rpi-hint">{t('rpi.hint')}</p>
      <ul className="rpi-list">{entries.map(entry => {
        const fixed = entry.status === 'invalid' || entry.status === 'identical';
        const options: Array<SegOption<ReferenceImportDecision>> = [{ value: 'skip', label: t(entry.status === 'conflict' ? 'rpi.keepLocal' : 'rpi.skip') }];
        if (entry.status === 'new') options.push({ value: 'import', label: t('rpi.importNew') });
        if (entry.status === 'conflict') options.push({ value: 'copy', label: t('rpi.saveCopy') });
        const off = busy || !!result || fixed;
        return <li className="rpi-entry" key={entry.entryId} data-testid={`rpi-entry-${entry.entryId}`}>
          <div className="rpi-entry-head">
            <span className="rpi-thumb">{entry.previewUrl ? <img src={entry.previewUrl} alt={t('rpi.previewAlt', { name: entry.name })} /> : <Icon name="image" size={20} />}</span>
            <div className="rpi-entry-text">
              <strong>{entry.name}</strong>
              <span className="rpi-entry-meta"><Tag tone={STATUS_TONES[entry.status]}>{t(STATUS_KEYS[entry.status])}</Tag><span>{t(entry.kind === 'precise' ? 'rpi.kind.precise' : entry.kind === 'vibe' ? 'rpi.kind.vibe' : 'rpi.kind.unknown')}</span>{entry.group && <span>{entry.group}</span>}</span>
            </div>
          </div>
          <p className="rpi-msg">{hostMessageText(entry, language)}</p>
          {!!entry.localNames?.length && <p className="rpi-local">{t('rpi.local', { names: entry.localNames.join(listSeparator) })}</p>}
          {entry.parameters && <Disclosure summary={t('rpi.details')} className="rpi-details">
            <pre className="ui-mono">{JSON.stringify(entry.parameters, null, 2)}</pre>
            {entry.localParameters?.map((local, index) => <div key={index}><strong>{t('rpi.local', { names: local.name })}</strong><pre className="ui-mono">{JSON.stringify(local.parameters, null, 2)}</pre></div>)}
          </Disclosure>}
          <div className="rpi-action"><span className="rpi-action-l">{t('rpi.action')}</span>
            <Seg<ReferenceImportDecision> size="sm" label={t('rpi.actionLabel', { name: entry.name })} value={decisions[entry.entryId]} options={options.map(option => ({ ...option, disabled: off }))}
              onChange={action => setDecisions(current => ({ ...current, [entry.entryId]: action }))} />
          </div>
        </li>;
      })}</ul>
      {error && <p className="rpi-alert" role="alert">{error}</p>}
      {result && <ImportResult result={result} />}
    </div>
  </Dialog>;
}

type PresetSource = { base64: string; previewUrl: string; width: number; height: number; extension: string };

function fileToSource(file: File) {
  return new Promise<PresetSource>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const previewUrl = String(reader.result ?? '');
      const probe = new Image();
      probe.onerror = () => reject(new Error('Invalid image'));
      probe.onload = () => resolve({ base64: previewUrl.split(',')[1] ?? '', previewUrl, width: probe.naturalWidth, height: probe.naturalHeight, extension: file.name.split('.').pop() || 'png' });
      probe.src = previewUrl;
    };
    reader.readAsDataURL(file);
  });
}

const PRECISE_TYPE_KEYS: Record<PreciseReferenceType, UiStringKey> = { character: 'rp.character', style: 'rp.style', 'character&style': 'rp.both' };
const preciseTypeLabel = (t: UiText, type: PreciseReferenceType) => PRECISE_TYPE_KEYS[type] ? t(PRECISE_TYPE_KEYS[type]) : String(type);

/** A preset's values as the card shows them. */
export function presetValuesText(t: UiText, preset: Pick<ReferencePreset, 'kind' | 'infoExtracted' | 'strength' | 'preciseType' | 'fidelity'>) {
  return preset.kind === 'vibe'
    ? `${t('rp.infoLabel')} ${preset.infoExtracted.toFixed(2)} · ${t('rp.strengthLabel')} ${preset.strength.toFixed(2)}`
    : `${t('rp.typeLabel')} ${preciseTypeLabel(t, preset.preciseType)} · ${t('rp.preciseStrengthLabel')} ${preset.strength.toFixed(2)} · ${t('rp.fidelityLabel')} ${preset.fidelity.toFixed(2)}`;
}

/** The page number field: commits on Enter or its button, clamped to the pages there are. */
function PageNumberInput({ page, pageCount, label, goLabel, onChange }: { page: number; pageCount: number; label: string; goLabel: string; onChange: (page: number) => void }) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);
  const commit = () => {
    const parsed = Math.floor(Number(draft));
    const next = Number.isFinite(parsed) ? Math.max(1, Math.min(pageCount, parsed)) : page;
    setDraft(String(next));
    onChange(next);
  };
  return <span className="rp-pagenum"><TextInput type="number" min={1} max={pageCount} value={draft} aria-label={label} className="ui-num" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') commit(); }} />
    <Button size="sm" onClick={commit}>{goLabel}</Button></span>;
}

/** 创建参考预设: an image, its kind and values, a name and a group. */
function CreatePresetDialog({ groups, initialGroup, busy, onClose, onSave }: {
  groups: string[]; initialGroup: string; busy: boolean; onClose(): void;
  onSave(input: { name: string; group: string; kind: ReferencePresetKind; source: PresetSource | null; infoExtracted: number; strength: number; fidelity: number; preciseType: PreciseReferenceType }): Promise<boolean>;
}) {
  const { t } = useUiText();
  const setToast = useAppStore(state => state.setToast);
  const [name, setName] = useState('');
  const [group, setGroup] = useState(initialGroup);
  const [kind, setKind] = useState<ReferencePresetKind>('vibe');
  const [source, setSource] = useState<PresetSource | null>(null);
  const [infoExtracted, setInfoExtracted] = useState(1);
  const [strength, setStrength] = useState(1);
  const [fidelity, setFidelity] = useState(1);
  const [preciseType, setPreciseType] = useState<PreciseReferenceType>('character');
  const nameRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listId = `rp-groups-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const vibe = kind === 'vibe';
  return <Dialog open onClose={onClose} busy={busy} icon="preset" width={640} title={t('rp.createTitle')} description={t('rp.createHint')} initialFocusRef={nameRef}
    footer={<><Button onClick={onClose} disabled={busy}>{t('rp.cancel')}</Button><Button variant="primary" busy={busy} onClick={() => void onSave({ name, group, kind, source, infoExtracted, strength, fidelity, preciseType })} data-testid="rp-create-save">{group ? t('rp.saveCurrent') : t('rp.save')}</Button></>}>
    <div className="rp-create" data-testid="rp-create">
      <div className={clsx('rp-create-img', source && 'has-image')} style={source && source.width > 0 && source.height > 0 ? { aspectRatio: `${source.width} / ${source.height}` } : undefined}>
        {source ? <img src={source.previewUrl} alt={name || t('rp.image')} /> : <div className="rp-create-ph"><Icon name="image" size={28} /><strong>{t('rp.image')}</strong><span>{t('rp.imageHint')}</span></div>}
        <Button size="sm" icon="upload" className="rp-create-pick" onClick={() => fileRef.current?.click()} data-testid="rp-create-pick">{source ? t('rp.replaceImage') : t('rp.image')}</Button>
        <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('rp.image')} data-testid="rp-create-file"
          onChange={event => { const file = event.target.files?.[0]; if (file) void fileToSource(file).then(setSource).catch(() => setToast(t('rp.chooseRequired'))); event.target.value = ''; }} />
      </div>
      <div className="rp-create-fields">
        <Seg<ReferencePresetKind> full label={t('rp.kind')} value={kind} onChange={next => { setKind(next); setStrength(1); }} options={[{ value: 'vibe', label: t('rp.vibe') }, { value: 'precise', label: t('rp.precise') }]} />
        <Field label={t('rp.name')}><TextInput ref={nameRef} value={name} onChange={event => setName(event.target.value)} data-testid="rp-create-name" /></Field>
        <Field label={t('rp.group')}><TextInput list={listId} value={group} placeholder={t('rp.noGroup')} onChange={event => setGroup(event.target.value)} data-testid="rp-create-group" /></Field>
        <datalist id={listId}>{groups.map(item => <option key={item} value={item} />)}</datalist>
        {!vibe && <Field label={t('rp.typeLabel')}>
          <Seg<PreciseReferenceType> full size="sm" label={t('rp.typeLabel')} value={preciseType} onChange={setPreciseType} options={(['character', 'style', 'character&style'] as const).map(value => ({ value, label: preciseTypeLabel(t, value) }))} />
        </Field>}
        <div className="rp-param"><SliderField label={vibe ? t('rp.infoLabel') : t('rp.preciseStrengthLabel')} value={vibe ? infoExtracted : strength} min={0} max={1} step={0.01} onChange={vibe ? setInfoExtracted : setStrength} /><small>{vibe ? t('rp.infoHelp') : t('rp.preciseStrengthHelp')}</small></div>
        <div className="rp-param"><SliderField label={vibe ? t('rp.strengthLabel') : t('rp.fidelityLabel')} value={vibe ? strength : fidelity} min={0} max={1} step={0.01} onChange={vibe ? setStrength : setFidelity} /><small>{vibe ? t('rp.vibeStrengthHelp') : t('rp.fidelityHelp')}</small></div>
      </div>
    </div>
  </Dialog>;
}

/**
 * 素材库 › 预设 › 参考 › 管理参考预设 (rebuilt in step 4c2 on the UI kit, same operations as before): the reference
 * presets on this device with search, group, kind, cards per row and page size; create, import (.nairp, with its
 * preview), export (all, a group), groups (create, delete), and per preset use on the canvas, move to a group, delete
 * (archived through the library) and a double-click preview.
 */
export default function ReferencePresetManager() {
  const { t, language } = useUiText();
  const setToast = useAppStore(state => state.setToast);
  const addVibeImage = useAppStore(state => state.addVibeImage);
  const addPreciseReference = useAppStore(state => state.addPreciseReference);
  const libraryKey = assetQueryKey(window.naiDesktop, 'reference-presets');
  const libraryQuery = useLocalAssetQuery(libraryKey, () => window.naiDesktop.listReferencePresets(), true, EMPTY_LIBRARY);
  const library = libraryQuery.data ?? EMPTY_LIBRARY;
  const setLibrary = (next: ReferencePresetLibrary) => assetQueryClient.setQueryData(libraryKey, next);
  useEffect(() => watchAssetLibraryChanges(window.naiDesktop), []);
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS);
  const [kindFilter, setKindFilter] = useState<ReferencePresetKind | 'all'>('all');
  const [group, setGroup] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [previewPreset, setPreviewPreset] = useState<ReferencePreset | null>(null);
  const [importPreview, setImportPreview] = useState<ReferenceImportPreview | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ReferencePreset | null>(null);
  const [gridColumns, setGridColumns] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem(LOCAL_GRID_COLUMNS_KEY));
    return (GRID_COLUMN_OPTIONS as readonly number[]).includes(stored) ? stored : 3;
  });
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(() => {
    const stored = Number(globalThis.localStorage?.getItem(LOCAL_PAGE_SIZE_KEY));
    return (LOCAL_PAGE_SIZE_OPTIONS as readonly number[]).includes(stored) ? stored : 12;
  });
  const sectionRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => { await readAssetQuery(assetQueryKey(window.naiDesktop, 'reference-presets'), () => window.naiDesktop.listReferencePresets(), true); }, []);
  const prepareImport = async () => {
    setBusy(true);
    try {
      const result = await window.naiDesktop.prepareReferenceImport();
      if (result.ok && result.importId) setImportPreview(result);
      else if (!result.canceled) setToast(hostMessageText(result, language, t('rpi.previewFailed')));
    } catch (error) { setToast(hostMessageText(error, language, t('rpi.previewFailed'))); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    const onImported = () => void refresh();
    window.addEventListener('novelai:reference-presets-changed', onImported);
    return () => window.removeEventListener('novelai:reference-presets-changed', onImported);
  }, [refresh]);
  useEffect(() => { globalThis.localStorage?.setItem(LOCAL_GRID_COLUMNS_KEY, String(gridColumns)); }, [gridColumns]);
  useEffect(() => { globalThis.localStorage?.setItem(LOCAL_PAGE_SIZE_KEY, String(localPageSize)); }, [localPageSize]);
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || document.hidden || skipMotion(section)) return;
    const animation = animateIn(section, "translateY(10px)", 240);
    return () => { animation.cancel(); };
  }, []);

  const localizedPresetName = (preset: ReferencePreset) => preset.sourceNames?.[language] || preset.sourceNames?.['zh-CN'] || preset.name;
  const localizedPresetGroup = (preset: ReferencePreset) => preset.sourceGameId && preset.sourceCategory
    ? `${catalogGameName(preset.sourceGameId, language, preset.sourceGameNames)} · ${catalogCategoryName(preset.sourceCategory, language)}`
    : catalogGroupName(preset.group, language);

  const presets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return library.presets
      .filter(preset => groupFilter === ALL_GROUPS || preset.group === groupFilter)
      .filter(preset => kindFilter === 'all' || preset.kind === kindFilter)
      .filter(preset => !normalizedQuery || [preset.name, preset.group, preset.sourceGameId, preset.sourceCategory, ...Object.values(preset.sourceNames ?? {}), ...Object.values(preset.sourceGameNames ?? {})].filter(Boolean).join('\n').toLocaleLowerCase().includes(normalizedQuery))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [library, groupFilter, kindFilter, query]);
  const localPageCount = Math.max(1, Math.ceil(presets.length / localPageSize));
  const localPagePresets = presets.slice((localPage - 1) * localPageSize, localPage * localPageSize);
  useEffect(() => setLocalPage(1), [groupFilter, kindFilter, localPageSize, query]);
  useEffect(() => setLocalPage(current => Math.min(current, localPageCount)), [localPageCount]);

  const save: Parameters<typeof CreatePresetDialog>[0]['onSave'] = async ({ name, group: targetGroup, kind, source, infoExtracted, strength, fidelity, preciseType }) => {
    if (!source || !name.trim()) { setToast(t('rp.chooseRequired')); return false; }
    setBusy(true);
    const result = await window.naiDesktop.saveReferencePreset({
      name, group: targetGroup, kind, base64: source.base64, extension: source.extension,
      infoExtracted, strength, preciseType, fidelity, informationExtracted: 1,
      width: source.width, height: source.height,
    });
    setBusy(false);
    if (!result.ok) { setToast(hostMessageText(result, language, t('rp.chooseRequired'))); return false; }
    setLibrary(result.library || EMPTY_LIBRARY);
    setShowCreate(false);
    setToast(t('rp.saved'));
    return true;
  };

  const apply = async (preset: ReferencePreset) => {
    const result = await window.naiDesktop.readReferencePreset(preset.id);
    if (!result.ok || !result.base64 || !result.preset) return setToast(hostMessageText(result, language, t('rp.chooseRequired')));
    const saved = result.preset;
    const previewUrl = saved.fileUrl;
    if (saved.kind === 'vibe') addVibeImage({ id: crypto.randomUUID(), previewUrl, base64: result.base64, infoExtracted: saved.infoExtracted, strength: saved.strength });
    else addPreciseReference({ id: crypto.randomUUID(), previewUrl, base64: result.base64, type: saved.preciseType, strength: saved.strength, fidelity: saved.fidelity, informationExtracted: 1, srcWidth: saved.width, srcHeight: saved.height });
    setToast(t('rp.applied'));
  };

  const mutatePreset = async (preset: ReferencePreset, command: 'archive' | 'update', patch: Record<string, unknown>) => {
    const { item } = await window.naiDesktop.assetLibrary({ action: 'read', kind: 'reference_preset', id: preset.id }) as AssetDetail;
    if (item.archived || !sameSavedPreset(item.payload, preset)) return { ok: false, message: t('rpi.changedElsewhere') };
    await window.naiDesktop.assetLibrary({ action: 'mutate', command, items: [{ kind: 'reference_preset', id: preset.id, expectedRevision: (preset as ReferencePreset & { assetRevision?: number }).assetRevision ?? item.revision }], patch });
    await invalidateAssetQueries();
    return { ok: true };
  };

  const runOperation = async (operation: () => Promise<{ ok: boolean; message?: string; library?: ReferencePresetLibrary }>, success: string) => {
    setBusy(true);
    try {
      const result = await operation();
      if (result.library) setLibrary(result.library);
      else if (result.ok) await refresh();
      setToast(result.ok ? success : hostMessageText(result, language, success));
      return result.ok;
    } catch (error) {
      setToast(hostMessageText(error, language, t('rpi.opUnfinished')));
      return false;
    } finally { setBusy(false); }
  };

  const removePreset = async (preset: ReferencePreset) => {
    setRemoveTarget(null);
    await runOperation(() => mutatePreset(preset, 'archive', { archived: true }), t('rp.remove'));
  };

  const createGroup = async () => {
    const nextGroup = newGroupName.trim();
    if (!nextGroup) return setToast(t('rp.groupName'));
    setBusy(true);
    const result = await window.naiDesktop.createReferencePresetGroup(nextGroup);
    setBusy(false);
    if (!result.ok) return setToast(hostMessageText(result, language, t('rp.groupName')));
    setLibrary(result.library || EMPTY_LIBRARY);
    setGroupFilter(nextGroup);
    setGroup(nextGroup);
    setNewGroupName('');
    setToast(t('rp.groupCreated'));
  };

  const moveToGroup = async (presetId: string, nextGroup: string) => {
    const preset = library.presets.find(item => item.id === presetId);
    if (preset) await runOperation(() => mutatePreset(preset, 'update', { group: nextGroup }), t('rp.moved'));
  };

  const deleteGroup = async () => {
    if (!deleteGroupTarget || busy) return;
    const target = deleteGroupTarget;
    setBusy(true);
    const result = await window.naiDesktop.deleteReferencePresetGroup(target);
    setBusy(false);
    if (!result.ok) return setToast(hostMessageText(result, language, t('rp.deleteGroup')));
    setLibrary(result.library || EMPTY_LIBRARY);
    setGroupFilter(ALL_GROUPS);
    if (group === target) setGroup('');
    setDeleteGroupTarget(null);
    setToast(t('rp.deleteGroupDone'));
  };

  const selectGroup = (value: string) => {
    setGroupFilter(value);
    if (value !== ALL_GROUPS) setGroup(value);
  };

  const groupOptions = [{ value: '', label: t('rp.noGroup') }, ...library.groups.map(item => ({ value: item, label: catalogGroupName(item, language) }))];
  const currentGroupName = groupFilter === ALL_GROUPS ? t('rp.all') : groupFilter ? catalogGroupName(groupFilter, language) : t('rp.noGroup');
  const first = presets.length ? (localPage - 1) * localPageSize + 1 : 0;

  return <div className="rp" data-testid="reference-presets">
    {libraryQuery.error && <p className="rp-alert" role="alert">{hostMessageText(libraryQuery.error, language)}</p>}
    <section className="rp-hero">
      <div className="rp-hero-copy">
        <span className="rp-summary ui-muted ui-num" aria-label={t('rp.library')}>{t('rp.presetCount', { n: library.presets.length })} · {t('rp.groupCount', { n: library.groups.length })}</span></div>
      <div className="rp-hero-actions">
        <Button variant="primary" icon="plus" onClick={() => setShowCreate(true)} data-testid="rp-create">{t('rp.createPreset')}</Button>
        <Button icon="upload" disabled={busy} onClick={() => void prepareImport()} data-testid="rp-import">{t('rp.import')}</Button>
        <Button icon="download" onClick={() => void runOperation(() => window.naiDesktop.exportReferencePresets(), t('rp.exported'))} data-testid="rp-export-all">{t('rp.exportAll')}</Button>
      </div>
    </section>

    <div ref={sectionRef} className="rp-content">
      <div className="rp-toolbar" role="toolbar" aria-label={t('rp.library')}>
        <SearchInput className="rp-search" value={query} onChange={setQuery} placeholder={t('rp.search')} label={t('rp.search')} clearLabel={t('rp.clearSearch')} />
        <span className="rp-ctl"><span>{t('rp.currentGroup')}</span><Select<string> className="rp-select" label={t('rp.currentGroup')} value={groupFilter} options={[{ value: ALL_GROUPS, label: t('rp.all') }, ...groupOptions]} onChange={selectGroup} testId="rp-group-filter" /></span>
        <Seg<ReferencePresetKind | 'all'> size="sm" label={t('rp.kind')} value={kindFilter} onChange={setKindFilter} options={[{ value: 'all', label: t('rp.all') }, { value: 'vibe', label: t('rp.vibe') }, { value: 'precise', label: t('rp.precise') }]} />
        <span className="rp-toolbar-gap" />
        <span className="rp-ctl"><span>{t('rp.cardsPerRow')}</span><Select<number> className="rp-select rp-select--s" label={t('rp.cardsPerRow')} value={gridColumns} options={GRID_COLUMN_OPTIONS.map(value => ({ value, label: String(value) }))} onChange={setGridColumns} placement="bottom-end" /></span>
        <span className="rp-ctl"><span>{t('rp.perPage')}</span><Select<number> className="rp-select" label={t('rp.perPage')} value={localPageSize} options={LOCAL_PAGE_SIZE_OPTIONS.map(value => ({ value, label: t('rp.itemsPerPage', { n: value }) }))} onChange={setLocalPageSize} placement="bottom-end" /></span>
      </div>

      <div className="rp-groupbar">
        <span className="rp-groupbar-cur"><Icon name="group" size={14} />{t('rp.currentGroup')} · <b>{currentGroupName}</b></span>
        {groupFilter !== ALL_GROUPS && <Button size="sm" variant="ghost" icon="download" onClick={() => void runOperation(() => window.naiDesktop.exportReferencePresets({ group: groupFilter }), t('rp.exported'))} data-testid="rp-export-group">{t('rp.exportGroup')}</Button>}
        {groupFilter !== ALL_GROUPS && groupFilter !== '' && <Button size="sm" variant="dangerGhost" icon="trash" disabled={busy} onClick={() => setDeleteGroupTarget(groupFilter)} title={t('rp.deleteGroupHint')} data-testid="rp-delete-group">{t('rp.deleteGroup')}</Button>}
        <span className="rp-toolbar-gap" />
        <form className="rp-newgroup" onSubmit={event => { event.preventDefault(); void createGroup(); }}>
          <TextInput value={newGroupName} placeholder={t('rp.groupName')} aria-label={t('rp.groupName')} onChange={event => setNewGroupName(event.target.value)} data-testid="rp-new-group" />
          <Button size="sm" type="submit" icon="plus" disabled={busy || !newGroupName.trim()} data-testid="rp-create-group">{t('rp.createGroup')}</Button>
        </form>
      </div>

      {libraryQuery.isPlaceholderData && !library.presets.length ? <p className="rp-wait" role="status"><Spinner size={14} /> {t('c.loading')}</p>
        : presets.length === 0 ? <EmptyState icon="preset" title={t('rp.empty')} body={t('rp.createHint')} />
        : <>
          <div className="rp-grid" style={{ '--rp-columns': gridColumns } as CSSProperties}>{localPagePresets.map(preset => {
            const title = localizedPresetName(preset);
            return <article className="rp-card" key={preset.id} data-testid={`rp-card-${preset.id}`}>
              <div className="rp-card-img" title={t('rp.preview')} onDoubleClick={event => { event.stopPropagation(); setPreviewPreset(preset); }}>
                <img src={preset.fileUrl} alt={title} loading="lazy" />
                <Tag tone="accent" className="rp-card-kind">{preset.kind === 'vibe' ? t('rp.vibe') : t('rp.precise')}</Tag>
              </div>
              <div className="rp-card-body">
                <b className="rp-card-title" title={title}>{title}</b>
                <span className="rp-card-group">{preset.group ? localizedPresetGroup(preset) : t('rp.noGroup')}</span>
                <small className="rp-card-values ui-num">{presetValuesText(t, preset)}</small>
                <Select<string> className="rp-select" label={t('rp.moveGroupOf', { name: title })} value={preset.group} options={groupOptions} onChange={next => void moveToGroup(preset.id, next)} disabled={busy} />
              </div>
              <div className="rp-card-acts">
                <Button size="sm" variant="primary" icon="canvas" onClick={() => void apply(preset)} data-testid="rp-use">{t('rp.use')}</Button>
                <Button size="sm" variant="dangerGhost" icon="trash" onClick={() => setRemoveTarget(preset)} data-testid="rp-remove">{t('rp.remove')}</Button>
              </div>
            </article>;
          })}</div>
          <nav className="rp-pages" aria-label={t('rp.choosePage')}>
            <Button size="sm" icon="left" disabled={localPage <= 1} onClick={() => setLocalPage(current => Math.max(1, current - 1))}>{t('rp.previous')}</Button>
            <PageNumberInput page={localPage} pageCount={localPageCount} label={t('rp.choosePage')} goLabel={t('rp.goPage')} onChange={setLocalPage} />
            <b className="ui-num" aria-live="polite">{t('rp.page', { page: localPage, pages: localPageCount, start: first, end: Math.min(localPage * localPageSize, presets.length), total: presets.length })}</b>
            <Button size="sm" iconAfter="right" disabled={localPage >= localPageCount} onClick={() => setLocalPage(current => Math.min(localPageCount, current + 1))}>{t('rp.next')}</Button>
          </nav>
        </>}
    </div>

    {importPreview && <ReferenceImportReview preview={importPreview} onClose={() => setImportPreview(null)} onCommitted={async () => { await invalidateAssetQueries(); await refresh(); }} />}
    {showCreate && <CreatePresetDialog groups={library.groups} initialGroup={group} busy={busy} onClose={() => setShowCreate(false)} onSave={save} />}
    {previewPreset && <Dialog open onClose={() => setPreviewPreset(null)} width={960} title={localizedPresetName(previewPreset)}
      footer={<Button onClick={() => setPreviewPreset(null)}>{t('rp.close')}</Button>}>
      <div className="rp-preview"><img src={previewPreset.fileUrl} alt={localizedPresetName(previewPreset)} /></div>
    </Dialog>}
    <ConfirmDialog open={!!deleteGroupTarget} tone="danger" icon="trash" title={t('rp.deleteGroupTitle')} description={t('rp.deleteGroupHint')} busy={busy}
      confirmLabel={t('rp.deleteGroup')} cancelLabel={t('rp.cancel')} onCancel={() => setDeleteGroupTarget(null)} onConfirm={() => void deleteGroup()}>
      {deleteGroupTarget && <p className="rp-confirm-name">{catalogGroupName(deleteGroupTarget, language)}</p>}
    </ConfirmDialog>
    <ConfirmDialog open={!!removeTarget} tone="danger" icon="trash" title={t('rp.confirmTitle')} description={t('rp.confirmDelete')}
      confirmLabel={t('rp.remove')} cancelLabel={t('rp.cancel')} onCancel={() => setRemoveTarget(null)} onConfirm={() => { if (removeTarget) void removePreset(removeTarget); }}>
      {removeTarget && <p className="rp-confirm-name">{localizedPresetName(removeTarget)}</p>}
    </ConfirmDialog>
  </div>;
}
