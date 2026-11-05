import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, Icon, IconButton, showToast } from '../ui';
import { uiText, useUiText, type UiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { hostErrorText } from '../host-errors';
import { agentClientLabel, type AgentActivity } from '../agent-clients';
import { relativeWhen } from '../settings/mcp/model';
import { navigate } from '../shell/route';
import { WorkspaceError } from '../workspace/protocol';
import type { WorkspaceController, WorkspaceDraft, WorkspaceView } from '../workspace/controller';
import { DIRECTOR_TOOLS, NAI_INPAINT_MODELS, NAI_MODELS, NAI_SAMPLERS, NAI_UC_PRESETS } from '../types';
import { agentDraftOf, elide, isStale, promptDiff, reviewRows, useWorkspaceController, useWorkspaceView, type ReviewRow } from './draft-model';
import { optionLabel } from './controls';

/** The event the old pending-changes entries send (queue page, old panels): it opens the review on the canvas. */
export const REVIEW_EVENT = 'novelai:review-changes';

// ── Who sent a draft ─────────────────────────────────────────────────────────
// The host records the agent calls (client, tool, time; never arguments): the draft's sender is the client of the
// latest draft_edit call up to the moment the canvas first saw that draft. Kept per draft id for this run.
const senders = new Map<string, { name: string; at: number }>();
async function senderOf(draftId: string): Promise<{ name: string; at: number }> {
  const known = senders.get(draftId);
  if (known) return known;
  const seenAt = Date.now();
  let name = agentClientLabel(null);
  try {
    const activity = await window.naiDesktop.agentActivity?.() as AgentActivity | undefined;
    const call = (activity?.recent ?? []).filter(item => (item.tool === 'draft_edit' || item.method === 'draft_edit') && Date.parse(item.at) <= seenAt + 2_000)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
    if (call) name = agentClientLabel(call.client);
  } catch { /* the name stays Agent */ }
  const value = { name, at: seenAt };
  senders.set(draftId, value);
  while (senders.size > 50) senders.delete(senders.keys().next().value!);
  return value;
}
function useSender(draft: WorkspaceDraft | null) {
  const [sender, setSender] = useState<{ id: string; name: string; at: number } | null>(null);
  useEffect(() => {
    if (!draft) { setSender(null); return; }
    let live = true;
    void senderOf(draft.draftId).then(value => { if (live) setSender({ id: draft.draftId, ...value }); });
    return () => { live = false; };
  }, [draft?.draftId]);
  return sender && draft && sender.id === draft.draftId ? sender : null;
}
/** A clock that ticks every 30 s, for "2 分钟前". */
function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);
  return now;
}

// ── Applying, discarding, undoing ────────────────────────────────────────────
/** The text of a refusal of apply_edit / undo_edit in the interface language. */
export function draftErrorText(error: unknown, t: UiText, language: string): string {
  const code = error instanceof WorkspaceError ? error.code : (error as { code?: unknown } | null)?.code;
  if (code === 'conflict') return t('cv.draft.conflict');
  if (code === 'draft_not_found') return t('cv.draft.gone');
  if (code === 'workspace_busy') return t('cv.draft.busy');
  if (code === 'undo_unavailable') return t('cv.draft.undoGone');
  return hostErrorText(error, language);
}

/**
 * Undoes the last applied draft. draftId (the applied toast's undo) limits it to that draft: when another one was
 * applied after it, nothing is undone.
 */
export async function undoLastApplied(controller: WorkspaceController, t: UiText, language: string, name: string, draftId?: string) {
  const view = controller.getView();
  if (draftId && view.lastApplied?.draftId !== draftId) { showToast({ message: t('cv.undo.notLast'), tone: 'warn' }); return; }
  if (!view.undoAvailable) { showToast({ message: t('cv.draft.undoGone'), tone: 'warn' }); return; }
  try {
    await controller.execute('undo_edit', { workspaceId: view.workspaceId, expectedRevision: view.revision });
    showToast({ message: t('cv.draft.undone', { name }), tone: 'neutral' });
  } catch (error) {
    showToast({ message: error instanceof WorkspaceError && error.code === 'conflict' ? t('cv.draft.undoGone') : t('cv.draft.undoFailed', { reason: draftErrorText(error, t, language) }), tone: 'warn' });
  }
}

