import { useEffect, useState } from 'react';
import { Button, ConfirmDialog, Icon, Seg, Toggle } from '../../ui';
import { formatNumber, useUiText } from '../../ui/i18n';
import { QUEUE_ENQUEUE_ITEMS, QUEUE_PENDING_ITEMS, QUEUE_RETENTION_DAYS, normalizeQueueRetentionDays } from '../../queue-limits';
import type { AppSettings, QueueRecordsRepairPlan, QueueRetentionStatus } from '../../types';
import { queueRetentionCall, useQueueRetention } from '../../queue/retention';
import { InlineNote, NumberField, SettingsBlock, SettingsGroup, SettingsRow, isSettingsCapture, saveSetting, settingErrorText, useSettings } from './common';

type QueueKey = 'queueMaxItemsPerEnqueue' | 'queueMaxPendingItems' | 'queueRetentionDays';
export type KeepChoice = '7' | '30' | '90' | 'never';
const PROBLEMS = ['records_missing', 'chain_broken', 'anchor_missing', 'anchor_invalid', 'anchor_mismatch', 'torn_unverified', 'read_failed'] as const;
const SKIPS = ['frozen_queue_unreadable', 'cleaned_records_unreadable'] as const;

/** Which retention lines Settings › Queue shows for a host status (broken records first; a skipped or partial last run). */
export function queueRetentionNotes(status: QueueRetentionStatus | null, cleaning = false) {
  const broken = status?.records?.state === 'broken';
  const problem = !broken ? null : status?.records?.problem && (PROBLEMS as readonly string[]).includes(status.records.problem) ? status.records.problem : 'read_failed';
  const skip = status?.lastRun?.skipped;
  return {
    broken, problem,
    cleaning: !broken && (cleaning || !!status?.running),
    cleaned: !broken && !(cleaning || status?.running) && (status?.cleanedBatches ?? 0) > 0 ? status!.cleanedBatches : 0,
    recovered: !broken && (status?.recoveredFromLibrary ?? 0) > 0 ? status!.recoveredFromLibrary! : 0,
    skipped: !broken && skip && (SKIPS as readonly string[]).includes(skip) ? skip : null,
    invalid: status?.lastRun?.invalid ?? 0,
  };
}
/** A choice that keeps fewer days than now (or any number of days after forever) is previewed and confirmed first. */
export function retentionShortens(current: number | null, next: KeepChoice) {
  return next !== 'never' && (current === null || Number(next) < current);
}

/**
 * Settings › Queue (prototype 25): the two queue safety limits (the old QueueSafetySettings: same ranges, rounding and
 * an in-place error when a value is refused), how long ended batches are kept (queue retention) and the fixed rules.
 */
