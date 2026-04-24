# AI IDE

<p align="center">
  <img src="frontend/public/favicon.svg" width="88" alt="AI IDE logo" />
</p>

> Current Version: `v0.4.0`
>
> Release Date: `2026-04-24`

A fully offline, self-hosted, web-based AI-powered IDE featuring a code editor, integrated terminal, AI coding assistant, and multi-agent collaboration — all running in a single Docker container.

**No cloud dependencies. No data leaves your network.** Connect any OpenAI-compatible LLM (vLLM, Ollama, LocalAI, etc.) and get a private Cursor/Windsurf alternative you fully control.

[中文文档](README_zh.md)

![Login](docs/screenshots/login.png)
![IDE](docs/screenshots/ide.png)

## Release Notes

### v0.4.0 · 2026-04-24

- Added a lightweight **plugin system** with builtin and external plugins, offline installation from the local `plugins/` directory, permissions/scopes, and an in-app plugin manager
- Moved **Monaco highlighting** and **chat Markdown rendering** into builtin plugins, and shipped **Markdown file preview** as a real external sample plugin under `plugins/markdown-file-preview`
- Added builtin **interface localization** with English / Simplified Chinese switching in Settings, plus dark-theme-aware Monaco editor theming
- Added per-workspace **chat history persistence** under `.history/`, including history browsing, continue-chat support, LLM-generated conversation titles, and automatic pruning to the 5 most recent conversations

### v0.3.2 · 2026-04-24

- Expanded **Python semantic highlighting** with multi-line assignment targets, `with` aliases, `for` targets, `lambda` parameters, comprehension bindings, `global` / `nonlocal`, and `except*` aliases
- Refined **TypeScript / React / Vue** editor highlighting by expanding Monaco token theme coverage for semantic token types and embedded component syntax
- Added manual editor regression samples under [`docs/editor-samples/`](docs/editor-samples/README.md) for Python, TypeScript, React, and Vue

### v0.3.1 · 2026-04-23

- Extended **Ctrl/Cmd + left click** navigation with a workspace-aware definition lookup path, improving symbol jumps for Python, Vue, React, and other cross-file flows
- Added **Max Tokens** to the in-app **Admin Settings** panel so administrators can manage request limits without editing environment variables
- Fixed an editor regression where **Ctrl/Cmd + S** could save stale content because Monaco actions were holding outdated callbacks

### v0.3.0 · 2026-04-22

- Added an in-app **Admin Settings** panel for creating users, deleting users, resetting passwords, and updating the LLM endpoint / API key / model without restarting the service
- Added **file and folder downloads** from the left file tree; folders are streamed as `.zip`
- Added **batch delete** in the file tree with multi-select support
- Added **Ctrl/Cmd + left click** code navigation in the editor for jumping to symbol definitions within the current file and already-open tabs
- Fixed the **Copy** action on AI code blocks with a clipboard fallback for environments where `navigator.clipboard` is unavailable

## Versioning

This repository now documents releases in a lightweight GitHub-style changelog format.
`v0.4.0` is the current documented release and adds the plugin system, builtin localization, dark-theme Monaco improvements, and persisted chat history on top of the `v0.3.x` feature set.

## Features

- **100% Offline & Self-Hosted** — No internet required at runtime; all data stays on your infrastructure. Ideal for air-gapped environments, enterprise use, and sensitive codebases
- **OpenAI-Compatible API** — Works with vLLM, Ollama, LocalAI, DeepSeek, OpenAI, or any OpenAI-compatible LLM endpoint — swap models without changing code
- **Monaco Code Editor** — Full-featured editor with syntax highlighting, deeper Python semantic highlighting, richer TypeScript/React/Vue token coloring, IntelliSense, multi-tab support, reliable Ctrl/Cmd-click symbol navigation, and fixed Ctrl/Cmd+S save behavior
- **Plugin System** — VS Code-style lightweight plugin mode with builtin and external plugins, explicit permissions/scopes, offline install from `plugins/`, an in-app plugin manager, and a shipped Markdown preview example plugin
- **AI Coding Assistant** — Chat with an AI agent that can read, write, edit files, and run shell commands in your workspace
- **Persistent Chat History** — Each workspace stores conversation history in `.history/` as `.jsonl` files, supports continue-chat flows, and keeps only the 5 most recent conversations
- **Integrated Terminal** — Full PTY terminal (xterm.js) with Conda pre-installed
- **File Explorer** — Tree-view file browser with create, rename, download, batch delete, folder-as-zip download, and "Open Folder" (switch workspace at runtime)
- **Admin Settings Panel** — Manage users, reset passwords, update LLM URL / API key / model / max tokens from the UI, and switch interface language between English and Simplified Chinese
- **Multi-User Auth** — Login page with username/password, backed by `users.json` and the in-app admin settings panel; each user gets isolated sessions (separate workspace, terminal, AI context)
- **Multi-Agent Collaboration** — Spawn autonomous AI teammates that can claim tasks, communicate via message bus, and work in parallel
- **Task Board** — Create, assign, and track tasks across agents
- **Docker Ready** — Multi-stage Dockerfile with Node.js, Python, Conda, Git, and common dev tools pre-installed