function useDraftActions(controller: WorkspaceController | null, view: WorkspaceView | null, draft: WorkspaceDraft | null, name: string) {
  const { t, language } = useUiText();
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (!controller || !view || !draft || busy) return false;
    setBusy(true);
    try {
      await controller.execute('apply_edit', { workspaceId: view.workspaceId, expectedRevision: controller.getView().revision, draftId: draft.draftId });
      const applied = draft.draftId;
      showToast({ message: lang => uiText(lang, 'cv.draft.applied', { name }), tone: 'ok', durationMs: 8000, action: { label: lang => uiText(lang, 'cv.draft.undo'), onClick: () => void undoLastApplied(controller, t, language, name, applied) } });
      return true;
    } catch (error) {
      showToast({ message: t('cv.draft.failed', { reason: draftErrorText(error, t, language) }), tone: 'danger' });
      return false;
    } finally { setBusy(false); }
  };
  const discard = () => {
    if (!controller || !draft) return;
    // Only the draft shown (a newer one may have replaced it meanwhile).
    if (controller.getView().draft?.draftId !== draft.draftId) return;
    controller.discardDraft();
    showToast({ message: t('cv.draft.discarded') });
  };
  return { busy, apply, discard };
}

// ── The layer on the stage: banner, review sheet, undo chip ─────────────────
/**
 * The agent draft on the stage (prototype 13–15): a cyan banner (discard / review / apply), the review sheet with
 * the fields side by side, and a yellow banner once the draft is out of date (it can then only be discarded). The
 * canvas's values never change before 应用; the left column only marks the fields (DraftBadge). Applying is
 * apply_edit of the workspace controller and can be undone (undo_edit) until the canvas changes again.
 */
export function DraftLayer() {
  const { t, lang } = useUiText();
  const controller = useWorkspaceController();
  const view = useWorkspaceView(controller);
  const draft = agentDraftOf(view);
  const stale = isStale(view, draft);
  const sender = useSender(draft);
  const name = sender?.name ?? agentClientLabel(null);
  const now = useMinuteClock();
  const [sheet, setSheet] = useState(false);
  const actions = useDraftActions(controller, view, draft, name);
  // Closing the sheet (Esc, ×) puts the focus back on the banner's 查看改动 it was opened from.
  const reviewButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const closeSheet = () => { returnFocus.current = true; setSheet(false); };
  useEffect(() => {
    if (sheet || !returnFocus.current) return;
    returnFocus.current = false;
    reviewButton.current?.focus({ preventScroll: true });
  }, [sheet]);
  useEffect(() => { if (!draft) setSheet(false); }, [draft?.draftId]);
  // The old entries (queue page, old panels) ask for the review: show the canvas with it.
  // With no agent draft the canvas alone answers (its header offers the undo of the last applied draft), and no
  // review sheet is left armed for the next draft.
  const hasDraft = useRef(false);
  hasDraft.current = !!draft;
  useEffect(() => {
    const open = () => { navigate('canvas'); if (hasDraft.current) setSheet(true); };
    window.addEventListener(REVIEW_EVENT, open);
    return () => window.removeEventListener(REVIEW_EVENT, open);
  }, []);
  if (!draft) return null;
  const fields = [...new Set(draft.changes.map(change => fieldText(t, change.field)))];
  const shown = fields.slice(0, 3).join(t('c.listSep')) + (fields.length > 3 ? ` ${t('cv.draft.more', { n: fields.length - 3 })}` : '');
  const when = sender ? relativeWhen(new Date(sender.at).toISOString(), lang, now) : '';
  // The sheet takes the banner's place while it is open (prototype 14); it has the same actions.
  return <>
    {!sheet && <div className={clsx('cv-banner', stale && 'is-warn')} role="status" data-testid="cv-draft-banner" data-stale={stale || undefined}>
      <span className="cv-banner-icon"><Icon name={stale ? 'alert' : 'agent'} size={18} /></span>
      <div className="cv-banner-text">
        <b>{stale ? t('cv.draft.staleTitle', { name }) : t('cv.draft.title', { name })}</b>
        <span>{stale ? t('cv.draft.stale') : t('cv.draft.sum', { n: fields.length, fields: shown, when })}</span>
      </div>
      <Button size="sm" variant={stale ? 'default' : 'ghost'} onClick={actions.discard} data-testid="cv-draft-discard">{t('cv.draft.discard')}</Button>
      {!stale && <Button ref={reviewButton} size="sm" onClick={() => setSheet(true)} data-testid="cv-draft-review">{t('cv.draft.review')}</Button>}
      {!stale && <Button size="sm" variant="primary" busy={actions.busy} onClick={() => void actions.apply()} data-testid="cv-draft-apply">{t('cv.draft.apply')}</Button>}
    </div>}
    {sheet && <ReviewSheet draft={draft} name={name} when={when} stale={stale} busy={actions.busy} onClose={closeSheet}
      onDiscard={() => { actions.discard(); setSheet(false); }} onApply={async () => { if (await actions.apply()) setSheet(false); }} />}
  </>;
}

