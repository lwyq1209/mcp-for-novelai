// A hidden Electron window for the DevTools-driver tests (tests/window.mjs): no client, no app data, no keychain
// (--use-mock-keychain is on the command line). Every Electron path points into the test's temp folder; the window
// loads that folder's index.html and the process quits when the test process that started it is gone.
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const dir = process.env.NAI_DEVTOOLS_FIXTURE_DIR;
const parent = Number(process.env.NAI_DEVTOOLS_FIXTURE_PARENT);
if (!dir || !path.isAbsolute(dir)) { console.error('NAI_DEVTOOLS_FIXTURE_DIR (absolute) is required.'); process.exit(2); }
const userData = path.join(dir, 'electron-user-data');
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('crashDumps', path.join(dir, 'electron-crash-dumps'));
app.setPath('logs', path.join(dir, 'electron-logs'));
app.dock?.hide();

setInterval(() => { try { process.kill(parent, 0); } catch { app.exit(0); } }, 1000).unref();

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1000, height: 760, show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  window.loadFile(path.join(dir, 'index.html'));
});
app.on('window-all-closed', () => app.quit());
