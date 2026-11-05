// Step 3a review rework (P3-6): a restored workbench image is admitted only from <data root>/image-inputs (or as the
// previous workbench image of an undo), never from elsewhere in the data root. Real files in a temporary data root.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCleanupsSync } from '../src/test-support/temp-dirs';
import { PNG } from "pngjs";

const state = vi.hoisted(() => ({ listeners: new Map<string, (event: any, input: unknown) => void>(), workbench: null as string | null }));
vi.mock("electron", () => ({
  ipcMain: { on: (channel: string, listener: (event: any, input: unknown) => void) => { state.listeners.set(channel, listener); } },
  nativeImage: { createFromBuffer: (buffer: Buffer) => { const png = PNG.sync.read(buffer); return { isEmpty: () => false, getSize: () => ({ width: png.width, height: png.height }) }; } },
}));
vi.mock("./ipc/nai", () => ({ getBridgeWorkbenchPath: () => state.workbench, setBridgeWorkbenchPath: (value: string | null) => { state.workbench = value; } }));
import { registerWorkbenchSync } from "./workbench-sync";

const roots: string[] = [];
afterEach(() => { state.listeners.clear(); state.workbench = null; runCleanupsSync(roots.splice(0).map(root => () => fs.rmSync(root, { recursive: true, force: true }))); });
const png = () => { const image = new PNG({ width: 2, height: 2 }); image.data.fill(255); return PNG.sync.write(image); };

function setup() {
  const dataRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nai-workbench-sync-")));
  roots.push(dataRoot);
  const inputRoot = path.join(dataRoot, "image-inputs");
  const sender = {};
  registerWorkbenchSync(() => ({ webContents: sender }) as any, inputRoot);
  const commit = (input: unknown) => { const event: any = { sender }; state.listeners.get("novelai:bridge:commit-workbench")!(event, input); return event.returnValue as { ok: boolean; message?: string }; };
  const file = (relative: string) => { const target = path.join(dataRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, png()); return target; };
  return { dataRoot, inputRoot, commit, file };
}

describe("restored workbench inputs", () => {
  it("creates <data root>/image-inputs and admits an image saved there", () => {
    const h = setup();
    expect(fs.statSync(h.inputRoot).isDirectory()).toBe(true);
    const saved = h.file("image-inputs/source.png");
    expect(h.commit(saved)).toEqual({ ok: true });
    expect(state.workbench).toBe(saved);
    expect(h.commit(null)).toEqual({ ok: true });
    expect(state.workbench).toBeNull();
  });

  it("refuses files elsewhere in the data root, outside it, and links that leave image-inputs", () => {
    const h = setup();
    const refused = [
      h.file("library/covers/cover.png"),
      h.file("runtime/frozen-queue/image.png"),
      h.file("output/2026-11-02/result.png"),
      h.file("image-inputs-other/near-miss.png"),
    ];
    const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nai-workbench-outside-")));
    roots.push(outsideRoot);
    const outside = path.join(outsideRoot, "elsewhere.png"); fs.writeFileSync(outside, png());
    refused.push(outside);
    const link = path.join(h.inputRoot, "link.png"); fs.symlinkSync(h.file("library/linked.png"), link);
    refused.push(link);
    for (const candidate of refused) {
      expect(h.commit(candidate), candidate).toEqual({ ok: false, message: "Restored images must come from this NovelAI workspace." });
      expect(state.workbench).toBeNull();
    }
    expect(h.commit("relative/source.png")).toMatchObject({ ok: false });
  });

  it("still admits the previous workbench image when an undo restores it", () => {
    const h = setup();
    const previous = h.file("output/2026-11-02/generated.png");
    state.workbench = previous; // the image the workbench showed before, e.g. a generated result
    expect(h.commit(h.file("image-inputs/next.png"))).toEqual({ ok: true });
    expect(h.commit(previous)).toEqual({ ok: true });
    expect(state.workbench).toBe(previous);
  });
});
