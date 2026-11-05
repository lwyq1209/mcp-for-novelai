#!/usr/bin/env node
// Drives the test client's window through DevTools (real mouse/keyboard events). Every command takes --port <cdp>.
//   node dev-tools/ui.mjs eval --port <p> '<js expression>'          value of the expression (promises awaited)
//   node dev-tools/ui.mjs click --port <p> '<css>|text=…' [--nth n] [--force] [--double] [--right] [--modifiers Shift,Meta]
//   node dev-tools/ui.mjs click-text --port <p> '<text>' [--exact] [--within '<css>'] [--nth n]
//   node dev-tools/ui.mjs click-at --port <p> <x> <y> [--double] [--right]   a real click at fixed window coordinates
//        (CSS pixels), whatever is there at that moment; reports the element hit
//   node dev-tools/ui.mjs hover --port <p> '<css>|text=…' [--nth n]
//   node dev-tools/ui.mjs type --port <p> '<css>' '<text>' [--replace | --clear] [--per-key] [--nth n]
//        --replace: select all with the real shortcut (Meta+A on macOS, Control+A elsewhere), then type over it
//        --clear:   select all + Backspace, then type;   neither: insert at the caret
//   node dev-tools/ui.mjs key --port <p> <combo> [--repeat n]          Enter, Escape, Shift+Tab, Mod+A, ArrowDown …
//   node dev-tools/ui.mjs wait --port <p> '<css>|text=…|text^=…' [--timeout s] [--state visible|attached|hidden] [--nth n]
//   node dev-tools/ui.mjs dialog-text --port <p> [--timeout s]       text of the VISIBLE, TOP-MOST dialog (waits; default 10 s)
//   node dev-tools/ui.mjs toasts --port <p> [--timeout s] [--contains '<text>']   toasts shown now (or wait for one)
//   node dev-tools/ui.mjs scroll --port <p> '<css>' [--delta 600] [--to-end]
//   node dev-tools/ui.mjs shot --port <p> <file.png>
//   node dev-tools/ui.mjs console --port <p> [--errors] [--wait ms]   messages/exceptions so far (replayed) + during wait
//   node dev-tools/ui.mjs route --port <p> library|canvas|queue|settings   (then moves the pointer off the top bar)
//   node dev-tools/ui.mjs metrics --port <p>                          renderer heap, DOM nodes, layout counts
//   node dev-tools/ui.mjs size --port <p> 1440x900                    resize the window (clamped by the screen)
//   node dev-tools/ui.mjs --help                                      this text
// --nth n is a 0-BASED index among the VISIBLE matches: --nth 0 (the default) is the first visible match, --nth 1
// the second. Hidden matches are not counted (for wait --state attached all matches are). Out of range → not_found
// with the number of visible matches. --timeout is in seconds (default 10).
import { ToolError, allowOptions, helpRequested, isMain, parseArgs, printUsage, runCli, sleep } from './lib/cli.mjs';
import { checkNth, connectPage, dialogText, stripWindowErrorSuffixes, toasts } from './lib/cdp.mjs';
import { withFrontWatch } from './lib/front-watch.mjs';

export { connectPage, dialogText, toasts };

const MODIFIER_BITS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
function modifierBits(value) {
  if (!value) return 0;
  return String(value).split(',').filter(Boolean).reduce((bits, name) => {
    const key = name === 'Mod' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : name;
    if (!(key in MODIFIER_BITS)) throw new ToolError('usage', `Unknown modifier ${name}.`);
    return bits | MODIFIER_BITS[key];
  }, 0);
}

function seconds(value, fallbackMs) {
  if (value === undefined) return fallbackMs;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new ToolError('usage', '--timeout is a number of seconds (0 or more).');
  return number * 1000;
}

