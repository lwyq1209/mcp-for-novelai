import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import { Icon, Seg } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { maxNAICharacterPrompts, supportsNAICharacterPrompts, type CharCaption } from '../../types';
import { PromptTextarea } from '../PromptTextarea';
import { HeadAction, NumberField, Section } from '../controls';
import { useDraftGroups } from '../draft-model';
import { DraftBadge } from '../DraftBadge';
import { showStepToast } from '../guarded-undo';
import { persistWorkspaceState } from '../../store';
import { PromptLibraryPicker } from '../LibraryPicker';

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const fixed = (value: number) => value.toFixed(2);

/** The 5 × 5 cell of a position (0–1), for the small position glyph of a character card. */
const cellOf = (value: number) => Math.min(4, Math.max(0, Math.floor(value * 5)));

/**
 * Characters, edited in place (prototype 13; it replaces the old character dialog): the position mode of all of them
 * (auto or custom, as the old dialog switched every character at once), a pad to drag their positions, and one card
 * per character with its prompt, negative prompt and exact coordinates. Every change goes through the store's
 * character actions, as before.
 */
export function CharactersSection() {
  const { t } = useUiText();
  const captions = useAppStore(state => state.charCaptions);
  const model = useAppStore(state => state.params.model);
  const width = useAppStore(state => state.params.width);
  const height = useAppStore(state => state.params.height);
  const add = useAppStore(state => state.addCharCaption);
  const update = useAppStore(state => state.updateCharCaption);
  const supported = supportsNAICharacterPrompts(model);
  const max = maxNAICharacterPrompts(model);
  const custom = captions.some(caption => caption.useCoords);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const seen = useRef(new Set(captions.map(caption => caption.id)));
  // A character added here (or by a restore) that is still empty opens for editing.
  useEffect(() => {
    const fresh = captions.filter(caption => !seen.current.has(caption.id));
    captions.forEach(caption => seen.current.add(caption.id));
    const empty = fresh.filter(caption => !caption.prompt.trim());
    if (empty.length) setOpen(current => new Set([...current, ...empty.map(caption => caption.id)]));
  }, [captions]);
  const marked = useDraftGroups().has('chars');
  const toggle = (id: string) => setOpen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const setMode = (next: 'auto' | 'custom') => { for (const caption of captions) update(caption.id, { useCoords: next === 'custom' }); };
  // 清空 (the old dialog's 清空角色), undone from its toast while the characters are still none.
  const clearAll = () => {
    const before = useAppStore.getState().charCaptions;
    useAppStore.getState().clearCharCaptions();
    showStepToast(t, t('cv.chars.cleared'), { read: () => useAppStore.getState().charCaptions, after: [], restore: () => { useAppStore.setState({ charCaptions: before }); persistWorkspaceState(); } });
  };

  return <Section testId="cv-characters" title={captions.length ? t('cv.chars.count', { n: captions.length }) : t('cv.chars')} changed={marked} badge={marked ? <DraftBadge /> : undefined} actions={<>
    {captions.length > 0 && <HeadAction icon="trash" onClick={clearAll} title={t('cv.chars.clearTip')} testId="cv-char-clear">{t('cv.chars.clear')}</HeadAction>}
    <HeadAction icon="plus" onClick={add} disabled={!supported || captions.length >= max} title={supported ? t('cv.chars.limit', { n: max }) : t('cv.chars.unsupported')} testId="cv-char-add">{t('cv.chars.add')}</HeadAction>
  </>}>
    {!supported && <p className="cv-note cv-note--warn">{t('cv.chars.unsupported')}</p>}
    {supported && captions.length > 0 && <div className="cv-char-mode">
      <span className="ui-muted">{t('cv.chars.position')}</span>
      <Seg<'auto' | 'custom'> size="sm" label={t('cv.chars.position')} value={custom ? 'custom' : 'auto'} onChange={setMode} options={[{ value: 'auto', label: t('cv.chars.auto') }, { value: 'custom', label: t('cv.chars.custom') }]} />
    </div>}
    {supported && custom && captions.length > 0 && <PositionPad captions={captions} width={width} height={height} />}
    {captions.map((caption, index) => <CharacterCard key={caption.id} caption={caption} index={index} model={model} expanded={open.has(caption.id)} onToggle={() => toggle(caption.id)} />)}
  </Section>;
}

