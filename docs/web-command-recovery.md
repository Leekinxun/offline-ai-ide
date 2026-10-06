# Web command recovery / Web 命令与回滚

Web follows the recovery approach introduced on `APP_RUST` in `65b3d14` and
`c8ed8fb`. Starting a Code turn, executing a command, and delegating work no
longer require a full-workspace checkpoint. Projects above 20,000 files or
64 MiB therefore do not fail these operations because of snapshot limits.

- `write_file`, `edit_file`, and `rename_file` retain exact file mutation
  journals. Evidence is prepared before changing files; journal commit failures
  restore the tool's own edit without replacing a concurrent writer's file.
- Bash, process, and external tool calls persist small execution receipts under
  `.history/external-tools`. Their effects have `rollbackCoverage: "untracked"`
  and `observationComplete: false`; no project contents are copied for them.
- Command receipts participate in review revisions. Missing or corrupt expected
  receipts prevent rollback. Whole-run and whole-turn rollback refuse untracked
  effects, while selected recorded files and hunks remain undoable.
- Text artifacts rejected for NUL bytes after commands receive targeted repair
  checks without being attributed as recorded edits. Ordinary reads do not
  imply that the file was changed. This is bounded inspection, not complete
  observation of command effects.
- Manual workspace checkpoints and explicit restore remain available with their
  existing limits. Blob cleanup retains data referenced by file journals.

This is the project's own recovery contract. It does not change tool approvals,
workspace permissions, or sandbox policy. Upstream Codex removed ghost snapshots
in [openai/codex#19481](https://github.com/openai/codex/pull/19481); this project
continues to provide its own recorded-file undo and manual checkpoints.

Web 端采用 `APP_RUST` 的处理方式：聊天启动、命令执行和委派任务不再先备份整个
项目。文件写入、编辑、重命名保留精确的单文件回滚日志；命令与外部工具只记录
执行收据，并明确标注其文件影响不在自动撤销范围内。

整轮或整次运行撤销遇到这类命令影响时会拒绝执行，避免把未完整观察到的影响
误当成已完整回滚。已记录的文件或 Hunk 仍可单独撤销。手动检查点及明确确认的
恢复操作仍保留原有大小限制；审批、权限与沙箱规则保持原有边界。
