import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../store";
import { bridgeSafeApi, bridgeSafeError, HOST_ERROR_MARK, plainErrorMessage, readHostError, scrubHostErrorSuffixes, stripHostErrorSuffixes } from "../host-errors/bridge";
import { hostErrorText } from "../host-errors";
import { compactRemoteErrorText } from "../error-message";
import { getToasts, showToast, dismissToast } from "../ui";
import { createWorkspaceController, type WorkspacePort } from "./controller";
import { WorkspaceError, workspaceErrorInfo } from "./protocol";
import { pickCreativeState } from "./state";

/**
 * Step 4b1 review rework 3: a host error's structure (invisible message suffix, host-errors/bridge.ts) is for the
 * window only. Nothing the window sends back (workspace replies to the bridge and on to MCP, host requests), shows
 * or copies keeps the suffix or its reason/params (step 4a: reason/params do not travel over the bridge).
 */
/** Every character the suffix may use (and other zero-width / format characters an agent must not receive). */
export const FORMAT_CHARACTERS = /[\u200b-\u200f\u2060-\u2064\ufeff]/;
const acrossBridge = (value: unknown) => value instanceof Error ? new Error(value.message) : value;
/** A host refusal as the window receives it from the preload (contextBridge keeps the message only). */
const preloadError = (message = "tag:x changed (current revision 2); read it again.") =>
  acrossBridge(bridgeSafeError(Object.assign(new Error(message), { code: "library_conflict", reason: "trash.item_changed", params: { item: "tag:x", revision: 2 } }))) as Error;

function controllerWith(overrides: Partial<WorkspacePort>) {
  const port: WorkspacePort = {
    read: () => pickCreativeState(useAppStore.getState()),
    subscribe: (listener) => useAppStore.subscribe(listener),
    apply: (patch) => useAppStore.setState(patch),
    validateImages: async () => {},
    readActivity: () => ({ isGenerating: false }),
    ...overrides,
  };
  return createWorkspaceController(port, "test-workspace");
}

describe("workspace replies to the bridge carry no suffix, reason or params", () => {
  beforeEach(() => { useAppStore.setState(useAppStore.getInitialState(), true); });

  it("a preload error thrown while the controller handles an agent request", async () => {
    const error = preloadError();
    expect(readHostError(error).reason).toBe("trash.item_changed");
    expect(FORMAT_CHARACTERS.test(error.message)).toBe(true);
    const controller = controllerWith({ validateImages: async () => { throw error; } });
    const response = await controller.handle({ requestId: "r1", method: "draft_edit", args: { workspaceId: "test-workspace", expectedRevision: controller.read().revision, patch: { params: { positivePrompt: "1girl" } } } });
    expect(response).toEqual({ requestId: "r1", error: { code: "internal_error", message: "tag:x changed (current revision 2); read it again." } });
    const wire = JSON.stringify(response);
    expect(FORMAT_CHARACTERS.test(wire)).toBe(false);
    expect(wire).not.toMatch(/reason|params|trash\.item_changed/);
  });

  it("a WorkspaceError built from a host error's text, with that text in its details", async () => {
    const host = preloadError("The source could not be saved.");
    const controller = controllerWith({ validateImages: async () => { throw new WorkspaceError("source_prepare_failed", host.message, { cause: host.message, nested: [{ text: `${host.message} (2)` }] }); } });
    const response = await controller.handle({ requestId: "r2", method: "draft_edit", args: { workspaceId: "test-workspace", expectedRevision: controller.read().revision, patch: { params: { positivePrompt: "1girl" } } } });
    expect(response).toEqual({ requestId: "r2", error: { code: "source_prepare_failed", message: "The source could not be saved.", details: { cause: "The source could not be saved.", nested: [{ text: "The source could not be saved. (2)" }] } } });
    expect(FORMAT_CHARACTERS.test(JSON.stringify(response))).toBe(false);
  });

  it("workspaceErrorInfo keeps code and details otherwise as they were", () => {
    expect(workspaceErrorInfo(new WorkspaceError("conflict", "Draft changed.", { currentRevision: 3 }))).toEqual({ code: "conflict", message: "Draft changed.", details: { currentRevision: 3 } });
    expect(workspaceErrorInfo("text")).toEqual({ code: "internal_error", message: "Workspace operation failed." });
  });

  it("the preload scrubs what the window sends to the host (a reply, a request), and leaves other values as they are", () => {
    const sent: unknown[] = [];
    const bytes = new Uint8Array([1, 2, 3]);
    const api = bridgeSafeApi({ replyWorkspace: (response: unknown) => { sent.push(response); }, save: (images: unknown) => { sent.push(images); return 1; } });
    const dirty = preloadError().message;
    api.replyWorkspace({ requestId: "r3", error: { code: "internal_error", message: dirty, details: { list: [dirty, 7, null] } } });
    api.save([{ name: "a.png", bytes }]);
    expect(sent[0]).toEqual({ requestId: "r3", error: { code: "internal_error", message: "tag:x changed (current revision 2); read it again.", details: { list: ["tag:x changed (current revision 2); read it again.", 7, null] } } });
    expect((sent[1] as Array<{ bytes: Uint8Array }>)[0].bytes).toBe(bytes);
    const clean = { a: "x", b: [1, { c: "y" }] };
    expect(scrubHostErrorSuffixes(clean)).toBe(clean);
  });
});

