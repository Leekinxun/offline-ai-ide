#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EVIDENCE_DIR="${CREWFORGE_RETRIEVAL_EVIDENCE_DIR:-$ROOT_DIR/.omx/artifacts/retrieval}"
mkdir -p "$EVIDENCE_DIR"

echo "[1/5] Retrieval reference evaluation"
(cd "$ROOT_DIR/backend" && npm run eval:retrieval -- --json "$EVIDENCE_DIR/evaluation.json")

echo "[2/5] Retrieval policy and isolation security tests"
(cd "$ROOT_DIR/backend" && node --import tsx --test src/security/retrievalPolicy.test.ts)

echo "[3/5] Retrieval smoke performance gate"
(cd "$ROOT_DIR/backend" && npm run benchmark:retrieval -- --json "$EVIDENCE_DIR/benchmark-smoke.json")

echo "[4/5] Backend typecheck"
(cd "$ROOT_DIR/backend" && npm run build)

echo "[5/5] Diff whitespace check"
(cd "$ROOT_DIR" && git diff --check)

echo "Retrieval verification passed. Evidence: $EVIDENCE_DIR"
