import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { droppedImagePaths, hasDraggedFiles } from '../drag-drop';
import { imagePasteProps } from '../image-paste';
import { useAppStore } from '../store';
import { saveAssetSetting } from '../asset-library/legacy-settings';
import { positivePromptPresetStorageId } from '../positive-prompt-presets';
import type { StylePromptPreset, StylePromptPreviewImage } from '../types';
import { Button, Dialog, Icon, IconButton, UiPortal } from '../ui';
import { useUiText, type UiText } from '../ui/i18n';
import './dialogs.css';

/** At most three images per preset (the host's folder keeps the same limit). */
export const PRESET_IMAGE_LIMIT = 3;

/** The texts that differ between a Style preset's dialog and a prompt preset's (step 4c1: it names prompt presets). */
export function presetImageTexts(t: UiText, kind: 'style' | 'positive') {
  return kind === 'positive'
    ? { title: t('cv.pp.img.title'), none: t('cv.pp.img.none'), hint: t('cv.pp.img.hint'), limit: t('cv.pp.img.limit'), imported: (n: number) => t('cv.pp.img.imported', { n }) }
    : { title: t('spi.title'), none: t('spi.none'), hint: t('spi.hint'), limit: t('spi.limit'), imported: (n: number) => t('spi.imported', { n }) };
}

/**
 * The preview images of one preset (at most three): import, drop, paste, replace, delete; double-click for a
 * full-screen preview, Escape closes the preview first and then the dialog. Rebuilt in step 4c2 on the UI kit.
 */
export function StylePresetImagesView({ preset, kind, onImport, onDropImages, onReplace, onDelete, onClose }: {
  preset: StylePromptPreset;
  kind: 'style' | 'positive';
  onImport: () => void;
  onDropImages: (sourcePaths: string[]) => void;
  onReplace: (image: StylePromptPreviewImage, sourcePath?: string) => void;
  onDelete: (image: StylePromptPreviewImage) => void;
  onClose: () => void;
}) {
  const { t } = useUiText();
  const text = presetImageTexts(t, kind);
  const [preview, setPreview] = useState<StylePromptPreviewImage | null>(null);
  const [dragging, setDragging] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const images = preset.previewImages ?? [];
  const closePreview = () => {
    setPreview(null);
    const target = opener.current;
    if (target?.isConnected) window.setTimeout(() => target.focus({ preventScroll: true }), 0);
  };
  // Escape outside the dialog box (the preview has the focus, or nothing does): the preview first, then the dialog.
  // Inside the box the dialog handles Escape itself and stops it there.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (preview) closePreview();
      else onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, preview]);
  return <>
    <Dialog open onClose={onClose} icon="palette" width={640} title={text.title} description={<span className="spi-sub">{t('spi.count', { name: preset.name, n: images.length })}</span>} initialFocusRef={closeRef}
      footer={<><Button ref={closeRef} onClick={onClose}>{t('spi.close')}</Button><Button variant="primary" icon="folder" disabled={images.length >= PRESET_IMAGE_LIMIT} onClick={onImport} data-testid="spi-add">{t('spi.add')}</Button></>}>
      <div className={clsx('spi-drop', dragging && 'is-over')} data-testid="preset-images"
        onDragEnter={event => { if (!hasDraggedFiles(event.dataTransfer)) return; event.preventDefault(); setDragging(true); }}
        onDragOver={event => { if (!hasDraggedFiles(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragging(true); }}
        onDragLeave={event => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setDragging(false); }}
        data-image-paste="drop" data-image-paste-multiple="true" tabIndex={0}
        onDrop={event => {
          if (!hasDraggedFiles(event.dataTransfer)) return;
          event.preventDefault();
          setDragging(false);
          const paths = droppedImagePaths(event.dataTransfer, PRESET_IMAGE_LIMIT - images.length);
          if (paths.length > 0) onDropImages(paths);
        }}>
        {images.length === 0
          ? <div className="spi-empty" role="button" tabIndex={0} onClick={onImport} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onImport(); } }} data-testid="spi-empty">
            <Icon name="palette" size={28} />
            <strong>{text.none}</strong>
            <span>{t('spi.drop')}</span>
            <span className="ui-faint">{text.hint}</span>
          </div>
          : <div className="spi-grid">{images.map(image => <article className="spi-card" key={image.id}>
            <button type="button" className="spi-img" title={text.hint} onDoubleClick={event => { opener.current = event.currentTarget; setPreview(image); }}>
              <img src={image.fileUrl} alt={t('spi.alt', { name: preset.name, image: image.name })} />
            </button>
            <small className="spi-name" title={image.name}>{image.name}</small>
            <div className="spi-acts">
              <Button {...imagePasteProps(paths => onReplace(image, paths[0]))} size="sm" icon="folder" onClick={() => onReplace(image)}>{t('spi.replace')}</Button>
              <Button size="sm" variant="dangerGhost" icon="trash" onClick={() => onDelete(image)}>{t('spi.delete')}</Button>
            </div>
          </article>)}</div>}
        {images.length > 0 && <p className="spi-hint">{text.hint}</p>}
      </div>
    </Dialog>
    {preview && <UiPortal><div className="spi-lightbox" role="dialog" aria-modal="true" aria-label={t('spi.previewLabel')} onMouseDown={closePreview} data-testid="spi-lightbox">
      <IconButton className="spi-lightbox-close" tone="overlay" icon="x" label={t('spi.close')} autoFocus onMouseDown={event => event.stopPropagation()} onClick={closePreview} />
      <img src={preview.fileUrl} alt={t('spi.alt', { name: preset.name, image: preview.name })} onMouseDown={event => event.stopPropagation()} />
    </div></UiPortal>}
  </>;
}

