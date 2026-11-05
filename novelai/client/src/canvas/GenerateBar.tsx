import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Icon, Tooltip } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import { useAppStore } from '../store';
import { useQueueView } from '../workspace/queue-monitor';
import { imagesAhead } from '../workspace/manual-batches';
import { navigate } from '../shell/route';
import type { AnlasQuoteFeature, AnlasQuoteResult } from '../types';
import { useAnlasQuote } from './anlas-quote';
import { NumberField } from './controls';

const MAX_COUNT = 999;
/**
 * After a click the button rests this long: a double click (or a key repeat) is one click. The store already ignores a
 * click while the previous one is being prepared; with a fast service the first batch can be queued before the second
 * click of a double click arrives, and that second click would queue a second (paid) batch.
 */
export const CLICK_REST_MS = 800;

/** The cost on the button: a quote of 0 is free, an estimate reads "≈ n", an official quote reads "n". */
export function costText(t: UiText, quote: AnlasQuoteResult | null, loading: boolean) {
  if (quote?.ok && typeof quote.amount === 'number') {
    if (quote.amount === 0) return t('cv.gen.free');
    return quote.source === 'estimate-formula' || quote.source === 'estimate-fixed' ? t('cv.gen.cost', { n: quote.amount }) : t('cv.gen.costExact', { n: quote.amount });
  }
  if (loading) return t('cv.gen.costLoading');
  if (quote?.reason === 'missing-image') return t('cv.gen.noImage');
  if (quote?.reason === 'missing-params') return t('cv.gen.badParams');
  if (quote?.reason === 'image-too-large') return t('cv.gen.tooLarge');
  return t('cv.gen.costUnknown');
}

/**
 * The generate bar at the bottom of the left column (prototype 13, 16): the number of images, the button with the
 * estimated cost, and the queue around it. A click is the 4a manual path (the store's generate / generateI2I …:
 * balance and quote, then one manual batch under one new request key; a click while one is being prepared does
 * nothing). When images are ahead in the shared queue the button reads 加入队列 and says how many run first; this
 * canvas's running batch can be paused or stopped here.
 */
