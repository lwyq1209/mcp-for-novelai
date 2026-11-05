// The DevTools driver against a real (hidden) Chromium window: --nth counting, dialog-text, toasts and
// type --replace/--clear, through the library and through ui.mjs. No client, no app data (tests/window.mjs).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { dialogText, toasts } from '../lib/cdp.mjs';
import { runCliAsync } from './helpers.mjs';
import { openFixtureWindow, setBody } from './window.mjs';

let fixture;
before(async () => { fixture = await openFixtureWindow(); });
after(async () => { await fixture?.close?.(); });
const page = t => { if (fixture.skip) { t.skip(fixture.skip); return null; } return fixture.page; };
const ui = (...args) => runCliAsync('ui.mjs', [...args, '--port', String(fixture.port)]);

const BUTTONS = `
  <button class="b" style="display:none">hidden one</button>
  <button class="b" onclick="window.__testClicked='first'">first</button>
  <span style="visibility:hidden"><button class="b">invisible one</button></span>
  <button class="b" onclick="window.__testClicked='second'">second</button>`;

test('--nth is the 0-based index among the VISIBLE matches; out of range says how many there are', async t => {
  const p = page(t); if (!p) return;
  await setBody(p, BUTTONS);
  const first = await p.click('button.b', { nth: 0 });
  assert.equal(first.element.text, 'first');
  assert.deepEqual([first.nth, first.matches], [0, 2], 'two visible matches; the hidden ones are not counted');
  assert.equal(await p.evaluate('window.__testClicked'), 'first');
  assert.equal((await p.click('button.b', { nth: 1 })).element.text, 'second');
  assert.equal(await p.evaluate('window.__testClicked'), 'second');
  await assert.rejects(p.click('button.b', { nth: 2, timeoutMs: 300 }), error => error.code === 'not_found' && /--nth 2 is out of range: 2 visible matches; --nth counts the visible matches from 0 \(0 = the first, 1 = the last\)/.test(error.message) && error.details.visibleMatches === 2);
  await assert.rejects(p.click('button.b', { nth: -1 }), { code: 'usage' });
  await assert.rejects(p.click('button.b', { nth: 1.5 }), { code: 'usage' });
  await assert.rejects(p.wait('button.b', { nth: 2, timeoutMs: 300 }), error => error.code === 'wait_timeout' && /--nth 2 is out of range \(2 matches, counted from 0\)/.test(error.message));
  assert.equal((await p.wait('button.b', { nth: 3, state: 'attached' })).element.text, 'second', 'attached counts every match');

  const cli = await ui('click', 'button.b', '--nth', '1');
  assert.equal(cli.status, 0, cli.stdout);
  assert.deepEqual([cli.json.element.text, cli.json.nth, cli.json.matches], ['second', 1, 2]);
  const bad = await ui('click', 'button.b', '--nth', '-1');
  assert.equal(bad.status, 2);
  assert.match(bad.json.error.message, /0-based index among the VISIBLE matches/);
  const past = await ui('click', 'button.b', '--nth', '5', '--timeout', '0.3');
  assert.equal(past.json.error.code, 'not_found');
  assert.match(past.json.error.message, /out of range: 2 visible matches/);
});

// Hidden panels that keep role=dialog (the old canvas has many), one visible but covered panel, and the modal on top.
const DIALOGS = `
  <div role="dialog" aria-label="display none" style="display:none">display none text</div>
  <div role="dialog" aria-label="visibility hidden" style="visibility:hidden;position:fixed;left:10px;top:10px;width:300px;height:200px">visibility text</div>
  <div role="dialog" aria-label="opacity zero" style="opacity:0;position:fixed;left:10px;top:10px;width:300px;height:200px">opacity text</div>
  <div role="dialog" aria-label="off screen" style="position:fixed;left:-5000px;top:10px;width:300px;height:200px">off-screen text</div>
  <div role="dialog" aria-label="zero size" style="position:fixed;left:10px;top:10px;width:0;height:0;overflow:hidden">zero text</div>
  <div style="display:none"><div role="dialog" aria-label="hidden parent">hidden parent text</div></div>
  <div role="dialog" aria-label="old canvas panel" style="position:fixed;left:20px;top:20px;width:700px;height:500px;background:#eee">Old panel text <button>Old button</button></div>
  <div class="backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:10"></div>
  <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm" style="position:fixed;left:300px;top:200px;width:420px;height:240px;background:#fff;z-index:11">
    <h2 id="confirm-title">删除 2 项？</h2>
    <p>2 张图片会移到最近删除。</p>
    <p style="display:none">hidden paragraph</p>
    <button>取消</button> <button disabled>删除</button>
  </div>`;

