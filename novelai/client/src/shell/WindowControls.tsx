import { Icon } from '../ui';
import { useUiText } from '../ui/i18n';

/**
 * Minimize, maximize and close of the frameless window (frame:false): in the top bar, and in the first-run guide,
 * which covers the top bar (step 4c1; its error card leaves the top bar visible, so both keep these buttons).
 */
export function WindowControls() {
  const { t } = useUiText();
  return <div className="as-winctl" data-testid="window-controls">
    <button type="button" aria-label={t('win.min')} title={t('win.min')} onClick={() => window.naiDesktop.minimize()}><Icon name="minimize" size={14} /></button>
    <button type="button" aria-label={t('win.max')} title={t('win.max')} onClick={() => window.naiDesktop.maximize()}><Icon name="maximize" size={14} /></button>
    <button type="button" aria-label={t('win.close')} title={t('win.close')} className="is-close" onClick={() => window.naiDesktop.close()}><Icon name="x" size={14} /></button>
  </div>;
}
