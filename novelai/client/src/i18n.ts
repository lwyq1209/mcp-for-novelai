import type { AppLanguage } from "./types";

export interface AppLanguageInfo {
  code: AppLanguage;
  nativeName: string;
  englishName: string;
  menuLabel: string;
}

export const SUPPORTED_APP_LANGUAGES: readonly AppLanguageInfo[] = [
  {
    code: "zh-CN",
    nativeName: "简体中文",
    englishName: "Simplified Chinese",
    menuLabel: "简体中文",
  },
  {
    code: "en-US",
    nativeName: "English",
    englishName: "English",
    menuLabel: "English",
  },
] as const;

const APP_LANGUAGE_CODES = new Set<AppLanguage>(
  SUPPORTED_APP_LANGUAGES.map((item) => item.code),
);

export function isAppLanguage(value: unknown): value is AppLanguage {
  return (
    typeof value === "string" && APP_LANGUAGE_CODES.has(value as AppLanguage)
  );
}

/**
 * zh-CN and en-US read as themselves; any other value (a retired interface language, a system tag, missing or not a
 * string) reads zh-CN when it starts with "zh" and en-US otherwise. The main process already normalizes the saved
 * setting against the system language (electron/ipc/app-language.ts); this only guards values the renderer sees.
 */
export function normalizeAppLanguage(value: unknown): AppLanguage {
  if (isAppLanguage(value)) return value;
  return typeof value === "string" && value.trim().toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * Model, sampler and similar option labels by language (the canvas's selects). (Step 4c2: the old pages' text tables and
 * their get*Text / desktopUiText readers were removed; the interface copy is in src/ui/*.strings.ts.)
 */
const DESKTOP_OPTION_LABELS: Record<
  string,
  Record<AppLanguage, string>
> = {
  "nai-diffusion-5-full": {
    "zh-CN": "NAI Diffusion V5 Full（最新完整模型）",
    "en-US": "NAI Diffusion V5 Full (latest full model)",
  },
  "nai-diffusion-5-curated": {
    "zh-CN": "NAI Diffusion V5 Curated（最新精选模型）",
    "en-US": "NAI Diffusion V5 Curated (latest curated model)",
  },
  "nai-diffusion-4-5-full": {
    "zh-CN": "NAI Diffusion 4.5 Full（完整模型）",
    "en-US": "NAI Diffusion 4.5 Full",
  },
  "nai-diffusion-4-5-curated": {
    "zh-CN": "NAI Diffusion 4.5 Curated（精选模型）",
    "en-US": "NAI Diffusion 4.5 Curated",
  },
  "nai-diffusion-4-full": {
    "zh-CN": "NAI Diffusion 4 Full（完整模型）",
    "en-US": "NAI Diffusion 4 Full",
  },
  "nai-diffusion-4-curated": {
    "zh-CN": "NAI Diffusion 4 Curated（精选模型）",
    "en-US": "NAI Diffusion 4 Curated",
  },
  "nai-diffusion-3": {
    "zh-CN": "NAI Diffusion 3（旧版通用）",
    "en-US": "NAI Diffusion 3 (legacy general)",
  },
  "nai-diffusion-furry-3": {
    "zh-CN": "NAI Diffusion Furry 3（兽人模型）",
    "en-US": "NAI Diffusion Furry 3",
  },
  "nai-diffusion-4-5-full-inpainting": {
    "zh-CN": "NAI Diffusion 4.5 Full Inpaint（推荐）",
    "en-US": "NAI Diffusion 4.5 Full Inpaint (recommended)",
  },
  "nai-diffusion-5-full-inpainting": {
    "zh-CN": "NAI Diffusion V5 Full Inpaint（推荐）",
    "en-US": "NAI Diffusion V5 Full Inpaint (recommended)",
  },
  "nai-diffusion-5-curated-inpainting": {
    "zh-CN": "NAI Diffusion V5 Curated Inpaint",
    "en-US": "NAI Diffusion V5 Curated Inpaint",
  },
  k_euler_ancestral: {
    "zh-CN": "Euler Ancestral（欧拉祖先，推荐）",
    "en-US": "Euler Ancestral (recommended)",
  },
  k_euler: {
    "zh-CN": "Euler（欧拉）",
    "en-US": "Euler",
  },
  k_dpmpp_2m: {
    "zh-CN": "DPM++ 2M（稳定采样）",
    "en-US": "DPM++ 2M",
  },
  k_dpmpp_2m_sde: {
    "zh-CN": "DPM++ 2M SDE（随机微分）",
    "en-US": "DPM++ 2M SDE",
  },
  k_dpmpp_sde: {
    "zh-CN": "DPM++ SDE（高质量随机微分）",
    "en-US": "DPM++ SDE",
  },
  k_dpmpp_2s_ancestral: {
    "zh-CN": "DPM++ 2S Ancestral（祖先采样）",
    "en-US": "DPM++ 2S Ancestral",
  },
  ddim_v3: {
    "zh-CN": "DDIM（快速采样）",
    "en-US": "DDIM (fast)",
  },
  native: {
    "zh-CN": "Native（原生）",
    "en-US": "Native",
  },
  karras: {
    "zh-CN": "Karras（常用）",
    "en-US": "Karras",
  },
  exponential: {
    "zh-CN": "Exponential（指数）",
    "en-US": "Exponential",
  },
  "0": {
    "zh-CN": "Heavy（强负面）",
    "en-US": "Heavy",
  },
  "1": {
    "zh-CN": "Light（轻负面）",
    "en-US": "Light",
  },
  "2": {
    "zh-CN": "Human Focus（人物优先）",
    "en-US": "Human Focus",
  },
  "3": {
    "zh-CN": "None（不使用预设）",
    "en-US": "None",
  },
  "bg-removal": {
    "zh-CN": "移除背景",
    "en-US": "Remove background",
  },
  lineart: {
    "zh-CN": "线稿提取",
    "en-US": "Lineart",
  },
  sketch: {
    "zh-CN": "草图化",
    "en-US": "Sketch",
  },
  colorize: {
    "zh-CN": "上色",
    "en-US": "Colorize",
  },
  emotion: {
    "zh-CN": "表情迁移",
    "en-US": "Emotion transfer",
  },
  declutter: {
    "zh-CN": "去除杂乱",
    "en-US": "Declutter",
  },
  neutral: {
    "zh-CN": "中性（Neutral）",
    "en-US": "Neutral",
  },
  happy: {
    "zh-CN": "开心（Happy）",
    "en-US": "Happy",
  },
  sad: {
    "zh-CN": "悲伤（Sad）",
    "en-US": "Sad",
  },
  angry: {
    "zh-CN": "愤怒（Angry）",
    "en-US": "Angry",
  },
  surprised: {
    "zh-CN": "惊讶（Surprised）",
    "en-US": "Surprised",
  },
  scared: {
    "zh-CN": "害怕（Scared）",
    "en-US": "Scared",
  },
  disgusted: {
    "zh-CN": "厌恶（Disgusted）",
    "en-US": "Disgusted",
  },
  amazed: {
    "zh-CN": "惊叹（Amazed）",
    "en-US": "Amazed",
  },
};

export function localizedDesktopOptionLabel(
  language: unknown,
  value: string | number,
  fallback: string,
) {
  const code = normalizeAppLanguage(language);
  return DESKTOP_OPTION_LABELS[String(value)]?.[code] ?? fallback;
}