export function QueueSection() {
  const { t, lang, language } = useUiText();
  const settings = useSettings();
  const [error, setError] = useState('');
  const save = async <K extends QueueKey>(key: K, value: AppSettings[K]) => {
    setError('');
    try { await saveSetting(key, value); }
    catch (reason) { setError(t('set.saveFailed', { reason: settingErrorText(reason, language) })); }
  };
  const unlimited = settings?.queueMaxPendingItems === null;
  const [retention, setRetention] = useQueueRetention(!isSettingsCapture()), [cleaning, setCleaning] = useState(false);
  useEffect(() => { if (retention && !retention.running) setCleaning(false); }, [retention]);
  const keepDays = settings ? normalizeQueueRetentionDays(settings.queueRetentionDays) : QUEUE_RETENTION_DAYS.default;
  const keep: KeepChoice = keepDays === null ? 'never' : String(keepDays) as KeepChoice;
  // A shorter period that cleans at least one batch at once is confirmed first, with the host's own count.
  // batches null: the host could not work the count out (the change is still confirmed first; cancel changes nothing).
  const [shorten, setShorten] = useState<{ days: number; batches: number | null } | null>(null);
  const apply = (next: KeepChoice) => {
    // Changing the period cleans at once (the host runs a cleaning when the setting changes).
    if (next !== 'never') setCleaning(true);
    void save('queueRetentionDays', next === 'never' ? null : Number(next));
  };
  const chooseKeep = async (next: KeepChoice) => {
    if (next === keep) return;
    if (retentionShortens(keepDays, next)) {
      const preview = await queueRetentionCall<{ batches: number }>({ action: 'preview', days: Number(next) }).catch(() => null);
      if (!preview || !Number.isSafeInteger(preview.batches)) { setShorten({ days: Number(next), batches: null }); return; }
      if (preview.batches > 0) { setShorten({ days: Number(next), batches: preview.batches }); return; }
    }
    apply(next);
  };
  const notes = queueRetentionNotes(retention, cleaning), { broken, skipped, invalid } = notes;
  // The knowing repair of damaged records: its plan (what is lost, what the library recovers) is shown before it runs.
  const [repair, setRepair] = useState<QueueRecordsRepairPlan | null>(null), [repairing, setRepairing] = useState(false), [repairError, setRepairError] = useState('');
  const openRepair = async () => { setRepairError(''); try { const plan = await queueRetentionCall<QueueRecordsRepairPlan>({ action: 'repairPlan' }); if (plan?.needed) setRepair(plan); } catch (reason) { setRepairError(settingErrorText(reason, language)); } };
  const runRepair = async () => {
    if (!repair) return; setRepairing(true);
    try {
      const result = await queueRetentionCall<{ repaired: boolean; reason?: string; plan: QueueRecordsRepairPlan }>({ action: 'repair', confirm: { lost: repair.lost, recoverable: repair.recoverable } });
      // The plan changed meanwhile: show the new one instead of repairing what was not confirmed.
      if (result && !result.repaired && result.reason === 'plan_changed') { setRepair(result.plan); return; }
      setRepair(null);
      const status = await queueRetentionCall<any>(); if (status) setRetention(status);
    } catch (reason) { setRepairError(settingErrorText(reason, language)); setRepair(null); }
    finally { setRepairing(false); }
  };
  const problem = notes.problem ?? 'read_failed';
  return <section className="sp-section" data-testid="settings-queue">
    <h2>{t('set.queue')}</h2>
    {settings ? <SettingsGroup title={t('set.q.title')} icon="alert">
      <SettingsBlock className="sp-intro"><span>{t('set.q.intro')}</span></SettingsBlock>
      <SettingsRow label={t('set.q.per')} hint={t('set.q.perHint', { min: formatNumber(QUEUE_ENQUEUE_ITEMS.min, lang), max: formatNumber(QUEUE_ENQUEUE_ITEMS.max, lang), def: formatNumber(QUEUE_ENQUEUE_ITEMS.default, lang) })}>
        <NumberField value={settings.queueMaxItemsPerEnqueue} min={QUEUE_ENQUEUE_ITEMS.min} max={QUEUE_ENQUEUE_ITEMS.max} label={t('set.q.per')} unit={t('set.q.unit')} testId="queue-per"
          onCommit={value => void save('queueMaxItemsPerEnqueue', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.q.pending')} hint={t('set.q.pendingHint', { def: formatNumber(QUEUE_PENDING_ITEMS.default, lang) })}>
        <label className="sp-toggle-line"><Toggle checked={unlimited} label={t('set.q.unlimited')} onChange={value => void save('queueMaxPendingItems', value ? null : QUEUE_PENDING_ITEMS.default)} /><span>{t('set.q.unlimited')}</span></label>
        <NumberField value={settings.queueMaxPendingItems ?? QUEUE_PENDING_ITEMS.default} min={QUEUE_PENDING_ITEMS.min} max={QUEUE_PENDING_ITEMS.max} disabled={unlimited} label={t('set.q.pending')} unit={t('set.q.unit')} testId="queue-pending"
          onCommit={value => void save('queueMaxPendingItems', value)} />
      </SettingsRow>
      {error ? <SettingsBlock><InlineNote tone="danger" icon="alert" testId="queue-error">{error}</InlineNote></SettingsBlock> : null}
    </SettingsGroup> : null}
    {settings ? <SettingsGroup title={t('set.q.keep')} icon="archive" testId="queue-retention">
      <SettingsRow label={t('set.q.keepFor')} hint={t('set.q.keepHint')}>
        <Seg label={t('set.q.keepFor')} value={keep} onChange={chooseKeep} options={[
          ...QUEUE_RETENTION_DAYS.choices.map(days => ({ value: String(days) as KeepChoice, label: t('set.q.keepDays', { n: days }) })),
          { value: 'never' as KeepChoice, label: t('set.q.keepNever') },
        ]} />
      </SettingsRow>
      {broken ? <SettingsBlock>
        <InlineNote tone="danger" icon="alert" testId="queue-records-broken">{t('set.q.recordsBroken', { problem: t(`set.q.problem.${problem}` as any) })}</InlineNote>
        <div className="sp-faint" data-testid="queue-records-restore">{t('set.q.recordsRestore')}</div>
        <div><Button variant="default" size="sm" onClick={() => void openRepair()} data-testid="queue-records-repair">{t('set.q.repair')}</Button></div>
        {repairError ? <InlineNote tone="danger" icon="alert">{repairError}</InlineNote> : null}
      </SettingsBlock> : null}
      {notes.cleaning ? <SettingsBlock><InlineNote icon="refresh" testId="queue-retention-status">{t('set.q.cleaning')}</InlineNote></SettingsBlock>
        : notes.cleaned > 0 ? <SettingsBlock><InlineNote icon="check" testId="queue-retention-status">{t('set.q.cleaned', { n: notes.cleaned })}</InlineNote></SettingsBlock> : null}
      {notes.recovered > 0 ? <SettingsBlock><InlineNote icon="info" testId="queue-retention-recovered">{t('set.q.recovered', { n: notes.recovered })}</InlineNote></SettingsBlock> : null}
      {skipped ? <SettingsBlock><InlineNote tone="warn" icon="alert" testId="queue-retention-skipped">{t('set.q.lastSkipped', { reason: t(`set.q.skip.${skipped}` as any) })}</InlineNote></SettingsBlock> : null}
      {invalid > 0 ? <SettingsBlock><InlineNote tone="warn" icon="alert" testId="queue-retention-invalid">{t('set.q.invalid', { n: invalid })}</InlineNote></SettingsBlock> : null}
    </SettingsGroup> : null}
    <ConfirmDialog open={!!shorten} tone="danger" icon="trash"
      title={!shorten ? '' : shorten.batches === null ? t('set.q.shortenUnknownTitle', { days: shorten.days }) : t('set.q.shortenTitle', { n: shorten.batches })}
      description={!shorten ? undefined : shorten.batches === null ? t('set.q.shortenUnknownBody', { days: shorten.days }) : t('set.q.shortenBody', { days: shorten.days })}
      confirmLabel={shorten?.batches === null ? t('set.q.shortenUnknownConfirm', { days: shorten.days }) : t('set.q.shortenConfirm')} cancelLabel={t('c.cancel')} onCancel={() => setShorten(null)} onConfirm={() => { const next = shorten; setShorten(null); if (next) apply(String(next.days) as KeepChoice); }} />
    <ConfirmDialog open={!!repair} tone="danger" icon="alert" title={t('set.q.repairTitle')} busy={repairing}
      description={repair ? repair.lost === null ? t('set.q.repairBodyUnknown', { recovered: repair.recoverable }) : t('set.q.repairBody', { lost: repair.lost, recovered: repair.recoverable }) : undefined}
      confirmLabel={t('set.q.repairConfirm')} cancelLabel={t('c.cancel')} onCancel={() => setRepair(null)} onConfirm={() => void runRepair()} />
    <SettingsGroup title={t('set.q.rules')} icon="lock">
      <SettingsBlock className="sp-rules">
        <div><Icon name="play" size={14} /><span>{t('set.q.r1')}</span></div>
        <div><Icon name="refresh" size={14} /><span>{t('set.q.r2')}</span></div>
        <div><Icon name="drive" size={14} /><span>{t('set.q.r3')}</span></div>
      </SettingsBlock>
    </SettingsGroup>
  </section>;
}
