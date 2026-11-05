import type { AppLanguage } from "./types";

// Localized names for reference presets that carry the original downloadable
// catalog's game/category grouping (sourceGameId, sourceCategory or a
// "<game> · <category>" group). The online catalog itself was removed; these
// labels keep already-saved local presets readable in every UI language.

export type ReferencePresetSourceCategory = "游戏内角色图" | "角色立绘" | "角色资源";

export const REFERENCE_PRESET_GAME_NAMES: Record<string, Record<AppLanguage, string>> = {
  "原神": { "zh-CN": "原神", "en-US": "Genshin Impact" },
  "妮姬": { "zh-CN": "胜利女神：妮姬", "en-US": "GODDESS OF VICTORY: NIKKE" },
  "崩坏三": { "zh-CN": "崩坏3", "en-US": "Honkai Impact 3rd" },
  "异环": { "zh-CN": "异环", "en-US": "Neverness to Everness" },
  "明日方舟": { "zh-CN": "明日方舟", "en-US": "Arknights" },
  "星穹铁道": { "zh-CN": "崩坏：星穹铁道", "en-US": "Honkai: Star Rail" },
  "终末地": { "zh-CN": "明日方舟：终末地", "en-US": "Arknights: Endfield" },
  "绝区零": { "zh-CN": "绝区零", "en-US": "Zenless Zone Zero" },
  "蔚蓝档案": { "zh-CN": "蔚蓝档案", "en-US": "Blue Archive" },
  "鸣潮": { "zh-CN": "鸣潮", "en-US": "Wuthering Waves" },
};

const REFERENCE_PRESET_CATEGORY_NAMES: Record<ReferencePresetSourceCategory, Record<AppLanguage, string>> = {
  "游戏内角色图": { "zh-CN": "游戏内角色图", "en-US": "In-game character" },
  "角色立绘": { "zh-CN": "角色立绘", "en-US": "Character illustration" },
  "角色资源": { "zh-CN": "角色资源", "en-US": "Character resource" },
};

export function catalogGameName(game: string, language: AppLanguage | undefined, names?: Partial<Record<AppLanguage, string>>) {
  const locale = language ?? "zh-CN";
  return names?.[locale] || names?.["zh-CN"] || REFERENCE_PRESET_GAME_NAMES[game]?.[locale] || REFERENCE_PRESET_GAME_NAMES[game]?.["zh-CN"] || game;
}

export function catalogCategoryName(category: string, language: AppLanguage | undefined) {
  const locale = language ?? "zh-CN";
  return REFERENCE_PRESET_CATEGORY_NAMES[category as ReferencePresetSourceCategory]?.[locale] || category;
}

export function catalogGroupName(group: string, language: AppLanguage | undefined) {
  const [game, category, ...rest] = group.split(" · ");
  if (!category || rest.length || !REFERENCE_PRESET_GAME_NAMES[game]) return catalogGameName(group, language);
  return `${catalogGameName(game, language)} · ${catalogCategoryName(category, language)}`;
}
