import { plainErrorMessage, scrubHostErrorSuffixes } from "../host-errors/bridge";
/** Local workspace bridge protocol. Account settings and credentials are never workspace state. */
export interface WorkspaceRequest {
  requestId: string;
  method: string;
  args: Record<string, unknown>;
}

export interface WorkspaceErrorInfo {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type WorkspaceResponse = { requestId: string; result: unknown } | { requestId: string; error: WorkspaceErrorInfo };

export interface WorkspaceAsset {
  id: string;
  role: string;
  mimeType: string;
  width?: number;
  height?: number;
  data?: string;
  path?: string;
}

export interface WorkspaceDocument {
  schemaVersion: 1;
  state: Record<string, unknown>;
  assets: WorkspaceAsset[];
}

export const WORKSPACE_CAPABILITIES = {
  readWorkspace: true,
  readImages: true,
  draftEdit: true,
  applyEdit: true,
  undoEdit: true,
  maskEdit: true,
  generation: false,
  postprocess: false,
  batchGeneration: false,
  v5ReferenceGeneration: false,
} as const;

export class WorkspaceError extends Error {
  constructor(public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * The error a workspace reply carries to the bridge (and on to MCP): code, the plain message and details only. A
 * host error caught here may have crossed contextBridge with its structure in an invisible message suffix
 * (host-errors/bridge.ts); that suffix, with its reason and params, stays in the window (step 4a).
 */
export function workspaceErrorInfo(error: unknown): WorkspaceErrorInfo {
  return error instanceof WorkspaceError
    ? { code: error.code, message: plainErrorMessage(error), ...(error.details ? { details: scrubHostErrorSuffixes(error.details) } : {}) }
    : { code: "internal_error", message: error instanceof Error ? plainErrorMessage(error) : "Workspace operation failed." };
}
