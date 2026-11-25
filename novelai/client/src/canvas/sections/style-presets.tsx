import { useMemo, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { Button, Dialog, Field, Icon, TextInput, Toggle, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { hostErrorText } from '../../host-errors';
import { useAppStore } from '../../store';
import { saveAssetSetting } from '../../asset-library/legacy-settings';
import { openInLibrary } from '../../library/intent';
import { StylePresetImagesManager } from '../StylePresetImages';
import type { StylePromptPreset } from '../../types';
import { Popover, Select } from '../controls';
import type { RecipeScope } from '../scope';
import { stylePresetHas, stylePresetStyleText } from '../../style-preset';
import { applyStylePresetToCanvas, stylePresetApplyOptions } from '../style-preset-apply';

const EMPTY: StylePromptPreset[] = [];
const EMPTY_GROUPS: string[] = [];
const DEFAULT_GROUP = 'Default';
const presetId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The groups of the Style presets, Default first (the old picker's order: saved groups, then groups only presets name). */
function useStyleGroups(presets: readonly StylePromptPreset[]) {
  const saved = useAppStore(state => state.settings?.stylePromptPresetGroups ?? EMPTY_GROUPS);
  return useMemo(() => {
    const groups = new Set<string>([DEFAULT_GROUP, ...saved]);
    presets.forEach(preset => groups.add(preset.group || DEFAULT_GROUP));
    return [...groups];
  }, [saved, presets]);
}

/**
 * The Style presets of the canvas (prototype: the Style field's 预设): pick one to apply it (its style replaces the
 * Style, its negative text the negative prompt when it has any; a locked field also updates its saved copy), see
 * its sample images, manage those, or save the current Style as a new preset. Two switches, remembered, say how a
 * preset is applied: with its recommended sampling settings, and with text allowed in the image (its
 * text-suppressing negative left out). Editing, regrouping and deleting presets live in the library (预设).
 */
export function StylePresetPicker({ open, anchor, onClose, scope = 'base' }: { open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void; scope?: RecipeScope }) {
  const { t, language } = useUiText();
  const presets = useAppStore(state => state.settings?.stylePromptPresets ?? EMPTY);
  const current = useAppStore(state => scope === 'inpaint' && state.inpaintRecipe ? state.inpaintRecipe.stylePrompt : state.params.stylePrompt);
  const groups = useStyleGroups(presets);
  const [hovered, setHovered] = useState('');
  const [imagesFor, setImagesFor] = useState('');
  const [saving, setSaving] = useState(false);
  const settings = useAppStore(state => state.settings);
  const options = stylePresetApplyOptions(settings);
  // The preset in use: the one whose style (artists and prompt) is the current Style.
  const inUse = (preset: StylePromptPreset) => stylePresetStyleText(preset) === current.trim() && current.trim() !== '';
  const shown = presets.find(preset => preset.id === hovered) ?? presets.find(inUse);
  const groupName = (group: string) => group === DEFAULT_GROUP ? t('cv.style.default') : group;
  async function apply(preset: StylePromptPreset) {
    let written;
    try {
      written = await applyStylePresetToCanvas(preset, scope, options);
      // The family switch of a recommended model is a setting: read back what the host holds now.
      if (written.params.includes('model')) await useAppStore.getState().refreshSettings();
    } catch (error) { showToast({ message: hostErrorText(error, language), tone: 'danger' }); return; }
    onClose();
    const parts = [t('cv.style.part.style'), ...(written.negative ? [t('cv.style.part.negative')] : []), ...(written.params.length ? [t('cv.style.part.params')] : [])];
    showToast({ message: parts.length > 1 ? t('cv.style.appliedParts', { name: preset.name, parts: parts.join(t('c.listSep')) }) : t('cv.style.applied', { name: preset.name }) });
  }
  async function setOption(key: 'stylePresetApplyParams' | 'stylePresetAllowText', value: boolean) {
    const state = useAppStore.getState();
    if (state.settings) useAppStore.setState({ settings: { ...state.settings, [key]: value } });
    await window.naiDesktop.setSetting(key, value);
  }
  return <>
    <Popover open={open} anchor={anchor} onClose={onClose} label={t('cv.style.presets')} width={340} className="cv-style-pop">
      <div className="cv-pop-scroll">
        {presets.length === 0 && <p className="cv-pop-empty ui-faint">{t('cv.style.none')}</p>}
        {groups.map(group => {
          const members = presets.filter(preset => (preset.group || DEFAULT_GROUP) === group);
          if (!members.length) return null;
          return <div key={group} className="cv-pop-group">
            <div className="cv-pop-gh">{groupName(group)}<span className="ui-faint">{members.length}</span></div>
            {members.map(preset => <div key={preset.id} className={clsx('cv-pop-item', inUse(preset) && 'is-on')} onMouseEnter={() => setHovered(preset.id)} onMouseLeave={() => setHovered(value => value === preset.id ? '' : value)}>
              <button type="button" className="cv-pop-main" onFocus={() => setHovered(preset.id)} onClick={() => void apply(preset)} data-testid={`cv-style-preset-${preset.id}`}>
                <b>{preset.name}<StylePresetMarks preset={preset} /></b><span className="ui-mono">{stylePresetStyleText(preset)}</span>
              </button>
              <button type="button" className="cv-iconbtn" title={t('cv.style.images', { n: (preset.previewImages ?? []).length })} aria-label={t('cv.style.images', { n: (preset.previewImages ?? []).length })} onClick={() => { setImagesFor(preset.id); onClose(); }}>
                <Icon name="image" size={14} /><small className="ui-num">{(preset.previewImages ?? []).length}</small>
              </button>
            </div>)}
          </div>;
        })}
      </div>
      {shown && (shown.previewImages ?? []).length > 0 && <div className="cv-pop-preview">{(shown.previewImages ?? []).map(image => <img key={image.id} src={image.fileUrl} title={image.label || undefined} alt={`${shown.name} · ${image.label || image.name}`} />)}</div>}
      <div className="cv-pop-opts" data-testid="cv-style-options">
        <label className="cv-inline-toggle cv-inline-toggle--row" title={t('cv.style.withParamsTip')}><span>{t('cv.style.withParams')}</span><Toggle checked={options.withParams} label={t('cv.style.withParams')} onChange={value => void setOption('stylePresetApplyParams', value)} /></label>
        <label className="cv-inline-toggle cv-inline-toggle--row" title={t('cv.style.allowTextTip')}><span>{t('cv.style.allowText')}</span><Toggle checked={options.allowText} label={t('cv.style.allowText')} onChange={value => void setOption('stylePresetAllowText', value)} /></label>
      </div>
      <div className="cv-pop-foot">
        <Button size="sm" variant="ghost" icon="plus" onClick={() => { onClose(); setSaving(true); }}>{t('cv.style.saveCurrent')}</Button>
        <Button size="sm" variant="ghost" icon="library" onClick={() => { onClose(); openInLibrary({ view: { type: 'category', category: 'presets' } }); }}>{t('cv.style.manage')}</Button>
      </div>
    </Popover>
    {imagesFor && <StylePresetImagesManager presetId={imagesFor} onClose={() => setImagesFor('')} />}
    {saving && <SaveStyleDialog scope={scope} groups={groups} groupName={groupName} onClose={() => setSaving(false)} />}
  </>;
}

/** What a preset holds beside its style text, as small marks after its name: negative text, recommended settings. */
function StylePresetMarks({ preset }: { preset: StylePromptPreset }) {
  const { t } = useUiText();
  const has = stylePresetHas(preset);
  if (!has.negative && !has.textNegative && !has.params) return null;
  return <span className="cv-pop-marks">
    {(has.negative || has.textNegative) && <i title={t('cv.style.hasNegative')}>{t('cv.style.part.negative')}</i>}
    {has.params > 0 && <i title={t('cv.style.hasParams')}>{t('cv.style.part.params')}</i>}
  </span>;
}

/** The old confirmSaveStylePromptPreset: a new preset with this Style, a name (the Style's first 28 characters by default) and a group. */
function SaveStyleDialog({ groups, groupName, onClose, scope }: { groups: string[]; groupName(group: string): string; onClose(): void; scope: RecipeScope }) {
  const { t, language } = useUiText();
  const style = useAppStore(state => (scope === 'inpaint' && state.inpaintRecipe ? state.inpaintRecipe.stylePrompt : state.params.stylePrompt).trim());
  const presets = useAppStore(state => state.settings?.stylePromptPresets ?? EMPTY);
  const [name, setName] = useState(() => style.slice(0, 28) || `Style ${presets.length + 1}`);
  const [group, setGroup] = useState(DEFAULT_GROUP);
  const [busy, setBusy] = useState(false);
  async function save() {
    const trimmed = name.trim();
    if (!style) { showToast({ message: t('cv.style.needText'), tone: 'warn' }); return; }
    if (!trimmed) return;
    setBusy(true);
    try {
      const preset: StylePromptPreset = { id: presetId(), name: trimmed, prompt: style, group, createdAt: new Date().toISOString(), previewImages: [] };
      await saveAssetSetting(window.naiDesktop, 'stylePromptPresets', presets, [...presets, preset]);
      await useAppStore.getState().refreshSettings();
      showToast({ message: t('cv.style.saved', { name: trimmed }), tone: 'ok' });
      onClose();
    } catch (error) {
      showToast({ message: hostErrorText(error, language), tone: 'danger' });
    } finally { setBusy(false); }
  }
  return <Dialog open onClose={onClose} busy={busy} title={t('cv.style.saveTitle')} width={440} footer={<>
    <Button onClick={onClose} disabled={busy}>{t('c.cancel')}</Button>
    <Button variant="primary" busy={busy} disabled={!name.trim() || !style} onClick={() => void save()}>{t('c.save')}</Button>
  </>}>
    <div className="cv-form">
      <Field label={t('cv.style.saveName')}><TextInput autoFocus value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void save(); }} /></Field>
      <Field label={t('cv.style.saveGroup')}><Select<string> label={t('cv.style.saveGroup')} value={group} onChange={setGroup} options={groups.map(value => ({ value, label: groupName(value) }))} /></Field>
      <p className="cv-form-prev ui-mono">{style || t('cv.style.needText')}</p>
    </div>
  </Dialog>;
}
