import { app } from "electron";
import path from "path";

/**
 * The folder that installing another version replaces, for the installed executable `executable`. On macOS that is
 * the whole application bundle (…/MCP for NovelAI.app, whose executable sits in Contents/MacOS), elsewhere the folder
 * that holds the executable (the NSIS installation folder). For the Windows portable build the executable runs from
 * its temporary self-extraction folder, which that build replaces on every start.
 */
export function installationRoot(executable: string, platform: NodeJS.Platform = process.platform): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const folder = pathApi.dirname(executable);
  if (platform === "darwin") {
    const contents = pathApi.dirname(folder), bundle = pathApi.dirname(contents);
    if (pathApi.basename(folder) === "MacOS" && pathApi.basename(contents) === "Contents" && /\.app$/i.test(bundle)) return bundle;
  }
  return folder;
}

/** installationRoot() of this running app (save folders may not lie inside it; see data-directory-guard.ts). */
export function installedAppDir(): string {
  return installationRoot(app.getPath("exe"));
}
