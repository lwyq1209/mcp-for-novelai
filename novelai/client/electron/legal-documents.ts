import fs from "node:fs/promises";
import path from "node:path";

/** The two legal files the About page shows: the project's LICENSE and the generated THIRD_PARTY_NOTICES.md. */
export type LegalDocumentKind = "license" | "notices";

const FILE_NAMES: Record<LegalDocumentKind, string> = { license: "LICENSE", notices: "THIRD_PARTY_NOTICES.md" };

/**
 * Where a legal file is: a packaged app has both in its resources folder (package.json build.extraResources); a
 * development run reads them from the repository (LICENSE at its root, the notices in novelai/client).
 */
export function legalDocumentPath(kind: LegalDocumentKind, location: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  if (!Object.hasOwn(FILE_NAMES, kind)) throw new Error(`Unknown legal document: ${String(kind)}`);
  if (location.packaged) return path.join(location.resourcesPath, FILE_NAMES[kind]);
  return kind === "license" ? path.resolve(location.appPath, "..", "..", "LICENSE") : path.join(location.appPath, FILE_NAMES[kind]);
}

/** The file's text (at most 4 MiB, which the notices stay far below). */
export async function readLegalDocument(kind: LegalDocumentKind, location: { packaged: boolean; resourcesPath: string; appPath: string }): Promise<string> {
  const file = legalDocumentPath(kind, location);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error(`${FILE_NAMES[kind]} is not a readable text file.`);
  return fs.readFile(file, "utf8");
}
