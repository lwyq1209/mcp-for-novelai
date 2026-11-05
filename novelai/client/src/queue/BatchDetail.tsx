import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { hostErrorText, readHostError } from '../host-errors';
import { upstreamText } from './upstream';
import type { LibraryApi } from '../library/api';
import { openInLibrary } from '../library/intent';
import { Button, Dialog, Disclosure, Dot, Icon, IconButton, Progress, type IconName } from '../ui';
import type { UiLang, UiText } from '../ui/i18n';
import type { AppLanguage } from '../types';
import { queueActions, type QueueAction } from '../workspace/queue-monitor';
import { ItemGrid } from './ItemGrid';
import { StatusTag, enqueuedText, isAgentBatch, sourceLabel } from './QueueList';
import {
  ACTION_SETTLE_MS, STATUS_TEXT, actionStateKey, batchCounts, batchNotes, batchProject, batchProjectId, batchTitle, cancelImpact, isHalted, itemsTsv, modeLabelKey,
  progressTone, shortId, type BatchNote, type QueueBatch,
} from './model';
import { isBatchTerminal } from '../workspace/batch-types';

export interface BatchDetailProps {
  api: LibraryApi;
  batch: QueueBatch;
  hasToken: boolean;
  /** Minutes left (0: under a minute), or null when it can't be estimated reliably. */
  eta: number | null;
  onAction(action: QueueAction, batchId: string): Promise<unknown>;
  t: UiText;
  lang: UiLang;
  language: AppLanguage;
  /** Tests: render the cancel confirmation open. */
  initialConfirm?: boolean | 'cancel' | 'resume';
  /** The page chose this batch by itself (default or fallback): the buttons settle first, as after a state change. */
  settleOnMount?: boolean;
  /** The batch's project is still being read (seen through an event only): never shown as 无. */
  projectPending?: boolean;
}

const ACTION: Record<QueueAction, { label: 'q.pause' | 'q.resume' | 'q.cancel'; icon: IconName; variant: 'default' | 'primary' | 'dangerGhost' }> = {
  pause: { label: 'q.pause', icon: 'pause', variant: 'default' },
  resume: { label: 'q.resume', icon: 'play', variant: 'primary' },
  cancel: { label: 'q.cancel', icon: 'stop', variant: 'dangerGhost' },
};

