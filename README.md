# AI IDE

A fully offline, self-hosted, web-based AI-powered IDE featuring a code editor, integrated terminal, AI coding assistant, and multi-agent collaboration — all running in a single Docker container.

**No cloud dependencies. No data leaves your network.** Connect any OpenAI-compatible LLM (vLLM, Ollama, LocalAI, etc.) and get a private Cursor/Windsurf alternative you fully control.

[中文文档](README_zh.md)

![Login](docs/screenshots/login.png)
![IDE](docs/screenshots/ide.png)

## Features

- **100% Offline & Self-Hosted** — No internet required at runtime; all data stays on your infrastructure. Ideal for air-gapped environments, enterprise use, and sensitive codebases
- **OpenAI-Compatible API** — Works with vLLM, Ollama, LocalAI, DeepSeek, OpenAI, or any OpenAI-compatible LLM endpoint — swap models without changing code
- **Monaco Code Editor** — Full-featured editor with syntax highlighting, IntelliSense, and multi-tab support
- **AI Coding Assistant** — Chat with an AI agent that can read, write, edit files, and run shell commands in your workspace
- **Integrated Terminal** — Full PTY terminal (xterm.js) with Conda pre-installed
- **File Explorer** — Tree-view file browser with create, rename, delete, and "Open Folder" (switch workspace at runtime)
- **Multi-User Auth** — Login page with username/password, managed via a simple `users.json` config file; each user gets isolated sessions (separate workspace, terminal, AI context)
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

### User Management

Users are managed via `users.json` at the project root:

```json
{
  "allowedRoots": ["/workspace", "/home"],
  "users": [
    { "username": "admin", "password": "admin123", "defaultWorkspace": "/workspace" },
    { "username": "alice", "password": "securepass", "defaultWorkspace": "/workspace/alice" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `allowedRoots` | Directory prefixes users are allowed to open via the folder browser |
| `username` | Login username |
| `password` | Login password |
| `defaultWorkspace` | The workspace directory opened after login |

To add a user, append an entry to the `users` array and restart the backend.

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
│       ├── routes/          # REST API (files, auth)
│       └── ws/              # WebSocket handlers (chat, terminal)
├── frontend/                # React + Vite SPA
│   └── src/
│       ├── components/      # Sidebar, Editor, ChatPanel, Terminal, etc.
│       └── hooks/           # useAuth, useChat, useFileSystem
├── users.json               # User credentials & allowed paths
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
