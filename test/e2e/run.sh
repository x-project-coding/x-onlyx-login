#!/usr/bin/env bash
# Runs the end-to-end test under a virtual display.
#
# We start Xvfb by hand rather than via `xvfb-run`: the version on Debian bookworm can hang before
# ever launching the command (it waits on a display-readiness check that never completes in a bare
# container). Starting Xvfb directly and exporting DISPLAY is deterministic everywhere.
set -euo pipefail
cd "$(dirname "$0")/../.."

Xvfb :99 -screen 0 1400x1000x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
trap 'kill "$XVFB_PID" 2>/dev/null || true' EXIT
export DISPLAY=:99
for _ in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

exec node --test test/e2e/app.test.js test/e2e/branding.test.js
