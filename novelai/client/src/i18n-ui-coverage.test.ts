import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cross-client UI localization coverage", () => {
  it("keeps localized calls at the formerly mixed-language desktop surfaces", () => {
    const files = [
      "src/components/AppErrorBoundary.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain(">暂无可用参考图<");
      expect(source).not.toContain(">正在读取资源状态…<");
      expect(source).not.toContain("当前来源：${info.label}");
    }
  });
});
