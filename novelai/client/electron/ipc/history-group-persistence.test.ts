// History groups are the library's 'history' collections; the history store functions read and write them there
// (step 3e++: settings.json holds no history and no groups).
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PARAMS, type HistoryItem } from "../../src/types";

const fixture = vi.hoisted(() => ({ root: "" }));

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key === "userData") return path.join(fixture.root, "user-data");
      if (key === "pictures") return path.join(fixture.root, "pictures");
      if (key === "exe") return path.join(fixture.root, "app", "MCP for NovelAI");
      return fixture.root;
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

const closers: Array<() => void> = [];
beforeEach(() => {
  fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), "nai-history-group-test-"));
  vi.resetModules();
});

afterEach(() => {
  closers.splice(0).forEach(close => { try { close(); } catch { /* closed */ } });
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

async function setup() {
  const { openLibraryRepository } = await import("../library/repository");
  const repository = openLibraryRepository({ filePath: path.join(fixture.root, "library.sqlite") });
  closers.push(() => repository.close());
  const { activateLibrary, deactivateLibrary } = await import("../library-runtime");
  activateLibrary(repository, { userDataRoot: path.join(fixture.root, "user-data"), libraryDirectory: path.join(fixture.root, "library") });
  closers.unshift(() => deactivateLibrary());
  const store = await import("./store");
  const settingsFile = path.join(fixture.root, "user-data", "settings.json");
  const image = (id: string, groupId?: string): HistoryItem => {
    const filePath = path.join(fixture.root, "output", "2026-09-12", `${id}.png`);
    return { id, filePath, fileUrl: `nai-local://${id}`, date: "2026-09-12", createdAt: "2026-09-12T00:00:00.000Z", params: { ...DEFAULT_PARAMS }, actualSeed: 1, model: DEFAULT_PARAMS.model, width: 832, height: 1216, ...(groupId ? { groupId } : {}) };
  };
  return { repository, store, settingsFile, image };
}

it("creates, renames and reuses history groups as library collections, matching names without regard to case", async () => {
  const { repository, store } = await setup();
  const [created] = store.createHistoryGroup("  Sketches ");
  expect(created).toMatchObject({ name: "Sketches" });
  expect(store.createHistoryGroup("sketches")).toHaveLength(1);
  expect(store.createHistoryGroup("   ")).toHaveLength(1);
  expect(repository.collections("history")).toEqual([{ namespace: "history", id: created.id, name: "Sketches", payload: created }]);
  expect(store.renameHistoryGroup(created.id, " Inks ")).toEqual([{ ...created, name: "Inks" }]);
  expect(store.renameHistoryGroup("missing", "Other")).toEqual([{ ...created, name: "Inks" }]);
  // ensureHistoryGroup: an existing name is reused, a preferred id is renamed to the requested name, else one is created.
  expect(store.ensureHistoryGroup("INKS")).toEqual({ ...created, name: "Inks" });
  expect(store.ensureHistoryGroup("Paint", created.id)).toEqual({ ...created, name: "Paint" });
  const fresh = store.ensureHistoryGroup("Queue output");
  expect(store.getHistoryGroups().map(group => group.name).sort()).toEqual(["Paint", "Queue output"]);
  expect(fresh.id).not.toBe(created.id);
});

it("assigns an image to a group and back; deleting a group ungroups its images (archived ones too) and clears the settings naming it", async () => {
  const { repository, store, settingsFile, image } = await setup();
  const [group] = store.createHistoryGroup("Batch");
  store.addHistory([image("a"), image("b", group.id), image("c", group.id)]);
  repository.put("history", "c", repository.get("history", "c")!.payload, { expectedRevision: 1, archived: true });
  store.setHistoryGroup("a", group.id);
  expect(store.getHistory(undefined, group.id).map(item => item.id).sort()).toEqual(["a", "b"]);
  store.setHistoryGroup("a", "__ungrouped");
  expect(repository.get("history", "a")!.payload).not.toHaveProperty("groupId");
  const revision = repository.get("history", "a")!.revision;
  store.setHistoryGroup("a", undefined);
  expect(repository.get("history", "a")!.revision).toBe(revision);
  store.setSetting("generationGroupId", group.id);
  store.setSetting("activeHistoryGroupId", group.id);
  expect(store.deleteHistoryGroup(group.id)).toEqual([]);
  for (const id of ["b", "c"]) expect(repository.get("history", id)!.payload, id).not.toHaveProperty("groupId");
  expect(repository.get("history", "c")!.archived).toBe(true);
  expect(store.getSettings()).toMatchObject({ generationGroupId: "", activeHistoryGroupId: "" });
  const written = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  expect(Object.keys(written)).toEqual(["settings"]);
  expect(written.settings).toMatchObject({ generationGroupId: "", activeHistoryGroupId: "" });
});

it("checks new history records against the complete generation parameters, keeps one that fails it but is a valid stored record, and refuses an invalid one", async () => {
  const { repository, store, image } = await setup();
  const { qualityPreset: _dropped, ...params } = DEFAULT_PARAMS;
  // A record without a complete parameter set (not expected: generation checks it before the request) is saved anyway,
  // and named with the reason: its image exists and the queue names it.
  const relaxed = store.addHistory([image("complete"), { ...image("sparse"), params } as unknown as HistoryItem]);
  expect(relaxed).toEqual([{ id: "sparse", reason: expect.stringMatching(/Invalid generation history fields.*qualityPreset/) }]);
  expect(repository.get("history", "complete")?.payload.params).toEqual(DEFAULT_PARAMS);
  expect(repository.get("history", "sparse")?.payload.params).toEqual(params);
  // Not even a valid stored record: nothing of the call is written.
  expect(() => store.addHistory([image("third"), { ...image("broken"), params: { ...DEFAULT_PARAMS, steps: "28" } } as unknown as HistoryItem])).toThrow(/Invalid library fields/);
  expect(repository.get("history", "third")).toBeNull();
  expect(repository.get("history", "broken")).toBeNull();
  // Every other write keeps a stored record's parameters as they are (sparse).
  expect(store.updateHistoryItem("complete", { params } as unknown as Partial<HistoryItem>)?.params).toEqual(params);
});
