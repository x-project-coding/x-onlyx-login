/**
 * Make the sign-in browser present the seat's identity, and hear OnlyFans name the creator.
 *
 * Everything goes over the Chrome DevTools Protocol on the view's own `webContents.debugger`, the
 * same calls the seat makes (x-onlyfans worker/runtime/src/page-identity.js), so a session built
 * here and resumed there was made under one identity:
 *
 *   Network.setUserAgentOverride        the UA string, Accept-Language, `navigator.platform` and the
 *                                       client hints (Sec-CH-UA-*) on the wire
 *   Page.addScriptToEvaluateOnNewDocument  the seat's pins — platform (the CDP override's copy
 *                                       reverts on a live page, measured), core count, memory, the
 *                                       WebGL renderer — plus the WebAuthn hardening
 *   Emulation.setTimezoneOverride       only when the API names a zone
 *
 * The session-level UA (`session.setUserAgent`) is set by the caller for the same reason the seat
 * passes `--user-agent`: the page override does not reach a service worker, and OnlyFans runs one.
 *
 * The watch is `Network.responseReceived` for `/api2/v2/users/me` plus `Network.getResponseBody`
 * once the body has landed. Reading the answer this way touches nothing in the page.
 */

import { isMeUrl, judgeMe, HARDEN_SCRIPT, READ_XBC_EXPRESSION } from './session-capture.js';

export const attachIdentity = async (contents, identity, { onMe, log = () => {} } = {}) => {
  const dbg = contents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');

  const pending = new Map();
  const onMessage = async (_event, method, params) => {
    try {
      if (method === 'Network.responseReceived') {
        const { requestId, response } = params;
        if (response && isMeUrl(response.url)) pending.set(requestId, { url: response.url, status: response.status });
        return;
      }
      if (method === 'Network.loadingFinished' && pending.has(params.requestId)) {
        const { status } = pending.get(params.requestId);
        pending.delete(params.requestId);
        if (status !== 200) return onMe?.(null, { status });
        const { body } = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
        onMe?.(judgeMe(body), { status });
        return;
      }
      if (method === 'Network.loadingFailed' && pending.has(params.requestId)) pending.delete(params.requestId);
    } catch (err) {
      log(`watch: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  };
  dbg.on('message', onMessage);

  await dbg.sendCommand('Page.enable');
  await dbg.sendCommand('Network.enable', { maxResourceBufferSize: 4 * 1024 * 1024, maxTotalBufferSize: 32 * 1024 * 1024 });
  await dbg.sendCommand('Network.setUserAgentOverride', {
    userAgent: identity.userAgent,
    acceptLanguage: identity.acceptLanguage ?? 'en-US,en;q=0.9',
    ...(identity.platform ? { platform: identity.platform } : {}),
    ...(identity.userAgentMetadata ? { userAgentMetadata: identity.userAgentMetadata } : {}),
  });
  await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: HARDEN_SCRIPT });
  if (identity.initScript) {
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: identity.initScript });
  }
  if (identity.timezone) {
    // The seat swallows an unknown zone id rather than lose the browser; so does this.
    await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: identity.timezone }).catch((err) => {
      log(`timezone ${identity.timezone} not applied: ${String(err?.message ?? err).slice(0, 80)}`);
    });
  }

  return {
    /** `{ key, value }` of the device token in the page's local storage, or null. */
    async readXbc() {
      const { result } = await dbg.sendCommand('Runtime.evaluate', {
        expression: READ_XBC_EXPRESSION,
        returnByValue: true,
      });
      if (!result || typeof result.value !== 'string') return null;
      try {
        return JSON.parse(result.value);
      } catch {
        return null;
      }
    },
    detach() {
      dbg.off('message', onMessage);
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        /* the contents are already gone */
      }
    },
  };
};
