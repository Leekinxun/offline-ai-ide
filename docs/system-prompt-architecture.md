# System Prompt Architecture

本文记录 CrownForge Agent 系统提示词的结构约定。目标不是复制 Codex 的完整提示词文本，而是采用同样的分层方式，让稳定行为、运行时约束和项目上下文各自有清晰边界。

## 调研基线

- 调研日期：2026-07-30
- 本机 Codex CLI：`0.146.0-alpha.3.1`
- OpenAI Codex 开源仓库基线：`6219b7c40fc9c702c0aef9964e72b492558f60e4`
- 官方资料：
  - [Codex customization](https://developers.openai.com/codex/concepts/customization)
  - [Custom instructions with AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
  - [OpenAI model prompting guidance](https://developers.openai.com/api/docs/guides/latest-model)
  - [Codex base instructions source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/prompts/base_instructions/default.md)

## 结构结论

Codex 的提示词不是一段不断追加的扁平文本，而是两层结构：

1. 稳定基础指令：定义角色、沟通方式、指令优先级、计划与执行、验证、范围控制、最终答复和工具使用规则。
2. 运行时上下文：按当前任务注入交互模式、权限或只读状态、工作区信息、Todo、`AGENTS.md`、Memory、Skills 等内容。

稳定层应尽量保持不变，以便复用和缓存；动态层应有明确边界、来源和优先级，避免把临时状态混进长期行为规则。

## CrownForge 映射

| 层 | 内容 | 更新时机 |
| --- | --- | --- |
| Base instructions | 角色、工作方式、执行、验证、输出、工具规则 | 产品行为变化时 |
| Interaction mode | Ask / Review / Plan / Code 约束 | 每个请求 |
| Workspace mode | 可写或只读能力边界 | 每个请求 |
| Task state | 当前 Todo | 每次模型调用 |
| Project guidance | `AGENTS.md` 与 `.codex/AGENTS.md` | 工作区内容变化后 |
| Persistent context | USER/MEMORY 与 Skills 目录 | 工作区内容变化后 |
| Custom override | 管理员配置的系统提示词 | 配置变化后 |

管理员自定义提示词继续覆盖默认基础指令，但不能移除当前请求的模式、只读状态和其他运行时安全约束。

## 编写规则

- 每条规则只写一次，避免相同约束散落在多个区块。
- 只描述真实存在的工具、模式和权限，不复制 Codex 专属能力。
- 动态内容使用稳定标题或标签包裹，便于测试顺序与边界。
- `AGENTS.md`、Memory 和 Skills 是上下文，不替代对当前代码与工具结果的检查。
- 变更提示词结构时，用回归测试锁定关键区块、排列顺序、自定义覆盖和只读约束。
- 先运行提示词定向测试，再运行后端完整测试和 TypeScript 构建。
