#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOUNT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/crownforge-entrypoint-test.XXXXXX")"
WORKSPACE_DIR="$MOUNT_ROOT/workspace"
PLUGINS_DIR="$MOUNT_ROOT/plugins"
CONFIG_DIR="$MOUNT_ROOT/config"
HOME_DIR="$MOUNT_ROOT/home"

cleanup() {
  rmdir "$WORKSPACE_DIR" "$PLUGINS_DIR" "$CONFIG_DIR" "$HOME_DIR" "$MOUNT_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$WORKSPACE_DIR" "$PLUGINS_DIR" "$CONFIG_DIR" "$HOME_DIR"
chmod 0755 "$WORKSPACE_DIR" "$PLUGINS_DIR" "$CONFIG_DIR" "$HOME_DIR"

docker run --rm \
  --user 0:0 \
  --read-only \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add CHOWN \
  --mount "type=bind,src=$ROOT_DIR/scripts/docker-entrypoint.sh,dst=/crownforge-entrypoint,readonly" \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace" \
  --mount "type=bind,src=$PLUGINS_DIR,dst=/app/plugins" \
  --mount "type=bind,src=$CONFIG_DIR,dst=/app/config" \
  --mount "type=bind,src=$HOME_DIR,dst=/home/crewforge" \
  --entrypoint /crownforge-entrypoint \
  node:20-slim \
  init-mounts

docker run --rm \
  --user 10001:10001 \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --mount "type=bind,src=$ROOT_DIR/scripts/docker-entrypoint.sh,dst=/crownforge-entrypoint,readonly" \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace" \
  --mount "type=bind,src=$PLUGINS_DIR,dst=/app/plugins" \
  --mount "type=bind,src=$CONFIG_DIR,dst=/app/config" \
  --mount "type=bind,src=$HOME_DIR,dst=/home/crewforge" \
  --entrypoint /crownforge-entrypoint \
  node:20-slim \
  sh -ceu '
    test "$(id -u)" -eq 10001
    test "$(id -g)" -eq 10001
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
    for runtime_dir in /workspace /app/plugins /app/config; do test -w "$runtime_dir"; done
    mkdir /app/config/.team
    touch /app/config/.team/teams.json
    unlink /app/config/.team/teams.json
    rmdir /app/config/.team
  '

docker run --rm \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m,mode=1777 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add SETGID \
  --cap-add SETUID \
  --user 0:0 \
  --mount "type=bind,src=$ROOT_DIR/scripts/docker-entrypoint.sh,dst=/crownforge-entrypoint,readonly" \
  --mount "type=bind,src=$WORKSPACE_DIR,dst=/workspace" \
  --mount "type=bind,src=$PLUGINS_DIR,dst=/app/plugins" \
  --mount "type=bind,src=$CONFIG_DIR,dst=/app/config" \
  --mount "type=bind,src=$HOME_DIR,dst=/home/crewforge" \
  --entrypoint /crownforge-entrypoint \
  node:20-slim \
  sh -ceu '
    test "$(id -u)" -eq 10001
    test "$(id -g)" -eq 10001
    grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
    grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
    for runtime_dir in /workspace /app/plugins /app/config; do
      test -w "$runtime_dir"
      touch "$runtime_dir/.permission-test"
      unlink "$runtime_dir/.permission-test"
    done
  '

echo "Docker entrypoint permission regression passed."
