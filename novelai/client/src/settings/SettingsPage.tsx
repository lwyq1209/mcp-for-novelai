import clsx from 'clsx';
import { Icon, type IconName } from '../ui';
import { useUiText } from '../ui/i18n';
import type { UiStringKey } from '../ui/strings';
import type { CaptureRequest } from '../shell/capture';
import { navigate, SETTINGS_SECTIONS, type SettingsSection } from '../shell/route';
import { useAppStore } from '../store';
import { McpSection } from './mcp/McpSection';
import { AccountSection } from './sections/AccountSection';
import { QueueSection } from './sections/QueueSection';
import { CanvasSection } from './sections/CanvasSection';
import { StorageSection } from './sections/StorageSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { AboutSection } from './sections/AboutSection';
import './settings.css';

const NAV: Record<SettingsSection, { icon: IconName; label: UiStringKey }> = {
  account: { icon: 'key', label: 'set.account' },
  mcp: { icon: 'plug', label: 'set.mcp' },
  queue: { icon: 'queue', label: 'set.queue' },
  canvas: { icon: 'canvas', label: 'set.canvas' },
  storage: { icon: 'drive', label: 'set.storage' },
  appearance: { icon: 'palette', label: 'set.appearance' },
  about: { icon: 'info', label: 'set.about' },
};

export interface SettingsPageProps {
  section: SettingsSection;
  /** The page is shown (hidden pages stay mounted). */
  active: boolean;
  capture?: CaptureRequest | null;
}

/** The settings page (step 4b2, prototype 22–29): navigation on the left, one section at a time. */
export function SettingsPage({ section, active, capture = null }: SettingsPageProps) {
  const { t } = useUiText();
  const updateAvailable = useAppStore(state => !!state.updateInfo?.hasUpdate);
  return <div className="ui-scope sp-page" data-testid="settings-page" data-section={section}>
    <nav className="sp-nav" aria-label={t('set.nav')}>
      <h1>{t('set.title')}</h1>
      {SETTINGS_SECTIONS.map(value => <button key={value} type="button" className={clsx('sp-nav-item', value === section && 'is-on')} aria-current={value === section ? 'page' : undefined} onClick={() => navigate('settings', value)} data-testid={`settings-nav-${value}`}>
        <Icon name={NAV[value].icon} size={16} /><span>{t(NAV[value].label)}</span>{value === 'about' && updateAvailable ? <i className="sp-nav-dot" aria-hidden="true" /> : null}
      </button>)}
    </nav>
    <div className="sp-content" data-testid="settings-content">
      <div className="sp-inner">
        {section === 'mcp' ? <McpSection active={active} capture={capture} />
          : section === 'account' ? <AccountSection />
          : section === 'queue' ? <QueueSection />
          : section === 'canvas' ? <CanvasSection />
          : section === 'storage' ? <StorageSection active={active} />
          : section === 'appearance' ? <AppearanceSection />
          : <AboutSection />}
      </div>
    </div>
  </div>;
}
