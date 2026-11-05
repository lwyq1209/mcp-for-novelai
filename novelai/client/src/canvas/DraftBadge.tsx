import { useUiText } from '../ui/i18n';

/** The cyan "draft" badge beside a section an agent draft would change (prototype 13): the value itself is unchanged. */
export function DraftBadge() {
  const { t } = useUiText();
  return <span className="ui-tag ui-tag--agent cv-draft-badge">{t('cv.draft.badge')}</span>;
}
