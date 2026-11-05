import { describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { renderToStaticMarkup } from 'react-dom/server';
import { useAppStore } from '../../store';
import { buildMcpAccess } from '../../../electron/mcp-access';
import type { McpAccessInfo } from '../../types';
import { uiText } from '../../ui/i18n';
import { AgentConnect, clientHint } from './AgentConnect';
import { ServerStatus } from './McpSection';
import { callSince, captureActivity, clientTileOf, connectionRows, lastAppStart, MCP_CLIENTS, MCP_TOOL_GROUPS, MCP_TOOL_NAMES, previousClient, relativeWhen } from './model';
import { captureStep, completeGuide, Onboarding, OnboardingFailure } from '../../onboarding/Onboarding';
import { AppErrorBoundary } from '../../components/AppErrorBoundary';
import { navigate, useShellRoute } from '../../shell/route';

const info: McpAccessInfo = buildMcpAccess({
  platform: 'darwin', packaged: true, executable: '/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI',
  bundle: '/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs', bundleExists: true, sourceEntry: null,
  dataRoot: '/Users/u/Library/Application Support/mcp-for-novelai', customDataRoot: false, workspaceRoot: '/w', materialInbox: '/w/novelai/library-inbox',
  studyInbox: '/w/novelai/study-inbox', temporaryLocation: false, bridgeReady: true,
});
const lang = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });

describe('Settings › MCP access (step 4b2)', () => {
  it('lists exactly the MCP server’s 18 tools, in three groups', async () => {
    const mcp = await import(/* @vite-ignore */ new URL('../../../../src/mcp.mjs', import.meta.url).href) as { TOOL_DEFINITIONS: Array<{ name: string }> };
    expect([...MCP_TOOL_NAMES].sort()).toEqual(mcp.TOOL_DEFINITIONS.map(tool => tool.name).sort());
    expect(MCP_TOOL_NAMES).toHaveLength(18);
    expect(Object.fromEntries(Object.entries(MCP_TOOL_GROUPS).map(([group, names]) => [group, names.length]))).toEqual({ library: 4, queue: 7, canvas: 7 });
  });

  it('names times relative to now and lists the clients most recent first, never their arguments', () => {
    const now = new Date(2026, 10, 3, 18, 0);
    expect(relativeWhen(new Date(now.getTime() - 20_000).toISOString(), 'zh', now)).toBe('刚刚');
    expect(relativeWhen(new Date(now.getTime() - 2 * 60_000).toISOString(), 'zh', now)).toBe('2 分钟前');
    expect(relativeWhen(new Date(now.getTime() - 60_000).toISOString(), 'en', now)).toBe('1 minute ago');
    expect(relativeWhen(new Date(2026, 10, 3, 10, 21).toISOString(), 'zh', now)).toBe('今天 10:21');
    expect(relativeWhen(new Date(2026, 10, 2, 22, 14).toISOString(), 'en', now)).toBe('Yesterday 22:14');
    const rows = connectionRows(captureActivity(now, 'sample'), 'zh', now);
    expect(rows.map(row => [row.label, row.when, row.tool, row.live])).toEqual([
      ['Claude Code', '2 分钟前', 'get_queue_result', true], ['Codex', '今天 10:21', 'prepare_recipe', false], ['Pi', '昨天 22:14', 'enqueue_recipes', false],
    ]);
    expect(connectionRows(null, 'en')).toEqual([]);
    expect(clientTileOf('codex-mcp-client')).toBe('codex');
    expect(clientTileOf('Zed')).toBeNull();
    expect(clientTileOf('dsh-mcp-client')).toBe('dsh');
    expect(MCP_CLIENTS).toEqual(['claude', 'cursor', 'codex', 'pi', 'dsh', 'other']);
  });

  it('waits for a call after the guide step opened; an older call is only “connected before”', () => {
    const opened = Date.parse('2026-11-03T10:00:00.000Z');
    const activity = { recent: [{ at: '2026-11-03T09:00:00.000Z', client: { name: 'pi', version: null }, tool: 'list_queue', method: 'list_queue' }], clients: [{ client: { name: 'pi', version: null }, firstSeenAt: '2026-11-03T09:00:00.000Z', lastSeenAt: '2026-11-03T09:00:00.000Z', lastTool: 'list_queue', calls: 1 }] };
    expect(callSince(activity, opened)).toBeNull();
    expect(previousClient(activity)?.client?.name).toBe('pi');
    const later = { ...activity, recent: [{ at: '2026-11-03T10:00:05.000Z', client: { name: 'claude-code', version: '2' }, tool: 'list_queue', method: 'list_queue' }, ...activity.recent] };
    expect(callSince(later, opened)).toMatchObject({ client: { name: 'claude-code' }, tool: 'list_queue' });
    // A host clock a second behind the window still counts (skew), a minute behind does not.
    expect(callSince({ recent: [{ ...later.recent[0], at: '2026-11-03T09:59:59.000Z' }], clients: [] }, opened)).not.toBeNull();
    expect(callSince({ recent: [{ ...later.recent[0], at: '2026-11-03T09:59:00.000Z' }], clients: [] }, opened)).toBeNull();
  });

  it('shows each client’s snippet with where it goes and how the timeout is handled, in both languages', () => {
    const zh = ((key: string, params?: Record<string, string | number>) => uiText('zh', key as never, params)) as never;
    expect(clientHint(zh, 'codex', 1560, 30)).toBe('片段已把工具超时设为 26 分钟（tool_timeout_sec），启动等待设为 30 秒（startup_timeout_sec）。');
    expect(clientHint(zh, 'other', 1560, 30)).toContain('26 分钟（1560 秒）');
    for (const language of ['zh-CN', 'en-US'] as const) {
      lang(language);
      for (const client of MCP_CLIENTS) {
        const html = renderToStaticMarkup(<AgentConnect info={info} client={client} onClient={() => undefined} />);
        expect(html).toContain(`data-client="${client}"`);
        expect(html).toContain('aria-checked="true"');
        // The real paths of this run, exactly once in the snippet.
        expect(html).toContain('/Applications/MCP for NovelAI.app/Contents/Resources/mcp/novelai-mcp.mjs');
        expect(html).toContain('ELECTRON_RUN_AS_NODE');
        if (client === 'codex') expect(html).toContain('tool_timeout_sec = 1560');
        if (client === 'pi') expect(html).toContain('&quot;timeout&quot;: 1560');
        if (client === 'dsh') { expect(html).toContain('toolCallTimeoutMs: 1560000'); expect(html).toContain('~/.dsh/cordis.patch.yml'); expect(html).toContain('DeepSeek Harness'); }
        if (client === 'cursor') expect(html).toContain(language === 'zh-CN' ? '别让 Agent 重发' : 'before letting the agent resend');
      }
    }
  });

  it('says whether the server is ready, warns when the client is still starting or runs from a temporary place', () => {
    lang('zh-CN');
    const now = new Date();
    const ready = renderToStaticMarkup(<ServerStatus info={info} active={false} activity={captureActivity(now, 'sample')} />);
    expect(ready).toContain('MCP 服务就绪');
    expect(ready).toContain('novelai · 18 个工具');
    expect(ready).toContain('Claude Code');
    expect(ready).toContain('不记参数');
    const starting = renderToStaticMarkup(<ServerStatus info={{ ...info, bridgeReady: false, temporaryLocation: true }} active={false} activity={null} />);
    expect(starting).toContain('Agent 通道还没有启动');
    expect(starting).toContain('data-testid="mcp-temporary"');
    expect(starting).toContain('还没有 Agent 连接过');
  });

  it('names the agent that started the app, and when (the newest start only)', () => {
    const now = new Date(2026, 10, 3, 18, 0);
    const activity = { ...captureActivity(now, 'sample'), appStarts: [{ at: new Date(now.getTime() - 3 * 60_000).toISOString(), client: { name: 'claude-code', version: null } }, { at: new Date(now.getTime() - 9 * 60_000).toISOString(), client: null }] };
    expect(lastAppStart(activity, 'zh', now)).toMatchObject({ label: 'Claude Code', when: '3 分钟前' });
    expect(lastAppStart({ recent: [], clients: [] }, 'en', now)).toBeNull();
    for (const language of ['zh-CN', 'en-US'] as const) {
      lang(language);
      const html = renderToStaticMarkup(<ServerStatus info={info} active={false} activity={activity} />);
      expect(html).toContain('data-testid="mcp-recent-start"');
      expect(html).toContain(language === 'zh-CN' ? '启动了应用' : 'started the app');
      expect((html.match(/data-testid="mcp-recent-start"/g) ?? []).length).toBe(1);
    }
    expect(renderToStaticMarkup(<ServerStatus info={info} active={false} activity={captureActivity(now, 'sample')} />)).not.toContain('mcp-recent-start');
  });
});

