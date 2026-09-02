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
    iconEl.className = icon.kind === 'mark' ? 'mark lg' : `icon ${icon.kind}`;
    iconEl.textContent = icon.kind === 'mark' ? '' : (icon.glyph ?? '');
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
    a.textContent = 'Installation & help';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      window.onlyx.help();
    });
    return [a];
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
          actions: [button('Help', () => window.onlyx.help()), button('Close', () => window.onlyx.close(), true)],
        });
      case 'idle':
      default:
        return renderFull({
          icon: { kind: 'mark' },
          title: 'Open the link your manager sent you',
          text: 'OnlyX Login opens by itself when you click a connect link. There is nothing to set up here.',
          actions: [],
          fine: helpLine(),
        });
    }
  };

  $('bar-help').addEventListener('click', () => window.onlyx.help());
  window.onlyx.onState(render);
  render(current);
})();
