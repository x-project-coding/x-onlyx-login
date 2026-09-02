// Boots the REAL app (src/main.js), paints the success screen on it, clicks its Close button the
// way a creator does, and reports whether the app ACTUALLY QUIT. A test fixture, never shipped.
//
// Why a probe and not an assertion in app.test.js: the close chain is four hand-offs in four
// files, and every one of them is invisible to a state-file test. ui.js renders a button whose
// handler calls `window.onlyx.close()`; preload.cjs turns that into `ipcRenderer.send('action',
// 'close')`; main.js maps that to `win.close()`; and `window-all-closed` is what turns a closed
// window into a quit — with an explicit comment that it must do so on macOS too, where Electron's
// default is to keep the app alive. Break any link and the creator is told "You can close this
// window", clicks, and is left with a dead window or a process still running in her dock.
//
// The success STATE is pushed in over the same channel main.js uses (`header.webContents.send(
// 'state', ...)`), rather than driven through a whole fake sign-in: what is under test here is the
// close chain, and app.test.js already owns the road to success.
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const report = process.env.ONLYX_CLOSE_REPORT;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const found = {
  windowCreated: false,
  headerFound: false,
  title: '',
  text: '',
  /** Every button the success screen offers, in order. */
  actions: [],
  buttonFound: false,
  clicked: false,
  /** Why the click did NOT happen, when the page was able to say so. Empty on the success path. */
  clickNote: '',
  /** Set from 'will-quit' — the app decided to end, which is the property under test. */
  quit: false,
  windowsAfterClose: null,
  note: '',
};

const write = () => {
  try {
    fs.writeFileSync(report, JSON.stringify(found, null, 2));
  } catch (err) {
    /* the test reads the file's absence as a failure */
  }
};

// Written synchronously here: once the app is quitting there is no later turn of the loop.
app.on('will-quit', () => {
  found.quit = true;
  found.windowsAfterClose = BrowserWindow.getAllWindows().length;
  write();
});

// Imported before 'ready' so main.js registers its whenReady handler exactly as in production.
const mainLoaded = import(pathToFileURL(path.join(__dirname, '..', '..', 'src', 'main.js')).href);

app.whenReady().then(async () => {
  await mainLoaded;

  // main.js creates the window and the header view in its own whenReady handler.
  let header = null;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !header) {
    found.windowCreated = BrowserWindow.getAllWindows().length > 0;
    header = webContents
      .getAllWebContents()
      .find((wc) => !wc.isDestroyed() && /ui[\\/]index\.html$/.test(new URL(wc.getURL() || 'about:blank').pathname));
    if (!header) await sleep(100);
  }
  if (!header) {
    found.note = 'the header view never loaded';
    write();
    return app.exit(0);
  }
  found.headerFound = true;

  // WAIT FOR MAIN'S OWN FIRST PAINT BEFORE PUSHING ANYTHING. main.js re-sends its current state on
  // the header's 'did-finish-load' (main.js:989), and a URL is set at navigation START — so a
  // success pushed the moment the URL appeared was overwritten by main's `idle` a beat later, and
  // this probe measured the waiting screen. Waiting for the idle title proves that re-send has
  // already happened.
  const idleBy = Date.now() + 15_000;
  while (Date.now() < idleBy) {
    const title = await header
      .executeJavaScript(`document.getElementById('full-title')?.textContent ?? ''`)
      .catch(() => '');
    if (title.trim()) break;
    await sleep(100);
  }

  // The success screen, over the same channel main.js uses. A state SENT is not a frame PAINTED,
  // so wait for the title the renderer actually put in the DOM.
  header.send('state', { phase: 'success', username: 'creatorx' });
  const painted = Date.now() + 10_000;
  while (Date.now() < painted) {
    const title = await header.executeJavaScript(`document.getElementById('full-title')?.textContent ?? ''`);
    if (/connected/i.test(title)) break;
    await sleep(100);
  }

  found.title = await header.executeJavaScript(`document.getElementById('full-title')?.textContent ?? ''`);
  found.text = await header.executeJavaScript(`document.getElementById('full-text')?.textContent ?? ''`);
  found.actions = await header.executeJavaScript(
    `Array.from(document.getElementById('full-actions').querySelectorAll('button')).map((b) => b.textContent)`,
  );

  // Found by its LABEL, not by position: a test that clicked `button:first-child` would keep
  // passing if the screen's only button became something else entirely. Read FIRST, and separately
  // from the click, because of the race below.
  found.buttonFound = await header.executeJavaScript(
    `Array.from(document.getElementById('full-actions').querySelectorAll('button'))
       .some((el) => /close/i.test(el.textContent))`,
  );

  // THE CLICK IS DISPATCHED, NOT AWAITED, AND THE FLAG IS CLAIMED BEFORE IT.
  //
  // A successful click destroys the frame that is running the expression — that is the whole point
  // of it — so `await header.executeJavaScript('...b.click()...')` can never resolve when the
  // chain WORKS. The first draft awaited it and recorded the result: standalone the reply
  // occasionally won the race and the test passed; inside the full suite the window went first and
  // the probe reported `clicked: false` about a click that had in fact worked perfectly. A flag
  // set after an await is invisible to whatever the await destroyed.
  //
  // WHAT KEEPS THE CLAIM FROM BEING A TAUTOLOGY. It was `found.clicked = true`, unconditionally,
  // which is a value that cannot be false and therefore an assertion that cannot fail. Two things
  // make it earn its place, neither of them an await: it is claimed only for a button this probe
  // actually FOUND, and the expression below is written so it cannot throw — every path returns a
  // string. Silence therefore means one thing only (the frame died, i.e. the click worked), while
  // ANY answer means the click did not happen, and takes the flag back down.
  found.clicked = found.buttonFound;
  write();
  void header
    .executeJavaScript(
      `(() => {
         try {
           const host = document.getElementById('full-actions');
           const b = host && Array.from(host.querySelectorAll('button'))
             .find((el) => /close/i.test(el.textContent));
           if (!b) return 'no button on the success screen matched /close/i';
           b.click();
           return '';
         } catch (err) {
           return 'dispatching the click threw: ' + ((err && err.message) || err);
         }
       })()`,
    )
    .then((answer) => {
      if (!answer) return; // '' — dispatched, and the frame simply outlived the expression
      found.clicked = false;
      found.clickNote = answer;
      write();
    })
    .catch(() => {
      /* the frame going away underneath is the SUCCESS case */
    });

  // If the app is still here after this, the chain is broken — say so rather than hanging until
  // the test's own timeout, which would report as an infrastructure failure instead of a defect.
  await sleep(6_000);
  found.note = 'the app was still running 6s after Close was clicked';
  found.windowsAfterClose = BrowserWindow.getAllWindows().length;
  write();
  app.exit(0);
});
