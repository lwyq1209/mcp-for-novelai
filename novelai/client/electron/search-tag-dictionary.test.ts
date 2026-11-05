import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runCleanups } from '../src/test-support/temp-dirs';
import { createTagDictionary, parseTagDictionary, TAG_DICTIONARY } from './search-tag-dictionary';

const HEADER = 'name,cn_name,wiki,post_count,category,nsfw\r\n';
const GBK: Record<string, string> = { '握手': 'ced5cad6', '牵手': 'c7a3cad6', '手': 'cad6', '树木': 'caf7c4be', '花朵': 'bba8b6e4', '花': 'bba8', '森林': 'c9adc1d6', '握手别名': 'ced5cad6b1f0c3fb', '叶子': 'd2b6d7d3' };
// Encode only known SFW fixture words; do not depend on downloaded dictionaries.
function csv(rows: string) {
  let latin = HEADER + rows;
  for (const word of Object.keys(GBK).sort((a, b) => b.length - a.length)) latin = latin.replaceAll(word, Buffer.from(GBK[word], 'hex').toString('latin1'));
  if (/[^\x00-\xff]/.test(latin)) throw new Error('Unknown fixture encoding');
  return Buffer.from(latin, 'latin1');
}
const original = { bytes: TAG_DICTIONARY.bytes, sha256: TAG_DICTIONARY.sha256 };
const roots: string[] = [];
afterEach(async () => {
  Object.assign(TAG_DICTIONARY, original);
  await runCleanups(roots.splice(0).map(root => () => fs.rm(root, { recursive: true, force: true })));
});
async function root() { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'novelai-dictionary-test-')); roots.push(value); return value; }
async function installFixture(runtime: string, data: Buffer) {
  Object.assign(TAG_DICTIONARY, { bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
  await fs.mkdir(path.join(runtime, 'tag-dictionary'), { recursive: true });
  await fs.writeFile(path.join(runtime, 'tag-dictionary', 'tags_enhanced.csv'), data);
}

describe('optional Chinese dictionary parser', () => {
  it('decodes GB18030, quoted commas/escaped quotes/newlines, and separates primary translations from aliases', () => {
    const result = parseTagDictionary(csv('handshake,"握手,牵手,握手",\"a \"\"quoted\"\" wiki\nentry\",10,0,0\r\ntree,树木,,20,0,0\r\n'));
    expect(result).toEqual([{ name: 'handshake', translation: '握手', aliases: ['牵手'], category: 0, postCount: 10, nsfw: false }, { name: 'tree', translation: '树木', aliases: [], category: 0, postCount: 20, nsfw: false }]);
  });

  it('indexes explicit nsfw=0 and nsfw=1 rows, preserving the source flag', () => {
    const result = parseTagDictionary(csv('tree,树木,,20,0,0\nflower,花朵,,30,0,1\nleaf,叶子,,30,0,\nforest,,,30,0,0\n'));
    expect(result.map(item => [item.name, item.nsfw])).toEqual([['tree', false], ['flower', true]]);
  });

  it('rejects malformed headers, unclosed quotes and incomplete CSV records', () => {
    for (const data of [Buffer.from('name,translation\n'), csv('tree,"树木,,20,0,0\n'), csv('tree,树木,,20,0\n')]) {
      expect(() => parseTagDictionary(data)).toThrow();
    }
  });

  it('keeps useful records when source rows contain duplicate names, whitespace, or invalid counts/categories', () => {
    const result = parseTagDictionary(csv('tree,树木,,20,0,0\ntree,森林,,40,0,0\nbad tag,树木,,20,0,0\nnegative,树木,,-1,0,0\nunknown,树木,,20,2,0\n'));
    expect(result).toEqual([{ name: 'tree', translation: '树木', aliases: [], category: 0, postCount: 20, nsfw: false }]);
  });

  it('accepts literal double quotes inside unquoted fields in the pinned upstream CSV dialect', () => {
    const result = parseTagDictionary(csv('tree,树木,a"quoted wiki,20,0,0\nflower,花朵,plain wiki,30,0,0\n'));
    expect(result.map(item => item.name)).toEqual(['tree', 'flower']);
  });

  it('rejects invalid GB18030 bytes instead of silently replacing characters', () => {
    expect(() => parseTagDictionary(Buffer.concat([Buffer.from(HEADER), Buffer.from([0x81])]))).toThrow();
  });
});

describe('optional dictionary loading and ranking', () => {
  it('reports missing data without creating files or issuing any download', async () => {
    const runtime = await root(); const dictionary = createTagDictionary(runtime);
    expect(await dictionary.search('树木', 12)).toBeNull();
    expect(await dictionary.lookup(['tree'])).toEqual(new Map());
    expect(await fs.readdir(runtime)).toEqual([]);
  });

  it('rejects changed bytes even when the attacker preserves file length', async () => {
    const runtime = await root(); const data = csv('tree,树木,,20,0,0\n');
    await installFixture(runtime, data);
    const corrupted = Buffer.from(data); corrupted[corrupted.length - 4] ^= 1;
    await fs.writeFile(path.join(runtime, 'tag-dictionary', 'tags_enhanced.csv'), corrupted);
    await expect(createTagDictionary(runtime).search('树木', 12)).rejects.toThrow('校验失败');
  });

  it('loads a dictionary installed after an earlier missing-data query without restarting', async () => {
    const runtime = await root(); const dictionary = createTagDictionary(runtime);
    expect(await dictionary.search('树木', 12)).toBeNull();
    await installFixture(runtime, csv('tree,树木,,20,0,0\n'));
    expect((await dictionary.search('树木', 12))?.[0]).toMatchObject({ name: 'tree', translation: '树木' });
  });

  it('recovers after a corrupt installed file is repaired, using the same dictionary instance', async () => {
    const runtime = await root(); const data = csv('tree,树木,,20,0,0\n');
    await installFixture(runtime, data);
    await fs.writeFile(path.join(runtime, 'tag-dictionary', 'tags_enhanced.csv'), 'broken');
    const dictionary = createTagDictionary(runtime);
    await expect(dictionary.search('树木', 12)).rejects.toThrow('校验失败');
    await fs.writeFile(path.join(runtime, 'tag-dictionary', 'tags_enhanced.csv'), data);
    expect((await dictionary.search('树木', 12))?.[0].name).toBe('tree');
  });

  it('ranks primary exact above popular aliases, then primary partial and alias partial', async () => {
    const runtime = await root();
    await installFixture(runtime, csv('holding_hands,"牵手,握手",,90000,0,0\nhandshake,握手,,10,0,0\nhand_contact,握手别名,,900000,0,0\nhand_pose,"手,握手别名",,9000000,0,0\n'));
    const dictionary = createTagDictionary(runtime);
    const result = await dictionary.search('握手', 12);
    expect(result?.map(item => [item.name, item.matchKind])).toEqual([['handshake', 'primary-exact'], ['holding_hands', 'alias-exact'], ['hand_contact', 'primary-partial'], ['hand_pose', 'alias-partial']]);
    expect((await dictionary.search('握手', 1))?.map(item => item.name)).toEqual(['handshake']);
  });

  it('uses count only within equal match strength and resolves exact English names for decoration', async () => {
    const runtime = await root();
    await installFixture(runtime, csv('flower_a,花朵,,10,0,0\nflower_b,花朵,,30,0,0\ntree,树木,,90,0,0\n'));
    const dictionary = createTagDictionary(runtime);
    expect((await dictionary.search('花朵', 12))?.map(item => item.name)).toEqual(['flower_b', 'flower_a']);
    const translations = await dictionary.lookup(['tree', 'missing']);
    expect([...translations.keys()]).toEqual(['tree']);
    expect(translations.get('tree')).toMatchObject({ name: 'tree', translation: '树木' });
    expect(await dictionary.search('森林', 12)).toEqual([]);
  });
});
