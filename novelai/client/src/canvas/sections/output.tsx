import { useState } from 'react';
import { Disclosure, Icon, TextInput } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { useAppStore } from '../../store';
import { Labeled, NumberField, Select } from '../controls';

/**
 * Output settings of a manual run (not drawn in the prototype; the old Generate panel had them): the wait between images
 * of a batch, the file name prefix and the project (history group) the images join, with a new project in place.
 */
export function OutputSection() {
  const { t } = useUiText();
  const interval = useAppStore(state => state.batchIntervalSeconds);
  const setInterval = useAppStore(state => state.setBatchIntervalSeconds);
  const prefix = useAppStore(state => state.params.fileNamePrefix);
  const setParam = useAppStore(state => state.setParam);
  const groups = useAppStore(state => state.historyGroups);
  const groupId = useAppStore(state => state.generationGroupId);
  const setGroup = useAppStore(state => state.setGenerationGroupId);
  const createGroup = useAppStore(state => state.createGenerationGroup);
  const [name, setName] = useState('');
  const create = () => { const value = name.trim(); if (!value) return; void createGroup(value); setName(''); };
  const selected = groups.some(group => group.id === groupId) ? groupId : '';
  return <Disclosure summary={t('cv.out')} className="cv-adv" >
    <div className="cv-out" data-testid="cv-output">
      <Labeled label={t('cv.out.interval')} value={undefined}>
        <NumberField label={t('cv.out.interval')} value={interval} min={0} max={3600} normalize={value => Math.max(0, Math.min(3600, Math.round(value)))} onCommit={setInterval} />
        <small className="ui-faint">{t('cv.out.intervalHint')}</small>
      </Labeled>
      <Labeled label={t('cv.out.prefix')}>
        <TextInput value={prefix} placeholder={t('cv.out.prefixPlaceholder')} aria-label={t('cv.out.prefix')} onChange={event => setParam('fileNamePrefix', event.target.value)} />
      </Labeled>
      <Labeled label={t('cv.out.project')}>
        <Select<string> label={t('cv.out.project')} value={selected} onChange={value => void setGroup(value)} options={[{ value: '', label: t('cv.out.noProject') }, ...groups.map(group => ({ value: group.id, label: group.name }))]} />
        <div className="cv-row">
          <TextInput className="cv-grow" value={name} placeholder={t('cv.out.newProjectName')} aria-label={t('cv.out.newProjectName')} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); create(); } }} />
          <button type="button" className="ui-btn ui-btn--sm" disabled={!name.trim()} onClick={create}><Icon name="plus" size={13} />{t('cv.out.newProject')}</button>
        </div>
      </Labeled>
    </div>
  </Disclosure>;
}
