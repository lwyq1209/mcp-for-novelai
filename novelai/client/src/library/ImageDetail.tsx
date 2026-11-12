import { useEffect, useState, type ReactNode } from 'react';
import type { AssetCollection, AssetDetail } from '../asset-library/types';
import { libraryErrorText } from './errors';
import { Button, Disclosure, Icon, IconButton, MenuButton, Tabs, Tag, UiPortal, showToast, type MenuEntry } from '../ui';
import { formatBytes, formatWhen, useUiText, type UiText } from '../ui/i18n';
import type { ImageMetadataReport } from '../png-meta';
import { setCustomTags, type LibraryApi } from './api';
import { imageCreatedAt, imageMode, imageSource, type BatchIndex } from './model';
import { fileName, itemTitle, modelName, samplerName, ucName } from './present';
import { readReport, reportFields, reportHasSettings } from './image-meta';

export type ImageTab = 'prompt' | 'params' | 'info';

export interface ImageDetailProps {
  api: LibraryApi;
  detail: AssetDetail & { memberships?: Array<{ namespace: string; collectionId: string }> };
  batches: BatchIndex;
  projects: readonly AssetCollection[];
  collections: readonly AssetCollection[];
  tab: ImageTab;
  onTab(tab: ImageTab): void;
  onPrev?(): void;
  onNext?(): void;
  reuseEntries: MenuEntry[];
  collectEntries: MenuEntry[];
  collected: boolean;
  onExport(): void;
  /** Censor and export as JPG (for posting); absent where the host cannot (capture samples). */
  onCensor?(): void;
  onDelete(): void;
  onOpenQueue(): void;
  /** Reading an imported image's own settings (renderer parser), for its prompt and settings tabs. */
  readOriginal?: (url: string) => Promise<ArrayBuffer>;
}

/** The original image (or the best image the record has). */
export function detailImage(detail: AssetDetail) {
  const assets = detail.assets ?? [];
  const original = assets.find(asset => asset.role === 'original' && asset.fileUrl) ?? assets.find(asset => asset.fileUrl);
  return original?.fileUrl ? { url: original.fileUrl, filePath: original.filePath } : detail.item.payload?.fileUrl ? { url: detail.item.payload.fileUrl as string, filePath: detail.item.payload.filePath as string | undefined } : null;
}

const defaultRead = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error('unreadable'); return response.arrayBuffer(); };

/**
 * The image half of the detail drawer (prototype 02–04, 08): large image with ← → and full screen, time / size /
 * source / mode, 复用到画布 ▾, 收藏 ▾, export and delete, then the 提示词 / 参数 / 信息 tabs.
 */
