import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const TAG_DICTIONARY = {
  provider: 'DanbooruSearchOnline',
  repository: 'https://github.com/SuzumiyaAkizuki/DanbooruSearchOnline',
  commit: '4e6e1433a9b9ceb7a10a361c702dec44ea026ac5',
  url: 'https://raw.githubusercontent.com/SuzumiyaAkizuki/DanbooruSearchOnline/4e6e1433a9b9ceb7a10a361c702dec44ea026ac5/origin_database/tags_enhanced.csv',
  sha256: '62b5bb4860b865cd9c6edfd53a6a2dbf19282c5e9910d0fc170fed5fce9dac77',
  bytes: 7855424,
  license: 'GPL-3.0 repository; optional local data, not bundled',
} as const;

export interface DictionaryEntry { name: string; translation: string; aliases: string[]; category: number; postCount: number; nsfw: boolean }

function csvRows(text: string) {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else if (quoted) quoted = false;
      else if (field.length === 0) quoted = true;
      else field += c;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, '')); field = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error('辅助词库 CSV 引号未闭合。');
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function parseTagDictionary(bytes: Buffer): DictionaryEntry[] {
  const rows = csvRows(new TextDecoder('gb18030', { fatal: true }).decode(bytes));
  if (rows.shift()?.join(',') !== 'name,cn_name,wiki,post_count,category,nsfw') throw new Error('辅助词库字段不匹配。');
  const seen = new Set<string>(); const entries: DictionaryEntry[] = [];
  for (const row of rows) {
    if (row.length === 1 && !row[0]) continue;
    if (row.length !== 6) throw new Error('辅助词库记录损坏。');
    const [name, cn, , count, category, nsfw] = row;
    if (!['0', '1'].includes(nsfw) || !cn.trim()) continue;
    const aliases = [...new Set(cn.split(',').map(value => value.trim()).filter(Boolean))];
    if (!aliases.length) continue;
    if (!name || name.length > 300 || /\s/.test(name) || ![0, 1, 3, 4, 5].includes(Number(category)) || !Number.isSafeInteger(Number(count)) || Number(count) < 0 || seen.has(name)) continue;
    seen.add(name); entries.push({ name, translation: aliases[0], aliases: aliases.slice(1), category: Number(category), postCount: Number(count), nsfw: nsfw === '1' });
  }
  return entries;
}

export function createTagDictionary(runtimeDir: string) {
  let loaded: Promise<DictionaryEntry[] | null> | undefined;
  const load = () => {
    const pending = loaded ??= (async () => {
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(runtimeDir, 'tag-dictionary', 'tags_enhanced.csv')); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw new Error('无法读取本路线中文辅助词库。'); }
    if (bytes.length !== TAG_DICTIONARY.bytes || createHash('sha256').update(bytes).digest('hex') !== TAG_DICTIONARY.sha256) throw new Error('中文辅助词库校验失败；请重新运行本路线词库安装脚本。');
    return parseTagDictionary(bytes);
    })();
    return pending.then(entries => {
      if (entries === null && loaded === pending) loaded = undefined;
      return entries;
    }, error => {
      if (loaded === pending) loaded = undefined;
      throw error;
    });
  };
  return {
    async search(query: string, limit: number) {
      const entries = await load(); if (!entries) return null;
      return entries.map(entry => {
        const rank = entry.translation === query ? 0 : entry.aliases.includes(query) ? 1 : entry.translation.includes(query) ? 2 : entry.aliases.some(alias => alias.includes(query)) ? 3 : 99;
        return { ...entry, rank, matchKind: rank === 0 ? 'primary-exact' : rank === 1 ? 'alias-exact' : rank === 2 ? 'primary-partial' : 'alias-partial' };
      }).filter(entry => entry.rank < 99).sort((a, b) => a.rank - b.rank || b.postCount - a.postCount || a.name.localeCompare(b.name)).slice(0, limit);
    },
    async lookup(names: string[]) {
      const entries = await load(); const wanted = new Set(names);
      return new Map(entries?.filter(entry => wanted.has(entry.name)).map(entry => [entry.name, entry]) ?? []);
    },
  };
}
