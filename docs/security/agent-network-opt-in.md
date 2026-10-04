# Agent 命令的显式网络授权

Agent 的 `bash` 和 `process_start` 默认使用所选环境的操作系统网络限制。macOS、Linux 和可选 WSL2 通过现有沙箱禁网；Windows App 原生模式采用 Codex 官方防火墙方案，默认阻断外部连接，但不保证阻断 localhost。固定运行时 0.160.0 在 Windows Server 2022 的实测中，低权限账户及防火墙规则均正确启用，外部 TCP 443 被拒绝，本机回环连接仍可建立。需要严格回环隔离时请选择 WSL2。

`allow_network: true` 是单次放开外部网络的请求，只有以下条件同时成立才允许该命令获得该授权：

- 当前执行者是可写工作区中的主 Code Agent，不能是 Ask、Plan、Review、subagent 或 teammate。
- 管理员配置的 Code profile 中，`isolation.network` 为 `true`。
- 管理员与工作区 sandbox 的有效交集中，`networkOrigins` 包含字面值 `"*"`。
- 用户对这一次工具调用明确选择 `allow_once`，或已在 Web 界面明确开启绑定当前登录、工作区和任务的完全访问权限。

缺少任一条件都不会获得外部网络放开授权；这不会消除 Windows 原生模式的本机回环边界。只有具体 origin 的名单仍保持 shell 禁网；当前实现没有声称对 shell 做按域名代理或域名过滤。

## 管理员配置

配置通过现有管理 API 完成；实现与测试不会自动改动真实设置。

1. 从 `GET /api/admin/settings` 获取现有 `agents`，合并 `code.isolation.network = true` 后提交完整 override map 到 `PUT /api/admin/agents`。该接口替换 profile override map，提交时保留其他 profile、模型、预算、权限与隔离字段。
2. 从 `GET /api/extension-policy` 获取当前管理员与工作区策略。保留其他字段及已有 origins，在管理员 `sandbox.networkOrigins` 中加入 `"*"`，通过 `PUT /api/extension-policy/admin` 提交，并使用当前 `expectedVersion` 或 `If-Match`。
3. 如果工作区有显式 override，也要在其 `sandbox.networkOrigins` 中加入 `"*"`。使用 `PUT /api/extension-policy/workspace`，带上当前 workspace version 和 `adminPolicyVersion`。工作区不能扩大管理员未授予的范围。没有显式 override 时，工作区使用管理员 sandbox 默认值。

例如，工具请求可以是：

```json
{
  "command": "npm install",
  "allow_network": true
}
```

这仍须经过批准的计划命令范围及命令硬限制。默认模式下，本次高风险批准卡会显示 `NETWORK ACCESS`，说明该命令可能向任意网络地址发送工作区数据。完全访问权限开启前也会明确提示联网与工作区数据外传风险；该模式只能替代逐项确认，不能授予管理员未允许的联网能力。详见 [Web 任务审批模式](web-session-full-access.md)。

## 审批及执行边界

- Plan 批准、对话信任、目录会话许可、批量批准均不能替代联网调用的单次批准。
- 用户主动开启的 Web 完全访问权限可以替代新联网调用的逐项确认，但必须通过相同管理员能力检查；它不会自动批准已有待审批项。
- 对联网条目发送 `allow_session` 会被拒绝，不会转换成 `allow_once`。
- 执行器接收的是仅存在于服务端内存中的一次性授权，绑定工具类型、工作区和精确命令。JSON 参数不能伪造它，也不能跨命令或重复使用。
- 审批前和审批返回后都会重新读取网络策略及工作区写权限；等待期间撤销的授权不会启动命令。
- 完全访问权限签发的许可在实际执行与单次消费时再次验证授权版本和管理员联网能力；关闭、会话失效、工作区切换或权限收回后尚未启动的操作会被拒绝。
- 已经启动的命令保留本次授权直到退出或取消。要终止正在执行的联网操作，应停止对应 run 或 process session。
- `process_start` 的授权只用于启动该会话；后续 `process_input` 仍单独检查高风险授权，默认需要批准，完全访问权限可以替代确认，但不会绕过输入命令策略。
- 网络授权不会扩大文件系统路径、secret environment、资源限制或模式权限。系统 curl、证书或代理配置若受文件沙箱限制，可能仍无法运行；不会因此自动开放系统文件读取。
- 发布、远程登录／控制、云与集群管理、系统包管理、破坏性操作、下载代码直接执行和既有解释器逃逸限制仍被阻止。

用户主动运行的 Run Center 项目任务和受控预览沿用各自的已有授权边界；这个开关只控制 Agent 的命令工具。

## 验证

在 `ai-ide/backend` 中运行：

```sh
node --import tsx --test src/agent/networkAccess.test.ts src/agent/toolApproval.test.ts src/agent/permissionService.test.ts src/agent/toolPolicy.test.ts src/agent/shell.test.ts src/agent/processTools.test.ts
npx tsc --noEmit --noUnusedLocals --noUnusedParameters
```

上述授权回归只连接测试创建的临时 loopback HTTP 服务，不发外网请求；它们不代表 Windows 原生模式的回环隔离证明。Windows 原生验收另使用无认证的外部 TCP 443 正向对照，核实外部阻断并记录本机回环限制。覆盖缺少任一管理员授权、窄 origin 交集、默认禁网、只读／子 Agent、Plan 软授权、对话／会话缓存、批量批准、审批期间撤销、授权重放与跨工具使用，以及 bash／process_start 全部条件满足后的真实连接。
