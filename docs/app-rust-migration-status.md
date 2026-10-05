# APP_RUST migration status

Evidence captured on 2026-10-04. This remains a preview branch; no signed
production release has been published. Installation and user configuration are
described in [the Tauri installation guide](desktop-rust-installation.md).

## Desktop runtime

Tauri owns the desktop window and a private local Node service. The Rust IDE
service handles file trees/reads, embedded text search, read-only Git requests,
PTY sessions and `notify` change cursors. Change cursors preserve multiple-viewer
behavior and explicit refresh after restart, watcher overflow or recovery. The
owner waits for native cleanup and uses a bounded owned-process fallback on
Windows. Web and legacy Electron retain their existing services.

Desktop packages now contain a complete, checksum-pinned Git runtime. Production
services use the host-approved absolute executable; missing Git does not fall
back to an unrelated PATH executable. macOS packaging preserves internal Git
symlinks. Node services, Rust Git requests, and the Agent's approved Git version
query share the packaged runtime. Interactive shell integration restores the
bundled Git prefix after the user's startup profiles.

Node and the execution adapter remain packaged components. AI models and Agent
settings are user configuration: basic IDE startup does not require a model,
Codex login, or WSL. Windows defaults to native PowerShell; WSL is optional.
Project toolchains and dependencies remain separately configurable.

[Windows desktop acceptance at `741c9ab`](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37181686100)
passed actual file/search/Git HTTP contracts, PowerShell PTY Chinese input,
resize/stop and private shutdown. Both release Rust executables had no
`VCRUNTIME`, `MSVCP` or `CONCRT` imports. The host retains Windows OS UCRT imports.
Real Cargo with an empty cache and a reachable fixture registry made zero
registry requests: desktop diagnostics use `--offline` and
`RUSTUP_AUTO_INSTALL=0`; Web retains its previous command.

[The desktop lane at `bde064dd`](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37189492265)
also passed Windows compilation, 29 applicable Rust tests, actual PowerShell PTY
and HTTP contracts, and desktop Git selection/read-grant regressions. Unix shell
integration is covered separately by the 40-test macOS workspace run.

macOS package acceptance uses official standalone Node 22.23.3 and the packaged
Git. A relocated Git runtime works with system Git absent from PATH. The packaged
backend, Rust search/Git status, private bootstrap, local protocol-fixture chat
and shutdown passed under a Seatbelt policy allowing only declared local fixture
ports. A separate packaged Agent launcher verified its Git child under the
Agent's own filesystem and network-deny policy; nested Seatbelt application is
not used. These are transport/runtime tests, not model-weight acceptance.

The `bde064dd` macOS arm64 App also passed actual GUI operation with its model
endpoint unavailable, under a host-local-only Seatbelt network policy: Monaco
editing and on-disk save, Rust search, bundled Git 2.56.0 in the terminal, Git
init/commit/status and visual Diff, and clean App/Node/Core shutdown. A public
TCP endpoint connected outside this policy and returned `EPERM` inside it with
the same frozen IPv4 address, avoiding a DNS-failure-only result. This controls
the test process's network environment, not a production App network policy.
The 75.68 MiB Mac ZIP retained all 155 relative Git links and passed an unpacked
bundle seal plus runtime inventory/hash verification. It is an ad-hoc-sealed
preview, not Developer ID signing or notarization.

## Windows native Agent acceptance

[Full acceptance at `74a2452b`](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37188790813)
passed with the pinned, source-built Codex 0.160.0 execution adapter and
CrownForge-owned accounts/WFP patch. There were zero model requests. The verified
SDK build cache was reused; all runtime bytes and the non-administrator readback
helper were checked against their source receipt.

The strict smoke passed PowerShell execution/exit propagation, private and secret
read denial, approved writes, outside-write denial, default network denial and
stdin EOF. Normal root exit preserved an independently backgrounded fixture as
intended. Explicit stop, a real wall timeout and an actual backend crash each
stopped all observed parent/child/grandchild payloads. For the timeout, all three
live PIDs were observed after 17.985 seconds; expiry occurred at 60.057 seconds,
with every PID gone and both heartbeat files stable.

The matrix passed four IPv4/IPv6 TCP/UDP Offline probes with zero receiver nonces
or connections, and four explicitly inherited-network probes with actual
receiver delivery while private-read/write boundaries held. Official SDK
before/after controls executed under the same nonempty Online SID and each
delivered its own nonce. Original account and twelve-filter snapshots were
unchanged; CrownForge and official identities remained distinct. The
non-administrator parent and child both passed fresh policy readback.

[The full native lane at `bde064dd`](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37189492298)
independently repeated the complete acceptance and passed. Its actual timeout
was 60.068 seconds with all three observed payload PIDs stopped; the complete
SDK file inventory matches the accepted `74a2452b` producer.

Routine readiness still performs no privileged setup, firewall repair or UAC.
The user explicitly initializes the native sandbox in Settings. Failed readiness
does not switch to unrestricted execution or WSL.

## Installer acceptance

The Windows NSIS lane is bound to the complete successful SDK producer above
and its exact source lock. It verifies the archive SHA-256 before extraction;
there is no implicit SDK source-build fallback. The installer embeds the
Microsoft-signed complete WebView2 offline payload, standalone Node, Rust IDE
service, complete MinGit runtime and execution adapter.

