#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="${CROWNFORGE_SMOKE_IMAGE:-crownforge:smoke}"
CONTAINER_NAME="${CROWNFORGE_SMOKE_CONTAINER:-crownforge-smoke}"
PORT="${CROWNFORGE_SMOKE_PORT:-3900}"
CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/crownforge-smoke-config.XXXXXX")"
WORKSPACE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/crownforge-smoke-workspace.XXXXXX")"

# Bind mounts retain host ownership. These disposable test directories model the
# documented deployment requirement that the service account owns writable mounts.
cp "$ROOT_DIR/users.json" "$CONFIG_DIR/users.json"
cp "$ROOT_DIR/app-settings.json" "$CONFIG_DIR/app-settings.json"
chmod 0777 "$CONFIG_DIR" "$WORKSPACE_DIR"
chmod 0666 "$CONFIG_DIR/users.json" "$CONFIG_DIR/app-settings.json"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$CONFIG_DIR"
  rm -rf "$WORKSPACE_DIR"
}
trap cleanup EXIT

docker build --pull=false -t "$IMAGE_NAME" "$ROOT_DIR"
docker run -d --name "$CONTAINER_NAME" \
  --init \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m,mode=1777 \
  --tmpfs /run:rw,nosuid,size=16m,mode=0755 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --pids-limit 256 \
  --memory 2g \
  --cpus 2 \
  --health-cmd "curl --fail --silent http://127.0.0.1:3000/api/health | grep -q '\"status\":\"ok\"'" \
  --health-interval 30s \
  --health-timeout 5s \
  --health-retries 3 \
  --health-start-period 20s \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace,rw" \
  --mount "type=bind,src=$CONFIG_DIR,dst=/app/config,rw" \
  -p "$PORT:3000" "$IMAGE_NAME" >/dev/null

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
docker exec "$CONTAINER_NAME" sh -ceu '
  test "$(id -u)" -ne 0
  command -v curl >/dev/null
  command -v grep >/dev/null
  test "$(command -v bwrap)" = /usr/bin/bwrap
  test -w /workspace
  touch /workspace/.crownforge-smoke-write && rm /workspace/.crownforge-smoke-write
  test -w /app/config
  touch /app/config/.crownforge-smoke-write && rm /app/config/.crownforge-smoke-write
  ! touch /root/.crownforge-smoke-forbidden
  ! touch /etc/.crownforge-smoke-forbidden
  node -e "require(\"node-pty\"); console.log(\"node-pty ok\")"
  /opt/conda/bin/ruff --version

  # The parent server retains ordinary container networking, while an agent
  # subprocess receives a separate network namespace with no loopback access.
  curl --fail --silent http://127.0.0.1:3000/api/health | grep -q '"'"'"status":"ok"'"'"'
  /usr/bin/bwrap --die-with-parent --unshare-net -- /bin/sh -ceu '"'"'
    test "$(id -u)" -eq 10001
    printf "%s\n" "bubblewrap local command ok"
  '"'"'
  if /usr/bin/bwrap --die-with-parent --unshare-net -- \
    /opt/conda/bin/python -c '"'"'import socket; socket.create_connection(("127.0.0.1", 3000), timeout=1)'"'"'; then
    echo "bubblewrap network namespace unexpectedly reached parent loopback" >&2
    exit 1
  fi
'

readonly_rootfs="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$CONTAINER_NAME")"
if [ "$readonly_rootfs" != "true" ]; then
  echo "CrownForge Docker smoke test expected a read-only root filesystem" >&2
  docker logs "$CONTAINER_NAME" >&2 || true
  exit 1
fi

# HTTP readiness can precede Docker's first scheduled healthcheck. Poll the
# container health state so a legitimate `starting` status is not a false failure.
for attempt in $(seq 1 60); do
  health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$CONTAINER_NAME")"
  case "$health_status" in
    healthy)
      break
      ;;
    unhealthy|missing)
      echo "CrownForge Docker smoke test healthcheck failed: $health_status" >&2
      docker logs "$CONTAINER_NAME" >&2 || true
      exit 1
      ;;
  esac
  if [ "$attempt" -eq 60 ]; then
    echo "CrownForge Docker smoke test healthcheck timed out: $health_status" >&2
    docker logs "$CONTAINER_NAME" >&2 || true
    exit 1
  fi
  sleep 2
done
echo "CrownForge Docker smoke test passed on port ${PORT}."
