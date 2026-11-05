// Types of data-paths.cjs (the single data-root module shared by the client and the MCP server).
export interface PlatformOptions {
  platform?: string;
  env?: Record<string, string | undefined>;
  homedir?: string;
}
export interface DataPaths {
  readonly root: string;
  readonly library: string;
  readonly libraryDatabase: string;
  readonly studies: string;
  readonly runtime: string;
  readonly bridgeFile: string;
  readonly tagDictionary: string;
  readonly tagQueryCache: string;
  readonly backups: string;
  readonly logs: string;
  readonly imageInputs: string;
  readonly workspace: string;
}
export interface ProjectDirectories {
  materialInbox: string;
  materialExports: string;
  studyInbox: string;
  studyExports: string;
}
export declare const APP_DATA_DIR_NAME: 'mcp-for-novelai';
export declare const DATA_DIR_ENV: 'NOVELAI_DATA_DIR';
export declare const PROJECT_ROOT_ENV: 'NOVELAI_PROJECT_ROOT';
export declare const DEFAULT_OUTPUT_FOLDER_NAME: 'MCP for NovelAI';
export declare const SETTINGS_FILE_NAME: 'settings.json';
export declare const PROJECT_FOLDERS: Readonly<Record<keyof ProjectDirectories, string>>;
export declare const PROJECT_ROOT_SOURCES: Readonly<{ env: 'NOVELAI_PROJECT_ROOT'; dataDir: 'data-dir-workspace' }>;
export declare function appDataDirectory(options?: PlatformOptions): string;
export declare function resolveDataRoot(options?: PlatformOptions): string;
export declare function dataPathsFor(root: string, options?: { platform?: string }): DataPaths;
export declare function resolveDataPaths(options?: PlatformOptions): DataPaths;
/** <data root>/output when NOVELAI_DATA_DIR is set, else <Pictures>/MCP for NovelAI. */
export declare function defaultOutputDirectory(picturesDirectory: string, options?: PlatformOptions): string;
export declare function resolveProjectRoot(options?: PlatformOptions): { root: string; source: 'NOVELAI_PROJECT_ROOT' | 'data-dir-workspace' };
export declare function projectDirectories(projectRoot: string, options?: { platform?: string }): ProjectDirectories;
/** A test process (node --test, Vitest, or a *.test.* file started directly): it never resolves the real data root from its own environment. */
export declare function isTestProcess(env?: Record<string, string | undefined>, proc?: { execArgv?: string[]; argv?: string[] }): boolean;
