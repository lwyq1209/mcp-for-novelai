import { useState } from 'react';
import { Button, Field, IconButton, TextInput, Toggle, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import type { UiStringKey } from '../../ui/strings';
import { useAppStore } from '../../store';
import type { PromptTemplate } from '../../types';
import { SettingsBlock, SettingsGroup, SettingsRow, useSettingWriter, useSettings } from './common';

type BooleanKey = 'persistGenerateParams' | 'persistI2IParams' | 'persistInpaintParams' | 'persistUpscaleParams' | 'persistDirectorParams';

/** The five "remember between launches" switches (the old Performance section), each with its hint. */
export const PERSIST_SWITCHES: ReadonlyArray<{ key: BooleanKey; label: UiStringKey; hint: UiStringKey }> = [
  { key: 'persistGenerateParams', label: 'set.cv.pT2i', hint: 'set.cv.pT2iHint' },
  { key: 'persistI2IParams', label: 'set.cv.pI2i', hint: 'set.cv.pI2iHint' },
  { key: 'persistInpaintParams', label: 'set.cv.pInpaint', hint: 'set.cv.pInpaintHint' },
  { key: 'persistUpscaleParams', label: 'set.cv.pUpscale', hint: 'set.cv.pUpscaleHint' },
  { key: 'persistDirectorParams', label: 'set.cv.pDirector', hint: 'set.cv.pDirectorHint' },
];

/** A new template from the form, or null without a name (trimmed, as the old form saved it). */
export function templateFromForm(form: { name: string; prefix: string; suffix: string; negativePrompt: string }, id: string): PromptTemplate | null {
  const name = form.name.trim();
  if (!name) return null;
  return { id, name, prefix: form.prefix.trim(), suffix: form.suffix.trim(), negativePrompt: form.negativePrompt.trim() };
}

const EMPTY_FORM = { name: '', prefix: '', suffix: '', negativePrompt: '' };

/** Prompt templates (the old Prompt section): list with delete, and a form to add one. */
export function PromptTemplates() {
  const { t } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const [form, setForm] = useState(EMPTY_FORM);
  const templates = settings?.promptTemplates ?? [];
  const add = async () => {
    const template = templateFromForm(form, crypto.randomUUID());
    if (!template) return;
    if (await update('promptTemplates', [...templates, template])) setForm(EMPTY_FORM);
  };
  const remove = async (template: PromptTemplate) => {
    if (await update('promptTemplates', templates.filter(item => item.id !== template.id))) showToast({ message: t('set.cv.tplDeleted', { name: template.name }), tone: 'ok' });
  };
  const set = (key: keyof typeof EMPTY_FORM) => (event: { target: { value: string } }) => setForm(value => ({ ...value, [key]: event.target.value }));
  return <SettingsGroup title={t('set.cv.tpl')} icon="preset" testId="prompt-templates">
    <SettingsBlock>
      <span className="sp-faint">{t('set.cv.tplHint')}</span>
      {templates.length === 0 ? <span className="sp-empty">{t('set.cv.tplEmpty')}</span> : <ul className="sp-tpls">
        {templates.map(template => <li key={template.id} className="sp-tpl" data-testid="prompt-template">
          <div className="sp-tpl-body">
            <b>{template.name}</b>
            {template.prefix ? <code>{t('set.cv.tplLine', { label: t('set.cv.tplPrefix'), value: template.prefix })}</code> : null}
            {template.suffix ? <code>{t('set.cv.tplLine', { label: t('set.cv.tplSuffix'), value: template.suffix })}</code> : null}
            {template.negativePrompt ? <code>{t('set.cv.tplLine', { label: t('set.cv.tplNeg'), value: template.negativePrompt })}</code> : null}
          </div>
          <IconButton icon="trash" size="sm" label={t('set.cv.tplDelete', { name: template.name })} onClick={() => void remove(template)} />
        </li>)}
      </ul>}
    </SettingsBlock>
    <SettingsBlock className="sp-divided sp-tpl-form">
      <b className="sp-subhead">{t('set.cv.tplNew')}</b>
      <div className="sp-grid2">
        <Field label={t('set.cv.tplName')}><TextInput value={form.name} placeholder={t('set.cv.tplNamePh')} onChange={set('name')} data-testid="template-name" /></Field>
        <Field label={t('set.cv.tplNegOpt')}><TextInput className="sp-mono" value={form.negativePrompt} placeholder="lowres, bad anatomy, ..." onChange={set('negativePrompt')} /></Field>
        <Field label={t('set.cv.tplPrefix')}><TextInput className="sp-mono" value={form.prefix} placeholder="masterpiece, best quality, " onChange={set('prefix')} /></Field>
        <Field label={t('set.cv.tplSuffix')}><TextInput className="sp-mono" value={form.suffix} placeholder="4k, ultra detail" onChange={set('suffix')} /></Field>
      </div>
      <div><Button variant="primary" icon="plus" disabled={!form.name.trim()} onClick={() => void add()} data-testid="template-add">{t('set.cv.tplAdd')}</Button></div>
    </SettingsBlock>
  </SettingsGroup>;
}

/** Settings › Canvas (prototype 26): preview, autocomplete, drop, remembered settings, column widths, templates. */
export function CanvasSection() {
  const { t } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  if (!settings) return <section className="sp-section" data-testid="settings-canvas"><h2>{t('set.canvas')}</h2></section>;
  return <section className="sp-section" data-testid="settings-canvas">
    <h2>{t('set.canvas')}</h2>
    <SettingsGroup>
      <SettingsRow label={t('set.cv.stream')} hint={t('set.cv.streamHint')}>
        <Toggle checked={settings.streamPreviewEnabled ?? true} label={t('set.cv.stream')} onChange={value => void update('streamPreviewEnabled', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.cv.autocomplete')}>
        <Toggle checked={settings.autoComplete} label={t('set.cv.autocomplete')} onChange={value => void update('autoComplete', value)} />
      </SettingsRow>
      <SettingsRow label={t('set.cv.superDrop')} hint={t('set.cv.superDropHint')}>
        <Toggle checked={settings.superDrop} label={t('set.cv.superDrop')} onChange={value => void update('superDrop', value)} />
      </SettingsRow>
    </SettingsGroup>
    <SettingsGroup title={t('set.cv.remember')} icon="history" testId="persist-switches">
      <SettingsBlock className="sp-intro"><span>{t('set.cv.rememberHint')}</span></SettingsBlock>
      {PERSIST_SWITCHES.map(item => <SettingsRow key={item.key} label={t(item.label)} hint={t(item.hint)}>
        <Toggle checked={settings[item.key] !== false} label={t(item.label)} onChange={value => void update(item.key, value)} />
      </SettingsRow>)}
    </SettingsGroup>
    <SettingsGroup>
      <SettingsRow label={t('set.cv.layout')} hint={t('set.cv.layoutHint')}>
        <Button icon="undo" onClick={() => { useAppStore.getState().resetWsWidths(); showToast({ message: t('set.cv.layoutDone'), tone: 'ok' }); }} data-testid="reset-widths">{t('set.cv.layoutReset')}</Button>
      </SettingsRow>
    </SettingsGroup>
    <PromptTemplates />
  </section>;
}
