import { Seg, Toggle } from '../../ui';
import { appLanguageOf, uiText, useUiText, type UiLang } from '../../ui/i18n';
import { SettingsGroup, SettingsRow, useSettingWriter, useSettings } from './common';

/**
 * Settings › Appearance & language (prototype 28, without theme and thumbnail size: dark only, user decision 1):
 * the interface language (中文 / English, user decision 10) and the app's own reduce-motion switch.
 */
export function AppearanceSection() {
  const { t, lang } = useUiText();
  const settings = useSettings();
  const update = useSettingWriter();
  const setLanguage = (next: UiLang) => { if (next !== lang) void update('language', appLanguageOf(next)); };
  return <section className="sp-section" data-testid="settings-appearance">
    <h2>{t('set.appearance')}</h2>
    <SettingsGroup>
      <SettingsRow label={t('set.ap.lang')}>
        {/* Each language is named in its own language. */}
        <Seg label={t('set.ap.lang')} value={lang} onChange={setLanguage} options={[
          { value: 'zh', label: <span lang="zh-CN">{uiText('zh', 'set.ap.langZh')}</span> },
          { value: 'en', label: <span lang="en">{uiText('en', 'set.ap.langEn')}</span> },
        ]} />
      </SettingsRow>
      {settings ? <SettingsRow label={t('set.ap.motion')} hint={t('set.ap.motionHint')}>
        <Toggle checked={settings.reduceMotion === true} label={t('set.ap.motion')} onChange={value => void update('reduceMotion', value)} />
      </SettingsRow> : null}
    </SettingsGroup>
  </section>;
}
