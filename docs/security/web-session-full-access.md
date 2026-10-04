# Web task approval mode

CrownForge Web can optionally skip individual approval prompts for otherwise
permitted tools, including high-risk shell commands, process input, MCP calls and
network commands already allowed by administrator policy. The default remains
individual approval. The user must explicitly accept
the risk before enabling **Full access** in the task composer.

## Scope and lifetime

The grant uses the existing verified login namespace, canonical workspace and
conversation scope. Continuation runs in the same task share it. Another login,
task, workspace or isolated window does not inherit it. Refresh reads the current
server state. Grants exist only in server memory and end with logout, expiry,
workspace switching or server restart; they are never saved in user settings.

Changing the mode requires authenticated HTTP access, a matching workspace
header, a current revision, and a writable workspace role. Enabling also requires
an explicit risk acknowledgement. Tool inputs, model messages and WebSocket
permission hints cannot enable the mode. The grant is checked again at execution
admission, so revocation during asynchronous hooks or checkpoint preparation
prevents a previously authorized operation from starting.

Enabling affects new requests only. Existing approval cards stay pending until
the user responds or they expire. Disabling clears the task's existing session
approval cache as well as full access. A response to an old pending card cannot
recreate an old session grant. Already running operations are not rolled back or
terminated by changing the mode; use the task's Stop control when needed.

## Boundaries that remain

Full access changes approval prompts, not sandbox or authorization policy.
Tool/profile restrictions, Ask/Plan/Review capabilities, read-only team roles,
tenant ownership, path protection, process sandboxing and credential boundaries
still apply. A blocked operation remains blocked. Existing approved execution
plans continue to authorize their own bounded operations independently of this
setting.

Unrestricted network requests (`allow_network: true`) still require a writable
workspace, the primary Code Agent, administrator profile permission and `*` in
the effective network grant intersection. Full access replaces their individual
approval only after those checks pass; it cannot enable networking itself. Each
admitted command receives a non-serializable, single-use permit bound to its
exact command, tool, workspace and live authorization revision. The enabling
dialog warns that allowed networking can transmit workspace data.

Plan submission retains explicit confirmation because it asks the user to accept
plan content, rather than approve tool execution. Existing pending cards retain
their original interaction. Full access does not approve publication workflows,
mobile pairing, plugin capability grants, or other independent product decisions.

This first implementation is limited to the Web backend. Desktop backends cannot
enable it. Desktop bootstrap additionally requires the private host credential;
Web approval mode cannot bypass that boundary.

Mode changes and tools admitted by full access are recorded in the existing
policy audit log, including the actor, task scope and grant revision without
session tokens. The audit is the repository's local hash-chain log, not an
external tamper-proof audit service.

## Upstream reference and intentional difference

The current official Codex protocol defines `AskForApproval` separately from
`SandboxPolicy`: [upstream protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs).
`Never` disables prompts; `DangerFullAccess` is a separate sandbox choice. This
CrownForge option intentionally preserves its sandbox and administrator network
capability requirements. Its label does not imply unrestricted host access.

## Local verification

Use synthetic users and disposable workspaces. Do not enable this mode in
production merely to test it. The regression suites cover the default mode,
explicit acknowledgement, revocation, pending and concurrent requests, scope
isolation, unauthenticated/forged requests and refresh state. Run the repository's
`./scripts/verify.sh` for the complete clean-snapshot release gate. Live browser
checks and platform-specific limitations should be reported separately from that
browserless suite.
