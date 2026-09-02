// Measures the full-screen card's geometry in every icon state the renderer can paint, and writes
// the numbers to ONLYX_LAYOUT_REPORT (plus a PNG per state to ONLYX_LAYOUT_SHOTS, when set, so a
// human can look at what shipped). A test fixture, never shipped.
//
// Why geometry and not content: v1.0.1's idle screen had every string right and the OnlyX ring
// hard against the card's LEFT edge — ui.js swaps the icon element's whole className per state,
// and the idle `mark lg` had dropped `.icon`, the class the centring margin lived on. Content
// probes cannot see that; only a rect can.
const { app, BrowserWindow, WebContentsView } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const report = process.env.ONLYX_LAYOUT_REPORT;
const shots = process.env.ONLYX_LAYOUT_SHOTS;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One scenario per className the renderer can set on #full-icon: the idle mark, one spinner state
// (opening/captured/verifying/update-downloading share `icon spin`), success `icon ok`, error
// `icon bad`, and the help panel's bare `icon`. `wants` is how we know the state actually rendered
// before measuring — a message sent is not a frame painted.
const SCENARIOS = [
  { name: 'idle', state: { phase: 'idle' }, wants: /waiting/i },
  { name: 'opening', state: { phase: 'opening' }, wants: /opening/i },
  { name: 'success', state: { phase: 'success', username: 'demo' }, wants: /connected/i },
  { name: 'error', state: { phase: 'error', title: 'Something went wrong', detail: 'A test detail.' }, wants: /wrong/i },
  // Help is opened through the menu channel and stays open across renders — so it goes LAST.
  { name: 'help', help: true, wants: /^help$/i },
];

const MEASURE = `
  (() => {
    const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom }; };
    const icon = document.getElementById('full-icon');
    const card = document.querySelector('#full .card');
    const title = document.getElementById('full-title');
    const full = document.getElementById('full');
    const back = [...document.querySelectorAll('#full-actions button')].at(-1) ?? null;
    return {
      title: title.textContent,
      iconClass: icon.className,
      iconHidden: icon.hidden,
      icon: rect(icon),
      card: rect(card),
      // offset* is the LAYOUT box: the spinner is mid-rotation when measured, and rotation inflates
      // its client rect (a 64px square reads up to ~90px wide), so rect edges cannot carry asserts
      // for it. Neither element has a positioned ancestor, so both offsets share body's origin.
      iconOffsetWidth: icon.offsetWidth,
      iconLayoutBottom: icon.offsetTop + icon.offsetHeight,
      titleOffsetTop: title.offsetTop,
      fullScrollHeight: full.scrollHeight,
      fullClientHeight: full.clientHeight,
      innerHeight: window.innerHeight,
      // Where the last button ends once the panel is scrolled as far down as it goes: a panel that
      // CLIPS instead of scrolling leaves this below the viewport — a Back button nobody can press.
      backBottomScrolled: back ? (full.scrollTop = full.scrollHeight, back.getBoundingClientRect().bottom) : null,
    };
  })()
`;

app.whenReady().then(async () => {
  // Shown, unlike the branding probe's window: capturePage needs frames actually composited.
  const win = new BrowserWindow({ width: 900, height: 700, show: true });
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  const uiPath = process.env.ONLYX_UI_PATH || path.join(__dirname, '..', '..', 'src', 'ui', 'index.html');
  await view.webContents.loadFile(uiPath);

  const settle = () => view.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  const renderAndMeasure = async (scenario) => {
    if (scenario.help) view.webContents.send('help');
    else view.webContents.send('state', scenario.state);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const title = await view.webContents.executeJavaScript(`document.getElementById('full-title').textContent`);
      if (scenario.wants.test(title)) break;
      if (Date.now() > deadline) throw new Error(`${scenario.name} never rendered; title is "${title}"`);
      await sleep(50);
    }
    await settle();
    const found = await view.webContents.executeJavaScript(MEASURE);
    if (shots) {
      const image = await view.webContents.capturePage();
      fs.writeFileSync(path.join(shots, `${scenario.name}-${found.innerHeight}.png`), image.toPNG());
    }
    return found;
  };

  const out = { at900x700: {}, at720x500: {} };
  for (const s of SCENARIOS) out.at900x700[s.name] = await renderAndMeasure(s);

  // Again at the smallest window the app permits (720x520 outer; the content is a little shorter).
  // The idle screen must FIT there, and the help panel — which is legitimately taller — must
  // scroll rather than clip: #full used to flex-centre a too-tall card under body's
  // overflow:hidden, which hides the overflow at BOTH edges and puts Back out of reach.
  view.setBounds({ x: 0, y: 0, width: 720, height: 500 });
  win.setContentSize(720, 500);
  await settle();
  out.at720x500.help = await renderAndMeasure(SCENARIOS.at(-1));
  // Leaving help needs a click on Back — the probe reaches the handler directly instead.
  await view.webContents.executeJavaScript(`[...document.querySelectorAll('#full-actions button')].at(-1).click()`);
  out.at720x500.idle = await renderAndMeasure(SCENARIOS[0]);

  fs.writeFileSync(report, JSON.stringify(out, null, 2));
  app.quit();
});
