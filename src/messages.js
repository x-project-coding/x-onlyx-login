/**
 * What the creator reads when something goes wrong. Codes come from the API (connect-app.routes.ts)
 * and from the tunnel's close codes (tunnel.ts); the words are here so both stay in one voice and
 * none of them leak what the estate looks like from the inside.
 */

const ASK_FOR_A_NEW_LINK = 'Ask your manager for a new link.';

const OPEN_FAILURES = {
  invalid_or_spent: {
    title: 'This link has expired',
    detail: `Links work once and for 15 minutes. ${ASK_FOR_A_NEW_LINK}`,
  },
  claim_required: { title: 'This link is not complete', detail: ASK_FOR_A_NEW_LINK },
  account_unavailable: {
    title: 'This account cannot be connected right now',
    detail: 'Your manager needs to check the account in OnlyX before you sign in.',
  },
  no_egress: {
    title: 'OnlyX is not ready for this account yet',
    detail: 'Please try the link again in a minute. If it keeps happening, tell your manager.',
  },
  worker_not_ready: {
    title: 'OnlyX is not ready for this account yet',
    detail: 'Please try the link again in a minute. If it keeps happening, tell your manager.',
  },
};

const IMPORT_FAILURES = {
  pass_invalid: {
    title: 'This link has expired',
    detail: `Signing in took longer than the link allowed. ${ASK_FOR_A_NEW_LINK}`,
  },
  session_unusable: {
    title: 'The sign-in did not complete',
    detail: 'OnlyFans did not finish signing you in. Sign out and sign in once more in this window.',
  },
  wrong_creator: {
    title: 'That is a different OnlyFans account',
    detail: 'You signed in to an account that is not the one this link is for. Sign out in this window and sign in with the right one.',
  },
  duplicate_account: {
    title: 'That OnlyFans account is already connected elsewhere',
    detail: 'Tell your manager which OnlyFans account you signed in with.',
  },
  proxy_changed: {
    title: 'The connection changed while you were signing in',
    detail: `Please sign in again. ${ASK_FOR_A_NEW_LINK}`,
  },
  account_unavailable: OPEN_FAILURES.account_unavailable,
  already_imported: {
    title: 'You are already signed in',
    detail: 'This link was used to sign in already. If OnlyX still shows the account as disconnected, ask for a new link.',
  },
};

const TRANSPORT = {
  unreachable: {
    title: 'Cannot reach OnlyX',
    detail: 'Check your internet connection and open the link again.',
  },
  timeout: {
    title: 'OnlyX is not answering',
    detail: 'Check your internet connection and open the link again.',
  },
};

/** Tunnel close codes, mirrored from the API's tunnel.ts. The reason names are the same. */
export const TUNNEL_CLOSE = {
  4403: 'target_refused',
  4429: 'too_many_streams',
  4413: 'byte_budget',
  4407: 'proxy_auth',
  4409: 'proxy_blocked',
  4502: 'proxy_error',
  4504: 'connect_timeout',
  4408: 'idle',
};

const TUNNEL_FAILURES = {
  proxy_auth: {
    title: 'The secure connection was refused',
    detail: 'OnlyX could not open the connection for this account. Tell your manager — nothing is wrong on your side.',
  },
  proxy_blocked: {
    title: 'The secure connection was blocked',
    detail: 'OnlyX could not open the connection for this account. Tell your manager — nothing is wrong on your side.',
  },
  proxy_error: {
    title: 'The secure connection dropped',
    detail: 'Please open the link again. If it keeps happening, tell your manager.',
  },
  connect_timeout: {
    title: 'The secure connection timed out',
    detail: 'Please open the link again. If it keeps happening, tell your manager.',
  },
  byte_budget: {
    title: 'This sign-in used more data than expected',
    detail: `The link has been closed to protect the account. ${ASK_FOR_A_NEW_LINK}`,
  },
  unauthorized: {
    title: 'This link has expired',
    detail: `Signing in took longer than the link allowed. ${ASK_FOR_A_NEW_LINK}`,
  },
};

const GENERIC = {
  title: 'Something went wrong',
  detail: 'Please open the link again. If it keeps happening, tell your manager.',
};

export const messageForOpen = (code) => OPEN_FAILURES[code] ?? TRANSPORT[code] ?? GENERIC;
export const messageForImport = (code) => IMPORT_FAILURES[code] ?? TRANSPORT[code] ?? GENERIC;
export const messageForTunnel = (reason) => TUNNEL_FAILURES[reason] ?? GENERIC;

/** A seat that judged the import and refused it: the API's statusReason, made readable. */
export const messageForFailedConnect = (statusReason) => ({
  title: 'OnlyX could not use this sign-in',
  detail: statusReason
    ? `OnlyFans did not accept the session on OnlyX (${statusReason}). Open a new link and sign in again.`
    : 'OnlyFans did not accept the session on OnlyX. Open a new link and sign in again.',
});
