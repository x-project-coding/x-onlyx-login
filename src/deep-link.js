/**
 * The link a creator receives: `onlyx-connect://open?c=<claim>`.
 *
 * Its only job is to carry the claim. Everything else the app needs — which account, which proxy,
 * which identity — comes back from the API when the claim is spent, so a link that leaks tells an
 * attacker nothing but a 15-minute single-use token, and nothing in it can point the app at a
 * different server: the API base is compiled in (see config.js).
 *
 * Both the macOS `open-url` event and a Windows/Linux second-instance argv deliver the URL as a
 * string; on Windows the shell sometimes appends a slash (`open/?c=`) or hands the URL wrapped in
 * quotes. Every shape that still names one claim is accepted; anything else is not a link.
 */

export const SCHEME = 'onlyx-connect';

const CLAIM_SHAPE = /^[A-Za-z0-9_-]{8,512}$/;

/** The claim inside a deep link, or null when the string is not one of ours. */
export const parseDeepLink = (raw) => {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/^["']|["']$/g, '');
  if (!text.toLowerCase().startsWith(`${SCHEME}:`)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  // `onlyx-connect://open?c=` parses with host "open"; `onlyx-connect:open?c=` with pathname "open".
  const action = (url.host || url.pathname).replace(/^\/+|\/+$/g, '').toLowerCase();
  if (action !== 'open') return null;
  const claim = url.searchParams.get('c');
  if (!claim || !CLAIM_SHAPE.test(claim)) return null;
  return { claim };
};

/** The first deep link in a process's argv, or null. Electron puts it last, but do not rely on it. */
export const claimFromArgv = (argv) => {
  for (const arg of argv ?? []) {
    const parsed = parseDeepLink(arg);
    if (parsed) return parsed.claim;
  }
  return null;
};
