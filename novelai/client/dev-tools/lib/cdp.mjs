// Minimal Chrome DevTools Protocol driver for the test client's window (Node 24 global WebSocket/fetch, no deps).
// Input goes through Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText: real pointer and keyboard
// events, so focus, overlays (a click on something covered is refused unless forced) and disabled controls behave as
// for a person. Only 127.0.0.1 endpoints are used.
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, pollUntil, sleep } from './cli.mjs';
import { clientDir, clientRequire } from './paths.mjs';

const HOST = '127.0.0.1';

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

/** One DevTools WebSocket session. */
export class CdpConnection {
  static async open(url, { timeoutMs = 10_000 } = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DevTools WebSocket ${url} did not open within ${timeoutMs} ms.`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', event => { clearTimeout(timer); reject(new Error(`DevTools WebSocket error: ${event?.message ?? 'connection failed'}`)); }, { once: true });
    });
    return new CdpConnection(ws);
  }
  constructor(ws) {
    this.ws = ws; this.nextId = 1; this.pending = new Map(); this.listeners = new Map(); this.closed = false;
    ws.addEventListener('message', event => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id); clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
        else entry.resolve(message.result ?? {});
      } else if (message.method) for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`DevTools connection closed during ${entry.method}.`)); }
      this.pending.clear();
    });
  }
  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new Error(`DevTools connection is closed (${method}).`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }
  close() { if (!this.closed) { this.closed = true; try { this.ws.close(); } catch { /* already closed */ } } }
}

// ── In-page helpers (serialized into Runtime.evaluate; they run in the window, not in Node) ──────────────────────
function inPageResolve(spec) {
  const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const INTERACTIVE = 'button, a[href], [role=button], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=option], [role=checkbox], [role=switch], [role=radio], label, summary, input, select, textarea';
  let found;
  if (spec.text !== undefined) {
    const want = norm(spec.text);
    // `within`: every VISIBLE element matching that selector is a scope (the first match may be a hidden one).
    const scopes = spec.within ? [...document.querySelectorAll(spec.within)].filter(visible) : [document.body];
    const all = scopes.flatMap(scope => [scope, ...scope.querySelectorAll('*')]);
    const labels = el => [el.getAttribute('aria-label'), el.getAttribute('title'), el.tagName === 'INPUT' ? el.value || el.placeholder : null].map(norm);
    const own = el => norm(el.innerText ?? el.textContent);
    const exact = el => own(el) === want || labels(el).includes(want);
    let matches = all.filter(el => visible(el) && exact(el));
    if (!matches.length && !spec.exact) matches = all.filter(el => visible(el) && (own(el).includes(want) || labels(el).some(label => label.includes(want))));
    matches = matches.filter(el => !matches.some(other => other !== el && el.contains(other)));
    found = [...new Set(matches.map(el => el.closest(INTERACTIVE) ?? el))];
  } else {
    found = [...document.querySelectorAll(spec.css)];
    if (spec.state !== 'attached') found = found.filter(visible);
  }
  // nth: 0-based index among the VISIBLE matches (0 = the first); hidden matches are not counted.
  const element = found[spec.nth ?? 0] ?? null;
  const describe = el => el ? { tag: el.tagName.toLowerCase(), text: norm(el.innerText ?? el.textContent).slice(0, 80), label: el.getAttribute('aria-label'), className: String(el.className?.baseVal ?? el.className ?? '').slice(0, 120), testid: el.getAttribute('data-testid') } : null;
  const result = { count: found.length, nth: spec.nth ?? 0, element: describe(element) };
  if (!element) return result;
  const covers = el => { const r = el.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return Boolean(h && (h === el || el.contains(h))); };
  // Scrolled when its centre is outside the window or clipped/covered inside a scroll container (a person scrolls first).
  if (spec.scroll && !covers(element)) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  const disabled = Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true' || element.closest('fieldset[disabled]') || element.closest('[inert]'));
  Object.assign(result, {
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, point: { x, y },
    visible: visible(element), disabled, inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
    hitOk: Boolean(hit && (hit === element || element.contains(hit) || (element.tagName === 'LABEL' && element.control && (hit === element.control)))),
    hit: describe(hit),
  });
  if (spec.mark) { window.__devToolsTarget = element; }
  return result;
}

function inPageFocusInfo() {
  const el = document.activeElement;
  const target = window.__devToolsTarget;
  return { focused: el ? { tag: el.tagName.toLowerCase(), label: el.getAttribute('aria-label'), className: String(el.className ?? '').slice(0, 120) } : null, focusInTarget: Boolean(target && el && (target === el || target.contains(el))) };
}

/** Whether the focused field's whole content is selected (null when the field has no selection API). */
function inPageSelectionInfo() {
  const el = document.activeElement;
  if (!el) return { kind: 'none', all: null };
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    let start = null, end = null;
    try { start = el.selectionStart; end = el.selectionEnd; } catch { /* an input type without a selection API */ }
    const length = el.value.length;
    return { kind: 'field', length, start, end, all: start === null || start === undefined ? null : length === 0 || (start === 0 && end === length) };
  }
  if (el.isContentEditable) {
    const norm = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    const text = norm(el.innerText), selected = norm(getSelection()?.toString());
    return { kind: 'editable', length: text.length, selected: selected.length, all: text.length === 0 || selected === text };
  }
  return { kind: 'other', all: null };
}

/** The focused field's value (input/textarea value or contenteditable text), for the read-back after typing. */
function inPageFieldValue() {
  const el = document.activeElement;
  const value = !el ? null : el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : el.isContentEditable ? el.innerText : null;
  return value === null ? { value: null, length: null } : { value: value.length > 500 ? `${value.slice(0, 500)}…` : value, length: value.length };
}

/** The visibility test shared by the dialog and toast readers (its source is passed into them, see withShown). */
function inPageShown() {
  return el => {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) return false;
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
}

/**
 * Dialogs (role=dialog / alertdialog, open <dialog>) that are visible AND on top: a dialog counts when one of five
 * points inside it hit-tests to it (not to another dialog, a backdrop or the page over it). Hidden panels that keep
 * role=dialog (display:none, visibility:hidden, opacity 0, zero size, off-screen, inert or covered) are left out.
 * Order: an inner dialog before the one containing it, then the one painted above where two overlap, then modal
 * ones, then the later one in the document.
 */
function inPageDialogs(selector, shown) {
  const lines = el => String(el.innerText ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const all = [...document.querySelectorAll(selector)];
  const visible = all.filter(shown);
  const innermost = node => { for (let el = node; el && el !== document.documentElement; el = el.parentElement) if (visible.includes(el)) return el; return null; };
  const clip = el => { const r = el.getBoundingClientRect(); return { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(innerWidth, r.right), bottom: Math.min(innerHeight, r.bottom) }; };
  const onTop = visible.filter(dialog => {
    const r = clip(dialog);
    return [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].some(([fx, fy]) => innermost(document.elementFromPoint(r.left + (r.right - r.left) * fx, r.top + (r.bottom - r.top) * fy)) === dialog);
  });
  const above = (a, b) => {
    const ra = clip(a), rb = clip(b);
    const left = Math.max(ra.left, rb.left), right = Math.min(ra.right, rb.right), top = Math.max(ra.top, rb.top), bottom = Math.min(ra.bottom, rb.bottom);
    if (right <= left || bottom <= top) return 0;
    const hit = innermost(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
    return hit === a ? -1 : hit === b ? 1 : 0;
  };
  const modal = el => el.getAttribute('aria-modal') === 'true' || (el.tagName === 'DIALOG' && el.matches(':modal'));
  onTop.sort((a, b) => {
    if (a.contains(b)) return 1;
    if (b.contains(a)) return -1;
    const stacked = above(a, b);
    if (stacked) return stacked;
    if (modal(a) !== modal(b)) return modal(a) ? -1 : 1;
    return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
  });
  const labelOf = el => {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const labelled = ids.map(id => document.getElementById(id)?.innerText ?? '').join(' ').replace(/\s+/g, ' ').trim();
    return el.getAttribute('aria-label') || labelled || el.querySelector('h1, h2, h3, [role=heading]')?.innerText?.replace(/\s+/g, ' ').trim() || null;
  };
  const describe = (el, full) => {
    const r = el.getBoundingClientRect();
    const base = { label: labelOf(el), role: el.getAttribute('role') ?? el.tagName.toLowerCase(), modal: modal(el), testid: el.getAttribute('data-testid'), className: String(el.className ?? '').slice(0, 120) };
    if (!full) return base;
    const text = lines(el);
    const buttons = [...el.querySelectorAll('button, [role=button]')].filter(shown).map(button => ({ text: (button.innerText ?? '').replace(/\s+/g, ' ').trim() || button.getAttribute('aria-label') || button.getAttribute('title') || '', disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true') }));
    return { ...base, text: text.join('\n'), lines: text, buttons, rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
  };
  return { total: all.length, visible: visible.length, onTop: onTop.map((el, index) => describe(el, index === 0)), covered: visible.filter(el => !onTop.includes(el)).map(el => describe(el, false)) };
}

/** Visible toasts (oldest first): message text, tone, role and action label. */
function inPageToasts(selector, shown) {
  const text = el => String(el?.innerText ?? '').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return [...document.querySelectorAll(selector)].filter(shown).map(el => ({
    text: text(el.querySelector('.ui-toast__msg') ?? el),
    tone: /(?:^|\s)ui-toast--(\w+)/.exec(String(el.className))?.[1] ?? 'neutral',
    role: el.getAttribute('role'),
    action: text(el.querySelector('.ui-toast__action')) || null,
  }));
}

/** An expression calling an in-page reader with `selector` and the shared visibility test (no eval in the page). */
const withShown = (reader, selector) => `(${reader.toString()})(${JSON.stringify(selector)}, (${inPageShown.toString()})())`;

/** Selector of the dialogs dialogText() considers. */
export const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], dialog[open]';
/** Selector of the frame's toasts (src/ui/components/Toast.tsx: .ui-toast inside .ui-toast-stack). */
export const TOAST_SELECTOR = '.ui-toast';

/** A 0-based index among the visible matches; anything else is a usage error. */
export function checkNth(nth) {
  const value = Number(nth ?? 0);
  if (!Number.isInteger(value) || value < 0) throw new ToolError('usage', `--nth must be a whole number from 0: it is the 0-based index among the VISIBLE matches (0 = the first, 1 = the second); got ${JSON.stringify(nth)}.`);
  return value;
}

/** not_found with the reason: nothing visible matched, or --nth is past the visible matches (counted from 0). */
function notFound(target, last, timeoutMs) {
  const count = last?.count ?? 0, nth = last?.nth ?? 0;
  if (count > 0 && nth >= count) return new ToolError('not_found', `${target}: --nth ${nth} is out of range: ${count} visible match${count === 1 ? '' : 'es'}; --nth counts the visible matches from 0 (0 = the first, ${count - 1} = the last).`, { visibleMatches: count, nth });
  return new ToolError('not_found', `${target} was not found (visible) within ${timeoutMs} ms.`, { visibleMatches: count, nth });
}

/** Parses a wait/click target: `text=…` (visible text, aria-label or title), `text^=…` (contains), else CSS. */
export function parseTarget(target, extra = {}) {
  if (typeof target !== 'string' || !target) throw new ToolError('usage', 'A selector or text=… target is required.');
  if (target.startsWith('text=')) return { text: target.slice(5), exact: true, ...extra };
  if (target.startsWith('text^=')) return { text: target.slice(6), exact: false, ...extra };
  return { css: target, ...extra };
}

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────────────────────────
const NAMED_KEYS = {
  Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Esc: [27, 'Escape'], Tab: [9, 'Tab'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '], Insert: [45, 'Insert'],
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, [112 + i, `F${i + 1}`]])),
};
const MODIFIERS = { Alt: 1, Option: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
// macOS editing shortcuts are NSResponder commands, not key handlers: Chromium needs them named (Input.dispatchKeyEvent commands).
const MAC_COMMANDS = { 'Meta+a': ['selectAll'], 'Meta+c': ['copy'], 'Meta+v': ['paste'], 'Meta+x': ['cut'], 'Meta+z': ['undo'], 'Meta+Shift+z': ['redo'] };

/** "Shift+Tab", "Mod+A" (Meta on macOS, Control elsewhere), "Enter", "a" → a dispatchKeyEvent description. */
export function parseKeyCombo(combo, platform = process.platform) {
  const parts = String(combo).split('+').filter(Boolean);
  if (!parts.length) throw new ToolError('usage', 'key needs a key such as Enter, Escape, Shift+Tab or Mod+A.');
  const keyName = parts.pop();
  let modifiers = 0; const names = [];
  for (const raw of parts) {
    const name = raw === 'Mod' ? (platform === 'darwin' ? 'Meta' : 'Control') : raw;
    if (!(name in MODIFIERS)) throw new ToolError('usage', `Unknown modifier ${raw} in ${combo}.`);
    modifiers |= MODIFIERS[name]; names.push({ Option: 'Alt', Ctrl: 'Control', Cmd: 'Meta', Command: 'Meta' }[name] ?? name);
  }
  let key, code, keyCode, text;
  if (NAMED_KEYS[keyName]) {
    [keyCode, code, text] = NAMED_KEYS[keyName];
    key = code === 'Space' ? ' ' : code;
  } else if (keyName.length === 1) {
    const lower = keyName.toLowerCase();
    key = modifiers & 8 ? keyName.toUpperCase() : keyName;
    if (/[a-z]/.test(lower)) { code = `Key${lower.toUpperCase()}`; keyCode = lower.toUpperCase().charCodeAt(0); }
    else if (/[0-9]/.test(lower)) { code = `Digit${lower}`; keyCode = lower.charCodeAt(0); }
    else { code = ''; keyCode = keyName.charCodeAt(0); }
    text = key;
  } else throw new ToolError('usage', `Unknown key ${keyName} in ${combo}.`);
  // A key with Control/Meta types no text.
  if (modifiers & (2 | 4)) text = undefined;
  const commandKey = [...names.filter(name => name === 'Meta'), ...names.filter(name => name === 'Shift'), keyName.toLowerCase()].join('+');
  const commands = platform === 'darwin' ? MAC_COMMANDS[commandKey] : undefined;
  return { key, code, keyCode, text, modifiers, ...(commands ? { commands } : {}) };
}

// ── Page ────────────────────────────────────────────────────────────────────────────────────────────────────────
const NAV_LABELS = { library: ['素材库', 'Library'], canvas: ['画布', 'Canvas'], queue: ['队列', 'Queue'] };
const SETTINGS_LABELS = ['设置', 'Settings'];

/**
 * A text from the window without the invisible structure suffix host errors carry there (src/host-errors/bridge.ts):
 * the client's own stripHostErrorSuffixes from the build (dist-electron), so the rule is the same; before a build, the
 * same mark-and-digits pattern here.
 */
let stripSuffixes;
export function stripWindowErrorSuffix(text) {
  if (typeof text !== 'string') return text;
  if (!stripSuffixes) {
    try { stripSuffixes = clientRequire(path.join(clientDir, 'dist-electron', 'src', 'host-errors', 'bridge.js')).stripHostErrorSuffixes; }
    catch { stripSuffixes = value => value.replace(/\u2063\u2064\u2063[\u200b\u200c\u200d\u2060]*/g, ''); }
  }
  return stripSuffixes(text);
}
/** A value from the window with every string in it stripped of host error suffixes (plain JSON values only). */
export function stripWindowErrorSuffixes(value, depth = 0) {
  if (typeof value === 'string') return stripWindowErrorSuffix(value);
  if (!value || typeof value !== 'object' || depth > 32) return value;
  if (Array.isArray(value)) return value.map(item => stripWindowErrorSuffixes(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripWindowErrorSuffixes(item, depth + 1)]));
}

/** The test client's main window, driven through DevTools. */
export class Page {
  constructor(connection, { port, target }) { this.cdp = connection; this.port = port; this.target = target; this.console = null; }

  close() { this.cdp.close(); }

  /** Evaluates an expression or a function (called with JSON-serializable args) in the window; returns its value. */
  async evaluate(source, ...args) {
    const expression = typeof source === 'function' ? `(${source.toString()})(...${JSON.stringify(args)})` : String(source);
    const { result, exceptionDetails } = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (exceptionDetails) throw new ToolError('evaluate_failed', stripWindowErrorSuffix(exceptionDetails.exception?.description ?? exceptionDetails.text ?? 'Evaluation failed.'));
    return result?.value;
  }

  async waitForLoad({ timeoutMs = 30_000 } = {}) {
    const ok = await pollUntil(() => this.evaluate(() => document.readyState === 'complete' && Boolean(document.getElementById('root')?.children.length)).catch(() => false), { timeoutMs, intervalMs: 200 });
    if (!ok) throw new ToolError('load_timeout', `The window did not finish loading within ${timeoutMs} ms.`);
  }

  resolve(spec) { return this.evaluate(inPageResolve, spec); }

  /**
   * Waits for a target to be visible (state "visible"), present ("attached") or gone ("hidden"). `nth` is the 0-based
   * index among the matches (visible ones; all of them for "attached").
   */
  async wait(target, { timeoutMs = 10_000, state = 'visible', nth = 0 } = {}) {
    const spec = parseTarget(target, { nth: checkNth(nth), state });
    const started = Date.now();
    let last = null;
    const result = await pollUntil(async () => {
      const info = await this.resolve(spec).catch(() => null);
      if (!info) return null;
      last = info;
      if (state === 'hidden') return info.element ? null : { ...info, ok: true };
      return info.element ? { ...info, ok: true } : null;
    }, { timeoutMs, intervalMs: 100 });
    if (!result) {
      const outOfRange = state !== 'hidden' && last?.count > 0 && last.nth >= last.count;
      throw new ToolError('wait_timeout', outOfRange ? `${target} did not become ${state} within ${timeoutMs} ms: --nth ${last.nth} is out of range (${last.count} match${last.count === 1 ? '' : 'es'}, counted from 0).` : `${target} did not become ${state} within ${timeoutMs} ms.`, last ? { matches: last.count, nth: last.nth } : undefined);
    }
    return { ...result, elapsedMs: Date.now() - started };
  }

  async mouse(type, x, y, { button = 'left', clickCount = 1, modifiers = 0, buttons } = {}) {
    await this.cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount: type === 'mouseMoved' ? 0 : clickCount, modifiers, buttons: buttons ?? (type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0) });
  }

  /**
   * A real pointer click on a target: scrolled into view, refused when another element covers its centre (obscured)
   * or it is disabled, unless `force`. Waits up to `timeoutMs` for the target to appear.
   */
  async click(target, { timeoutMs = 10_000, nth = 0, force = false, button = 'left', clickCount = 1, modifiers = 0, spec: given } = {}) {
    const spec = given ? { ...given, nth: checkNth(given.nth) } : parseTarget(target, { nth: checkNth(nth) });
    let last = null;
    const info = await pollUntil(() => this.resolve({ ...spec, scroll: true, mark: true }).then(value => { last = value ?? last; return value?.element ? value : null; }).catch(() => null), { timeoutMs, intervalMs: 100 });
    if (!info) throw notFound(target, last, timeoutMs);
    if (!force && info.disabled) throw new ToolError('disabled', `${target} is disabled.`, info);
    if (!force && !info.hitOk) throw new ToolError('obscured', `${target} is covered at its centre by ${JSON.stringify(info.hit)}.`, info);
    const { x, y } = info.point;
    await this.mouse('mouseMoved', x, y, { modifiers });
    for (let count = 1; count <= clickCount; count++) {
      await this.mouse('mousePressed', x, y, { button, clickCount: count, modifiers });
      await this.mouse('mouseReleased', x, y, { button, clickCount: count, modifiers });
    }
    return { ok: true, target, element: info.element, point: info.point, matches: info.count, nth: info.nth };
  }

  clickText(text, options = {}) {
    return this.click(`text=${text}`, { ...options, spec: { text, exact: options.exact ?? false, nth: options.nth ?? 0, within: options.within } });
  }

  async hover(target, { timeoutMs = 10_000, nth = 0 } = {}) {
    let last = null;
    const info = await pollUntil(() => this.resolve({ ...parseTarget(target, { nth: checkNth(nth) }), scroll: true }).then(value => { last = value ?? last; return value?.element ? value : null; }).catch(() => null), { timeoutMs });
    if (!info) throw notFound(target, last, timeoutMs);
    await this.mouse('mouseMoved', info.point.x, info.point.y);
    return { ok: true, target, element: info.element, point: info.point, matches: info.count, nth: info.nth };
  }

  /**
   * Clicks a field (real focus) and inserts the text. `replace` first selects the whole content with the real
   * keyboard shortcut (Meta+A on macOS, Control+A elsewhere) so the typed text replaces it; `clear` selects all and
   * presses Backspace first. Both refuse with not_selected when the shortcut did not select the whole field. The
   * result reads the field's value back.
   */
  async type(target, text, { clear = false, replace = false, timeoutMs = 10_000, nth = 0, perKey = false } = {}) {
    if (clear && replace) throw new ToolError('usage', 'type takes --clear or --replace, not both.');
    const clicked = await this.click(target, { timeoutMs, nth });
    const focus = await this.evaluate(inPageFocusInfo);
    if (!focus.focusInTarget) throw new ToolError('not_focused', `Clicking ${target} did not move the keyboard focus into it (focus is on ${JSON.stringify(focus.focused)}).`, focus);
    let selection = null;
    if (clear || replace) {
      await this.key('Mod+a');
      selection = await this.evaluate(inPageSelectionInfo);
      if (selection.all === false) throw new ToolError('not_selected', `${process.platform === 'darwin' ? 'Meta+A' : 'Control+A'} did not select the whole content of ${target}; nothing was typed.`, selection);
      if (clear) await this.key('Backspace');
    }
    if (perKey) for (const char of String(text)) await this.key(char === ' ' ? 'Space' : char === '\n' ? 'Enter' : char);
    else await this.cdp.send('Input.insertText', { text: String(text) });
    const after = await this.evaluate(inPageFieldValue);
    return { ok: true, target, element: clicked.element, mode: replace ? 'replace' : clear ? 'clear' : 'insert', typed: String(text).length, ...(selection ? { replacedLength: selection.length ?? null } : {}), value: after.value, valueLength: after.length };
  }

  /**
   * The visible, top-most dialog (see inPageDialogs): label, modal, text (lines), buttons and rect, plus short
   * descriptions of the other visible ones. Waits up to `timeoutMs` for one; refuses with no_dialog otherwise.
   */
  async dialogText({ timeoutMs = 10_000, selector = DIALOG_SELECTOR } = {}) {
    const started = Date.now();
    let last = null;
    const found = await pollUntil(async () => {
      last = await this.evaluate(withShown(inPageDialogs, selector)).catch(() => last);
      return last?.onTop?.length ? last : null;
    }, { timeoutMs, intervalMs: 100 });
    if (!found) throw new ToolError('no_dialog', `No visible top-most dialog within ${timeoutMs} ms (${last?.total ?? 0} dialog element(s), ${last?.visible ?? 0} visible, none on top).`, last ? { total: last.total, visible: last.visible, covered: last.covered } : undefined);
    const [dialog, ...others] = found.onTop;
    return { ok: true, dialog, others, covered: found.covered, counts: { total: found.total, visible: found.visible, onTop: found.onTop.length }, elapsedMs: Date.now() - started };
  }

  /**
   * The toasts shown now, oldest first ({text, tone, role, action}). With `timeoutMs` > 0 waits up to that long for
   * one (whose text contains `contains`, when given) and refuses with no_toast otherwise.
   */
  async toasts({ timeoutMs = 0, contains, selector = TOAST_SELECTOR } = {}) {
    const started = Date.now();
    const wanted = contains === undefined ? null : String(contains);
    const read = () => this.evaluate(withShown(inPageToasts, selector));
    const ready = list => wanted === null ? list.length > 0 : list.some(toast => toast.text.includes(wanted));
    let list = await read();
    if (timeoutMs > 0 || wanted !== null) {
      const found = await pollUntil(async () => { list = await read().catch(() => list); return ready(list) ? list : null; }, { timeoutMs, intervalMs: 100 });
      if (!found) throw new ToolError('no_toast', wanted === null ? `No toast appeared within ${timeoutMs} ms.` : `No toast containing "${wanted}" appeared within ${timeoutMs} ms.`, { toasts: list });
    }
    return { ok: true, count: list.length, toasts: list, ...(wanted !== null ? { matched: list.filter(toast => toast.text.includes(wanted)).length } : {}), elapsedMs: Date.now() - started };
  }

  async key(combo, { repeat = 1 } = {}) {
    const key = parseKeyCombo(combo);
    for (let index = 0; index < repeat; index++) {
      const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode, modifiers: key.modifiers };
      await this.cdp.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...base, ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}), ...(key.commands ? { commands: key.commands } : {}) });
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
    return { ok: true, key: combo };
  }

  /** Mouse-wheel scrolling over a target; `toEnd` keeps scrolling until the scroll container stops moving. */
  async scroll(target, { deltaY = 600, toEnd = false, maxSteps = 2000, settleMs = 60, timeoutMs = 120_000 } = {}) {
    const info = await this.resolve({ ...parseTarget(target), mark: true });
    if (!info?.element) throw new ToolError('not_found', `${target} was not found.`);
    const { x, y } = info.point;
    const position = () => this.evaluate(() => {
      let el = window.__devToolsTarget;
      while (el && el !== document.documentElement && !(el.scrollHeight > el.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(el).overflowY))) el = el.parentElement;
      el ??= document.scrollingElement;
      return { top: Math.round(el.scrollTop), height: el.scrollHeight, client: el.clientHeight };
    });
    const started = Date.now();
    let steps = 0, last = await position(), unchanged = 0;
    do {
      await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, modifiers: 0 });
      steps++;
      await sleep(settleMs);
      const now = await position();
      unchanged = now.top === last.top && now.height === last.height ? unchanged + 1 : 0;
      last = now;
      if (!toEnd) break;
    } while (steps < maxSteps && unchanged < 8 && Date.now() - started < timeoutMs);
    return { ok: true, steps, elapsedMs: Date.now() - started, position: last, atEnd: last.top + last.client >= last.height - 2 };
  }

  async screenshot(file) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, { timeoutMs: 60_000 });
    const target = path.resolve(file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(data, 'base64'));
    return { ok: true, file: target, bytes: Buffer.byteLength(data, 'base64') };
  }

  /**
   * Starts collecting console messages, uncaught exceptions and browser log entries. Runtime.enable/Log.enable also
   * replay what the window logged before this connection (V8 keeps the recent console messages and exceptions).
   */
  async captureConsole() {
    if (this.console) return this.console;
    const entries = [];
    this.console = entries;
    this.cdp.on('Runtime.consoleAPICalled', event => entries.push({ source: 'console', level: event.type, text: (event.args ?? []).map(arg => arg.value ?? arg.description ?? arg.type).join(' ').slice(0, 2000), url: event.stackTrace?.callFrames?.[0]?.url, time: event.timestamp }));
    this.cdp.on('Runtime.exceptionThrown', event => entries.push({ source: 'exception', level: 'error', text: String(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? '').slice(0, 4000), url: event.exceptionDetails?.url, line: event.exceptionDetails?.lineNumber, time: event.timestamp }));
    this.cdp.on('Log.entryAdded', ({ entry }) => entries.push({ source: `log:${entry.source}`, level: entry.level, text: String(entry.text ?? '').slice(0, 2000), url: entry.url, time: entry.timestamp }));
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Log.enable');
    return entries;
  }

  /** The collected entries; `errorsOnly` keeps errors and exceptions. */
  consoleEntries({ errorsOnly = false } = {}) {
    const entries = this.console ?? [];
    return errorsOnly ? entries.filter(entry => entry.level === 'error' || entry.source === 'exception') : [...entries];
  }

  /** Opens a page of the frame by clicking the top bar (there is no renderer routing hook) and checks it is current. */
  /** Moves the pointer off the top bar (to the window's lower left), so no hover tooltip of the bar stays open. */
  async moveMouseAway() {
    const point = await this.evaluate(() => ({ x: 8, y: Math.max(60, innerHeight - 8) }));
    await this.mouse('mouseMoved', point.x, point.y);
  }

  async route(name, { timeoutMs = 10_000, force = false } = {}) {
    if (name === 'settings') {
      const selector = SETTINGS_LABELS.map(label => `.as-topbar button[aria-label="${label}"]`).join(', ');
      await this.click(selector, { timeoutMs, force });
      await this.wait(`${SETTINGS_LABELS.map(label => `.as-topbar button[aria-label="${label}"][aria-pressed="true"]`).join(', ')}`, { timeoutMs });
      await this.moveMouseAway();
      return { ok: true, route: name };
    }
    const labels = NAV_LABELS[name];
    if (!labels) throw new ToolError('usage', 'route takes library, canvas, queue or settings.');
    const index = Object.keys(NAV_LABELS).indexOf(name);
    const clicked = await pollUntil(() => this.evaluate((labels, index) => {
      const items = [...document.querySelectorAll('.as-nav .as-nav-item')];
      const match = items.find(item => labels.some(label => (item.innerText || '').includes(label))) ?? items[index];
      if (!match) return null;
      window.__devToolsTarget = match;
      const rect = match.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 40), y = rect.top + rect.height / 2, hit = document.elementFromPoint(x, y);
      return { x, y, current: match.getAttribute('aria-current') === 'page', hitOk: Boolean(hit && match.contains(hit)), hit: hit ? `${hit.tagName.toLowerCase()}.${String(hit.className).slice(0, 60)}` : null };
    }, labels, index).catch(() => null), { timeoutMs });
    if (!clicked) throw new ToolError('not_found', 'The top bar navigation was not found.');
    if (!clicked.hitOk && !force) throw new ToolError('obscured', `The ${name} navigation item is covered by ${clicked.hit} (a dialog or overlay is open).`, clicked);
    await this.mouse('mouseMoved', clicked.x, clicked.y);
    await this.mouse('mousePressed', clicked.x, clicked.y);
    await this.mouse('mouseReleased', clicked.x, clicked.y);
    const ok = await pollUntil(() => this.evaluate(() => window.__devToolsTarget?.getAttribute('aria-current') === 'page'), { timeoutMs });
    if (!ok) throw new ToolError('route_failed', `The ${name} page did not become current.`);
    await this.moveMouseAway();
    return { ok: true, route: name };
  }

  /**
   * A real pointer click at fixed window coordinates (CSS pixels), whatever is there now: what a user's click does when
   * the page changes under the pointer. Reports the element hit (before the click) so a script can tell what it hit.
   */
  async clickAt(x, y, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
    const hit = await this.evaluate((x, y) => {
      const el = document.elementFromPoint(x, y), target = el?.closest('button, a, [role="button"], input, [tabindex]') ?? el;
      return target ? { tag: target.tagName.toLowerCase(), text: (target.textContent ?? '').trim().slice(0, 80), testid: target.getAttribute('data-testid'), disabled: Boolean(target.disabled) || target.getAttribute('aria-disabled') === 'true' } : null;
    }, x, y);
    await this.mouse('mouseMoved', x, y, { modifiers });
    for (let count = 1; count <= clickCount; count++) {
      await this.mouse('mousePressed', x, y, { button, clickCount: count, modifiers });
      await this.mouse('mouseReleased', x, y, { button, clickCount: count, modifiers });
    }
    return { ok: true, point: { x, y }, hit };
  }

  /** Renderer performance counters (Performance.getMetrics) plus DOM counters. */
  async metrics() {
    await this.cdp.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => undefined);
    const { metrics } = await this.cdp.send('Performance.getMetrics');
    const values = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
    const dom = await this.cdp.send('Memory.getDOMCounters').catch(() => null);
    return { jsHeapUsedMiB: +(values.JSHeapUsedSize / 1048576).toFixed(1), jsHeapTotalMiB: +(values.JSHeapTotalSize / 1048576).toFixed(1), nodes: values.Nodes, documents: values.Documents, layoutCount: values.LayoutCount, recalcStyleCount: values.RecalcStyleCount, taskDurationS: values.TaskDuration, scriptDurationS: values.ScriptDuration, dom, raw: values };
  }

  /**
   * Resizes the real window. Electron's DevTools endpoint has no Browser.setWindowBounds, but its frameless main
   * window honours window.resizeTo; the OS may clamp the size to the screen's work area (the result says what it got).
   */
  async setWindowSize(width, height) {
    const viewport = await this.evaluate((width, height) => new Promise(resolve => {
      window.resizeTo(width, height);
      let tries = 0;
      const check = () => (innerWidth === width && innerHeight === height) || ++tries > 20 ? resolve({ width: innerWidth, height: innerHeight, outerWidth, outerHeight, devicePixelRatio, screen: { width: screen.availWidth, height: screen.availHeight } }) : setTimeout(check, 50);
      check();
    }), width, height);
    return { applied: viewport.width === width && viewport.height === height, requested: { width, height }, viewport };
  }
}

/**
 * Connects to the test client's main window on a DevTools port of 127.0.0.1. `emulateFocus` (default on) makes the
 * page behave as focused while this session lasts even when another app has the OS focus, so focus and keyboard
 * behaviour do not depend on which window happens to be frontmost.
 */
export async function connectPage({ port, timeoutMs = 10_000, emulateFocus = true } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) throw new ToolError('usage', 'A DevTools --port is required (the port given to test-client start).');
  const target = await pollUntil(async () => {
    try {
      const targets = await getJson(`http://${HOST}:${port}/json/list`);
      const pages = targets.filter(entry => entry.type === 'page' && entry.webSocketDebuggerUrl);
      return pages.find(entry => /^file:.*index\.html/.test(entry.url)) ?? pages[0] ?? null;
    } catch { return null; }
  }, { timeoutMs, intervalMs: 200 });
  if (!target) throw new ToolError('cdp_unavailable', `No window found on the DevTools port 127.0.0.1:${port}.`);
  const connection = await CdpConnection.open(target.webSocketDebuggerUrl, { timeoutMs });
  if (emulateFocus) await connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
  return new Page(connection, { port: Number(port), target });
}

/** The visible, top-most dialog of a connected page (Page#dialogText). */
export const dialogText = (page, options) => page.dialogText(options);
/** The toasts a connected page shows now, or waits for one (Page#toasts). */
export const toasts = (page, options) => page.toasts(options);
