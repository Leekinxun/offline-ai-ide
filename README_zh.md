# AI IDE

完全离线、可私有化部署的 Web AI 集成开发环境，集代码编辑器、集成终端、AI 编程助手和多智能体协作于一体，一个 Docker 容器即可运行。

**无需联网，数据不出内网。** 接入任意 OpenAI 兼容的大模型（vLLM、Ollama、LocalAI 等），即可拥有完全自主可控的 Cursor / Windsurf 替代方案。

[English](README.md)

![Login](docs/screenshots/login.png)
![IDE](docs/screenshots/ide.png)

## 功能特性

- **100% 离线 & 私有化部署** — 运行时无需联网，所有数据留在你的基础设施内。适用于内网隔离环境、企业部署和敏感代码场景
- **兼容 OpenAI API** — 支持 vLLM、Ollama、LocalAI、DeepSeek、OpenAI 等任何 OpenAI 兼容接口，切换模型无需改代码
- **Monaco 代码编辑器** — 支持语法高亮、智能提示、多标签页的全功能编辑器
- **AI 编程助手** — 与 AI 智能体对话，它可以读取、编写、编辑文件，并在工作区内执行 Shell 命令
- **集成终端** — 基于 xterm.js 的全功能 PTY 终端，预装 Conda
- **文件浏览器** — 树形文件管理，支持新建、重命名、删除，以及"打开文件夹"功能（运行时切换工作区）
- **多用户认证** — 登录页面支持用户名/密码认证，通过 `users.json` 配置文件管理；每个用户拥有独立会话（独立的工作区、终端、AI 上下文）
- **多智能体协作** — 可生成自主运行的 AI 队友，它们能认领任务、通过消息总线通信、并行工作
- **任务看板** — 创建、分配、跟踪跨智能体任务
- **Docker 就绪** — 多阶段构建，预装 Node.js、Python、Conda、Git 及常用开发工具

## 快速开始

### Docker 部署（推荐）

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

或使用 Docker Compose：

```bash
# 编辑 docker-compose.yml，配置你的 LLM 端点
docker compose up -d
```

然后打开 http://localhost:3000 并登录。

### Docker Compose

```yaml
services:
  ai-ide:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./workspace:/workspace
      - ./users.json:/app/users.json  # 可选：覆盖用户配置
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

### 本地开发

```bash
# 后端
cd backend
npm install
WORKSPACE_DIR=../workspace npm run dev

# 前端（另开一个终端）
cd frontend
npm install
npm run dev
```

打开 http://localhost:5173（Vite 开发服务器会自动代理 API 请求到后端）。

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VLLM_API_URL` | `http://host.docker.internal:8000/v1` | OpenAI 兼容的 API 地址 |
| `VLLM_API_KEY` | *（空）* | LLM 接口的 API Key |
| `MODEL_NAME` | `default` | 使用的模型名称 |
| `WORKSPACE_DIR` | `/workspace` | 默认工作区目录 |
| `PORT` | `3000` | 服务端口 |
| `MAX_AGENT_ITERATIONS` | `30` | 每次 AI 回复的最大工具调用轮数 |
| `AGENT_MAX_TOKENS` | `8192` | 每次 AI 回复的最大 Token 数 |
| `USERS_CONFIG` | *（自动检测）* | `users.json` 文件路径 |

### 用户管理

通过项目根目录的 `users.json` 管理用户：

```json
{
  "allowedRoots": ["/workspace", "/home"],
  "users": [
    { "username": "admin", "password": "admin123", "defaultWorkspace": "/workspace" },
    { "username": "alice", "password": "securepass", "defaultWorkspace": "/workspace/alice" }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `allowedRoots` | 用户可通过文件夹浏览器打开的目录前缀白名单 |
| `username` | 登录用户名 |
| `password` | 登录密码 |
| `defaultWorkspace` | 登录后默认打开的工作区目录 |

添加用户只需在 `users` 数组中追加一条记录，然后重启后端即可。

## 项目架构

```
ai-ide/
├── backend/                 # Express + WebSocket 服务端
│   └── src/
│       ├── agent/           # AI 智能体循环、工具、提示词、任务系统
│       │   ├── loop.ts      # LLM 调用循环及工具执行
│       │   ├── tools.ts     # 智能体工具（bash、文件读写、任务、队友）
│       │   ├── systemPrompt.ts
│       │   ├── taskManager.ts
│       │   ├── messageBus.ts
│       │   └── teammateManager.ts
│       ├── auth/            # 会话管理与中间件
│       ├── routes/          # REST API（文件操作、认证）
│       └── ws/              # WebSocket 处理（聊天、终端）
├── frontend/                # React + Vite 单页应用
│   └── src/
│       ├── components/      # Sidebar、Editor、ChatPanel、Terminal 等
│       └── hooks/           # useAuth、useChat、useFileSystem
├── users.json               # 用户凭证与允许路径配置
├── Dockerfile               # 多阶段构建（Node + Conda + 开发工具）
└── docker-compose.yml
```

### 技术栈

| 层级 | 技术 |
|------|------|
| 编辑器 | Monaco Editor |
| 终端 | xterm.js + node-pty |
| 前端 | React 18、Vite、TypeScript |
| 后端 | Express、WebSocket (ws)、TypeScript |
| AI | OpenAI 兼容 API（工具调用智能体循环） |
| 运行时 | Node.js 20、Python 3、Miniconda |

## AI 智能体能力

AI 助手可以：

- **读取 / 编写 / 编辑文件** — 直接操作工作区内的文件
- **执行 Shell 命令** — 通过集成终端运行命令
- **管理任务** — 创建、更新、跟踪任务看板
- **生成队友** — 创建具有特定角色的自主 AI 子智能体
- **协作** — 智能体之间通过消息总线通信，可主动认领任务

### 智能体工具列表

| 工具 | 说明 |
|------|------|
| `bash` | 执行 Shell 命令（危险操作已屏蔽） |
| `read_file` | 读取文件内容 |
| `write_file` | 创建或覆盖文件 |
| `edit_file` | 在现有文件中查找替换 |
| `TodoWrite` | 更新对话中的任务清单 |
| `task_create` | 创建持久化任务 |
| `task_update` | 更新任务状态 |
| `spawn_teammate` | 启动自主运行的 AI 队友 |
| `send_message` | 向指定队友发送消息 |
| `broadcast` | 向所有活跃队友广播消息 |

## 许可证

MIT
