import { WorkspaceError } from "./protocol";
import { record, validatePatch, type CreativeState, type EditablePatch } from "./state";

export type ScenePatch = Pick<EditablePatch, "params" | "charCaptions">;
export interface BatchScene { sceneId: string; patch: ScenePatch }

/** Detached text recipes share the editor's validation without writing its draft. */
export function validateScenePatch(input: unknown, current: CreativeState): ScenePatch {
  const value = record(input, "scene patch");
  if (!Object.keys(value).length || Object.keys(value).some(key => !["params", "charCaptions"].includes(key))) throw new WorkspaceError("invalid_argument", "A scene patch only accepts params and charCaptions.");
  return validatePatch(value, current);
}

/** Shared plan shape, also checked before the process-owned scheduler accepts it. */
export function parseBatchScenes(input: unknown, count: number, mode: string, allowSingleQueued = false): BatchScene[] {
  const minimum = allowSingleQueued ? 1 : 2;
  if (mode !== "t2i" || !Array.isArray(input) || input.length !== count || count < minimum || count > 20) throw new WorkspaceError("invalid_argument", `Scenes require t2i and ${minimum}–20 entries matching count.`);
  const ids = new Set<string>();
  return input.map(item => {
    const value = record(item, "scene");
    if (Object.keys(value).some(key => !["sceneId", "patch"].includes(key)) || typeof value.sceneId !== "string" || !value.sceneId.trim() || value.sceneId.length > 120 || /[\x00-\x1f]/.test(value.sceneId) || ids.has(value.sceneId)) throw new WorkspaceError("invalid_argument", "Each scene requires a unique sceneId and a text patch.");
    ids.add(value.sceneId);
    const patch = record(value.patch, "scene patch");
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !["params", "charCaptions"].includes(key))) throw new WorkspaceError("invalid_argument", "A scene patch only accepts params and charCaptions.");
    return { sceneId: value.sceneId, patch: structuredClone(patch) };
  });
}
