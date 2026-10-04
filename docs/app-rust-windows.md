# Windows Agent execution in the Rust desktop App

The Tauri host manages the IDE system services and starts the retained Agent
backend with its own Node runtime. Agent commands on Windows default to the
system PowerShell executable and a pinned CrownForge downstream build of the
Codex native Windows sandbox.
WSL 2 is an explicit selection in desktop execution settings. The integrated
terminal's shell preference does not select the Agent execution environment.

## Offline installation and operation

The desktop App must install and operate without Internet access. Codex is the
reference for execution and sandbox behavior, not the App's model provider or
login service. The retained Agent uses the project's own configurable model
client; offline deployments must supply reachable local or private-network
primary and fallback model services. Local IPC and connections to those services
remain part of the offline deployment; denying network access to sandboxed commands is a separate
execution permission.

The Windows bundle embeds the WebView2 offline installer through Tauri's
`offlineInstaller` mode. It must not use the downloaded or embedded bootstrapper,
both of which require Internet access when WebView2 is missing. See
[Tauri's WebView2 installation options](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options).
The generated installer still needs a real disconnected-machine installation
check; an installed development-machine WebView2 is not proof of that behavior.

Node, Rust IDE services and all sandbox executables are packaged resources.
Missing resources fail explicitly rather than triggering a runtime download.
Fetching source, compiler dependencies and the WebView2 installer belongs to the
build environment. Model weights and their local serving runtime must also be
available in the destination environment before Agent inference. Existing settings
can name remote providers and fallbacks, so a prior online configuration must be
reviewed for offline deployment; no cloud provider is a required dependency.

Git integration currently uses the system Git CLI. Python language/debug tools,
Ruff, Cargo and project-specific compiler/dependency caches are optional offline
environment prerequisites for their respective features. They are not all
included in the App. Desktop Cargo diagnostics use `--offline` with
`RUSTUP_AUTO_INSTALL=0` and report a missing toolchain or unavailable cached
dependencies without trying to fetch
them. Web diagnostics retain their existing command. User-configured external
model/MCP/plugin endpoints must be replaced with reachable local or private
network services for an offline deployment.
The rustup switch prevents the Cargo proxy from automatically installing an
absent workspace toolchain before Cargo can process `--offline`; see
[rustup's environment variables](https://rust-lang.github.io/rustup/environment-variables.html).

The independent Rust IDE service is built with `+crt-static` for both Windows
MSVC targets. The repository-root Cargo configuration covers direct CI
`--manifest-path` builds as well as packaging. Windows CI inspects the built
host/Core PE dependencies and rejects unprovided `VCRUNTIME`, `MSVCP` and
`CONCRT` imports. The host also uses Tauri's static VC runtime defaults; Windows
10+ provides the Universal CRT. Final installed binaries and bundled DLLs still
need inspection during Windows package acceptance.

The wire contract follows Codex **0.160.0** at commit
`a956835d020762cb2b570053af06f643a11c0ecc`. Variant
`crownforge-network-v1` rebuilds the CLI, command runner and setup helper from
that source with the [reviewed downstream patch](../desktop/rust/windows-sandbox-patches/README.md).
These executables are not unmodified official release binaries. Keep the complete
Windows runtime package, including the rebuilt command runner and setup helper, under
`backend/vendor/codex/win-x64` or `backend/vendor/codex/win-arm64` in the packaged
backend resources. Schema 2 `crownforge-codex-runtime.json` records the upstream
commit, verified baseline archive digest, patch digest, build variant and actual
executable hashes. The adapter rejects stock schema 1, mixed patched binaries,
wrong variants and altered files. Missing or altered runtime resources block native
execution. An independent Node runtime replaces Electron's Node mode; it must
remain the backend's `process.execPath` for its supervised internal children.

## Setup and capability reads

Opening execution settings or checking readiness must not create sandbox control
configuration, provision Windows users, modify ACLs or firewall rules, or request
UAC. A new App returns `notConfigured` until the user explicitly selects sandbox
setup. Setup completion and a fresh readiness response are both required before
Agent commands are enabled.

The downstream policy uses CrownForge-specific accounts, groups, locks, service
and registry names, and WFP GUIDs. It does not add broad persistent rules to the
shared Codex Offline account. Setup installs its own persistent TCP/UDP policy
transaction; ordinary readiness and execution check that policy without creating
or repairing it. A missing or unreadable policy requires explicit setup. The
rules remain after an ordinary App/helper crash; uninstall fences the owned
accounts and stops their processes before removing only their protections.

The intended scope is Offline network denial and explicitly selected Online
inherit. Managed proxy and arbitrary local-binding exceptions are unsupported.
Receiver-confirmed Windows tests must establish the effective TCP/UDP boundary;
source checks alone do not establish DNS-service proxying or every Windows build.

The adapter checks an existing App-owned control configuration without rewriting
it. A changed configuration stays on disk and blocks execution until explicit
setup repairs it. The execution-only Codex client does not send model-thread or
login RPCs. Its fixed unauthenticated custom provider skips upstream cloud/model
catalog discovery, and analytics and update checks are disabled. It does not
inherit API keys, Electron Node flags, injection settings,
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
rustup toolchain install 1.95.0 --profile minimal
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
The network/coexistence matrix is restricted to the explicitly authorized
disposable GitHub Actions runner and is executed by the acceptance workflow.

The `APP_RUST` push workflow `app-rust-sandbox.yml` builds all three executables
from the exact upstream commit plus SHA256-pinned patch and uploads reports even
on failure. It preserves the strict smoke, adds IPv4/IPv6 TCP/UDP receiver controls,
explicit inherit/file-boundary checks and original Codex coexistence. It also
launches a real restricted primary-token child to verify that the setup owner can
read policy as a non-administrator without global WFP permission changes.
The separate older `windows-native-sandbox.yml` workflow belongs to the original
native-runtime lane and is not evidence for this patched runtime.
Publishing installers still requires acceptance of the packaged App on the
supported Windows versions and architectures.

## Pinned upstream references

The adapter was checked against the official
[Codex 0.160.0 Windows readiness/setup handler](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/windows_sandbox_processor.rs),
its [registered-core opt-in](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/windows-sandbox-rs/src/app_package.rs),
and its [Windows sandbox implementation](https://github.com/openai/codex/tree/rust-v0.160.0/codex-rs/windows-sandbox-rs).
Upgrade the runtime and these contracts together, with fresh native acceptance.
