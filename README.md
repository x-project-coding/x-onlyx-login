# OnlyX Login

A small desktop app for macOS and Windows that a creator opens **from a link** to sign in to
OnlyFans for her OnlyX-managed account. There is nothing to set up and no account to create in the
app: click the link, sign in, see the success screen, close it.

## For creators — installing it

> These steps are also **in the connect page itself** — the link your manager sends shows the ones
> for your own computer, so nobody has to find this file.

**macOS** (12 Monterey or newer, Intel or Apple silicon)

1. Download `OnlyX-Login-<version>-mac.dmg`.
2. Double-click it in **Downloads**. A window opens with the OnlyX Login icon beside an
   **Applications** folder.
3. Drag **OnlyX Login** onto **Applications**. That is the install; you can then eject the disk image.
4. Open it once from Applications or Launchpad. Opening it once is what lets a link start it later.
5. **If macOS says it cannot check the app for malicious software:** press **Done** (not *Move to
   Bin*), open **System Settings › Privacy & Security**, scroll to **Security**, and press **Open
   Anyway** beside the OnlyX Login message, then confirm.
   Two things people get wrong here: Control-click → Open **no longer works** — Apple disabled that
   override in macOS Sequoia — and the *Open Anyway* button disappears about an hour after the
   warning, so if it is gone, try opening the app again first.

**Windows** (10 or 11, 64-bit)

1. Download `OnlyX-Login-<version>-win.exe`. If the browser warns that the file is not commonly
   downloaded, choose **Keep**.
2. Double-click it in **Downloads**.
3. **If Windows says "Windows protected your PC":** press **More info** — the small link inside the
   message — then **Run anyway**. The button only appears after More info.
4. It installs for your user in a few seconds and opens itself.

Steps 5 and 3 are the unsigned-build path: once the installers are signed and notarised (see
*Releasing*), neither warning appears.

Then click the connect link from your manager (it starts with `onlyx-connect://`). Your browser asks
whether to open OnlyX Login — choose **Open**. The app opens on the OnlyFans sign-in page; sign in as
usual — password, email code, and the camera check if OnlyFans asks for one — and wait for the
**Connected** screen.

If the link opens nothing at all, the app has not been installed or opened yet: a custom link fails
silently when nothing is registered to handle it. Install it, open it once, then click the link
again. Links work **once** and for **15 minutes**; ask for a new one if it has expired.

Help is **inside the app** (the Help button, or the Help menu) — there is no external help page to
depend on, and it answers without a connection.

## What the app does, and does not do

- The sign-in happens in a private browser window inside the app. **Which browser it claims to be is
  the OnlyX server's decision**, and the app follows it with no update on your side:
  - *your own computer* (the default) — the window presents the machine it is running on, and
    nothing else. It states no invented processor count, no invented graphics card and no invented
    version. Painting OnlyX's server identity over a real laptop is what produced a captcha on
    every sign-in, because the two never agreed.
  - *the OnlyX identity* — the older behaviour, where the window wears the browser OnlyX uses for
    the account afterwards, so OnlyFans sees one device across both.
- The sign-in normally uses **your own internet connection**, like any browser on your computer.
  OnlyFans' identity check pairs your computer with your phone and insists both are on the same
  network, which only your own connection can satisfy. (The OnlyX server can switch the app back to
  routing the sign-in through the account's own connection — the app follows whatever the server
  offers, so this needs no update on your side.)
- When OnlyFans confirms the sign-in, the app hands the session to OnlyX and closes the window.
  OnlyX then verifies it works on its side; the app shows **Connected** when it does.
- The app keeps **nothing**: the browser window is in memory and is discarded with the run; no
  password, cookie or file is stored on the computer, and the network credentials for the
  connection never reach the computer at all.
- The app talks to exactly one server, fixed at build time (`https://of-api.onlyx.ai`). A link can
  only carry a one-time code — it cannot point the app somewhere else.
