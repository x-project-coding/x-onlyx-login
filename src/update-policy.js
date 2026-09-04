/**
 * The auto-update decisions, as pure functions: main.js supplies the facts, this file answers.
 *
 * Deliberately free of Electron so every answer is testable directly (test/update-policy.test.js).
 * The updater itself (electron-updater) is wired in main.js; this file decides whether it may run
 * at all, whether it may paint the screen, and whether it may restart the app. Each refusal guards
 * a real failure, named at its branch.
 */

/**
 * May this build check for (and download) updates at all?
 *
 * - Unpackaged: never. `npm start` and the test suites must not talk to GitHub, and
 *   electron-updater refuses a dev tree anyway — refusing HERE keeps the decision one visible log
 *   line instead of a dependency's buried one.
 * - A platform with no published artifact (the Linux CI/Docker builds): never. There is no
 *   latest-linux.yml to fetch, so a check could only fail — a 404 on every CI boot, and a network
 *   touch the packaged-boot test exists to forbid.
 * - macOS without a certificate-backed signature (ad-hoc or none): never. Squirrel.Mac refuses to
 *   install an update onto such a build, so checking would download an update, promise it on
 *   screen, and then fail at the only step that matters. `signed` comes from probing the RUNNING
 *   binary (main.js), not from a build flag — so a Developer ID-signed release probes true and
 *   updates arm themselves with no code change.
 * - Windows: NSIS installs updates without a signature, so `signed` is not consulted there.
 */
export const updateCheckVerdict = ({ packaged, platform, signed }) => {
  if (!packaged) return { check: false, reason: 'unpackaged' };
  if (platform !== 'darwin' && platform !== 'win32') return { check: false, reason: 'no_feed_for_platform' };
  if (platform === 'darwin' && !signed) return { check: false, reason: 'mac_unsigned' };
  return { check: true, reason: 'ok' };
};

/**
 * Does this `codesign -dvv` output describe a certificate-backed signature?
 *
 * `Authority=` lines are the certificate chain, and only a real signing identity produces them.
 * Mere codesign SUCCESS proves nothing: electron-builder ad-hoc signs when no Developer ID is
 * configured (mandatory on Apple silicon), and an ad-hoc binary verifies fine while printing
 * `Signature=adhoc` / `TeamIdentifier=not set` and no chain — exactly the build Squirrel.Mac
 * refuses to update. Anchored to the line start because codesign echoes the executable PATH, and a
 * path containing "Authority=" must not read as a certificate.
 */
export const isCertSigned = (codesignText) => /^Authority=/m.test(codesignText ?? '');

/**
 * May an update screen replace what is on screen right now?
 *
 * Only the idle screen — and the update screens themselves, so downloading may become ready. The
 * state machine is last-write-wins with one writer, so an unguarded paint during a run would
 * replace the sign-in bar over a half-typed password, or eat a success/error verdict the creator
 * has not read yet. She loses nothing by not being told mid-run: the download continues in the
 * background and install-on-quit applies it once she is done.
 */
export const mayPaintUpdate = (phase) =>
  phase === 'idle' || phase === 'update-downloading' || phase === 'update-ready';

/**
 * May the app quit and install RIGHT NOW?
 *
 * `runActive` means a creator is somewhere between opening a link and its verdict: a 45-minute
 * pass, a live tunnel, possibly a half-typed password. A restart there destroys her run — so the
 * request is refused even when a click races a link that arrived between paint and press.
 * `downloaded` false means there is nothing staged: quitAndInstall would quit, install nothing,
 * and read as the app crashing on the button press.
 */
export const updateInstallVerdict = ({ runActive, downloaded }) => {
  if (!downloaded) return { install: false, reason: 'not_downloaded' };
  if (runActive) return { install: false, reason: 'run_in_progress' };
  return { install: true, reason: 'ok' };
};