/** The right side: one batch's state, its controls, notes, images and technical details. Render with key={batchId}. */
export function BatchDetail({ api, batch, hasToken, eta, onAction, t, lang, language, initialConfirm = false, settleOnMount = false, projectPending = false }: BatchDetailProps) {
  const [busy, setBusy] = useState<QueueAction | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  // The confirmation open now: cancel, or resuming a batch the queue paused itself (queue_halted).
  const [confirming, setConfirming] = useState<'cancel' | 'resume' | null>(initialConfirm === true ? 'cancel' : initialConfirm || null);
  // Said in place when a confirmation closed itself because the batch changed meanwhile.
  const [closedNote, setClosedNote] = useState<'' | 'ended' | 'changed'>('');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const counts = batchCounts(batch);
  const actions = queueActions(batch);
  const title = batchTitle(batch, t);
  const project = batchProject(batch);
  const projectId = batchProjectId(batch);
  const halted = isHalted(batch) && batch.status === 'paused';

  // After the batch's state or its buttons change, the buttons stay off for ACTION_SETTLE_MS and the change is said
  // beside them (review rework 4b2 P1): a click aimed at 暂停后续 never lands on the 继续 that took its place.
  const stateKey = actionStateKey(batch, actions);
  const [settling, setSettling] = useState(settleOnMount);
  const [changed, setChanged] = useState(false);
  const lastKey = useRef(stateKey);
  useEffect(() => {
    if (lastKey.current !== stateKey) { lastKey.current = stateKey; setSettling(true); setChanged(true); }
    else if (!settleOnMount) return; // first render of a batch the user picked: nothing to settle
    const settle = setTimeout(() => setSettling(false), ACTION_SETTLE_MS);
    const note = setTimeout(() => setChanged(false), ACTION_SETTLE_MS * 3);
    return () => { clearTimeout(settle); clearTimeout(note); };
  }, [stateKey]);

  // The keyboard focus stays in the actions (second rework, P3): a button that keeps its place keeps the focus (it is
  // only soft-disabled while settling); when the focused one goes away with its state (暂停后续 while pausing), the
  // focus moves to the actions group, not the page, and Enter there does nothing.
  const actsRef = useRef<HTMLDivElement>(null);
  const focusInside = useRef(false);
  useLayoutEffect(() => {
    const acts = actsRef.current;
    if (!acts || !focusInside.current) return;
    const active = typeof document === 'undefined' ? null : document.activeElement;
    if (!active || active === document.body) acts.focus({ preventScroll: true });
  }, [stateKey, busy]);

  // A confirmation whose question no longer applies closes itself and says why: the batch ended (nothing was
  // cancelled or resumed), or it is no longer paused by the queue's stop protection.
  useEffect(() => {
    if (!confirming || busy) return;
    if (isBatchTerminal(batch.status)) { setConfirming(null); setClosedNote('ended'); }
    else if (confirming === 'cancel' && !actions.includes('cancel')) { setConfirming(null); setClosedNote('changed'); }
    else if (confirming === 'resume' && !halted) { setConfirming(null); setClosedNote('changed'); }
  }, [batch.status, stateKey, confirming, busy, halted]);

  const run = async (action: QueueAction) => {
    setBusy(action); setFailure(null); setClosedNote('');
    try { await onAction(action, batch.batchId); if (alive.current) setConfirming(null); }
    catch (error) { if (alive.current) { setFailure(error ?? new Error('')); setConfirming(null); } }
    finally { if (alive.current) setBusy(null); }
  };
  const press = (action: QueueAction) => {
    if (settling || busy) return;
    setClosedNote('');
    if (action === 'cancel') setConfirming('cancel');
    else if (action === 'resume' && halted) setConfirming('resume');
    else void run(action);
  };
  const openCheck = () => openInLibrary({ view: projectId ? { type: 'project', id: `history:${projectId}` } : { type: 'category', category: 'history' } });
  const failureCode = failure ? readHostError(failure).code : undefined;

  return <div className="qp-detail" data-testid={`queue-detail-${batch.batchId}`} data-status={batch.status}>
    <header className="qp-detail-head">
      <div className="qp-detail-title">
        <h2 title={title}>{title}</h2>
        <StatusTag batch={batch} t={t} />
        <div ref={actsRef} className={clsx('qp-acts', settling && 'is-settling', changed && 'is-changed')} data-settling={settling || undefined}
          role="group" aria-label={t('q.actsLabel')} tabIndex={-1} data-testid={`queue-acts-${batch.batchId}`}
          onFocus={() => { focusInside.current = true; }}
          onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget) focusInside.current = false; }}>
          {actions.map(action => {
            const spec = ACTION[action];
            // Settling and a running action keep the keyboard focus on the button (aria-disabled, activation ignored;
            // review rework 4b2): a native disabled would drop the focus to the page. No token is a lasting state: disabled.
            return <Button key={action} variant={spec.variant} icon={spec.icon} busy={busy === action} disabled={action === 'resume' && !hasToken}
              softDisabled={busy !== null || settling}
              title={action === 'pause' ? t('q.pauseTip') : action === 'resume' ? (hasToken ? t(halted ? 'q.resumeHaltedTip' : 'q.resumeTip') : t('q.resumeNoToken')) : undefined}
              data-testid={`queue-${action}-${batch.batchId}`} data-queue-action={action}
              onClick={() => press(action)}>{t(spec.label)}</Button>;
          })}
          {changed && <span className="qp-acts-changed" role="status" data-testid={`queue-state-changed-${batch.batchId}`}>{t('q.stateChanged', { status: t(STATUS_TEXT[batch.status] ?? 'q.s.queued') })}</span>}
        </div>
      </div>
      <dl className="qp-meta">
        <div><dt>{t('q.m.source')}</dt><dd><Dot tone={isAgentBatch(batch) ? 'agent' : 'neutral'} />{sourceLabel(batch, t)}</dd></div>
        <div><dt>{t('q.m.project')}</dt><dd data-testid={`queue-project-${batch.batchId}`} data-pending={!project && projectPending ? 'true' : undefined}>{project || (projectPending ? t('q.m.projectLoading') : t('c.none'))}</dd></div>
        <div><dt>{t('q.m.mode')}</dt><dd>{t(modeLabelKey(batch.mode))}</dd></div>
        <div><dt>{t('q.m.count')}</dt><dd className="qp-num">{batch.count}</dd></div>
        <div><dt>{t('q.m.interval')}</dt><dd className="qp-num">{t('q.m.sec', { n: batch.intervalSeconds })}</dd></div>
        <div><dt>{t('q.m.enqueued')}</dt><dd className="qp-num">{enqueuedText(batch.createdAt, lang)}</dd></div>
      </dl>
      <div className="qp-total">
        <Progress value={batch.count ? counts.succeeded / batch.count : 0} tone={progressTone(batch)} label={t('q.progressLabel', { done: counts.succeeded, total: batch.count })} />
        <span className="qp-num" data-testid={`queue-progress-${batch.batchId}`}>
          {t('q.progress', { done: counts.succeeded, total: batch.count })}
          {eta !== null && <> · {eta === 0 ? t('q.etaSoon') : t('q.eta', { n: eta })}</>}
        </span>
      </div>
    </header>
    <div className="qp-detail-body">
      {failure !== null && <p role="alert" className="qp-note qp-note--danger" data-testid={`queue-action-error-${batch.batchId}`}>
        <Icon name="alert" size={16} className="qp-note-ic" />
        <span className="qp-note-text">{hostErrorText(failure, language)}{failureCode && <code className="qp-code">{failureCode}</code>}</span>
      </p>}
      {closedNote && <p role="status" className="qp-note qp-note--neutral" data-testid={`queue-confirm-closed-${batch.batchId}`}>
        <Icon name="info" size={16} className="qp-note-ic" /><span className="qp-note-text">{t(closedNote === 'ended' ? 'q.confirmClosedEnded' : 'q.confirmClosedChanged')}</span>
      </p>}
      {actions.includes('resume') && !hasToken && <p role="status" className="qp-note qp-note--warn" data-testid={`queue-resume-token-${batch.batchId}`}>
        <Icon name="key" size={16} className="qp-note-ic" /><span className="qp-note-text">{t('q.resumeNoToken')}</span>
      </p>}
      {batchNotes(batch).map(note => <BatchNoteView key={note.kind} note={note} t={t} language={language} onCheck={openCheck} />)}
      <ItemGrid api={api} batch={batch} t={t} language={language} />
      <TechInfo batch={batch} t={t} />
    </div>
    <Dialog open={confirming === 'cancel'} onClose={() => { if (!busy) setConfirming(null); }} title={t('q.cancel.title')} tone="danger" icon="stop" busy={busy === 'cancel'}
      footer={<>
        <Button onClick={() => setConfirming(null)} disabled={busy === 'cancel'}>{t('q.cancel.keep')}</Button>
        <Button variant="danger" busy={busy === 'cancel'} disabled={isBatchTerminal(batch.status)} onClick={() => void run('cancel')} data-testid="queue-cancel-confirm">{t('q.cancel.confirm')}</Button>
      </>}>
      <ConfirmBatchLine batch={batch} t={t} />
      <CancelConfirmText batch={batch} t={t} />
    </Dialog>
    <Dialog open={confirming === 'resume'} onClose={() => { if (!busy) setConfirming(null); }} title={t('q.resumeHalted.title')} tone="warn" icon="play" busy={busy === 'resume'}
      footer={<>
        <Button onClick={() => setConfirming(null)} disabled={busy === 'resume'}>{t('q.resumeHalted.keep')}</Button>
        <Button variant="primary" busy={busy === 'resume'} disabled={!halted || !hasToken} onClick={() => void run('resume')} data-testid="queue-resume-confirm">{t('q.resumeHalted.confirm')}</Button>
      </>}>
      <ConfirmBatchLine batch={batch} t={t} />
      <ResumeHaltedText t={t} />
    </Dialog>
  </div>;
}

