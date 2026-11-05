import { useEffect, useState } from 'react';
import type { AssetItem } from '../asset-library/types';
import { Button, Dialog, Icon, SearchInput, Spinner } from '../ui';
import { useUiText } from '../ui/i18n';
import type { LibraryApi } from './api';
import { useLibraryItems } from './data';
import { libraryErrorText } from './errors';
import { itemTitle } from './present';
import { Thumb } from './Thumb';

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * A history image as a tag's cover (用历史图做封面, step 4c1), composed as MCP's set_cover_from_history is: the image's
 * registered original (asset_library image, variant original, exact revision and assetId), then the host's ordinary
 * local cover save (material_samples set_local_cover) with the tag revision and cover revision read before, so a cover
 * changed meanwhile is refused, not replaced. Nothing is retried.
 */
export async function setCoverFromHistory(api: LibraryApi, tag: { id: string; revision: number; coverRevision: number }, image: AssetItem) {
  const assetId = image.preview?.assetId;
  if (!assetId) throw Object.assign(new Error('This image has no registered original.'), { code: 'image_unavailable', reason: 'library.history_image_unregistered' });
  const original = await api.assetLibrary({ action: 'image', kind: 'history', id: image.id, revision: image.revision, assetId, variant: 'original' }) as { data: string; mimeType: string };
  const extension = EXTENSIONS[original.mimeType] ?? 'png';
  return api.materialSamples!({ action: 'set_local_cover', entryId: tag.id, revision: tag.revision, expectedCoverRevision: tag.coverRevision, fileName: `history-${image.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}-r${image.revision}.${extension}`, data: original.data });
}

export function HistoryCoverPicker({ api, tag, onClose, onSaved }: { api: LibraryApi; tag: { id: string; revision: number; coverRevision: number; name: string }; onClose(): void; onSaved(): void }) {
  const { t, lang } = useUiText();
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState('');
  useEffect(() => { const timer = setTimeout(() => setShown(query), 250); return () => clearTimeout(timer); }, [query]);
  const list = useLibraryItems(api, { action: 'ui-list', kinds: ['history'], query: shown.trim(), archived: 'exclude', sortBy: 'createdAt', sortDirection: 'desc' }, true);
  const [busy, setBusy] = useState('');
  const [failure, setFailure] = useState('');
  const pick = async (image: AssetItem) => {
    if (busy) return;
    setBusy(image.id); setFailure('');
    try { await setCoverFromHistory(api, tag, image); onSaved(); }
    catch (error) { setFailure(libraryErrorText(error, t, lang)); setBusy(''); }
  };
  return <Dialog open onClose={onClose} busy={!!busy} icon="image" width={720} title={t('tag.coverHistoryTitle', { name: tag.name })} description={t('tag.coverHistoryDesc')}
    footer={<Button onClick={onClose} disabled={!!busy}>{t('c.cancel')}</Button>}>
    <div className="lib-hcover" data-testid="history-cover-picker">
      <SearchInput value={query} onChange={setQuery} placeholder={t('lib.search')} label={t('lib.searchShort')} clearLabel={t('lib.clearSearch')} />
      {failure && <p className="lib-error" role="alert"><Icon name="alert" size={14} /><span>{failure}</span></p>}
      {list.loading && !list.items.length && <p className="lib-wait" role="status"><Spinner size={14} /> {t('c.loading')}</p>}
      {!list.loading && !list.items.length && <p className="ui-muted">{t('empty.search.t')}</p>}
      <div className="lib-hcover-grid">
        {list.items.map(image => <button key={image.id} type="button" className="lib-all-img" disabled={!!busy} title={itemTitle(image)} aria-label={t('tag.coverUse', { name: itemTitle(image) })} onClick={() => void pick(image)} data-testid={`history-cover-${image.id}`}>
          <Thumb api={api} item={image} alt="" />{busy === image.id && <span className="lib-hcover-busy"><Spinner size={16} /></span>}
        </button>)}
      </div>
      {list.hasMore && <Button size="sm" variant="ghost" busy={list.loadingMore} onClick={list.loadMore}>{t('tag.coverMore')}</Button>}
    </div>
  </Dialog>;
}