/** The stage header's undo of the last applied draft (shown while undo_edit can still undo it). */
export function DraftUndoChip() {
  const { t, language } = useUiText();
  const controller = useWorkspaceController();
  const view = useWorkspaceView(controller);
  if (!controller || !view?.undoAvailable || view.lastApplied?.kind !== 'edit' || agentDraftOf(view)) return null;
  const name = senders.get(view.lastApplied.draftId)?.name ?? agentClientLabel(null);
  return <button type="button" className="cv-hact cv-undo-chip" title={t('cv.draft.undoTip')} data-testid="cv-draft-undo" onClick={() => void undoLastApplied(controller, t, language, name)}>
    <Icon name="undo" size={13} />{t('cv.draft.undoChip')}
  </button>;
}

function ReviewSheet({ draft, name, when, stale, busy, onClose, onDiscard, onApply }: { draft: WorkspaceDraft; name: string; when: string; stale: boolean; busy: boolean; onClose(): void; onDiscard(): void; onApply(): void }) {
  const { t, language } = useUiText();
  const params = useAppStore(state => state.params);
  const rows = useMemo(() => reviewRows(draft, { width: params.width, height: params.height, seed: params.seed, seedMode: params.seedMode }), [draft, params.width, params.height, params.seed, params.seedMode]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="dialog"][aria-modal="true"]')) { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  // Opened (also with Enter on 查看改动), the focus moves into the sheet.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, []);
  return <aside ref={panel} tabIndex={-1} className="cv-sheet" role="complementary" aria-label={t('cv.draft.sheet', { name })} data-testid="cv-draft-sheet">
    <div className="cv-sheet-h">
      <span className="cv-banner-icon"><Icon name="agent" size={16} /></span>
      <div className="cv-grow"><b>{t('cv.draft.sheet', { name })}</b><div className="ui-faint">{when}</div></div>
      <IconButton icon="x" label={t('cv.draft.close')} onClick={onClose} />
    </div>
    <div className="cv-sheet-b">
      <p className={clsx('cv-note', stale ? 'cv-note--warn' : 'cv-note--agent')}><Icon name={stale ? 'alert' : 'info'} size={14} /><span>{stale ? t('cv.draft.stale') : t('cv.draft.note')}</span></p>
      {rows.map(row => <DiffCard key={row.id} row={row} language={language} />)}
    </div>
    <div className="cv-sheet-f">
      <Button onClick={onDiscard} data-testid="cv-sheet-discard">{t('cv.draft.discard')}</Button>
      <Button variant="primary" icon="check" disabled={stale} busy={busy} onClick={onApply} data-testid="cv-sheet-apply">{t('cv.draft.apply')}</Button>
    </div>
  </aside>;
}

function DiffCard({ row, language }: { row: ReviewRow; language: string }) {
  const { t } = useUiText();
  const label = rowLabel(t, row);
  if (row.kind === 'text') {
    const diff = promptDiff(String(row.before ?? ''), String(row.after ?? ''));
    const line = (parts: ReturnType<typeof elide>) => parts.length ? parts.map((part, index) => <span key={index}>{index > 0 ? ', ' : ''}<span className={part.op === 'del' ? 'cv-del' : part.op === 'ins' ? 'cv-ins' : undefined}>{part.text}</span></span>) : <span className="ui-faint">{t('cv.draft.empty')}</span>;
    return <div className="cv-diff" data-testid={`cv-diff-${row.id}`}>
      <div className="cv-diff-h">{label}</div>
      <div className="cv-diff-r"><span className="cv-diff-k">{t('cv.draft.now')}</span><span className="ui-mono">{line(elide(diff.before))}</span></div>
      <div className="cv-diff-r"><span className="cv-diff-k is-agent">{t('cv.draft.after')}</span><span className="ui-mono">{line(elide(diff.after))}</span></div>
    </div>;
  }
  const before = valueText(t, row, row.before, language), after = valueText(t, row, row.after, language);
  return <div className="cv-diff" data-testid={`cv-diff-${row.id}`}>
    <div className="cv-diff-h">{label}</div>
    <div className="cv-diff-r"><span className="cv-diff-k">{t('cv.draft.now')}</span><span className="ui-mono cv-pre">{before}</span></div>
    <div className="cv-diff-r"><span className="cv-diff-k is-agent">{t('cv.draft.after')}</span><span className="ui-mono cv-pre"><span className="cv-ins">{after}</span></span></div>
  </div>;
}

