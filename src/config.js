/**
 * Where the app talks to, fixed at build time.
 *
 * Nothing the creator receives can move it: the deep link carries a claim and nothing else, so a
 * forged link cannot make the app hand a session to somebody else's server. The one override is for
 * development and tests, and is honoured only in an unpackaged app — `app.isPackaged` is decided by
 * the process, not by anything on disk or in the environment.
 */
export const API_BASE = 'https://of-api.onlyx.ai';

export const resolveApiBase = ({ packaged, env = process.env }) => {
  if (!packaged && env.ONLYX_API_BASE) return env.ONLYX_API_BASE.replace(/\/+$/, '');
  return API_BASE;
};

/**
 * Help lives INSIDE the app, not behind a link.
 *
 * This shipped pointing at `https://onlyx.ai/connect-app`, which 404s — so the one button a stuck
 * creator presses took her to a missing page. An installed app already has everything it needs to
 * answer her, and it can answer without a connection, which is exactly the state she may be in.
 */
export const SUPPORT_EMAIL = 'support@onlyx.ai';