/** What resuming a batch the queue paused itself means: the stop protection is lifted for later agent batches. */
export function ResumeHaltedText({ t }: { t: UiText }) {
  return <div className="qp-confirm" data-testid="queue-resume-halted-text">
    <p className="qp-confirm-charge"><Icon name="alert" size={14} />{t('q.resumeHalted.body')}</p>
    <p>{t('q.resumeHalted.recipes')}</p>
  </div>;
}

/** Which batch a confirmation acts on: its name, source and a short batch id. */
export function ConfirmBatchLine({ batch, t }: { batch: QueueBatch; t: UiText }) {
  return <p className="qp-confirm-batch" data-testid="queue-confirm-batch">
    <b>{batchTitle(batch, t)}</b><span className="qp-sep" aria-hidden="true">·</span><span>{sourceLabel(batch, t)}</span><span className="qp-sep" aria-hidden="true">·</span>
    <code className="qp-code" title={batch.batchId}>{shortId(batch.batchId, 8, 4)}</code>
  </p>;
}

/** The cancel confirmation's text: what is skipped, and the possible charge only when an image is being generated. */
export function CancelConfirmText({ batch, t }: { batch: QueueBatch; t: UiText }) {
  const impact = cancelImpact(batch);
  return <div className="qp-confirm" data-testid="queue-cancel-text">
    <p>{impact.pending > 0 ? t('q.cancel.body', { n: impact.pending }) : t('q.cancel.bodyNone')}</p>
    {impact.inFlight && <p className="qp-confirm-charge" data-testid="queue-cancel-charged"><Icon name="alert" size={14} />{t('q.cancel.charged')}</p>}
  </div>;
}

