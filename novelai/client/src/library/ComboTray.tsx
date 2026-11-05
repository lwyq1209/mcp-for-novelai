import { useState } from 'react';
import clsx from 'clsx';
import type { AssetItem } from '../asset-library/types';
import { libraryErrorText } from './errors';
import { Button, Icon, IconButton, showToast } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import { useAppStore } from '../store';
import type { MaterialComponent, MaterialEntry } from '../workspace/material-library-types';
import { componentsFromEntry } from '../workspace/material-library-ui';
import { planCombo, readComboFields, writeComboFields, type ComboRefusal } from '../canvas/combo-apply';
import { showStepToast } from '../canvas/guarded-undo';
import { NameDialog } from './dialogs';
import { createItem } from './MaterialDetail';
import type { LibraryApi } from './api';

/** Members a tag or combo adds to the tray (the same rule as the existing combo tray). */
export function trayMembersOf(item: AssetItem): MaterialComponent[] {
  if (item.kind !== 'tag' && item.kind !== 'combo') return [];
  return componentsFromEntry({ ...(item.payload as MaterialEntry), id: item.id, revision: item.revision });
}

/**
 * 应用到画布 (prototype 09): the members by their use, the old composer's rules (canvas/combo-apply.ts): Style members
 * replace the canvas Style as a whole (none: Style stays byte for byte), base members are appended to the positive
 * prompt, character members to the character the user chose (step 4b3 review rework; it was always the first one).
 * Nothing is generated. Returns the refusal, or null when it was applied (with an undo in the toast).
 */
export function applyTrayToCanvas(members: readonly MaterialComponent[], characterId: string | null, t: UiText): ComboRefusal | null {
  const plan = planCombo(members, 'base', characterId);
  if (!plan.ok) return plan.refusal;
  const used = members.some(member => member.target === 'character') ? characterId : null;
  writeComboFields('base', used, plan.after);
  showStepToast(t, t('tray.applied'), { read: () => readComboFields('base', used), after: plan.after, restore: () => writeComboFields('base', used, plan.before) });
  return null;
}

/** The tray's own words for two refusals (the canvas's for the rest). */
const REFUSAL_TEXT: Partial<Record<ComboRefusal, 'tray.styleLocked' | 'tray.noCharacter' | 'tray.pickCharacter'>> = { 'cv.combo.styleLocked': 'tray.styleLocked', 'cv.combo.noChars': 'tray.noCharacter', 'cv.combo.pickChar': 'tray.pickCharacter' };

const targetLabel = (t: UiText, target: MaterialComponent['target']) => t(`tag.target.${target}`);

export function ComboTray({ api, members, onChange, onApplied }: { api: LibraryApi; members: MaterialComponent[]; onChange(members: MaterialComponent[]): void; onApplied(): void }) {
  const { t, lang } = useUiText();
  const [saving, setSaving] = useState(false);
  const captions = useAppStore(state => state.charCaptions);
  const hasCharacterMembers = members.some(member => member.target === 'character');
  // Which character gets the character members: the only one, else the user picks one.
  const [characterId, setCharacterId] = useState('');
  const chosen = captions.some(caption => caption.id === characterId) ? characterId : captions.length === 1 ? captions[0].id : '';
  const apply = () => {
    try {
      const refusal = applyTrayToCanvas(members, chosen || null, t);
      if (refusal) { showToast({ message: t(REFUSAL_TEXT[refusal] ?? refusal), tone: 'warn' }); return; }
      onApplied();
    } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); }
  };
  const weight = (index: number, value: number) => onChange(members.map((member, i) => i === index ? { ...member, weight: Math.round(Math.max(0, Math.min(10, value)) * 100) / 100 } : member));
  return <div className="lib-tray" role="region" aria-label={t('tray.title')} data-testid="combo-tray">
    <div className="lib-tray-row">
      <span className="lib-tray-title"><Icon name="combo" size={16} />{t('tray.title')}<span className="lib-tray-n ui-num">{members.length}</span></span>
      <div className="lib-tray-items">{members.map((member, index) => <span key={`${index}-${member.text}`} className="lib-tray-item">
        <span className="ui-mono">{member.text}</span>
        <input className="lib-tray-w ui-num" type="number" min={0} max={10} step={0.1} value={member.weight} aria-label={t('tray.weightOf', { name: member.text })} onChange={event => weight(index, Number(event.target.value))} />
        <small>{targetLabel(t, member.target)}</small>
        <button type="button" className="lib-tray-x" aria-label={t('tray.remove', { name: member.text })} onClick={() => onChange(members.filter((_, i) => i !== index))}><Icon name="x" size={12} /></button>
      </span>)}</div>
    </div>
    {hasCharacterMembers && captions.length > 1 && <div className="lib-tray-row lib-tray-chars" role="radiogroup" aria-label={t('cv.combo.charsTo')} data-testid="tray-chars">
      <span className="lib-tray-hint">{t('cv.combo.charsTo')}</span>
      {captions.map((caption, index) => <button key={caption.id} type="button" role="radio" aria-checked={chosen === caption.id} className={clsx('ui-chip', chosen === caption.id && 'ui-chip--on')} title={caption.prompt} onClick={() => setCharacterId(caption.id)} data-testid={`tray-char-${index + 1}`}>{t('cv.char.n', { n: index + 1 })}</button>)}
    </div>}
    <div className="lib-tray-row">
      <span className="lib-tray-hint">{t('tray.hint')}</span>
      <div className="lib-toolbar-gap" />
      <Button size="sm" variant="ghost" onClick={() => onChange([])}>{t('tray.clear')}</Button>
      <Button size="sm" onClick={() => setSaving(true)}>{t('tray.save')}</Button>
      <Button size="sm" variant="primary" icon="canvas" onClick={apply}>{t('tray.apply')}</Button>
      <IconButton size="sm" icon="x" label={t('c.close')} onClick={() => onChange([])} className="lib-tray-close" />
    </div>
    {saving && <NameDialog title={t('tray.save')} label={t('tray.comboName')} confirmLabel={t('c.save')} onClose={() => setSaving(false)} onSubmit={async name => {
      await createItem(api, 'combo', { name, components: members });
      setSaving(false); showToast({ message: t('tray.saved', { name }), tone: 'ok' });
    }} />}
  </div>;
}
