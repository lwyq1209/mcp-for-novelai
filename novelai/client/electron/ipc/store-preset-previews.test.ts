import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", cleanups: [] as Array<() => void> }));
vi.mock("electron", () => ({
  app: { getPath: (key: string) => path.join(state.root, key), isPackaged: false, getPreferredSystemLanguages: () => [], getLocale: () => "en-US" },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error("unavailable"); }, decryptString: () => { throw new Error("unavailable"); } },
}));

afterEach(() => {
  for (const cleanup of state.cleanups.splice(0).reverse()) cleanup();
  vi.resetModules();
});

/** A nai-local URL for a path as an earlier run saved it (made without exposing the path in this process). */
const savedUrl = (file: string) => `nai-local://file/${encodeURIComponent(pathToFileURL(file).toString())}`;

/**
 * A data folder whose library holds a style preset and a prompt preset, each with one preview image saved by an
 * earlier run, then the modules of a freshly started main process (nothing exposed through nai-local yet).
 */
async function restartedApp() {
  state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nai-store-previews-")));
  const root = state.root, userData = path.join(root, "userData");
  fs.mkdirSync(userData, { recursive: true });
  state.cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "png"); return file; };
  const styleFile = write(path.join(userData, "style-prompt-previews", "style-1", "a.png"));
  const positiveFile = write(path.join(userData, "style-prompt-previews", "positive-prompt-pp-1", "b.jpg"));
  const outside = write(path.join(root, "outside.png"));
  const preview = (file: string) => ({ id: path.basename(file), name: path.basename(file), filePath: file, fileUrl: savedUrl(file), createdAt: "2026-11-05T00:00:00.000Z" });

  const { openLibraryRepository } = await import("../library/repository");
  const { activateLibrary, deactivateLibrary } = await import("../library-runtime");
  const repository = openLibraryRepository({ filePath: path.join(userData, "library.sqlite"), userDataRoot: userData, libraryDirectory: path.join(userData, "library") });
  state.cleanups.push(() => { deactivateLibrary(); repository.close(); });
  repository.put("style_preset", "style-1", { id: "style-1", name: "Ink", prompt: "ink", group: "", createdAt: "2026-11-05T00:00:00.000Z", previewImages: [preview(styleFile), preview(outside)] });
  repository.put("positive_preset", "pp-1", { id: "pp-1", name: "Cafe", prompt: "cafe", createdAt: "2026-11-05T00:00:00.000Z", previewImages: [preview(positiveFile)] });
  activateLibrary(repository, { userDataRoot: userData, libraryDirectory: path.join(userData, "library") });
  const media = await import("./local-media-protocol");
  const store = await import("./store");
  return { media, store, styleFile, positiveFile, outside };
}

describe("preset preview images after a restart", () => {
  it("are servable from the first settings read, without opening the preset's image dialog", async () => {
    const { media, store, styleFile, positiveFile, outside } = await restartedApp();
    expect(media.localMediaUrlToPath(savedUrl(styleFile)), "the URL an earlier run saved is not served yet").toBeNull();

    const settings = store.rendererSettings();
    const [style, notOwn] = settings.stylePromptPresets[0].previewImages!;
    expect(media.localMediaUrlToPath(style.fileUrl)).toBe(styleFile);
    expect(media.localMediaUrlToPath(settings.positivePromptPresets[0].previewImages![0].fileUrl)).toBe(positiveFile);
    // A saved path outside the preset's own folder stays as saved and is not served.
    expect(notOwn.fileUrl).toBe(savedUrl(outside));
    expect(media.localMediaUrlToPath(savedUrl(outside))).toBeNull();
    // The rest of the settings are getSettings()'s; internal readers keep the saved read model.
    const { stylePromptPresets: _style, positivePromptPresets: _positive, ...rest } = settings;
    const { stylePromptPresets: _savedStyle, positivePromptPresets: _savedPositive, ...savedRest } = store.getSettings();
    expect(rest).toEqual(savedRest);
    expect(store.getSettings().stylePromptPresets[0].previewImages![0].fileUrl).toBe(savedUrl(styleFile));
  });
});