test('dialog-text reads only the visible, top-most dialog', async t => {
  const p = page(t); if (!p) return;
  await setBody(p, DIALOGS);
  const result = await p.dialogText({ timeoutMs: 2000 });
  assert.equal(result.dialog.label, '删除 2 项？');
  assert.equal(result.dialog.modal, true);
  assert.equal(result.dialog.testid, 'confirm');
  assert.deepEqual(result.dialog.lines, ['删除 2 项？', '2 张图片会移到最近删除。', '取消 删除']);
  assert.ok(!result.dialog.text.includes('hidden paragraph'));
  assert.deepEqual(result.dialog.buttons, [{ text: '取消', disabled: false }, { text: '删除', disabled: true }]);
  assert.deepEqual(result.counts, { total: 8, visible: 2, onTop: 1 });
  assert.deepEqual(result.covered.map(entry => entry.label), ['old canvas panel'], 'the visible panel under the backdrop is covered, not on top');
  assert.deepEqual(result.others, []);
  assert.equal((await dialogText(p, { timeoutMs: 500 })).dialog.label, '删除 2 项？', 'the exported function reads the same');

  const cli = await ui('dialog-text', '--timeout', '2');
  assert.equal(cli.status, 0, cli.stdout);
  assert.equal(cli.json.dialog.label, '删除 2 项？');
  assert.match(cli.json.dialog.text, /2 张图片会移到最近删除。/);
});

test('dialog-text order: an inner dialog first, then the one painted above, then modal, then the later one', async t => {
  const p = page(t); if (!p) return;
  await setBody(p, `
    <div role="dialog" aria-label="outer" aria-modal="true" style="position:fixed;left:10px;top:10px;width:600px;height:400px;background:#fff">
      Outer text
      <div role="dialog" aria-label="inner" style="position:absolute;left:200px;top:100px;width:200px;height:120px;background:#ddd">Inner text</div>
    </div>
    <div role="dialog" aria-label="side" style="position:fixed;left:700px;top:10px;width:250px;height:200px;background:#fff">Side text</div>`);
  const nested = await p.dialogText({ timeoutMs: 1000 });
  assert.equal(nested.dialog.label, 'inner');
  assert.deepEqual(nested.others.map(entry => entry.label), ['outer', 'side'], 'modal before the non-modal side panel that does not overlap');

  await setBody(p, `
    <div role="dialog" aria-label="upper" style="position:fixed;left:100px;top:100px;width:300px;height:200px;background:#fff;z-index:5">Upper</div>
    <div role="dialog" aria-label="lower later" style="position:fixed;left:150px;top:150px;width:300px;height:200px;background:#eee;z-index:1">Lower</div>`);
  const stacked = await p.dialogText({ timeoutMs: 1000 });
  assert.equal(stacked.dialog.label, 'upper', 'painted above wins over document order');
  assert.deepEqual(stacked.others.map(entry => entry.label), ['lower later']);

  await setBody(p, '<div role="dialog" style="display:none">only hidden</div><p>no dialog</p>');
  await assert.rejects(p.dialogText({ timeoutMs: 300 }), error => error.code === 'no_dialog' && /1 dialog element\(s\), 0 visible/.test(error.message));
  const cli = await ui('dialog-text', '--timeout', '0.3');
  assert.equal(cli.status, 1);
  assert.equal(cli.json.error.code, 'no_dialog');
});

const TOASTS = `
  <div class="ui-toast-stack" style="position:fixed;left:50%;bottom:22px;transform:translateX(-50%)">
    <div role="status" class="ui-toast ui-toast--ok"><div class="ui-toast__msg">生成完成，已保存 1 张图片。</div><button class="ui-toast__action">查看</button><button aria-label="关闭">x</button></div>
    <div role="status" class="ui-toast" style="display:none"><div class="ui-toast__msg">a hidden toast</div></div>
  </div>`;

