import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_VERSION } from '../src/mcp.mjs';
import { USER_AGENT, VERSION } from '../src/version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = relative => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));

test('the client, the MCP server and the novelai package share one release version', () => {
  assert.equal(VERSION, '0.1.2');
  assert.equal(SERVER_VERSION, VERSION);
  for (const file of ['package.json', 'client/package.json']) {
    const manifest = json(file);
    assert.equal(manifest.version, VERSION, file);
    const lock = json(file.replace('package.json', 'package-lock.json'));
    assert.equal(lock.version, VERSION, `${file} lock`);
    assert.equal(lock.packages[''].version, VERSION, `${file} lock root package`);
    assert.equal(lock.name, manifest.name, `${file} lock name`);
  }
  assert.equal(json('package.json').name, 'mcp-for-novelai-server');
  assert.equal(json('client/package.json').name, 'mcp-for-novelai');
});

test('public requests identify themselves as MCP for NovelAI with that version', () => {
  assert.equal(USER_AGENT, `MCP-for-NovelAI/${VERSION}`);
  for (const file of ['src/tag-details.mjs', 'src/tag-cooccurrence.mjs', 'src/tag-query-coordinator.mjs']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert.match(source, /'User-Agent': `\$\{USER_AGENT\} \(/, file);
  }
});