export function ImageDetail({ api, detail, batches, projects, collections, tab, onTab, onPrev, onNext, reuseEntries, collectEntries, collected, onExport, onCensor, onDelete, onOpenQueue, readOriginal = defaultRead }: ImageDetailProps) {
  const { t, lang } = useUiText();
  const item = detail.item, payload = item.payload ?? {};
  const image = detailImage(detail);
  const [full, setFull] = useState(false);
  const [report, setReport] = useState<ImageMetadataReport | null | undefined>(undefined);
  const study = item.kind === 'study';
  useEffect(() => {
    if (!study || !image) { setReport(undefined); return; }
    let live = true; setReport(undefined);
    readOriginal(image.url).then(buffer => { if (live) setReport(readReport(buffer)); }).catch(() => { if (live) setReport(null); });
    return () => { live = false; };
  }, [study, image?.url]);
  const source = imageSource(item, batches), mode = imageMode(item, batches);
  const width = Number(payload.width ?? payload.study?.width), height = Number(payload.height ?? payload.study?.height);
  return <div className="lib-detail">
    <div className="lib-dr-img" onDragStart={event => { if (image?.filePath && api.startImageDrag) { event.preventDefault(); api.startImageDrag(image.filePath); } }}>
      {image ? <img src={image.url} alt={itemTitle(item)} draggable={!!image.filePath} title={t('d.dragOut')} /> : <Icon name="image" size={28} />}
      {onPrev && <IconButton className="lib-dr-nav is-left" tone="overlay" icon="left" label={t('d.prev')} onClick={onPrev} />}
      {onNext && <IconButton className="lib-dr-nav is-right" tone="overlay" icon="right" label={t('d.next')} onClick={onNext} />}
      {image && <IconButton className="lib-dr-full" tone="overlay" size="sm" icon="expand" label={t('d.full')} onClick={() => setFull(true)} />}
    </div>
    <div className="lib-dr-meta">
      <span className="ui-num">{formatWhen(imageCreatedAt(item), lang)}</span>
      {width > 0 && height > 0 && <span className="ui-num">{width}×{height}</span>}
      {source.kind === 'agent' && <Tag tone="agent" icon="agent">{source.label}</Tag>}
      {source.kind === 'manual' && <Tag>{t('c.manual')}</Tag>}
      {mode && <Tag>{t(`mode.${mode}`)}</Tag>}
      {item.archived && <Tag>{t('lib.archivedBadge')}</Tag>}
    </div>
    <div className="lib-dr-actions">
      <MenuButton label={t('d.reuse')} entries={reuseEntries} minWidth={280}>{trigger => <Button {...trigger} data-capture="reuse" variant="primary" icon="canvas" iconAfter="down">{t('d.reuse')}</Button>}</MenuButton>
      <MenuButton label={t('d.collect.menu')} entries={collectEntries}>{trigger => <Button {...trigger} icon={collected ? 'starFill' : 'star'}>{collected ? t('d.collected') : t('d.collect')}</Button>}</MenuButton>
      <IconButton icon="download" label={t('d.export')} onClick={onExport} />
      {onCensor && image && <IconButton icon="mosaic" label={t('cz.open')} onClick={onCensor} data-testid="detail-censor" />}
      <IconButton icon="trash" className="lib-danger-icon" label={t('d.delete')} onClick={onDelete} />
    </div>
    <Tabs<ImageTab> className="lib-dr-tabs" label={t('d.tab.label')} value={tab} onChange={onTab} tabs={[{ value: 'prompt', label: t('d.tab.prompt') }, { value: 'params', label: t('d.tab.params') }, { value: 'info', label: t('d.tab.info') }]} />
    {tab === 'prompt' && <PromptSection t={t} item={detail} report={report} />}
    {tab === 'params' && <ParamsSection t={t} lang={lang} detail={detail} report={report} mode={mode} />}
    {tab === 'info' && <InfoSection api={api} detail={detail} batches={batches} projects={projects} collections={collections} onOpenQueue={onOpenQueue} />}
    {full && image && <UiPortal><div className="lib-lightbox" role="dialog" aria-modal="true" aria-label={itemTitle(item)} tabIndex={-1} ref={node => node?.focus()} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setFull(false); } }} onClick={() => setFull(false)}>
      <img src={image.url} alt={itemTitle(item)} onClick={event => event.stopPropagation()} />
      <IconButton className="lib-lightbox-close" tone="overlay" icon="x" label={t('c.close')} onClick={() => setFull(false)} />
    </div></UiPortal>}
  </div>;
}

function CopyText({ label, text, t }: { label: ReactNode; text: string; t: UiText }) {
  return <div className="lib-ptext-wrap">
    <div className="lib-plabel">{label}</div>
    <div className="lib-ptext ui-mono">{text}<IconButton className="lib-ptext-cp" size="sm" icon="copy" label={t('c.copy')} onClick={() => { void navigator.clipboard?.writeText(text).then(() => showToast({ message: t('c.copied'), tone: 'ok', durationMs: 1800 })); }} /></div>
  </div>;
}

function PromptSection({ t, item: detail, report }: { t: UiText; item: AssetDetail; report: ImageMetadataReport | null | undefined }) {
  const payload = detail.item.payload ?? {};
  let style = '', positive = '', negative = '', characters: Array<{ prompt: string; negativePrompt: string }> = [];
  if (detail.item.kind === 'history') {
    const params = payload.params ?? {};
    style = String(params.stylePrompt ?? ''); positive = String(params.positivePrompt ?? ''); negative = String(params.negativePrompt ?? '');
    const captions = payload.characterSnapshot?.captions ?? (Array.isArray(payload.characterPrompts) ? payload.characterPrompts.map((prompt: string) => ({ prompt })) : []);
    characters = captions.map((caption: any) => ({ prompt: String(caption.prompt ?? ''), negativePrompt: String(caption.negativePrompt ?? '') }));
  } else if (report) {
    const fields = reportFields(report);
    style = fields.stylePrompt; positive = fields.positivePrompt; negative = fields.negativePrompt; characters = fields.characters;
  }
  if (detail.item.kind === 'study' && report === undefined) return <p className="lib-sect ui-muted" role="status">{t('imp.read.reading')}</p>;
  if (!style && !positive && !negative && !characters.length) return <p className="lib-sect ui-muted">{t('d.noPrompt')}</p>;
  return <div className="lib-sect">
    {style && <CopyText t={t} label={t('d.style')} text={style} />}
    {positive && <CopyText t={t} label={t('d.positive')} text={positive} />}
    {characters.map((character, index) => <div key={index} className="lib-sect-sub">
      {character.prompt && <CopyText t={t} label={t('d.char', { n: index + 1 })} text={character.prompt} />}
      {character.negativePrompt && <CopyText t={t} label={t('d.charNegative', { n: index + 1 })} text={character.negativePrompt} />}
    </div>)}
    {negative && <CopyText t={t} label={t('d.negative')} text={negative} />}
  </div>;
}

