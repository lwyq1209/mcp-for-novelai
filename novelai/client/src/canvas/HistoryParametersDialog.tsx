import { useRef, useState } from 'react';
import { hostErrorText } from '../host-errors';
import type { AppLanguage, HistoryItem } from '../types';
import { historyRecoveryIsBusy, useAppStore } from '../store';
import { applyHistoryParameters, historyPlanIsStale, historyText, historyTextList, planHistoryParameters, type HistoryParameterPlan, type HistoryParameterError } from '../history-parameters';
import { Button, Dialog, Icon } from '../ui';
import { useUiText, type UiLang, type UiText } from '../ui/i18n';
import './dialogs.css';

const display = (value: unknown, t: UiText) => value === undefined ? t('hp.notSaved') : typeof value === 'boolean' ? value ? t('hp.on') : t('hp.off') : typeof value === 'object' ? JSON.stringify(value, null, 2) : value === '' ? t('hp.empty') : String(value);

/** An apply error: ours carry their copy key; any other (from the store or the host) renders through hostErrorText. */
export function historyApplyErrorText(error: unknown, t: UiText, language: AppLanguage) {
  const { uiKey, uiParams } = (error ?? {}) as Partial<HistoryParameterError>;
  return uiKey ? t(uiKey, uiParams) : hostErrorText(error, language, t('hp.applyFailed'));
}

/** The dialog content without the dialog itself, so it can be rendered on its own. */
export function HistoryParametersContent({ item, plan, lang, t, characters, vibes, references, source, mask }: {
  item: HistoryItem; plan: HistoryParameterPlan; lang: UiLang; t: UiText;
  characters: number; vibes: number; references: number; source: boolean; mask: boolean;
}) {
  const charactersText = plan.characters === undefined ? t('hp.charsLegacy', { n: characters }) : t('hp.charsReplace', { n: plan.characters.length });
  const keptText = t('hp.kept', { vibes, references, source: t(source ? 'hp.hasSource' : 'hp.noSource'), mask: t(mask ? 'hp.hasMask' : 'hp.noMask') });
  return <>
    <p className="hp-source ui-muted">{t('hp.source', { name: item.filePath.split(/[\\/]/).pop() || item.id })}</p>
    <div className="hp-warn" role="note">
      <strong><Icon name="info" size={14} />{t('hp.warnTitle')}</strong>
      <p>{[charactersText, keptText].join(lang === 'zh' ? '' : ' ')}</p>
      <p>{historyText(lang, plan.modeNotice)}</p>
    </div>
    {plan.blocked ? <p className="hp-alert" role="alert">{historyText(lang, plan.blocked)}</p> : <>
      <p className="hp-seed"><strong>{t('hp.seed', { seed: plan.actualSeed === null ? t('hp.seedNone') : String(plan.actualSeed) })}</strong>{plan.actualSeed !== null && <span className="ui-muted">{t('hp.seedFixedNote')}</span>}</p>
      {!!plan.missing.length && <p className="hp-note" role="note">{t('hp.missing', { names: historyTextList(lang, plan.missing) })}</p>}
      {!!plan.invalid.length && <p className="hp-alert" role="alert">{t('hp.invalid', { names: historyTextList(lang, plan.invalid) })}</p>}
      {plan.characters !== undefined && <section className="hp-chars" aria-label={t('hp.charsSection')}><h3>{t('hp.charsHeading')}</h3>{plan.characters.length === 0 ? <p className="ui-muted">{t('hp.charsEmpty')}</p> : plan.characters.map((caption, index) => <div className="hp-char" key={index}>
        <h4>{t('hp.character', { index: String(index + 1) })}</h4>
        <p className="hp-label">{t('hp.positive')}</p><pre className="ui-mono">{display(caption.prompt, t)}</pre>
        <p className="hp-label">{t('hp.negative')}</p><pre className="ui-mono">{display(caption.negativePrompt, t)}</pre>
        <p className="ui-muted">{t('hp.coords', { state: t(caption.useCoords ? 'hp.on' : 'hp.off'), x: String(caption.x), y: String(caption.y) })}</p>
      </div>)}</section>}
      <table className="hp-table"><thead><tr><th>{t('hp.colParam')}</th><th>{t('hp.colSaved')}</th><th>{t('hp.colApplied')}</th></tr></thead><tbody>{plan.fields.map(field => <tr key={field.key}><th scope="row">{historyText(lang, field.label)}</th><td><pre>{display(field.saved, t)}</pre></td><td><pre>{display(field.applied, t)}</pre></td></tr>)}</tbody></table>
      <p className="hp-note ui-faint">{t('hp.tableNote')}</p>
    </>}
  </>;
}

/**
 * 读取已存参数 / 套用提示词和参数 (step 4c2 rebuild of the 4c1 dialog): what restoring a history record's saved
 * parameters changes, and the apply. The plan is made once when the dialog opens; a later edit of the parameters or
 * characters (stale), a running generation or a blocked plan keeps the apply off.
 */
export function HistoryParametersDialog({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  const { t, lang, language } = useUiText();
  const params = useAppStore(state => state.params);
  const isGenerating = useAppStore(historyRecoveryIsBusy);
  const characters = useAppStore(state => state.charCaptions);
  const vibes = useAppStore(state => state.vibeImages.length);
  const references = useAppStore(state => state.preciseReferences.length);
  const source = useAppStore(state => state.workbenchImage);
  const mask = useAppStore(state => !!state.inpaintMask);
  const [plan] = useState(() => planHistoryParameters(item, params, characters));
  // The error itself, rendered when shown, so a language switch re-renders it.
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const stale = historyPlanIsStale(plan, params, characters);
  const apply = () => {
    setBusy(true); setError(null);
    void applyHistoryParameters(plan).then(onClose).catch(failure => { setError(failure ?? new Error('')); setBusy(false); });
  };
  return <Dialog open onClose={onClose} busy={busy} icon="history" width={840} title={t('hp.title')} initialFocusRef={cancelRef}
    footer={<><Button ref={cancelRef} onClick={onClose} disabled={busy}>{t('hp.cancel')}</Button><Button variant="primary" busy={busy} disabled={!!plan.blocked || stale || isGenerating} onClick={apply} data-testid="hp-apply">{t('hp.apply')}</Button></>}>
    <div className="hp-body" data-testid="history-parameters">
      <HistoryParametersContent item={item} plan={plan} lang={lang} t={t} characters={characters.length} vibes={vibes} references={references} source={!!source} mask={mask} />
      {stale && <p className="hp-alert" role="alert">{t('hp.stale')}</p>}
      {isGenerating && <p className="hp-note" role="status">{t('hp.generating')}</p>}
      {error !== null && <p className="hp-alert" role="alert">{historyApplyErrorText(error, t, language)}</p>}
    </div>
  </Dialog>;
}
