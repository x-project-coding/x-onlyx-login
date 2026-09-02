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

/** Where a creator (or her manager) reads how to install the app, and what to do when it fails. */
export const HELP_URL = 'https://onlyx.ai/connect-app';
export const SUPPORT_EMAIL = 'support@onlyx.ai';
