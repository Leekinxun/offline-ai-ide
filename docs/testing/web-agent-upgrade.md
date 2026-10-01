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

真实浏览器 smoke 是显式检查，不放入默认 unit gate。它使用 Node 内置 `fetch` 和后端已有的 `ws`，通过 Chrome CDP 操作真实页面；不会安装依赖或读取已有标签页。默认不保存截图，传入 `--artifacts` 时保存本次夹具的截图。

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

## 编辑审阅与消息显示回归

在新启动的 fixture 上执行：

```sh
node scripts/web-agent-browser-smoke.mjs \
  --launch --review \
  --workspace "<fixture 输出的 workspace 路径>" \
  --artifacts /tmp/crownforge-review-screenshots
```

`--review` 只在验证临时目录、账号和本地模型之后，允许固定的 `FIXTURE_REVIEW` Code 请求。该回合修改临时 `review-doc.md` 的三个独立块，以及 `review-notes.md`、`review-checklist.md`，并返回延迟的 SSE 思考摘要、工具事件和包含长路径、表格、代码块的 Markdown 回复。其他 Code 请求及直接文件写 API 仍被拦截。每次执行需要新 fixture。

检查包括：首 token 前的等待、模型提供的思考和工具活动是否可见；用 `elementFromPoint` 检查按钮是否被覆盖，再用真实 Chromium 鼠标按下/松开确认修改；从服务端重读保留状态，并确认文件字节和编辑器保存状态；在 1440 和 1000 像素窗口中检查消息及输入区的横向溢出。

原始回归已在修复前复现三个失败：活动状态缺失、保留按钮中心命中 Monaco 的透明 `view-lines` 层、长 Markdown 回复撑宽消息。此前直接触发 DOM click 的手工保留检查没有覆盖真实鼠标命中，此回归专门补上该缺口。

修复后结果：本节真实浏览器回归 **7/7**，原浏览器 smoke **7/7**；前端策略与工作台回归 **116/116**；流式解析、活动状态、真实 Agent loop 和重连专项 **34/34**；严格类型检查、生产构建、包体积预算、UI contract 和发布方法检查通过。这轮使用针对性回归，上方 861 项是上一轮功能改造的全量结果。

已检查 400px 侧栏及 1000px 窗口中通过分隔条 Home 键设置的真实 280px 侧栏截图。修复同时覆盖新右侧 dock 在窄窗口下的定位与宽度。模型思考仅在提供方实际返回时展示；没有思考数据时展示等待响应、工具执行或审批状态。

## 保留后的编辑视图

`--review` 进一步验证：在主编辑器保留第一块后，只剩待确认的第二块；从旁边“变更”面板保留整个文件后，主编辑器的红绿标记立即清除，完整历史差异与撤销按钮仍可用；切换文件再返回不会重新显示已确认标记。两个审阅入口按工作区和 run 同步状态，各自保持原有的 request 范围。

策略回归覆盖同一显示块包含多个 hunk、全文件保留、无 hunk 的创建记录、早期或无法定位的待确认记录，以及确认后再次收到 Agent 修改。无法安全定位的记录仍通过完整“变更”视图处理，不放宽当前内容与历史版本的一致性校验。

本次验证：前端回归 **123/123**，真实浏览器 `--review` **7/7**，严格类型检查、生产构建、UI contract 与包体积预算通过；已检查全部确认后的无红绿标记编辑区截图。

## 一键保留

最新 `--review` 用三个文件验证两种范围：先在编辑器保留一块，再点击固定栏的“全部保留”，一次确认当前文件剩余的两块，另外两个文件仍待审；接着点击“变更”的“全部保留（2 个文件）”，通过一次批量请求确认本轮剩余文件。检查服务端持久化状态、历史 Diff 和撤销入口，以及所有文件字节保持不变、重新打开后标记不再出现。

批量接口对整个 run/request 摘要做版本校验，完整预检后一次写入原有 journal；过期、缺证据或无法写入时不发布部分确认。确认操作不改变文件内容或工具审批，后续新增修改仍为待审状态。

验证结果：后端相关回归 **67/67**、前端回归 **125/125**、真实浏览器 `--review` **8/8**，类型检查、生产构建、界面检查和包体积预算通过；已检查两个批量按钮同时可见的截图。

## 目录权限与重命名（2026-09-29）

