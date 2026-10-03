# CrownForge desktop app · v1.1.1 preview

The desktop edition packages the existing frontend and Node backend together. On
each computer, Electron starts the backend on a random `127.0.0.1` port and opens
the local UI. The backend, workspace, settings, users, and installed plugins are
local to that computer. An AI model endpoint is still required for AI features;
configure it in Settings after the workbench opens.

## Synced Web features

The desktop package builds the current shared frontend and backend. Version
1.1.1 includes the latest workbench docks, adjustable panels, unified selection
menus, settings layout, and global interface zoom. Editor tabs support path
copying and grouped closing; Markdown preview, split editing, and two-file
comparison retain linked scrolling.

The AI task view and editor collaboration panel share the composer draft.
Inline AI proposals apply to the selected editor content with version checks.
Use `@` to attach files, directories, symbols, selected text, Problems, or terminal
context, and inspect context sources from the context indicator. Agent changes
can be reviewed by hunk, file, or whole run, with keep-all controls and turn undo.

The terminal supports up to eight named tabs and bounded reconnection to the
same running process after a transport interruption or page reload. Long Agent
runs preserve goals and corrections through context compaction, and show
server-recorded execution facts and verification evidence. Closing the app also
stops its backend: PTY recovery does not survive that restart. Interrupted Agent
runs can be continued from their saved record after reopening the app, but
continuation requires the user to choose **Resume**; startup does not automatically
restart commands or AI requests.

The top-bar Web Preview can start supported static or Vite targets, inspect
elements, return feedback to the Agent, and navigate to source candidates. It
uses the local backend and a sandboxed frame. External preview links open through
the desktop host's validated link handling. Preview links are temporary; create
a fresh link when an old one expires. Vite execution and previewing a project's
configuration retain their approval boundaries.

Desktop appearance preferences use the per-user native preference store so
changing the local backend port does not reset them after an app restart. The
interface zoom controls and keyboard shortcuts share the same setting.

## Targets

| Package command | Target | Runtime |
| --- | --- | --- |
| `npm run package:win-x64` | Windows 10/11 x64 | Electron 44 |
| `npm run package:win7-x64` | Windows 7 SP1 x64 | Electron 22 legacy build |
| `npm run package:mac-arm64` | macOS 13+ Apple silicon | Electron 44 |
| `npm run package:mac-x64` | macOS 13+ Intel | Electron 44 |

