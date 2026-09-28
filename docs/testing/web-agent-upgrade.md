# Web Agent 改造验证

## 本次结果（2026-09-28）

| 检查 | 结果 |
| --- | --- |
| 后端完整单元/集成回归 | 143 个文件，861 项：858 通过、0 失败、3 条件跳过 |
| 前端与工作台策略回归 | 110/110 通过 |
| 前后端 TypeScript | 严格未使用变量/参数检查通过；后端额外启用 `--strict` |
| 前端生产构建和体积预算 | 通过；App 分包 460,127 bytes，低于 500,000 限制 |
| UI contract、发布验证方法检查 | 通过；发布验证方法 7/7 |
| 独立真实 Chrome smoke | 7/7 通过，浏览器上下文和进程清理完成 |

三个跳过项：本机有 `sandbox-exec`，两个“缺少硬隔离 helper”的反向环境分支不适用；可选检索性能基准未设置 `CREWFORGE_RUN_RETRIEVAL_BENCHMARK=1`。这不是完整发布验证或付费模型成功率评测；没有执行部署、完整性能 soak 或 Docker 发布检查。

额外在临时工作区的真实浏览器中验证：

- 人工未保存内容与 Agent 同文件修改冲突时保留，选择保留本地内容后仍在。
- Code 工具落盘后，编辑器保持已保存状态，红删绿增持续显示，保留状态持久化。
- 保留后“撤销上一回合”恢复磁盘，原对话留在历史中，原需求进入新分支的草稿。
- 人工键入并保存后再由 Agent 修改，Cmd/Ctrl+Z 只撤销外部同步，保留人工内容且不改变磁盘；重做后可保存。
- 编辑器逐块撤销实际恢复磁盘并同步已保存 buffer，保留同文件原有人工注释。
- 结构化问题等待期间切到其他对话，列表继续显示等待；切回回答后正常完成。
- 预览中实际触发 Console 错误、点击元素，分别收到错误和选中元素反馈；无源码映射时明确提示。

`app-settings.json` 和 `users.json` 在测试前后的哈希一致。测试使用隔离设置与临时目录，复用已安装依赖，未调用外部模型。

## 复现浏览器 smoke

真实浏览器 smoke 是显式检查，不放入默认 unit gate。它使用 Node 内置 `fetch` 和后端已有的 `ws`，通过 Chrome CDP 操作真实页面；不会安装依赖、读取已有标签页或保存截图。

在 `ai-ide` 目录中启动离线 fixture：

```sh
node scripts/web-agent-fixture.mjs
```

保留该进程，从输出中取得 `url` 和 `workspace`。fixture 使用临时目录、固定账号 `fixture / local-fixture-only` 和本机 `local-fixture` 模型，不调用外部模型。前端会在启动时生成固定快照，代码变更后需要重新启动 fixture 再验证。

在另一终端运行：

```sh
node scripts/web-agent-browser-smoke.mjs \
  --launch \
  --url http://127.0.0.1:45173 \
  --workspace "<fixture 输出的 workspace 路径>"
```

`--launch` 使用已安装的 Chrome 创建一次性 headless 实例、独立临时用户目录和 BrowserContext。结束时仅关闭自己创建的浏览器进程与页面，并删除自己的临时目录。macOS 使用标准 Chrome 安装路径；其他平台可通过 `CHROME_BINARY` 指定已安装的可执行文件。

也可以连接已经启用 CDP 的本机 Chrome：

```sh
node scripts/web-agent-browser-smoke.mjs \
  --url http://127.0.0.1:45173 \
  --cdp http://127.0.0.1:9222 \
  --workspace "<fixture 输出的 workspace 路径>"
```

这种模式不会启动或关闭 Chrome，只创建并清理独立 BrowserContext 和 Target。若 `/json/version` 不可用，脚本报告失败，不退回操作用户现有标签页。

脚本逐项输出 JSON 格式的 `pass`／`fail`、耗时和失败原因，最后输出总计，任何失败返回非零退出码。覆盖内容：

| 场景 | 实际验证 |
| --- | --- |
| 独立浏览器上下文 | 单独登录、存储及页面，不枚举用户标签页 |
| 离线安全校验和编辑器 | UI 登录；验证账号、临时目录、配置和模型均属于 fixture；打开 calculator.ts |
| 工作区引用 | 输入 `@file:calculator`、选择候选、观察引用 chip |
| Inline Assistant | 使用 Cmd/Ctrl+K；生成时 Accept 禁用；完成后可接受；只改 Monaco buffer；Cmd/Ctrl+Z 还原 |
| 静态预览 | 从 Web preview 入口启动并确认 Static HTML；iframe 实际渲染且不含 allow-same-origin；点击页面 Save 验证交互 |
| 长命令 | 从运行中心启动 npm:wait；观察实时输出；输入 exit 后进程结束且 UI 显示输入回显 |
| 共享工作区保护 | calculator.ts 的磁盘内容始终不变；没有非 Ask 请求或文件写入尝试 |

安全校验失败时不会发送 Agent 请求。脚本额外拦截非 Ask／非 `local-fixture` 请求、`FIXTURE_EDIT` 和文件写入；如果拦截发生，该轮验证也会失败，不能据此宣称产品通过。接受 Inline 结果和撤销均作用于脚本自己的编辑器 buffer；清理只停止该页面创建的预览与命令会话，并注销自己的 fixture 登录。

测试结束后，在 fixture 所在终端按 Ctrl+C，释放它创建的服务和临时工作区。不要把该脚本指向正常用户项目或真实模型配置。
