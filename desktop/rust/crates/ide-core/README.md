# CrownForge desktop IDE core

This library and `crownforge-ide-core` binary provide the desktop IDE's native file reads,
directory enumeration, embedded ripgrep-compatible search, read-only Git execution,
file watching and user terminal sessions. Agent command execution and sandbox policy
remain owned by the separately authenticated Agent service.

The binary receives newline-delimited JSON on stdin and writes only protocol JSON on
stdout. Diagnostics go to stderr. Requests use `{ "id": 1, "method": "ping", "params": {} }`;
responses contain either `result` or `error: { code, message }`. Native events contain
`event` and `params`. Four request workers keep filesystem work off the protocol reader.
Encoded output records are buffered with a 32 MiB limit before writing stdout. A result
that exceeds the limit after JSON escaping returns `LIMIT_EXCEEDED` for that request ID;
it never writes a partial JSON record or stops the service.
`rpc.cancel` bypasses their queue. Closing stdin cancels pending work and terminates
watchers and terminal children before joining the workers.

Supported methods:

| Method | Parameters / result |
| --- | --- |
| `ping` | Protocol version and supported capabilities |
| `fs.entries` | `workspaceDir`, optional `path`; directory entry flags |
| `fs.read` | `workspaceDir`, `path`; UTF-8 `content` and descriptor-based `mtimeMs` |
| `search` | Existing workspace search options; sorted `results`, `truncated` |
| `git.exec` | `workspaceDir`, `args`; `stdout`, `stderr`, `exitCode` |
| `watch.start` | `workspaceDir`, optional caller UUID `watchId` |
| `watch.stop` | `watchId`; idempotent cleanup |
| `pty.spawn` | `workspaceDir`, `executable`, `args`, sanitized `env`, `cols`, `rows`, optional caller UUID `sessionId` |
| `pty.write` | `sessionId`, base64 `data` |
| `pty.resize` | `sessionId`, `cols`, `rows` |
| `pty.kill` | `sessionId`; idempotent process-tree cleanup |
| `rpc.cancel` | `requestId`; cancellation of queued or running work |

Events are `fs.changed { watchId, paths, overflow }`,
`pty.output { sessionId, data }` (base64 bytes), and
`pty.exit { sessionId, exitCode }`. Subscribe with caller-generated UUIDs before starting
a watcher or terminal because events can precede the corresponding response. When IDs
are omitted, this process generates unique string IDs. A watcher batches events for
about 75 ms; `overflow: true` requires a full rescan and does not replace mutation logs.

Search uses the upstream `grep-regex`, `grep-matcher` and `ignore` libraries directly.
It preserves include/exclude globs, hidden-file traversal, optional ignore files,
UTF-16 editor columns, generated/protected/secret path exclusions, and a 10 MiB file
limit. At most four search workers run per request; results are capped at 5,000. File
reads also have a 10 MiB limit. Paths are canonicalized inside the workspace; Unix file
reads additionally use descriptor-relative `openat` with `O_NOFOLLOW` to prevent a
link replacement between authorization and opening the file.

Git allows only `status`, `diff`, `log`, `show`, `rev-parse`, `check-ignore`, and
`ls-files`. It disables external diff/textconv/fsmonitor and optional index locks,
rejects scope-changing and output-writing options, limits output to 32 MiB, and times
out after 30 seconds. Write operations continue through the approved Agent path.

PTY environments are explicitly cleared before applying the supplied environment.
On Unix, explicit shutdown kills terminal descendants and PTY-owned process groups;
on Windows it uses the trusted spawned PID for `taskkill /T /F` and native child cleanup.
This is user-terminal lifecycle cleanup, not an Agent security sandbox. Deliberately
detached daemon processes require their own lifecycle owner.

Run from the repository with:

```sh
cargo test --manifest-path desktop/rust/crates/ide-core/Cargo.toml
cargo clippy --manifest-path desktop/rust/crates/ide-core/Cargo.toml --all-targets -- -D warnings
```

Tests use disposable real directories and repositories, native file watchers, and
Unix PTYs, including symlink escape, Unicode columns, child-tree termination, queued
cancellation, and stdin EOF cleanup. Windows PTY execution and native filesystem
notifications require Windows CI validation.
