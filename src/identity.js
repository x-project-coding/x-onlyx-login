/**
 * Make the sign-in browser present ONE COHERENT DEVICE, and hear OnlyFans name the creator.
 *
 * Everything goes over the Chrome DevTools Protocol on the view's own `webContents.debugger`, the
 * same calls the seat makes (x-onlyfans worker/runtime/src/page-identity.js):
 *
 *   Network.setUserAgentOverride        the UA string, Accept-Language, `navigator.platform` and the
 *                                       client hints (Sec-CH-UA-*) on the wire
 *   Page.addScriptToEvaluateOnNewDocument  the WebAuthn hardening, always — plus, in `seat` mode,
 *                                       the seat's pins (core count, memory, WebGL renderer)
 *   Emulation.setTimezoneOverride       only when the API names a zone
 *
 * WHICH DEVICE IS THE SERVER'S CALL, and it says so in `identity.source`:
 *
 *   seat    everything below is applied. The sign-in and the seat that resumes it are then made
 *           under one identity, which is what this app did from its first release.
 *   native  present THIS machine. The seat's story was written for a Linux container pretending to
 *           be a Mac; on a creator's real Mac each of its claims is a contradiction instead, and
 *           the bill was a hard captcha on every sign-in (2026-09-02). Nothing is overridden at
 *           all: the session's User-Agent is set to this engine's own with the Electron and app
 *           tokens stripped and the version reduced (native-identity.js), no client hints are
 *           touched, no pins are injected, no zone and no language is forced. The only thing still
 *           applied is the WebAuthn hardening — which claims nothing about the device and only
 *           refuses a passkey, a dead end for a session the seat has to resume without one.
 *
 * The session-level UA (`session.setUserAgent`) is set by the CALLER in both modes, before the view
 * exists — a renderer takes `navigator.userAgent` at creation, and it is the only half a service
 * worker reads. See the note in main.js.
 *
 * The watch is `Network.responseReceived` for `/api2/v2/users/me` plus `Network.getResponseBody`
 * once the body has landed. Reading the answer this way touches nothing in the page.
 */

import { isMeUrl, judgeMe, HARDEN_SCRIPT, READ_XBC_EXPRESSION } from './session-capture.js';
import { isNative } from './native-identity.js';

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
  // NOTHING AT ALL IN NATIVE MODE, and that is the change. `Network.setUserAgentOverride` cannot
  // carry a User-Agent without also carrying a `userAgentMetadata`: with the metadata absent,
  // `navigator.userAgentData.brands` comes back EMPTY and every `Sec-CH-UA-*` header disappears —
  // the "all blank" tell x-onlyfans' device-profile.js names in its own header. And an honest
  // metadata block cannot be built at this moment: the machine only answers through
  // `getHighEntropyValues`, which is secure-context only, and the document under this debugger is
  // the `about:blank` warm-up, where `window.isSecureContext` is false and `navigator.userAgentData`
  // is undefined (measured). Left alone, the engine emits its own hints, which are already true.
  if (!isNative(identity)) {
    await dbg.sendCommand('Network.setUserAgentOverride', {
      userAgent: identity.userAgent,
      acceptLanguage: identity.acceptLanguage ?? 'en-US,en;q=0.9',
      ...(identity.platform ? { platform: identity.platform } : {}),
      ...(identity.userAgentMetadata ? { userAgentMetadata: identity.userAgentMetadata } : {}),
    });
  }
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
