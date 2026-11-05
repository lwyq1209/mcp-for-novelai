import type { MaterialComponent, MaterialEntry, MaterialTarget } from './material-library-types';

/** Numeric emphasis is NovelAI syntax; artist spelling has already been resolved by the library service. */
export function materialPrompt(components: readonly MaterialComponent[]): string {
  return components.map((item) => {
    if (!Number.isFinite(item.weight) || item.weight < 0 || item.weight > 10) throw new Error('权重须在 0–10 之间。');
    const text = item.source === 'danbooru' && item.category === 'artist' && !/^artist:/i.test(item.text) ? `artist:${item.text}` : item.text;
    return item.weight === 1 ? text : `${Number(item.weight.toFixed(3))}::${text} ::`;
  }).join(', ');
}

export function componentsFromEntry(entry: MaterialEntry): MaterialComponent[] {
  if (entry.kind === 'tag' && entry.tag) return [{ text: entry.tag.text, source: entry.tag.source, category: entry.tag.category, weight: 1, target: entry.tag.target, entryId: entry.id, entryRevision: entry.revision }];
  return (entry.components ?? []).map((item) => ({ ...item, entryId: entry.id, entryRevision: entry.revision }));
}


/** Composer Style replaces the whole field; a selection without Style leaves it byte-for-byte intact. */
export function replaceMaterialStyle(current: string, components: readonly MaterialComponent[]): string {
  const matching = components.filter((item) => item.target === 'style');
  return matching.length ? materialPrompt(matching) : current;
}

export function appendMaterialText(current: string, components: readonly MaterialComponent[], target: MaterialTarget): string {
  const matching = components.filter((item) => item.target === target);
  if (!matching.length) return current;
  return [current.trim().replace(/,\s*$/, ''), materialPrompt(matching)].filter(Boolean).join(', ');
}
