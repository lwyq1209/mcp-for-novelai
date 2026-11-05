import type { HistoryItem, HistoryItemsSnapshot } from "./types";

/** At most this many identities per incremental history read; more falls back to a full getHistory (same bound as the host). */
export const HISTORY_ITEMS_LIMIT = 500;

/**
 * Rebuilds the visible history list from an incremental read (2026-11-01).
 *
 * `snapshot.order` is the complete view in getHistory order. Changed items
 * take their fresh payloads; every other visible item keeps its previous
 * object. Identities the view contains but neither source has are returned
 * as `missing`, so the caller can read them too or fall back to a full load.
 * Items absent from the order (deleted, archived, moved to another date or
 * group) drop out. `present` applies the same per-item presentation as a full
 * refresh (the completed-image bridge).
 */
export function mergeHistorySnapshot(
  previous: readonly HistoryItem[],
  changed: Iterable<string>,
  snapshot: Pick<HistoryItemsSnapshot, "items" | "order">,
  present: (item: HistoryItem) => HistoryItem = (item) => item,
): { history: HistoryItem[]; missing: string[] } {
  if (!Array.isArray(snapshot.order)) throw new Error("历史增量读取缺少列表顺序。");
  const changedIds = new Set(changed);
  const fresh = new Map(snapshot.items.map((item) => [item.id, item] as const));
  const kept = new Map<string, HistoryItem>();
  for (const item of previous) if (!changedIds.has(item.id) && !kept.has(item.id)) kept.set(item.id, item);
  const history: HistoryItem[] = [], missing: string[] = [];
  for (const id of snapshot.order) {
    const item = fresh.get(id) ?? kept.get(id);
    if (item) history.push(present(item));
    else missing.push(id);
  }
  return { history, missing };
}
