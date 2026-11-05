import { ipcMain, nativeImage, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getBridgeWorkbenchPath, setBridgeWorkbenchPath } from "./ipc/nai";

/** A narrow synchronous commit closes the renderer CAS -> main input race. A restored workbench image must be a
 * file inside `inputRoot` (<data root>/image-inputs, where pasted and prepared source copies are saved) or the
 * path that was the workbench image before (an undo); anything else, elsewhere in the data root included, is refused. */
export function registerWorkbenchSync(getWindow: () => BrowserWindow | null, inputRoot: string) {
  fs.mkdirSync(path.resolve(inputRoot), { recursive: true, mode: 0o700 });
  const managedInputs = fs.realpathSync(path.resolve(inputRoot));
  const admitted = new Set<string>();
  ipcMain.on("novelai:bridge:commit-workbench", (event, input: unknown) => {
    try {
      if (getWindow()?.webContents !== event.sender) throw new Error("Invalid workspace sender.");
      const previous = getBridgeWorkbenchPath();
      if (previous) { try { admitted.add(fs.realpathSync(previous)); } catch { /* Missing original stays unavailable. */ } }
      if (input === null) { setBridgeWorkbenchPath(null); event.returnValue = { ok: true }; return; }
      if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Invalid workbench image path.");
      const resolved = fs.realpathSync(input);
      const relative = path.relative(managedInputs, resolved);
      if (!admitted.has(resolved) && (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative))) throw new Error("Restored images must come from this NovelAI workspace.");
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error("Invalid workbench image size.");
      const image = nativeImage.createFromBuffer(fs.readFileSync(resolved));
      const dimensions = image.getSize();
      if (image.isEmpty() || dimensions.width * dimensions.height > 64 * 1024 * 1024) throw new Error("Workbench image cannot be decoded safely.");
      admitted.add(resolved);
      setBridgeWorkbenchPath(resolved);
      event.returnValue = { ok: true };
    } catch (error) { event.returnValue = { ok: false, message: error instanceof Error ? error.message : "Workbench commit failed." }; }
  });
}
