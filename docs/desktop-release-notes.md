# CrownForge desktop preview · v1.1.0 Preview 5

This preview runs CrownForge locally on each computer. Download the installer for your operating system from this release's **Assets**, together with its matching `.sha256` file. ZIP archives and their checksums are also provided.

**Interface update:** The desktop app now includes the latest Web workbench UI: unified selection menus, clearer chat conversations and model selection, more room for the chat composer, adjustable file and AI side panels, and clearer registration rejection feedback.

**Open Folder fix:** The desktop app now uses the operating system's folder picker to open projects outside its built-in workspace, including another drive or volume. It remembers the selected project after restart. The welcome screen's Open Folder button now opens a folder, and switching away from unsaved files asks for confirmation.

**Font update:** The editor now follows VS Code's platform font defaults (Menlo on macOS, Consolas on Windows), with normal token weight, automatic line height, and ligatures off. File tree and tab labels use the interface font. If you previously chose a custom editor font, select **VS Code default** in Settings to switch.

| Operating system | Installer asset |
| --- | --- |
| macOS 13+ · Apple silicon | `CrownForge-1.1.0-mac-arm64.dmg` |
| macOS 13+ · Intel | `CrownForge-1.1.0-mac-x64.dmg` |
| Windows 10/11 · x64 | `CrownForge-1.1.0-win-x64.exe` |
| Windows 7 SP1 · x64 | `CrownForge-Win7-1.1.0-x64.exe` |

To check a download on macOS, run `shasum -a 256 -c <installer>.sha256` in the download folder. On Windows, run `certutil -hashfile <installer>.exe SHA256` and compare the result with the matching `.sha256` file. Checksum files must come from this same release.

On first launch, the app creates an `admin` account and displays a random password once. Save it before closing the dialog. Configure an AI model endpoint in Settings after logging in. See the [desktop guide](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md) for local data, dependencies, and feature limits.

**Preview limits:** These installers are unsigned; the macOS builds are not notarized. The Windows installers were built on Windows Server 2022 with native dependencies, but installation and runtime behavior have not yet been verified on Windows 10/11 or Windows 7. If the native PTY cannot start, the terminal falls back to a limited `cmd.exe` mode. Windows Agent shell commands remain disabled because the project has no Windows hard-isolation implementation. The Windows 7 package uses Electron 22, whose Chromium and Node runtimes are no longer security-maintained. Please report target-system results in GitHub Issues.

---

# CrownForge 桌面预览版 · v1.1.0 预览 5

本预览版在每台电脑本地独立运行。请在本次 Release 的 **Assets** 中按上表选择安装包，并下载同名 `.sha256` 文件校验；同时提供 ZIP 包及其校验文件。macOS 可在下载目录运行 `shasum -a 256 -c <安装包>.sha256`；Windows 可运行 `certutil -hashfile <安装包>.exe SHA256`，然后与对应校验文件比较。

**界面更新：**桌面版同步了最新版网页工作台界面：统一的选择菜单、更清晰的聊天会话与模型选择、更宽敞的聊天输入区、可调整宽度的文件和 AI 侧栏，以及更明确的注册拒绝提示。

**打开文件夹修复：**桌面版现在使用系统目录选择窗口，可打开内置工作区之外的项目，包括其他磁盘或卷；重启后会恢复上次选择的项目。欢迎页“打开文件夹”按钮也已接入该功能，切换前若有未保存文件会提示确认。

**字体更新：**编辑器默认使用 VS Code 对应平台的字体（macOS 为 Menlo、Windows 为 Consolas），语法文本恢复常规字重、自动行高并关闭连字；文件树和标签改用界面字体。如果你此前主动选择了其他字体，可在设置里选择 **VS Code default**。

首次启动会创建 `admin` 账户，并仅显示一次随机密码，请保存后再关闭提示框。登录后在设置中配置 AI 模型端点。数据位置、外部依赖及功能限制见[桌面版指南](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md)。

**预览版限制：**安装包尚未签名，macOS 包尚未公证。Windows 安装包由 Windows Server 2022 构建并编译原生依赖，但尚未在 Windows 10/11 或 Windows 7 目标系统完成安装和运行验收；原生 PTY 无法启动时，终端会回退到功能有限的 `cmd.exe` 模式。Windows 的 Agent shell 命令因缺少硬隔离实现而保持禁用。Windows 7 包使用的 Electron 22 及其 Chromium、Node 运行时已停止安全维护。欢迎在 GitHub Issues 反馈目标系统上的测试结果。
