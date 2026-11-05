import { useEffect } from "react";
import { createRendererWorkspace } from "./adapter";
import { useAppStore } from "../store";
import { setWorkspaceRuntime } from "./runtime";
import { windowQueueMonitor } from "./queue-monitor";

/**
 * The live workspace bridge: agent requests to the canvas and the queue's read model (the queue page and the top bar
 * follow host batch events from boot on). It renders nothing; the old floating 「任务与 Agent」 panel was removed in
 * step 4c2 (the queue page shows the queue, the canvas shows agent drafts).
 */
export function WorkspaceBridge() {
  const bootDone = useAppStore((state) => state.bootDone);
  useEffect(() => {
    if (!bootDone) return;
    const workspace = createRendererWorkspace();
    const remove = window.naiDesktop.onWorkspaceRequest((request) => {
      void workspace.handle(request).then((response) => window.naiDesktop.replyWorkspace(response));
    });
    setWorkspaceRuntime(workspace);
    window.naiDesktop.workspaceReady(workspace.getView().workspaceId);
    const removeQueue = windowQueueMonitor()?.connect() ?? (() => {});
    return () => { remove(); removeQueue(); setWorkspaceRuntime(null); workspace.dispose(); };
  }, [bootDone]);
  return null;
}
