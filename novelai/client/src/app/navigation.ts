export const ACTIVE_TABS = [
  "generate",
  "inpaint",
  "postprocess",
  "metadata",
  "tools",
  "referencePresets",
] as const;

export type ActiveTab = (typeof ACTIVE_TABS)[number];

const ACTIVE_TAB_SET = new Set<string>(ACTIVE_TABS);

export function isActiveTab(value: unknown): value is ActiveTab {
  return typeof value === "string" && ACTIVE_TAB_SET.has(value);
}

/** The page to open for a requested tab: any page id this version does not know opens generate. */
export function restorableActiveTab(value: unknown): ActiveTab {
  return isActiveTab(value) ? value : "generate";
}

