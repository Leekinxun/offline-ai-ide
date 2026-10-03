# Product implementation reference

Use the current official Codex implementation as the default reference for Agent
execution, approvals, sandboxing, process lifecycles, and desktop interactions.
Verify the upstream behavior before changing these contracts. Record necessary
differences explicitly instead of presenting approximations as equivalent.

Windows Agent execution defaults to native PowerShell with the Codex Windows
sandbox. WSL2 is an explicit optional Linux execution environment. Integrated
terminal preferences do not change the Agent execution environment. Sandbox
setup requires an explicit user action; ordinary capability checks must not
create users, change filesystem permissions, or update firewall rules.

Preserve unrelated local edits and private configuration. Validate published
source independently of those edits, and distinguish native Windows evidence
from mocked platform tests or Linux-only verification.
