import { describe, expect, it } from "vitest";
import { compactRemoteErrorText, describeRemoteError } from "./error-message";
import { hostErrorText } from "./host-errors";

describe("compactRemoteErrorText", () => {
  it("replaces a Cloudflare 502 HTML document with one bounded message", () => {
    const html = `<!doctype html><html><head><title>Bad gateway</title></head><body>
      <div class="cf-error-details"><h1>Bad gateway</h1><span>Error code 502</span>
      <p>Cloudflare Ray ID: a32d3eee482ea8ad</p></div></body></html>`;
    const message = compactRemoteErrorText(html, { status: 502, language: "zh-CN" });

    expect(message).toBe("NovelAI 暂时不可用（HTTP 502 Bad Gateway），请稍后重试。");
    // The host (no language) and an English window read English (step 4c1).
    expect(compactRemoteErrorText(html, { status: 502 })).toBe("NovelAI is unavailable right now (HTTP 502 Bad Gateway); try again later.");
    expect(compactRemoteErrorText(html, { status: 502, language: "en-US" })).toBe("NovelAI is unavailable right now (HTTP 502 Bad Gateway); try again later.");
    expect(message).not.toContain("<html");
    expect(message).not.toContain("Cloudflare Ray ID");
  });

  it("reads nested IPC/Axios payloads and recognizes gateway timeouts", () => {
    const message = compactRemoteErrorText({
      response: {
        status: 504,
        data: "<html><body><h1>Gateway Timeout</h1></body></html>",
      },
    });

    expect(message).toContain("HTTP 504 Gateway Timeout");
    expect(message).not.toContain("<");
  });

  it("keeps useful plain-text validation errors and caps their length", () => {
    const message = compactRemoteErrorText({ message: `Invalid prompt: ${"x".repeat(600)}` }, { maxLength: 120 });
    expect(message).toMatch(/^Invalid prompt:/);
    expect(message.length).toBeLessThanOrEqual(120);
    expect(message.endsWith("…")).toBe(true);
  });

  it("shows the message of a JSON error body instead of the raw JSON (HTTP 402 from NovelAI, step 4b2)", () => {
    const body = JSON.stringify({ statusCode: 402, message: "An active subscription is required to access this endpoint." });
    expect(compactRemoteErrorText(body, { status: 402 })).toBe("An active subscription is required to access this endpoint.");
    expect(compactRemoteErrorText(Buffer.from(body).toString("utf8"))).toBe("An active subscription is required to access this endpoint.");
    expect(compactRemoteErrorText(JSON.stringify({ error: { detail: "Not enough Anlas." } }))).toBe("Not enough Anlas.");
    expect(compactRemoteErrorText(JSON.stringify([{ title: "Bad size" }]))).toBe("Bad size");
    // Without a readable field, or not JSON at all, the text is shown as it was.
    expect(compactRemoteErrorText(JSON.stringify({ statusCode: 402 }))).toBe('{"statusCode":402}');
    expect(compactRemoteErrorText("{not json")).toBe("{not json");
    // A JSON 503 is still the unavailable message.
    expect(compactRemoteErrorText(JSON.stringify({ statusCode: 503, message: "down" }), { language: "zh-CN" })).toBe("NovelAI 暂时不可用（HTTP 503 Service Unavailable），请稍后重试。");
  });

  it("an error page and an empty answer: one reason each, English in the host, the window's language with one (step 4c1)", () => {
    const page = "<html><body><h1>Oops</h1></body></html>";
    expect(describeRemoteError(page)).toEqual({ text: "NovelAI answered with an error page; try again later.", reason: "remote.html_page" });
    expect(compactRemoteErrorText(page, { language: "zh-CN" })).toBe("NovelAI 返回了网页错误，请稍后重试。");
    expect(describeRemoteError(page, { status: 500 })).toMatchObject({ reason: "remote.html_page", params: { status: 500 } });
    expect(describeRemoteError("")).toEqual({ text: "The request failed; try again later.", reason: "remote.failed" });
    expect(compactRemoteErrorText("", { language: "zh-CN" })).toBe("请求失败，请稍后重试。");
    expect(compactRemoteErrorText("", { fallback: "自定义" })).toBe("自定义");
    // A readable upstream message has no reason and is kept as it is.
    expect(describeRemoteError(JSON.stringify({ statusCode: 400, message: "prompt rejected" }))).toEqual({ text: "prompt rejected" });
    // The window's catalog renders the same reasons (hostErrorText).
    expect(hostErrorText({ code: "generation_failed", reason: "remote.unavailable", params: { status: 503, statusText: " Service Unavailable" } }, "zh-CN")).toBe("NovelAI 暂时不可用（HTTP 503 Service Unavailable），请稍后重试。");
    expect(hostErrorText({ code: "generation_failed", reason: "remote.html_page" }, "en-US")).toBe("NovelAI answered with an error page; try again later.");
    // No Chinese anywhere in what the host says.
    for (const value of [page, "", "<html>502 Bad Gateway</html>", JSON.stringify({ statusCode: 504 })]) expect(describeRemoteError(value).text).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
