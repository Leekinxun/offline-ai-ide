#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/6] Backend tests and typecheck"
(cd "$ROOT_DIR/backend" && npm test && npm run build)

echo "[2/6] JSON hierarchy mutation tests"
(cd "$ROOT_DIR/backend" && node --import tsx --test ../scripts/jsonTree.test.ts)

echo "[3/6] Context performance benchmark"
(cd "$ROOT_DIR/backend" && npm run benchmark)

echo "[4/6] Frontend production build"
(cd "$ROOT_DIR/frontend" && npm run build)

echo "[5/6] Frontend UI contract"
(cd "$ROOT_DIR" && bash scripts/ui-contract.sh)

echo "[6/6] Diff whitespace check"
(cd "$ROOT_DIR" && git diff --check)

echo "CrownForge verification passed."
