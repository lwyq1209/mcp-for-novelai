import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import { openLibraryRepository, type LibraryRepository } from "../library/repository";
import { activateLibrary, deactivateLibrary } from "../library-runtime";
import {
  copyStylePromptPreviewImages,
  reconcileStylePromptPreviewImages,
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
});
