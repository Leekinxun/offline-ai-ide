# Web 手机控制台

手机控制台适用于 CrownForge Web/Docker 部署。用户先在网页端登录，在用户菜单打开“手机控制台”，用微信扫描二维码，并核对网页和手机显示的六位短码；网页端明确批准后，手机才获得独立会话。桌面 Electron 版仍只监听本机回环地址，不提供这条连接。

## 部署条件

1. 手机必须能够访问与网页相同的 HTTPS 域名。将 `MOBILE_PUBLIC_BASE_URL` 设为该**源**，例如 `https://forge.example.com`；不能带路径、查询参数或账号信息。HTTP 仅供非生产环境的 `localhost` / `127.0.0.1` 测试。
2. 在反向代理上启用 TLS，并转发普通 HTTP 与 `/ws/mobile`、`/ws/chat`、`/ws/team` 的 WebSocket Upgrade。二维码、手机请求和 WebSocket 必须使用同一源。若使用仓库的 Compose 示例，把 `9798:3000` 限制为仅反向代理可达（例如绑定 `127.0.0.1:9798:3000` 或通过防火墙限制），再由 HTTPS 域名对外提供服务。
3. 配置真实的 `USERS_CONFIG`。缺失用户配置或仍使用默认管理员口令时，服务端会拒绝生成二维码。首次成功登录会将旧格式明文密码迁移为带盐的 scrypt 哈希；升级前按[运维手册](operations/operator-runbook.md)备份用户配置。

如果生产环境使用本仓库的 `docker-compose.yml`，请在**部署服务器**的 `ai-ide/.env` 中新增下面一行；该文件与 `docker-compose.yml` 同目录，已有 `.env` 时保留其中其他配置。不要放到 `frontend/.env`、`users.json` 或网页管理员设置中。Compose 会把这里的值代入 `ai-ide` 服务的 `environment`；仓库的 `.gitignore` 已排除 `.env`。[Docker Compose 的 `.env` 规则](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/)。

```env
# /path/to/CrewForge/ai-ide/.env；请替换为生产环境的真实域名
MOBILE_PUBLIC_BASE_URL=https://code.example.com
```

这里填写浏览器地址栏实际使用的**完整源**：若用户通过 `https://code.example.com` 访问，就填 `https://code.example.com`；若域名使用非默认端口，须包含端口。不要填 Docker 容器地址、`http://localhost:9798` 或页面路径；末尾 `/` 可以省略。更新后在该目录执行 `docker compose config` 检查解析结果，再执行 `docker compose up -d --build --force-recreate ai-ide` 让容器获得新变量。[Compose 更新容器的行为](https://docs.docker.com/reference/cli/docker/compose/up/)。

若不是用 Compose 部署，则把同名变量设置在启动 Node 服务的运行环境中；例如 `docker run` 使用 `-e MOBILE_PUBLIC_BASE_URL=https://code.example.com`（替换域名）。浏览器前端无需构建时环境变量，二维码地址由后端生成。

微信在这里负责打开 H5 页面。二维码链接不包含网页 Bearer 令牌；票据放在 URL fragment 中，页面读取后立即从地址栏清除。这个流程不获取微信账号身份，也不需要公众号网页授权。

## 会话与权限

- 二维码票据有效 90 秒，只能被一台手机认领一次；网页端核对短码并批准后才签发手机会话。
- 手机会话使用独立的 `HttpOnly` Cookie。生产环境要求 `Secure`；写请求还需同源 Origin 和 CSRF 令牌。手机 Cookie 不能调用原有桌面 Bearer API。
- 手机会话默认闲置 30 分钟过期、绝对有效期 8 小时，并依附于批准它的网页登录会话。网页退出、密码重置、设备下线、当前团队权限撤销或服务重启后需要重新配对。
- 工作区列表是配对时账号可访问范围的快照；切换工作区时重新检查实时团队成员资格。只读成员仅能查看；工具审批按当前权限和风险分类处理，手机端不提供“始终允许”或高风险放行。
- 手机可查看任务、会话、运行过程和文件变更摘要；对当前运行可停止、纠偏及处理允许的审批。新任务或已结束会话的继续执行由服务端运行协调器启动。终端、管理设置和任意文件编辑不在手机入口开放。

网页会话和运行协调器目前按单个 Node 进程工作。WebSocket 断线可重新获取任务快照；服务端重启会结束登录及手机会话，用户需重新登录和扫码。多实例部署前需要共享会话、运行归属与事件总线。

## 验收

使用实际手机微信和浏览器分别检查扫码、待确认、拒绝、过期与设备撤销；在 320–430px 宽度验证任务、审批和对话；再测试断网重连、团队降为 `viewer`、网页退出与两端同时处理同一审批。服务端应始终按最新用户、团队和工作区权限裁决请求。
