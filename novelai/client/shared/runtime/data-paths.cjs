'use strict';
/**
 * The one place that decides where MCP for NovelAI keeps its data. The Electron client
 * (electron/main.ts and friends, compiled to dist-electron/shared/runtime/), the MCP server
 * (novelai/src, also bundled into the single-file MCP) and the source launcher scripts all
 * use this module, so the client and the MCP server always agree on bridge.json and the
 * inbox folders. CommonJS with no dependencies so every one of them can load it as is.
 *
 * Data root: NOVELAI_DATA_DIR when set (development, tests, isolated worktrees), otherwise
 * <appData>/mcp-for-novelai, where <appData> is what Electron calls appData:
 *   macOS   ~/Library/Application Support
 *   Windows %APPDATA% (normally ~\AppData\Roaming)
 *   Linux   $XDG_CONFIG_HOME, or ~/.config
 *
 * Layout under the data root (also Electron's userData, so Chromium's profile and the
 * settings file live directly in it):
 *   settings.json (SETTINGS_FILE_NAME, rotated to .bak and .bak2)  the client's settings,
 *             account summary and encrypted token
 *   library.sqlite                                          asset library database, the one store of
 *             the library (created empty, version 8, by the first start of a data root)
 *   library/  asset library files (studies/, covers/)
 *   trash/    Recently Deleted: files of deleted library items, one folder per entry (electron/library-trash.ts);
 *             the entries themselves are rows of library.sqlite. Purged after 30 days; never in a backup.
 *   runtime/bridge.json, runtime/frozen-queue, runtime/queue-recipes,
 *   runtime/tag-dictionary, runtime/public-tag-query-cache-v1  live client state and caches
 *   backups/  default automatic backup folder
 *   logs/     default log folder
 *   image-inputs/  pasted and prepared source images (the only folder restored workbench
 *             inputs are admitted from)
 *   updates/  the in-app update (electron/update/): downloads/ (the downloaded release file), <id>/ (one update's
 *             helper script, its log and states), pending.json (an update handed to the helper); never in a backup
 *   output/   default image output folder of an isolated run (NOVELAI_DATA_DIR naming another folder
 *             than the default data root, isCustomDataRoot); otherwise the default is <Pictures>/MCP for NovelAI
 *   workspace/novelai/{library,study}-{inbox,exports}       inbox and export folders used
 *             when NOVELAI_PROJECT_ROOT is not set
 */
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const APP_DATA_DIR_NAME = 'mcp-for-novelai';
const DATA_DIR_ENV = 'NOVELAI_DATA_DIR';
const PROJECT_ROOT_ENV = 'NOVELAI_PROJECT_ROOT';
/** The client's settings file directly in the data root. */
const SETTINGS_FILE_NAME = 'settings.json';
/** Folder name of the default image output directory under the user's Pictures folder. */
const DEFAULT_OUTPUT_FOLDER_NAME = 'MCP for NovelAI';
/** Inbox and export folders, relative to the project root (POSIX form, as shown to models). */
const PROJECT_FOLDERS = Object.freeze({
  materialInbox: 'novelai/library-inbox',
  materialExports: 'novelai/library-exports',
  studyInbox: 'novelai/study-inbox',
  studyExports: 'novelai/study-exports',
});
/** projectRoot().source values. */
const PROJECT_ROOT_SOURCES = Object.freeze({ env: PROJECT_ROOT_ENV, dataDir: 'data-dir-workspace' });

/** @param {string | undefined} platform */
function pathFor(platform) { return platform === 'win32' ? nodePath.win32 : nodePath.posix; }

/** @param {unknown} value */
function nonBlank(value) { return typeof value === 'string' && value.trim() ? value.trim() : ''; }

/**
 * Electron's appData folder for a platform.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string}
 */
function appDataDirectory(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support');
  if (platform === 'win32') {
    const appData = nonBlank(env.APPDATA);
    return appData && p.isAbsolute(appData) ? p.normalize(appData) : p.join(home, 'AppData', 'Roaming');
  }
  const xdg = nonBlank(env.XDG_CONFIG_HOME);
  return xdg && p.isAbsolute(xdg) ? p.normalize(xdg) : p.join(home, '.config');
}

/**
 * Whether this process runs tests: a `node --test` file (NODE_TEST_CONTEXT, or --test among its own flags), a Vitest
 * worker (VITEST), or a *.test.* file started directly with node.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ execArgv?: string[], argv?: string[] }} [proc]
 */
function isTestProcess(env = process.env, proc = process) {
  if (nonBlank(env.NODE_TEST_CONTEXT) || nonBlank(env.VITEST)) return true;
  if ((proc.execArgv ?? []).some(flag => flag === '--test' || flag.startsWith('--test-'))) return true;
  return /\.test\.[cm]?[jt]sx?$/.test(proc.argv?.[1] ?? '');
}

