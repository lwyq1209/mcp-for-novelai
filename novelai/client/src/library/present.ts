import type { AssetItem, AssetKind } from '../asset-library/types';
import type { IconName } from '../ui';
import type { UiText } from '../ui/i18n';

/** Reading names and excerpts of library items for cards and the drawer (step 4b1). Pure; never used to apply or save. */
export function itemTitle(item: Pick<AssetItem, 'kind' | 'id' | 'name' | 'payload'>): string {
  if (item.kind === 'history') {
    const file = typeof item.payload?.filePath === 'string' ? item.payload.filePath.split(/[\\/]/).pop() : '';
    return (item.name && item.name !== item.id ? item.name : file?.replace(/\.[a-z0-9]+$/i, '')) || item.id;
  }
  if (item.kind === 'artist_favorite') {
    if (item.name && item.name !== item.id) return item.name;
    const artists = Array.isArray(item.payload?.artists) ? item.payload.artists as Array<{ name: string; weight: number }> : [];
    return artists.map(artist => artist.weight === 1 ? artist.name : `${artist.weight} × ${artist.name}`).join(' + ') || String(item.payload?.prompt ?? '').slice(0, 80) || item.id;
  }
  return item.name || item.id;
}

/** The file name of a history original or an imported image. */
export function fileName(item: Pick<AssetItem, 'kind' | 'payload' | 'name'>): string {
  const path = item.payload?.filePath ?? item.payload?.study?.fileName;
  return typeof path === 'string' && path ? path.split(/[\\/]/).pop() ?? path : item.name;
}

export const KIND_ICONS: Record<AssetKind | 'collection', IconName> = {
  history: 'history', study: 'imported', tag: 'tag', combo: 'combo', note: 'note', style_preset: 'preset', positive_preset: 'preset',
  prompt_chunk: 'preset', reference_preset: 'image', artist_favorite: 'artist', collection: 'collection',
};

const SHORT_MODELS: Record<string, string> = {
  'nai-diffusion-5-full': 'NAI Diffusion V5 Full', 'nai-diffusion-5-curated': 'NAI Diffusion V5 Curated',
  'nai-diffusion-4-5-full': 'NAI Diffusion 4.5 Full', 'nai-diffusion-4-5-curated': 'NAI Diffusion 4.5 Curated',
  'nai-diffusion-4-full': 'NAI Diffusion 4 Full', 'nai-diffusion-4-curated': 'NAI Diffusion 4 Curated',
  'nai-diffusion-3': 'NAI Diffusion 3', 'nai-diffusion-furry-3': 'NAI Diffusion Furry 3',
  'nai-diffusion-4-5-full-inpainting': 'NAI Diffusion 4.5 Full Inpaint', 'nai-diffusion-5-full-inpainting': 'NAI Diffusion V5 Full Inpaint', 'nai-diffusion-5-curated-inpainting': 'NAI Diffusion V5 Curated Inpaint',
  // V5 Full Effort Medium (src/nai-effort.ts): the history record's model is the model id that was sent.
  'nai-diffusion-5-full-medium': 'NAI Diffusion V5 Full (Medium effort)', 'nai-diffusion-5-full-medium-inpainting': 'NAI Diffusion V5 Full Inpaint (Medium effort)',
};
/** A model id as a short name (the same in both languages); unknown ids show as they are. */
export const modelName = (model: string) => SHORT_MODELS[model] ?? model;

const SAMPLERS: Record<string, string> = { k_euler_ancestral: 'Euler Ancestral', k_euler: 'Euler', k_dpmpp_2m: 'DPM++ 2M', k_dpmpp_2m_sde: 'DPM++ 2M SDE', k_dpmpp_sde: 'DPM++ SDE', k_dpmpp_2s_ancestral: 'DPM++ 2S Ancestral', ddim_v3: 'DDIM' };
export const samplerName = (value: unknown) => typeof value === 'string' ? SAMPLERS[value] ?? value : '';
const UC: Record<number, string> = { 0: 'Heavy', 1: 'Light', 2: 'Human Focus', 3: 'None' };
export const ucName = (value: unknown) => typeof value === 'number' ? UC[value] ?? String(value) : '';

/** The excerpt and the meta line of a preset, combo, note or artist card. */
export function cardExcerpt(item: AssetItem, t: UiText): { text: string; meta: string } {
  const payload = item.payload ?? {};
  switch (item.kind) {
    case 'tag': {
      const count = payload.tag?.evidence?.postCount ?? payload.tag?.postCount;
      return { text: String(payload.tag?.text ?? ''), meta: count == null ? t('tag.postsUnknown') : t('tag.posts', { n: Number(count) }) };
    }
    case 'combo': {
      const members = Array.isArray(payload.components) ? payload.components : [];
      return { text: members.map((member: any) => member.weight === 1 ? member.text : `${member.weight}::${member.text}`).join(', '), meta: t('combo.members', { n: members.length }) };
    }
    case 'note': return { text: String(payload.notes ?? ''), meta: payload.group ? String(payload.group) : '' };
    case 'style_preset': case 'positive_preset': return { text: String(payload.prompt ?? ''), meta: payload.group ? String(payload.group) : '' };
    case 'prompt_chunk': return { text: String(payload.content ?? ''), meta: '' };
    case 'reference_preset': {
      const parts = [payload.kind === 'vibe' ? t('pre.ref.vibe') : t('pre.ref.precise'), t('pre.ref.strength', { v: String(payload.strength ?? '') })];
      parts.push(payload.kind === 'vibe' ? t('pre.ref.info', { v: String(payload.infoExtracted ?? '') }) : t('pre.ref.fidelity', { v: String(payload.fidelity ?? '') }));
      return { text: parts.join(' · '), meta: payload.group ? String(payload.group) : '' };
    }
    case 'artist_favorite': return { text: String(payload.prompt ?? ''), meta: '' };
    default: return { text: String(payload.notes ?? ''), meta: '' };
  }
}

/** Tags of a tag card: its use (Style / 全图 / 角色). */
export function tagTarget(item: AssetItem, t: UiText): string {
  const target = item.payload?.tag?.target;
  return target === 'style' ? t('tag.target.style') : target === 'character' ? t('tag.target.character') : target === 'base' ? t('tag.target.base') : '';
}
