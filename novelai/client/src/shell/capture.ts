import type { UiLang } from '../ui/i18n';

/**
 * UI capture of the new pages (step 4b1). In capture mode only (the window was started with NAI_UI_CAPTURE_PATH, see
 * electron/ui-capture-guard.ts) the main process passes uiCapture and uiCapturePage in the URL; a normal start has
 * neither. The page name is the capture file name without ".png"; a trailing -zh or -en picks the language.
 * Only the names below open a new page with sample data; anything else is ignored here and keeps the existing
 * capture behaviour (uiCapture) of the old pages.
 */
export const CAPTURE_PAGES = [
  'library', 'library-detail', 'library-reuse-menu', 'library-detail-info', 'library-multiselect', 'library-delete-confirm',
  'library-clear-archived', 'library-project', 'library-tags-tray', 'library-presets', 'library-imports', 'library-imports-read',
  'library-empty', 'trash', 'trash-purge', 'shell-canvas', 'shell-queue', 'shell-settings',
  // Review rework: the two confirmations of 清空最近删除, and the first of a multi-round 清空已归档.
  'trash-empty', 'trash-empty-confirm', 'library-clear-archived-round',
  // The library on the run's own (fresh, empty) data root through the real host IPC, without sample data.
  'library-host',
  // Step 4c1: a large library on the run's own data root (e.g. seed-library's 10 000 images), through the real host
  // IPC: the history scrolled to its middle image, and that image opened in the drawer.
  'library-host-scrolled', 'library-host-detail',
  // Step 4b2: the queue page (prototype 17–19), the settings page (22–29) and the first-run guide (30–33). The queue
  // shows the sample batches; settings and the guide read this run's own data root through the real host IPC, with a
  // sample account, agent activity and update where the prototype shows them. queue-partial (2026-12) replaced
  // queue-halted: a batch no longer pauses itself; it goes on past a failed or unknown image and ends partly done.
  'queue', 'queue-partial', 'queue-unknown', 'queue-blocked', 'queue-failed', 'queue-empty',
  'settings-account', 'settings-mcp', 'settings-mcp-cursor', 'settings-mcp-codex', 'settings-mcp-pi', 'settings-mcp-other',
  'settings-queue', 'settings-canvas', 'settings-storage', 'settings-appearance', 'settings-about', 'settings-about-update',
  'onboarding-1', 'onboarding-2', 'onboarding-2-connected', 'onboarding-3',
] as const;
export type CapturePage = typeof CAPTURE_PAGES[number];
export interface CaptureRequest { page: CapturePage; lang: UiLang | null }

const SAFE = /^[A-Za-z0-9-]{1,80}$/;

/** Pages that show the run's own data root through the host IPC (no sample data). */
export const hostCapture = (page: CapturePage) => page === 'library-host' || page.startsWith('library-host-');

/** The new-page capture this URL asks for, or null (not a capture run, an unsafe value or an unknown page). */
export function captureRequest(search: string): CaptureRequest | null {
  const params = new URLSearchParams(search);
  if (!params.has('uiCapture')) return null;
  const raw = params.get('uiCapturePage') ?? '';
  if (!SAFE.test(raw)) return null;
  const match = /^(.*?)(?:-(zh|en))?$/.exec(raw.replace(/^\d+-/, ''));
  const page = match?.[1] ?? '';
  if (!(CAPTURE_PAGES as readonly string[]).includes(page)) return null;
  return { page: page as CapturePage, lang: (match?.[2] as UiLang | undefined) ?? null };
}

let cached: CaptureRequest | null | undefined;
/** The capture request of this window, read once. */
export function windowCaptureRequest(): CaptureRequest | null {
  if (cached !== undefined) return cached;
  cached = typeof window === 'undefined' ? null : captureRequest(window.location.search);
  return cached;
}
