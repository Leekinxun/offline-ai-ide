# CrownForge remote desktop preview · v1.1.1

The desktop app now connects to an existing CrownForge server and loads the same
frontend used by the browser. Enter a server root URL, sign in with your server
account, and use the server's projects, terminals, Agent runs, and history.

- Configure and remember an HTTP/HTTPS server address, retry failed loads, and
  change servers from the connection settings.
- Keep login and frontend storage in separate persistent sessions per server.
- Recover the existing server run after a transport interruption. Closing the
  client does not stop server-owned Agent work; explicit Stop remains available.
- Package only the native client shell and connection screen. Git, model/MCP
  access, project tools, execution sandboxes, and files belong to the server.

| Operating system | Installer asset |
| --- | --- |
| macOS 13+ · Apple silicon | `CrownForge-1.1.1-mac-arm64.dmg` |
| macOS 13+ · Intel | `CrownForge-1.1.1-mac-x64.dmg` |
| Windows 10/11 · x64 | `CrownForge-1.1.1-win-x64.exe` |
| Windows 7 SP1 · x64 | `CrownForge-Win7-1.1.1-x64.exe` |

When published, download an installer or ZIP and its matching `.sha256` file
from the same release. Use `shasum -a 256 -c <installer>.sha256` on macOS, or
`certutil -hashfile <installer>.exe SHA256` on Windows and compare the result.

Use a root URL without credentials, subpaths, query strings, or fragments.
HTTPS certificate validation remains enabled. A stopped/restarted server can
interrupt its runs; closing a client and restarting a server have different
lifecycles. Data from earlier local desktop previews is preserved but is not
automatically migrated to a server. See the [desktop guide](desktop-app.md).

These are source changes, not a declaration of new installer acceptance.
Installers remain unsigned, macOS builds are not notarized, and each target OS
needs installation and real-server acceptance. The Windows 7 legacy target uses
unsupported Electron 22; compatibility with the current server frontend must
also be checked on that OS.

---

# CrownForge 远程桌面预览版 · v1.1.1

桌面端现在连接已有的 CrownForge 服务器，加载与浏览器完全相同的前端。
填写服务器根地址，使用服务器账号登录，即可访问服务器上的项目、终端、
Agent 任务和历史记录。

- 支持配置并记住 HTTP/HTTPS 服务器地址、连接失败重试和切换服务器。
- 不同服务器分别保存登录与前端状态，避免混用身份和项目上下文。
- 网络恢复后接回已有任务。关闭客户端不会停止服务器上的 Agent 任务，
  用户仍可通过工作台的“停止”操作显式取消任务。
- 安装包只包含客户端外壳和连接页；文件、Git、模型/MCP、项目工具和
  执行沙箱由服务器提供，客户端电脑无需安装这些工具。

发布后，请在同一次 Release 中下载安装包或 ZIP 及对应 `.sha256` 文件。
macOS 可运行 `shasum -a 256 -c <安装包>.sha256`；Windows 可运行
`certutil -hashfile <安装包>.exe SHA256` 并比较校验值。

服务器地址须为根 URL，不支持账号密码、子路径、查询参数或片段。
HTTPS 证书校验保持开启。服务器进程停止或重启可能中断任务，不能与
关闭客户端后的任务保活混为一谈。旧本地桌面版的数据会保留，但不会
自动迁移到服务器。连接、部署和迁移说明见[桌面版指南](desktop-app.md)。

本说明描述源码改动，不表示新版安装包已经通过全部平台验收。安装包
尚未签名，macOS 包尚未公证；各目标系统仍需独立安装及真实服务器验收。
Windows 7 旧版构建使用已停止维护的 Electron 22，还需实机验证当前
服务器前端的兼容性。
