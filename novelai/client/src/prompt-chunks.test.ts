import { describe, expect, it } from "vitest";
import { appendPromptChunk } from "./prompt-chunks";

// Step 4c2: the old snippet popover (and its placement test) was removed; inserting a snippet keeps this rule.
describe("appending a prompt snippet", () => {
  it("adds the snippet as one more comma-separated part", () => {
    expect(appendPromptChunk("", "masterpiece")).toBe("masterpiece, ");
    expect(appendPromptChunk("1girl, ", "night sky")).toBe("1girl, night sky, ");
    expect(appendPromptChunk("1girl", ", night sky,")).toBe("1girl, night sky, ");
  });
  it("leaves the field unchanged for an empty snippet", () => {
    expect(appendPromptChunk("1girl, ", "  ,  ")).toBe("1girl, ");
  });
});
