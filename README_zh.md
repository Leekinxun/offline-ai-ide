# CrownForge

<p align="center">
  <img src="frontend/public/favicon.svg" width="88" alt="CrownForge logo" />
</p>

> 当前版本：`v0.7.0`
>
> 发布时间：`2026-07-14`

CrownForge 是一个完全离线、可私有化部署的 Web AI 编程工作台，集代码编辑器、集成终端、Rolex Agent 和多智能体协作于一体，一个 Docker 容器即可运行。

**无需联网，数据不出内网。** 接入任意 OpenAI 兼容的大模型（vLLM、Ollama、LocalAI 等），即可拥有完全自主可控的 Cursor / Windsurf 替代方案。

[English](README.md)

![Login](docs/screenshots/login.png)
![IDE](docs/screenshots/ide.png)

## 版本更新

### v0.7.0 · 2026-07-14

- 完成 **CrownForge Workbench 前端改造**，覆盖任务优先的 AI 面板、编辑器画布、各类面板、响应式抽屉，以及设置 / 终端 / 知识体验
- 新增 `TaskHeader` 与 `ContextStrip`，让当前模式、运行状态、上下文预算、MCP 健康状态和 Memory / Skills 状态一眼可见
- 新增按文件保存的 Monaco **视图状态恢复**，切换标签页时保留滚动位置、光标、选区和折叠状态
- Git、Agent、Team、Terminal、Settings、Knowledge 等界面统一使用 `PanelShell` 风格，并补齐加载中 / 空状态 / 错误状态与响应式行为
- 完善 Tab、命令面板、搜索、Dialog、Esc 关闭、可见焦点、ARIA Dialog 语义、窄屏触控尺寸和 reduced-motion 等键盘与无障碍体验
- 新增可重复执行的 **UI Contract** 检查，并纳入 `scripts/verify.sh`，覆盖响应式断点、焦点状态、Dialog 语义、`PanelShell` 和 reduced-motion 支持
- 提升 Workbench 全局字号，并统一面板、状态和元信息层级，改善远程服务器浏览器中的阅读体验
- 重构 **资源管理器**：新增工作区身份卡、文件筛选、文件 / 文件夹统计、分组创建操作、可键盘操作的文件树，以及更清晰的空工作区 / 无匹配状态
- 新增内置 **JSON 可视化插件**：支持树形搜索、节点统计、全部展开/折叠、JSONPath/值复制、格式错误反馈，并完整适配浅色与深色主题
- 按批准的 `workbench.html` 基线对齐真实 React 工作台（1440×900）：52px Header、52px Activity Rail、272px Explorer、380px Task Dock 和 26px Status Bar，同时保留认证、文件、命令、Git、Agent、Team、终端、设置和 AI 对话入口

### v0.6.1 · 2026-07-14

- 新增持久化 Agent 上下文、自动压缩、外部 MCP、MCP 懒加载、工作区 / 用户记忆和可复用 Skills
- 新增管理员 **记忆管理中心**：支持查看、编辑、清空和跨作用域合并用户记忆与工作区记忆
- 新增管理员 **Skills 管理中心**：支持搜索、预览说明与参数、启用 / 停用技能，以及查看技能运行记录
- 新增模型能力自动探测、运行历史与任务恢复、上下文压缩预览和 MCP 连接健康状态


### v0.6.0 · 2026-07-12

- 新增以 **CrownForge** 为核心的品牌视觉，统一替换原有 AI IDE 展示名称，并加入皇冠、锻造台和火花组合而成的原生 SVG Logo
- 新增统一品牌常量，应用标题、登录页、工作区欢迎页、顶部品牌区和 favicon 使用同一产品名称
- 补充 **Rolex Agent** 作为底层 Agent 的产品说明，并同步更新插件示例和启动日志中的产品名称
- 同步完善中英文 README 与 `DESIGN.md` 中的品牌规范和 Logo 方向

### v0.5.1 · 2026-07-09