/**
 * A test process never resolves the user's real data root from its own environment: a test file run on its own (`node --test tests/x.test.mjs`, one Vitest file outside its config) without
 * NOVELAI_DATA_DIR stops here with this error instead of reading or writing <appData>/mcp-for-novelai. `npm test`
 * (tests/run-tests.mjs), tests/isolate-data-dir.mjs and the client's Vitest globalSetup give every test process a
 * throwaway data root. Options with their own env (explicit platform/env/homedir) only compute paths and are not refused.
 * @param {Record<string, string | undefined>} env
 * @param {string} what
 */
function refuseRealRootInTests(env, what) {
  if (env !== process.env || !isTestProcess()) return;
  throw Object.assign(new Error(`[test isolation] A test process asked for ${what} without ${DATA_DIR_ENV}; the real data root is never used by tests. Run the tests with npm test (novelai: tests/run-tests.mjs; client: vitest with its config), or start the file with node --test --import ./tests/isolate-data-dir.mjs, or set ${DATA_DIR_ENV} to a throwaway folder.`), { code: 'test_isolation_required' });
}

/**
 * The data root: NOVELAI_DATA_DIR (resolved to an absolute path) or <appData>/mcp-for-novelai.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string}
 */
function resolveDataRoot(options = {}) {
  const env = options.env ?? process.env;
  const p = pathFor(options.platform ?? process.platform);
  const override = nonBlank(env[DATA_DIR_ENV]);
  if (override) return p.resolve(override);
  refuseRealRootInTests(env, 'the default data root');
  return p.join(appDataDirectory(options), APP_DATA_DIR_NAME);
}

/**
 * Every fixed location under one data root.
 * @param {string} root
 * @param {{ platform?: string }} [options]
 */
function dataPathsFor(root, options = {}) {
  const p = pathFor(options.platform ?? process.platform);
  const library = p.join(root, 'library');
  const runtime = p.join(root, 'runtime');
  return Object.freeze({
    root,
    library,
    libraryDatabase: p.join(root, 'library.sqlite'),
    studies: p.join(library, 'studies'),
    runtime,
    bridgeFile: p.join(runtime, 'bridge.json'),
    tagDictionary: p.join(runtime, 'tag-dictionary'),
    tagQueryCache: p.join(runtime, 'public-tag-query-cache-v1'),
    backups: p.join(root, 'backups'),
    logs: p.join(root, 'logs'),
    imageInputs: p.join(root, 'image-inputs'),
    workspace: p.join(root, 'workspace'),
  });
}

/**
 * <appData>/mcp-for-novelai: the data root without NOVELAI_DATA_DIR (a path only; nothing is read or created).
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {string}
 */
function defaultDataRoot(options = {}) {
  return pathFor(options.platform ?? process.platform).join(appDataDirectory(options), APP_DATA_DIR_NAME);
}

/**
 * A folder with every symbolic link of its existing part resolved and the part that does not exist yet appended.
 * @param {string} folder @param {typeof nodePath.posix} p @param {(value: string) => string} realpath
 */
function canonicalFolder(folder, p, realpath) {
  const missing = [];
  for (let current = folder; ;) {
    try { return p.join(realpath(current), ...missing); }
    catch {
      const parent = p.dirname(current);
      if (parent === current) return folder;
      missing.unshift(p.basename(current)); current = parent;
    }
  }
}

/**
 * Whether two data roots are the same folder: the same resolved path without trailing separators (letter case ignored
 * on Windows); or, for two paths with the same last name only, the same folder on disk — through a symbolic link on the
 * way, or another letter case on a case-insensitive volume. A path with another last name (a test or isolated data root)
 * is never looked at on disk. Paths of another platform than this one are only compared as text.
 * @param {string} a @param {string} b
 * @param {{ platform?: string, fs?: { realpathSync: any, statSync: any } }} [options]
 */
function sameDataRoot(a, b, options = {}) {
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  const norm = (/** @type {string} */ value) => {
    const resolved = p.resolve(value), root = p.parse(resolved).root;
    return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  };
  const fold = (/** @type {string} */ value) => platform === 'win32' ? value.toLowerCase() : value;
  const left = norm(a), right = norm(b);
  if (fold(left) === fold(right)) return true;
  if (p.basename(left).toLowerCase() !== p.basename(right).toLowerCase() || platform !== process.platform) return false;
  const files = options.fs ?? fs;
  try {
    const realpath = (/** @type {string} */ value) => (files.realpathSync.native ?? files.realpathSync)(value);
    if (fold(canonicalFolder(left, p, realpath)) === fold(canonicalFolder(right, p, realpath))) return true;
    const one = files.statSync(left), two = files.statSync(right);
    return one.dev === two.dev && one.ino === two.ino;
  } catch { return false; }
}

