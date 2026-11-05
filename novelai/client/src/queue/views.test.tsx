import { afterEach, describe, expect, it, vi } from 'vitest';
// SSR reads a zustand store's initial state; select from the live state instead (as the other SSR tests do).
vi.mock('../store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store')>();
  const store = actual.useAppStore;
  const select = (selector: (state: ReturnType<typeof store.getState>) => unknown) => selector(store.getState());
  return { ...actual, useAppStore: Object.assign(select, store) };
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { assetQueryClient } from '../asset-library/query';
import { createCaptureFixture } from '../library/capture-fixture';
import { useAppStore } from '../store';
import { uiText } from '../ui/i18n';
import type { BatchItem } from '../workspace/batch-types';
import { createQueueMonitor, type QueueMonitorView } from '../workspace/queue-monitor';
import { BatchDetail, CancelConfirmText, ConfirmBatchLine, ResumeHaltedText } from './BatchDetail';
import { QueuePage, QueueView } from './QueuePage';
import { batch, item } from './test-batch';
import type { QueueBatch } from './model';

afterEach(() => assetQueryClient.clear());
const now = new Date();
const setLanguage = (language: 'zh-CN' | 'en-US') => useAppStore.setState({ settings: { ...(useAppStore.getState().settings ?? {}), language } as never });
const noop = () => Promise.resolve();
const loaded = (batches: QueueBatch[]): QueueMonitorView => ({ loaded: true, batches, error: '' });
const zh = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('zh', key, params);
const en = (key: Parameters<typeof uiText>[1], params?: Record<string, string | number>) => uiText('en', key, params);
/** Text without tags (React may split text nodes with comments). */
const textOf = (html: string) => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');

function page(view: QueueMonitorView, options: { hasToken?: boolean; selected?: string; capture?: Parameters<typeof QueueView>[0]['capture']; lang?: 'zh' | 'en' } = {}) {
  const fixture = createCaptureFixture(options.lang ?? 'zh', now);
  return renderToStaticMarkup(<QueueView view={view} hasToken={options.hasToken ?? true} api={fixture.api} active={false} capture={options.capture ?? null}
    onAction={noop} onRefresh={noop} initialSelected={options.selected ?? null} />);
}

