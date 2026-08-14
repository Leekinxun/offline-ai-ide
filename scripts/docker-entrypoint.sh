#!/bin/sh
set -eu

runtime_uid="${CROWNFORGE_UID:-10001}"
runtime_gid="${CROWNFORGE_GID:-10001}"

case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:|*:*:*)
    echo "CROWNFORGE_UID and CROWNFORGE_GID must be numeric." >&2
    exit 64
    ;;
esac

if [ "$runtime_uid" -eq 0 ] || [ "$runtime_gid" -eq 0 ]; then
  echo "CrownForge must run with a non-root CROWNFORGE_UID and CROWNFORGE_GID." >&2
  exit 64
fi

prepare_runtime_mounts() {
  for runtime_dir in /workspace /app/plugins /app/config; do
    if [ ! -d "$runtime_dir" ]; then
      echo "Required runtime directory is missing: $runtime_dir" >&2
      exit 73
    fi
  done

  if ! chown "$runtime_uid:$runtime_gid" /workspace /app/plugins; then
    echo "Unable to initialize workspace/plugin ownership. The entrypoint requires CHOWN during container startup." >&2
    exit 73
  fi

  if ! chown -R "$runtime_uid:$runtime_gid" /app/config /home/crewforge; then
    echo "Unable to initialize CrownForge configuration ownership." >&2
    exit 73
  fi
}

if [ "${1:-}" = "init-mounts" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "init-mounts must run as root with only the CHOWN capability." >&2
    exit 77
  fi
  prepare_runtime_mounts
  exit 0
fi

if [ "$(id -u)" -eq 0 ]; then
  prepare_runtime_mounts
  exec setpriv \
    --reuid="$runtime_uid" \
    --regid="$runtime_gid" \
    --clear-groups \
    --no-new-privs \
    -- "$@"
fi

attempt=0
while [ ! -w /workspace ] || [ ! -w /app/plugins ] || [ ! -w /app/config ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "Runtime mounts are not writable by UID/GID $(id -u):$(id -g). Check the crownforge-permissions service or use the documented root entrypoint for docker run." >&2
    exit 73
  fi
  sleep 1
done

exec "$@"