/**
 * Whether NOVELAI_DATA_DIR names another folder than the default data root: an isolated run (development, tests,
 * worktrees). NOVELAI_DATA_DIR set to the default data root itself (as every configuration of Settings › MCP access
 * writes it, and so as an agent's MCP server may start the app) is an ordinary start.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string, fs?: any }} [options]
 */
function isCustomDataRoot(options = {}) {
  const env = options.env ?? process.env;
  const override = nonBlank(env[DATA_DIR_ENV]);
  if (!override) return false;
  return !sameDataRoot(override, defaultDataRoot(options), options);
}

/**
 * The default image output folder (outputDir until the user picks one): <data root>/output for an isolated run
 * (isCustomDataRoot), so development, tests and worktrees keep their images with their data; otherwise — also with
 * NOVELAI_DATA_DIR set to the default data root — <Pictures>/MCP for NovelAI.
 * @param {string} picturesDirectory the user's Pictures folder (Electron app.getPath('pictures'))
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string, fs?: any }} [options]
 * @returns {string}
 */
function defaultOutputDirectory(picturesDirectory, options = {}) {
  const p = pathFor(options.platform ?? process.platform);
  if (isCustomDataRoot(options)) return p.join(resolveDataRoot(options), 'output');
  // The Pictures folder is the caller's (Electron's app.getPath, mocked in tests): only a path is computed here.
  return p.join(picturesDirectory, DEFAULT_OUTPUT_FOLDER_NAME);
}

/**
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string }} [options]
 */
function resolveDataPaths(options = {}) { return dataPathsFor(resolveDataRoot(options), options); }

/**
 * The project root that inbox/export folders and project-relative paths are based on:
 * NOVELAI_PROJECT_ROOT (resolved to an absolute path) when set, otherwise <data root>/workspace.
 * @param {{ platform?: string, env?: Record<string, string | undefined>, homedir?: string }} [options]
 * @returns {{ root: string, source: string }}
 */
function resolveProjectRoot(options = {}) {
  const env = options.env ?? process.env;
  const p = pathFor(options.platform ?? process.platform);
  const configured = nonBlank(env[PROJECT_ROOT_ENV]);
  if (configured) return { root: p.resolve(configured), source: PROJECT_ROOT_SOURCES.env };
  return { root: resolveDataPaths(options).workspace, source: PROJECT_ROOT_SOURCES.dataDir };
}

/**
 * The four inbox/export folders under a project root.
 * @param {string} projectRoot
 * @param {{ platform?: string }} [options]
 * @returns {{ materialInbox: string, materialExports: string, studyInbox: string, studyExports: string }}
 */
function projectDirectories(projectRoot, options = {}) {
  const p = pathFor(options.platform ?? process.platform);
  const at = (/** @type {string} */ relative) => p.join(projectRoot, ...relative.split('/'));
  return {
    materialInbox: at(PROJECT_FOLDERS.materialInbox),
    materialExports: at(PROJECT_FOLDERS.materialExports),
    studyInbox: at(PROJECT_FOLDERS.studyInbox),
    studyExports: at(PROJECT_FOLDERS.studyExports),
  };
}

exports.APP_DATA_DIR_NAME = APP_DATA_DIR_NAME;
exports.DATA_DIR_ENV = DATA_DIR_ENV;
exports.PROJECT_ROOT_ENV = PROJECT_ROOT_ENV;
exports.DEFAULT_OUTPUT_FOLDER_NAME = DEFAULT_OUTPUT_FOLDER_NAME;
exports.SETTINGS_FILE_NAME = SETTINGS_FILE_NAME;
exports.PROJECT_FOLDERS = PROJECT_FOLDERS;
exports.PROJECT_ROOT_SOURCES = PROJECT_ROOT_SOURCES;
exports.appDataDirectory = appDataDirectory;
exports.resolveDataRoot = resolveDataRoot;
exports.dataPathsFor = dataPathsFor;
exports.resolveDataPaths = resolveDataPaths;
exports.defaultOutputDirectory = defaultOutputDirectory;
exports.defaultDataRoot = defaultDataRoot;
exports.sameDataRoot = sameDataRoot;
exports.isCustomDataRoot = isCustomDataRoot;
exports.resolveProjectRoot = resolveProjectRoot;
exports.projectDirectories = projectDirectories;
exports.isTestProcess = isTestProcess;