Windows 7 requires a separate installer because Electron 22 is the final
version that runs there. Its Chromium and Node versions are no longer supported
upstream. The legacy package also pins ripgrep 13, built before Rust changed
the default Windows target to require Windows 10. The Windows 7 package must be tested on a real Windows 7 SP1 x64
machine before a stable release; building it on a current Windows host alone does not
prove Windows 7 compatibility. See [Electron's platform notice](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice).

## Build

Use Node.js 22.12 or later to run the packaging tools. Build macOS packages on
a Mac with the matching CPU architecture, and build both Windows packages on a
current Windows x64 computer (the CI runner uses Windows Server 2022). Do not
run the build tools on Windows 7. This ensures `node-pty` and ripgrep are
installed and rebuilt for the correct platform. The package script builds the frontend and backend,
installs only backend production dependencies into a temporary staging folder,
rebuilds native dependencies against the selected Electron version, then creates
an installer and a ZIP archive under `desktop-dist/<target>/`.

Before packaging, the CI workflow checks the desktop host, local-session and
loopback boundaries, interrupted-run recovery, and shared editor/terminal
policies with isolated temporary user data. It also runs frontend and backend
type/build checks, UI contracts, and the frontend bundle budget. These gates
prepare a preview package; they do not replace the target-system checks below.

The Windows 7 build downloads Microsoft's archived ripgrep 13 binary at build
time and verifies its SHA-256 hash before packaging. The installed app itself
does not download that binary.

For a provisional Windows package on a Mac, `npm run package:win-x64-cross` and
`npm run package:win7-x64-cross` create NSIS installers and ZIP archives in
`desktop-dist/*-cross/`. This path installs Windows ripgrep binaries but omits
the native `node-pty` module, so the terminal uses its limited `cmd.exe` pipe
fallback. These artifacts have only static package checks; build them again on
Windows and test them on the target OS before a stable release.

```bash
cd backend && npm ci
cd ../frontend && npm ci
cd ../desktop && npm ci
npm run package:mac-arm64   # or another target from the table
```

Early 1.1.0 preview installers were cross-built on macOS. The current workflow
builds Windows packages on a Windows runner; each target OS still needs its own
installation checks.
The current installers are not signed or notarized; a stable release also needs
platform signing and malware scanning.

## First launch and local data

On first launch the app creates a local `admin` account with a random password.
The desktop host uses a local session to enter the workbench without a separate password login on
normal launches. Web login remains separate. The app stores
`users.json`, `app-settings.json`, `preferences.json`, `workspace/`, and `plugins/` under Electron's
per-user CrownForge data directory. It never copies the repository's development
credentials or settings into an installer. Bundled example plugins are copied to
the per-user plugin directory only when that directory is first created.

On Windows desktop, uploaded chat attachments are stored under the per-user
data directory's `attachments/` folder, partitioned by workspace. Existing
workspace `.history/attachments` blobs are left in place and are not
automatically read or migrated. Keep the user data directory private to the
current OS account, including when setting `CREWFORGE_DESKTOP_DATA_DIR`.

Use **Open Folder** in the file explorer or welcome screen to choose any local
project directory with the operating system's folder picker, including a
different drive or volume. The selected directory becomes that user's workspace
and is restored after restarting. If the directory is temporarily unavailable
at login, that session opens the built-in workspace; a later login restores the
project once the directory is available again. Existing
Web sessions keep their configured workspace boundaries. A malformed `users.json`
blocks startup instead of enabling a default password.

The application listens only on loopback and chooses a free port on each launch.
The local API is unavailable to other computers. The desktop host establishes a
new local session when it restarts; stored browser tokens are not portable
credentials. Mobile remote control remains a Web deployment feature: the
desktop listener stays on loopback and the mobile-pairing entry is hidden.

## Platform capabilities

The editor, file operations, chat, and local service use the same code as the
Web edition. The integrated terminal prefers `node-pty`; on Windows it falls
back to `cmd.exe` pipes if a native PTY cannot start. In that fallback, terminal
resize and some interactive console programs are limited. Git operations require
Git on `PATH`. Python tools require a local Python installation and the project's
Python dependencies. Python debugging additionally requires `debugpy` in the
configured interpreter. Project npm tasks and Vite previews require local Node.js,
npm, and the project's installed dependencies; the bundled Electron backend
does not install these project tools or packages for you.

On Windows 10/11, Agent shell commands use Bash inside WSL2. Install a WSL2
Linux distribution with Bash, bubblewrap, and Node.js 18 or later at
`/usr/bin/node`, and configure its default user as a regular, non-root user.
The App uses the system's default WSL distribution unless the backend's
`CROWNFORGE_WSL_DISTRO` environment variable selects another installed
distribution. The Windows desktop and file tools keep using the same workspace;
the execution adapter maps a supported NTFS workspace into WSL for command
execution.

Agent commands require a **case-sensitive NTFS workspace** so differently cased
filenames cannot bypass the Linux filesystem isolation rules. Prepare a new,
empty NTFS project directory and enable case sensitivity from an administrator
PowerShell before copying the project into it:

```powershell
fsutil.exe file setCaseSensitiveInfo "C:\path\project" enable
```

Follow [Microsoft's case-sensitivity guidance](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity)
before migrating an existing, populated directory; do not simply change its
flags in place. The App checks this requirement and never changes directory
flags itself. Linux filesystem workspaces accessed through WSL UNC paths have
not yet been validated for this adapter.

Installing WSL alone does not enable Agent commands. The App first checks the
Linux execution environment and its filesystem and network isolation; commands
remain unavailable if that check fails. Open Settings to see the WSL execution
service status and check it again after changing the distribution. A ready
service does not guarantee that the selected workspace meets the separate
case-sensitivity and path checks. WSL does not provide
an unrestricted fallback when bubblewrap cannot establish isolation. Windows 7
does not support WSL and keeps Agent shell commands disabled. File read/write/edit
tools, the manual terminal, and Web preview remain available on all Windows
targets. The manual terminal continues to use its native Windows terminal path.

For native Windows acceptance, build the backend and run
`node scripts/windows-wsl-smoke.mjs` from the repository root in an administrator
terminal after preparing WSL2. This test only sets case sensitivity on its own
disposable directories and uses isolated configuration. It verifies Bash,
Node/npm, read-only queries, private-file and network isolation, interactive
input, and cancellation through the actual Windows execution adapter. Results
are saved in `.artifacts/windows-wsl-smoke/report.json`.

`node scripts/wsl-helper-linux-smoke.mjs` tests the Linux helper in a disposable
Docker fixture with Bash, Node, npm, and bubblewrap. Its report explicitly
excludes native Windows, WSL transport, and DrvFS acceptance.
Prepare the fixture image with:

```sh
docker build -f scripts/fixtures/wsl-helper-linux.Dockerfile -t crewforge-wsl-helper-test:local scripts/fixtures
```

Before target-system acceptance, install the matching package and check
first-run account creation, direct workbench entry, file open/save, Inline AI,
context references, hunk/file/run review, chat with a configured model,
multi-terminal operation, preferences after restart, explicit interrupted-run
continuation, preview and external links, Git operations (when Git is installed),
and uninstall. On Windows also check the terminal fallback. Repeat on Windows 7
SP1 x64, Windows 10, Windows 11, and both macOS architectures; verify that the
backend stops after the window closes. A successful build or automated local
fixture check does not establish installation and runtime acceptance on every
target OS.
