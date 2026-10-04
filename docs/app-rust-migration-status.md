# APP_RUST migration status

Desktop acceptance: `9b0d2b651208405a220d411f26bec7458abe4db0`.
Evidence captured on 2026-10-04. This remains a prototype branch; no signed
Windows installer or production release has been published.

## Completed increment

The native desktop `/api/files/changes` endpoint uses Rust `notify` change
cursors instead of synchronous Node tree traversal. It preserves the HTTP
response shape, multiple-viewer behavior and explicit refresh after restart,
clock rollback, watcher overflow or recovery. Tauri preserves the returned
cursor through tree refresh. Web and legacy Electron retain their timestamp
behavior. Index rebuild/AST parsing and mutation journals remain in Node.

The desktop owner now waits for the Rust child to finish cleanup before exiting,
continues draining its output pipes, and uses a bounded owned-process-tree
fallback on Windows. Cleanup failure is reported as failure. Wrapper and native
host deadlines allow the backend to complete that cleanup.

[Windows desktop acceptance passed](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37177448303).
The job builds the Windows host and verifies real Rust file/search/Git services,
the desktop HTTP contracts, PowerShell PTY input with Chinese text, resize, stop
and private sidecar shutdown. This is not Agent sandbox or interactive installer
acceptance.

The Windows desktop job also ran real Cargo against an empty dependency cache
and a reachable disposable registry. Desktop diagnostics made zero registry
requests and returned a clear offline dependency error. `RUSTUP_AUTO_INSTALL=0`
prevents implicit toolchain installation; Web retains its prior command.

An independent 177.39 MiB macOS bundle from the same published source uses
official Node 22.23.3. The packaged backend passed cold start, private bootstrap,
Rust tree access, a complete local model-protocol fixture chat and owned-process
shutdown under a Seatbelt policy that denies networking except declared
host-local fixture ports. An undeclared reachable receiver returned `EPERM` and
received zero requests under that same policy. The generated
`.artifacts/app-rust/offline-report.json` preserves the policy digest and resource
hashes; fixtures and reports are excluded from Git. This did not run the GUI,
workers or bundled plugins, verify real model weights, directly test a public
endpoint, or accept a Windows installer. It is not complete offline App acceptance.

## Windows Agent acceptance blocker

[Strict native sandbox acceptance failed](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37133715334).
Pinned Codex 0.160.0 passed actual PowerShell execution, exit-status propagation,
read-only Get-ChildItem, private/case-alias/App-config read denial, approved writes
and outside/control write denial. The smoke stopped at `NETWORK-LEAK`; later
Agent stdin, stop, timeout and backend-crash checks did not run.

The independent diagnostic recorded receiver-confirmed loopback TCP connections
for the original command, a Console-output control and the same Console command
after adding a temporary all-user outbound TCP block on exactly the fixture's
one loopback port. The rule was created, its scope validated and then removed.
Firewall services were running and all profiles enabled. This does not support
attributing the gap solely to the SID condition or disabled profiles.

The diagnostic completing does not count as sandbox acceptance. Preserve the
strict network assertion. The next investigation must establish an effective
loopback isolation boundary, potentially at WFP/ALE, or verify an upstream
runtime fix. Do not automatically expand system firewall rules or fall back to
WSL. PowerShell remains the native default; WSL is explicitly optional.

The downstream remediation now builds all three executables from the pinned
Codex source plus the CrownForge-owned WFP/account patch. It preserves the local
execution protocol and adds direct TCP/UDP denial, fail-closed policy readback
and a separate coexistence matrix. It is a proposed boundary until Windows
execution passes. The
[first full source build](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37173503390)
passed the mocked contracts and reached SDK compilation, then hit its 75-minute
build timeout. There was no Rust compiler error or finished release-build record;
strict smoke, network matrix and non-administrator readback were skipped.
The cold-build budget is now 120 minutes inside a 180-minute job. Superseded
pushes cancel obsolete runs so the current revision can reach acceptance.
No network or process-cleanup assertion has been relaxed.

Windows cold-start diagnostics also measured cmdlet output substantially slower
than direct Console output. Positive-command fixture budgets accommodate that
observed delay; network denial and explicit stop/timeout assertions remain intact.
The cause of the cmdlet delay has not been established.

## Remaining sequence

The destination App must install and operate in a completely offline environment.
Codex is an execution/sandbox implementation reference, not a cloud-model or
login dependency. The Windows bundle now selects the embedded WebView2 offline
installer. Build-time source downloads do not establish offline runtime
acceptance; the packaged App still needs disconnected installation and local-model
execution checks. Web behavior remains outside this desktop migration.

1. Resolve the native network boundary and rerun the complete Agent acceptance,
   including stdin and process cleanup. Then verify Windows packaging and actual
   WebView/installer behavior.
2. Move repository enumeration/hashing to Rust with preserved ignore and context
   authorization. Keep TypeScript AST parsing/storage in an independent Node
   child initially; the existing index lock recovers by owner PID, so a worker
   thread cannot simply replace that process contract.
3. Unify desktop writes behind a workspace admission fence and Node coordinator
   before adding Rust file publication. Preserve hunk review/undo, version
   conflict checks, authorization, durable recovery and shell change capture.
   User secret-file saves must retain their current metadata-only handling;
   ordinary watcher events are not authoritative mutation evidence.

The last two items are audited implementation boundaries, not completed Rust
indexing or write migration. An asynchronous file RPC must not bypass existing
writers, journal recovery, ChangeSet transactions or approval contracts.
