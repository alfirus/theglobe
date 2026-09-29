#!/bin/sh
# The Globe — macOS production launcher.
# Requires: Node.js 20+ and a prior `npm run build` (./build is gitignored).
# Usage: ./start-macos.sh [port]   (default port 3000)
set -eu
cd "$(dirname "$0")"

if [ ! -f build/index.js ]; then
	echo "No production build found. Run 'npm run build' first." >&2
	exit 1
fi

PORT="${1:-${PORT:-3000}}"
export PORT HOST="${HOST:-127.0.0.1}"
echo "The Globe running at http://127.0.0.1:${PORT}"
exec node build
