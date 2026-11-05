// A hidden Electron window (tests/fixtures/window-host.cjs) driven through the same DevTools driver as the test
// client, for the ui/cdp tests: real layout, hit testing, focus and keyboard events, without a client or app data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pollUntil, sleep } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { backgroundElectronExecutable } from '../lib/background-app.mjs';
import { freePort } from '../test-client.mjs';
import { TEMP_PREFIX, devToolsDir, makeTempDir, removeTempDir } from './helpers.mjs';

const HOST = path.join(devToolsDir, 'tests', 'fixtures', 'window-host.cjs');
const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>dev-tools fixture</title><style>body{margin:0;font:14px sans-serif}</style></head><body><div id="root"><p>fixture</p></div></body></html>';

/** Starts the hidden window; returns {page, port, close()} or {skip: reason} when Electron cannot start here. */
export async function openFixtureWindow() {
  const dir = makeTempDir(`${TEMP_PREFIX}window-`);
  fs.writeFileSync(path.join(dir, 'index.html'), PAGE);
  const port = await freePort();
  const env = { ...process.env, NAI_DEVTOOLS_FIXTURE_DIR: dir, NAI_DEVTOOLS_FIXTURE_PARENT: String(process.pid) };
  delete env.ELECTRON_RUN_AS_NODE;
  let stderr = '';
  // The agent copy of Electron on macOS (LSUIElement=1): launching it never makes it the active app (review rework 2).
  const child = spawn(backgroundElectronExecutable(), [HOST, '--use-mock-keychain', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-4000); });
  let exited = false;
  child.once('exit', () => { exited = true; });
  const close = async (page) => {
    page?.close();
    if (!exited) {
      child.kill('SIGTERM');
      if (!await pollUntil(() => exited, { timeoutMs: 10_000, intervalMs: 50 })) { child.kill('SIGKILL'); await pollUntil(() => exited, { timeoutMs: 5_000, intervalMs: 50 }); }
    }
    await sleep(50);
    removeTempDir(dir);
  };
  try {
    const page = await connectPage({ port, timeoutMs: 20_000 });
    await page.waitForLoad({ timeoutMs: 20_000 });
    return { page, port, close: () => close(page) };
  } catch (error) {
    await close(null);
    return { skip: `the fixture window did not start (${error.message}) ${stderr.slice(-400)}` };
  }
}

/** Replaces the fixture page's body content (and clears what earlier tests left on window). */
export function setBody(page, html) {
  return page.evaluate(html => {
    document.getElementById('root').innerHTML = html;
    for (const key of Object.keys(window).filter(key => key.startsWith('__test'))) delete window[key];
    return true;
  }, html);
}
