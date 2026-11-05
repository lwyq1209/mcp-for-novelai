import { useEffect, useId, useRef, useState } from 'react';
import { hostMessageText } from '../host-errors/compose';
import { catalogGroupName } from '../reference-preset-names';
import { useAppStore } from '../store';
import type { ReferencePresetSaveRequest } from '../types';
import { Button, Dialog, Field, TextInput } from '../ui';
import { useUiText } from '../ui/i18n';
import './dialogs.css';

export type QuickPresetSource = Omit<ReferencePresetSaveRequest, 'name' | 'group'> & { previewUrl: string };

/**
 * 参考图 › 存为参考预设 (step 4c2 rebuild of the old quick save): a name and a group (an existing one offered, or a new
 * one typed) for one reference of the canvas, saved with its image and values as they are.
 */
export function ReferencePresetQuickSaveDialog({ source, onClose }: { source: QuickPresetSource; onClose: () => void }) {
  const { t, language } = useUiText();
  const setToast = useAppStore(state => state.setToast);
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement | null>(null);
  const listId = `rq-groups-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  useEffect(() => {
    void window.naiDesktop.listReferencePresets().then(library => setGroups(library.groups));
  }, []);
  const save = async () => {
    if (!name.trim()) return setToast(t('rp.chooseRequired'));
    setBusy(true);
    const { previewUrl: _previewUrl, ...payload } = source;
    const result = await window.naiDesktop.saveReferencePreset({ ...payload, name, group });
    setBusy(false);
    setToast(result.ok ? t('rp.saved') : hostMessageText(result, language, t('rp.chooseRequired')));
    if (result.ok) onClose();
  };
  return <Dialog open onClose={onClose} busy={busy} icon="star" width={520} title={t('rp.quickSave')} initialFocusRef={first}
    footer={<><Button onClick={onClose} disabled={busy}>{t('rp.cancel')}</Button><Button variant="primary" busy={busy} onClick={() => void save()} data-testid="rq-save">{t('rp.save')}</Button></>}>
    <form className="rq-body" data-testid="reference-quick-save" onSubmit={event => { event.preventDefault(); void save(); }}>
      <img className="rq-thumb" src={source.previewUrl} alt="" />
      <div className="rq-fields">
        <Field label={t('rp.name')}><TextInput ref={first} value={name} onChange={event => setName(event.target.value)} data-testid="rq-name" /></Field>
        <Field label={t('rp.group')}><TextInput list={listId} value={group} placeholder={t('rp.createHint')} onChange={event => setGroup(event.target.value)} data-testid="rq-group" /></Field>
        <datalist id={listId}>{groups.map(item => <option key={item} value={item} label={catalogGroupName(item, language)} />)}</datalist>
      </div>
    </form>
  </Dialog>;
}
