/**
 * Where `nai` works: its data folder and project root, decided once before any business module is loaded (the
 * MCP modules read NOVELAI_DATA_DIR and NOVELAI_PROJECT_ROOT when they are imported: src/business-guards.mjs
 * PROJECT_ROOT, src/material-tools.mjs and src/study-tools.mjs inbox folders). src/cli.mjs resolves them here, writes
 * them into process.env and only then imports src/cli-run.mjs, so every layer sees the same two folders.
 *
 * Data folder: --data-dir, else NOVELAI_DATA_DIR, else the app's default (client/shared/runtime/data-paths.cjs).
 * Project root: --project, else NOVELAI_PROJECT_ROOT, else the nearest folder at or above the working directory that
 * has a .mcp.json / .pi/mcp.json whose mcpServers.novelai.env sets NOVELAI_PROJECT_ROOT (then that value, with ${VAR}
 * and ${VAR:-default} expanded, is the project root, a relative one taken from that folder: the same root the agent's
 * MCP server there uses; this comes before the folder's inboxes), or holds novelai/library-inbox or
 * novelai/study-inbox, else <data folder>/workspace. Of those configuration files
 * only that one key is read. Nothing is written.
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import dataPaths from '../client/shared/runtime/data-paths.cjs';

const { DATA_DIR_ENV, PROJECT_ROOT_ENV } = dataPaths;
const nonBlank = value => typeof value === 'string' && value.trim() ? value.trim() : '';
const isDirectory = file => { try { return statSync(file).isDirectory(); } catch { return false; } };
/** Largest MCP configuration file read while looking for the project root. */
const CONFIG_LIMIT = 1024 * 1024;
export const PROJECT_CONFIG_FILES = Object.freeze(['.mcp.json', '.pi/mcp.json']);

/**
 * `${VAR}` and `${VAR:-default}` in a configuration value, as Claude Code expands them in .mcp.json: the variable from
 * `env`, else the default (`${VAR}` without one stays as it is). Returns the text, or null when a `${…}` is left.
 */
export function expandConfigValue(value, env = process.env) {
  const text = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, name, fallback) => {
    const set = env[name];
    if (typeof set === 'string' && set !== '') return set;
    return fallback !== undefined ? fallback : match;
  });
  return text.includes('${') ? null : text;
}

/** The NOVELAI_PROJECT_ROOT a configuration file sets for its `novelai` server (expanded), or null. Reads that key only. */
function configuredProjectRoot(file, env) {
  try {
    if (statSync(file).size > CONFIG_LIMIT) return null;
    const value = JSON.parse(readFileSync(file, 'utf8'))?.mcpServers?.novelai?.env?.[PROJECT_ROOT_ENV];
    if (typeof value !== 'string') return null;
    return nonBlank(expandConfigValue(value, env) ?? '') || null;
  } catch { return null; }
}

/**
 * What makes `directory` a project root: {root, marker, markerPath}, or null. A configuration there that sets the
 * novelai server's project root comes first (it names the root that server uses); an unresolved or empty value is no
 * marker. Then the inbox folders.
 */
export function projectMarker(directory, env = process.env) {
  for (const file of PROJECT_CONFIG_FILES) {
    const markerPath = path.join(directory, ...file.split('/'));
    const configured = configuredProjectRoot(markerPath, env);
    if (configured) return { root: path.resolve(directory, configured), marker: file, markerPath };
  }
  for (const inbox of ['novelai/library-inbox', 'novelai/study-inbox']) if (isDirectory(path.join(directory, ...inbox.split('/')))) return { root: directory, marker: inbox, markerPath: path.join(directory, ...inbox.split('/')) };
  return null;
}

/** The project root found at or above `cwd`: {root, marker, markerPath}, or null. */
export function detectProjectRoot(cwd, env = process.env) {
  for (let current = path.resolve(cwd); ; current = path.dirname(current)) {
    const found = projectMarker(current, env);
    if (found) return found;
    if (path.dirname(current) === current) return null;
  }
}

export class CliEnvironmentError extends Error {
  constructor(code, message) { super(message); this.name = 'CliEnvironmentError'; this.code = code; }
}

/**
 * The two folders of this run: {dataRoot|null (the app's default), dataSource, projectRoot|null (the data folder's
 * workspace), projectSource}. dataSource: '--data-dir' | 'NOVELAI_DATA_DIR' | 'default'. projectSource: '--project' |
 * 'NOVELAI_PROJECT_ROOT' | 'detected' (with marker, the inbox folder or configuration file found, and markerPath, where) |
 * 'data-dir-workspace'. A --project folder must exist.
 */
export function resolveCliEnvironment({ global = {}, env = process.env, cwd = process.cwd() } = {}) {
  let dataRoot = null, dataSource = 'default';
  if (global['data-dir'] !== undefined) {
    if (!nonBlank(global['data-dir'])) throw new CliEnvironmentError('usage', '--data-dir needs a folder.');
    dataRoot = path.resolve(cwd, global['data-dir'].trim()); dataSource = '--data-dir';
  } else if (nonBlank(env[DATA_DIR_ENV])) { dataRoot = path.resolve(cwd, env[DATA_DIR_ENV].trim()); dataSource = DATA_DIR_ENV; }
  if (global['image-dir'] !== undefined && !nonBlank(global['image-dir'])) throw new CliEnvironmentError('usage', '--image-dir needs a folder.');
  let projectRoot = null, projectSource = 'data-dir-workspace', marker = null, markerPath = null;
  if (global.project !== undefined) {
    if (!nonBlank(global.project)) throw new CliEnvironmentError('usage', '--project needs a folder.');
    projectRoot = path.resolve(cwd, global.project.trim()); projectSource = '--project';
    if (!isDirectory(projectRoot)) throw new CliEnvironmentError('project_not_found', 'The --project folder does not exist (or is not a folder). Nothing was sent.');
  } else if (nonBlank(env[PROJECT_ROOT_ENV])) { projectRoot = path.resolve(cwd, env[PROJECT_ROOT_ENV].trim()); projectSource = PROJECT_ROOT_ENV; }
  else {
    const detected = detectProjectRoot(cwd, env);
    if (detected) { projectRoot = detected.root; projectSource = 'detected'; marker = detected.marker; markerPath = detected.markerPath; }
  }
  return { dataRoot, dataSource, projectRoot, projectSource, ...(marker ? { marker, markerPath } : {}) };
}

/**
 * Writes the folders into `env` (NOVELAI_DATA_DIR and NOVELAI_PROJECT_ROOT as absolute paths; the project root is
 * removed when the data folder's workspace is meant) and removes ELECTRON_RUN_AS_NODE, which only told the app's
 * executable to run nai as Node and must reach no other process.
 */
export function applyCliEnvironment(resolved, env = process.env) {
  if (resolved.dataRoot) env[DATA_DIR_ENV] = resolved.dataRoot;
  if (resolved.projectRoot) env[PROJECT_ROOT_ENV] = resolved.projectRoot;
  else delete env[PROJECT_ROOT_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