// Every command runs under the front-app watcher (macOS): a test client in front fails it with front_detected.
async function main(argv) {
  if (helpRequested(argv)) return printUsage(import.meta.url);
  return withFrontWatch(`ui.mjs ${argv[0] ?? ''}`.trim(), () => command(argv));
}
async function command(argv) {
  const { positional, options } = parseArgs(argv, { booleans: ['force', 'double', 'right', 'exact', 'clear', 'replace', 'per-key', 'errors', 'to-end'] });
  const [command, ...rest] = positional;
  const common = ['port', 'timeout'];
  const timeoutMs = seconds(options.timeout, 10_000);
  const nth = checkNth(options.nth ?? 0);
  const page = await connectPage({ port: Number(options.port), timeoutMs: 10_000 });
  try {
    switch (command) {
      case 'eval': allowOptions(options, common); if (!rest[0]) throw new ToolError('usage', 'eval needs a JavaScript expression.'); return { ok: true, value: stripWindowErrorSuffixes(await page.evaluate(rest[0])) };
      case 'click': allowOptions(options, [...common, 'nth', 'force', 'double', 'right', 'modifiers']);
        return await page.click(rest[0], { timeoutMs, nth, force: options.force === true, clickCount: options.double ? 2 : 1, button: options.right ? 'right' : 'left', modifiers: modifierBits(options.modifiers) });
      case 'click-text': allowOptions(options, [...common, 'nth', 'force', 'exact', 'within', 'double', 'modifiers']);
        if (!rest[0]) throw new ToolError('usage', 'click-text needs the text.');
        return await page.clickText(rest[0], { timeoutMs, nth, force: options.force === true, exact: options.exact === true, within: options.within, clickCount: options.double ? 2 : 1, modifiers: modifierBits(options.modifiers) });
      case 'click-at': {
        allowOptions(options, [...common, 'double', 'right']);
        const x = Number(rest[0]), y = Number(rest[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ToolError('usage', 'click-at needs x and y (CSS pixels of the window).');
        return await page.clickAt(x, y, { clickCount: options.double ? 2 : 1, button: options.right ? 'right' : 'left' });
      }
      case 'hover': allowOptions(options, [...common, 'nth']); return await page.hover(rest[0], { timeoutMs, nth });
      case 'type': allowOptions(options, [...common, 'nth', 'clear', 'replace', 'per-key']);
        if (rest.length < 2) throw new ToolError('usage', 'type needs a selector and the text.');
        return await page.type(rest[0], rest[1], { timeoutMs, nth, clear: options.clear === true, replace: options.replace === true, perKey: options['per-key'] === true });
      case 'key': allowOptions(options, [...common, 'repeat']); if (!rest[0]) throw new ToolError('usage', 'key needs a key combo.'); return await page.key(rest[0], { repeat: Number(options.repeat ?? 1) });
      case 'wait': allowOptions(options, [...common, 'state', 'nth']); return { ...(await page.wait(rest[0], { timeoutMs, state: options.state ?? 'visible', nth })), ok: true };
      case 'dialog-text': allowOptions(options, common); return await page.dialogText({ timeoutMs });
      case 'toasts': {
        allowOptions(options, [...common, 'contains']);
        if (options.contains === true) throw new ToolError('usage', '--contains needs the text.');
        // Without --timeout/--contains: the toasts shown right now. --contains alone waits up to 10 s.
        const wait = options.timeout !== undefined ? timeoutMs : options.contains !== undefined ? 10_000 : 0;
        return await page.toasts({ timeoutMs: wait, contains: options.contains });
      }
      case 'scroll': allowOptions(options, [...common, 'delta', 'to-end']); return await page.scroll(rest[0], { deltaY: Number(options.delta ?? 600), toEnd: options['to-end'] === true, timeoutMs: options.timeout === undefined ? 120_000 : timeoutMs });
      case 'shot': allowOptions(options, common); if (!rest[0]) throw new ToolError('usage', 'shot needs an output .png path.'); return await page.screenshot(rest[0]);
      case 'console': {
        allowOptions(options, [...common, 'errors', 'wait']);
        await page.captureConsole();
        await sleep(Number(options.wait ?? 300));
        const entries = page.consoleEntries({ errorsOnly: options.errors === true });
        return { ok: true, count: entries.length, entries };
      }
      case 'route': allowOptions(options, [...common, 'force']); return await page.route(rest[0], { timeoutMs, force: options.force === true });
      case 'metrics': allowOptions(options, common); return { ok: true, ...(await page.metrics()) };
      case 'size': {
        allowOptions(options, common);
        const match = /^(\d+)x(\d+)$/.exec(rest[0] ?? '');
        if (!match) throw new ToolError('usage', 'size needs WIDTHxHEIGHT.');
        return { ok: true, ...(await page.setWindowSize(Number(match[1]), Number(match[2]))) };
      }
      default: throw new ToolError('usage', 'Usage: ui.mjs eval|click|click-text|click-at|hover|type|key|wait|dialog-text|toasts|scroll|shot|console|route|metrics|size --port <cdp> … (ui.mjs --help).');
    }
  } finally { page.close(); }
}

if (isMain(import.meta.url)) await runCli(main);
