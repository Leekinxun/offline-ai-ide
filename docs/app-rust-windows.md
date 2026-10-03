# Windows Agent execution in the Rust desktop App

The Tauri host manages the IDE system services and starts the retained Agent
backend with its own Node runtime. Agent commands on Windows default to the
system PowerShell executable and the pinned Codex native Windows sandbox.
WSL 2 is an explicit selection in desktop execution settings. The integrated
terminal's shell preference does not select the Agent execution environment.

The existing adapter uses Codex **0.160.0**. Keep its complete Windows runtime
package, including the command runner and setup helper, under
`backend/vendor/codex/win-x64` or `backend/vendor/codex/win-arm64` in the packaged
backend resources. `crownforge-codex-runtime.json` records the architecture,
version, and per-file hashes. Missing or altered runtime resources block native
execution. An independent Node runtime replaces Electron's Node mode; it must
remain the backend's `process.execPath` for its supervised internal children.

## Setup and capability reads

Opening execution settings or checking readiness must not create sandbox control
configuration, provision Windows users, modify ACLs or firewall rules, or request
UAC. A new App returns `notConfigured` until the user explicitly selects sandbox
setup. Setup completion and a fresh readiness response are both required before
Agent commands are enabled.

The adapter checks an existing App-owned control configuration without rewriting
it. A changed configuration stays on disk and blocks execution until explicit
setup repairs it. The execution-only Codex client does not start model threads or
login flows. It does not inherit API keys, Electron Node flags, injection settings,
or `CODEX_WINDOWS_REGISTERED_CORE`. This last exclusion matters because the
pinned upstream readiness handler can refresh registered service state when that
environment variable is enabled.

If native sandbox readiness fails, commands return an error. They do not switch
to unrestricted PowerShell, CMD, Bash, or WSL. WSL must be selected explicitly;
it retains the Linux sandbox requirements. Job Objects and process supervision
provide lifecycle cleanup and do not replace the native security boundary.

Native filesystem reads follow Codex's broader root-read boundary, with App
configuration, credentials, and protected workspace paths denied. Narrow read
grants and explicit POSIX resource limits require WSL. The elevated native mode
is supported; the unelevated compatibility mode stays unavailable because it
cannot enforce this App's private-file read restrictions.

## Verification

Run the adapter regression checks from `backend/`:

```sh
node --import tsx --test src/agent/windowsShell.test.ts src/agent/windowsNativeSandbox.test.ts src/agent/codexSandboxClient.test.ts src/run/windowsAgentSettings.test.ts
npm run build
```

These tests cover default PowerShell selection with an empty PATH, explicit WSL
selection, missing-runtime errors without a shell fallback, immutable capability
reads, private control configuration, and the pinned RPC contract. Their mocked
Windows tests can run on macOS and do not prove Windows OS isolation.

For native acceptance, use a disposable real Windows machine and run from the
project root:

```powershell
node desktop/scripts/prepare-codex-runtime.mjs x64
node scripts/windows-native-sandbox-smoke.mjs --allow-setup
```

`--allow-setup` explicitly authorizes provisioning the disposable fixture and any
Windows administrator prompt. Without that flag, a fresh unconfigured fixture
fails before setup. The smoke checks actual PowerShell execution, denied private
reads and outside writes, denied network connections, stdin/EOF, exit codes,
process stop, timeout, and backend-crash cleanup. A non-Windows machine is a
failure rather than a skipped acceptance result. The report is written to
`.artifacts/windows-native-sandbox-smoke/report.json`.

The manually dispatched `windows-native-sandbox.yml` workflow uses an
administrator disposable Windows runner and uploads the report even on failure.
Publishing installers still requires acceptance of the packaged App on the
supported Windows versions and architectures.

## Pinned upstream references

The adapter was checked against the official
[Codex 0.160.0 Windows readiness/setup handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs),
its [registered-core opt-in](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/windows-sandbox-rs/src/app_package.rs),
and its [Windows sandbox implementation](https://github.com/openai/codex/tree/rust-v0.160.0/codex-rs/windows-sandbox-rs).
Upgrade the runtime and these contracts together, with fresh native acceptance.
