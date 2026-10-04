# APP_RUST 安装与首次使用

本文说明 `APP_RUST` 分支的 Tauri 桌面版。Web 端和旧 Electron 桌面版仍按原有文档运行；这里仅说明新的桌面 App。

## 安装后能直接使用什么

安装包会随包带上基础 IDE 运行时：前端页面、Monaco worker、本地 Node 服务、Rust IDE 服务、Git 运行时、插件、Windows 执行适配器，以及 Windows NSIS 包内的 WebView2 离线安装器。

因此，普通启动、打开本地文件夹、编辑文件、文件搜索、Git 视图和内置终端不要求用户另外安装 Node、Rust、Git、Bash、WSL、Codex 账号或 AI 模型。AI 服务不可用时，这些基础 IDE 功能仍应可用。

这不表示所有 IDE 逻辑都已经是纯 Rust。当前 Rust 化覆盖了桌面外壳和高频 IDE 基础能力；AI Agent、部分语言和变更编排逻辑仍保留在随包 Node 服务中。

## AI 对话和 Agent 需要配置什么

AI 对话和 Agent 都是用户配置项。App 不内置模型权重，不自动启动推理服务，也不绑定某个模型供应商。

离线环境中，用户需要自行准备可访问的本地或内网模型服务，并在设置中填写模型端点、模型名称和凭据。这个模型服务可以是本机服务，也可以是离线网络内的私有服务；只要目标环境可访问即可。

Agent 执行命令前还依赖执行环境配置。模型服务负责“生成回答”，执行环境负责“运行命令”，两者是不同配置。

## Windows 怎么配置

Windows 默认使用原生 PowerShell 执行 Agent 命令和内置终端。WSL2 是可选项，只有用户显式选择 WSL2 时才会使用；选择 WSL2 后仍需要满足它自己的 Linux 环境和沙箱要求。

首次启用 Windows 原生 Agent 沙箱时，需要在 App 中执行一次显式初始化：

1. 打开 **Settings → General → Desktop app**。
2. 点击 **初始化 Windows 沙箱（Set up Windows sandbox）**。
3. 按系统提示完成管理员授权。
4. 等待 App 返回新的 readiness 结果后，再运行 Agent 命令。

普通启动、打开设置和 readiness 检查不会自动申请 UAC，也不会自动创建用户、修复防火墙规则或静默切到 WSL/非沙箱 shell。初始化失败时，Agent 命令会被阻止；编辑器、搜索、Git 视图和终端仍可继续使用。

## 项目依赖由项目自己提供

安装 App 不等于安装所有项目工具链。Python 项目仍需要对应解释器和包，npm 项目仍需要项目自己的 npm 依赖，Rust 项目仍需要项目需要的 toolchain 和缓存。桌面 App 内部使用的 Node、Git 和 Rust IDE 服务，只服务于 App 自身，不替代项目选择的运行时。

完全离线部署时，请把项目依赖、语言工具链、包缓存、调试器、MCP/插件端点和模型服务一起准备到目标环境，或改成目标环境可访问的本地/内网服务。

## 构建依赖不是用户前置要求

打包人员在构建安装包时需要 Node 22 LTS、Rust、缓存好的构建依赖、独立 Node 可执行文件、固定 SHA 的 Git 运行时和 Windows WebView2 离线安装器。这些是构建机要求，不是最终用户安装 App 前必须手动安装的依赖。

发布给用户的安装包应包含 App 自己需要的运行时资源。缺少运行时资源时，App 应明确失败，而不是在用户机器上临时下载或静默改用系统 PATH 中的工具。

## 当前验证边界

详见 [APP_RUST migration status](app-rust-migration-status.md) 和 [Windows Agent execution](app-rust-windows.md)。

已验证的范围包括：macOS `bde064dd` 预览包 ZIP、实际 GUI 打开与编辑保存、受控外网连接禁止、本地协议模型 fixture、Rust 搜索/Git、终端中的随包 Git，以及干净关闭；Windows 桌面合约和原生沙箱已有独立 CI 验收记录。

Windows `fa7f7bd` 的[完整安装包验收](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37213445654)已通过：实际安装、无模型启动、随包 Git、文件搜索、PowerShell 终端、APP 窗口、正常关闭和卸载。[桌面平台验收](https://github.com/Leekinxun/offline-ai-ide/actions/runs/37213445648)也已通过。

当前仍是预览包，尚未发布签名生产版本。带有预装 WebView2 的 CI 机器不能证明“干净 Windows 且无 WebView2 时的断网安装”已经完成；安装器已验证包含完整的微软离线 WebView2 载荷。
