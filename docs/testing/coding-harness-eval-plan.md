# Coding Harness 能力专项测评计划

## 目标

下一轮测评只把模型生成代码当作被测负载，重点验证 Harness 是否能可靠地驱动、观测、终止和评分复杂 coding 任务。每个用例同时记录 WS 终态、静默时长、审批决策、测试环境、worktree/change-set 证据和主工作区合入结果。

## 测评矩阵

| ID | 能力 | 设计 | 关键断言 | 建议预算 |
| --- | --- | --- | --- | ---: |
| H1 | 正常 Code 生命周期 | 创建文件、运行测试、收尾 | 必须收到 `summary`、`done`、终态 `run_state`；结果文件完整 | 5 min |
| H2 | 静默超时 | 使用可控的无输出长任务或测试后端静默注入 | 90 秒内得到 `inactivity_timeout`，发送 stop，不等待用例总超时 | 2 min |
| H3 | 致命错误短路 | 注入 `Invalid collaboration path` / finalization error 消息 | 立即得到 `fatal_error`，记录 `fatalErrors`，不等待 summary | 2 min |
| H4 | 审批会话策略 | 连续安全写入、unittest、`git status`，夹杂删除/网络命令 | 安全请求可复用 `allow_session`；高危请求仍 `allow_once` 或 deny；统计审批次数 | 5 min |
| H5 | Python 隔离 | 测试位于 `tests/`，模块从工作区根导入；另含 pytest 风格 fallback runner | `PYTHONPATH` 指向 case 根目录；不会出现 `ModuleNotFoundError` 或 0 tests 假通过 | 5 min |
| H6 | C1 协议边界 | URL 服务返回 302，目标不可达 | 通过原始响应断言 `302 + Location`；urllib 自动跟随不造成误扣 | 5 min |
| H7 | 多智能体证据 | 两个 teammate 分别写入独立 worktree 并提交 ChangeSet | 分别记录 worktree、ChangeSet、patch、单测状态；主工作区合入单独评分 | 10 min |
| H8 | 多智能体失败隔离 | 一个 teammate 成功，一个因缺失输入失败 | 成功产物和失败证据都保留；不得把两者合并成“全部成功” | 10 min |
| H9 | Completion Gate | 先执行一个被拒绝/失败的探索命令，再成功完成目标测试 | `toolErrors` 只进审计指标；最终质量合格时不得被标记为 failed | 5 min |
| H10 | 停止与恢复 | 批量生成任务中途发送 stop；随后执行恢复/追问 | 运行标记为 stopped，保留部分产物；恢复会话仍可收到完整终态 | 8 min |

## 评分权重

- 终态可靠性（H1-H3、H10）：30%
- 观测和证据完整性（H4、H7、H8）：25%
- 测试隔离与协议断言（H5、H6）：20%
- 完成门禁准确性（H9）：15%
- 性能与摩擦（静默退出时间、审批数量、总墙钟时间）：10%

硬门禁：任何用例出现 40 分钟级别无消息挂起、结果文件缺失、秘密泄漏或 destructive command 实际执行，专项轮次判定失败。

## 运行顺序

H1-H10 是下一轮新增的专项用例编号。开始执行前，需要在 `CASES`/`fixtures.mjs` 中加入这些 fixture，并为 H2/H3 增加可控的 WS fault-injection adapter；它们不会复用生产服务上的随机错误。

1. 先运行 H1、H4、H5、H6，确认 Harness 基础路径和 Python 环境正常。
2. 再运行 H2、H3、H9，验证本轮 P0/P1 修复并测量短路时延。
3. 最后运行 H7、H8、H10，观察 worktree、ChangeSet、停止和恢复的组合行为。
4. 运行评分：

```bash
node .tmp/eval-harness/harness.mjs H1 H4 H5 H6 H2 H3 H9 H7 H8 H10 --force
node .tmp/eval-harness/score.mjs
node .tmp/eval-harness/score.mjs --compare .tmp/eval-harness/scoring-facts.json
```

在专项 fixture 尚未加入时，可先用现有代表性用例验证基础路径：

```bash
node .tmp/eval-harness/harness.mjs S1 S4 C1 C6 T1 T2 I2 --force
node .tmp/eval-harness/score.mjs
```

## 交付物

每个用例必须留下：

- `results/<ID>/transcript.jsonl`
- `results/<ID>/result.json`
- WS 终态、静默/短路原因、审批统计
- Python 测试输出及 `PYTHONPATH` 设置
- worktree、ChangeSet、patch 和 teammate 测试证据

整轮结束后生成 `docs/testing/eval-score-compare.md` 和 `docs/testing/eval-score-radar.json`，报告每个能力维度的通过率、回归项、墙钟时间和主工作区合入缺口。
