# APP_RUST installation and first use

This guide describes the Tauri desktop package on the `APP_RUST` branch. The
Electron commands in `desktop-app.md` describe the legacy package. Web deployment
and its system dependencies retain their existing behavior.

中文说明：[APP_RUST 安装与首次使用](desktop-rust-installation.zh-CN.md)。

## Application runtime

The desktop installer contains the frontend and its Monaco workers, a standalone
Node runtime for the retained local services, the Rust IDE service, Git and its
runtime libraries, plugins, and the pinned Windows execution adapter. Windows
NSIS embeds Microsoft's complete WebView2 offline installer. Installation and
ordinary IDE startup do not download these components or require Node, Rust,
Git, Bash, WSL, a Codex account, or an AI model to be installed separately.

Windows native execution and the integrated terminal use Windows PowerShell.
The private shell shipped inside MinGit is used by Git helpers; it does not
change the Agent execution environment. WSL2 remains an explicit optional choice
with its own Linux requirements. macOS uses the operating system's shell and
libraries; the supported floor is macOS 13. Windows targets Windows 10/11 x64;
Windows 7 is outside this Tauri package's supported targets.

Open the installed App, choose a local folder, and use the editor, file search,
Git view, and terminal. The host creates private local user data and a local
session. A model service that is unavailable does not block these IDE features.

## User configuration

AI conversation and Agent features use the model endpoint, model name, and
credentials configured by the user in Settings. For a disconnected installation,
provide a local or otherwise available offline model service and its model
weights separately. The App does not require a particular model provider and
does not ship model weights or start inference automatically.

Windows Agent commands additionally need one explicit sandbox initialization
from **Settings → General → Desktop app → Set up Windows sandbox**. This may
show the operating system's administrator prompt. Routine startup and readiness
checks do not perform this privileged setup. Cancellation or a failed check
leaves Agent command execution blocked; it does not block the editor and does
not switch silently to WSL or an unrestricted shell.

Project builds, language runtimes, debuggers, package managers, and dependencies
remain properties of each project. For example, a Python project needs its
interpreter and packages, and an npm project needs npm and its dependencies.
The App's internal Node service is not a replacement for every project's chosen
toolchain. In an offline environment, bring those project dependencies with the
project or configure the appropriate local toolchain.

## Package preparation

Build on the target operating system and CPU architecture. The packaging tools
need Node 22 LTS, Rust, their cached or downloadable build dependencies, and a
compatible standalone Node executable. These are build-machine requirements,
not end-user requirements. The Windows SDK is built from the pinned source and
CrownForge patch, or restored only from a fully accepted, digest-verified CI
artifact. Git downloads are pinned by SHA-256 and packaged as a complete runtime.

```sh
npm --prefix backend ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
npm --prefix desktop/rust ci --ignore-scripts
npm --prefix desktop/rust run package -- --bundles app # macOS
```

On Windows, select `--bundles nsis`. A standalone Node runtime can be selected
with the absolute `CROWNFORGE_NODE_EXECUTABLE` build setting. macOS packaging
preserves Git's internal relative symlinks. Ordinary local macOS packages receive
an ad-hoc resource seal; distribution signing/notarization uses explicit Apple
configuration. An ad-hoc seal is not Developer ID signing or notarization.

## Evidence and release boundary

See `app-rust-migration-status.md` for verified revisions and CI results. A
Windows runner with WebView2 already installed does not demonstrate disconnected
installation on a clean Windows machine without WebView2. Full target-system
acceptance must retain that distinction. A protocol-fixture model test verifies
the App's local transport, not a user's model weights or inference installation.

Git runtime receipts preserve executable and companion-file hashes, licensing
materials, and source provenance. The macOS build includes the matching Git
source archive and recipe. Windows third-party source links alone must not be
described as a complete corresponding-source companion for distribution.
