import { Button, MenuButton, type MenuEntry } from '../ui';
import { useUiText } from '../ui/i18n';

export interface SelectionBarProps {
  count: number;
  /** Selected items the current view does not show (selected before a search or filter). */
  outside?: number;
  allSelected: boolean;
  /** 全选 takes the loaded items only: their number when more could load (the button says so). */
  loaded?: number;
  onAll(): void;
  collectEntries: MenuEntry[];
  /** Images only: 移到项目 and 导出. */
  projectEntries?: MenuEntry[];
  onExport?(): void;
  archived: boolean;
  onArchive(): void;
  onDelete(): void;
  onDone(): void;
}

/** The floating bar of a multiple selection (prototype 05). */
export function SelectionBar({ count, outside = 0, allSelected, loaded, onAll, collectEntries, projectEntries, onExport, archived, onArchive, onDelete, onDone }: SelectionBarProps) {
  const { t } = useUiText();
  const none = count === 0;
  return <div className="lib-selbar" role="toolbar" aria-label={t('sel.label')} data-testid="selection-bar">
    <span className="lib-selbar-count ui-num" aria-live="polite">{t('sel.count', { n: count })}{outside > 0 && <span className="lib-selbar-out" data-testid="selection-outside"> · {t('sel.outside', { n: outside })}</span>}</span>
    <Button size="sm" variant="ghost" onClick={onAll} data-testid="selection-all">{allSelected ? t('sel.none') : loaded !== undefined ? t('sel.allLoaded', { n: loaded }) : t('sel.all')}</Button>
    <span className="lib-selbar-sep" aria-hidden="true" />
    <MenuButton label={t('sel.collect')} entries={collectEntries} placement="top-start">{trigger => <Button {...trigger} size="sm" variant="ghost" icon="collection" disabled={none}>{t('sel.collect')}</Button>}</MenuButton>
    {projectEntries && <MenuButton label={t('sel.project')} entries={projectEntries} placement="top-start">{trigger => <Button {...trigger} size="sm" variant="ghost" icon="group" disabled={none}>{t('sel.project')}</Button>}</MenuButton>}
    {onExport && <Button size="sm" variant="ghost" icon="download" disabled={none} onClick={onExport}>{t('sel.export')}</Button>}
    <Button size="sm" variant="ghost" icon="archive" disabled={none} onClick={onArchive}>{archived ? t('sel.unarchive') : t('sel.archive')}</Button>
    <span className="lib-selbar-sep" aria-hidden="true" />
    <Button size="sm" variant="dangerGhost" icon="trash" disabled={none} onClick={onDelete} data-testid="selection-delete">{t('sel.delete')}</Button>
    <Button size="sm" onClick={onDone}>{t('sel.done')}</Button>
  </div>;
}