const NOTE_ICON: Record<BatchNote['kind'], IconName> = {
  pause: 'info', paused: 'pause', queued: 'clock', cancelling: 'stop', halted: 'pause', error: 'alert', unknown: 'alert', failed: 'x',
};

/** One in-place note: what happened + what next, the raw code in small monospace after it. */
export function BatchNoteView({ note, t, language, onCheck }: { note: BatchNote; t: UiText; language: AppLanguage; onCheck?(): void }) {
  let text: ReactNode;
  switch (note.kind) {
    case 'pause': text = t('q.note.pause'); break;
    case 'paused': text = t('q.note.paused'); break;
    case 'queued': text = t('q.note.queued'); break;
    case 'cancelling': text = t('q.note.cancelling'); break;
    case 'halted': text = t('q.note.halted'); break;
    case 'unknown': text = t('q.note.unknown', { n: note.count ?? 0 }); break;
    case 'failed': {
      const reason = note.item?.error ? hostErrorText(note.item.error, language) : '';
      const upstream = upstreamText(note.item?.error, t, language);
      text = <>{t('q.note.failed', { n: note.count ?? 0 })}{reason && <> {t('q.note.failedFirst', { index: (note.item?.index ?? 0) + 1, reason })}</>}
        {upstream && <span className="qp-upstream" data-testid={`queue-upstream-${note.testId?.replace(/^queue-failed-/, '') ?? ''}`}>{upstream}</span>}</>;
      break;
    }
    case 'error': text = null; break;
  }
  return <NoteBody note={note} text={text} language={language} onCheck={note.kind === 'unknown' ? onCheck : undefined} t={t} />;
}
function NoteBody({ note, text, language, onCheck, t }: { note: BatchNote; text: ReactNode; language: AppLanguage; onCheck?(): void; t: UiText }) {
  const shown = note.kind === 'error' ? hostErrorText(note.error, language) : text;
  const role = note.tone === 'danger' || note.tone === 'warn' ? 'alert' : 'status';
  return <div role={note.kind === 'pause' || note.kind === 'queued' ? 'note' : role} className={clsx('qp-note', `qp-note--${note.tone}`)} data-testid={note.testId} data-note={note.kind}>
    <Icon name={NOTE_ICON[note.kind]} size={16} className="qp-note-ic" />
    <span className="qp-note-text">{shown}{note.code && <code className="qp-code">{note.code}</code>}</span>
    {onCheck && <Button size="sm" variant="ghost" onClick={onCheck}>{t('q.note.check')}</Button>}
  </div>;
}
const TECH_ITEMS_SHOWN = 20;
/** 技术信息 (collapsed): ids and hashes for pasting to an agent or an issue, each copied in one click. */
export function TechInfo({ batch, t }: { batch: QueueBatch; t: UiText }) {
  const [all, setAll] = useState(false);
  const items = all ? batch.items : batch.items.slice(0, TECH_ITEMS_SHOWN);
  return <Disclosure className="qp-tech" summary={t('c.tech')}>
    <dl className="qp-tech-list">
      <TechRow label={t('q.tech.batch')} value={batch.batchId} t={t} />
      {batch.requestKey && <TechRow label={t('q.tech.request')} value={batch.requestKey} t={t} />}
      {batch.recipePlanHash && <TechRow label={t('q.tech.plan')} value={batch.recipePlanHash} t={t} />}
      <TechRow label={t('q.m.mode')} value={batch.mode} t={t} copy={false} />
    </dl>
    <div className="qp-tech-items">
      <div className="qp-tech-items-h"><span>{t('q.tech.items')}</span><CopyButton value={itemsTsv(batch)} label={t('q.tech.copyAll')} t={t} text /></div>
      <table className="qp-tech-table">
        <thead><tr><th>#</th><th>{t('q.tech.job')}</th><th>{t('q.tech.seed')}</th></tr></thead>
        <tbody>{items.map(item => <tr key={item.index}>
          <td className="qp-num">{item.index + 1}</td>
          <td className="ui-mono" title={item.jobId ?? undefined}>{item.jobId ? shortId(item.jobId) : '—'}</td>
          <td className="ui-mono">{item.actualSeed ?? item.plannedSeed ?? '—'}</td>
        </tr>)}</tbody>
      </table>
      {!all && batch.items.length > TECH_ITEMS_SHOWN && <Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t('q.tech.showAll', { n: batch.items.length })}</Button>}
    </div>
  </Disclosure>;
}
function TechRow({ label, value, t, copy = true }: { label: string; value: string; t: UiText; copy?: boolean }) {
  return <div className="qp-tech-row"><dt>{label}</dt><dd><code className="ui-mono" title={value}>{shortId(value, 18, 8)}</code>{copy && <CopyButton value={value} label={t('c.copy')} t={t} />}</dd></div>;
}

/** Copies one value; says so in place, and says when the clipboard refused. */
export function CopyButton({ value, label, t, text = false }: { value: string; label: string; t: UiText; text?: boolean }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) throw new Error('clipboard');
      await navigator.clipboard.writeText(value);
      setState('ok');
    } catch { setState('fail'); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1800);
  };
  return <span className="qp-copy">
    {text ? <Button size="sm" variant="ghost" icon="copy" onClick={() => void copy()}>{label}</Button> : <IconButton size="sm" icon={state === 'ok' ? 'check' : 'copy'} label={label} onClick={() => void copy()} />}
    {state === 'ok' && <span className="qp-copy-msg" role="status">{t('c.copied')}</span>}
    {state === 'fail' && <span className="qp-copy-msg is-fail" role="alert">{t('q.tech.copyFailed')}</span>}
  </span>;
}
