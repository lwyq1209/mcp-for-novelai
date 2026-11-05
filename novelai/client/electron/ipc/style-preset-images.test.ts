import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import { openLibraryRepository, type LibraryRepository } from "../library/repository";
import { activateLibrary, deactivateLibrary } from "../library-runtime";
import { localMediaUrlToPath } from "./local-media-protocol";
import {
  copyStylePromptPreviewImages,
  reconcileStylePromptPreviewImages,
  servablePreviewImages,
  stylePromptPreviewDirectory,
} from "./style-preset-images";

const temporary: string[] = [], repositories: LibraryRepository[] = [];

afterEach(() => runCleanupsSync([() => deactivateLibrary(), ...repositories.splice(0).map(repository => () => repository.close()), ...temporary.splice(0).map((directory) => () => fs.rmSync(directory, { recursive: true, force: true }))]));

/** A data root whose library is open: preset previews are named by the presets' library records. */
function dataRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "style-preview-"));
  temporary.push(root);
  const repository = openLibraryRepository({ filePath: path.join(root, "library.sqlite"), userDataRoot: root, libraryDirectory: path.join(root, "library") });
  repositories.push(repository);
  activateLibrary(repository, { userDataRoot: root, libraryDirectory: path.join(root, "library") });
  return { root, repository };
}

