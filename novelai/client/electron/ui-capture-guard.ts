import { DATA_DIR_ENV, isCustomDataRoot } from "../shared/runtime/data-paths.cjs";

/**
 * UI capture (NAI_UI_CAPTURE_PATH) is a development tool that starts a full client without a visible window. It
 * must never run on the real data folder, so it requires NOVELAI_DATA_DIR naming another folder than the default data
 * root (isCustomDataRoot; set to the default root itself, it is the real data folder): otherwise main.ts refuses to
 * start, before the data folder is created or touched. Returns the refusal text, or null when the run may start.
 */
export function uiCaptureRefusal(env: NodeJS.ProcessEnv, options: { platform?: string; homedir?: string } = {}): string | null {
  if (!env.NAI_UI_CAPTURE_PATH?.trim() || isCustomDataRoot({ ...options, env })) return null;
  return [
    `UI capture (NAI_UI_CAPTURE_PATH) needs its own data folder: set ${DATA_DIR_ENV} to a throwaway folder and run it again.`,
    "Nothing was started, so the real data folder was not created or changed.",
    `界面截图模式（NAI_UI_CAPTURE_PATH）需要单独的数据文件夹：请把 ${DATA_DIR_ENV} 设为一个临时文件夹后重新运行。本次没有启动，真实数据文件夹未被创建或改动。`,
    "",
  ].join("\n");
}

/** A capture page name: letters, digits and "-", 1–80 characters (step 4b1). */
const CAPTURE_PAGE = /^[A-Za-z0-9-]{1,80}$/;

/**
 * The page a capture run names by its file (step 4b1): the file name without ".png", when it is only letters, digits
 * and "-"; null for any other name and outside capture mode (no NAI_UI_CAPTURE_PATH). The window opens that page with
 * sample data only when it was started for a capture (see uiCaptureLoadOptions).
 */
export function uiCapturePageName(capturePath: string | undefined): string | null {
  const value = capturePath?.trim();
  if (!value) return null;
  const name = value.replaceAll("\\", "/").split("/").pop() ?? "";
  if (!/\.png$/i.test(name)) return null;
  const page = name.slice(0, -4);
  return CAPTURE_PAGE.test(page) ? page : null;
}

/**
 * The loadFile options of the main window: undefined outside capture mode, so a normal start never carries capture
 * parameters in its URL; in capture mode the given query plus uiCapturePage (the safe page name, else empty).
 */
export function uiCaptureLoadOptions(capturePath: string | undefined, query: Record<string, string>): { query: Record<string, string> } | undefined {
  if (!capturePath?.trim()) return undefined;
  return { query: { ...query, uiCapturePage: uiCapturePageName(capturePath) ?? "" } };
}

/**
 * The main window size (step 4b1): a capture whose path has a /w1440/ folder is 1440×900, as the interface design's
 * screenshots; one with /compact/ is 1120×760; every other start (and capture) keeps 1385×900.
 */
export function mainWindowSize(capturePath: string | undefined): { width: number; height: number } {
  const value = capturePath?.trim().replaceAll("\\", "/").toLowerCase() ?? "";
  if (value && value.includes("/w1440/")) return { width: 1440, height: 900 };
  if (value && value.includes("/compact/")) return { width: 1120, height: 760 };
  return { width: 1385, height: 900 };
}