test('toasts lists the toasts shown now and can wait for one containing a text', async t => {
  const p = page(t); if (!p) return;
  await setBody(p, '<p>nothing yet</p>');
  assert.deepEqual((await p.toasts()).toasts, [], 'no toast: an empty list, not an error');
  await assert.rejects(p.toasts({ timeoutMs: 200 }), { code: 'no_toast' });

  await setBody(p, TOASTS);
  const now = await p.toasts();
  assert.deepEqual(now.toasts, [{ text: '生成完成，已保存 1 张图片。', tone: 'ok', role: 'status', action: '查看' }]);
  // A toast that appears later (as after a failed generation) is waited for by its text.
  await p.evaluate(() => setTimeout(() => {
    const toast = document.createElement('div');
    toast.className = 'ui-toast ui-toast--danger'; toast.setAttribute('role', 'alert');
    toast.innerHTML = '<div class="ui-toast__msg">NovelAI API 源（HTTP 500）：Upstream GPU melted</div>';
    document.querySelector('.ui-toast-stack').append(toast);
  }, 400));
  const waited = await toasts(p, { timeoutMs: 5000, contains: 'Upstream GPU melted' });
  assert.equal(waited.matched, 1);
  assert.deepEqual(waited.toasts.map(toast => [toast.tone, toast.role]), [['ok', 'status'], ['danger', 'alert']]);
  assert.ok(waited.elapsedMs >= 300);

  const cli = await ui('toasts');
  assert.equal(cli.status, 0, cli.stdout);
  assert.equal(cli.json.count, 2);
  const missing = await ui('toasts', '--contains', 'never shown', '--timeout', '0.3');
  assert.equal(missing.json.error.code, 'no_toast');
});

const FIELDS = `
  <textarea class="t" style="width:400px;height:80px">old content that must go</textarea>
  <input class="i" value="abc">
  <div class="ce" contenteditable="true" style="width:300px;min-height:30px;border:1px solid">editable old text</div>
  <textarea class="locked">keep me</textarea>`;

test('type --replace selects all with the real shortcut and types over it; --clear empties first', async t => {
  const p = page(t); if (!p) return;
  await setBody(p, FIELDS);
  await p.evaluate(() => {
    window.__testKeys = [];
    document.addEventListener('keydown', event => window.__testKeys.push(`${event.metaKey ? 'Meta+' : ''}${event.ctrlKey ? 'Control+' : ''}${event.key}`), true);
    document.querySelector('.locked').addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'a') event.preventDefault(); });
  });
  const replaced = await p.type('textarea.t', '1girl, night sky', { replace: true });
  assert.deepEqual([replaced.mode, replaced.value, replaced.replacedLength], ['replace', '1girl, night sky', 24]);
  assert.ok((await p.evaluate('window.__testKeys')).includes(process.platform === 'darwin' ? 'Meta+a' : 'Control+a'), 'a real select-all key event was sent');
  assert.equal(await p.evaluate(() => document.querySelector('textarea.t').value), '1girl, night sky');

  assert.equal((await p.type('input.i', 'xyz', { clear: true })).value, 'xyz');
  assert.equal((await p.type('.ce', 'fresh text', { replace: true })).value, 'fresh text');
  await assert.rejects(p.type('textarea.locked', 'lost', { replace: true }), error => error.code === 'not_selected' && error.details.all === false);
  assert.equal(await p.evaluate(() => document.querySelector('textarea.locked').value), 'keep me', 'nothing typed when select-all failed');
  await assert.rejects(p.type('textarea.t', 'x', { replace: true, clear: true }), { code: 'usage' });

  const cli = await ui('type', 'textarea.t', 'typed by the CLI', '--replace');
  assert.equal(cli.status, 0, cli.stdout);
  assert.deepEqual([cli.json.mode, cli.json.value], ['replace', 'typed by the CLI']);
  const both = await ui('type', 'textarea.t', 'x', '--replace', '--clear');
  assert.equal(both.status, 2);
});
