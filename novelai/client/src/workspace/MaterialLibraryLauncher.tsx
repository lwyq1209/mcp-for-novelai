import { useEffect, useState } from 'react';
import { subscribeAssetLibraryChanges, watchAssetLibraryChanges } from '../asset-library/query';
import { libraryReadModelErrorText, nextLibraryReadModelErrors, refreshLibraryReadModels, settleLibraryReadModels, type LibraryReadModelErrors } from './library-read-models';
import { useAppStore } from '../store';

/**
 * The library's background read models (settings, history items) re-read when the library changes, whichever page is
 * shown; a failed read shows its error here. (Step 4c2: the old material sidebar that lived in this file was removed.)
 */
export function MaterialLibraryLauncher() {
  const [errors, setErrors] = useState<LibraryReadModelErrors>({});
  useEffect(() => watchAssetLibraryChanges(window.naiDesktop), []);
  // Same coalesced batches as the query invalidation; only affected read models re-read.
  useEffect(() => subscribeAssetLibraryChanges(window.naiDesktop, batch => {
    const store = useAppStore.getState();
    const reads = refreshLibraryReadModels(batch, { refreshSettings: store.refreshSettings, refreshHistoryItems: store.refreshHistoryItems });
    if (!reads.length) return;
    // Each read model clears only its own error, and only when it read successfully.
    void settleLibraryReadModels(reads).then(outcome => setErrors(previous => nextLibraryReadModelErrors(previous, outcome)));
  }), []);
  // Rendered now, in the current interface language (also after switching it).
  const language = useAppStore(state => state.settings?.language);
  const error = libraryReadModelErrorText(errors, language);
  return error ? <p role="alert" className="material-background-error">{error}</p> : null;
}
