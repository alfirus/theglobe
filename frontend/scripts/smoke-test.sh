#!/bin/sh
# Smoke test for the packaged macOS app: launch it, confirm the embedded
# SvelteKit server answers over loopback, then shut everything down.
# Usage: sh scripts/smoke-test.sh
set -eu

APP="/Users/alfirusahmad/theglobe/frontend/dist/mac-arm64/The Globe.app"
LOG="/tmp/globe-test.log"

rm -f "$LOG"
"$APP/Contents/MacOS/The Globe" > "$LOG" 2>&1 &
APP_PID=$!

sleep 8

echo "=== app log ==="
cat "$LOG"

echo "=== server child ==="
CHILD="$(pgrep -f 'Resources/server/index.js' | head -1 || true)"
if [ -z "$CHILD" ]; then
	echo "FAIL: server child process not running"
else
	echo "child pid: $CHILD"
	LINE="$(lsof -a -p "$CHILD" -iTCP -sTCP:LISTEN -n -P | tail -1)"
	echo "listen: $LINE"
	PORT="$(echo "$LINE" | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | sed 's/.*://')"
	echo "=== HTTP check on 127.0.0.1:$PORT ==="
	curl -sS --max-time 10 -o /tmp/globe-home.html -w 'HTTP %{http_code}\n' "http://127.0.0.1:$PORT/" || echo "FAIL: curl error"
	grep -o '<title>[^<]*</title>' /tmp/globe-home.html || echo "(no <title> in response)"
fi

echo "=== shutting down ==="
kill "$APP_PID" 2>/dev/null || true
sleep 2
kill -9 "$APP_PID" 2>/dev/null || true
pkill -f 'Resources/server/index.js' 2>/dev/null || true
echo "done"
