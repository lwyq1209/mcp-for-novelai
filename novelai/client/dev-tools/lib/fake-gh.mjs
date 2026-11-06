#!/usr/bin/env node
// A stand-in for the GitHub CLI's release commands, for rehearsing .github/scripts/sign-release.mjs (its --gh option)
// without GitHub: the releases are folders of FAKE_GH_ROOT, nothing goes over the network.
//
//   FAKE_GH_ROOT/<tag>/release.json    {"isDraft": true}
//   FAKE_GH_ROOT/<tag>/assets/<name>   the release files
//   FAKE_GH_ROOT/calls.jsonl           one line per call (arguments only)
//
// Commands (as gh 2.x writes them):
//   release view <tag> --repo <r> --json tagName,isDraft,assets   → {tagName, isDraft, assets: [{name, size}]}
//   release download <tag> --repo <r> --pattern <exact name> --dir <dir>
//   release upload <tag> <file>… --repo <r> [--clobber]
// A missing release or file is an error (exit 1), as with gh.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.FAKE_GH_ROOT;
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1); };
if (!root) fail('FAKE_GH_ROOT is not set');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const [group, command, tag] = args;
if (group !== 'release' || !tag) fail(`fake gh: unsupported command ${args.join(' ')}`);
if (!/^v[0-9A-Za-z.-]+$/.test(tag)) fail(`fake gh: bad tag ${tag}`);
const release = path.join(root, tag), assets = path.join(release, 'assets');
if (!fs.existsSync(path.join(release, 'release.json'))) fail('release not found');
const info = JSON.parse(fs.readFileSync(path.join(release, 'release.json'), 'utf8'));
const names = () => fs.readdirSync(assets).filter(name => fs.statSync(path.join(assets, name)).isFile()).sort();

if (command === 'view') {
  process.stdout.write(`${JSON.stringify({ tagName: tag, isDraft: info.isDraft === true, assets: names().map(name => ({ name, size: info.sizes?.[name] ?? fs.statSync(path.join(assets, name)).size })) })}\n`);
} else if (command === 'download') {
  const pattern = option('--pattern'), dir = option('--dir');
  if (!pattern || !dir) fail('fake gh: download needs --pattern and --dir');
  if (!names().includes(pattern)) fail(`no assets match the file pattern`);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(assets, pattern), path.join(dir, pattern));
} else if (command === 'upload') {
  const files = args.slice(3).filter((value, index, all) => !value.startsWith('--') && !(all[index - 1] ?? '').match(/^--(repo)$/));
  for (const file of files) {
    const target = path.join(assets, path.basename(file));
    if (fs.existsSync(target) && !args.includes('--clobber')) fail(`asset under the same name already exists: ${path.basename(file)}`);
    if (info.isDraft !== true) fail('fake gh: the release is published');
    fs.copyFileSync(file, target);
  }
} else {
  fail(`fake gh: unsupported command release ${command}`);
}
