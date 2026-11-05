#!/usr/bin/env node
// Fills a NEW, EMPTY test data root with a sample library through the client's own repository (lib/seed.mjs).
//   node dev-tools/seed-library.mjs --data <dir> [--history 200] [--tags 40] [--combos 12] [--notes 8]
//        [--style-presets 8] [--positive-presets 5] [--chunks 6] [--reference-presets 4] [--favorites 12]
//        [--collections 3] [--imports 12] [--trash 0] [--archived-ratio 0.05] [--agent-ratio 0.3]
//        [--image-scale 8] [--days 120] [--seed <n>] [--sizes 832x1216,1216x832,…] [--preset-images 832x1216,…]
//        [--marks] [--quiet]
//   node dev-tools/seed-library.mjs --help
// Run it before the first start of a test client on that data root (the client must not be running).
// --sizes gives the history images these recorded sizes in order (newest first, repeated) instead of random ones;
// --preset-images gives the first style preset and the first prompt preset preview images of these sizes (at most 3).
// The files are 1/--image-scale of each size (--image-scale 1: the full size). --marks draws a white frame, both
// diagonals and a coloured square in each corner on the history and preset images, so a screenshot shows at once
// whether a view shows the whole image.
// --quiet prints only ok, dataRoot, the counts and the total time instead of the full report.
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, printUsage, runCli } from './lib/cli.mjs';
import { SEED_DEFAULTS, seedLibrary } from './lib/seed.mjs';
import { findTestClients } from './lib/processes.mjs';
import { canonicalPath } from './lib/guard.mjs';

const camel = key => key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const kebab = key => key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
const NUMERIC = Object.keys(SEED_DEFAULTS);
const SIZE_LISTS = ['sizes', 'preset-images'];

/** The short form of a seed report (--quiet): counts and time. */
export function quietSeedResult(result) {
  return { ok: result.ok, dataRoot: result.dataRoot, counts: result.counts, totalMs: result.timingsMs?.total };
}

async function main(argv) {
  if (helpRequested(argv)) return printUsage(import.meta.url);
  const { options } = parseArgs(argv, { booleans: ['quiet', 'marks'] });
  allowOptions(options, ['data', 'quiet', 'marks', ...SIZE_LISTS, ...NUMERIC.map(kebab)]);
  if (options.data === undefined) throw new ToolError('refused_no_data', 'seed-library needs --data <new empty folder>.');
  if (findTestClients({ dataRoot: canonicalPath(String(options.data)) }).length) throw new ToolError('already_running', 'A test client runs on this data root; stop it first.');
  const values = { data: String(options.data) };
  for (const [key, value] of Object.entries(options)) if (key !== 'data' && key !== 'quiet') values[camel(key)] = key === 'marks' ? value === true : SIZE_LISTS.includes(key) ? String(value) : Number(value);
  const result = await seedLibrary(values);
  return options.quiet === true ? quietSeedResult(result) : result;
}

if (isMain(import.meta.url)) await runCli(main);
export { seedLibrary };