describe("style prompt preview images", () => {
  it("copies selected images into the persistent preset directory and respects slots", () => {
    const { root, repository } = dataRoot();
    const sourceA = path.join(root, "a.png");
    const sourceB = path.join(root, "b.jpg");
    fs.writeFileSync(sourceA, "png");
    fs.writeFileSync(sourceB, "jpg");

    const copied = copyStylePromptPreviewImages(
      [sourceA, sourceB],
      "style/unsafe",
      1,
      root,
    );

    expect(copied).toHaveLength(1);
    expect(fs.existsSync(copied[0].filePath)).toBe(true);
    expect(path.dirname(copied[0].filePath)).toBe(
      stylePromptPreviewDirectory("style/unsafe", root),
    );
    expect(copied[0].fileUrl).toMatch(/^nai-local:\/\/file\//);
    // Staged as an asset of the preset until the preset saves it; no manifest file.
    expect(repository.assets()).toEqual([{ id: `preview:${copied[0].id}`, payload: { ...copied[0], stagedForPreset: "style/unsafe" } }]);
    expect(fs.readdirSync(path.dirname(copied[0].filePath))).toEqual([path.basename(copied[0].filePath)]);
  });

  it("ignores unsupported files and never exceeds three images", () => {
    const { root } = dataRoot();
    const sources = ["a.png", "b.jpg", "c.webp", "d.jpeg", "bad.txt"].map(
      (name) => {
        const file = path.join(root, name);
        fs.writeFileSync(file, name);
        return file;
      },
    );
    expect(copyStylePromptPreviewImages(sources, "style", 99, root)).toHaveLength(3);
  });

  it("reads a preset's previews from its saved record (or the given ones), with the URL rebuilt from the path", () => {
    const { root, repository } = dataRoot();
    const file = path.join(stylePromptPreviewDirectory("style", root), "kept.png");
    const image = { id: "kept", name: "my-style-reference.png", filePath: file, fileUrl: "stale-url", createdAt: "2026-11-03T00:00:00.000Z" };
    repository.put("style_preset", "style", { id: "style", name: "Style", prompt: "ink", group: "", createdAt: image.createdAt, previewImages: [image] });
    const restored = reconcileStylePromptPreviewImages("style", undefined, root);
    expect(restored).toEqual([{ ...image, fileUrl: expect.stringMatching(/^nai-local:\/\/file\//) }]);
    // An orphan file in the preset's folder is not adopted: the record decides.
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(file), "orphan.png"), "png");
    expect(reconcileStylePromptPreviewImages("style", undefined, root).map(value => value.id)).toEqual(["kept"]);
    expect(reconcileStylePromptPreviewImages("style", [], root)).toEqual([]);
    expect(reconcileStylePromptPreviewImages("positive-prompt-missing", undefined, root)).toEqual([]);
  });

  describe("served to the renderer after a restart (servablePreviewImages)", () => {
    /** A nai-local URL for a path, made without exposing it (as a URL saved by an earlier run). */
    const savedUrl = (file: string) => `nai-local://file/${encodeURIComponent(pathToFileURL(file).toString())}`;
    const image = (file: string, id = path.basename(file)) => ({ id, name: id, filePath: file, fileUrl: savedUrl(file), createdAt: "2026-11-05T00:00:00.000Z" });
    const write = (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "png"); return file; };
    /** Creates a symbolic link, or returns false where the system does not allow it (Windows without the privilege). */
    const link = (target: string, at: string) => { try { fs.symlinkSync(target, at); return true; } catch { return false; } };

    it("rebuilds and serves the URL of a real image file in the preset's own folder", () => {
      const root = fs.realpathSync(dataRoot().root);
      const file = write(path.join(stylePromptPreviewDirectory("style-a", root), "kept.png"));
      const saved = image(file);
      expect(localMediaUrlToPath(saved.fileUrl), "a fresh process serves nothing yet").toBeNull();
      const [served] = servablePreviewImages("style-a", [saved], root);
      expect(served).toEqual({ ...saved, fileUrl: expect.stringMatching(/^nai-local:\/\/file\//) });
      expect(localMediaUrlToPath(served.fileUrl)).toBe(file);
      // A prompt preset's folder is "positive-prompt-<id>".
      const positive = write(path.join(stylePromptPreviewDirectory("positive-prompt-pp", root), "p.webp"));
      expect(localMediaUrlToPath(servablePreviewImages("positive-prompt-pp", [image(positive)], root)[0].fileUrl)).toBe(positive);
    });

    it("leaves every other entry as saved and serves nothing for it", () => {
      const root = fs.realpathSync(dataRoot().root);
      const own = stylePromptPreviewDirectory("style-b", root);
      const outside = write(path.join(root, "private", "secret.png"));
      const otherPreset = write(path.join(stylePromptPreviewDirectory("style-other", root), "theirs.png"));
      const missing = path.join(own, "gone.png");
      const text = write(path.join(own, "notes.txt"));
      const nested = write(path.join(own, "sub", "deep.png"));
      const entries = [image(outside), image(otherPreset), image(missing), image(text), image(nested), { ...image(outside), filePath: "relative/x.png" }, { id: "no-path" }, null];
      expect(servablePreviewImages("style-b", entries, root)).toEqual(entries);
      for (const file of [outside, otherPreset, missing, text, nested]) expect(localMediaUrlToPath(savedUrl(file)), file).toBeNull();
      expect(servablePreviewImages("style-b", "not a list", root)).toBe("not a list");
      expect(servablePreviewImages("style-none", [image(outside)], root), "a preset without a folder").toEqual([image(outside)]);
    });

    it("does not follow symbolic links: a linked image file or a linked preset folder is not served", () => {
      const root = fs.realpathSync(dataRoot().root);
      const outside = write(path.join(root, "private", "linked.png"));
      const own = stylePromptPreviewDirectory("style-c", root);
      fs.mkdirSync(own, { recursive: true });
      const linkedFile = path.join(own, "link.png");
      if (link(outside, linkedFile)) {
        expect(servablePreviewImages("style-c", [image(linkedFile)], root)).toEqual([image(linkedFile)]);
        expect(localMediaUrlToPath(savedUrl(outside))).toBeNull();
        expect(localMediaUrlToPath(savedUrl(linkedFile))).toBeNull();
      }
      const elsewhere = path.join(root, "elsewhere");
      const inElsewhere = write(path.join(elsewhere, "x.png"));
      const linkedFolder = stylePromptPreviewDirectory("style-d", root);
      if (link(elsewhere, linkedFolder)) {
        const entry = image(path.join(linkedFolder, "x.png"));
        expect(servablePreviewImages("style-d", [entry], root)).toEqual([entry]);
        expect(localMediaUrlToPath(savedUrl(inElsewhere))).toBeNull();
      }
    });
  });
});
