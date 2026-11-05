import { useMemo, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { Button, Dialog, Field, Icon, TextInput, showToast } from '../../ui';
import { useUiText } from '../../ui/i18n';
import { hostErrorText } from '../../host-errors';
import { useAppStore } from '../../store';
import { saveAssetSetting } from '../../asset-library/legacy-settings';
import { openInLibrary } from '../../library/intent';
import { StylePresetImagesManager } from '../StylePresetImages';
import type { StylePromptPreset } from '../../types';
import { Popover, Select } from '../controls';
import { setPromptField, type RecipeScope } from '../scope';

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
 * The Style presets of the canvas (prototype: the Style field's 预设): pick one to replace the Style (a locked Style
 * also updates its saved copy, as before), see its preview images, manage those, or save the current Style as a new
 * preset. Editing, regrouping and deleting presets live in the library (预设).
 */
export function StylePresetPicker({ open, anchor, onClose, scope = 'base' }: { open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void; scope?: RecipeScope }) {
  const { t } = useUiText();
  const presets = useAppStore(state => state.settings?.stylePromptPresets ?? EMPTY);
  const current = useAppStore(state => scope === 'inpaint' && state.inpaintRecipe ? state.inpaintRecipe.stylePrompt : state.params.stylePrompt);
  const groups = useStyleGroups(presets);
  const [hovered, setHovered] = useState('');
  const [imagesFor, setImagesFor] = useState('');
  const [saving, setSaving] = useState(false);
  const shown = presets.find(preset => preset.id === hovered) ?? presets.find(preset => preset.prompt.trim() === current.trim());
  const groupName = (group: string) => group === DEFAULT_GROUP ? t('cv.style.default') : group;
  function apply(preset: StylePromptPreset) {
    setPromptField(scope, 'stylePrompt', preset.prompt);
    onClose();
    showToast({ message: t('cv.style.applied', { name: preset.name }) });
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
            {members.map(preset => <div key={preset.id} className={clsx('cv-pop-item', preset.prompt.trim() === current.trim() && 'is-on')} onMouseEnter={() => setHovered(preset.id)} onMouseLeave={() => setHovered(value => value === preset.id ? '' : value)}>
              <button type="button" className="cv-pop-main" onFocus={() => setHovered(preset.id)} onClick={() => apply(preset)} data-testid={`cv-style-preset-${preset.id}`}>
                <b>{preset.name}</b><span className="ui-mono">{preset.prompt}</span>
              </button>
              <button type="button" className="cv-iconbtn" title={t('cv.style.images', { n: (preset.previewImages ?? []).length })} aria-label={t('cv.style.images', { n: (preset.previewImages ?? []).length })} onClick={() => { setImagesFor(preset.id); onClose(); }}>
                <Icon name="image" size={14} /><small className="ui-num">{(preset.previewImages ?? []).length}</small>
              </button>
            </div>)}
          </div>;
        })}
      </div>
      {shown && (shown.previewImages ?? []).length > 0 && <div className="cv-pop-preview">{(shown.previewImages ?? []).map(image => <img key={image.id} src={image.fileUrl} alt={`${shown.name} · ${image.name}`} />)}</div>}
      <div className="cv-pop-foot">
        <Button size="sm" variant="ghost" icon="plus" onClick={() => { onClose(); setSaving(true); }}>{t('cv.style.saveCurrent')}</Button>
        <Button size="sm" variant="ghost" icon="library" onClick={() => { onClose(); openInLibrary({ view: { type: 'category', category: 'presets' } }); }}>{t('cv.style.manage')}</Button>
      </div>
    </Popover>
    {imagesFor && <StylePresetImagesManager presetId={imagesFor} onClose={() => setImagesFor('')} />}
    {saving && <SaveStyleDialog scope={scope} groups={groups} groupName={groupName} onClose={() => setSaving(false)} />}
  </>;
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