## Quick Start

### Docker (Recommended)

```bash
docker build -t ai-ide .

docker run -d --name ai-ide \
  -p 3000:3000 \
  -v ./workspace:/workspace \
  -v ./users.json:/app/users.json \
  -e VLLM_API_URL=http://your-llm-server:8000/v1 \
  -e VLLM_API_KEY=your-api-key \
  -e MODEL_NAME=your-model-name \
  ai-ide
```

Or use Docker Compose:

```bash
# Edit docker-compose.yml with your LLM endpoint
docker compose up -d
```

Then open http://localhost:3000 and log in.
Sign in as an admin user and use the top-right **Settings** button to manage users and configure the LLM endpoint.

### Docker Compose

```yaml
services:
  ai-ide:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./workspace:/workspace
      - ./users.json:/app/users.json  # optional: override user config
    environment:
      - VLLM_API_URL=http://host.docker.internal:8000/v1
      - VLLM_API_KEY=
      - MODEL_NAME=default
      - WORKSPACE_DIR=/workspace
      - MAX_AGENT_ITERATIONS=30
      - AGENT_MAX_TOKENS=8192
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### Local Development

```bash
# Backend
cd backend
npm install
WORKSPACE_DIR=../workspace npm run dev

# Frontend (in another terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 (Vite dev server proxies API requests to the backend).

In local development, admin-managed LLM settings are persisted to `app-settings.json` at the project root by default.
`users.json` is also auto-detected from the project root by default, and each workspace stores its own chat history under `<workspace>/.history/`.

### Editor Highlighting Samples

Open the files under [`docs/editor-samples/`](docs/editor-samples/README.md) in the IDE when you want a quick manual regression pass for editor highlighting. The sample set currently covers Python semantic bindings, TypeScript semantics, React TSX, and Vue `<script setup lang="ts">` flows.

### Plugin System

The frontend now supports a lightweight plugin architecture inspired by VS Code:

- Builtin plugins ship inside the app bundle and can be enabled/disabled from Settings
- External plugins are discovered from the local `plugins/` directory and installed fully offline
- Plugins declare explicit permissions and derived scopes before activation
- Editor highlighting and chat Markdown rendering are implemented as builtin plugins
- Markdown file preview ships as a working external sample plugin in `plugins/markdown-file-preview/`

Open a Markdown file in the IDE to use the preview toolbar with `Edit`, `Preview`, and `Split` modes.

See [`docs/plugins/README.md`](docs/plugins/README.md) for the plugin manifest format, host APIs, permissions, and offline installation flow.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VLLM_API_URL` | `http://host.docker.internal:8000/v1` | OpenAI-compatible API endpoint |
| `VLLM_API_KEY` | *(empty)* | API key for the LLM endpoint |
| `MODEL_NAME` | `default` | Model name to use |
| `WORKSPACE_DIR` | `/workspace` | Default workspace directory |
| `PORT` | `3000` | Server port |
| `MAX_AGENT_ITERATIONS` | `30` | Max tool-use rounds per AI response |
| `AGENT_MAX_TOKENS` | `8192` | Max tokens per AI response |
| `USERS_CONFIG` | *(auto-detect)* | Path to `users.json` |
| `APP_SETTINGS_CONFIG` | *(auto-detect)* | Path to `app-settings.json` for admin-managed LLM settings |

### Runtime Settings Files

| File | Purpose |
|------|---------|
| `users.json` | Stores users, passwords, admin flags, and allowed workspace roots |
| `app-settings.json` | Stores admin-managed LLM runtime settings such as URL, API key, model, and max tokens |
| `<workspace>/.history/*.jsonl` | Stores per-workspace chat conversations, generated titles, and message history |

