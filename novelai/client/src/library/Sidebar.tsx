import clsx from 'clsx';
import type { AssetCollection } from '../asset-library/types';
import { Icon, IconButton, MenuButton, Tooltip, type IconName, type MenuEntry } from '../ui';
import { formatNumber, useUiText } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import type { CategoryCounts } from './data';
import { sameView, type LibraryCategory, type LibraryView } from './model';

const IMAGE_SECTIONS: Array<{ category: LibraryCategory; icon: IconName; label: UiStringKey }> = [
  { category: 'history', icon: 'history', label: 'side.history' },
  { category: 'imports', icon: 'imported', label: 'side.imports' },
];
const PROMPT_SECTIONS: Array<{ category: LibraryCategory; icon: IconName; label: UiStringKey }> = [
  { category: 'tags', icon: 'tag', label: 'side.tags' },
  { category: 'combos', icon: 'combo', label: 'side.combos' },
  { category: 'notes', icon: 'note', label: 'side.notes' },
  { category: 'presets', icon: 'preset', label: 'side.presets' },
  { category: 'artists', icon: 'palette', label: 'side.artists' },
];

export interface SidebarProps {
  view: LibraryView;
  onView(view: LibraryView): void;
  counts: CategoryCounts;
  collections: readonly AssetCollection[];
  projects: readonly AssetCollection[];
  memberCounts: Readonly<Record<string, number>>;
  onNewCollection(): void;
  collectionMenu(collection: AssetCollection): MenuEntry[];
  projectMenu(project: AssetCollection): MenuEntry[];
}

/** The library's section list (prototype 01): images, prompt materials, collections, projects, Recently deleted. */
export function Sidebar({ view, onView, counts, collections, projects, memberCounts, onNewCollection, collectionMenu, projectMenu }: SidebarProps) {
  const { t, lang } = useUiText();
  const item = (target: LibraryView, icon: IconName, label: string, count: number | undefined, key: string, menu?: { label: string; entries: MenuEntry[] }) => {
    const on = sameView(view, target);
    return <div key={key} className={clsx('lib-side-row', on && 'is-on')}>
      <button type="button" className="lib-side-item" aria-current={on ? 'page' : undefined} onClick={() => onView(target)}>
        <Icon name={icon} size={16} /><span className="lib-side-name">{label}</span>
        {count !== undefined && <span className="lib-side-n ui-num">{formatNumber(count, lang)}</span>}
      </button>
      {menu && <MenuButton label={menu.label} entries={menu.entries} placement="bottom-end">{trigger => <IconButton {...trigger} className="lib-side-more" size="sm" icon="more" label={menu.label} />}</MenuButton>}
    </div>;
  };
  return <nav className="lib-side" aria-label={t('side.label')}>
    <h2 className="lib-side-h">{t('side.images')}</h2>
    {IMAGE_SECTIONS.map(section => item({ type: 'category', category: section.category }, section.icon, t(section.label), counts[section.category], section.category))}
    <h2 className="lib-side-h">{t('side.prompting')}</h2>
    {PROMPT_SECTIONS.map(section => item({ type: 'category', category: section.category }, section.icon, t(section.label), counts[section.category], section.category))}
    <h2 className="lib-side-h"><span>{t('side.collections')}</span><IconButton size="sm" icon="plus" label={t('side.newCollection')} onClick={onNewCollection} /></h2>
    {collections.length === 0 && <p className="lib-side-empty">{t('side.noCollections')}</p>}
    {collections.map(collection => item({ type: 'collection', id: collection.id }, 'collection', collection.name, memberCounts[collection.id], collection.id, { label: t('side.collectionMenu', { name: collection.name }), entries: collectionMenu(collection) }))}
    <h2 className="lib-side-h"><Tooltip content={t('side.projectsTip')} placement="bottom"><span className="lib-side-h-tip" tabIndex={0}>{t('side.projects')}<Icon name="info" size={12} /></span></Tooltip></h2>
    {projects.length === 0 && <p className="lib-side-empty">{t('side.noProjects')}</p>}
    {projects.map(project => item({ type: 'project', id: project.id }, 'group', project.name, memberCounts[project.id], project.id, { label: t('side.projectMenu', { name: project.name }), entries: projectMenu(project) }))}
    <div className="lib-side-spacer" />
    <div className="lib-side-foot">{item({ type: 'trash' }, 'trash', t('side.trash'), counts.trash, 'trash')}</div>
  </nav>;
}