/** Drag the numbered markers (the old dialog's position stage): the pad has the image's aspect ratio. */
function PositionPad({ captions, width, height }: { captions: CharCaption[]; width: number; height: number }) {
  const { t } = useUiText();
  const update = useAppStore(state => state.updateCharCaption);
  const aspect = Math.max(1, width) / Math.max(1, height);
  const place = (caption: CharCaption, event: ReactPointerEvent<HTMLButtonElement>) => {
    const pad = event.currentTarget.parentElement;
    if (!pad) return;
    const rect = pad.getBoundingClientRect();
    update(caption.id, { useCoords: true, x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) });
  };
  return <div className="cv-pad-wrap"><div className="cv-pad" aria-label={t('cv.chars.pad')} title={t('cv.chars.customHint')} style={{ aspectRatio: `${Math.max(1, width)} / ${Math.max(1, height)}`, width: aspect >= 1 ? '100%' : `${Math.max(34, aspect * 100)}%` }}>
    {captions.map((caption, index) => <button key={caption.id} type="button" className="cv-pad-marker" data-testid={`cv-char-marker-${index + 1}`}
      style={{ left: `${(caption.useCoords ? caption.x : 0.5) * 100}%`, top: `${(caption.useCoords ? caption.y : 0.5) * 100}%` }}
      aria-label={t('cv.chars.marker', { n: index + 1 })} title={`${t('cv.char.n', { n: index + 1 })} · ${t('cv.char.at', { x: fixed(caption.x), y: fixed(caption.y) })}`}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); place(caption, event); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) place(caption, event); }}
      onKeyDown={event => {
        const step = event.shiftKey ? 0.05 : 0.01;
        const patch: { x?: number; y?: number } = {};
        if (event.key === 'ArrowLeft') patch.x = Math.max(0, caption.x - step);
        if (event.key === 'ArrowRight') patch.x = Math.min(1, caption.x + step);
        if (event.key === 'ArrowUp') patch.y = Math.max(0, caption.y - step);
        if (event.key === 'ArrowDown') patch.y = Math.min(1, caption.y + step);
        if (patch.x == null && patch.y == null) return;
        event.preventDefault();
        update(caption.id, { ...patch, useCoords: true });
      }}>{index + 1}</button>)}
  </div></div>;
}

function CharacterCard({ caption, index, model, expanded, onToggle }: { caption: CharCaption; index: number; model: string; expanded: boolean; onToggle(): void }) {
  const { t } = useUiText();
  const update = useAppStore(state => state.updateCharCaption);
  const remove = useAppStore(state => state.removeCharCaption);
  const autoComplete = useAppStore(state => state.settings?.autoComplete ?? true);
  const libraryButton = useRef<HTMLButtonElement>(null);
  const [picker, setPicker] = useState(false);
  const n = index + 1;
  const cellX = caption.useCoords ? cellOf(caption.x) : -1, cellY = caption.useCoords ? cellOf(caption.y) : -1;
  return <div className={clsx('cv-char', expanded && 'is-open')} data-testid={`cv-char-${n}`}>
    <div className="cv-char-row">
      <button type="button" className="cv-char-head" aria-expanded={expanded} aria-label={t(expanded ? 'cv.char.collapse' : 'cv.char.expand', { n })} onClick={onToggle}>
        <span className="cv-char-pg" aria-hidden="true">{Array.from({ length: 25 }, (_, cell) => <i key={cell} className={clsx(cell % 5 === cellX && Math.floor(cell / 5) === cellY && 'on')} />)}</span>
        <span className="cv-char-tx ui-mono">{caption.prompt.trim() || t('cv.char.empty')}</span>
        <span className="ui-tag">{caption.useCoords ? t('cv.char.at', { x: fixed(caption.x), y: fixed(caption.y) }) : t('cv.chars.auto')}</span>
      </button>
      <button type="button" className="cv-iconbtn" aria-label={t('cv.char.remove', { n })} title={t('cv.char.remove', { n })} onClick={() => remove(caption.id)}><Icon name="x" size={14} /></button>
    </div>
    {expanded && <div className="cv-char-body">
      <div className="cv-pbox">
        <PromptTextarea value={caption.prompt} model={model} enabled={autoComplete} rows={3} ariaLabel={`${t('cv.char.n', { n })} · ${t('cv.char.prompt')}`} placeholder={t('cv.char.promptPlaceholder')} className="cv-prompt-text" testId={`cv-char-prompt-${n}`} onChange={prompt => update(caption.id, { prompt })} />
        <div className="cv-pfoot">
          <button ref={libraryButton} type="button" className={clsx('cv-hact', picker && 'is-on')} aria-pressed={picker} title={t('cv.fromLibTip')} onClick={() => setPicker(open => !open)} data-testid={`cv-char-library-${n}`}><Icon name="library" size={13} />{t('cv.fromLib')}</button>
        </div>
        <PromptLibraryPicker open={picker} anchor={libraryButton} onClose={() => setPicker(false)} field="character" characterId={caption.id} characterNumber={n} value={caption.prompt}
          read={() => useAppStore.getState().charCaptions.find(value => value.id === caption.id)?.prompt ?? ''} onChange={prompt => update(caption.id, { prompt })} />
      </div>
      <div className="cv-pbox cv-pbox--neg">
        <PromptTextarea value={caption.negativePrompt ?? ''} model={model} enabled={autoComplete} rows={2} ariaLabel={`${t('cv.char.n', { n })} · ${t('cv.char.negative')}`} placeholder={t('cv.char.negativePlaceholder')} className="cv-prompt-text" testId={`cv-char-negative-${n}`} onChange={negativePrompt => update(caption.id, { negativePrompt })} />
      </div>
      {caption.useCoords && <div className="cv-char-xy">
        <label><span>{t('cv.char.x')}</span><NumberField label={`${t('cv.char.n', { n })} · ${t('cv.char.x')}`} value={caption.x} min={0} max={1} step={0.01} normalize={clamp01} onCommit={x => update(caption.id, { x })} /></label>
        <label><span>{t('cv.char.y')}</span><NumberField label={`${t('cv.char.n', { n })} · ${t('cv.char.y')}`} value={caption.y} min={0} max={1} step={0.01} normalize={clamp01} onCommit={y => update(caption.id, { y })} /></label>
      </div>}
    </div>}
  </div>;
}
