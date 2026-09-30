#!/bin/sh
# Extended smoke test: probe every /api route of the packaged app for 5xx.
set -eu

APP="/Users/alfirusahmad/theglobe/frontend/dist/mac-arm64/The Globe.app"
LOG="/tmp/globe-test2.log"

rm -f "$LOG"
"$APP/Contents/MacOS/The Globe" > "$LOG" 2>&1 &
APP_PID=$!

sleep 8

CHILD="$(pgrep -f 'Resources/server/index.js' | head -1 || true)"
if [ -z "$CHILD" ]; then
	echo "FAIL: server child not running"
	cat "$LOG"
	kill "$APP_PID" 2>/dev/null || true
	exit 1
fi

LINE="$(lsof -a -p "$CHILD" -iTCP -sTCP:LISTEN -n -P | tail -1)"
PORT="$(echo "$LINE" | grep -oE '127\.0\.0\.1:[0-9]+' | head -1 | sed 's/.*://')"
BASE="http://127.0.0.1:$PORT"
echo "server on $BASE"

probe() {
	# $1 = method, $2 = path, $3 = optional JSON body
	if [ "$#" -ge 3 ]; then
		CODE="$(curl -sS --max-time 15 -o /tmp/globe-probe.out -w '%{http_code}' \
			-X "$1" -H 'Content-Type: application/json' -H "Origin: $BASE" \
			--data "$3" "$BASE$2" || echo 000)"
	else
		CODE="$(curl -sS --max-time 15 -o /tmp/globe-probe.out -w '%{http_code}' \
			-X "$1" -H "Origin: $BASE" "$BASE$2" || echo 000)"
	fi
	echo "$CODE $1 $2"
	if [ "$CODE" -ge 500 ] 2>/dev/null; then
		echo "  --- 5xx body (first 400 chars) ---"
		head -c 400 /tmp/globe-probe.out
		echo
	fi
}

probe GET /
probe GET /api/settings
probe GET /api/stats
probe POST /api/health '{}'
probe POST /api/chat '{"messages":[{"role":"user","content":"hi"}],"stream":false}'

echo "=== app log tail ==="
tail -20 "$LOG"

echo "=== shutting down ==="
kill "$APP_PID" 2>/dev/null || true
sleep 2
kill -9 "$APP_PID" 2>/dev/null || true
pkill -f 'Resources/server/index.js' 2>/dev/null || true
echo "done"
