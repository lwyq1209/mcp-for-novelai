import type { AssetItem } from '../asset-library/types';
import type { CapturePage } from '../shell/capture';
import type { ImageTab } from './ImageDetail';
import type { LibraryView } from './model';

/**
 * UI capture scenarios of the library page (step 4b1): the states of the prototype's screenshots 01–12, 20 and 21,
 * on the sample data of capture-fixture.ts (ids h1…h40, t1…, user:c1…, history:cafe…, x1…). Capture runs only.
 */
export interface LibraryScenario {
  view?: LibraryView;
  open?: { kind: AssetItem['kind']; id: string };
  tab?: ImageTab;
  /** Item ids selected (selection mode on). */
  selected?: string[];
  /** Tag ids put on the combo tray. */
  tray?: string[];
  dialog?: 'delete' | 'archived' | 'purge';
  /** data-capture name of a control clicked once the page shows (opens a menu). */
  click?: string;
  /** The 导入图片 reading dialog with the sample image. */
  importFile?: boolean;
  trashSelected?: string[];
  /** 清空最近删除 opened at its first or second confirmation. */
  trashEmpty?: 1 | 2;
  /** Host-backed large-library captures (step 4c1): the history scrolled to its middle image, or that image opened. */
  hostMiddle?: 'scroll' | 'open';
}

const SIX = ['h1', 'h2', 'h3', 'h5', 'h6', 'h7'];
const SCENARIOS: Partial<Record<CapturePage, LibraryScenario>> = {
  library: {},
  'library-detail': { open: { kind: 'history', id: 'h1' }, tab: 'prompt' },
  'library-reuse-menu': { open: { kind: 'history', id: 'h1' }, tab: 'prompt', click: 'reuse' },
  'library-detail-info': { open: { kind: 'history', id: 'h2' }, tab: 'info' },
  'library-multiselect': { selected: SIX },
  'library-delete-confirm': { selected: SIX, dialog: 'delete' },
  'library-clear-archived': { dialog: 'archived' },
  'library-project': { view: { type: 'project', id: 'history:cafe' }, open: { kind: 'history', id: 'h5' }, tab: 'params' },
  'library-tags-tray': { view: { type: 'category', category: 'tags' }, open: { kind: 'tag', id: 't1' }, tray: ['t4', 't1', 't7'] },
  'library-presets': { view: { type: 'category', category: 'presets' } },
  'library-imports': { view: { type: 'category', category: 'imports' } },
  'library-imports-read': { view: { type: 'category', category: 'imports' }, importFile: true },
  'library-empty': { view: { type: 'collection', id: 'user:c4' } },
  trash: { view: { type: 'trash' } },
  'trash-purge': { view: { type: 'trash' }, trashSelected: ['x3', 'x7'], dialog: 'purge' },
  'trash-empty': { view: { type: 'trash' }, trashEmpty: 1 },
  'trash-empty-confirm': { view: { type: 'trash' }, trashEmpty: 2 },
  'library-clear-archived-round': { dialog: 'archived' },
  'library-host-scrolled': { hostMiddle: 'scroll' },
  'library-host-detail': { hostMiddle: 'open', tab: 'prompt' },
};

export function captureScenario(page: CapturePage): LibraryScenario | null {
  return SCENARIOS[page] ?? null;
}