- The camera is used only if OnlyFans asks for an identity check during sign-in; macOS will ask you
  to allow it the first time.

## For managers

In OnlyX, open the account, choose **Connect → Connect with the app**, and send the creator the
link. The link is one-time and expires in 15 minutes; once she has opened it she has 45 minutes to
finish signing in. The account shows as connected in OnlyX as soon as the session is verified.

## For developers

```
npm install
npm start                       # opens the welcome screen
npm start -- "onlyx-connect://open?c=<claim>"   # opens a link (Windows/Linux argv form)
npm test                        # unit tests
npm run test:e2e:docker         # the real app against a fake OnlyFans, tunnel and API, in Docker under Xvfb
npm run test:e2e                # same, but expects DISPLAY already set (see test/e2e/run.sh)
```

An unpackaged app honours `ONLYX_API_BASE` to point at another API; a packaged app ignores it.

Layout:

| file | role |
| --- | --- |
| `src/main.js` | the flow: link → open pass → tunnel (only if the server offers one) → sign-in view → capture → import → verify |
| `src/tunnel.js` | a loopback `CONNECT` proxy that carries each stream over the API's WebSocket tunnel; not started when the open answer says `tunnel: null` |
| `src/identity.js` | applies the identity the server chose to the sign-in view over the DevTools protocol, watches `/users/me` |
| `src/native-identity.js` | the honest identity: this engine's own User-Agent with the Electron and app tokens removed and the version reduced |
| `src/session-capture.js` | which cookies to take, how to shape the payload; the WebAuthn refusal script |
| `src/diagnostics.js` | the opt-in record of what the sign-in view was allowed to do (see *Diagnosing a failed sign-in*) |
| `test/e2e/identity-probe.cjs` | a measurement fixture: what each half of a served identity does to the wire and to the page |
| `src/api.js`, `src/messages.js` | the three API calls; what the creator reads for every failure |
| `src/ui/` | the app's own screens (header bar while signing in, full-window otherwise) |
| `src/ui/fonts/` | Public Sans (SIL OFL), bundled so the app looks right offline and makes no third-party request |

The server side lives in `x-onlyfans` (`apps/api/src/modules/connect-app/`).

### Diagnosing a failed sign-in

The sign-in view is deliberately locked down — popups denied, non-https navigation blocked,
downloads refused, every permission but three denied, WebAuthn neutralised — and **every one of
those guards fails silently.** `event.preventDefault()` tells the page nothing, a denied
`window.open` returns `null`, and a refused permission is indistinguishable from the creator
pressing Block. When OnlyFans' identity check failed on 2026-09-02 (a QR code that answered the
phone `Error.Header.NotFound` — raw i18n keys, i.e. the verification session behind it did not
exist), the app had recorded nothing at all and we were left with a screenshot.

So: `ONLYX_LOGIN_DIAG` makes one run write a JSON-per-line record of what the sign-in view was
allowed to do — navigations, redirects, **window-open attempts and the verdict each received**,
blocked navigations, permission requests and checks, refused downloads, page console errors, crashes
and every state change. It is **off by default**, and it never writes a secret: URLs keep their
origin and path and the *names* of their query parameters, fragments become a length, and
token-shaped runs in console text are masked.

**macOS** — quit the app first (a second copy hands its link to the running one and never reads the
environment), then from Terminal:

```
ONLYX_LOGIN_DIAG=1 "/Applications/OnlyX Login.app/Contents/MacOS/OnlyX Login" \
  "onlyx-connect://open?c=<the claim from the link>"
```

**Windows** — from PowerShell:

```
$env:ONLYX_LOGIN_DIAG=1
& "$env:LOCALAPPDATA\Programs\onlyx-login\OnlyX Login.exe" "onlyx-connect://open?c=<claim>"
```

