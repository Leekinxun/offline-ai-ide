#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CSS_FILE="$ROOT_DIR/frontend/src/App.css"
APP_FILE="$ROOT_DIR/frontend/src/App.tsx"
COMMAND_FILE="$ROOT_DIR/frontend/src/components/CommandPalette.tsx"
SEARCH_FILE="$ROOT_DIR/frontend/src/components/WorkspaceSearchPanel.tsx"

assert_contains() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if ! rg -q --fixed-strings "$pattern" "$file"; then
    echo "UI contract failed: $description" >&2
    echo "  expected '$pattern' in $file" >&2
    exit 1
  fi
}

assert_contains "$CSS_FILE" ".panel-shell" "shared panel shell"
assert_contains "$CSS_FILE" "@media (max-width: 860px)" "narrow-screen drawer breakpoint"
assert_contains "$CSS_FILE" "@media (max-width: 720px)" "compact modal breakpoint"
assert_contains "$CSS_FILE" "@media (prefers-reduced-motion: reduce)" "reduced-motion support"
assert_contains "$CSS_FILE" "[role=\"tab\"]:focus-visible" "visible tab focus"
assert_contains "$APP_FILE" "aria-modal=\"true\"" "diff dialog semantics"
assert_contains "$APP_FILE" "handleEscape" "global Escape handling"
assert_contains "$COMMAND_FILE" "aria-modal=\"true\"" "command dialog semantics"
assert_contains "$SEARCH_FILE" "aria-modal=\"true\"" "search dialog semantics"

echo "CrownForge UI contract passed."
