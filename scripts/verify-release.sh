#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--inside-clean-snapshot" ]]; then
  [[ "${WS15_CLEAN_SNAPSHOT:-}" == "1" ]] || { echo "WS-15 clean-snapshot marker is required" >&2; exit 1; }
  exec node "$ROOT_DIR/scripts/verify-release.mjs"
fi

exec node "$ROOT_DIR/scripts/verify-clean-snapshot.mjs" -- bash scripts/verify-release.sh --inside-clean-snapshot
