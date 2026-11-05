import { useEffect, useRef, useState } from 'react';
import { assetQueryKey, useLocalAssetQuery } from '../asset-library/query';
import type { AssetItem } from '../asset-library/types';
import type { LibraryApi } from '../library/api';
import { Thumb } from '../library/Thumb';
import { Icon, type IconName } from '../ui';

/**
 * The thumbnail of one finished queue image by its history id: the item is read only once the tile is near the
 * viewport, with the window's ui-read (the library drawer's read and cache key): unlike the plain read it carries the
 * item's preview (assetId and cache key), which the library's Thumb needs to show its 384px thumbnail (step 4c1: the
 * plain read has no preview, so the queue page showed only the placeholder). A read that fails shows the alert icon.
 */
/** The read a queue thumbnail sends (exported for the test that runs it against the real host service). */
export const readHistoryThumb = (api: Pick<LibraryApi, 'assetLibrary'>, historyId: string): Promise<{ item?: AssetItem }> =>
  api.assetLibrary({ action: 'ui-read', kind: 'history', id: historyId });
export const historyThumbKey = (api: LibraryApi, historyId: string) => assetQueryKey(api, 'detail', 'history', historyId, undefined);

export function HistoryThumb({ api, historyId, icon = 'image', failedTitle }: { api: LibraryApi; historyId: string; icon?: IconName; failedTitle: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || near) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setNear(true); }, { rootMargin: '300px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  const detail = useLocalAssetQuery<{ item?: AssetItem }>(historyThumbKey(api, historyId), () => readHistoryThumb(api, historyId), near);
  const item = detail.data?.item;
  if (item) return <Thumb api={api} item={item} icon={icon} />;
  const failed = detail.isError || (detail.isSuccess && !item);
  return <span ref={ref} className="lib-thumb" data-state={failed ? 'unavailable' : 'loading'} title={failed ? failedTitle : undefined}>
    <Icon name={failed ? 'alert' : icon} size={20} />
  </span>;
}