function ParamsSection({ t, lang, detail, report, mode }: { t: UiText; lang: 'zh' | 'en'; detail: AssetDetail; report: ImageMetadataReport | null | undefined; mode: string | null }) {
  const payload = detail.item.payload ?? {};
  const rows: Array<[string, ReactNode]> = [];
  const add = (label: string, value: unknown, render?: ReactNode) => { if (value !== undefined && value !== null && value !== '') rows.push([label, render ?? String(value)]); };
  const onOff = (value: unknown) => value === undefined ? undefined : value ? t('c.on') : t('c.off');
  if (detail.item.kind === 'history') {
    const params = payload.params ?? {};
    add(t('d.p.model'), payload.model ?? params.model, modelName(String(payload.model ?? params.model)));
    if (mode) add(t('d.p.mode'), mode, t(`mode.${mode}` as 'mode.t2i'));
    add(t('d.p.size'), payload.width && payload.height ? `${payload.width} × ${payload.height}` : undefined);
    add(t('d.p.steps'), params.steps); add(t('d.p.cfg'), params.cfgScale); add(t('d.p.rescale'), params.cfgRescale);
    add(t('d.p.sampler'), params.sampler, samplerName(params.sampler)); add(t('d.p.noise'), params.noiseSchedule);
    const seed = payload.actualSeed ?? params.seed;
    add(t('d.p.seed'), seed, <span className="lib-kv-seed ui-num">{String(seed)}<IconButton size="sm" icon="copy" label={t('d.copySeed')} onClick={() => { void navigator.clipboard?.writeText(String(seed)).then(() => showToast({ message: t('c.copied'), tone: 'ok', durationMs: 1800 })); }} /></span>);
    add(t('d.p.quality'), onOff(params.qualityToggle)); add(t('d.p.uc'), params.ucPreset, ucName(params.ucPreset));
    add(t('d.p.variety'), params.variety ? t('c.on') : undefined); add(t('d.p.transparent'), params.transparentBackground ? t('c.on') : undefined);
  } else if (report) {
    const fields = reportFields(report);
    add(t('d.p.model'), fields.model, fields.model ? modelName(fields.model) : undefined);
    add(t('d.p.size'), fields.width && fields.height ? `${fields.width} × ${fields.height}` : undefined);
    add(t('d.p.steps'), fields.steps); add(t('d.p.cfg'), fields.cfgScale); add(t('d.p.rescale'), fields.cfgRescale);
    add(t('d.p.sampler'), fields.sampler, samplerName(fields.sampler)); add(t('d.p.noise'), fields.noiseSchedule); add(t('d.p.seed'), fields.seed); add(t('d.p.uc'), fields.ucPreset, ucName(fields.ucPreset));
  }
  if (detail.item.kind === 'study' && report === undefined) return <p className="lib-sect ui-muted" role="status">{t('imp.read.reading')}</p>;
  if (!rows.length || (detail.item.kind === 'study' && !reportHasSettings(report))) return <p className="lib-sect ui-muted">{detail.item.kind === 'study' ? t('imp.read.none') : t('d.p.none')}</p>;
  void lang;
  return <dl className="lib-kv lib-sect">{rows.map(([label, value]) => <div key={label} className="lib-kv-row"><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function InfoSection({ api, detail, batches, projects, collections, onOpenQueue }: { api: LibraryApi; detail: AssetDetail & { memberships?: Array<{ namespace: string; collectionId: string }> }; batches: BatchIndex; projects: readonly AssetCollection[]; collections: readonly AssetCollection[]; onOpenQueue(): void }) {
  const { t, lang } = useUiText();
  const item = detail.item, payload = item.payload ?? {};
  const source = imageSource(item, batches);
  const project = typeof payload.groupId === 'string' ? projects.find(value => value.id === `history:${payload.groupId}`)?.name ?? payload.groupId : '';
  const inCollections = (detail.memberships ?? []).filter(value => value.namespace === 'user').map(value => collections.find(collection => collection.id === `user:${value.collectionId}`)?.name).filter(Boolean) as string[];
  const queue = payload.queueOrigin as { batchId: string; requestKey: string; itemIndex: number } | undefined;
  const rows: Array<[string, ReactNode]> = [];
  rows.push([t('d.i.source'), source.kind === 'agent' ? <Tag tone="agent" icon="agent">{source.label}</Tag> : source.kind === 'manual' ? t('d.source.manual') : t('d.i.imported')]);
  if (queue && source.kind === 'agent') rows.push([t('d.i.batch'), <button type="button" className="lib-link" onClick={onOpenQueue}>{t('d.i.batchRef', { index: String(queue.itemIndex + 1), project: project || t('c.none') })}</button>]);
  if (item.kind === 'history') rows.push([t('d.i.project'), project || <span className="ui-faint">{t('c.none')}</span>]);
  if (item.kind === 'study') {
    if (payload.study?.sourceUrl) rows.push([t('d.i.sourceUrl'), <button type="button" className="lib-link" onClick={() => void window.naiDesktop?.openExternal?.(payload.study.sourceUrl)}>{payload.study.sourceUrl}</button>]);
    if (payload.study?.sourceAuthor) rows.push([t('d.i.author'), payload.study.sourceAuthor]);
  }
  rows.push([t('d.i.created'), formatWhen(imageCreatedAt(item), lang)]);
  // The file size as the host recorded it (the original asset's byteLength, an import's byteLength); none when unknown.
  const recorded = Number((detail.assets ?? []).find(asset => asset.role === 'original')?.byteLength ?? payload.study?.byteLength ?? payload.byteLength);
  rows.push([t('d.i.file'), <span className="ui-mono lib-kv-file">{fileName(item)}{Number.isFinite(recorded) && recorded > 0 ? ` · ${formatBytes(recorded, lang)}` : ''}</span>]);
  rows.push([t('d.i.colls'), inCollections.length ? inCollections.join(t('c.listSep')) : <span className="ui-faint">{t('c.none')}</span>]);
  return <>
    <dl className="lib-kv lib-sect">{rows.map(([label, value]) => <div key={label} className="lib-kv-row"><dt>{label}</dt><dd>{value}</dd></div>)}
      {item.kind === 'history' && <div className="lib-kv-row"><dt>{t('d.i.tags')}</dt><dd><CustomTags api={api} detail={detail} /></dd></div>}
    </dl>
    <Disclosure summary={t('c.tech')} className="lib-tech">
      <div className="ui-mono lib-tech-body">
        <div>id {item.id}</div><div>revision {item.revision}</div>
        {queue && <><div>batchId {queue.batchId}</div><div>requestKey {queue.requestKey}</div><div>itemIndex {queue.itemIndex}</div></>}
        {payload.generationOrigin?.jobId && <div>jobId {payload.generationOrigin.jobId}</div>}
        {payload.study?.sha256 && <div>sha256 {payload.study.sha256}</div>}
      </div>
    </Disclosure>
  </>;
}

/** The image's own tags (history only); saved with the image's current revision, never retried. */
function CustomTags({ api, detail }: { api: LibraryApi; detail: AssetDetail }) {
  const { t, lang } = useUiText();
  const tags: string[] = detail.item.payload?.annotation?.customTags ?? [];
  const [input, setInput] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (next: string[]) => {
    setBusy(true);
    try { await setCustomTags(api, detail.item, next); setInput(''); setAdding(false); }
    catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); }
    finally { setBusy(false); }
  };
  return <span className="lib-ctags">
    {tags.map(tag => <span key={tag} className="lib-ctag"><Tag tone="accent">{tag}</Tag><button type="button" className="lib-ctag-x" aria-label={t('d.i.removeTag', { name: tag })} disabled={busy} onClick={() => void save(tags.filter(value => value !== tag))}><Icon name="x" size={10} /></button></span>)}
    {adding ? <input className="ui-input lib-ctag-input" autoFocus value={input} disabled={busy} placeholder={t('d.i.tagPlaceholder')} aria-label={t('d.i.tags')} onChange={event => setInput(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && input.trim()) { event.preventDefault(); void save([...tags, input.trim()]); } if (event.key === 'Escape') { event.stopPropagation(); setAdding(false); setInput(''); } }} onBlur={() => { if (!input.trim()) setAdding(false); }} />
      : <button type="button" className="lib-link" onClick={() => setAdding(true)}>{t('d.i.addTag')}</button>}
  </span>;
}
