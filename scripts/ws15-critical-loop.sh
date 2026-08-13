#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ITERATIONS="${WS15_ITERATIONS:-100}"

if [[ "${1:-}" == "--iterations" ]]; then
  ITERATIONS="${2:-}"
  shift 2
fi

if (($# != 0)); then
  echo "usage: ws15-critical-loop.sh [--iterations positive-integer]" >&2
  exit 2
fi

if ! [[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "WS15_ITERATIONS must be a positive integer" >&2
  exit 2
fi

run_iteration() {
  local test_output
  if ! test_output="$(cd "$ROOT/backend" && node --import tsx --test ../scripts/frontendFlows.test.ts ../scripts/frontendVisualLocale.test.ts ../scripts/fileTreeNavigation.test.ts ../scripts/jsonTree.test.ts)"; then
    printf '%s\n' "$test_output" >&2
    return 1
  fi
  if ! grep -Eq '^# fail 0$' <<<"$test_output" || ! grep -Eq '^# skipped 0$' <<<"$test_output"; then
    echo "WS-15 critical loop requires a zero-failure, zero-skip browserless test summary" >&2
    printf '%s\n' "$test_output" >&2
    return 1
  fi
  node "$ROOT/scripts/modal-keyboard-contract.mjs"
  node "$ROOT/scripts/file-tree-keyboard-contract.mjs"
  node "$ROOT/scripts/ws15-frontend-flow-contract.mjs"
}

for ((iteration = 1; iteration <= ITERATIONS; iteration += 1)); do
  if ! run_iteration >/dev/null; then
    echo "WS-15 critical loop failed at iteration $iteration/$ITERATIONS; rerunning with output" >&2
    run_iteration
    exit 1
  fi
done

echo "CrewForge WS-15 critical loop passed: $ITERATIONS/$ITERATIONS iterations, 0 failures."