// ── Text of fields and values ────────────────────────────────────────────────
function rowLabel(t: UiText, row: ReviewRow) {
  const text = t(row.label.key, row.label.name ? { name: row.label.name } : undefined);
  return row.label.inpaint ? t('cv.f.in', { name: text }) : text;
}
/** The banner's name of one change field. */
export function fieldText(t: UiText, field: string) {
  const rows = reviewRows({ draftId: '', baseRevision: 0, kind: 'edit', changes: [{ field, before: null, after: null }] });
  return rowLabel(t, rows[0]);
}

const OPTION_LISTS: Record<string, ReadonlyArray<{ value: string | number; label: string }>> = {
  model: NAI_MODELS, sampler: NAI_SAMPLERS, ucPreset: NAI_UC_PRESETS, inpaintModel: NAI_INPAINT_MODELS, directorTool: DIRECTOR_TOOLS,
};

/** One value of the review in words (never image bytes): sizes, seeds, switches, options, characters, references. */
export function valueText(t: UiText, row: ReviewRow, value: unknown, language: string): string {
  if (row.kind === 'size') { const v = value as { width?: number; height?: number }; return `${v.width ?? '?'} × ${v.height ?? '?'}`; }
  if (row.kind === 'seed') { const v = value as { seed?: number; seedMode?: string }; return v.seedMode === 'random' ? t('cv.draft.random') : String(v.seed ?? ''); }
  const [head, sub] = row.id.split('.');
  const key = sub ?? head;
  if (head === 'inpaintRecipe' && !sub) return t(value ? 'cv.draft.on' : 'cv.draft.off');
  if (value === null || value === undefined) return t('cv.draft.none');
  if (typeof value === 'boolean') return t(value ? 'cv.draft.on' : 'cv.draft.off');
  if (key === 'inpaintMask') return t(String(value).includes('changed') ? 'cv.draft.newMask' : 'cv.draft.mask');
  if (typeof value === 'string' && /^(Image present|Selected image)/.test(value)) return t(value.startsWith('Selected') ? 'cv.draft.newImage' : 'cv.draft.image');
  if (OPTION_LISTS[key]) { const item = OPTION_LISTS[key].find(option => option.value === value); return item ? optionLabel(language, item.value, item.label).name : String(value); }
  if (key === 'qualityPreset') return t(value === 'none' ? 'cv.quality.none' : value === 'light' ? 'cv.quality.light' : 'cv.quality.standard');
  if (key === 'directorTool' && typeof value === 'string') return t(`cv.pp.tool.${value}` as never);
  if (key === 'charCaptions' && Array.isArray(value)) {
    if (!value.length) return t('cv.draft.chars', { n: 0 });
    return value.map((caption: any, index) => `${index + 1}. ${String(caption?.prompt ?? '').trim() || t('cv.draft.empty')}${caption?.useCoords ? ` · ${t('cv.draft.charAt', { x: Number(caption.x).toFixed(2), y: Number(caption.y).toFixed(2) })}` : ''}`).join('\n');
  }
  if ((key === 'vibeImages' || key === 'preciseReferences') && typeof value === 'object') {
    const refs = value as { count?: number; references?: Array<Record<string, unknown>> };
    const list = (refs.references ?? []).map((ref, index) => `${index + 1}. ${Object.entries(ref).filter(([name]) => !['id', 'name', 'srcWidth', 'srcHeight', 'assetId'].includes(name)).map(([name, part]) => `${name} ${part}`).join(' · ')}`);
    return [t('cv.draft.refs', { n: refs.count ?? 0 }), ...list].join('\n');
  }
  if (typeof value === 'string') return value || t('cv.draft.empty');
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(item => typeof item === 'object' ? JSON.stringify(item) : String(item)).join('\n');
  if (typeof value === 'object') return Object.entries(value as Record<string, unknown>).filter(([name]) => !['base64', 'data', 'fileUrl', 'filePath', 'assetId', 'previewUrl'].includes(name))
    .map(([name, part]) => `${name}: ${typeof part === 'object' ? JSON.stringify(part) : String(part)}`).join('\n');
  return String(value);
}
