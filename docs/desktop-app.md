# CrownForge desktop app

The desktop edition packages the existing frontend and Node backend together. On
each computer, Electron starts the backend on a random `127.0.0.1` port and opens
the local UI. The backend, workspace, settings, users, and installed plugins are
local to that computer. An AI model endpoint is still required for AI features;
configure it in Settings after logging in.

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

The public preview's Windows installers were cross-built on macOS. For a stable
release, rebuild them on Windows and run installation checks on each target OS.
The current installers are not signed or notarized; a stable release also needs
platform signing and malware scanning.

## First launch and local data

On first launch the app creates an `admin` account with a random password and
shows it once. Save the password; the dialog can copy it. The app stores
`users.json`, `app-settings.json`, `workspace/`, and `plugins/` under Electron's
per-user CrownForge data directory. It never copies the repository's development
credentials or settings into an installer. Bundled example plugins are copied to
the per-user plugin directory only when that directory is first created.

On Windows desktop, uploaded chat attachments are stored under the per-user
data directory's `attachments/` folder, partitioned by workspace. Existing
workspace `.history/attachments` blobs are left in place and are not
automatically read or migrated. Keep the user data directory private to the
current OS account, including when setting `CREWFORGE_DESKTOP_DATA_DIR`.

The initial allowed workspace root is the current user's home directory. To
open a project on another drive or volume, close the app, add that path to
`allowedRoots` in the per-user `users.json`, and restart. A malformed
`users.json` blocks startup instead of enabling a default password.

The application listens only on loopback and chooses a free port on each launch.
The local API is unavailable to other computers. The login session is scoped to
that port, so a login may be required again after restarting the app.

## Platform capabilities

The editor, file operations, chat, and local service use the same code as the
Web edition. The integrated terminal prefers `node-pty`; on Windows it falls
back to `cmd.exe` pipes if a native PTY cannot start. In that fallback, terminal
resize and some interactive console programs are limited. Git and Python tools
require Git and Python to be installed on the computer and available on `PATH`.

Agent shell commands remain blocked on Windows: the current hard filesystem and
network isolation helpers use macOS Seatbelt or Linux bubblewrap, and Windows
has no equivalent implementation in this project. File read/write/edit tools
remain available. Do not remove that block merely to make shell commands run.

For Windows 7 acceptance, install the legacy package on Windows 7 SP1 x64 and
check first-run account creation, login, file open/save, chat with a configured
model, terminal fallback, Git operations (when Git is installed), app restart,
and uninstall. Repeat the same checks on Windows 10, Windows 11, and both macOS
architectures; verify that the backend stops after the window closes.
