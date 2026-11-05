// Tag-autocomplete data: category colors/labels, Chinese tag glosses and the
// top-level tab list. Pure data + helpers, extracted from App.tsx for clarity.
import type { TagSuggestion } from "./types";

/** CSS color per Danbooru tag category */
export const CAT_COLOR: Record<number, string> = {
  0: "#4ade80", // general
  1: "#fb923c", // artist
  3: "#a78bfa", // copyright
  4: "#60a5fa", // character
  5: "#94a3b8", // meta
};

export const CAT_LABEL: Record<number, string> = {
  0: "通用",
  1: "画师",
  3: "作品",
  4: "角色",
  5: "元信息",
};

const CAT_LABEL_LOCALE: Record<"zh-CN" | "en-US", Record<number, string>> = {
  "zh-CN": CAT_LABEL,
  "en-US": { 0: "General", 1: "Artist", 3: "Copyright", 4: "Character", 5: "Meta" },
};

const COMMON_TAG_GLOSS: Record<"zh-CN" | "en-US", Record<string, string>> = {
  "zh-CN": {
    "1girl": "一个女孩",
    "1boy": "一个男孩",
    solo: "单人",
    "long hair": "长发",
    "short hair": "短发",
    twintails: "双马尾",
    ponytail: "马尾",
    "blonde hair": "金发",
    "black hair": "黑发",
    "white hair": "白发",
    "blue hair": "蓝发",
    "red hair": "红发",
    "pink hair": "粉发",
    "blue eyes": "蓝眼",
    "red eyes": "红眼",
    "green eyes": "绿眼",
    smile: "微笑",
    blush: "脸红",
    "open mouth": "张嘴",
    "looking at viewer": "看向观众",
    dress: "连衣裙",
    "school uniform": "校服",
    gloves: "手套",
    "hair ornament": "发饰",
    "simple background": "简单背景",
    outdoors: "户外",
    indoors: "室内",
    night: "夜晚",
    "starry sky": "星空",
    cityscape: "城市景观",
    classroom: "教室",
    masterpiece: "杰作",
    "best quality": "最佳质量",
    "very aesthetic": "高审美",
  },
  "en-US": {},
};

/** Same rule as normalizeAppLanguage in i18n.ts (which imports this module): zh* reads Chinese, anything else English. */
function normalizeLanguage(language: unknown): "zh-CN" | "en-US" {
  return typeof language === "string" && language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function readableTag(tag: string): string {
  return tag.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function localizedCategoryLabel(category: number, language?: unknown): string {
  const code = normalizeLanguage(language);
  return CAT_LABEL_LOCALE[code][category] ?? CAT_LABEL[category] ?? "Tag";
}

export function localizedTagLabel(tag: string, sourceLabel?: string, language?: unknown): string {
  const code = normalizeLanguage(language);
  const normalized = readableTag(tag).toLowerCase();
  if (code === "zh-CN") return sourceLabel?.trim() || TAG_ZH[normalized] || COMMON_TAG_GLOSS["zh-CN"][normalized] || readableTag(tag);
  return COMMON_TAG_GLOSS["en-US"][normalized] || readableTag(tag);
}

export const TAG_ZH: Record<string, string> = {
  "1girl": "一个女孩 / 单女性角色",
  "1boy": "一个男孩 / 单男性角色",
  solo: "单人画面",
  "long hair": "长发",
  "short hair": "短发",
  "blonde hair": "金发",
  "black hair": "黑发",
  "white hair": "白发",
  "blue hair": "蓝发",
  "red hair": "红发",
  "pink hair": "粉发",
  "green hair": "绿发",
  "blue eyes": "蓝眼睛",
  "green eyes": "绿眼睛",
  "red eyes": "红眼睛",
  "yellow eyes": "黄眼睛 / 金色眼睛",
  gloves: "手套",
  "black gloves": "黑色手套",
  "white gloves": "白色手套",
  dress: "连衣裙",
  "white dress": "白色连衣裙",
  "school uniform": "校服",
  skirt: "裙子",
  smile: "微笑",
  "looking at viewer": "看向观众 / 正视镜头",
  "open mouth": "张嘴",
  "hair ornament": "发饰",
  earrings: "耳环",
  "male focus": "男性为主体",
  "grey eyes": "灰色眼睛",
  "simple background": "简单背景",
  outdoors: "户外",
  night: "夜晚",
  city: "城市",
  masterpiece: "杰作 / 高质量修饰词",
  "best quality": "最佳质量修饰词",
  "very aesthetic": "高审美质量修饰词",
  "artist name": "画师名占位标签",
};

export function tagDescription(s: TagSuggestion, language?: unknown): string {
  return localizedTagLabel(s.tag, s.description, language) || `${localizedCategoryLabel(s.category, language)} category`;
}