const EMPTY_PRESETS: StylePromptPreset[] = [];

/**
 * The handlers around the dialog (moved from App.tsx in step 4b3, unchanged in step 4c2): a preset's images are kept
 * in its setting and its image folder; kind "positive" (step 4b3c) does the same for a prompt preset (its setting and
 * its image folder id, as the old prompt preset control kept them).
 */
export function StylePresetImagesManager({ presetId, onClose, kind = 'style' }: { presetId: string; onClose: () => void; kind?: 'style' | 'positive' }) {
  const { t } = useUiText();
  const settings = useAppStore(state => state.settings);
  const refreshSettings = useAppStore(state => state.refreshSettings);
  const setToast = useAppStore(state => state.setToast);
  const settingKey = kind === 'positive' ? 'positivePromptPresets' : 'stylePromptPresets';
  const stylePromptPresets = ((kind === 'positive' ? settings?.positivePromptPresets : settings?.stylePromptPresets) ?? EMPTY_PRESETS) as StylePromptPreset[];
  const storageId = (id: string) => kind === 'positive' ? positivePromptPresetStorageId(id) : id;
  const text = presetImageTexts(t, kind);

  async function updateImages(id: string, images: StylePromptPreviewImage[]) {
    await saveAssetSetting(window.naiDesktop, settingKey as 'stylePromptPresets', stylePromptPresets,
      stylePromptPresets.map(item => item.id === id ? { ...item, previewImages: images.slice(0, PRESET_IMAGE_LIMIT) } : item));
    await refreshSettings();
  }

  useEffect(() => {
    if (!presetId) return;
    const preset = stylePromptPresets.find(item => item.id === presetId);
    if (!preset) return;
    let cancelled = false;
    void window.naiDesktop.reconcileStylePromptPresetImages(storageId(preset.id), preset.previewImages ?? []).then(async restored => {
      if (cancelled) return;
      const currentIds = (preset.previewImages ?? []).map(image => image.id).join('|');
      const restoredIds = restored.map(image => image.id).join('|');
      if (currentIds !== restoredIds) await updateImages(preset.id, restored);
    });
    return () => { cancelled = true; };
  }, [presetId]);

  async function importImages(preset: StylePromptPreset) {
    const current = await window.naiDesktop.reconcileStylePromptPresetImages(storageId(preset.id), preset.previewImages ?? []);
    const available = PRESET_IMAGE_LIMIT - current.length;
    if (available <= 0) { setToast(text.limit); return; }
    const imported = await window.naiDesktop.importStylePromptPresetImages(storageId(preset.id), available, text.title);
    if (imported.length === 0) return;
    await updateImages(preset.id, [...current, ...imported]);
  }

  async function importDropped(preset: StylePromptPreset, sourcePaths: string[]) {
    const current = await window.naiDesktop.reconcileStylePromptPresetImages(storageId(preset.id), preset.previewImages ?? []);
    const available = PRESET_IMAGE_LIMIT - current.length;
    if (available <= 0) { setToast(text.limit); return; }
    const imported = await window.naiDesktop.importStylePromptPresetImagePaths(sourcePaths, storageId(preset.id), available);
    if (imported.length === 0) return;
    await updateImages(preset.id, [...current, ...imported]);
    setToast(text.imported(imported.length));
  }

  async function replaceImage(preset: StylePromptPreset, image: StylePromptPreviewImage, sourcePath?: string) {
    const imported = sourcePath
      ? await window.naiDesktop.importStylePromptPresetImagePaths([sourcePath], storageId(preset.id), 1)
      : await window.naiDesktop.importStylePromptPresetImages(storageId(preset.id), 1, t('spi.replace'));
    if (imported.length === 0) return;
    await updateImages(preset.id, (preset.previewImages ?? []).map(item => item.id === image.id ? imported[0] : item));
  }

  async function deleteImage(preset: StylePromptPreset, image: StylePromptPreviewImage) {
    await updateImages(preset.id, (preset.previewImages ?? []).filter(item => item.id !== image.id));
  }

  const preset = stylePromptPresets.find(item => item.id === presetId);
  if (!preset) return null;
  return <StylePresetImagesView preset={preset} kind={kind}
    onImport={() => void importImages(preset)}
    onDropImages={paths => void importDropped(preset, paths)}
    onReplace={(image, sourcePath) => void replaceImage(preset, image, sourcePath)}
    onDelete={image => void deleteImage(preset, image)}
    onClose={onClose} />;
}