[Installed package acceptance at `fa7f7bd`](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37213445654)
passed actual NSIS installation, installed-service/Git/PowerShell PTY execution,
Host window creation, shutdown and uninstall with the model endpoint unavailable.
The Host translates safely representable Windows canonical paths before passing
them to Node; this fixes the actual installed Host's `EISDIR: lstat 'D:'` startup
failure. Existing user settings remain intact, and Unix paths retain their
previous behavior. The
[Windows desktop platform lane](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37213445648)
also passed the new path-boundary tests and existing real PTY/HTTP contracts.

The final NSIS Host payload is verified against its actual installed bytes;
Tauri's bundle-specific executable patch is recorded separately from the
restored raw build input. The pinned MinGit files contain orphaned upstream
debug-directory metadata: only four receipt-verified MinGit executables use a
bounded raw import/delay-import inspector, with actual Git and HTTP-helper
execution still required. Other executables retain `dumpbin` verification.

A runner
with preinstalled WebView2 is not evidence of disconnected installation on a
clean Windows machine with WebView2 absent. Neither a protocol model fixture nor
an empty model configuration proves a user's real inference service is ready.

## Context indexing and coordinated desktop writes

The desktop context index uses Rust for ignore-aware repository traversal,
strict text reads, SHA256 hashing, bounded scan sessions, pagination and live
freshness checks. Scan sessions bind the physical workspace identity, reject
late symlink/reparse substitutions and enforce content/response limits. Node
keeps the language adapters, import resolution and retrieval ranking;
TypeScript AST work runs in a worker thread. Index shards and revision markers
are published through the Rust metadata transaction namespace. Rebuild locks
remain owned by the supervising Node PID and async waits do not block its event
loop.

Desktop editor/create/upload/copy/move/delete operations, Agent write/edit/rename,
checkpoint restore, hunk/whole-file rollback, keep and keep-all use the Rust
workspace writer. Agent source bytes and mutation blobs/journal share one
transaction. Rust checks expected existence/hash/identity, streams bounded
chunks, stages files, keeps durable WAL receipts, preserves file modes/times and
refuses replacement of concurrently created targets. Unknown commit outcomes
are queried/recovered by transaction ID; late cancellation cannot erase a
completed write receipt. Recovery refuses to overwrite changed postimages.
Agent writer admission prunes terminal receipt history to the latest 1024
transactions; unresolved recovery records are never pruned. Committed transaction payloads are removed, including manual editor secret-file
copies; manual save evidence remains metadata-only. Multi-file publication has
observable intermediate states and is not an atomic filesystem snapshot.

Bounded and long-running Agent commands reserve an advisory Rust writer guard
from the pre-execution checkpoint through process-tree cleanup and native
mutation-evidence publication. Other cooperative Agent, rollback, restore and
ChangeSet integration writers are blocked. Human saves and index refreshes
remain available; concurrent human saves block attribution to the command.
Polling cannot report terminal validation success while the audit is pending.
Guard ownership survives Rust service restart and is tied to the supervising
Node PID, workspace identity and opaque owner token.

Checkpoint creation, retention and blob garbage collection also take the native
writer, so their existing Node schema code cannot race mutation-evidence
publication in the shared blob store.

The architectural boundary is deliberate: model configuration, approval and
review decisions, hunk selection, checkpoint schema/retention, and ChangeSet v3
state transitions remain in the bundled Node service. ChangeSet decision and
recovery entry points acquire the native workspace writer, while their existing
Git ref compare-and-swap, integration WAL and review rules are retained. This
increment does not claim that every Agent/business-state operation is Rust code
or introduce an external Node installation requirement.

Verification for this increment covers the Rust crate suite, actual native
index rebuild/incremental/retrieval regressions, source-mode AST worker/event-loop
checks, file/evidence transaction receipts, keep/rollback routes, binary capture,
explicit evidence gaps, human-save attribution conflicts, process cleanup and
Web regressions. Windows compile/native protocol coverage is part of
`desktop-rust.yml`. Installation acceptance is intentionally deferred for this
increment; commits carrying `[skip-app-install]` skip the installer acceptance
job. Earlier installation evidence above remains tied to its original source
commits.

## Desktop explorer workspace switching

The native explorer now reads one directory per request and loads descendants
when expanded. It no longer traverses an entire large workspace before the
initial tree appears or fails the whole tree at the former 250,000-entry cap.
Desktop workspace changes clear the previous tree, abort pending loads and
ignore results from earlier workspace/request generations. Native change
cursors advance only after a successful refresh, keeping failed loads retryable.

Quick Open and file references use a separate bounded Rust metadata path search,
so unexpanded source folders remain searchable. File-tree and name queries can
fence their expected workspace against the authenticated session selection.
Web and legacy desktop keep their original full-tree flow.

Validation includes reversed responses, scope mismatch, failed refresh retry,
lazy branch replacement, native HTTP root switching and one IPC call per
directory. macOS application verification covered switching from a small
workspace to a workspace exceeding the former tree limit, expanding a folder,
and retaining existing model preferences. Windows-target compile and Clippy
checks pass; this fix does not add an installer acceptance run.
