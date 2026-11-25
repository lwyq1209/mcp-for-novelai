/**
 * How many preview images a preset keeps: a Style preset six sample images (issue #1: the reference image and a
 * sample per kind of scene), a prompt preset three. One rule for the window, the host's preset image folder and
 * backup restore; a preset's folder is named by its storage id ("positive-prompt-<id>" for a prompt preset, the id
 * itself for a Style preset).
 */
export const STYLE_PRESET_PREVIEW_LIMIT = 6;
export const PROMPT_PRESET_PREVIEW_LIMIT = 3;
const PROMPT_PRESET_STORAGE_PREFIX = 'positive-prompt-';

export const presetPreviewLimit = (kind: 'style' | 'positive') => kind === 'positive' ? PROMPT_PRESET_PREVIEW_LIMIT : STYLE_PRESET_PREVIEW_LIMIT;
/** The folder name of a preset's images under <data>/style-prompt-previews: its storage id with only safe characters. */
export const presetPreviewFolderName = (storageId: string) => storageId.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
/** The limit of the preset whose image folder has this storage id. */
export const presetPreviewLimitOfStorage = (storageId: string) => presetPreviewLimit(storageId.startsWith(PROMPT_PRESET_STORAGE_PREFIX) ? 'positive' : 'style');
