import { describe, expect, it } from "vitest";
import { HOST_ERROR_TEXTS, formatHostErrorText, hostErrorText } from ".";
import { QUEUE_ERROR_TEXTS } from "./queue";

const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();

describe("host errors in the interface language (step 4a)", () => {
  it("a batch state renders by its code, also a stored one whose message is still Chinese", () => {
    const stored = { code: "scheduler_stopped", message: "队列调度遇到异常，已停止后续提交；请核对已生成的图片。" };
    expect(hostErrorText(stored, "en-US")).toBe("An internal error of the queue ended this batch early; its remaining images were skipped. Other batches are not affected; check the images already created.");
    expect(hostErrorText(stored, "zh-CN")).toBe("队列内部出错，这个批次提前结束，剩下的图片没有生成；其他批次不受影响。请核对已生成的图片。");
    // A legacy automatic pause stays readable, worded as the past: the queue no longer pauses other batches.
    const halted = { code: "queue_halted", message: "前一批次失败或结果未知；后续批次暂停，需检查后显式恢复。" };
    expect(hostErrorText(halted, "en-US")).toBe("An older version paused this batch after an earlier batch failed or had an unknown result; the queue no longer pauses other batches for that.");
    expect(hostErrorText(halted, "zh-CN")).toBe("旧版本在前一批失败或结果未知后暂停了这个批次；现在的队列不会因此暂停其他批次。");
  });

  it("an image's own outcome says the batch went on, in both languages, and never that the queue stopped or paused", () => {
    const codes = ["rate_limited", "child_lookup_failed", "child_status_unavailable", "scheduler_error", "submission_unconfirmed", "restart_unconfirmed"];
    for (const code of codes) {
      const zh = hostErrorText({ code, message: "untranslated host message" }, "zh-CN"), en = hostErrorText({ code, message: "untranslated host message" }, "en-US");
      expect(QUEUE_ERROR_TEXTS[code], code).toBeDefined();
      expect(zh, code).toMatch(/[\u4e00-\u9fff]/);
      expect(en, code).not.toMatch(/[\u4e00-\u9fff]/);
      expect(en, code).not.toBe("untranslated host message");
      expect(`${zh} ${en}`, code).not.toMatch(/批次已停止|停止后续|后续批次暂停|stopped submitting|the batch stopped|paused until/);
    }
    for (const code of ["rate_limited", "child_lookup_failed", "child_status_unavailable", "scheduler_error"]) {
      expect(QUEUE_ERROR_TEXTS[code]["zh-CN"], code).toContain("批次接着出后面的图");
      expect(QUEUE_ERROR_TEXTS[code]["en-US"], code).toContain("the batch went on");
    }
    expect(hostErrorText({ code: "rate_limited", message: "x" }, "en-US")).toContain("HTTP 429");
    expect(hostErrorText({ code: "rate_limited", message: "x" }, "zh-CN")).toContain("约 60 秒");
    expect(hostErrorText({ code: "child_status_unavailable", message: "x" }, "zh-CN")).toContain("约 90 秒");
    // The legacy reasons of old stopped batches stay readable.
    for (const code of ["child_stopped", "child_rejected", "restart_blocked", "recovered_paused"]) expect(hostErrorText({ code, message: "旧" }, "en-US"), code).toMatch(/older version/);
  });

  it("the frozen queue and the recipe store name the entry they do not use", () => {
    const frozen = { code: "queue_storage_error", message: "The frozen queue folder holds an entry …", reason: "queue.stray_entry", params: { entry: "runtime/frozen-queue/notes.txt" } };
    expect(hostErrorText(frozen, "zh-CN")).toBe("冻结队列文件夹里有本应用不使用的条目：runtime/frozen-queue/notes.txt（在数据文件夹内）。冻结队列已停止，没有改动任何文件。把这个条目移走或删除，然后重新启动应用即可恢复。");
    expect(hostErrorText(frozen, "en-US")).toContain("holds an entry this app does not use: runtime/frozen-queue/notes.txt (in the data folder)");
    const recipes = { code: "queue_storage_failed", message: "The recipe store holds an entry …", reason: "recipe.stray_entry", params: { entry: "runtime/queue-recipes/x.txt" } };
    expect(hostErrorText(recipes, "zh-CN")).toContain("配方存储里有本应用不使用的条目：runtime/queue-recipes/x.txt");
    expect(hostErrorText(recipes, "en-US")).toContain("The recipe store holds an entry this app does not use: runtime/queue-recipes/x.txt");
    // Without the reason the code still has its own text.
    expect(hostErrorText({ code: "queue_storage_failed", message: "Recipe file hash does not match." }, "zh-CN")).toBe("配方存储无法读取或写入；没有保存或入队任何内容。");
  });

  it("queue refusals, the total queue limit and a manual click's own refusals", () => {
    expect(hostErrorText({ code: "queue_full", message: "…", reason: "queue.pending_limit", params: { limit: 200 } }, "zh-CN")).toBe("队列最多保留 200 张未完成的图片（设置“排队总数上限”）；请先完成或取消一些。");
    expect(hostErrorText({ code: "queue_full", message: "…", reason: "queue.pending_limit", params: { limit: 200 } }, "en-US")).toBe("The queue holds at most 200 unfinished images (Settings, total queue limit); finish or cancel some first.");
    expect(hostErrorText({ code: "batch_not_paused", message: "Only a paused batch can be resumed; a failed or unknown image is never resent." }, "zh-CN")).toBe("只有正常暂停的批次可以继续；失败或结果未知的图片不会重发。");
    expect(hostErrorText({ code: "invalid_image", message: "The image must be a file of at most 128 MiB.", reason: "manual.source_too_large", params: { max: 128 } }, "zh-CN")).toBe("图片必须是不超过 128 MiB 的文件。");
    expect(hostErrorText({ code: "source_missing", message: "x", reason: "manual.source_expired" }, "zh-CN")).toContain("请重新点击");
  });

  it("a failed generation request says what failed, with its HTTP status and the provider's text", () => {
    const failed = { code: "generation_failed", message: "Image generation failed (HTTP 400): prompt too long", reason: "generation.failed_t2i", params: { status: 400, httpZh: "（HTTP 400）", httpEn: " (HTTP 400)", detail: "prompt too long" } };
    expect(hostErrorText(failed, "zh-CN")).toBe("图片生成失败（HTTP 400）：prompt too long");
    expect(hostErrorText(failed, "en-US")).toBe("Image generation failed (HTTP 400): prompt too long");
    // HTTP 402 (step 4b2): a refused charge says so in the interface language, with the provider's message.
    const payment = { code: "generation_failed", message: "Image generation failed (HTTP 402): not enough Anlas or subscription: An active subscription is required.", reason: "generation.payment_required", params: { status: 402, httpZh: "（HTTP 402）", httpEn: " (HTTP 402)", detail: "An active subscription is required." } };
    expect(hostErrorText(payment, "zh-CN")).toBe("余额或订阅不足（HTTP 402）：An active subscription is required.");
    expect(hostErrorText(payment, "en-US")).toBe("Not enough Anlas or subscription (HTTP 402): An active subscription is required.");
    const auth = { code: "authentication_failed", message: "…", reason: "generation.auth", params: { httpZh: "", httpEn: "" } };
    expect(hostErrorText(auth, "en-US")).toMatch(/^NovelAI authentication failed: paste and verify/);
    expect(hostErrorText({ code: "provider_unknown", message: "…" }, "zh-CN")).toContain("不会自动重发");
  });

  it("an error the catalog does not know shows its message as it came; nothing at all shows the fallback", () => {
    expect(hostErrorText({ code: "invalid_argument", message: "Invalid recipe ID." }, "zh-CN")).toBe("Invalid recipe ID.");
    expect(hostErrorText(new Error("plain failure"), "en-US")).toBe("plain failure");
    expect(hostErrorText(undefined, "zh-CN", "队列读取失败。")).toBe("队列读取失败。");
    expect(hostErrorText(undefined, "en-US")).toBe("The operation did not complete.");
    expect(formatHostErrorText("{a} and {b}", { a: 1 })).toBe("1 and ");
  });

  it("every catalog entry has both languages with the same placeholders", () => {
    for (const [key, text] of Object.entries(HOST_ERROR_TEXTS)) {
      expect(text["zh-CN"].trim(), key).not.toBe("");
      expect(text["en-US"].trim(), key).not.toBe("");
      expect(placeholders(text["zh-CN"]).filter(name => !/^http/.test(name)), key).toEqual(placeholders(text["en-US"]).filter(name => !/^http/.test(name)));
    }
    expect(Object.keys(QUEUE_ERROR_TEXTS).length).toBeGreaterThan(40);
  });
});