The app prints `diagnostics: recording this sign-in to <path>` on startup; that is the file to send
(macOS puts it in `~/Library/Logs/OnlyX Login/`). Reproduce the failure once, then close the app and
send the file. Setting the variable to an absolute path writes there instead.

`ONLYX_LOGIN_POPUPS=allow` is the second switch, and it is a **test**, not a fix. By default a
`window.open` is denied and an https target is loaded in the same view — which destroys the page
that asked, along with `window.opener`, its `message` listener and anything it held. With this set,
the vendor gets a real popup window instead: same locked-down preferences, same in-memory session,
same navigation guard, same identity, capped at two. Use it on a second reproduction *only if* the
first one's file shows a `window-open` line at the moment the handoff failed.

### Branding

The app carries OnlyX's own identity, not an approximation: the accent is **`#00AEEF`** — the blue
sampled from the OnlyFans mark, the same one `app.onlyx.ai` and the creator's connect page use — the
mark is the product's ring on a near-black disc (`public/favicon.svg` in `x-onlyx-ui`), and the
typeface is **Public Sans**, bundled rather than fetched so it renders before the app has a
connection and no request goes to a third party.

`test/e2e/branding.test.js` is the guard: a bundled font the page's CSP refuses on a `file://`
origin falls back to Helvetica silently, and a packaged app resolves its assets out of an asar
archive — so the test loads the real page and asserts the face actually loaded and the accent is the
brand's. It is run against the source tree in CI; it was also verified against a packed asar.

### Releasing

Push a tag: `git tag v1.0.1 && git push origin v1.0.1`. The `release` workflow builds a universal
DMG and an x64 NSIS installer and attaches them to a **draft** GitHub release — the two jobs run in
parallel, so the release stays a draft until you have checked both installers are attached and
publish it yourself. A live release carrying only one platform is worse than no release: the
connect page would offer a download that does not exist for half of them.

Signing needs these repository secrets; without them the installers are produced **unsigned**, and
macOS Gatekeeper / Windows SmartScreen warn the creator on first open:

| secret | what |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate as a base64 `.p12`, and its password |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | notarization via an App Store Connect key — **the method Apple recommends** |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization via an Apple ID instead; either full set works |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Authenticode certificate as a base64 `.pfx`, and its password |

Notarization needs **no flag**: electron-builder starts it as soon as one full set of Apple
credentials is in the environment, and its `mac.notarize` option exists only to *disable* that. A
workflow that passes `--config.mac.notarize=true` to "switch it on" is doing nothing.

### Auto-update

From v1.0.1 the app updates itself: at launch it checks the latest **published** release's
`latest.yml` / `latest-mac.yml`, downloads in the background, and installs when the creator closes
the app — never during a sign-in, and a failed check (offline, GitHub down) is logged and changes
nothing. The policy lives in `src/update-policy.js`; the wiring in `src/main.js`. Three release
facts matter:

- **macOS updates require a Developer ID-signed app.** Squirrel.Mac refuses to install onto an
  unsigned or ad-hoc build, so unsigned mac builds skip updates entirely (`auto-update: skip
  (mac_unsigned)` in the log) rather than promise an update they cannot install. The app probes its
  own signature at launch, so the first signed release arms mac updates by itself — no code change.
  Until then, mac users get new versions by reinstalling, exactly as before.
- The mac build produces a **ZIP beside the DMG**: the ZIP is what Squirrel.Mac installs from
  (v1.0.0 shipped dmg-only, which auto-update could not have used); the DMG stays the human
  download. When publishing the draft, check dmg + zip + exe are all attached.
- v1.0.0 predates the updater, so it never updates itself: the move to v1.0.1 is one last manual
  reinstall per machine. Every version from v1.0.1 on updates on its own (Windows now; macOS once
  builds are signed).

Downloads: release assets on a **private** repository need a GitHub login to download, so either
keep this repository public (the app has no secrets in it) or copy each release's DMG/EXE to a
public download location and point the OnlyX connect page at it.
