#!/usr/bin/env bash
# Does a PACKAGED build actually boot?
#
# The source-tree e2e cannot answer this. A packaged app resolves its ESM entry point and its
# CommonJS `ws` dependency from inside an asar archive, and if that resolution breaks the app starts
# with NO window, no error, and nothing on the creator's screen. CI had never once launched a packed
# build, so that failure mode was completely unobserved.
#
# It cannot drive the whole flow either, and that is by design, not a gap: `ONLYX_API_BASE` and every
# other test hook is refused when `app.isPackaged`, so a packaged build talks to production or to
# nothing. So the API host is pointed at loopback in /etc/hosts first: the binary starts, reads the
# deep link, enters the flow, fails to reach the API and says so — the evidence wanted — without a
# packed test build ever touching production.
set -euo pipefail
cd "$(dirname "$0")/../.."

Xvfb :99 -screen 0 1400x1000x24 -nolisten tcp >/tmp/xvfb-pkg.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
export DISPLAY=:99
for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

echo "[packaged] building --dir"
npx electron-builder --dir >/tmp/eb-pkg.log 2>&1 || { tail -25 /tmp/eb-pkg.log; exit 1; }

BIN="$(find dist -maxdepth 2 -name 'onlyx-login' -type f -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "[packaged] FAIL: no packed binary"; exit 1; }
ASAR="$(dirname "$BIN")/resources/app.asar"
[ -f "$ASAR" ] || { echo "[packaged] FAIL: no app.asar — the app was not packed into an archive"; exit 1; }
echo "[packaged] binary=$BIN asar=$(stat -c%s "$ASAR") bytes"

# Never let a test build reach the real API. The compiled-in host resolves to loopback, where
# nothing is listening, so the run ends in a connection error instead of a request to production.
if ! grep -q "of-api.onlyx.ai" /etc/hosts; then
  if [ -w /etc/hosts ]; then
    echo "127.0.0.1 of-api.onlyx.ai" >> /etc/hosts
  elif command -v sudo >/dev/null 2>&1; then
    echo "127.0.0.1 of-api.onlyx.ai" | sudo tee -a /etc/hosts >/dev/null
  else
    # Refuse rather than run a packed build that would reach the real API with a junk claim.
    echo "[packaged] cannot pin the API host to loopback — refusing to run"; exit 1
  fi
fi

OUT=/tmp/packaged-run.log
set +e
timeout 60 "./$BIN" --no-sandbox --disable-gpu --disable-dev-shm-usage \
  "onlyx-connect://open?c=packagedBootProbe0123" >"$OUT" 2>&1
set -e

echo "[packaged] --- app output ---"
grep -E "onlyx-login" "$OUT" | head -10 || true

# It booted and entered the flow if it logged the run at all. Reaching for the network and failing is
# the expected end with --network none; a silent no-window boot prints none of this.
if ! grep -q "\[onlyx-login\]" "$OUT"; then
  echo "[packaged] FAIL: the packaged app produced no application output — it did not boot"
  tail -30 "$OUT"; exit 1
fi
if ! grep -qE "run 1 failed|run 1: pass opened" "$OUT"; then
  echo "[packaged] FAIL: booted but never entered the connect flow from the deep link"
  tail -30 "$OUT"; exit 1
fi
# And it must NOT have honoured a test hook: a packaged build talks to its compiled-in API only.
if grep -q "127.0.0.1" "$OUT"; then
  echo "[packaged] FAIL: a packaged build used a test API base"; exit 1
fi
echo "[packaged] OK: packed build boots from asar, reads the deep link, enters the flow, ignores test hooks"