- 新增文件浏览器里的 **文件 / 文件夹上传**，改为 multipart 表单上传，并支持覆盖冲突确认，不再依赖不稳定的大体积 base64 载荷
- 新增管理员可配置的 **上传单文件大小上限**；管理员可在 **Settings** 中调整，环境变量回退项为 `UPLOAD_MAX_FILE_SIZE_MB`
- 新增 **编辑器字体选择**，用户可在 **Settings** 中选择更舒服的代码字体，并按浏览器会话持久化
- 新增按文件保存的 **编辑器视图状态恢复**，重新打开之前的文件时会回到上次离开的光标和滚动位置
- 新增 AI **停止当前任务** 和 **纠偏当前任务** 控制，用户可在 AI 执行工具期间打断或修正运行方向
- 将已有的 **Markdown 渲染**、浅色/深色主题切换、自定义系统提示词作为一等用户功能补充到文档中

### v0.5.0 · 2026-05-12

- 新增 **可打断的 Agent Steering** 与 follow-up 队列：用户可在 AI 运行期间继续追加纠正或补充消息；智能体会在每次工具执行完成后立即检查 steering 队列，一旦发现新消息就中断剩余工具，并在保留已有工具执行结果上下文的前提下开始下一轮 turn
- 管理员 **设置页** 新增 **最大 Agent 迭代轮数** 配置，不再需要通过硬编码环境变量来控制内层循环上限
- 新增 **工作区自动刷新**，编辑器与文件树会在文件变化后自动同步；同时左侧文件树新增手动 **刷新按钮**，并将多选交互优化为 **按需进入**，不再默认一直展示复选框
- 新增实用型 **团队协作 MVP**：支持团队创建/加入/切换、带角色的邀请码、`owner/admin/member/viewer` 权限模型、在线状态、文件认领、共享工作区同步、角色管理、所有者转移、移除成员和主动离队
- 新增 **协作安全保存**：对 `viewer` 角色强制只读、保存前认领冲突提醒、保存时版本校验、远端修改来源标记（`team_member`、`external`、`assistant_tool`、`unknown`），以及支持按块 / 按 hunk 合并和一键 **全部采用远端** / **全部保留本地** 的冲突处理弹窗

### v0.4.0 · 2026-04-24

- 新增轻量级 **插件系统**，支持内置插件、外部插件、本地 `plugins/` 目录离线安装、权限/作用域声明，以及界面内的插件管理
- 将 **Monaco 高亮** 和 **聊天 Markdown 渲染** 重构为内置插件，并将 **Markdown 文件预览** 作为真正的外部示例插件放到 `plugins/markdown-file-preview`
- 新增内置 **界面国际化插件**，可在设置中切换英文 / 简体中文，并补齐 Monaco 在暗色主题下的联动切换
- 新增按工作区存储的 **历史对话持久化**，数据写入 `.history/`，支持查看历史、继续对话、模型自动生成标题，并自动只保留最近 5 个会话

### v0.3.2 · 2026-04-24

- 扩展 **Python 语义高亮**，新增多行赋值目标、`with` 别名、`for` 目标变量、`lambda` 参数、推导式绑定、`global` / `nonlocal`、`except*` 别名等场景
- 优化 **TypeScript / React / Vue** 的编辑器高亮体验，补充 Monaco 语义 token 和组件嵌入语法的主题映射
- 新增手动回归样例目录 [`docs/editor-samples/`](docs/editor-samples/README.md)，可直接打开检查 Python、TypeScript、React、Vue 的高亮效果

### v0.3.1 · 2026-04-23

- 扩展 **Ctrl/Cmd + 鼠标左键跳转**，增加基于工作区的定义查找路径，提升 Python、Vue、React 等跨文件跳转命中率
- 管理员设置页新增 **Max Tokens** 配置，可直接在界面中管理请求上限，无需手改环境变量
- 修复编辑器 **Ctrl/Cmd + S** 可能保存旧内容的问题，原因是 Monaco 动作持有了过期回调

### v0.3.0 · 2026-04-22

- 新增内置 **管理员设置页**，可直接在界面中新增用户、删除用户、重置密码，以及修改 LLM 的 URL / API Key / Model，且无需重启服务
- 左侧文件树新增 **文件 / 文件夹下载**，其中下载文件夹时会自动以 `.zip` 形式返回
- 左侧文件树新增 **批量删除**，支持多选后统一删除
- 编辑器新增 **Ctrl/Cmd + 鼠标左键跳转**，可在当前文件和已打开标签页中跳转到符号定义位置
- 修复 AI 回答中代码块 **Copy 按钮失效** 的问题，并增加剪贴板回退方案

## 版本说明

