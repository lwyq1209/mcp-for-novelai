import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { runCleanupsSync } from '../../src/test-support/temp-dirs';
import {
  createReferencePresetGroup,
  deleteReferencePresetGroup,
  deleteReferencePreset,
  listReferencePresets,
  moveReferencePresetToGroup,
  readReferencePreset,
  saveReferencePreset,
} from "./reference-presets";
import { openLibraryRepository, type LibraryRepository } from "../library/repository";
import { activateLibrary, deactivateLibrary } from "../library-runtime";

const roots: string[] = [], repositories: LibraryRepository[] = [];

afterEach(() => runCleanupsSync([() => deactivateLibrary(), ...repositories.splice(0).map(repository => () => repository.close()), ...roots.splice(0).map((root) => () => fs.rmSync(root, { recursive: true, force: true }))]));

/** A data root whose library is open: the presets are library items, their images files in reference-presets/. */
function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reference-presets-"));
  roots.push(root);
  const repository = openLibraryRepository({ filePath: path.join(root, "library.sqlite"), userDataRoot: root, libraryDirectory: path.join(root, "library") });
  repositories.push(repository);
  activateLibrary(repository, { userDataRoot: root, libraryDirectory: path.join(root, "library") });
  return root;
}

describe("reference preset persistence", () => {
  it("does not create online game groups before a successful download", async () => {
    const library = await listReferencePresets(temporaryRoot());
    expect(library.groups).toEqual([]);
    expect(library.presets).toHaveLength(0);
  });

  it("lists the saved groups as they are, empty or occupied", async () => {
    const root = temporaryRoot();
    for (const group of ["原神", "自定义"]) await createReferencePresetGroup(group, root);
    await saveReferencePreset({ name: "占用", group: "鸣潮", kind: "precise", base64: Buffer.from("image").toString("base64") }, root);

    const library = await listReferencePresets(root);
    expect([...library.groups].sort()).toEqual(["原神", "自定义", "鸣潮"].sort());
  });

  it("reuses an existing group instead of creating duplicates", async () => {
    const root = temporaryRoot();
    await createReferencePresetGroup("原神", root);
    await createReferencePresetGroup("原神 · 游戏内角色图", root);
    await saveReferencePreset({
      name: "安柏",
      group: "原神 · 游戏内角色图",
      kind: "precise",
      base64: Buffer.from("image").toString("base64"),
    }, root);
    expect((await listReferencePresets(root)).groups).toContain("原神");
    expect((await listReferencePresets(root)).groups.filter((group) => group === "原神 · 游戏内角色图")).toHaveLength(1);
  });

  it("defaults new vibe preset parameters to one", async () => {
    const root = temporaryRoot();
    const saved = await saveReferencePreset(
      {
        name: "默认氛围",
        kind: "vibe",
        base64: Buffer.from("image").toString("base64"),
        extension: "png",
      },
      root,
    );

    expect(saved.preset).toMatchObject({ infoExtracted: 1, strength: 1 });
  });

  it("saves, reads, groups and deletes a local preset", async () => {
    const root = temporaryRoot();
    const image = Buffer.from("local-image-bytes");
    const saved = await saveReferencePreset(
      {
        name: "角色参考",
        group: "常用",
        kind: "precise",
        base64: image.toString("base64"),
        extension: "jpg",
        preciseType: "character&style",
        strength: 0.8,
        fidelity: 0.9,
        informationExtracted: 0.75,
        width: 832,
        height: 1216,
        sourceId: "genshin/amber/default",
        sourceNames: { "zh-CN": "安柏", "ja-JP": "アンバー", "en-US": "Amber" },
        sourceGameNames: { "zh-CN": "原神", "en-US": "Genshin Impact" },
        sourceGameId: "原神",
        sourceCategory: "游戏内角色图",
      },
      root,
    );

    expect(saved.ok).toBe(true);
    expect(saved.preset).toMatchObject({
      name: "角色参考",
      group: "常用",
      kind: "precise",
      width: 832,
      height: 1216,
      sourceId: "genshin/amber/default",
      sourceNames: { "zh-CN": "安柏", "ja-JP": "アンバー", "en-US": "Amber" },
      sourceGameId: "原神",
      sourceCategory: "游戏内角色图",
    });
    expect(saved.preset?.fileUrl).toMatch(/^nai-local:\/\/file\//);

    const read = await readReferencePreset(saved.preset!.id, root);
    expect(Buffer.from(read.base64!, "base64")).toEqual(image);

    const grouped = await createReferencePresetGroup("备用", root);
    expect(grouped.library?.groups).toEqual(expect.arrayContaining(["常用", "备用"]));

    const moved = await moveReferencePresetToGroup(saved.preset!.id, "备用", root);
    expect(moved.preset?.group).toBe("备用");
    expect((await listReferencePresets(root)).presets[0]?.group).toBe("备用");

    const removedGroup = await deleteReferencePresetGroup("备用", root);
    expect(removedGroup.ok).toBe(true);
    expect(removedGroup.library?.groups).not.toContain("备用");
    expect(removedGroup.library?.presets[0]?.group).toBe("");
    expect(fs.existsSync(saved.preset!.filePath)).toBe(true);

    // Delete archives the preset: it leaves the list, its versions and image stay (Recently Deleted removes them for good).
    const deleted = await deleteReferencePreset(saved.preset!.id, root);
    expect(deleted.ok).toBe(true);
    expect((await listReferencePresets(root)).presets).toHaveLength(0);
    expect(fs.existsSync(saved.preset!.filePath)).toBe(true);
    expect(fs.readdirSync(path.join(root, "reference-presets"))).toEqual([path.basename(saved.preset!.filePath)]);
  });

  it("keeps a preset whose image file is missing and says so when it is read", async () => {
    const root = temporaryRoot();
    const saved = await saveReferencePreset(
      {
        name: "氛围",
        kind: "vibe",
        base64: Buffer.from("image").toString("base64"),
        extension: "png",
        infoExtracted: 0.7,
        strength: 0.6,
      },
      root,
    );
    fs.rmSync(saved.preset!.filePath);
    expect((await listReferencePresets(root)).presets.map(preset => preset.id)).toEqual([saved.preset!.id]);
    expect(await readReferencePreset(saved.preset!.id, root)).toMatchObject({ ok: false, code: "reference_preset_image_missing", message: "The preset image does not exist; import it again." });
  });

  it("refuses to list or save without an open library", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reference-presets-")); roots.push(root);
    await expect(listReferencePresets(root)).rejects.toMatchObject({ code: 'library_unavailable', reason: 'reference_preset.library_not_open', message: 'The material library is not open.' });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