describe('queue page on the sample batches (SSR)', () => {
  it('lists the groups with cards, statuses and sources, and selects the running batch with its pause note (17)', () => {
    setLanguage('zh-CN');
    const { batches } = createCaptureFixture('zh', now);
    const html = page(loaded(batches));
    expect(html).toContain('data-testid="queue-page"');
    for (const id of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9']) expect(html).toContain(`data-testid="queue-batch-${id}"`);
    expect(html).toMatch(/data-testid="queue-batch-b1" data-status="running"/);
    const text = textOf(html);
    for (const value of ['进行中', '等待中', '已结束', '生成中', '排队', '已暂停', '已阻断', '已完成', '已取消', 'Claude Code', 'Codex', '手动 · 本次运行', '7 / 12 张', '全部', '未结束']) expect(text).toContain(value);
    expect(text).toContain(zh('q.summary', { a: 1, b: 3, c: 0 }).slice(0, 8));
    expect(html).toContain('data-testid="queue-detail-b1"');
    expect(html).toContain('data-testid="queue-pause-b1"');
    expect(html).toContain('data-testid="queue-cancel-b1"');
    expect(html).not.toContain('data-testid="queue-resume-b1"');
    expect(text).toContain(zh('q.note.pause'));
    expect(html).toContain('data-testid="queue-item-b1-0" data-status="succeeded"');
    expect(html).toContain('data-testid="queue-item-b1-7" data-status="running"');
    expect(html).toContain('data-testid="queue-item-b1-8" data-status="pending"');
    expect(text).toContain(zh('c.tech'));
    // Running pulses; the agent source is cyan.
    expect(html).toContain('ui-dot--live');
    expect(html).toContain('ui-tag--agent');
  });

  it('shows the automatic pause (queue_halted) with Resume, and no token disables Resume with the reason (18)', () => {
    setLanguage('zh-CN');
    const { batches } = createCaptureFixture('zh', now);
    const html = page(loaded(batches), { capture: { page: 'queue-halted', lang: 'zh' } });
    expect(html).toContain('data-testid="queue-detail-b4"');
    expect(html).toContain('data-testid="queue-halted-b4"');
    expect(textOf(html)).toContain(zh('q.note.halted'));
    expect(html).toContain('queue_halted');
    expect(html).not.toMatch(/data-testid="queue-resume-b4"[^>]*disabled/);
    const noToken = page(loaded(batches), { capture: { page: 'queue-halted', lang: 'zh' }, hasToken: false });
    expect(noToken).toMatch(/data-testid="queue-resume-b4"[^>]*disabled=""/);
    expect(noToken).toContain('data-testid="queue-resume-token-b4"');
    expect(noToken).toContain('data-testid="queue-no-token"');
    expect(textOf(noToken)).toContain(zh('q.noToken'));
  });

  it('shows unknown results with the library check, failures with their first reason, and a blocked batch with its host reason (19)', () => {
    setLanguage('en-US');
    const { batches } = createCaptureFixture('en', now);
    const unknown = page(loaded(batches), { capture: { page: 'queue-unknown', lang: 'en' }, lang: 'en' });
    expect(unknown).toContain('data-testid="queue-unknown-b7"');
    expect(textOf(unknown)).toContain(en('q.note.unknown', { n: 1 }));
    expect(unknown).toContain('data-testid="queue-item-b7-7" data-status="unknown"');
    const failed = page(loaded(batches), { capture: { page: 'queue-failed', lang: 'en' }, lang: 'en' });
    expect(failed).toContain('data-testid="queue-failed-b8"');
    expect(textOf(failed)).toContain(en('q.note.failed', { n: 2 }));
    expect(textOf(failed)).toContain('Image 4: The provider refused the request.');
    expect(failed).toContain('data-testid="queue-item-b8-3" data-status="failed"');
    const blocked = page(loaded(batches), { capture: { page: 'queue-blocked', lang: 'en' }, lang: 'en' });
    expect(blocked).toContain('data-testid="queue-error-b5"');
    expect(blocked).toContain('recipe_source_missing');
    expect(blocked).not.toContain('data-testid="queue-pause-b5"');
    expect(blocked).not.toContain('data-testid="queue-cancel-b5"');
  });

  it('shows the empty state, the loading state, and a read failure with Retry', async () => {
    setLanguage('zh-CN');
    const empty = page(loaded([]));
    expect(empty).toContain('data-testid="queue-empty"');
    expect(textOf(empty)).toContain(zh('q.empty.t'));
    expect(textOf(empty)).toContain(zh('q.empty.d'));
    // The page over a capture monitor: queue-empty shows no batches, queue shows them.
    const fixture = createCaptureFixture('zh', now);
    const monitor = createQueueMonitor({ call: async () => ({ ok: true, result: { batches: fixture.batches } }) as never });
    await monitor.refresh();
    const captured = renderToStaticMarkup(<QueuePage monitor={monitor} api={fixture.api} active={false} capture={{ page: 'queue-empty', lang: 'zh' }} />);
    expect(captured).toContain('data-testid="queue-empty"');
    expect(captured).not.toContain('queue-batch-b1');
    expect(renderToStaticMarkup(<QueuePage monitor={monitor} api={fixture.api} active={false} capture={{ page: 'shell-queue', lang: 'zh' }} />)).toContain('data-testid="queue-detail-b1"');
    const noBridge = renderToStaticMarkup(<QueuePage monitor={null} api={fixture.api} active={false} />);
    expect(noBridge).toContain('data-testid="queue-read-failed"');
    expect(noBridge).not.toContain('queue-retry');
    expect(page({ loaded: false, batches: [], error: '' })).toContain('data-testid="queue-loading"');
    const failed = page({ loaded: false, batches: [], error: 'x', failure: { code: 'queue_unavailable', message: 'The queue is not ready yet.' } });
    expect(failed).toContain('data-testid="queue-retry"');
    expect(textOf(failed)).toContain('队列还没准备好，请稍后再试。');
  });
});

describe('queue page controls and the cancel confirmation', () => {
  const item = (index: number, status: BatchItem['status']): BatchItem => ({ index, plannedSeed: index, actualSeed: null, requestKey: `k${index}`, jobId: status === 'pending' ? null : `j${index}`, status, results: [], error: null });
  it('mentions the possible charge only while an image is being generated', () => {
    setLanguage('zh-CN');
    const running = renderToStaticMarkup(<CancelConfirmText batch={batch('r', 'running', [item(0, 'running'), item(1, 'pending'), item(2, 'pending')])} t={zh} />);
    expect(textOf(running)).toContain(zh('q.cancel.body', { n: 2 }));
    expect(running).toContain('data-testid="queue-cancel-charged"');
    expect(textOf(running)).toContain('可能已经扣费');
    const queued = renderToStaticMarkup(<CancelConfirmText batch={batch('q', 'queued', [item(0, 'pending')])} t={en} />);
    expect(textOf(queued)).toContain('The 1 image not started yet won’t be generated.');
    expect(queued).not.toContain('queue-cancel-charged');
  });
  it('offers Pause and Cancel while running, Resume (primary) and Cancel while paused, nothing once ended', () => {
    setLanguage('en-US');
    const { api } = createCaptureFixture('en', now);
    const detail = (value: QueueBatch) => renderToStaticMarkup(<BatchDetail api={api} batch={value} hasToken eta={null} onAction={noop} t={en} lang="en" language="en-US" />);
    const running = detail(batch('r', 'running', [item(0, 'running')]));
    expect(running).toContain('queue-pause-r');
    expect(running).toContain('queue-cancel-r');
    const paused = detail(batch('p', 'paused', [item(0, 'pending')]));
    expect(paused).toMatch(/data-testid="queue-resume-p"[^>]*ui-btn--primary/);
    expect(paused).toMatch(/data-testid="queue-cancel-p"[^>]*ui-btn--danger-ghost/);
    const ended = detail(batch('d', 'succeeded', [item(0, 'skipped')]));
    expect(ended).not.toMatch(/queue-(pause|resume|cancel)-d/);
    const withEta = renderToStaticMarkup(<BatchDetail api={api} batch={batch('r', 'running', [item(0, 'running')])} hasToken eta={3} onAction={noop} t={en} lang="en" language="en-US" />);
    expect(textOf(withEta)).toContain('0 of 1 · About 3 min left');
    expect(textOf(running)).not.toContain('min left');
  });
});

describe('an agent batch\'s failed image shows what NovelAI answered (step 4c1)', () => {
  const failed = (upstream?: Record<string, unknown>): BatchItem => ({ index: 0, plannedSeed: 1, actualSeed: null, requestKey: 'k0', jobId: 'j0', status: 'failed', results: [],
    error: { code: 'generation_failed', message: 'The generation request did not complete (HTTP 400); check the account and the input.', reason: 'generation.request_failed', params: { status: 400, httpZh: '（HTTP 400）', httpEn: ' (HTTP 400)' }, ...(upstream ? { upstream } : {}) } as BatchItem['error'] });
  const detail = (item: BatchItem, lang: 'zh' | 'en') => {
    setLanguage(lang === 'zh' ? 'zh-CN' : 'en-US');
    const { api } = createCaptureFixture(lang, now);
    return renderToStaticMarkup(<BatchDetail api={api} batch={batch('f', 'blocked', [item])} hasToken eta={null} onAction={noop} t={lang === 'zh' ? zh : en} lang={lang} language={lang === 'zh' ? 'zh-CN' : 'en-US'} />);
  };
  it('the failure note has NovelAI\'s message under the reason, in both languages; the cell title too', () => {
    const zhHtml = detail(failed({ status: 400, message: 'prompt rejected' }), 'zh');
    expect(zhHtml).toContain('data-testid="queue-upstream-f"');
    expect(textOf(zhHtml)).toContain('NovelAI 返回（HTTP 400）：prompt rejected');
    expect(zhHtml).toContain('title="生成请求未完成（HTTP 400）；请检查账号配置和输入。 · NovelAI 返回（HTTP 400）：prompt rejected"');
    const enHtml = detail(failed({ status: 400, message: 'prompt rejected' }), 'en');
    expect(textOf(enHtml)).toContain('NovelAI said (HTTP 400): prompt rejected');
    expect(textOf(enHtml)).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it('an unavailable service reads by reason; an item stored before (no upstream) shows only its reason', () => {
    expect(textOf(detail(failed({ status: 502, reason: 'remote.unavailable', params: { statusText: ' Bad Gateway' } }), 'zh'))).toContain('NovelAI 暂时不可用（HTTP 502 Bad Gateway），请稍后重试。');
    const old = detail(failed(), 'en');
    expect(old).not.toContain('queue-upstream-');
    expect(textOf(old)).toContain('The generation request did not complete (HTTP 400)');
  });
});

describe('a large manual batch stays cheap to render', () => {
  it('renders 999 items with a bounded number of elements', () => {
    setLanguage('zh-CN');
    const { api } = createCaptureFixture('zh', now);
    const items: BatchItem[] = Array.from({ length: 999 }, (_, index) => ({
      index, plannedSeed: index, actualSeed: index < 300 ? index : null, requestKey: `k${index}`, jobId: index <= 300 ? `job-${index}` : null,
      status: index < 300 ? 'succeeded' : index === 300 ? 'running' : 'pending',
      results: index < 300 ? [{ index: 0, id: `h-${index}`, width: 832, height: 1216, model: 'm', actualSeed: index }] : [], error: null,
    }));
    const big = batch('big', 'running', items, { source: { kind: 'manual', persistent: false } });
    const html = renderToStaticMarkup(<BatchDetail api={api} batch={big} hasToken eta={null} onAction={noop} t={zh} lang="zh" language="zh-CN" />);
    const elements = (html.match(/<[a-z]/g) ?? []).length;
    const cells = (html.match(/data-testid="queue-item-big-/g) ?? []).length;
    expect(cells).toBe(999);
    // 698 pending cells are one element each, a finished cell 6 (cell, button, thumb, icon, check mark), plus the
    // header, notes and the first 20 technical rows: 3,278 elements on this data (2026-11, about 55 ms).
    expect(elements).toBeLessThan(3600);
  });
});

describe('queue page code', () => {
  it('keeps the dev-tools test ids', () => {
    const dir = path.resolve(__dirname);
    const code = ['QueuePage.tsx', 'QueueList.tsx', 'BatchDetail.tsx', 'ItemGrid.tsx'].map(name => readFileSync(path.join(dir, name), 'utf8')).join('\n');
    for (const id of ['queue-page', 'queue-batch-', 'queue-detail-', 'queue-${action}-', 'queue-cancel-confirm', 'queue-item-', 'queue-empty', 'queue-halted-', 'queue-error-', 'queue-unknown-', 'queue-failed-']) {
      expect(code.includes(id) || readFileSync(path.join(dir, 'model.ts'), 'utf8').includes(id), id).toBe(true);
    }
  });
});

describe('review rework (4b2 P1): the shown batch stays, buttons settle, confirmations name their batch', () => {
  const fixture = () => createCaptureFixture('zh', now);
  const detail = (value: QueueBatch, props: Partial<Parameters<typeof BatchDetail>[0]> = {}) => renderToStaticMarkup(<BatchDetail api={fixture().api} batch={value} hasToken eta={null} onAction={noop} t={zh} lang="zh" language="zh-CN" {...props} />);

  it('a batch the page chose by itself starts with its buttons off (settling); one the user picked does not', () => {
    setLanguage('zh-CN');
    const running = batch('r1', 'running', [item(0, 'succeeded'), item(1, 'running'), item(2, 'pending')]);
    const settling = detail(running, { settleOnMount: true });
    const pauseTag = (html: string) => /<button[^>]*data-testid="queue-pause-r1"[^>]*>/.exec(html)?.[0] ?? '';
    // Off but focusable (second rework, P3): aria-disabled, never the native disabled that drops the focus.
    expect(pauseTag(settling)).toContain('aria-disabled="true"');
    expect(pauseTag(settling)).not.toMatch(/\sdisabled=""/);
    expect(settling).toContain('data-settling="true"');
    expect(pauseTag(detail(running))).not.toContain('aria-disabled');
    // The actions group can hold the focus when the focused button goes away with its state.
    expect(settling).toMatch(/<div[^>]*role="group"[^>]*tabindex="-1"[^>]*data-testid="queue-acts-r1"/);
  });

  it('resuming a batch the queue paused itself asks first, saying the protection is lifted and it may have been charged', () => {
    setLanguage('zh-CN');
    const halted = batch('h1', 'paused', [item(0, 'pending')], { error: { code: 'queue_halted', message: 'x' } });
    // The dialog renders in a portal (not in SSR): its parts, and the wiring in the source.
    expect(textOf(renderToStaticMarkup(<ResumeHaltedText t={zh} />))).toContain('前一批失败或结果未知（可能已扣费）。继续会解除自动暂停保护，之后新入队的 Agent 批次也会直接开始。');
    const line = textOf(renderToStaticMarkup(<ConfirmBatchLine batch={halted} t={zh} />));
    expect(line).toContain('Claude Code');
    expect(line).toContain('h1');
    const source = readFileSync(path.join(__dirname, 'BatchDetail.tsx'), 'utf8');
    expect(source).toContain("else if (action === 'resume' && halted) setConfirming('resume');");
    expect(source).toContain('data-testid="queue-resume-confirm"');
    // Opening a confirmation whose batch ended closes it and says nothing was done.
    expect(source).toContain("if (isBatchTerminal(batch.status)) { setConfirming(null); setClosedNote('ended'); }");
    expect(detail(halted)).toContain('title="' + zh('q.resumeHaltedTip') + '"');
  });

  it('the cancel confirmation names the batch, its source and a short id; its button is off once the batch ended', () => {
    setLanguage('en-US');
    const running = batch('0f9e8d7c-1111-4222-8333-444455556666', 'running', [item(0, 'running'), item(1, 'pending')], { output: { historyGroupName: 'Lighthouse' } });
    const text = textOf(renderToStaticMarkup(<><ConfirmBatchLine batch={running} t={en} /><CancelConfirmText batch={running} t={en} /></>));
    expect(text).toContain('Lighthouse');
    expect(text).toContain('Claude Code');
    expect(text).toContain('0f9e8d7c…6666');
    expect(text).toContain(en('q.cancel.charged'));
    expect(readFileSync(path.join(__dirname, 'BatchDetail.tsx'), 'utf8')).toContain('disabled={isBatchTerminal(batch.status)} onClick={() => void run(\'cancel\')} data-testid="queue-cancel-confirm"');
  });

  it('the page keeps the shown batch when it ends and offers the next one in progress at the top of the list', () => {
    setLanguage('zh-CN');
    const ended = batch('e1', 'succeeded', [item(0, 'succeeded')]);
    const next = batch('n1', 'running', [item(0, 'running'), item(1, 'pending')]);
    const html = page(loaded([next, ended]), { selected: 'e1' });
    expect(html).toContain('data-testid="queue-detail-e1"');
    expect(html).toContain('data-testid="queue-next-active" data-batch="n1"');
    expect(textOf(html)).toContain(zh('q.next.ended'));
    // Showing the running batch itself: no entry.
    expect(page(loaded([next, ended]), { selected: 'n1' })).not.toContain('data-testid="queue-next-active"');
  });
});

describe('second rework (4b2 P3): a project still being read is never shown as none', () => {
  it('shows 读取中… while the batch is unlisted, 无 when it has no project, the name when it has one', () => {
    setLanguage('zh-CN');
    const { api } = createCaptureFixture('zh', now);
    const agent = batch('u1', 'queued', [item(0, 'pending')]);
    const text = (props: Partial<Parameters<typeof BatchDetail>[0]>) => textOf(renderToStaticMarkup(<BatchDetail api={api} batch={agent} hasToken eta={null} onAction={noop} t={zh} lang="zh" language="zh-CN" {...props} />));
    expect(text({ projectPending: true })).toContain(`${zh('q.m.project')}${zh('q.m.projectLoading')}`);
    expect(text({})).toContain(`${zh('q.m.project')}${zh('c.none')}`);
    expect(text({ projectPending: true, batch: { ...agent, output: { historyGroupName: 'P1' } } })).toContain(`${zh('q.m.project')}P1`);
    // The page passes the monitor's unlisted ids down.
    const html = page({ loaded: true, batches: [agent], error: '', unlisted: ['u1'] }, { selected: 'u1' });
    expect(html).toContain('data-testid="queue-project-u1" data-pending="true"');
  });
});