仓库现在开始以 GitHub 项目常见的轻量级更新记录方式维护版本说明。
`v0.7.0` 是当前 README 记录的最新版本，完成 CrownForge Workbench 前端改造，补充任务上下文、响应式面板、可读字号、增强版资源管理器、按文件编辑器状态恢复、键盘无障碍交互和可重复的 UI Contract 验证，并延续 `v0.6.1` 的 Agent 上下文与 MCP 能力。

## 工作台设计基线

真实前端以批准的 `workbench.html` 作为桌面工作台视觉参考，默认验收视口为 1440×900。工作台由以下区域组成：

- **Workspace Header** — CrownForge 品牌、工作区路径、当前任务、命令面板、面板切换和紧凑用户菜单
- **Activity Rail** — 资源管理器、变更、智能体、终端和设置，使用低噪声激活态
- **Editor Canvas** — 标签页、面包屑、Monaco 或文件预览，以及作为主视觉中心的代码工作区
- **Task Dock** — 任务标题、Ask / Code / Review / Plan 模式、Context / MCP / Memory / Skills 状态、消息、运行证据和输入区
- **Status Bar** — 连接、分支、变更、光标、语言和后台任务等辅助信息

实现保留真实工作区数据和现有交互流程；参考文件只定义布局、层级、间距和信息密度，不替换真实业务内容。

## 功能特性

### 本地验证与 Docker Smoke Test

仓库提供可重复的本地验证脚本：

```bash
./scripts/verify.sh
./scripts/docker-smoke.sh
```

`verify.sh` 会依次执行后端测试与类型检查、上下文性能基准、前端生产构建、前端 UI Contract 检查和差异检查；`docker-smoke.sh` 会构建镜像、启动一次性容器、检查 `/api/health`，并确认容器能够返回 CrownForge 前端页面。端口被占用时可以通过 `CROWNFORGE_SMOKE_PORT` 覆盖默认端口。

- **100% 离线 & 私有化部署** — 运行时无需联网，所有数据留在你的基础设施内。适用于内网隔离环境、企业部署和敏感代码场景
- **兼容 OpenAI API** — 支持 vLLM、Ollama、LocalAI、DeepSeek、OpenAI 等任何 OpenAI 兼容接口，切换模型无需改代码
- **Monaco 代码编辑器** — 支持语法高亮、更完整的 Python 语义高亮、TypeScript/React/Vue 高亮优化、智能提示、多标签页、编辑器字体选择、按文件恢复光标/滚动位置、Ctrl/Cmd 点击符号跳转、协作提示，以及带版本感知的更安全保存流程
- **运行、测试与调试** — 发现项目声明的可信任务，流式展示并可停止运行，支持错误定位，并通过 Node Inspector 或 Python `debugpy`/DAP 使用断点、继续、单步和调用栈
- **Markdown 渲染** — AI 对话内容通过内置插件渲染 Markdown，Markdown 文件可通过仓库自带的外部预览插件查看
- **JSON 可视化** — JSON 文件默认以可搜索的树形结构预览，支持节点统计、展开/折叠、JSONPath/值复制和清晰的解析错误提示
- **浅色 / 深色主题** — 用户可从标题栏切换界面主题；主题偏好会保存在本地，并与 Monaco 编辑器主题同步
- **插件系统** — 提供类似 VS Code 的轻量插件模式，支持内置/外部插件、显式权限与作用域、本地 `plugins/` 离线安装、界面内插件管理，以及仓库内自带的 Markdown 预览示例插件
- **AI 编程助手** — 与 AI 智能体对话，它可以读取、编写、编辑文件，并在工作区内执行 Shell 命令；支持通过停止和纠偏控制在运行中打断或追加 follow-up / steering 消息，并会自动遵守团队只读角色权限
- **历史对话持久化** — 每个工作区会在 `.history/` 下保存 `.jsonl` 会话文件，支持继续历史对话，并自动只保留最近 5 个会话
- **集成终端** — 基于 xterm.js 的全功能 PTY 终端，预装 Conda，默认自动激活 `base` 环境，并内置 `ruff`
- **文件浏览器** — 树形文件管理，支持新建、重命名、文件/文件夹上传、下载、批量删除、文件夹 zip 下载、自动刷新，以及会话隔离的“打开文件夹”；切换后文件树、终端、AI 上下文和 Git 状态都会跟随当前目录更新
- **管理员设置页** — 可在界面中管理用户、重置密码、配置 LLM 的 URL / API Key / Model / Max Tokens / Max Agent Iterations / System Prompt / 上传大小限制，并切换英文 / 简体中文界面语言
- **多用户认证** — 支持由 `users.json` 管理的本地账号密码登录、用户自助注册和管理员审核；每个审核通过的登录会话拥有独立工作区、终端和 AI 上下文
- **团队协作** — 支持在共享工作区内创建/加入团队、按 `owner/admin/member/viewer` 邀请成员、查看在线状态与活跃文件、认领文件、查看协作活动，并通过冲突安全保存流程降低多人编辑冲突
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
  -v ./plugins:/app/plugins \
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
使用管理员账号登录后，可以通过右上角 **Settings** 按钮管理用户并配置 LLM。

