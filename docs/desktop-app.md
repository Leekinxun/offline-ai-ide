# CrownForge remote desktop client · v1.1.1 preview

The browser and desktop client connect to the same CrownForge server and load
that server's frontend. Projects, Git, terminals, Agent runs, model access, MCP,
accounts, and conversation history belong to the server. The desktop app provides
a native window, server connection settings, and bounded native UI integrations.
It does not start a local backend or create a local administrator account.

This is an intentional product difference from Codex's local execution model:
CrownForge's desktop client controls server-side work. Server execution,
approvals, sandboxing, and explicit task cancellation retain their existing
contracts.

## Connect and sign in

1. Deploy the normal Web server and confirm that its address works in a browser.
2. Start the desktop app and enter the same root URL, for example
   `https://ide.example.com` or `http://192.168.1.20:9798`.
3. Sign in on the server's ordinary login page with your server account.

Use a complete HTTP or HTTPS root URL. Credentials in URLs, query strings,
fragments, and subpaths such as `/crownforge` or `/login` are rejected. The shared
frontend uses absolute API and WebSocket routes, so a reverse proxy must serve
CrownForge at the selected origin's root and forward WebSocket upgrades.
Internal HTTP endpoints are supported. HTTPS uses the operating system/Electron
certificate validation; invalid or untrusted certificates are not bypassed.
Install your organization's CA through its normal trust policy when needed.

The app remembers the last selected server. Use the application menu's server
connection entry, or the workbench connection settings, to change it. If an
initial page load fails, the connection screen remains available with retry and
address controls. Load retries use a bounded backoff; an already loaded workbench
uses the shared frontend's WebSocket reconnection and run subscription logic.
Connecting or reconnecting does not submit the task again.

Each server origin has its own persistent Electron session partition. Cookies,
login tokens, and server frontend storage are separated across origins; browser
and desktop logins are separate client sessions even when they use the same
server account. The connection configuration stores the server URL, not a server
password. Remote pages have no Node integration or unrestricted local file or
command bridge.

## Task and connection lifecycle

| Event | Behavior |
| --- | --- |
| Network interruption or page reload | The workbench reconnects and subscribes to the existing conversation/run; it restores server state. |
| Close the desktop client or browser | The client disconnects. Server-owned Agent runs continue while the server is running. |
| Reopen the client | Connect and sign in if required, then reopen the conversation to see its current state. |
| Explicit Stop in the workbench | The authenticated request stops the selected run under the normal server rules. |
| Server process stops or restarts | This interrupts server execution. Existing durable history/recovery rules apply; the client cannot keep a stopped server running or automatically restart commands. |

An Agent waiting for approval or a question remains waiting until an authorized
client responds. Terminal reconnection and retention follow the server's terminal
policy; closing a client is not a guarantee of indefinite PTY retention.

## Data, workspaces, and tools

The desktop user-data directory holds connection settings, native preferences,
and per-server browser sessions. Project files, server users/settings, plugins,
Git credentials, model credentials, and execution tools remain on the server.
Choosing a workspace means choosing a directory on the server. Upload/download
are the explicit way to exchange local files with it.

Client computers do not need Git, Python, Node.js/npm, ripgrep, PTY bindings,
Agent sandbox helpers, or model runtimes installed. Install the tools and
project dependencies required by your workflows on the server. An offline
installation works when the client can reach the server and all configured
server dependencies are available on the permitted internal network.

Earlier desktop previews started a local backend and stored projects and
accounts in the desktop user-data directory. This client does not delete or
automatically migrate that data. Back up the old data and transfer the intended
projects and configuration to your server deliberately; local administrator
credentials are not imported as server credentials.

## Targets and build

| Package command | Target | Runtime |
| --- | --- | --- |
| `npm run package:win-x64` | Windows 10/11 x64 | Electron 44 |
| `npm run package:win7-x64` | Windows 7 SP1 x64 | Electron 22 legacy build |
| `npm run package:mac-arm64` | macOS 13+ Apple silicon | Electron 44 |
| `npm run package:mac-x64` | macOS 13+ Intel | Electron 44 |

Use Node.js 22.12 or later to run the build tools. macOS packages require macOS;
Windows native packages require Windows. The client has no native server modules,
so the build host's CPU architecture does not need to match the target. macOS can
also create Windows packages with `package:win-x64-cross` and
`package:win7-x64-cross`; these outputs still require target-OS acceptance.

```sh
cd desktop
npm ci
npm test
npm run package:mac-arm64
# Optional unpacked application for a local smoke check:
npm run package:mac-arm64 -- --dir
```

Only the client shell and connection screen are packaged. There is no bundled
copy of the workbench frontend, backend, plugins, local accounts, ripgrep, PTY
module, or Agent execution runtime. The packaging script checks the actual
`app.asar` contents and rejects unexpected resources. Normal package commands
produce an installer and ZIP under `desktop-dist/<target>/`, with a matching
`.sha256` file for each artifact. A `--dir` build creates only an unpacked app.

On macOS, run `shasum -a 256 -c <installer>.sha256`. On Windows, use
`certutil -hashfile <installer>.exe SHA256` and compare it with the checksum from
the same release. Installers remain unsigned and macOS builds are not notarized.

Windows 7 uses Electron 22, the final Electron line for that OS; its Chromium
and Node runtimes are no longer security-maintained. Keeping the legacy build
target does not establish current server-frontend compatibility or installation
acceptance. See [Electron's platform notice](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice).

## Verification and release boundary

The packaging workflow separately checks the shared server/frontend and the
remote client. Platform packaging jobs install only desktop build dependencies;
they do not prepare local server tools or execution sandboxes. Automated client
and package tests cover URL/IPC boundaries, server-specific state, reconnect
behavior, required shell resources, and rejection of server data in packages.

Before release, test each target OS with a real server: first connection, normal
and rejected login, server switching, network loss and recovery, expired login,
TLS failures, editor and upload/download operations, isolated windows, preview
links, native preferences, and uninstall. Start an Agent run, close the client,
confirm server-side progress from the browser, then reopen and recover the same
run without duplicating it. Also verify the distinct server-restart behavior.
Source tests and successful builds do not replace these platform installation
and runtime acceptance results.

For a repeatable local smoke check, install the backend/frontend development
dependencies and build the shared frontend, then run from the repository root:

```sh
node scripts/remote-desktop-smoke.mjs
# Or exercise an unpacked macOS client:
node scripts/remote-desktop-smoke.mjs --app desktop-dist/mac-arm64/mac-arm64/CrownForge.app
```

The script starts its own disposable server, scripted loopback model, and desktop
profile. It checks server selection, normal login, WebSocket recovery, completion
after client exit, temporary authentication failure, and persistent login on
relaunch. Screenshots and a JSON report are written to
`.artifacts/remote-desktop-smoke/`. It does not use existing user profiles or a
paid model. The previous `scripts/desktop-smoke.mjs` command forwards to this
remote-client check.
