import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_STRINGS, type UiStringKey } from './strings';
import { QUEUE_STRINGS } from './queue.strings';
import { SETTINGS_STRINGS } from './settings.strings';
import { MCP_STRINGS } from './mcp.strings';
import { ONBOARDING_STRINGS } from './onboarding.strings';
import { CANVAS_STRINGS } from './canvas.strings';
import { fillUiText, formatBytes, formatDay, formatWhen, quotedList, uiLangOf, uiText } from './i18n';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const placeholders = (text: string) => [...text.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map(match => match[1]).sort();

describe('new interface copy: every key in both languages (step 4b1)', () => {
  const entries = Object.entries(UI_STRINGS) as Array<[UiStringKey, readonly [string, string]]>;
  it('has a non-empty Chinese and English text for every key', () => {
    expect(entries.length).toBeGreaterThan(300);
    for (const [key, pair] of entries) {
      expect(Array.isArray(pair) && pair.length === 2, key).toBe(true);
      expect(pair[0].trim(), `${key} zh`).not.toBe('');
      expect(pair[1].trim(), `${key} en`).not.toBe('');
    }
  });
  it('uses the same placeholders in both languages', () => {
    for (const [key, [zh, en]] of entries) expect(placeholders(en), key).toEqual(placeholders(zh));
  });
  it('keeps English free of Chinese characters and straight quotes (curly quotes and apostrophes only)', () => {
    for (const [key, [, en]] of entries) {
      if (key === 'top.langZh') continue; // the language switch shows 中 in both languages
      expect(CJK.test(en), `${key}: ${en}`).toBe(false);
      expect(/["']/.test(en), `${key}: ${en}`).toBe(false);
    }
  });
  it('writes Chinese with Chinese quotes, and no developer words (revision, workspaceId, batchId, sha256, 冻结, 宿主)', () => {
    for (const [key, [zh, en]] of entries) {
      expect(/"/.test(zh), `${key}: ${zh}`).toBe(false);
      for (const word of [/revision/i, /workspaceId/, /batchId/, /sha256/i, /requestKey/, /冻结/, /宿主/, /bridge/i]) {
        expect(word.test(zh) || word.test(en), `${key}`).toBe(false);
      }
    }
  });
  it('fills placeholders and falls back to the key for an unknown key', () => {
    expect(uiText('zh', 'del.title', { n: 6 })).toBe('删除 6 项？');
    expect(uiText('en', 'del.title', { n: 1234 })).toBe('Delete 1,234 items?');
    expect(uiText('en', 'tr.by', { who: 'Claude Code', when: 'Today 15:02' })).toBe('Claude Code · Today 15:02');
    expect(uiText('zh', 'nope' as UiStringKey)).toBe('nope');
    expect(fillUiText('{a}{b}', { a: 'x' }, 'en')).toBe('x');
  });
});

describe('the copy files of step 4b2', () => {
  it('keep their own key prefix and never redefine a key of another file', () => {
    const files: Array<[string, Record<string, unknown>]> = [['q.', QUEUE_STRINGS], ['set.', SETTINGS_STRINGS], ['mcp.', MCP_STRINGS], ['onb.', ONBOARDING_STRINGS], ['cv.', CANVAS_STRINGS]];
    const seen = new Map<string, string>();
    for (const [prefix, strings] of files) for (const key of Object.keys(strings)) {
      expect(key.startsWith(prefix), key).toBe(true);
      expect(seen.get(key), key).toBeUndefined();
      seen.set(key, prefix);
    }
    // strings.ts lists the base keys after the spreads, so a base key with one of these prefixes would hide a file's key.
    const base = readFileSync(path.resolve(__dirname, 'strings.ts'), 'utf8');
    expect(base.match(/^  '(q|set|mcp|onb|cv)\.[^']*':/gm) ?? []).toEqual([]);
  });
});

describe('formatting for the interface language', () => {
  const now = new Date(2026, 10, 3, 18, 0);
  it('names days relative to today', () => {
    expect(formatDay(new Date(2026, 10, 3, 9), 'zh', now)).toBe('今天');
    expect(formatDay(new Date(2026, 10, 2, 9), 'en', now)).toBe('Yesterday');
    expect(formatDay(new Date(2026, 10, 1, 9), 'zh', now)).toBe('11 月 1 日');
    expect(formatDay(new Date(2026, 10, 1, 9), 'en', now)).toBe('Nov 1');
    expect(formatDay(new Date(2025, 9, 28), 'zh', now)).toBe('2025 年 10 月 28 日');
    expect(formatWhen(new Date(2026, 10, 3, 17, 44), 'zh', now)).toBe('今天 17:44');
    expect(formatWhen(new Date(2026, 9, 28, 17, 44), 'en', now)).toBe('Oct 28');
  });
  it('formats sizes, lists and languages', () => {
    expect(formatBytes(15_600_000, 'zh')).toBe('15.6 MB');
    expect(formatBytes(900, 'en')).toBe('900 B');
    expect(formatBytes(46_200_000, 'en')).toBe('46.2 MB');
    expect(quotedList(['夏日企划', '封面候选'], 'zh')).toBe('「夏日企划」「封面候选」');
    expect(quotedList(['Summer project', 'Cover picks'], 'en')).toBe('“Summer project”, “Cover picks”');
    expect(uiLangOf('zh-CN')).toBe('zh');
    expect(uiLangOf('en-US')).toBe('en');
    expect(uiLangOf('ja-JP')).toBe('en');
  });
});

/**
 * The source with its comments blanked out (newlines kept, so line numbers stay) and everything else kept: strings,
 * template literals and regular expression literals are read as such, so a "//" inside a string is not a comment
 * (review rework). CSS has only block comments ("//" in a url() is not one).
 */
function stripComments(source: string, css = false): string {
  let out = '', i = 0, regexOk = true, word = '';
  const n = source.length;
  while (i < n) {
    const c = source[i], d = source[i + 1];
    if (!css && c === '/' && d === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const end = source.indexOf('*/', i + 2), stop = end < 0 ? n : end + 2; out += source.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && source[j] !== c) { if (source[j] === '\\') j++; j++; }
      out += source.slice(i, j + 1); i = j + 1; regexOk = false; word = ''; continue;
    }
    if (!css && c === '/' && (regexOk || word === 'return' || word === 'typeof')) {
      let j = i + 1, inClass = false;
      while (j < n && source[j] !== '\n') { const ch = source[j]; if (ch === '\\') { j += 2; continue; } if (ch === '[') inClass = true; else if (ch === ']') inClass = false; else if (ch === '/' && !inClass) break; j++; }
      out += source.slice(i, j + 1); i = j + 1; regexOk = false; word = ''; continue;
    }
    out += c; i++;
    // A "/" may start a regular expression after an operator or an arrow, never after "<" or ">" (JSX: "</p>" and
    // text after a tag), so a closing tag can never hide the text that follows it.
    if (/[A-Za-z0-9_$]/.test(c)) { word += c; regexOk = false; }
    else if (!/\s/.test(c)) { word = ''; regexOk = c === '>' ? source[i - 2] === '=' : /[(,=:[!&|?{};+\-*%~^]/.test(c); }
  }
  return out;
}

describe('comment stripping of the copy check', () => {
  it('keeps strings, template literals and regular expressions; drops line and block comments', () => {
    expect(stripComments("const a = 'x // 中文';")).toContain('中文');
    expect(stripComments('const a = "http://x" + `y // 中`;')).toContain('中');
    expect(stripComments('const a = 1; // 中文')).not.toContain('中文');
    expect(stripComments('/* 中文\n注释 */ const a = 1;')).not.toMatch(CJK);
    expect(stripComments('/* 中文\n注释 */ const a = 1;').split('\n')).toHaveLength(2);
    expect(stripComments("const r = /[\\u4e00]\\//; const b = '中';")).toContain('中');
    expect(stripComments("return /x/.test(a) ? '中' : '';")).toContain('中');
    expect(stripComments('<b>{x}</b>中文</i>')).toContain('中文');
    expect(stripComments('const f = a => /x/.test(a) || "中";')).toContain('中');
    expect(stripComments('a { background: url(http://x/中.png); } /* 中文 */', true)).toContain('中.png');
    expect(stripComments('a { background: url(http://x/中.png); } /* 中文 */', true)).not.toContain('中文');
  });
});

// The new interface's copy lives in strings.ts only: no Chinese text in the code or styles of the new interface
// directories (comments aside). The capture sample data (names users typed in the prototype) is exempt.
const NEW_UI_DIRS = ['ui', 'shell', 'library', 'queue', 'settings', 'onboarding', 'canvas'];
describe('no hard-coded Chinese in the new interface code', () => {
  const root = path.resolve(__dirname, '..');
  const files = NEW_UI_DIRS.flatMap(folder => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? walk(file) : /\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
    });
    return walk(path.join(root, folder));
  }).filter(file => !/strings\.ts$|capture-fixture\.ts$|capture-art\.ts$/.test(file));
  it('finds the files', () => {
    expect(files.length).toBeGreaterThan(30);
    for (const folder of NEW_UI_DIRS) expect(files.some(file => file.includes(`${path.sep}${folder}${path.sep}`)), folder).toBe(true);
    expect(files.some(file => file.endsWith('.css'))).toBe(true);
  });
  for (const file of files) {
    it(path.relative(root, file), () => {
      const code = stripComments(readFileSync(file, 'utf8'), file.endsWith('.css'));
      const lines = code.split('\n').map((line, index) => [index + 1, line] as const).filter(([, line]) => CJK.test(line));
      expect(lines.map(([index, line]) => `${index}: ${line.trim()}`)).toEqual([]);
    });
  }
});

describe('English singulars', () => {
  it('uses the .one form when n or f is 1, and every .one key has its base key', () => {
    expect(uiText('en', 'lib.count.items', { n: 1 })).toBe('1 item');
    expect(uiText('en', 'lib.count.items', { n: 2 })).toBe('2 items');
    expect(uiText('en', 'tr.purge.body', { f: 1, size: '1.0 MB' })).toBe('1 file (1.0 MB) will be permanently deleted. This can’t be undone.');
    expect(uiText('zh', 'lib.count.items', { n: 1 })).toBe('1 项');
    for (const key of Object.keys(UI_STRINGS).filter(value => value.endsWith('.one'))) expect(Object.hasOwn(UI_STRINGS, key.slice(0, -4)), key).toBe(true);
  });
});

describe('English counts agree with their nouns (review rework)', () => {
  // Counts that are never 1 where the key is used: a fixed limit (max 500), Recently deleted's "days left" (1 uses
  // tr.leftOne) and the partial header (only with more than 100 entries).
  const NEVER_ONE = new Set(['del.tooMany', 'err.invalid', 'tr.left', 'tr.countPartial']);
  it('renders no "1 items" or "2 item" for any count placeholder, each counted on its own', () => {
    const wrong: string[] = [];
    for (const key of Object.keys(UI_STRINGS).filter(key => !key.endsWith('.one') && !NEVER_ONE.has(key))) {
      const en = (UI_STRINGS as Record<string, readonly [string, string]>)[key][1];
      const counts = [...new Set([...en.matchAll(/\{(n|m|f)\}/g)].map(match => match[1]))];
      if (!counts.length) continue;
      const cases = [...counts.map(one => Object.fromEntries(counts.map(name => [name, name === one ? 1 : 2]))), Object.fromEntries(counts.map(name => [name, 1]))];
      for (const values of cases) {
        const kind = uiText('en', 'kinds.tag' as UiStringKey, { n: values.n ?? 2 });
        const text = uiText('en', key as UiStringKey, { ...values, kind, name: 'X', names: '“X”', size: '1 MB', who: 'You', when: 'now', reason: 'R.', project: 'P', index: '1', max: 500 });
        if (/\b1 (items|files|entries|images|recipes|collections|days|posts|members|tags|covers)\b|\b1 (were|are|aren’t|remain)\b|\b2 (item|file|entry|image|recipe|collection|day|post|member|tag|cover)\b|\b2 (was|is|isn’t|remains)\b/.test(text)) wrong.push(`${key} ${JSON.stringify(values)}: ${text}`);
      }
    }
    expect(wrong).toEqual([]);
  });
  it('fixes the singulars the review named', () => {
    expect(uiText('en', 'del.undoneGone', { n: 1, m: 1 })).toBe('Restored 1 item; no longer in Recently deleted: 1');
    expect(uiText('en', 'del.undoneGone', { n: 3, m: 1 })).toBe('Restored 3 items; no longer in Recently deleted: 1');
    expect(uiText('en', 'del.outside', { n: 1 })).toBe('1 of them isn’t in the current view');
    expect(uiText('en', 'del.outside', { n: 2 })).toBe('2 of them aren’t in the current view');
  });
});

