import type { DataBackupCategory, DataBackupIntegrityReason } from "../../types";

/**
 * The rules of Settings › Storage › export & restore (src/settings/sections/BackupSettings.tsx): which categories a
 * backup offers, which need a separate confirmation, and which integrity reasons apply to a selection. (Step 4c2: the
 * old settings dialog's backup panels that lived beside these were removed.)
 */
const CATEGORIES: DataBackupCategory[] = [
  "configuration",
  "apiCredentials",
  "artistLibrary",
  "referencePresets",
  "imageHistory",
  "promptPresets",
  "workspaceData",
];
export const DEFAULT_DATA_BACKUP_CATEGORIES = CATEGORIES.filter(category=>category!=="apiCredentials");
/** The import result with its counts after the workspace merge also in the params its text is rendered from. */
export function withMergedCounts<T extends { imported: number; skipped: number }>(result: T): T {
  const params = (result as { params?: unknown }).params;
  return params && typeof params === "object" && !Array.isArray(params) ? { ...result, params: { ...params, imported: result.imported, skipped: result.skipped } } : result;
}
export const requiresCredentialExportConfirmation = (categories: Iterable<DataBackupCategory>) => new Set(categories).has("apiCredentials");
export const initialImportConfirmationStage = (degraded: boolean | undefined): 1 | 4 => degraded ? 4 : 1;
const LIBRARY_BACKUP_CATEGORIES:DataBackupCategory[]=["imageHistory","artistLibrary","referencePresets","promptPresets"];
const LIBRARY_INTEGRITY_CODES=new Set(["library-snapshot-unavailable","library-assets-missing"]);
export function integrityReasonsForSelection(reasons:DataBackupIntegrityReason[]|undefined,selection:Iterable<DataBackupCategory>){const selected=new Set(selection),fullLibrary=LIBRARY_BACKUP_CATEGORIES.every(category=>selected.has(category));return(reasons??[]).filter(reason=>(fullLibrary||!LIBRARY_INTEGRITY_CODES.has(reason.code))&&reason.categories.some(category=>selected.has(category)));}
