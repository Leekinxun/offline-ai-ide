# CrownForge Windows sandbox downstream patch

`crownforge-network-v1.patch` applies to official Codex commit
`a956835d020762cb2b570053af06f643a11c0ecc` (`rust-v0.160.0`). This is a
CrownForge downstream build, not an upstream fix or an unmodified official
runtime. The integration receipt must identify the upstream commit, archive
digest, patch digest, variant and final executable hashes independently.

The release commit's manifests inherit workspace version `0.160.0` while its
lockfile still labels 159 internal path packages `0.0.0`. The patch aligns only
those manifest-identified package versions. All 1,313 third-party package blocks,
including versions, sources, checksums and dependency lists, remain byte-identical.
Builds continue to use `--locked`; this is release metadata alignment, not an
external dependency update.

Apply in a clean checkout with `git apply --check` followed by `git apply
--index`. Rebuild all three cooperating executables from the same patched
source and the upstream Rust 1.95.0 toolchain:

```powershell
cargo build --locked --release -p codex-cli --bin codex
cargo build --locked --release -p codex-windows-sandbox --bin codex-windows-sandbox-setup --bin codex-command-runner
```

The public `initialize`, `windowsSandbox/readiness`, `setupStart`,
`setupCompleted`, and sandbox CLI shapes remain unchanged. No new Rust
dependency is added. The package does not include a provisioning service:
its pipe/service/registry namespace is isolated, so it cannot discover or
attach the ordinary Codex provisioning service. Supporting a CrownForge
service in the future requires building that service from the patched source.

The patch establishes these differences:

- `CrownForgeSbxOff` / `CrownForgeSbxOn` local accounts (both within the SAM
  20-character limit), `CrownForgeSandboxUsers`, setup/read-ACL mutexes,
  desktop names, provisioning pipe, service names, registry keys and uninstall
  paths have their own namespace. Existing shared Codex accounts are untouched.
- Setup marker/users schema 6 additionally verifies the exact private account
  names. Old schema 5 data does not grant readiness or execution authority.
  Explicit setup replaces only the App-private control data with the new account
  records; DPAPI and the existing filesystem permission/ACL machinery remain.
- Eight new filters cover TCP/UDP in `ALE_AUTH_CONNECT_V4/V6` and
  `ALE_AUTH_RECV_ACCEPT_V4/V6`. They match only the private Offline account,
  without address/port exceptions, and retain the twelve upstream ICMP,
  direct-DNS and SMB rules. All twenty filter GUIDs and their provider/sublayer
  belong to CrownForge. Online is unaffected; Offline managed proxies and
  arbitrary local-binding exceptions are unsupported.
- Persistent filter publication is one WFP transaction and setup fails if WFP
  installation fails. Existing owned metadata READ ACLs are refreshed before
  that transaction; new objects receive their ACL through `Add0`. Ordinary
  readiness/launch reads the installed filters individually with `GetByKey0`,
  requiring no engine read-transaction permission,
  without recreating missing policy. Readback checks persistent/enabled/block
  state, namespace, layer, condition count, protocol/port and the exact Offline
  SID security descriptor. Missing/inaccessible/altered policy is not ready.
  Ordinary launches and login failures never delete credentials, repair accounts
  or invoke full setup; those operations remain explicit setup actions.
- The actual host user captured by `current_setup_user()` before elevation
  receives only `FWPM_ACTRL_READ` on owned provider/sublayer/filter metadata.
  SYSTEM/Administrators retain management permissions. Global engine/container
  ACLs are unchanged, and no caller-supplied workspace SID is used.
- Materialized runner names include `crownforge-wfp-v1` and SHA-256 of the
  source bytes, using the existing Windows BCrypt dependency. Cached executable
  reuse also compares SHA-256 content, rather than trusting only length/mtime.
  The private cache directory is `.crownforge-sandbox-bin`.
- The upstream uninstall order is preserved: fence and disable the private
  accounts, stop their payload processes, then remove only owned policy and
  principals. Persistent filters survive an ordinary helper/backend crash;
  cleanup is an explicit privileged operation, not dynamic-session rundown.

Validation performed locally includes clean-base apply checks, Rust formatting
and offline compile-only checking of the modified WFP and materialization
modules against the already-used `windows-sys` bindings. A macOS compile-only
harness is not Windows execution evidence.

The SDK's ignored test `wfp::tests::crownforge_wfp_nonadmin_owner_readback_parent`
must run after explicit setup under the elevated non-SYSTEM setup owner. It
creates a genuine same-owner LUA primary token and launches only the exact
ignored child test in the same executable. The child verifies no impersonation,
the original TokenUser SID, deny-only Administrators, zero restricting SIDs,
and no enabled privilege except SeChangeNotify, then calls the production probe
using a fresh WFP engine. Failure never falls back to administrator readback;
the parent terminates its owned child on a 60-second timeout. Build the test
binary with `cargo test --release -p codex-windows-sandbox --lib --no-run`, then
run this exact ignored parent test with `--ignored --exact --nocapture`.

Additional unit checks cover namespace/schema rejection, eight TCP/UDP specs,
altered/disabled policy readback and same-size modified helper binaries. Real
Windows CI must additionally verify:

1. Ordinary non-admin App readiness can read owned filters after explicit
   elevated setup and cannot write/delete them; missing policy remains an error.
2. Real Offline payload TCP/UDP attempts to IPv4/IPv6 loopback and remote
   positive-control endpoints are blocked, including mapped IPv6 addresses.
3. Original Codex Offline/Online accounts, rules and service/registry objects
   remain unchanged and continue their baseline behavior; CrownForge Online
   is unaffected.
4. Setup interruption, helper/backend death, account SID replacement, policy
   tampering and BFE restart do not produce a false-ready result or silent
   policy installation. Teardown leaves no owned payload and removes only the
   CrownForge namespace.
5. Direct DNS sockets and delegated Windows DNS Client resolution are measured
   separately. User-SID ALE filters must not be advertised as preventing every
   SYSTEM/service-mediated resolution path without that evidence. The patch
   does not add a kernel callout or claim to block every local IPC mechanism.
