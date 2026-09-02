// Loads src/ui/index.html exactly as the app does (a WebContentsView on a file:// URL with the real
// preload) and writes what it found to ONLYX_BRAND_REPORT. A test fixture, never shipped.
const { app, BrowserWindow, WebContentsView, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const report = process.env.ONLYX_BRAND_REPORT;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  // ONLYX_UI_PATH lets the same probe check a PACKAGED app's asar, which is what actually ships.
  const uiPath = process.env.ONLYX_UI_PATH || path.join(__dirname, '..', '..', 'src', 'ui', 'index.html');
  await view.webContents.loadFile(uiPath);

  // The state the app sends on idle, so the mark is on screen when we look.
  view.webContents.send('state', { phase: 'idle' });

  const found = await view.webContents.executeJavaScript(`
    (async () => {
      await document.fonts.ready;
      const cs = getComputedStyle(document.body);
      const mark = document.querySelector('.mark');
      return {
        fontLoaded: document.fonts.check('16px "Public Sans"'),
        bodyFont: cs.fontFamily,
        brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim(),
        hasMark: !!mark && getComputedStyle(mark).boxShadow !== 'none',
        title: document.title,
      };
    })()
  `);
  fs.writeFileSync(report, JSON.stringify(found, null, 2));
  app.quit();
});
