#!/bin/sh
# Claude Fleet: set up (if needed), start in the background and open in the browser (macOS / Linux).
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js >= 18 is required: https://nodejs.org" >&2
  exit 1
fi
if [ ! -f dist/fleet.cjs ]; then
  echo "Not built yet. Once: corepack enable && pnpm install && pnpm build" >&2
  exit 1
fi
exec node dist/fleet.cjs setup "$@"
