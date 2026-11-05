import { useState, type RefObject } from 'react';
import clsx from 'clsx';
import { Button, Icon, Spinner, showToast } from '../ui';
import { useUiText } from '../ui/i18n';
import { useCollections, useItemDetail } from '../library/data';
import { addToCollection, createCollection, removeFromCollection, type LibraryApi } from '../library/api';
import { NameDialog } from '../library/dialogs';
import { libraryErrorText } from '../library/errors';
import { Popover } from './controls';

const api = () => window.naiDesktop as unknown as LibraryApi;

/**
 * 加入收藏夹… of the stage's image actions (the old image actions' 加入收藏夹, step 4b3 review rework): the user
 * collections with a check on the ones the image is in; a click adds it to or removes it from one; a new collection
 * can be made and gets the image. The same library calls as the library page's collect menu.
 */
export function CollectPicker({ open, anchor, onClose, historyId }: { open: boolean; anchor: RefObject<HTMLElement | null>; onClose(): void; historyId: string }) {
  const { t, lang } = useUiText();
  const collections = useCollections(api(), open);
  const detail = useItemDetail(api(), { kind: 'history', id: historyId }, open);
  const [busy, setBusy] = useState('');
  const [naming, setNaming] = useState(false);
  const item = detail.data?.item;
  const member = (id: string) => !!detail.data?.memberships?.some(value => value.namespace === 'user' && value.collectionId === id);
  const toggle = async (id: string, name: string) => {
    if (!item) return;
    setBusy(id);
    try {
      const ref = [{ kind: item.kind, id: item.id, revision: item.revision }];
      if (member(id)) { await removeFromCollection(api(), ref, id); showToast({ message: t('cv.coll.removed', { name }) }); }
      else { await addToCollection(api(), ref, id); showToast({ message: t('cv.coll.added', { name }), tone: 'ok' }); }
    } catch (failure) { showToast({ message: libraryErrorText(failure, t, lang), tone: 'danger' }); }
    finally { setBusy(''); }
  };
  return <>
    <Popover open={open} anchor={anchor} onClose={onClose} label={t('cv.coll.title')} width={280} placement="bottom-end" className="cv-lib-pop">
      <div className="cv-lib-head"><div className="cv-lib-title"><b>{t('cv.coll.title')}</b></div></div>
      <div className="cv-pop-scroll" data-testid="cv-collect">
        {!collections.loaded || detail.isPending ? <p className="cv-pop-empty ui-faint"><Spinner size={12} /> {t('cv.lib.loading')}</p>
          : !collections.user.length ? <p className="cv-pop-empty ui-faint">{t('cv.coll.none')}</p>
          : collections.user.map(collection => <div key={collection.id} className={clsx('cv-pop-item', member(collection.id) && 'is-on')}>
            <button type="button" className="cv-pop-main cv-coll-row" disabled={!!busy || !item} aria-pressed={member(collection.id)} onClick={() => void toggle(collection.id, collection.name)} data-testid={`cv-collect-${collection.id}`}>
              <b><Icon name={member(collection.id) ? 'check' : 'collection'} size={13} /> {collection.name}</b>
            </button>
          </div>)}
      </div>
      <div className="cv-pop-foot">
        <Button size="sm" variant="ghost" icon="plus" disabled={!item} onClick={() => { onClose(); setNaming(true); }}>{t('cv.coll.new')}</Button>
      </div>
    </Popover>
    {naming && item && <NameDialog title={t('cv.coll.newTitle')} label={t('cv.coll.name')} confirmLabel={t('c.save')} onClose={() => setNaming(false)} onSubmit={async name => {
      const created = await createCollection(api(), name);
      await addToCollection(api(), [{ kind: item.kind, id: item.id, revision: item.revision }], created.collection.id);
      setNaming(false);
      showToast({ message: t('cv.coll.added', { name: created.collection.name }), tone: 'ok' });
    }} />}
  </>;
}
