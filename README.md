# OnlyX Login

A small desktop app for macOS and Windows that a creator opens **from a link** to sign in to
OnlyFans for her OnlyX-managed account. There is nothing to set up and no account to create in the
app: click the link, sign in, see the success screen, close it.

## For creators — installing it

**macOS** (12 Monterey or newer, Intel or Apple silicon)

1. Download `OnlyX-Login-<version>-mac.dmg` from the link your manager gives you.
2. Open the DMG and drag **OnlyX Login** into **Applications**.
3. Open it once from Applications (right-click → Open the first time if macOS asks). It shows a
   welcome screen and can be closed again — it only needs to have been opened once.

**Windows** (10 or 11, 64-bit)

1. Download `OnlyX-Login-<version>-win.exe` from the link your manager gives you.
2. Run it. It installs for your user in a few seconds and opens once; close it.

Then click the connect link from your manager (it starts with `onlyx-connect://`). OnlyX Login opens
on the OnlyFans sign-in page. Sign in as usual — with your password, email code, and the camera
check if OnlyFans asks for one — and wait for the **Connected** screen.

If the link opens nothing, the app has not been installed or opened yet: install it, open it once,
then click the link again. Links work **once** and for **15 minutes**; ask for a new one if it has
expired.

## What the app does, and does not do

- The sign-in happens in a private browser window inside the app, wearing the same browser identity
  and the same network connection OnlyX uses for the account afterwards — so OnlyFans sees one
  device signing in, not two.
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
| `src/main.js` | the flow: link → open pass → tunnel → sign-in view → capture → import → verify |
| `src/tunnel.js` | a loopback `CONNECT` proxy that carries each stream over the API's WebSocket tunnel |
| `src/identity.js` | applies the seat's identity to the sign-in view over the DevTools protocol, watches `/users/me` |
| `src/session-capture.js` | which cookies to take, how to shape the payload; the WebAuthn refusal script |
| `src/api.js`, `src/messages.js` | the three API calls; what the creator reads for every failure |
| `src/ui/` | the app's own screens (header bar while signing in, full-window otherwise) |
| `src/ui/fonts/` | Public Sans (SIL OFL), bundled so the app looks right offline and makes no third-party request |

The server side lives in `x-onlyfans` (`apps/api/src/modules/connect-app/`).

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
DMG and an x64 NSIS installer and attaches them to a GitHub release.

Signing needs these repository secrets; without them the installers are produced **unsigned**, and
macOS Gatekeeper / Windows SmartScreen warn the creator on first open:

| secret | what |
| --- | --- |
| `CSC_LINK`, `CSC_KEY_PASSWORD` | Developer ID Application certificate as a base64 `.p12`, and its password |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | notarization (the DMG is notarized only when these are present) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Authenticode certificate as a base64 `.pfx`, and its password |

Downloads: release assets on a **private** repository need a GitHub login to download, so either
keep this repository public (the app has no secrets in it) or copy each release's DMG/EXE to a
public download location and point the OnlyX connect page at it.
