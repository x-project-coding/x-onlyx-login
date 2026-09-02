// Boots the REAL app (src/main.js) the way a creator does from the icon — no deep link — and
// writes what is actually on screen to ONLYX_NOLINK_REPORT. A test fixture, never shipped.
//
// Why this probe exists: every other e2e opens the app WITH a link, and the link path calls
// focusWindow() -> win.show(), so none of them can see a launch that never shows a window at all.
// This one imports the real entry before 'ready', lets it manage its own window, and only observes.
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const report = process.env.ONLYX_NOLINK_REPORT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Imported before 'ready' so main.js registers its whenReady handler exactly as in production.
const mainLoaded = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'main.js')).href);

app.whenReady().then(async () => {
  await mainLoaded;
  const found = {
    windowCreated: false,
    visible: false,
    visibleAfterMs: null,
    // Diagnostics for the failure this probe was written on: a window whose own webContents never
    // loads anything never fires 'ready-to-show', so a show deferred to that event never happens.
    readyToShowFired: false,
    windowOwnURL: null,
    mode: null,
    idleTitle: '',
    idleText: '',
  };

  const started = Date.now();
  const deadline = started + 10_000;
  let win = null;
  while (Date.now() < deadline && !(win = BrowserWindow.getAllWindows()[0] ?? null)) await sleep(50);

  if (win) {
    found.windowCreated = true;
    win.once('ready-to-show', () => {
      found.readyToShowFired = true;
    });
    // The fixed app is visible within a poll or two; the broken one never becomes visible, and this
    // loop running to its deadline is the creator staring at nothing.
    while (Date.now() < deadline) {
      if (win.isVisible()) {
        found.visible = true;
        found.visibleAfterMs = Date.now() - started;
        break;
      }
      await sleep(100);
    }
    found.windowOwnURL = win.webContents.getURL();

    // What the idle screen actually rendered, read from the header view's page. The view is found
    // by URL and polled on its own budget: a fixed app is visible BEFORE the header's loadFile has
    // committed, so a single look right after the visibility check sees no header at all — and the
    // page can equally be fully rendered while the window is invisible, the bug shape to record.
    const pageDeadline = Date.now() + 10_000;
    while (Date.now() < pageDeadline) {
      const header = webContents.getAllWebContents().find((wc) => wc.getURL().includes('/ui/index.html'));
      if (header && !header.isLoading()) {
        try {
          const page = await header.executeJavaScript(`({
            mode: document.body.dataset.mode,
            title: document.getElementById('full-title')?.textContent ?? '',
            text: document.getElementById('full-text')?.textContent ?? '',
          })`);
          found.mode = page.mode;
          found.idleTitle = page.title;
          found.idleText = page.text;
          if (found.idleTitle) break;
        } catch (err) {
          found.pageError = String(err?.message ?? err).slice(0, 200);
        }
      }
      await sleep(100);
    }
  }

  fs.writeFileSync(report, JSON.stringify(found, null, 2));
  app.quit();
});
