#!/bin/bash
# Recovery only: never publishes. No native app changes and no Gatekeeper bypass.
set -euo pipefail

app='dist/mac-universal/OnlyX Login.app'
expected_team='Y5NUN99S3X'

verify_signature() {
  codesign --verify --deep --strict --verbose=2 "$app"
  local details
  details=$(codesign -dv --verbose=4 "$app" 2>&1)
  echo "$details"
  [[ "$details" == *"Authority=Developer ID Application:"* ]]
  [[ "$details" == *"TeamIdentifier=$expected_team"* ]]
  [[ "$details" == *"runtime"* ]]
  [[ $(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$app/Contents/Info.plist") == ai.onlyx.login ]]
  [[ $(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist") == "$(node -p 'require("./package.json").version')" ]]
}

credentials() {
  : "${APPLE_ID:?Apple ID is required}"
  : "${APPLE_APP_SPECIFIC_PASSWORD:?App-specific password is required}"
  [[ "${APPLE_TEAM_ID:-}" == "$expected_team" ]]
  auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
}

case "${1:-}" in
  build)
    : "${CSC_LINK:?Developer ID signing certificate is required}"
    mkdir -p recovery
    # Disabling automatic notarization is only for this intermediate build. finish fails closed
    # unless Apple accepts the submission, the ticket is stapled, and Gatekeeper accepts the app.
    npx electron-builder --mac dir --universal --publish never --config.mac.notarize=false
    verify_signature > recovery/signature.txt
    git rev-parse HEAD > recovery/source-commit.txt
    git ls-tree -r HEAD -- src package.json package-lock.json electron-builder.yml build > recovery/source-tree.txt
    ditto -c -k --keepParent "$app" recovery/OnlyX-Login-signed.zip
    shasum -a 256 recovery/OnlyX-Login-signed.zip > recovery/signed-sha256.txt
    ;;
  submit)
    credentials
    xcrun notarytool submit recovery/OnlyX-Login-signed.zip "${auth[@]}" \
      --no-wait --output-format json > recovery/submission.json
    ;;
  finish)
    credentials
    mkdir -p notary-status
    # A resumed run may change pipeline code, but must package exactly the same native sources.
    git ls-tree -r HEAD -- src package.json package-lock.json electron-builder.yml build > notary-status/source-tree.txt
    cmp recovery/source-tree.txt notary-status/source-tree.txt
    shasum -a 256 -c recovery/signed-sha256.txt
    submission=$(node -e 'const x=require("./recovery/submission.json"); if(!/^[0-9a-f-]{36}$/i.test(x.id||""))process.exit(1); process.stdout.write(x.id)')
    xcrun notarytool wait "$submission" "${auth[@]}" --timeout 20m \
      --output-format json > notary-status/wait.json || true
    xcrun notarytool info "$submission" "${auth[@]}" --output-format json > notary-status/info.json
    status=$(node -p 'require("./notary-status/info.json").status')
    echo "Apple notarization status: $status (submission $submission)"
    if [[ "$status" != Accepted ]]; then
      if [[ "$status" == Invalid || "$status" == Rejected ]]; then
        xcrun notarytool log "$submission" "${auth[@]}" notary-status/apple-log.json || true
      fi
      echo 'No installer published. If still processing, resume using this workflow run ID.'
      exit 1
    fi
    # Always unpack the exact archive Apple checked, not a leftover local build.
    mkdir -p dist/mac-universal
    ditto -x -k recovery/OnlyX-Login-signed.zip dist/mac-universal
    verify_signature > notary-status/verification.txt
    xcrun stapler staple "$app" >> notary-status/verification.txt 2>&1
    xcrun stapler validate "$app" >> notary-status/verification.txt 2>&1
    spctl --assess --type execute --verbose=4 "$app" >> notary-status/verification.txt 2>&1
    # --prepackaged never re-signs or alters the accepted app. ZIP/update hashes are made AFTER
    # stapling, so the public artifacts and latest-mac.yml describe the final bytes.
    npx electron-builder --mac --universal --prepackaged "$app" --publish never
    verify_signature >> notary-status/verification.txt
    xcrun stapler validate "$app" >> notary-status/verification.txt 2>&1
    shasum -a 256 dist/OnlyX-Login-*-mac.dmg dist/OnlyX-Login-*-mac.zip >> notary-status/verification.txt
    ;;
  *) echo 'Usage: recover-mac-release.sh build|submit|finish' >&2; exit 2 ;;
esac
