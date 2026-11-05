import { describe, expect, it } from "vitest";
import { catalogCategoryName, catalogGameName, catalogGroupName } from "./reference-preset-names";

describe("reference preset source labels", () => {
  it("uses the active app language for game, category and group labels", () => {
    expect(catalogGameName("原神", "en-US", { "zh-CN": "原神", "en-US": "Genshin Impact" })).toBe("Genshin Impact");
    expect(catalogGameName("原神", "en-US")).toBe("Genshin Impact");
    expect(catalogGameName("原神", "zh-CN")).toBe("原神");
    expect(catalogCategoryName("游戏内角色图", "en-US")).toBe("In-game character");
    expect(catalogGroupName("原神 · 游戏内角色图", "en-US")).toBe("Genshin Impact · In-game character");
    expect(catalogGroupName("原神 · 游戏内角色图", "zh-CN")).toBe("原神 · 游戏内角色图");
  });

  it("leaves user-defined groups and unknown games unchanged", () => {
    expect(catalogGroupName("my group", "en-US")).toBe("my group");
    expect(catalogGroupName("Unknown · 角色立绘", "en-US")).toBe("Unknown · 角色立绘");
    expect(catalogCategoryName("custom", "zh-CN")).toBe("custom");
  });
});
