/**
 * THE MACHINE THIS APP IS ACTUALLY RUNNING ON, said out loud.
 *
 * The server used to hand every sign-in the SEAT's identity — a Linux container's story about being
 * a MacBook — and the app applied it over a creator's real Mac. Each half of that story was an
 * improvement on the container and a plain contradiction on her laptop, and the bill arrived as a
 * hard captcha on every sign-in. Measured on the app's own engine (Electron 44 / Chrome 152,
 * test/e2e/identity-probe.cjs, 2026-09-02):
 *
 *   navigator.hardwareConcurrency  8         pinned, over a machine reading 12
 *   navigator.deviceMemory         8         pinned, over a machine reading 32
 *   getParameter(37445)            answered "Google Inc. (Apple)" with WEBGL_debug_renderer_info
 *                                  NEVER OBTAINED. Real Chrome answers null until it is, so the
 *                                  patch is visible in one line, without anyone reading the string
 *   uaFullVersion                  151.0.7922.173  } two fields of ONE api disagreeing, because
 *   fullVersionList                Chromium 152    } the seat profile sets the deprecated
 *                                                    `fullVersion` and never `fullVersionList`
 *   navigator.languages            ["en-US","en;q=0.9"] — the served Accept-Language becomes a
 *                                  LANGUAGE TAG, and the header goes out `en-US,en;q=0.9;q=0.9`
 *
 * WHY THIS FILE IS SO SMALL, and why it is not a metadata builder. Untouched, this engine already
 * reports a coherent browser: `navigator.userAgentData` says `[Not?A_Brand v24, Chromium v152]`,
 * `Sec-CH-UA-Platform` and `-Platform-Version` are the real machine's, `uaFullVersion` is the real
 * engine's. That is exactly what a plain Chromium sends, and a plain Chromium is a browser people
 * use. The only thing wrong with it is the USER-AGENT STRING, in two ways Electron adds and no
 * browser has:
 *
 *   ... (KHTML, like Gecko) OnlyX Login/1.2.0 Chrome/152.0.7977.65 Electron/44.1.1 Safari/537.36
 *                           ^^^^^^^^^^^^^^^^^ the app                ^^^^^^^^^^^^^^^^ the runtime
 *                                             and the version is UNREDUCED — every real Chrome
 *                                             froze it at <major>.0.0.0 years ago
 *
 * Take those away and the string is what Chromium on this machine would send, agreeing with every
 * client hint the engine emits beside it.
 *
 * THE OVERRIDE THAT LOOKED RIGHT AND IS NOT. The obvious move is `Network.setUserAgentOverride`
 * with a rebuilt `userAgentMetadata`, to add a `Google Chrome` brand as well. Two measurements
 * killed it. First, an override carrying a `userAgent` and no `userAgentMetadata` does not leave
 * the hints alone: `navigator.userAgentData.brands` comes back EMPTY and every `Sec-CH-UA-*`
 * header disappears — the "all blank" tell x-onlyfans' device-profile.js names in its own header.
 * Second, a metadata block cannot be built honestly at the only moment it could be applied: the
 * fields have to come from the machine, the machine is asked through
 * `navigator.userAgentData.getHighEntropyValues`, and that is SECURE-CONTEXT ONLY — on the
 * about:blank the app warms its renderer with, `window.isSecureContext` is false and
 * `navigator.userAgentData` is `undefined`. Building the block from a Darwin-to-macOS table
 * instead is how you ship a platform version that is wrong the first time Apple skips a number.
 *
 * So the whole of native mode is: set the session's User-Agent to a cleaned one, and apply nothing
 * else. `session.setUserAgent` is also the half that reaches a SERVICE WORKER, which the page-level
 * CDP override never does and OnlyFans registers one.
 */

/** What this build tells the server it can do. The server gates the native identity on it. */
export const NATIVE_IDENTITY_CAP = 'nativeIdentity';
export const APP_CAPS = [NATIVE_IDENTITY_CAP];

/** The server's instruction. Anything but `native` means "wear what you were sent". */
export const isNative = (identity) => identity?.source === 'native';

/**
 * The machine's own User-Agent, with the three things Electron does that a browser does not:
 *
 *   1. the app's product token between `(KHTML, like Gecko)` and `Chrome/`
 *   2. the ` Electron/<version>` token
 *   3. an UNREDUCED Chrome version — `Chrome/152.0.7977.65` where every real Chrome and Chromium
 *      has sent `Chrome/152.0.0.0` since the UA reduction. The build number is not secret (it is
 *      in `Sec-CH-UA-Full-Version-List`, where it belongs); it is that no browser puts it HERE.
 *
 * Everything else is left exactly as the engine wrote it — the platform string included. This is
 * not a disguise: after the clean the string is what Chromium on this machine would send, and the
 * client hints the engine emits beside it agree with it, which is the property the seat's borrowed
 * profile could not have.
 *
 * Returns null when the string is not one this can safely clean — no `Chrome/` token — so the
 * caller applies nothing at all rather than a mangled claim.
 */
export const cleanUserAgent = (userAgent) => {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  if (!/Chrome\/\d/.test(ua)) return null;
  const cleaned = ua
    // The app's own product token. Matched as "everything up to Chrome/" rather than as
    // `Name/Version`, because `app.getName()` is "OnlyX Login" and a space would break a token
    // match — which is the kind of miss that ships a UA still carrying the app's name.
    .replace(/(\(KHTML, like Gecko\)\s+)[\s\S]*?(?=Chrome\/)/, '$1')
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/Chrome\/(\d+)(?:\.\d+){0,3}/, 'Chrome/$1.0.0.0')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return /Chrome\/\d+\.0\.0\.0/.test(cleaned) ? cleaned : null;
};
