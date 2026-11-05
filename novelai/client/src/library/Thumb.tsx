import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { assetQueryClient, assetQueryKey } from '../asset-library/query';
import type { AssetItem, AssetThumbnail } from '../asset-library/types';
import { Icon, type IconName } from '../ui';
import type { LibraryApi } from './api';
import { boundThumbnailCache, scheduleThumbnail } from './thumb-loader';

boundThumbnailCache(assetQueryClient);

/**
 * A card or tile picture: the host's 384px thumbnail of the item's preview image (asset_library thumbnail), read only
 * once the tile is near the viewport, in turn with the other tiles (thumb-loader.ts). Without a preview it shows the
 * kind's icon.
 */
export function Thumb({ api, item, icon = 'image', alt = '' }: { api: LibraryApi; item: AssetItem; icon?: IconName; alt?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const preview = item.preview;
  useEffect(() => {
    const node = ref.current;
    if (!node || !preview) return;
    if (typeof IntersectionObserver !== 'function') { setNear(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setNear(true); }, { rootMargin: '300px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [preview?.cacheKey]);
  const thumbnail = useQuery<AssetThumbnail, Error>({
    queryKey: assetQueryKey(api, 'thumbnail', item.kind, item.id, item.revision, preview?.cacheKey),
    // The signal: a tile that leaves before its read is sent drops the read (thumb-loader.ts).
    queryFn: ({ signal }) => scheduleThumbnail(() => api.assetLibrary({ action: 'thumbnail', kind: item.kind, id: item.id, revision: item.revision, assetId: preview!.assetId }), signal),
    enabled: near && !!preview,
  }, assetQueryClient);
  const src = thumbnail.data?.status === 'ready' ? thumbnail.data.dataUrl : undefined;
  return <span ref={ref} className="lib-thumb" data-state={src ? 'ready' : preview ? (thumbnail.isError || thumbnail.data?.status === 'unavailable' ? 'unavailable' : 'loading') : 'none'}>
    {src ? <img src={src} alt={alt} decoding="async" draggable={false} /> : <Icon name={thumbnail.isError || thumbnail.data?.status === 'unavailable' ? 'alert' : icon} size={22} />}
  </span>;
}
