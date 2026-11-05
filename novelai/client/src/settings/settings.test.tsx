import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '../store';
import { SETTINGS_SECTIONS, type SettingsSection } from '../shell/route';
import type { AppSettings } from '../types';
import { APP_VERSION, CREDENTIAL_FORMAT_ISSUE_SUFFIX } from '../types';
import { initialImportConfirmationStage } from '../features/settings/data-backup';
import { SettingsPage } from './SettingsPage';
import { TokenForm, ProxyControl } from './sections/AccountSection';
import { OutputFolderField } from './sections/StorageSection';
import { queueRetentionNotes, retentionShortens } from './sections/QueueSection';
import { PERSIST_SWITCHES, templateFromForm } from './sections/CanvasSection';
import {
  DEFAULT_HTTP_PROXY, DEFAULT_SOCKS_PROXY, PROXY_MODES, commitNumber, credentialIssueKinds, importStageAfter, logInfoLine, openFolderKey,
  opusAllowance, overwritesSettings, proxyCurrent, proxyPresetFor, proxyUrlFor, updateCheckMessage,
} from './sections/logic';

const SETTINGS: AppSettings = {
  hasOnboarded: true, language: 'zh-CN', outputDir: '/Users/you/Pictures/MCP for NovelAI', logDir: '', apiBaseUrl: 'https://api.novelai.net', imageBaseUrl: 'https://image.novelai.net',
  allowCustomEndpoint: false, allowCustomEndpointFallback: false, proxyMode: 'auto', proxyUrl: '', proxyForNai: true, proxyForUpdate: true, autoCheckUpdates: true, ignoredUpdateVersion: '',
  theme: 'dark', reduceMotion: false, autoComplete: true, weightHighlight: true, promptRandomizer: true, superDrop: true, streamPreviewEnabled: true, showFloatingToolbar: true,
  historyJumpAfterGenerate: true, historyRetentionDays: 30, loggingEnabled: true, keepImageMetadata: true, autoBackupEnabled: true, autoBackupIntervalHours: 24, autoBackupRetentionCount: 7,
  autoBackupIncludeImages: false, backupDir: '', activeHistoryGroupId: '', generationGroupId: '', modelMode: 'anime', lockStylePrompt: false, lockNegativePrompt: false, savedStylePrompt: '',
  savedNegativePrompt: '', imageNameTemplate: '{date}_{seq}_{model}', promptTemplates: [{ id: 't1', name: 'Realistic', prefix: 'masterpiece, ', suffix: '4k', negativePrompt: 'lowres' }],
  stylePromptPresets: [], stylePromptPresetGroups: [], positivePromptPresets: [], promptChunks: [], lastGenerationState: null,
  persistGenerateParams: true, persistI2IParams: true, persistInpaintParams: false, persistUpscaleParams: true, persistDirectorParams: true, queueMaxItemsPerEnqueue: 20, queueMaxPendingItems: 200, queueRetentionDays: 30,
};

const initial = useAppStore.getState();
afterEach(() => useAppStore.setState({ settings: initial.settings, account: initial.account, updateInfo: initial.updateInfo, updateProgress: initial.updateProgress, updateNotice: initial.updateNotice }));
const setup = (language: 'zh-CN' | 'en-US', patch: Partial<AppSettings> = {}, state: Record<string, unknown> = {}) =>
  useAppStore.setState({ settings: { ...SETTINGS, language, ...patch }, account: { hasToken: true, tierName: 'Opus', tierLevel: 3, anlasBalance: 8240, opusUsage: { percent: 73, isNegative: false, timeUntilNextPercent: 6042 } }, ...state } as never);
const page = (section: SettingsSection) => renderToStaticMarkup(<SettingsPage section={section} active />);