describe("what the window shows or copies has no suffix", () => {
  it("message helpers, the catalog, toasts and the store", () => {
    const error = preloadError();
    expect(plainErrorMessage(error)).toBe("tag:x changed (current revision 2); read it again.");
    expect(plainErrorMessage(error.message)).toBe("tag:x changed (current revision 2); read it again.");
    expect(plainErrorMessage({ no: "message" }, "fallback")).toBe("fallback");
    expect(FORMAT_CHARACTERS.test(hostErrorText(error, "zh-CN"))).toBe(false);
    expect(FORMAT_CHARACTERS.test(hostErrorText({ code: "x", message: error.message }, "en-US"))).toBe(false);
    expect(FORMAT_CHARACTERS.test(compactRemoteErrorText({ detail: { message: error.message } }))).toBe(false);
    // A stack (copied by the error boundary) repeats the message: every suffix goes, not only one at the end.
    expect(stripHostErrorSuffixes(`Error: ${error.message}\n    at x (y.js:1:1)\nError: ${error.message}`)).toBe("Error: tag:x changed (current revision 2); read it again.\n    at x (y.js:1:1)\nError: tag:x changed (current revision 2); read it again.");
    // A damaged suffix is dropped from the message too (only the structure is lost).
    expect(readHostError(new Error(error.message.slice(0, -1))).message).toBe("tag:x changed (current revision 2); read it again.");
    const id = showToast({ message: error.message });
    expect(getToasts().find(toast => toast.id === id)?.message).toBe("tag:x changed (current revision 2); read it again.");
    dismissToast(id);
    useAppStore.getState().setToast(error.message);
    expect(useAppStore.getState().toast).toBe("tag:x changed (current revision 2); read it again.");
    expect(HOST_ERROR_MARK.length).toBe(3);
  });
});

describe("no caught error's raw message is shown or sent outside host-errors/bridge.ts", () => {
  const root = path.resolve(__dirname, "..");
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
  it("reads them through plainErrorMessage / readHostError (a raw .message would keep the suffix)", () => {
    const offenders: string[] = [];
    for (const file of files(root)) {
      if (/host-errors[\\/]bridge\.ts$|library[\\/]capture-fixture\.ts$/.test(file)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/stripHostErrorSuffixes\(|plainErrorMessage\(/.test(line)) return;
        if (/\b(\w+)\s+instanceof\s+Error\s*\?\s*\1\.message\b/.test(line) || /\.catch\(\(?(\w+)\)?\s*=>[^)]*\b\1\.message\b/.test(line) || /\b(error|failure|reason|err|e)\?\.message\s*(\|\||\?\?)/.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

