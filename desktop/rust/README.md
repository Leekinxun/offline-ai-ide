# CrownForge Rust desktop

This workspace replaces the desktop Electron host with Tauri 2. The existing
React/Monaco workbench is served by a private loopback Node sidecar, with Rust
IDE services supplied by `crownforge-ide-core`. Web and Docker startup do not
use this workspace or enable its native services.

## Develop

Install Rust 1.89+ and the platform's Tauri prerequisites, and use a supported
standalone Node LTS release. The current bundle uses supported Node 22
Maintenance LTS to preserve the existing macOS 13 compatibility. Development accepts
Node 20+, while release staging and packaging require Node 22+. Build existing
backend/frontend dependencies with their normal
project workflow, then run:

```sh
npm --prefix desktop/rust ci
npm --prefix desktop/rust run dev
```

`CROWNFORGE_NODE_EXECUTABLE` optionally selects an absolute standalone Node
executable. It must match the host architecture. The launcher builds the
frontend, backend, and Rust workspace, then starts the desktop host. For an
isolated smoke test set `CREWFORGE_DESKTOP_DATA_DIR` to a disposable directory;
otherwise the host reuses the released Electron application's
`CrownForge` user-data directory and its existing users, preferences and state.

After building, the native host can be started directly from any directory:

```sh
CREWFORGE_DESKTOP_DATA_DIR=/absolute/test-data \
CROWNFORGE_NODE_EXECUTABLE=/absolute/node \
desktop/rust/target/debug/crownforge-desktop
```

## Package on the target operating system

