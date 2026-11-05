import { create } from 'zustand';

/**
 * The pages of the new frame. The app opens on the library. Settings is a page of its own (step 4b2, user decision 5)
 * with seven sections; the old section names of the settings dialog (openSettings('api') …) open the matching
 * section. Presentation only: never stored with a recipe or sent to the host.
 */
export type ShellRoute = 'library' | 'canvas' | 'queue' | 'settings';
export type ShellPage = ShellRoute;
export const SHELL_ROUTES: readonly ShellRoute[] = ['library', 'canvas', 'queue', 'settings'];
export const DEFAULT_SHELL_PAGE: ShellPage = 'library';

/** The seven sections of the settings page, in the order of its navigation. */
export const SETTINGS_SECTIONS = ['account', 'mcp', 'queue', 'canvas', 'storage', 'appearance', 'about'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'account';

/** The old settings dialog's section names (and the new ones) → the section of the settings page. */
const LEGACY_SECTIONS: Record<string, SettingsSection> = {
  api: 'account', account: 'account', mcp: 'mcp', queue: 'queue', canvas: 'canvas', prompt: 'canvas', performance: 'canvas',
  storage: 'storage', backup: 'storage', language: 'appearance', appearance: 'appearance', about: 'about',
};
export const settingsSectionOf = (value: unknown): SettingsSection => typeof value === 'string' && Object.hasOwn(LEGACY_SECTIONS, value) ? LEGACY_SECTIONS[value] : DEFAULT_SETTINGS_SECTION;

export const isShellRoute = (value: unknown): value is ShellRoute => typeof value === 'string' && (SHELL_ROUTES as readonly string[]).includes(value);

interface ShellRouteState { page: ShellPage; settingsSection: SettingsSection }
export const useShellRoute = create<ShellRouteState>(() => ({ page: DEFAULT_SHELL_PAGE, settingsSection: DEFAULT_SETTINGS_SECTION }));

/** Opens a page of the frame; settings may name a section (an old dialog section name works too). */
export function navigate(route: ShellRoute, section?: string) {
  const state = useShellRoute.getState();
  const settingsSection = route === 'settings' && section !== undefined ? settingsSectionOf(section) : state.settingsSection;
  if (state.page !== route || state.settingsSection !== settingsSection) useShellRoute.setState({ page: route, settingsSection });
}

/** Opens the settings page at a section (the old openSettings(section) entries). */
export const openSettingsSection = (section?: string) => navigate('settings', section ?? useShellRoute.getState().settingsSection);

/** The route the top bar shows as current. */
export function visibleRoute(page: ShellPage): ShellRoute {
  return page;
}