export function GenerateBar({ feature, label, onRun, disabled = false, disabledReason = '', showCount = true }: {
  feature: AnlasQuoteFeature; label?: string; onRun(): void; disabled?: boolean; disabledReason?: string; showCount?: boolean;
}) {
  const { t } = useUiText();
  const account = useAppStore(state => state.account);
  const count = useAppStore(state => state.batchCount);
  const setCount = useAppStore(state => state.setBatchCount);
  const preparing = useAppStore(state => state.manualPreparing);
  const batches = useAppStore(state => state.manualBatches);
  const activeId = useAppStore(state => state.activeGenerationRunId);
  const spent = useAppStore(state => state.currentAnlasSpent);
  const isGenerating = useAppStore(state => state.isGenerating);
  const togglePause = useAppStore(state => state.togglePause);
  const cancel = useAppStore(state => state.cancel);
  const view = useQueueView();
  const ahead = imagesAhead(view.batches);
  const { quote, loading } = useAnlasQuote(feature);
  const lastClick = useRef(0);
  const [resting, setResting] = useState(false);
  // A click the rest swallows is acknowledged on the button (已收到) until the rest ends: it was seen, not lost.
  const [swallowed, setSwallowed] = useState(false);
  useEffect(() => {
    if (!resting) return;
    const timer = window.setTimeout(() => { setResting(false); setSwallowed(false); }, Math.max(0, CLICK_REST_MS - (Date.now() - lastClick.current)));
    return () => window.clearTimeout(timer);
  }, [resting]);
  const run = () => {
    const now = Date.now();
    if (now - lastClick.current < CLICK_REST_MS) { setSwallowed(true); return; }
    if (preparing) return;
    lastClick.current = now;
    setResting(true);
    onRun();
  };
  const current = batches.find(batch => batch.batchId === activeId) ?? batches[0];
  const others = batches.filter(batch => batch !== current).reduce((sum, batch) => sum + batch.count - batch.done - batch.failed, 0);
  const balance = account.anlasBalance ?? t('c.unknown');
  const estimate = quote?.source === 'estimate-formula' || quote?.source === 'estimate-fixed';
  const tip = `${quote?.ok && typeof quote.amount === 'number' ? t(estimate ? 'cv.gen.costTip.estimate' : 'cv.gen.costTip.official', { b: balance }) : t('cv.gen.costTip.none', { b: balance })}${quote?.insufficient ? ` · ${t('cv.gen.insufficient')}` : ''}`;
  const buttonLabel = swallowed && resting ? t('cv.gen.received') : preparing ? t('cv.gen.preparing') : ahead > 0 ? t('cv.gen.enqueue') : label ?? t('cv.gen');

  return <div className="cv-genbar" data-testid="cv-genbar">
    {current && <div className="cv-gnote cv-gnote--run" data-testid="cv-manual-status">
      <span className={clsx('cv-dot', current.status === 'running' && 'is-live')} />
      <span className="cv-grow">{t(current.status === 'paused' ? 'cv.gen.paused' : current.status === 'queued' ? 'cv.gen.waiting' : 'cv.gen.running', { done: current.done + current.failed, total: current.count })}
        {others > 0 ? ` · ${t('cv.gen.more1', { n: others })}` : ''}{isGenerating && spent != null ? ` · ${t('cv.gen.spent', { n: spent })}` : ''}</span>
      <button type="button" className="cv-hact" onClick={() => void togglePause()} data-testid="cv-manual-pause"><Icon name={current.status === 'paused' ? 'play' : 'pause'} size={12} />{t(current.status === 'paused' ? 'cv.gen.resume' : 'cv.gen.pause')}</button>
      <button type="button" className="cv-hact cv-hact--danger" title={t('cv.gen.stopTip')} onClick={() => void cancel()} data-testid="cv-manual-stop"><Icon name="stop" size={12} />{t('cv.gen.stop')}</button>
    </div>}
    {ahead > 0 && <div className="cv-gnote" data-testid="cv-queue-ahead">
      <span className="cv-dot is-live" /><span className="cv-grow">{t('cv.gen.ahead', { n: ahead })}</span>
      <button type="button" className="cv-link" onClick={() => navigate('queue')}>{t('cv.gen.queueLink')} →</button>
    </div>}
    {disabled && disabledReason && <div className="cv-gnote cv-gnote--warn">{disabledReason}</div>}
    <div className="cv-gn">
      {showCount && <div className="cv-stepper" role="group" aria-label={t('cv.gen.countLabel')}>
        <button type="button" aria-label={t('cv.gen.fewer')} disabled={count <= 1} onClick={() => setCount(count - 1)}><Icon name="minus" size={14} /></button>
        <NumberField className="cv-stepper-num" label={t('cv.gen.countLabel')} value={count} min={1} max={MAX_COUNT} normalize={value => Math.max(1, Math.min(MAX_COUNT, Math.round(value)))} onCommit={setCount} />
        <button type="button" aria-label={t('cv.gen.more')} disabled={count >= MAX_COUNT} onClick={() => setCount(count + 1)}><Icon name="plus" size={14} /></button>
      </div>}
      {account.hasToken
        ? <Tooltip content={tip}><button type="button" className={clsx('cv-genbtn', resting && 'is-resting', swallowed && resting && 'is-received')} data-testid="cv-generate" disabled={disabled || preparing} aria-busy={preparing || undefined} aria-disabled={resting || undefined}
          data-quote-amount={quote?.ok && typeof quote.amount === 'number' ? quote.amount : ''} data-quote-source={quote?.source ?? ''} data-ahead={ahead}
          onClick={run}>
          <Icon name="sparkle" size={17} /><span>{buttonLabel}</span><small data-testid="cv-cost">{costText(t, quote, loading)}</small>
        </button></Tooltip>
        : <button type="button" className="cv-genbtn" data-testid="cv-connect" onClick={() => navigate('settings', 'account')}><Icon name="key" size={16} /><span>{t('cv.gen.connect')}</span></button>}
    </div>
  </div>;
}
