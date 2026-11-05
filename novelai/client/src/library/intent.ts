import { create } from 'zustand';
import type { AssetItem } from '../asset-library/types';
import { navigate } from '../shell/route';
import type { LibraryView } from './model';

/**
 * Another page asks the library to show something (step 4b2): the queue page opens a finished image in the detail
 * drawer, or the images of a batch's project. Each request has its own sequence number, so asking for the same item
 * twice opens it twice. Presentation only.
 */
export interface LibraryIntent { seq: number; view?: LibraryView; open?: { kind: AssetItem['kind']; id: string } }
export const useLibraryIntent = create<{ intent: LibraryIntent | null }>(() => ({ intent: null }));

let sequence = 0;
/** Shows the library with this view (default: history) and, optionally, this item's detail. */
export function openInLibrary(target: Omit<LibraryIntent, 'seq'>) {
  sequence += 1;
  useLibraryIntent.setState({ intent: { seq: sequence, ...target } });
  navigate('library');
}
