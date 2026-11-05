import { describe, expect, it } from "vitest";
import { BACKUP_ERROR_TEXTS } from "./backup";
import { hostMessageText } from "./compose";
import { hostErrorText } from "./index";

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();

describe("backup, reference preset and history host texts", () => {
  it("has a non-empty Chinese and English text for every entry, with the same placeholders", () => {
    for (const [key, text] of Object.entries(BACKUP_ERROR_TEXTS)) {
      expect(text["zh-CN"].trim(), key).not.toBe("");
      expect(text["en-US"].trim(), key).not.toBe("");
      expect(placeholders(text["zh-CN"]), key).toEqual(placeholders(text["en-US"]));
    }
  });

  it("renders a failed export with its inner error in the interface language", () => {
    const result = {
      ok: false, code: "backup_export_failed", message: "The export failed: The backup file is empty.",
      params: { detail: "The backup file is empty." },
      details: { detail: { code: "backup_invalid_archive", reason: "backup.file_empty", message: "The backup file is empty." } },
    };
    expect(hostMessageText(result, "zh-CN")).toBe("导出失败：备份文件为空。");
    expect(hostMessageText(result, "en-US")).toBe("The export failed: The backup file is empty.");
    // An inner error the catalog does not know shows its message.
    const unknown = { ...result, details: { detail: { code: "host_error", message: "EACCES: permission denied" } } };
    expect(hostMessageText(unknown, "zh-CN")).toBe("导出失败：EACCES: permission denied");
  });

  it("renders an export receipt with its limitations", () => {
    const result = {
      ok: true, code: "backup_exported", reason: "backup.exported_limited", message: "…", params: { count: 2 },
      details: { limitations: [
        { code: "library-assets-missing", reason: "backup.library_assets_missing", params: { count: 3 }, message: "3 original(s) …" },
        { code: "portable-assets-missing:imageHistory", reason: "backup.portable_assets_missing", params: { category: "imageHistory", count: 1 }, message: "1 linked file(s) …" },
      ] },
    };
    expect(hostMessageText(result, "zh-CN")).toBe("所选类别备份已创建，但存在 2 项限制：统一素材库有 3 份原图或预览不可用，未写入归档。；imageHistory 有 1 份关联文件不可用，未写入归档。");
    expect(hostMessageText(result, "en-US")).toBe("The backup of the selected categories was created with 2 limitation(s): 3 original(s) or preview(s) of the material library are unavailable and were not written to the archive.; 1 linked file(s) of imageHistory are unavailable and were not written to the archive.");
  });

  it("renders a refused, an aborted and a completed import", () => {
    const refused = { ok: false, code: "backup_degraded_confirmation_required", message: "…", params: { count: 1 }, details: { reasons: [{ code: "library-snapshot-unavailable", reason: "backup.library_snapshot_missing", message: "…" }] } };
    expect(hostMessageText(refused, "zh-CN")).toBe("所选导入范围存在限制，需明确确认降级导入：所选素材类别没有统一素材库快照；无法证明版本完整。");
    expect(hostMessageText(refused, "en-US")).toBe("The selected import scope has limitations; confirm the degraded import explicitly: The selected material categories have no material library snapshot; their versions cannot be proven complete.");
    const aborted = {
      ok: false, code: "backup_import_aborted", reason: "backup.import_aborted_removed", message: "…", params: { removed: 2, detail: "…" },
      details: { detail: { code: "backup_invalid_record", reason: "backup.invalid_record.history", params: { id: "\"h-1\"", detail: "params/steps is invalid" }, message: "…" } },
    };
    expect(hostMessageText(aborted, "zh-CN")).toBe("导入中止；当前数据的导入前备份已保留，本次已写入但未保存的 2 个图片文件已删除：备份中的历史记录 \"h-1\" 不是有效的素材记录，没有写入任何素材：params/steps is invalid");
    expect(hostMessageText(aborted, "en-US")).toBe("Import aborted; the safety backup of the current data was kept, and the 2 image file(s) written but not saved by this import were deleted: The history record \"h-1\" in the backup is not a valid material record; no material was written: params/steps is invalid");
    const done = { ok: true, code: "backup_imported", reason: "backup.imported_warnings", message: "…", params: { imported: 5, skipped: 1, renamed: 0 }, details: { warnings: [{ code: "backup_warning", reason: "backup.in_trash", params: { count: 4 }, message: "…" }] } };
    expect(hostMessageText(done, "zh-CN")).toBe("导入完成：新增 5 项，跳过 1 项，重命名 0 项。 4 项在「最近删除」中，未从备份导入；需要时请在「最近删除」中恢复。");
    expect(hostMessageText(done, "en-US")).toBe("Import complete: 5 added, 1 skipped, 0 renamed. 4 item(s) are in Recently Deleted and were not imported from the backup; restore them from Recently Deleted when needed.");
    expect(hostMessageText({ ok: false, cancelled: true, code: "backup_cancelled", reason: "backup.import_cancelled", message: "The import was cancelled." }, "zh-CN")).toBe("已取消导入。");
  });

  it("renders reference preset failures and an import receipt", () => {
    expect(hostErrorText({ code: "reference_preset_name_required", message: "Enter a preset name." }, "zh-CN")).toBe("请输入预设名称。");
    expect(hostErrorText({ code: "reference_preset_image_size", message: "…", params: { limitMb: 50 } }, "zh-CN")).toBe("参考图片为空或超过 50 MB。");
    expect(hostErrorText({ code: "reference_preset_image_size", message: "…", params: { limitMb: 50 } }, "en-US")).toBe("The reference image is empty or larger than 50 MB.");
    expect(hostErrorText({ code: "reference_import_entry_invalid", reason: "reference_import.value_out_of_range", params: { key: "strength" }, message: "…" }, "zh-CN")).toBe("strength 必须在 0 到 1 之间。");
    const partial = {
      ok: false, code: "reference_imported", reason: "reference_import.partial", message: "…", params: { imported: 1, skipped: 0, failed: 2, detail: "Fixture disk full" },
      details: { detail: { code: "host_error", message: "Fixture disk full" } },
    };
    expect(hostMessageText(partial, "zh-CN")).toBe("已导入 1 项，跳过 0 项，未完成 2 项。Fixture disk full 已完成项保留；重新预览会跳过相同内容。");
    expect(hostMessageText(partial, "en-US")).toBe("Imported 1, skipped 0, 2 not completed. Fixture disk full Completed entries are kept; previewing again skips the same content.");
    // A nested detail that has details of its own is rendered from its params only (one level).
    const notes = { code: "reference_import_entry_failed", reason: "reference_import.entry_failed_notes", message: "…", params: { detail: "Disk full", notes: "File cleanup did not complete: busy" } };
    expect(hostMessageText({ ...partial, details: { detail: notes } }, "zh-CN")).toBe("已导入 1 项，跳过 0 项，未完成 2 项。Disk full File cleanup did not complete: busy 已完成项保留；重新预览会跳过相同内容。");
    expect(hostMessageText({ ...notes, details: { detail: { code: "host_error", message: "Disk full" }, notes: [{ code: "reference_import_entry", reason: "reference_import.cleanup_incomplete", params: { detail: "busy" }, message: "…" }] } }, "zh-CN")).toBe("Disk full 未完成文件清理：busy");
  });

  it("renders history storage failures and receipts", () => {
    const notOpen = { ok: false, code: "library_unavailable", reason: "history.library_not_open", message: "The material library is not open." };
    expect(hostErrorText(notOpen, "zh-CN")).toBe("素材库尚未打开。");
    expect(hostErrorText(notOpen, "en-US")).toBe("The material library is not open.");
    expect(hostErrorText({ ok: true, code: "history_exported", params: { count: 12 }, message: "Exported 12 image(s)." }, "zh-CN")).toBe("已导出 12 张图片。");
    expect(hostErrorText({ ok: true, code: "history_exported", params: { count: 12 }, message: "Exported 12 image(s)." }, "en-US")).toBe("Exported 12 image(s).");
    const failed = { ok: false, code: "history_delete_failed", message: "…", params: { detail: "refused" }, details: { detail: { code: "host_error", message: "refused before anything changed" } } };
    expect(hostMessageText(failed, "zh-CN")).toBe("删除未完成，历史记录和图片都还在：refused before anything changed");
    expect(hostMessageText(failed, "en-US")).toBe("The delete did not complete; the history record and image are still there: refused before anything changed");
  });

  it("keeps the message of a result the catalog does not know and keeps at most 20 array details", () => {
    expect(hostMessageText({ ok: false, message: "旧版备份里的中文原因" }, "en-US")).toBe("旧版备份里的中文原因");
    const many = Array.from({ length: 25 }, (_, index) => ({ code: "host_error", message: `w${index}` }));
    const text = hostMessageText({ code: "backup_rescue_incomplete", message: "…", details: { reasons: many } }, "en-US");
    expect(text).toContain("w19"); expect(text).not.toContain("w20");
  });
});