在新 fixture 上执行 `node scripts/web-agent-browser-smoke.mjs --launch --rename --workspace "<fixture workspace>"`。`--rename` 与 `--review` 互斥；仍必须通过离线模型、临时目录和账号校验，且只允许固定的 `FIXTURE_RENAME` Code 请求。

该场景包含十个有空格的子目录和中文文件名。实际通过审批执行带 `2>/dev/null` 的枚举命令，再用 `rename_file` 改名；检查十份文件内容不变、外部普通参考文件返回只读标记、当前脏标签迁移到新名称后保留未保存文字，以及运行结束后的文件树更新。

验证记录：后端全量 **922 项：919 通过、0 失败、3 条件跳过**（151 个测试文件）；前端回归 **130/130**；真实浏览器 `--rename` **6/6**。重命名底层另外覆盖目标冲突、并发替换、提交失败恢复和整轮撤销；外部读取覆盖假授权、授权撤销、敏感内容、链接与读取竞态。真实配置哈希保持一致。权限模型详见 [工作区文件访问](../security/workspace-file-access.md)。

## 工具审批与短窗口（2026-09-30）

启动新 fixture 后，单独运行审批检查（不重复其他模式）：

```sh
node scripts/web-agent-browser-smoke.mjs \
  --launch --approval \
  --workspace "<fixture 输出的 workspace 路径>" \
  --artifacts /tmp/crownforge-approval-screenshots
```

`--approval` 与 `--review`、`--rename` 互斥。完成账号、临时工作区及本地模型校验后，脚本只允许固定的 `FIXTURE_APPROVAL: approve the fixture note and run its check` Code 请求。离线模型先读取并修改 `approval-note.md`，随后请求执行 `npm run approval-check`；该命令仅检查这份临时文件并输出结果。

检查覆盖：任务页实际点击中风险批量批准、服务端 ACK 确认获批项、后续高风险 bash 卡持续可见且没有批量入口；再对自己创建的 fixture WebSocket 发送批量批准，确认 `resolvedCount: 0` 且高风险卡保留。随后切到编辑器助手核对同一审批，再回任务页，在 600px 高窗口中检查内部滚动与鼠标命中，通过真实 CDP 鼠标按下/松开批准一次，等待工具检查和运行成功。

结束时比对全部 Git 跟踪文件字节及工作区状态，只允许 `approval-note.md` 出现预期修改。截图包含中风险批准前、600px 编辑器审批、600px 任务页审批及完成状态。脚本清理自己的 Chrome 上下文和进程；fixture 退出时删除整个临时工作区。不读取正常用户配置，不访问线上，也不调用真实模型。

验证结果：真实 Chrome `--approval` **8/8**；后端完整测试与所有根目录前端策略测试合计 **1,084 项：1,081 通过、0 失败、3 条件跳过**；只读命令与变更集专项最终 **51/51**，补充通配符边界后只读命令测试 **7/7**。前后端类型检查、严格未使用变量检查、生产构建、体积预算、UI contract、发布方法检查通过。新增固定沙箱自检在本机 macOS 的七项 canary 均通过。

本轮全量测试使用独立 settings/users/workspace 与只允许 loopback 的 Node 网络 guard。完整 clean-snapshot 发布流程在复制已有 `desktop-dist` 构建产物时遇到框架符号链接而退出，因此改为上述隔离配置回归；未删除用户的桌面构建产物，也未宣称完整发布 soak 通过。

线上只读排查复现了两层失败：隐藏的高风险审批在约 300 秒后超时；真正获批的命令又因 bubblewrap 无法创建 namespace 而失败。宿主机报告默认 AppArmor、默认 seccomp 和 `no-new-privileges`。独立 Linux Docker 27.4.0 / bubblewrap 0.8.0 实验复现默认 seccomp 下的 namespace 拒绝；实验规则进一步允许 namespace 后仍无法挂载私有 `/proc`，没有得到可部署的完整通过结果。应用修复、macOS canary 通过和浏览器成功不能替代目标服务器的沙箱验收；线上容器未在此验证中重建或放宽安全策略。部署步骤见 [沙箱诊断手册](../operations/operator-runbook.md#linux-container-sandbox-diagnostics)。

验证结果：独立 `--approval` **8/8 通过**，已实际查看两个入口的 600px 截图；浏览器上下文及自建 Chrome 清理成功，临时 fixture 服务已停止。此前一轮脚本误选了折叠详情中的隐藏导航按钮，已改为定位真实可见入口，并在全新 fixture 上完成上述结果。