If you run with Docker and want admin changes to survive container recreation, persist these files with bind mounts or a volume-backed path.
For local development, the default `users.json` and `app-settings.json` locations are the project root.

### User Management

Users can be managed in two ways:

- Preferred: log in as an admin user and open the in-app **Settings** panel to create users, delete users, or reset passwords
- Alternative: edit `users.json` manually at the project root (or the path pointed to by `USERS_CONFIG`)

Example `users.json`:

```json
{
  "allowedRoots": ["/workspace", "/home"],
  "users": [
    { "username": "admin", "password": "admin123", "defaultWorkspace": "/workspace", "isAdmin": true },
    { "username": "alice", "password": "securepass", "defaultWorkspace": "/workspace/alice", "isAdmin": false }
  ]
}
```

| Field | Description |
|-------|-------------|
| `allowedRoots` | Directory prefixes users are allowed to open via the folder browser |
| `username` | Login username |
| `password` | Login password |
| `defaultWorkspace` | The workspace directory opened after login |
| `isAdmin` | Whether the user can open the admin settings panel |

If you edit `users.json` outside the app, restart the backend to reload it. Changes made from the admin settings UI are applied immediately.

### LLM Management

LLM runtime settings can be managed in two ways:

- Preferred: use the admin **Settings** panel in the UI
- Alternative: provide `VLLM_API_URL`, `VLLM_API_KEY`, `MODEL_NAME`, and `AGENT_MAX_TOKENS` via environment variables

When settings are changed from the UI, they are written to `app-settings.json` and new AI requests will use the updated values immediately.

### Conversation History

- Chat history is persisted per workspace inside `.history/`
- Each conversation is stored as one `.jsonl` file
- New conversations receive an LLM-generated short title when possible
- The history browser in the chat panel lets users continue earlier conversations
- Only the 5 most recent conversations are retained automatically to prevent unbounded growth

## Architecture

```
ai-ide/
├── backend/                 # Express + WebSocket server
│   └── src/
│       ├── agent/           # AI agent loop, tools, prompt, task system
│       │   ├── loop.ts      # LLM call loop with tool execution
│       │   ├── tools.ts     # Agent tools (bash, file I/O, tasks, teammates)
│       │   ├── systemPrompt.ts
│       │   ├── taskManager.ts
│       │   ├── messageBus.ts
│       │   └── teammateManager.ts
│       ├── auth/            # Session management & middleware
│       ├── chat/            # Conversation history persistence & title generation
│       ├── routes/          # REST API (files, auth)
│       ├── plugins/         # Plugin manifest validation & registry
│       └── ws/              # WebSocket handlers (chat, terminal)
├── frontend/                # React + Vite SPA
│   └── src/
│       ├── components/      # Sidebar, Editor, ChatPanel, Terminal, etc.
│       ├── i18n/            # UI localization provider and message bundles
│       ├── plugins/         # Frontend plugin runtime and builtin plugins
│       └── hooks/           # useAuth, useChat, useFileSystem
├── plugins/                 # Offline-installable external plugins
├── users.json               # User credentials & allowed paths
├── app-settings.json        # Persisted admin-managed LLM settings
├── Dockerfile               # Multi-stage build (Node + Conda + tools)
└── docker-compose.yml
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Editor | Monaco Editor |
| Terminal | xterm.js + node-pty |
| Frontend | React 18, Vite, TypeScript |
| Backend | Express, WebSocket (ws), TypeScript |
| AI | OpenAI-compatible API (tool-use agent loop) |
| Runtime | Node.js 20, Python 3, Miniconda |

## AI Agent Capabilities

The AI assistant can:

- **Read / write / edit files** in your workspace
- **Run shell commands** via the integrated terminal
- **Manage tasks** — create, update, and track a task board
- **Spawn teammates** — create autonomous sub-agents with specific roles
- **Collaborate** — agents communicate via a message bus and can claim tasks

### Agent Tools

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands (dangerous patterns blocked) |
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace in existing files |
| `TodoWrite` | Update the in-chat task checklist |
| `task_create` | Create a persistent task |
| `task_update` | Update task status |
| `spawn_teammate` | Launch an autonomous AI teammate |
| `send_message` | Send a message to a teammate |
| `broadcast` | Message all active teammates |

## License

MIT
