# CrownForge desktop preview · v1.1.1

This preview synchronizes the latest Web workbench and Agent workflows into the local desktop app. When a release is published, choose the installer for your operating system from its **Assets**, together with the matching `.sha256` file. ZIP archives and checksums are also produced by the packaging workflow.

**Workbench and editor:** Updated docks, resizable panels, selection menus, settings layout, and global zoom. File tabs support grouped closing and copying paths. Markdown split preview and two-file comparison keep linked scrolling, and editor Inline AI proposals remain connected in each editor mode.

**AI collaboration and review:** The task view and collaboration panel share the input draft. `@` references can include files, directories, symbols, selected text, Problems, and terminal context. The context indicator opens source inspection. Review Agent edits by hunk, file, or whole run, keep all pending changes, provide line feedback, or undo a turn while respecting content-version and running-task checks.

**Long runs and terminals:** Up to eight named terminal tabs support bounded reconnect and output recovery after a transport interruption or page reload. Agent context compaction preserves goals and corrections, and execution facts expose recorded reads, compactions, and verification evidence. After an app restart, choose **Resume** to continue an interrupted Agent run; reopening the app does not automatically restart commands or AI requests. Terminal processes do not survive backend shutdown.

**Web Preview and desktop integration:** The top-bar preview can start static or Vite targets, inspect elements, send feedback to the Agent, and navigate to source candidates. Validated external links open through the desktop host. Appearance preferences persist in the native per-user store across changing local ports, and desktop zoom shortcuts share the in-app setting. Normal desktop launches create a local account when needed and enter the workbench without a separate password login.

**Desktop fixes and verification:** Interrupted runs can resume while retaining their execution-plan constraints. Theme, font, language and zoom survive a restart; changing language with an open editor no longer disposes the Inline AI controls incorrectly. Internal Node processes now start correctly for command sessions, Vite preview and Node debugging. Closed stdin produces a controlled error instead of crashing the backend. The macOS Apple silicon package passed nine real Electron checks, including long-command input and exit, Inline edits and undo, preview isolation, language changes and restart recovery. Seven real sandbox checks preserved workspace, credential and network boundaries.

| Operating system | Installer asset |
| --- | --- |
| macOS 13+ · Apple silicon | `CrownForge-1.1.1-mac-arm64.dmg` |
| macOS 13+ · Intel | `CrownForge-1.1.1-mac-x64.dmg` |
| Windows 10/11 · x64 | `CrownForge-1.1.1-win-x64.exe` |
| Windows 7 SP1 · x64 | `CrownForge-Win7-1.1.1-x64.exe` |

On macOS, run `shasum -a 256 -c <installer>.sha256` in the download folder. On Windows, run `certutil -hashfile <installer>.exe SHA256` and compare the result with the matching `.sha256` file. The checksum must come from the same release. Configure an AI model endpoint in Settings. Local project workflows require the relevant Git, Python, Node.js/npm, project packages, and `debugpy` for Python debugging. See the [desktop guide](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md) for data locations and dependencies.

**Preview limits and acceptance:** Installers are unsigned and macOS builds are not notarized. Automated checks and a local Electron fixture do not prove installation and runtime behavior on every target OS; Windows 7, Windows 10/11, Intel macOS, and Apple silicon macOS each need their own acceptance results. Windows terminal fallback uses limited `cmd.exe` pipes when native PTY cannot start. Windows Agent shell commands remain disabled because the project has no Windows hard-isolation implementation. The app listens only on loopback and does not expose mobile remote control. Windows 7 uses Electron 22, whose Chromium and Node runtimes are no longer security-maintained.

---

# CrownForge 桌面预览版 · v1.1.1

本预览版把最新 Web 工作台与 Agent 工作流同步到本地桌面应用。发布后，可在 Release 的 **Assets** 中按上表选择安装包，并下载同名 `.sha256` 文件校验；打包工作流同时生成 ZIP 包及校验文件。

**工作台与编辑器：**更新左右面板、可调宽度、选择菜单、设置布局和全局缩放。文件标签支持成组关闭与复制路径，Markdown 分栏预览和双文件比对保留同步滚动，各编辑模式都接入 Inline AI 提议。

**AI 协作与审查：**任务视图与协作栏共用输入草稿。通过 `@` 引用文件、目录、代码符号、选区、Problems 和终端上下文，上下文指示器可打开来源检查。支持按 hunk、文件或整轮审查 Agent 修改、一键保留待审查修改、行级反馈和撤销一轮，操作继续受文件版本与任务运行状态约束。

**长任务与多终端：**最多八个可命名终端标签，传输中断或页面刷新后可在有限重连窗口内恢复同一进程及输出。Agent 压缩上下文时保留目标与纠正，执行事实展示真实读取、压缩与验证记录。应用重启后需要用户点击 **继续运行**，才会续跑中断的 Agent 任务；启动本身不会自动重启命令或 AI 请求。终端进程不会跨后端关闭保活。

**Web 预览与桌面接入：**顶栏预览支持静态页面或 Vite 目标、元素检查、向 Agent 发送反馈和跳转候选源码。外部链接经桌面宿主校验后打开。外观偏好保存在本机用户目录，随机端口变化后仍可恢复；桌面缩放快捷键与界面控件使用同一设置。正常启动时按需创建本机账户，免密直进工作台。

**桌面修复与验证：**中断任务可在保留原执行计划约束的前提下继续运行；主题、字体、语言和缩放可跨重启恢复，打开编辑器后切换语言不会再导致 Inline AI 控件崩溃。命令会话、Vite 预览和 Node 调试所需的内部 Node 进程现已正确启动，关闭 stdin 会返回受控错误，不再使后台崩溃。Apple silicon macOS 安装包通过九项真实 Electron 检查，涵盖长命令输入与退出、Inline 编辑与撤销、预览隔离、语言切换和重启恢复；七项真实沙箱检查验证了工作区、凭据和网络边界。

macOS 可在下载目录运行 `shasum -a 256 -c <安装包>.sha256`；Windows 可运行 `certutil -hashfile <安装包>.exe SHA256`，然后与同次发布的校验文件比较。在设置中配置 AI 模型端点。本机项目工作流需要对应的 Git、Python、Node.js/npm、项目依赖；Python 调试另需配置解释器中的 `debugpy`。数据位置与依赖见[桌面版指南](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md)。

**预览版限制与验收：**安装包尚未签名，macOS 包尚未公证。自动检查和本机 Electron 隔离样例不能代替所有目标系统的安装与运行验收；Windows 7、Windows 10/11、Intel macOS 与 Apple silicon macOS 各需独立验收结果。原生 PTY 无法启动时，Windows 终端回退到功能有限的 `cmd.exe` 模式。Windows Agent shell 因缺少硬隔离实现而保持禁用。桌面服务仅监听 loopback，不开放手机远程控制。Windows 7 使用的 Electron 22 及其 Chromium、Node 运行时已停止安全维护。
