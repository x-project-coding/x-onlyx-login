# Mac release recovery

The original v1.3.1 release run timed out after six hours without publishing a Mac artifact.
The `release` workflow now offers `recover_mac=true`: it does not publish a release and does
not change native app code. It requires the existing Developer ID and Apple ID repository
secrets; there is no unsigned fallback.

1. Build/sign the universal app with automatic notarization temporarily disabled.
2. Verify its Developer ID, team, hardened runtime, bundle ID, and version.
3. Submit a ZIP to Apple without waiting. Save the exact signed ZIP, source tree, checksum,
   and submission ID in the `mac-notary-recovery` Actions artifact **before** waiting.
4. Wait up to 20 minutes. An in-progress or rejected submission fails closed: no installer is
   offered as verified. Apple status/logs are saved separately.
5. Only after `Accepted`, unpack the exact submitted app, staple the ticket, and require
   `codesign --verify --deep --strict`, `stapler validate`, and Gatekeeper acceptance.
6. Package that prepackaged app as DMG/ZIP without re-signing. Generate updater hashes after
   stapling. Verified files are saved as `verified-mac-release`, not published automatically.

If Apple is still processing, run the same workflow/ref with `recover_mac=true` and
`resume_run_id=<previous recovery run ID>`. It reuses that exact archive and submission,
checks that native sources are unchanged, and never submits a duplicate request.

Before publishing, independently mount the DMG read-only, verify the contained app, compare
artifact SHA-256 hashes, and check that every platform's installer and updater metadata is
present in the intended draft. Resolve drafts by exact release ID if an earlier run created
duplicates. Do not overwrite a public artifact or publish an incomplete draft.

## Verified v1.3.1 recovery (2026-09-10)

- [Recovery run](https://github.com/x-project-coding/x-onlyx-login/actions/runs/34519028727).
- App sources match tag `v1.3.1`; only release automation changed.
- Apple submission `0a0b31ec-c37f-4bca-9dac-aceb9267e0e1`: **Accepted**.
- Bundle `ai.onlyx.login`, version `1.3.1`, universal x86_64/arm64, minimum macOS `13.0`.
- Developer ID Application: BODEN CHANG (`Y5NUN99S3X`). Hardened runtime enabled.
- Contained app independently verified on the destination Mac: signature valid,
  stapled ticket valid, Gatekeeper `accepted`, source `Notarized Developer ID`.
- DMG SHA-256: `4ea5e0a28b970dc861f89ec642f74b3334deae51836d57def8d40100d7a3dd13`.
- ZIP SHA-256: `cdd3b5c132841dfd98209b03045ef2dd4bc2741d3e14542c5a1711d0cf4454a7`.

These checks apply to the Mac app only; they do not assert Windows Authenticode signing.
