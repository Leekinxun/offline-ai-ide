#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CROWNFORGE_SMOKE_IMAGE:-crownforge:smoke}"
CONTAINER_NAME="${CROWNFORGE_SMOKE_CONTAINER:-crownforge-smoke}"
PORT="${CROWNFORGE_SMOKE_PORT:-3900}"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull=false -t "$IMAGE_NAME" "$ROOT_DIR"
docker run -d --name "$CONTAINER_NAME" -p "$PORT:3000" "$IMAGE_NAME" >/dev/null

for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${PORT}/api/health" | grep -q '"status":"ok"'; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "CrownForge Docker smoke test timed out" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 2
done

curl --fail --silent "http://127.0.0.1:${PORT}/" | grep -q "CrownForge"
echo "CrownForge Docker smoke test passed on port ${PORT}."
