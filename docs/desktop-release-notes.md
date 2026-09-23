# CrownForge desktop preview · v1.1.0

This preview runs CrownForge locally on each computer. Download the installer for your operating system from this release's **Assets**, together with its matching `.sha256` file. ZIP archives and their checksums are also provided.

| Operating system | Installer asset |
| --- | --- |
| macOS 13+ · Apple silicon | `CrownForge-1.1.0-mac-arm64.dmg` |
| macOS 13+ · Intel | `CrownForge-1.1.0-mac-x64.dmg` |
| Windows 10/11 · x64 | `CrownForge-Windows-Cross-1.1.0-x64.exe` |
| Windows 7 SP1 · x64 | `CrownForge-Win7-Cross-1.1.0-x64.exe` |

To check a download on macOS, run `shasum -a 256 -c <installer>.sha256` in the download folder. On Windows, run `certutil -hashfile <installer>.exe SHA256` and compare the result with the matching `.sha256` file. Checksum files must come from this same release.

On first launch, the app creates an `admin` account and displays a random password once. Save it before closing the dialog. Configure an AI model endpoint in Settings after logging in. See the [desktop guide](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md) for local data, dependencies, and feature limits.

**Preview limits:** These installers are unsigned; the macOS builds are not notarized. Both Windows installers were cross-built on macOS, omit native `node-pty`, and use the limited `cmd.exe` terminal fallback. Windows 10/11 and Windows 7 installation and runtime behavior have not yet been verified on those target systems. Windows Agent shell commands remain disabled because the project has no Windows hard-isolation implementation. The Windows 7 package uses Electron 22, whose Chromium and Node runtimes are no longer security-maintained. Please report target-system results in GitHub Issues.

---

# CrownForge 桌面预览版 · v1.1.0

本预览版在每台电脑本地独立运行。请在本次 Release 的 **Assets** 中按上表选择安装包，并下载同名 `.sha256` 文件校验；同时提供 ZIP 包及其校验文件。macOS 可在下载目录运行 `shasum -a 256 -c <安装包>.sha256`；Windows 可运行 `certutil -hashfile <安装包>.exe SHA256`，然后与对应校验文件比较。

首次启动会创建 `admin` 账户，并仅显示一次随机密码，请保存后再关闭提示框。登录后在设置中配置 AI 模型端点。数据位置、外部依赖及功能限制见[桌面版指南](https://github.com/Leekinxun/offline-ai-ide/blob/main/docs/desktop-app.md)。

**预览版限制：**安装包尚未签名，macOS 包尚未公证。两个 Windows 安装包均在 macOS 上交叉构建，未包含原生 `node-pty`，终端使用功能有限的 `cmd.exe` 回退；Windows 10/11 和 Windows 7 尚未在目标系统完成安装和运行验收。Windows 的 Agent shell 命令因缺少硬隔离实现而保持禁用。Windows 7 包使用的 Electron 22 及其 Chromium、Node 运行时已停止安全维护。欢迎在 GitHub Issues 反馈目标系统上的测试结果。
