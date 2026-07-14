#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/5] Backend tests and typecheck"
(cd "$ROOT_DIR/backend" && npm test && npm run build)

echo "[2/5] Context performance benchmark"
(cd "$ROOT_DIR/backend" && npm run benchmark)

echo "[3/5] Frontend production build"
(cd "$ROOT_DIR/frontend" && npm run build)

echo "[4/5] Frontend UI contract"
(cd "$ROOT_DIR" && bash scripts/ui-contract.sh)

echo "[5/5] Diff whitespace check"
(cd "$ROOT_DIR" && git diff --check)

echo "CrownForge verification passed."