Select a supported LTS runtime with `CROWNFORGE_NODE_EXECUTABLE` when the global
Node installation is older. Official standalone archives are available from
[nodejs.org/dist](https://nodejs.org/dist/); verify the archive against its
release's `SHASUMS256.txt` before extracting it. This does not require changing
the global Node installation. Node's current supported release families are
listed in the [official release table](https://nodejs.org/en/about/previous-releases).

```sh
# macOS
npm --prefix desktop/rust run package -- --bundles app

# Native Windows PowerShell
npm --prefix desktop/rust run package -- --bundles nsis
```

The package includes standalone Node, backend production dependencies,
frontend assets, plugins and the Rust IDE binary. Windows also includes the
pinned CrownForge downstream Codex runtime, complete resources and schema 2 receipt under
`backend/vendor/codex/win-<arch>`. Resource staging never includes root-level
private configuration. Production JavaScript dependencies are installed using
the selected Node runtime with install scripts disabled. The unused `node-pty`
package is removed only from generated native resources; Rust owns desktop
PTY, and retained TypeScript services receive a verified ripgrep executable.
Electron ABI rebuilds are not used. macOS packaging
rejects Node executables that depend on local, unbundled shared libraries.
Universal macOS Node executables are reduced to the packaging architecture in
generated resources. Codex's Windows runtime is included only on Windows and
only for the target architecture.

`npm --prefix desktop/rust run prepare:runtime` builds and stages resources
without creating a bundle. `run build` does the same; `run package` additionally
invokes the locally installed Tauri CLI. Generated resources and target outputs
are ignored. Release signing/notarization require the distributor's credentials.

The production bundle using official Node 22 supports macOS 13+ and Windows
10+. Node 22's binary supports this macOS floor; Node 24 would require macOS
13.5+, so switching runtime families requires reviewing the package's platform
floor. See [Node 22's supported platforms](https://github.com/nodejs/node/blob/v22.23.3/BUILDING.md#platform-list). Windows 7 remains an
unverified legacy Electron target. Linux native desktop startup is disabled
until iframe IPC attribution is verified; this does not affect the Web build.

## Native boundary

The workbench receives only the existing `window.crownforgeDesktop` interface:
preferences, safe external URLs and menu zoom callbacks. A top-frame-only
initialization script checks the exact loopback origin and `/` or `/login`.
Each registered window has a private bridge token. Tauri's application command
manifest and a runtime capability restrict native commands to that window's
bound port and workbench paths. There are no browser-accessible shell,
filesystem, dialog or window-management permissions.

Loopback access alone cannot bootstrap a desktop administrator session. The
host creates a fresh 256-bit private credential for each backend launch and
passes it through the daemon's environment. The trusted top-frame script keeps
it in a closure and adds `X-CrownForge-Desktop-Bootstrap` only to the exact
backend origin's `/api/auth/me` fetch. Other origins, preview pages, frames and
API paths receive no credential. It is not exposed on the bridge, in URLs,
logs or persistent state, and the backend's child-process environment
allowlists do not pass it to terminals or Agent commands. Missing credentials
fail closed. Node VM tests execute the same embedded production script to
check URL scope and preservation of Request/Headers objects.

Preview iframes retain the existing sandbox. They have no matching native
capability or injected bridge. WebKit reports iframe document navigations to
the navigation hook, so only validated preview document paths are permitted
there; a top-level page-load guard restores the workbench if a preview attempts
to replace it. New trusted workbench windows use the same policy. HTTPS external
links and canonical authorized preview URLs open in the system browser.

The Node sidecar communicates startup, shutdown and native folder-picker
requests through private NDJSON pipes. Ordinary stdout logs are redirected to
stderr. Closing the host pipe triggers daemon shutdown; host exit waits for
graceful shutdown and then stops the child. The Rust service is invoked only
by the desktop-gated backend, preserving existing authorization and file
mutation contracts. Integrated user terminals do not grant the Agent a new
execution path or bypass its approval/sandbox policy.

## Verify

```sh
cargo check --manifest-path desktop/rust/Cargo.toml --workspace
npm --prefix desktop/rust test
npm --prefix desktop/rust run smoke
```

These tests cover URL and preference boundaries, native bridge shape, pipe
protocol and host-disconnect shutdown. UI behavior and native Windows sandbox
behavior additionally require platform-specific end-to-end validation.

After creating a macOS bundle, use its Node runtime for the offline backend
check:

```sh
desktop/rust/target/release/bundle/macos/CrownForge.app/Contents/Resources/runtime/node/node scripts/desktop-rust-offline-smoke.mjs
```

This disposable check uses Seatbelt to deny networking except declared host-local
fixture ports. It first confirms that an undeclared receiver is reachable
outside the restriction and receives no request inside it. It then cold-starts
the bundled backend, verifies private bootstrap and Rust tree access, serves
the bundled frontend entry and completes a chat against a local model protocol
fixture. The owned process group is checked after shutdown. Reports and fixtures
are ignored. It does not execute GUI assets/workers or bundled plugins, verify
real model weights, directly probe a public endpoint, or accept a Windows
installer. See [offline deployment requirements](../../docs/app-rust-windows.md#offline-installation-and-operation).

## Current migration boundary

The `APP_RUST` branch currently supplies these desktop-only replacements:

| Desktop capability | Implementation |
| --- | --- |
| Windows, menus, folder selection, preferences and lifecycle | Tauri/Rust host |
| File tree enumeration and UTF-8 reads | Rust filesystem service |
| Workspace search | Embedded `grep-regex`, `grep-matcher`, and `ignore` |
| Git status | Rust-managed read-only Git CLI, preserving porcelain semantics |
| Integrated terminal | Rust `portable-pty` behind the existing lease/reconnect/replay protocol |
| Diagnostic file watching | Rust `notify` events with debounce, rerun and disconnect handling |
| Windows Agent commands | Retained Node adapter to the pinned Codex native sandbox; PowerShell by default, WSL explicitly selected |

File mutations, conflict checks, ChangeSet/checkpoint evidence and collaboration
journals still have their existing coordinator. Rust filesystem notifications
are not substitutes for these records. Repository indexing, TypeScript/Python
language services, debug adapters and project task orchestration still use the
retained services, as do the remaining workspace snapshot/change polling paths.
Further Rust migration must preserve their output contracts
and unify programmatic writes before changing ownership. This is the first
working migration increment, not a claim that the complete IDE has been rewritten.

The native backend requires both `CREWFORGE_DESKTOP=1` and an explicit
`CROWNFORGE_IDE_CORE_EXECUTABLE`. Neither ordinary Web nor Docker startup enables
it. The frontend source is reused without a Tauri-specific rewrite. A configured
native service failure returns an error; it does not silently use unrestricted
Agent execution or an alternative terminal backend.

In the Tauri profile, server startup captures its private bootstrap credential
into an internal authentication module and removes it from `process.env` before
project commands can start. The module exports only initialization and a boolean
comparison, so compiler, preview, debug and terminal children do not inherit
the credential. Ordinary Web and legacy Electron profiles retain their existing
authentication behavior.

The smoke uses disposable files, a private Node sidecar and real Rust services;
it exercises desktop login, HTTP file/search/Git routes, save version/evidence,
framed WebSocket terminal input/resize/stop, and shutdown. It writes a concise
report to `.artifacts/app-rust/smoke-report.json`. The macOS UI has additionally
been checked with an isolated data directory. No Windows native sandbox result
is inferred from macOS compilation or mocked Windows adapter tests. See
[Windows acceptance](../../docs/app-rust-windows.md) for the separate smoke.
The `desktop-rust.yml` workflow runs on `APP_RUST` pushes and additionally builds the
native Windows host and exercises the real PowerShell PTY without provisioning
the Agent sandbox. `app-rust-sandbox.yml` provisions only its disposable Windows
runner and retains strict OS isolation assertions. A compiled host or a passing
protocol test does not substitute for those assertions.

### Workspace change detection

In the native desktop profile, `/api/files/changes` now queries Rust
`fs.changeVersion` instead of recursively traversing the workspace in Node.
Each workspace has an epoch and monotonic revision maintained by `notify`.
Watcher errors fail the request; overflow requests a full UI refresh. Root
replacement, native service restart and cache expiration invalidate old cursors.
The service keeps at most 32 watchers and reclaims them after five idle minutes.
It does not build an index or persist mutation evidence from filesystem events.

The HTTP response remains `{ changed, latestMtime }`. For this desktop endpoint,
`latestMtime` is an opaque refresh watermark; file reads still report actual file
mtime. Tauri exposes a read-only `workspaceChanges: "cursor"` capability so a tree
refresh preserves the acknowledged watermark even if the clock goes backwards.
Web and legacy Electron retain their timestamp traversal and tree behavior.
Multiple windows cannot consume one another's change notifications.

After building the backend and debug core, reproduce the idle-workspace comparison:

```sh
npm --prefix desktop/rust run benchmark:changes
```

The benchmark creates and removes 10,000/100,000-file fixtures, compares the
unchanged traversal with native cursor RPC on the same workspace, and writes
`.artifacts/app-rust/changes-benchmark.json`. It includes RPC and Node projection
cost, excludes HTTP transport, and reports watcher startup separately. One local
macOS arm64 debug run (Node 20.15.1, 20 warm samples) measured 100,000-file p95 at
314.41ms for traversal and 0.56ms for the native query. This does not establish
Windows performance, startup indexing cost or whole-application speed.

The remaining index rebuild, AST parsing, programmatic writes and rollback stay
in Node. Moving writes across asynchronous RPC requires a shared workspace
admission fence, durable recovery intent and preserved hunk/secret-file policies;
a filesystem notification alone cannot provide that evidence.