### Docker Compose

```yaml
services:
  ai-ide:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./workspace:/workspace
      - ./plugins:/app/plugins
      - ./users.json:/app/users.json  # 可选：覆盖用户配置
    environment:
      - VLLM_API_URL=http://host.docker.internal:8000/v1
      - VLLM_API_KEY=
      - MODEL_NAME=default
      - WORKSPACE_DIR=/workspace
      - MAX_AGENT_ITERATIONS=30
      - AGENT_MAX_TOKENS=8192
      - UPLOAD_MAX_FILE_SIZE_MB=250
    restart: unless-stopped
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### 本地开发

```bash
# Python 调试适配器（每个开发环境安装一次）
python3 -m pip install -r requirements.txt

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

本地开发模式下，通过管理员设置页保存的 LLM 配置默认会写入项目根目录的 `app-settings.json`。
`users.json` 也会默认从项目根目录自动检测；每个工作区的历史对话会保存在 `<workspace>/.history/` 下。

### Agent 工作区快捷键

- `Cmd/Ctrl+P` — 快速打开文件
- `Cmd/Ctrl+Shift+P` — 打开命令面板
- `Cmd/Ctrl+Shift+F` — 搜索工作区
- `Cmd/Ctrl+Alt+N` — 开始新任务
- `Cmd/Ctrl+Alt+←/→` — 在任务线程之间切换
- `Cmd/Ctrl+B` / `Cmd/Ctrl+J` / `Cmd/Ctrl+backtick` — 切换资源管理器 / AI 助手 / 终端
- `Cmd/Ctrl+K` — 切换专注模式

命令面板还可以直接打开设置、MCP 健康状态、Memory/Skills 管理、Git 变更和 Agent Board；Chat 顶部的 MCP 与 Memory/Skills 状态入口也可以直接点击进入管理界面。

### 编辑器高亮样例

如需快速做一次编辑器高亮回归检查，可以直接打开 [`docs/editor-samples/`](docs/editor-samples/README.md) 下的样例文件。当前样例覆盖 Python 语义绑定、TypeScript、React TSX 和 Vue `<script setup lang="ts">` 场景。

### 插件系统

前端现在支持一套轻量插件架构，设计目标是便于维护和离线扩展：

- 内置插件随应用一起发布，可在设置中启用/禁用
- 外部插件从本地 `plugins/` 目录发现并加载，无需联网安装
- 插件在激活前必须声明显式权限，并自动推导展示作用域
- 当前的编辑器高亮、聊天 Markdown 渲染和 JSON 可视化已经迁移为内置插件
- Markdown 文件预览作为可直接复制修改的外部示例插件放在 `plugins/markdown-file-preview/`

直接在 IDE 中打开 Markdown 文件，即可通过顶部的 `编辑 / 预览 / 分栏` 切换按钮使用预览能力。
打开 JSON 文件时会默认进入内置树形预览，也可以通过同一组按钮切回编辑或分栏模式。
现在 Docker 镜像也会默认打包仓库里的 `plugins/` 目录，仓库内提供的 `docker-compose.yml` 还会把本地 `./plugins` 挂载到 `/app/plugins`，因此外部插件开箱即用。

插件清单格式、宿主 API、权限模型和离线安装方式请参考 [`docs/plugins/README.md`](docs/plugins/README.md)。

### 团队协作

当前版本新增了一套以“低摩擦协作”为目标的团队工作流，优先解决多人共享工作区中的可见性、权限控制和保存冲突问题，而不是一开始就引入高复杂度的 CRDT/OT 实时同编：

