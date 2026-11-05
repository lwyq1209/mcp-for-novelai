import { describe, expect, it } from "vitest";
import { hostErrorText } from "./index";
import { LIBRARY_ERROR_TEXTS } from "./library";

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();

describe("library host error catalog", () => {
  it("renders Recently Deleted errors with their params in both languages", () => {
    const error = { code: "library_conflict", message: "history:a changed (current revision 3); read it again.", reason: "trash.item_changed", params: { item: "history:a", revision: 3 } };
    expect(hostErrorText(error, "zh-CN")).toBe("history:a 已被修改（当前版本 3），请回读。");
    expect(hostErrorText(error, "en-US")).toBe("history:a changed (current revision 3); read it again.");
  });

  it("renders material library errors", () => {
    const error = { code: "invalid_argument", message: "entry has unsupported fields: x, y.", reason: "material.unsupported_fields_at", params: { where: "entry", fields: "x, y" } };
    expect(hostErrorText(error, "zh-CN")).toBe("entry 含有不支持的字段：x, y。");
    expect(hostErrorText(error, "en-US")).toBe("entry has unsupported fields: x, y.");
    const trashed = { code: "library_not_found", message: "This item is in Recently Deleted (trashId t1); restore it first.", reason: "library.item_in_trash", params: { trashId: "t1" } };
    expect(hostErrorText(trashed, "zh-CN")).toBe("这份素材在「最近删除」中（trashId t1）；请先用 restore 恢复。");
  });

  it("renders study errors", () => {
    const error = { code: "study_busy", message: "Too many study files are pending; wait for the current imports to finish.", reason: "study.busy" };
    expect(hostErrorText(error, "zh-CN")).toBe("研读待处理文件已满，请等已有导入结束。");
    expect(hostErrorText(error, "en-US")).toBe("Too many study files are pending; wait for the current imports to finish.");
    expect(hostErrorText({ code: "image_too_large", message: "x", reason: "library.study_image_pixels" }, "zh-CN")).toBe("研读图片超过 3200 万像素。");
    expect(hostErrorText({ code: "image_too_large", message: "x", reason: "library.history_image_pixels" }, "en-US")).toBe("The history image exceeds 32 million pixels.");
  });

  it("renders tag cover errors", () => {
    const error = { code: "cover_conflict", message: "The cover changed; read it again before uploading.", reason: "cover.changed_upload" };
    expect(hostErrorText(error, "zh-CN")).toBe("封面已修改，请回读后再上传。");
    expect(hostErrorText(error, "en-US")).toBe("The cover changed; read it again before uploading.");
  });

  it("renders the codes a material import reports inside its result, and its fixed note", () => {
    expect(hostErrorText({ code: "material_busy", message: "Material reads are full; try again later. The generation queue is not affected." }, "zh-CN")).toBe("素材读取已满，请稍后重试；生成队列不受影响。");
    expect(hostErrorText({ reason: "material.import_partial_note" }, "en-US")).toBe("Imported entries are kept; do not import the whole backup again.");
    expect(hostErrorText({ code: "cover_invalid_image", message: "A backup cover cannot be decoded." }, "zh-CN")).toBe("A backup cover cannot be decoded.");
  });

  it("falls back to the message when the catalog does not know the error", () => {
    expect(hostErrorText({ code: "invalid_argument", message: "Invalid library kind." }, "zh-CN")).toBe("Invalid library kind.");
    expect(hostErrorText({ code: "library_conflict", message: "Unlisted.", reason: "library.not_in_catalog" }, "en-US")).toBe("Unlisted.");
  });

  it("has both languages for every entry, with the same placeholders", () => {
    const entries = Object.entries(LIBRARY_ERROR_TEXTS);
    expect(entries.length).toBeGreaterThan(100);
    for (const [key, text] of entries) {
      expect(key).toMatch(/^(?:(?:library|material|cover|study|trash)\.[a-z0-9_]+|[a-z_]+)$/);
      expect(text["zh-CN"].trim(), key).not.toBe("");
      expect(text["en-US"].trim(), key).not.toBe("");
      expect(placeholders(text["zh-CN"]), key).toEqual(placeholders(text["en-US"]));
    }
  });
});