describe('the first-run guide (step 4b2)', () => {
  it('opens at the step a capture names, with three steps and skip', () => {
    expect(captureStep(null)).toBe(1);
    expect(captureStep({ page: 'onboarding-2-connected', lang: 'zh' })).toBe(2);
    expect(captureStep({ page: 'onboarding-3', lang: null })).toBe(3);
    for (const language of ['zh-CN', 'en-US'] as const) {
      lang(language);
      useAppStore.setState({ account: { hasToken: false } as never });
      const first = renderToStaticMarkup(<Onboarding />);
      expect(first).toContain('data-step="1"');
      expect(first).toContain(language === 'zh-CN' ? '先连接你的 NovelAI 账号' : 'First, connect your NovelAI account');
      expect(first).toContain('data-testid="onboarding-skip"');
      expect(first).toContain('data-testid="onboarding-later-1"');
      expect((first.match(/class="ob-step[ "]/g) ?? []).length).toBe(3);
      // Step 4c1: the guide covers the top bar, so it has the frameless window's own minimize / maximize / close.
      expect(first).toContain('data-testid="window-controls"');
      expect((first.match(/<div class="as-winctl"[\s\S]*?<\/div>/)?.[0].match(/<button /g) ?? []).length).toBe(3);
      expect(first).toContain(language === 'zh-CN' ? 'aria-label="最小化"' : 'aria-label="Minimize"');
      const third = renderToStaticMarkup(<Onboarding capture={{ page: 'onboarding-3', lang: null }} />);
      expect(third).toContain(language === 'zh-CN' ? '准备好了' : 'You’re all set');
      expect(third).toContain('data-testid="onboarding-finish"');
    }
  });
  it('waits on the agent step until a call arrives (capture: just now) and links the project homepage', async () => {
    lang('zh-CN');
    const waiting = renderToStaticMarkup(<Onboarding capture={{ page: 'onboarding-2', lang: 'zh' }} />);
    expect(waiting).toContain('正在等 Agent 的第一次调用');
    const connected = renderToStaticMarkup(<Onboarding capture={{ page: 'onboarding-2-connected', lang: 'zh' }} />);
    expect(connected).toContain('已接通：Claude Code 刚刚调用了 list_queue');
    const source = (await import('node:fs')).readFileSync(new URL('../../onboarding/Onboarding.tsx', import.meta.url), 'utf8');
    expect(source).toContain('openExternal(PROJECT_HOMEPAGE_URL)');
    expect(source).toContain('window.naiDesktop.completeSetup()');
  });
});

describe('the guide\'s error card (4b2 second rework, P2)', () => {
  it('offers retry, skip and copy, and its text names only those (no switching tabs)', () => {
    for (const language of ['zh-CN', 'en-US'] as const) {
      lang(language);
      const html = renderToStaticMarkup(<OnboardingFailure error={new Error('boom')} retry={() => {}} copy={() => {}} />);
      for (const id of ['onboarding-error-retry', 'onboarding-error-skip', 'onboarding-error-copy']) expect(html).toContain(`data-testid="${id}"`);
      expect(html).toContain(language === 'zh-CN' ? '跳过引导' : 'Skip the guide');
      expect(html).toContain(language === 'zh-CN' ? '设置 › 关于与更新' : 'Settings › About &amp; updates');
      expect(html).not.toMatch(/页签|tabs?\b/i);
      expect(html).toContain('boom');
    }
  });
  it('the boundary renders the guide card in place of the default one', () => {
    lang('zh-CN');
    const Throw = () => { throw new Error('guide broke'); };
    const boundary = new AppErrorBoundary({ scope: 'onboarding', children: <Throw />, renderFallback: failure => <OnboardingFailure {...failure} /> });
    boundary.state = { error: new Error('guide broke') };
    const html = renderToStaticMarkup(<>{boundary.render()}</>);
    expect(html).toContain('data-testid="onboarding-error-skip"');
    expect(html).not.toContain('切换页签');
  });
  it('skip marks the guide done, closes it and opens the library', async () => {
    const completeSetup = vi.fn(async () => {});
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { ...(previous as object), naiDesktop: { completeSetup } };
    const load = vi.spyOn(useAppStore.getState(), 'load').mockResolvedValue(undefined as never);
    useAppStore.setState({ showOnboarding: true, load } as never);
    navigate('settings');
    try {
      await completeGuide(null, true);
      expect(completeSetup).toHaveBeenCalledTimes(1);
      expect(useAppStore.getState().showOnboarding).toBe(false);
      expect(useShellRoute.getState().page).toBe('library');
    } finally { (globalThis as { window?: unknown }).window = previous; load.mockRestore(); }
  });
});