- 创建、加入、切换绑定到共享工作区的团队
- 生成带默认角色的邀请码
- 支持 `owner`、`admin`、`member`、`viewer` 四种权限角色
- 跟踪成员在线状态、活跃文件和轻量协作活动
- 通过软认领（soft claim）降低多人同时修改同一文件的冲突概率
- 对 `viewer` 角色在编辑器和 AI 文件写入能力上统一执行只读限制
- 当队友创建、重命名、删除或保存文件时，自动广播文件树与文件内容刷新
- 通过版本校验、认领冲突提醒、修改来源标记，以及按块/批量合并的 diff 弹窗来保护保存流程

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `VLLM_API_URL` | `http://host.docker.internal:8000/v1` | OpenAI 兼容的 API 地址 |
| `VLLM_API_KEY` | *（空）* | LLM 接口的 API Key |
| `MODEL_NAME` | `default` | 使用的模型名称 |
| `WORKSPACE_DIR` | `/workspace` | 默认工作区目录 |
| `PYTHON_EXECUTABLE` | `python3`（Windows 为 `python`） | 工作区没有 `.venv` 或 `venv` 解释器时用于调试的 Python 解释器 |
| `DEBUGPY_PYTHON_EXECUTABLE` | `PYTHON_EXECUTABLE` | 已安装 `debugpy==1.8.21` 的 Python 解释器；Docker 镜像会自动配置 |
| `PORT` | `3000` | 服务端口 |
| `MAX_AGENT_ITERATIONS` | `30` | 每次 AI 回复的最大工具调用轮数 |
| `AGENT_MAX_TOKENS` | `8192` | 每次 AI 回复的最大 Token 数 |
| `SYSTEM_PROMPT` | *（空）* | AI 智能体默认 System Prompt 覆盖项 |
| `UPLOAD_MAX_FILE_SIZE_MB` | `250` | 单个上传文件大小上限，单位 MB；可由管理员设置页覆盖 |
| `USERS_CONFIG` | *（自动检测）* | `users.json` 文件路径 |
| `APP_SETTINGS_CONFIG` | *（自动检测）* | 管理员设置页写入的 `app-settings.json` 路径 |

### 运行时配置文件

| 文件 | 作用 |
|------|------|
| `users.json` | 存储用户、密码、管理员标记和允许访问的工作区根目录 |
| `app-settings.json` | 存储管理员在界面中配置的 LLM URL、API Key、Model、Max Tokens、Max Agent Iterations、System Prompt、插件覆盖项、上传大小限制等运行时设置 |
| `<workspace>/.history/*.jsonl` | 存储按工作区隔离的历史对话、自动生成标题和消息记录 |
| `<workspace>/.team/teams.json` | 存储团队成员、角色、邀请码、在线状态、文件认领和协作活动等团队数据 |

如果你使用 Docker 并希望这些设置在重建容器后仍然保留，建议通过挂载文件或卷的方式持久化这两个配置文件。
本地开发时，`users.json` 和 `app-settings.json` 的默认位置都是项目根目录。

### 用户管理

用户管理现在有两种方式：

- 推荐：使用管理员账号登录，在界面右上角 **Settings** 中直接新增用户、删除用户、重置密码
- 兼容方式：直接编辑项目根目录的 `users.json`，或编辑 `USERS_CONFIG` 指向的文件

`users.json` 示例：