describe('settings logic', () => {
  it('reads the proxy preset from the saved mode, else from the address (the old control)', () => {
    expect(PROXY_MODES[0]).toBe('auto');
    for (const mode of PROXY_MODES) expect(proxyPresetFor(mode, 'whatever')).toBe(mode);
    expect(proxyPresetFor('legacy', '')).toBe('direct');
    expect(proxyPresetFor(undefined, 'HTTP://127.0.0.1:7890/')).toBe('http');
    expect(proxyPresetFor(undefined, DEFAULT_SOCKS_PROXY)).toBe('socks');
    expect(proxyPresetFor(undefined, 'http://10.0.0.2:8080')).toBe('custom');
    expect(proxyUrlFor('auto', 'x')).toBe('');
    expect(proxyUrlFor('direct', 'x')).toBe('');
    expect(proxyUrlFor('http', 'x')).toBe(DEFAULT_HTTP_PROXY);
    expect(proxyUrlFor('socks', 'x')).toBe('socks5://127.0.0.1:10808');
    expect(proxyUrlFor('custom', 'http://10.0.0.2:8080')).toBe('http://10.0.0.2:8080');
    expect(proxyCurrent('auto', '')).toEqual({ key: 'set.net.currentAuto' });
    expect(proxyCurrent('direct', 'x')).toEqual({ key: 'set.net.currentDirect' });
    expect(proxyCurrent('custom', '  ')).toEqual({ key: 'set.net.currentEmpty' });
    expect(proxyCurrent('http', DEFAULT_HTTP_PROXY)).toEqual({ key: 'set.net.currentProxy', url: DEFAULT_HTTP_PROXY });
  });

  it('rounds and clamps committed numbers; text that is not a number reverts', () => {
    expect(commitNumber('20', 1, 200)).toBe(20);
    expect(commitNumber('12.6', 1, 200)).toBe(13);
    expect(commitNumber('0', 1, 200)).toBe(1);
    expect(commitNumber('-5', 1, 200)).toBe(1);
    expect(commitNumber('999', 1, 200)).toBe(200);
    expect(commitNumber('1e9', 1, 100_000)).toBe(100_000);
    expect(commitNumber('', 1, 200)).toBeNull();
    expect(commitNumber('abc', 1, 200)).toBeNull();
  });

  it('tells a locked credential from one in an unsupported format', () => {
    expect(credentialIssueKinds(undefined)).toEqual({ locked: false, unsupported: false });
    expect(credentialIssueKinds(['token'])).toEqual({ locked: true, unsupported: false });
    expect(credentialIssueKinds([`token${CREDENTIAL_FORMAT_ISSUE_SUFFIX}`])).toEqual({ locked: false, unsupported: true });
  });

  it('computes the Opus allowance as the old usage dialog did', () => {
    expect(opusAllowance(undefined)).toBeNull();
    expect(opusAllowance({ percent: 73, isNegative: false, timeUntilNextPercent: 6042 })).toEqual({ remaining: 73, images: 1263, refill: 14.3, refillImages: 247, empty: false });
    expect(opusAllowance({ percent: 40, isNegative: true, timeUntilNextPercent: 0 })).toMatchObject({ remaining: 0, images: 0, refill: null, refillImages: null, empty: true });
  });

  it('chooses the update-check line: up to date, a newer version, or the failure', () => {
    expect(updateCheckMessage(null)).toBeNull();
    expect(updateCheckMessage({ status: 'current', hasUpdate: false, currentVersion: '0.1.0' })).toEqual({ key: 'set.ab.current', params: { version: '0.1.0' }, tone: 'ok' });
    expect(updateCheckMessage({ status: 'available', hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0', releaseUrl: 'https://x' })).toEqual({ key: 'set.ab.available', params: { version: '0.2.0' }, tone: 'accent' });
    expect(updateCheckMessage({ status: 'failed', hasUpdate: false, currentVersion: '0.1.0', error: 'timeout' })).toEqual({ key: 'set.ab.failed', params: { reason: 'timeout' }, tone: 'danger' });
  });

  it('shows the log path with its size, or that there is no log yet', () => {
    expect(logInfoLine(null)).toBeNull();
    expect(logInfoLine({ path: '/l/app.log', exists: true, sizeBytes: 15_600 })).toEqual({ key: 'set.st.logCurrent', path: '/l/app.log', bytes: 15_600 });
    expect(logInfoLine({ path: '/l/app.log', exists: false, sizeBytes: 99 })).toEqual({ key: 'set.st.logCurrentEmpty', path: '/l/app.log', bytes: 0 });
  });

  it('names the folder button for the platform', () => {
    expect(openFolderKey('darwin')).toBe('set.openFinder');
    expect(openFolderKey('MacIntel')).toBe('set.openFinder');
    expect(openFolderKey('win32')).toBe('set.openFolder');
    expect(openFolderKey('linux')).toBe('set.openFolder');
  });

  it('walks the backup confirmations: incomplete → merge → replace settings → run', () => {
    expect(initialImportConfirmationStage(true)).toBe(4);
    expect(initialImportConfirmationStage(false)).toBe(1);
    expect(importStageAfter(4, ['imageHistory'])).toBe(1);
    expect(importStageAfter(1, ['imageHistory'])).toBe('run');
    expect(importStageAfter(1, ['imageHistory', 'configuration'])).toBe(2);
    expect(importStageAfter(1, ['apiCredentials'])).toBe(2);
    expect(importStageAfter(2, ['configuration'])).toBe('run');
    expect(overwritesSettings(['workspaceData'])).toBe(false);
  });

  it('makes a prompt template only with a name, trimmed', () => {
    expect(templateFromForm({ name: '  ', prefix: 'a', suffix: '', negativePrompt: '' }, 'x')).toBeNull();
    expect(templateFromForm({ name: ' Real ', prefix: ' a, ', suffix: ' b ', negativePrompt: ' c ' }, 'x')).toEqual({ id: 'x', name: 'Real', prefix: 'a,', suffix: 'b', negativePrompt: 'c' });
  });
});

describe('settings sections render (SSR, both languages)', () => {
  it('navigation lists the seven sections and marks the current one; About shows a dot for a newer release', () => {
    setup('zh-CN', {}, { updateInfo: { status: 'available', hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0' } });
    const html = page('queue');
    for (const value of SETTINGS_SECTIONS) expect(html).toContain(`settings-nav-${value}`);
    expect(html).toMatch(/settings-nav-queue"[^>]*>|aria-current="page"[^>]*data-testid="settings-nav-queue"/);
    expect(html).toContain('sp-nav-dot');
  });

  it('account & network: status, Opus allowance, token form, proxy, scope and custom addresses', () => {
    setup('zh-CN', { credentialIssues: [`token${CREDENTIAL_FORMAT_ISSUE_SUFFIX}`] });
    const zh = page('account');
    for (const text of ['已连接 · Opus · 8,240 Anlas', 'Opus 免费额度：剩余 73%（约 1,263 张）', '验证并保存', '如何获取 token', '移除 token', '跟随系统', 'HTTP 本地', 'SOCKS5 本地', '自定义', '不使用', '走代理的请求', '自定义 API 地址', '允许把 token 发给非官方地址', '格式不对，没有使用']) expect(zh, text).toContain(text);
    expect(zh).toContain('type="password"');
    expect(zh).not.toContain('自定义出图地址鉴权失败时');
    setup('en-US', { allowCustomEndpoint: true, proxyMode: 'direct' }, { account: { hasToken: false } });
    const en = page('account');
    for (const text of ['Not connected to NovelAI', 'Verify &amp; save', 'How to get a token', 'Retry on the official address', 'Direct, no proxy']) expect(en, text).toContain(text);
    expect(en).not.toContain('Remove token');
    // Proxy scope is disabled while the proxy is off.
    expect(en.match(/role="switch"[^>]*disabled=""/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('queue: both limits with their ranges, no-limit switch and the fixed rules', () => {
    setup('zh-CN');
    const zh = page('queue');
    for (const text of ['单次入队最多', '1–200，默认 20', '排队总数上限', '不限制', '不限制画布上的手动生成', '超出时被拒绝', '每批 64 MiB，整个队列 512 MiB', '不会自动重发']) expect(zh, text).toContain(text);
    setup('en-US', { queueMaxPendingItems: null });
    const en = page('queue');
    expect(en).toContain('Images per enqueue');
    expect(en).toMatch(/aria-checked="true"[^>]*aria-label="No limit"/);
    expect(en).toMatch(/data-testid="queue-pending"[^>]*disabled=""|disabled=""[^>]*data-testid="queue-pending"/);
  });

  it('queue: how long ended batches are kept (queue retention): 7 / 30 / 90 days or forever, 30 by default', () => {
    setup('zh-CN');
    const zh = page('queue');
    for (const text of ['已结束的批次', '保留', '7 天', '30 天', '90 天', '永不清理', '图片仍在素材库']) expect(zh, text).toContain(text);
    expect(zh).toMatch(/aria-checked="true"[^>]*>30 天|30 天<\/button>/);
    expect(zh).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>(?:<[^>]+>)*30 天/);
    setup('en-US', { queueRetentionDays: null });
    const en = page('queue');
    for (const text of ['Ended batches', 'Keep', '7 days', '90 days', 'Forever', 'the images stay in the library']) expect(en, text).toContain(text);
    expect(en).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>(?:<[^>]+>)*Forever/);
  });

  it('queue retention lines (review rework): damaged records first, a skipped run, kept invalid records; shorter periods are confirmed', () => {
    const base = { days: 30, cleanedBatches: 4, running: false, lastRun: null, records: { state: 'ok' as const, anchored: 4, readable: 4 } };
    expect(queueRetentionNotes(null)).toMatchObject({ broken: false, cleaning: false, cleaned: 0, skipped: null, invalid: 0 });
    expect(queueRetentionNotes(base)).toMatchObject({ broken: false, cleaned: 4 });
    expect(queueRetentionNotes(base, true)).toMatchObject({ cleaning: true, cleaned: 0 });
    const broken = queueRetentionNotes({ ...base, records: { state: 'broken', problem: 'chain_broken', anchored: 4, readable: 3 } });
    expect(broken).toMatchObject({ broken: true, problem: 'chain_broken', cleaning: false, cleaned: 0 });
    expect(queueRetentionNotes({ ...base, records: { state: 'broken', problem: 'something_new', anchored: null, readable: 0 } }).problem).toBe('read_failed');
    const run = { at: 'x', days: 30, cleaned: 0, recipes: 0, receipts: 0, ms: 1 };
    expect(queueRetentionNotes({ ...base, lastRun: { ...run, skipped: 'frozen_queue_unreadable' } }).skipped).toBe('frozen_queue_unreadable');
    expect(queueRetentionNotes({ ...base, lastRun: { ...run, skipped: 'never' } }).skipped).toBeNull();
    expect(queueRetentionNotes({ ...base, lastRun: { ...run, skipped: null, invalid: 2 } }).invalid).toBe(2);
    // Records recovered from the library: an information line (review rework 2), not shown while the records are damaged.
    expect(queueRetentionNotes({ ...base, recoveredFromLibrary: 3 }).recovered).toBe(3);
    expect(queueRetentionNotes({ ...base, recoveredFromLibrary: 3, records: { state: 'broken', problem: 'chain_broken', anchored: 4, readable: 3 } }).recovered).toBe(0);
    expect(queueRetentionNotes(base).recovered).toBe(0);
    expect(retentionShortens(30, '7')).toBe(true);
    expect(retentionShortens(null, '90')).toBe(true);
    expect(retentionShortens(7, '30')).toBe(false);
    expect(retentionShortens(30, 'never')).toBe(false);
  });

  it('canvas: preview, autocomplete, drop, five remembered modes, column widths and templates', () => {
    setup('zh-CN');
    const zh = page('canvas');
    for (const text of ['生成时显示过程预览', '输入提示词时补全标签', '任何模式都能把图片拖到画布上载入', '跨次启动记住参数', '文生图', '图生图', '局部重绘', '放大', 'Director', '恢复默认宽度', '提示词模板', 'Realistic', '前缀：masterpiece,', '添加模板']) expect(zh, text).toContain(text);
    setup('en-US');
    const en = page('canvas');
    for (const text of ['Show a live preview while generating', 'Remember settings between launches', 'Prompt templates']) expect(en, text).toContain(text);
  });

  it('storage & backup: output folder, names, metadata, backups, library, Recently deleted, data folder and logs', () => {
    setup('zh-CN');
    const zh = page('storage');
    for (const text of ['出图文件夹', '/Users/you/Pictures/MCP for NovelAI', '更改', '文件名', '{date} {time} {seq} {seed} {model} {type} {ts}', '在图片里保存生成参数', '自动备份', '包含图片', '保留', '立即备份', '从备份恢复…', '导出备份…', '导出素材…', '导入素材…', '最近删除保留 30 天', '打开最近删除', '数据文件夹', '写运行日志', '日志文件夹', '打开日志文件', '打开日志文件夹']) expect(zh, text).toContain(text);
    expect(zh).not.toMatch(/Android|iOS/);
    setup('en-US');
    const en = page('storage');
    for (const text of ['Output folder', 'Automatic backup', 'Manual export', 'Export materials…', 'Open Recently deleted', 'Data folder', 'Logs']) expect(en, text).toContain(text);
  });

  it('appearance & language: the two languages (each in its own language) and reduce motion, no theme', () => {
    setup('en-US');
    const en = page('appearance');
    expect(en).toContain('中文');
    expect(en).toContain('English');
    expect(en).toContain('Reduce motion');
    expect(en).not.toMatch(/Theme|Light|Thumbnail/);
    setup('zh-CN');
    const zh = page('appearance');
    expect(zh).toContain('减少动效');
    expect(zh).not.toContain('主题');
  });

  it('about & updates: version, check, the newer release, auto check, links, license, credit and setup', () => {
    setup('zh-CN', {}, { updateInfo: { status: 'available', hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0', releaseUrl: 'https://github.com/x/releases/tag/v0.2.0' } });
    const zh = page('about');
    for (const text of ['MCP for NovelAI', `版本 ${APP_VERSION}`, '检查更新', '有新版本 0.2.0', '在 GitHub 发布页下载安装包。', '前往下载', '自动检查更新', '项目主页', 'github.com/lwyq1209/mcp-for-novelai', '使用说明', 'NovelAI 文档', 'MIT 许可', '查看许可', '第三方声明', '基于 Langbai NovelAI Studio 改造（MIT 许可）', 'NovelAI 是 Anlatan 的商标，本应用与其无关。', '重新运行首次引导']) expect(zh, text).toContain(text);
    setup('en-US', {}, { updateInfo: null });
    const en = page('about');
    expect(en).toContain('Check for updates automatically');
    expect(en).not.toContain('is available');
  });

  it('about & updates: Update and restart, its progress, the queue wait, a verification failure, the first start after an update', () => {
    const available = { status: 'available' as const, hasUpdate: true, currentVersion: '0.1.0', latestVersion: '0.2.0', releaseUrl: 'https://github.com/x/releases/tag/v0.2.0' };
    setup('zh-CN', {}, { updateInfo: available, updateProgress: { phase: 'idle', install: { supported: true } } });
    let zh = page('about');
    for (const text of ['更新并重启', '前往下载', '验证它的签名']) expect(zh, text).toContain(text);
    setup('zh-CN', {}, { updateInfo: available, updateProgress: { phase: 'downloading', version: '0.2.0', received: 1024 * 1024, total: 4 * 1024 * 1024, install: { supported: true } } });
    zh = page('about');
    expect(zh).toContain('role="progressbar"');
    expect(zh).toContain('正在下载');
    expect(zh).toContain('data-testid="update-cancel"');
    setup('zh-CN', {}, { updateInfo: available, updateProgress: { phase: 'ready', version: '0.2.0', queueBusy: true, install: { supported: true } } });
    zh = page('about');
    expect(zh).toContain('队列结束后更新');
    expect(zh).toContain('先在队列页暂停它们');
    setup('zh-CN', {}, { updateInfo: available, updateProgress: { phase: 'failed', version: '0.2.0', error: { code: 'verify_failed', message: 'x', retryable: false, reason: 'signature_invalid' }, install: { supported: true } } });
    zh = page('about');
    expect(zh).toContain('无法验证更新，已停止，什么都没有安装');
    expect(zh).toContain('签名与应用内置的更新公钥不符');
    expect(zh).not.toContain('data-testid="update-install"');
    setup('en-US', {}, { updateInfo: available, updateProgress: { phase: 'idle', install: { supported: false, reason: 'translocated' } } });
    const en = page('about');
    expect(en).toContain('This copy cannot update itself');
    expect(en).toContain('Move it to Applications first');
    expect(en).not.toContain('data-testid="update-install"');
    setup('en-US', {}, { updateInfo: null, updateNotice: { kind: 'updated', from: '0.1.2', to: '0.1.3', releaseUrl: 'https://github.com/lwyq1209/mcp-for-novelai/releases/tag/v0.1.3' } });
    const after = page('about');
    expect(after).toContain('Updated from 0.1.2 to 0.1.3');
    expect(after).toContain('What’s new (CHANGELOG)');
  });

  it('the MCP section is still the MCP section', () => {
    setup('zh-CN');
    expect(page('mcp')).toContain('data-testid="settings-mcp"');
  });
});

describe('components for the first-run guide', () => {
  it('TokenForm guide layout: field and Verify & save on one line, no remove; page layout has remove and show', () => {
    setup('en-US');
    const guide = renderToStaticMarkup(<TokenForm layout="guide" />);
    expect(guide).toContain('data-layout="guide"');
    expect(guide).toContain('Verify &amp; save');
    expect(guide).toContain('How to get a token');
    expect(guide).not.toContain('Remove token');
    const pageLayout = renderToStaticMarkup(<TokenForm />);
    expect(pageLayout).toContain('data-layout="page"');
    expect(pageLayout).toContain('token-reveal');
    expect(pageLayout).toContain('Remove token');
  });

  it('ProxyControl shows the five modes and the current routing; OutputFolderField guide has no Open', () => {
    setup('zh-CN', { proxyMode: 'custom', proxyUrl: 'http://10.0.0.2:8080' });
    const proxy = renderToStaticMarkup(<ProxyControl />);
    expect(proxy).toContain('data-mode="custom"');
    expect(proxy).toContain('经过代理 http://10.0.0.2:8080');
    expect(proxy).toContain('proxy-url');
    const guide = renderToStaticMarkup(<OutputFolderField layout="guide" />);
    expect(guide).toContain('/Users/you/Pictures/MCP for NovelAI');
    expect(guide).toContain('更改');
    expect(guide).not.toContain('>打开<');
  });
});

/** Every non-test source file under src/settings, joined. */
function settingsSource() {
  const root = path.resolve(__dirname);
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : [];
  });
  return walk(root).map(file => readFileSync(file, 'utf8')).join('\n');
}

describe('every setting of the old settings dialog has a place to change it', () => {
  // The settings keys of the old SettingsModal (App.tsx at ebb24cf) and its sections.
  const OLD_KEYS: Array<keyof AppSettings> = [
    'apiBaseUrl', 'imageBaseUrl', 'allowCustomEndpoint', 'allowCustomEndpointFallback', 'proxyMode', 'proxyUrl', 'proxyForNai', 'proxyForUpdate',
    'queueMaxItemsPerEnqueue', 'queueMaxPendingItems', 'outputDir', 'keepImageMetadata', 'loggingEnabled', 'logDir', 'imageNameTemplate', 'superDrop',
    'streamPreviewEnabled', 'persistGenerateParams', 'persistI2IParams', 'persistInpaintParams', 'persistUpscaleParams', 'persistDirectorParams',
    'autoCheckUpdates', 'reduceMotion', 'language', 'autoComplete', 'promptTemplates', 'autoBackupEnabled', 'autoBackupIntervalHours',
    'autoBackupRetentionCount', 'autoBackupIncludeImages', 'backupDir',
  ];
  const source = settingsSource();
  const persisted = new Set<string>(PERSIST_SWITCHES.map(item => item.key));
  for (const key of OLD_KEYS) {
    it(key, () => {
      const writes = new RegExp(`(?:update|save|saveSetting)\\(\\s*'${key}'|settingKey="${key}"`);
      // outputDir is also written by the host's folder dialog (selectOutputDir); the five remember switches by update(item.key).
      const ok = writes.test(source) || (persisted.has(key) && source.includes('update(item.key, value)'));
      expect(ok, `${key} has no write in src/settings`).toBe(true);
    });
  }
  it('also keeps the output folder dialog and the backup folder dialog', () => {
    expect(source).toContain('window.naiDesktop.selectOutputDir()');
    expect(source).toContain('window.naiDesktop.selectBackupDirectory()');
    expect(source).toContain('window.naiDesktop.selectLogDir()');
  });
});
