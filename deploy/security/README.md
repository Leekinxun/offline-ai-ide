# CrownForge Linux container sandbox profile

This is an **opt-in**, service-specific profile for Docker hosts where the
container's protected `/proc` submounts prevent nested bubblewrap from mounting a
new private procfs. It retains Docker's existing masked/read-only paths and runs
Agent payloads without `/proc`, using `CROWNFORGE_SANDBOX_PROC_MODE=none`.
The default application mode remains `private`; there is no automatic fallback.

The seccomp baseline is Docker 29.1.3, pinned in `provenance.json`. The additions
permit clone only with `CLONE_NEWUSER`, unshare only for `CLONE_NEWUSER`, and the
mount/umount2/pivot_root calls needed by bubblewrap. All other baseline rules
remain, including clone3 fallback behavior. The named AppArmor profile retains
Docker's proc/sys restrictions and limits additional mount types and flags to
the sandbox setup. It does not allow a payload to mount a new procfs.

Keep the service non-root, `cap_drop: ALL`, `no-new-privileges`, read-only root,
resource limits and existing workspace/config mounts. Do not replace Docker's
global profiles or disable its system-path masks. The helper's temporary setup
uses the parent procfs; the final payload must not see it. The fixed self-test
checks this as `payloadProcAbsent`.

## Enable on a verified host

Parse and test the profiles on an isolated container before replacing the
service. The profile must be loaded on the Docker host, and the seccomp path is
an absolute host file path resolved by Compose, not a container path.

```sh
sudo apparmor_parser -Q -T -K deploy/security/crownforge-bwrap.apparmor
sudo install -m 0644 deploy/security/crownforge-bwrap.apparmor /etc/apparmor.d/crownforge-bwrap
sudo apparmor_parser -r -T -K /etc/apparmor.d/crownforge-bwrap
export CROWNFORGE_SECCOMP_PROFILE="$(pwd)/deploy/security/crownforge-bwrap.seccomp.json"
docker-compose -p <existing-project-name> -f docker-compose.yml -f docker-compose.sandbox.yml config --services
# After the candidate passes the fixed sandbox self-test:
docker-compose -p <existing-project-name> -f docker-compose.yml -f docker-compose.sandbox.yml up -d --no-deps --force-recreate ai-ide
```

Use `docker compose` where installed instead of the standalone `docker-compose`.
Keep both Compose files and the same project name on subsequent updates. A host
may persist the resolved override as `docker-compose.override.yml` so the normal
Compose invocation includes it; preserve any existing host override. A plain
`restart` does not update container security settings. Loading the named profile
from `/etc/apparmor.d` also preserves it across host reboots.

## Compatibility and verification

Without procfs, ordinary standard streams, workspace files, Python, Ruff and
simple Node/npm scripts can run, but interfaces that require procfs cannot.
On the target Node 20 runtime, `process.memoryUsage()` and
`process.memoryUsage.rss()` return an `ENOENT` error. Process inspection tools
and opening `/dev/stdout` or `/dev/fd` by pathname may also depend on procfs.
Do not describe a successful simple npm script as support for every toolchain.

Run the same image's `runSandboxSelfTest()` as UID/GID 10001 inside the target
container. Require the nine ordinary checks plus `payloadProcAbsent` in none
mode. Also verify representative commands, timeout/cancellation cleanup, the
served frontend artifact and authenticated administrator diagnostics. The full
procedure is in [deployment verification](../../docs/testing/deployment-verification.md).

Keep a rollback image and the previous Compose/profile configuration. Restore
application/runtime settings without restoring older user project files or
persistent application configuration over newer data.

The 2026-09-30 target-host verification used Ubuntu 22.04.5, kernel
5.15.0-185, Docker 29.1.3 and bubblewrap 0.8.0. All ten boundary/runtime canaries
passed, as did the actual shell paths for Python/Ruff versions, grouped commands,
`2>/dev/null`, Python unittest and an offline npm script. Timeout, explicit stop
and supervisor death all cleaned up detached descendants. This matrix does not
certify other kernels or tools that require procfs. A write to a hidden host
`/tmp` pathname may create an isolated scratch file; the canary separately verifies
that the real host sentinel is invisible and unchanged.