```json
{
  "allowedRoots": ["/workspace", "/home"],
  "pendingRegistrations": [],
  "users": [
    { "username": "admin", "password": "admin123", "defaultWorkspace": "/workspace", "isAdmin": true },
    { "username": "alice", "password": "securepass", "defaultWorkspace": "/workspace/alice", "isAdmin": false }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `allowedRoots` | 用户可通过文件夹浏览器打开的目录前缀白名单 |
| `pendingRegistrations` | 等待管理员审核的注册申请，由 CrownForge 自动维护 |
| `username` | 登录用户名 |
| `password` | 登录密码 |
| `defaultWorkspace` | 登录后默认打开的工作区目录 |
| `isAdmin` | 是否拥有管理员设置页权限 |

如果你是在应用外手动编辑 `users.json`，需要重启后端后才会生效；如果是在管理员设置页中修改，则会立即生效。

用户可以在登录卡片切换到“注册”，提交用户名和密码。申请只保存在本地，管理员在“设置 → 用户管理”中审核通过前不能登录。审核通过后会创建普通用户，并在第一个 `allowedRoots` 根目录下分配同名默认工作区；拒绝则会删除该申请。

每次登录都会创建独立 CrownForge 会话。在 Explorer 中切换文件夹只影响当前浏览器会话，并会立即清空旧编辑器/Git Diff，重新加载新目录的文件树、终端、对话上下文和 Git 状态。目标目录必须已经存在且位于 `allowedRoots` 内。

### LLM 配置管理

LLM 运行时配置同样支持两种方式：

- 推荐：通过管理员设置页直接修改
- 兼容方式：通过环境变量 `VLLM_API_URL`、`VLLM_API_KEY`、`MODEL_NAME`、`AGENT_MAX_TOKENS`、`MAX_AGENT_ITERATIONS`、`SYSTEM_PROMPT` 指定

通过管理员设置页保存后，配置会写入 `app-settings.json`，新的 AI 请求会立即使用最新设置。系统提示词也属于运行时配置，管理员可以不重建镜像就定制 AI 助手行为。

### 上传

- 用户可从文件浏览器上传单个文件或整个文件夹
- 上传采用 multipart 表单数据，不再把大文件转成 base64 JSON 载荷
- 文件夹上传会保留所选文件夹下的相对路径
- 如果上传内容与现有文件冲突，界面会提示是否覆盖
- 管理员可在 **Settings** 中配置单文件上传大小上限；环境变量回退项为 `UPLOAD_MAX_FILE_SIZE_MB`

### 编辑器偏好

- 用户可在 **Settings** 中切换内置编辑器字体预设
- 字体偏好会通过 `localStorage` 保存在当前浏览器
- 每个打开的文件都会记录 Monaco 视图状态，回到之前的标签页时会恢复上次的光标和滚动位置

### 历史对话

- 历史对话按工作区保存在 `.history/` 目录下
- 每个会话对应一个 `.jsonl` 文件
- 新会话会优先使用大模型自动生成一个简短标题
- 聊天面板内可以直接查看历史列表并继续对话
- 为避免无限增长，系统会自动只保留最近 5 个会话

## 项目架构

```
ai-ide/
├── backend/                 # Express + WebSocket 服务端
│   └── src/
│       ├── agent/           # AI 智能体循环、工具、提示词、任务系统
│       │   ├── loop.ts      # 双层 LLM 循环，支持工具执行与 steering 打断
│       │   ├── tools.ts     # 智能体工具（bash、文件读写、任务、队友）
│       │   ├── systemPrompt.ts
│       │   ├── taskManager.ts
│       │   ├── messageBus.ts
│       │   └── teammateManager.ts
│       ├── auth/            # 会话管理与中间件
│       ├── chat/            # 历史对话持久化与标题生成
│       ├── files/           # 协作/冲突提示使用的文件变更元数据
│       ├── routes/          # REST API（文件、认证、管理员、团队）
│       ├── team/            # 团队成员、角色、邀请码、认领、在线状态、活动流
│       ├── plugins/         # 插件清单校验与注册表
│       └── ws/              # WebSocket 处理（聊天、终端、团队）
├── frontend/                # React + Vite 单页应用
│   └── src/
│       ├── components/      # Sidebar、Editor、ChatPanel、Terminal 等
│       ├── i18n/            # 界面国际化 Provider 与文案包
│       ├── utils/           # 冲突 diff/merge 辅助工具
│       ├── plugins/         # 前端插件运行时与内置插件
│       └── hooks/           # useAuth、useChat、useFileSystem、useTeam
├── plugins/                 # 支持离线安装的外部插件目录
├── users.json               # 用户凭证与允许路径配置
├── app-settings.json        # 管理员设置页持久化的 LLM 配置
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
- **停止当前运行** — Stop 控制会中止当前 LLM / 工具循环，并将本次运行标记为用户停止
- **实时接收 Steering** — 用户追加的 follow-up 消息和纠偏控制可在单个工具执行完成后立即打断当前流程，并在保留已有工具结果上下文的前提下进入下一轮 turn
- **管理任务** — 创建、更新、跟踪任务看板
- **生成队友** — 创建具有特定角色的自主 AI 子智能体
- **协作** — 智能体之间通过消息总线通信，可主动认领任务
- **遵守团队权限** — 当当前团队角色为只读时，文件写入类工具会自动受限

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
