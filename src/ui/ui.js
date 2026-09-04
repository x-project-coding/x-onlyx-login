// Renders the app's state. Everything the creator sees while NOT looking at OnlyFans is here.
(() => {
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  let current = { phase: 'idle' };
  let clockTimer = null;

  const button = (label, onClick, primary) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    if (primary) el.className = 'primary';
    el.addEventListener('click', onClick);
    return el;
  };

  const renderFull = ({ icon, title, text, detail, actions, fine }) => {
    body.dataset.mode = 'full';
    const iconEl = $('full-icon');
    // 'mark' is the OnlyX ring itself — used on the idle screen, where the product is what to show.
    // Only the className changes per state; the slot's size and centring live on #full-icon in the
    // CSS, so no kind can lose them the way v1.0.1's `mark lg` lost `.icon`'s margin.
    iconEl.className = icon.kind === 'mark' ? 'mark lg' : `icon ${icon.kind}`;
    iconEl.textContent = icon.kind === 'mark' ? '' : (icon.glyph ?? '');
    iconEl.hidden = false;
    $('full-title').textContent = title;
    $('full-text').textContent = text ?? '';
    $('full-detail').textContent = detail ?? '';
    const box = $('full-actions');
    box.replaceChildren(...actions);
    $('full-fine').replaceChildren(...(fine ?? []));
  };

  const helpLine = () => {
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'Help';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openHelp();
    });
    return [a];
  };

  /**
   * What a stuck creator actually needs, in the app, with no connection required.
   *
   * The Help button used to open `onlyx.ai/connect-app`, which 404s — so the one button a stuck
   * person presses took her to a missing page. Everything below is answerable offline, because
   * "cannot reach OnlyX" is one of the states she may be in when she presses it.
   */
  const HELP = [
    ['Nothing happened when I clicked my link', 'Open OnlyX Login once from your Applications folder (Mac) or Start menu (Windows), then click the link again. Your browser will ask whether to open OnlyX Login — choose Open.'],
    // Mac releases are Developer ID-signed and notarised from v1.3.1. A Gatekeeper warning on an
    // official current build therefore means the copy is old, incomplete or not the release we
    // produced; do not teach a creator to override that signal. Windows remains unsigned for now.
    ['My computer shows a warning the first time I open the app', 'Mac: delete that copy and install the latest version from the OnlyX connect link your manager sent you. The current Mac release is signed and checked by Apple, so do not use Open Anyway for a fresh official download — tell your manager if it still warns. Windows: click “More info”, then “Run anyway”.'],
    ['My link says it has expired', 'Links work once, and for 15 minutes. Ask your manager to send a new one — it takes them a second.'],
    ['I signed in to the wrong account', 'Sign out inside the sign-in window and sign in again with the account your manager is expecting. You do not need a new link.'],
    ['OnlyFans is asking for a selfie or a video check', 'That is normal. Allow the camera when your computer asks, and hold your face up to it as OnlyFans instructs. Nothing is recorded by OnlyX.'],
    ['It says it cannot reach OnlyX', 'Check your internet connection and click the link again. If it keeps happening, tell your manager.'],
  ];

  let helpOpen = false;
  const openHelp = () => {
    helpOpen = true;
    render(current);
  };
  const closeHelp = () => {
    helpOpen = false;
    render(current);
  };

  const renderHelp = () => {
    body.dataset.mode = 'full';
    const iconEl = $('full-icon');
    iconEl.className = 'icon';
    iconEl.textContent = '';
    // No glyph here — hidden, not left as an invisible 86px spacer: help is the tallest screen in
    // the app, and that dead band is the difference between the panel fitting the default window
    // and every reader getting a scrollbar. renderFull un-hides it for every real icon.
    iconEl.hidden = true;
    $('full-title').textContent = 'Help';
    $('full-text').textContent = '';
    $('full-detail').textContent = '';
    const list = document.createElement('dl');
    list.className = 'help';
    for (const [q, a] of HELP) {
      const dt = document.createElement('dt');
      dt.textContent = q;
      const dd = document.createElement('dd');
      dd.textContent = a;
      list.append(dt, dd);
    }
    $('full-actions').replaceChildren(list, button('Back', closeHelp, true));
    const mail = document.createElement('span');
    mail.textContent = 'Still stuck? Tell your manager, or write to support@onlyx.ai';
    $('full-fine').replaceChildren(mail);
  };

  const tickClock = () => {
    if (current.phase !== 'signin' || !current.expiresAt) return;
    const left = Math.max(0, Math.floor((new Date(current.expiresAt).getTime() - Date.now()) / 1000));
    const m = Math.floor(left / 60);
    const s = String(left % 60).padStart(2, '0');
    const el = $('bar-clock');
    el.textContent = `${m}:${s} left`;
    el.classList.toggle('late', left < 5 * 60);
  };

  const render = (state) => {
    current = state;
    clearInterval(clockTimer);
    clockTimer = null;
    if (helpOpen) return renderHelp();
    const who = state.username ? `@${state.username}` : 'your account';

    switch (state.phase) {
      case 'signin': {
        body.dataset.mode = 'bar';
        $('bar-who').innerHTML = '';
        const whoEl = $('bar-who');
        whoEl.append('Sign in to OnlyFans as ');
        const b = document.createElement('b');
        b.textContent = who;
        whoEl.append(b);
        const notice = $('bar-notice');
        if (state.notice) {
          notice.textContent = `${state.notice.title}. ${state.notice.detail}`;
          notice.title = notice.textContent;
          notice.classList.add('on');
        } else {
          notice.textContent = '';
          notice.classList.remove('on');
        }
        tickClock();
        clockTimer = setInterval(tickClock, 1000);
        return;
      }
      case 'opening':
        return renderFull({ icon: { kind: 'spin' }, title: 'Opening your link…', text: 'Setting up a private connection for your account.', actions: [] });
      case 'captured':
        return renderFull({ icon: { kind: 'spin' }, title: 'Signed in', text: 'Sending your sign-in to OnlyX…', actions: [] });
      case 'verifying':
        return renderFull({
          icon: { kind: 'spin' },
          title: 'Connecting your account…',
          text: `OnlyX is taking over the session for ${who}. This usually takes under a minute.`,
          detail: 'Please keep this window open.',
          actions: [],
        });
      case 'success':
        return renderFull({
          icon: { kind: 'ok', glyph: '✓' },
          title: 'Connected',
          text: `${who} is now connected to OnlyX. You can close this window.`,
          actions: [button('Close', () => window.onlyx.close(), true)],
        });
      case 'error':
        return renderFull({
          icon: { kind: 'bad', glyph: '!' },
          title: state.title ?? 'Something went wrong',
          text: state.detail ?? '',
          actions: [button('Help', openHelp), button('Close', () => window.onlyx.close(), true)],
        });
      // The update screens. Main paints these only over the idle screen (update-policy.js) — a
      // creator mid-sign-in never sees them — so their copy's one job is to keep the link primary:
      // an update must never read as "wait before using your link".
      case 'update-downloading':
        return renderFull({
          icon: { kind: 'spin' },
          title: 'Updating OnlyX Login',
          text: 'A newer version is downloading in the background. Your connect link works as normal — click it any time.',
          actions: [],
          fine: helpLine(),
        });
      case 'update-ready':
        return renderFull({
          icon: { kind: 'ok', glyph: '↻' },
          title: 'Update ready',
          text: `${state.version ? `Version ${state.version}` : 'The new version'} installs itself when you close the app. Restart now to get it right away — or just click your connect link as normal.`,
          actions: [button('Restart to update', () => window.onlyx.installUpdate(), true)],
          fine: helpLine(),
        });
      case 'idle':
      default:
        // The screen a creator meets when she opens the app from its icon, with no link — at a
        // desktop, quite possibly wondering why an app with nothing in it just opened. It must
        // read as "ready and waiting" — a still page with an imperative title reads as an error —
        // and it must hand her the next step, because the link is NOT in this window: it is in
        // the chat where her manager sent it. Saying "installed is enough" is what stops her
        // leaving the window open for days as a superstition.
        return renderFull({
          icon: { kind: 'mark' },
          title: 'Waiting for your link',
          text: 'This app connects your OnlyFans account to OnlyX. Open the chat where your manager sent your connect link and click the link — your sign-in starts right here, by itself.',
          detail: 'No link? Ask your manager for one. You can close this window until then: OnlyX Login only needs to stay installed, not open.',
          actions: [],
          fine: helpLine(),
        });
    }
  };

  $('bar-help').addEventListener('click', openHelp);
  // The app menu's Help item lives in the main process and reaches the page this way.
  window.onlyx.onHelp?.(openHelp);
  window.onlyx.onState(render);
  render(current);
})();
