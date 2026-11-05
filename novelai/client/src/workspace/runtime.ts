import type { WorkspaceController } from "./controller";

let current: WorkspaceController | null = null;
const listeners = new Set<() => void>();

export function setWorkspaceRuntime(workspace: WorkspaceController | null) {
  current = workspace;
  listeners.forEach((listener) => listener());
}
export const getWorkspaceRuntime = () => current;
export function subscribeWorkspaceRuntime(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
