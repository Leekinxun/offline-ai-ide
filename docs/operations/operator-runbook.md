# Operator runbook / 运维手册

This runbook covers backup, restore, retention, process isolation, Git/provider
integrations, secrets, incident recovery, air-gapped transfer, and downgrade.
Evidence IDs resolve in
[`../verification/release-evidence.md`](../verification/release-evidence.md).

本文覆盖备份、恢复、保留策略、进程隔离、Git/Provider 集成、密钥、事故恢复、
隔离网传输和降级。证据 ID 见
[`../verification/release-evidence.md`](../verification/release-evidence.md)。

## Data boundaries / 数据边界

- **Authoritative:** project files and `.git/`; config files; `.history/` except
  rebuildable indexes; `.checkpoints/`; `.team/`; `.codex/`; `.crewforge/`.
- **Rebuildable:** `.history/repository-index/v1/` and ordinary build caches.
- **Sensitive:** `users.json`, `app-settings.json`, provider/MCP secrets,
  extension policies, audit records, traces, prompts, source, patches and bundles.
- Checkpoint capture deliberately excludes control directories such as `.git`,
  `.history`, `.checkpoints`, `.team`, `.codex`, and `.crewforge`. A checkpoint
  is therefore not a full CrownForge backup (`CHK-01`).

- **权威数据：** 项目文件与 `.git/`、配置文件、除可重建索引外的 `.history/`、
  `.checkpoints/`、`.team/`、`.codex/`、`.crewforge/`。
- **可重建数据：** `.history/repository-index/v1/` 与普通构建缓存。
- **敏感数据：** `users.json`、`app-settings.json`、Provider/MCP 密钥、扩展策略、
  审计、Trace、Prompt、源码、Patch 与 Bundle。
- Checkpoint 会主动排除 `.git`、`.history`、`.checkpoints`、`.team`、`.codex`
  与 `.crewforge` 等控制目录，因此 checkpoint 不是完整备份（`CHK-01`）。

## Backup / 备份

1. Reject or drain new model, tool, Git delivery, provider delivery and bundle
   export work. Record any operation already marked `manual_recovery`.
2. Stop the service. Files are written atomically in many stores, but there is
   no cross-store snapshot transaction; a live filesystem copy can be
   internally inconsistent.
3. Copy the complete workspace tree and the directory containing
   `USERS_CONFIG`, `APP_SETTINGS_CONFIG`, and `CREWFORGE_ADMIN_POLICY` when that
   policy lives outside the workspace.
4. Preserve ownership, permissions, timestamps, symlinks and Git metadata.
5. Encrypt the backup, restrict access, and record a checksum and release ID.
6. Restore the copy into a disposable location and run the verification steps
   below. A backup that has never been restored is not treated as verified.

An explicit legacy app-settings v0→v1 helper creates an exact sibling
`app-settings.json.migration-v0-<timestamp>.bak` before replacing the source;
both files are forced to mode `0600`. Ordinary startup only compatibility-reads
v0. When `GET /api/migrations` reports `appSettings.state` as
`legacy_compatible`, an admin may explicitly invoke the helper through
`POST /api/migrations/app-settings/run`. The sibling can contain model, MCP, or provider secrets: include it in
encrypted retention, never loosen its permissions, and do not treat it as a
complete configuration backup. To undo that migration, stop the service, move
the v1 file aside, restore the exact sibling to the configured path with mode
`0600`, and start the matching older release. The process-global team index at
`TEAM_STORE_ROOT/.team/teams.json` has no such automatic migration backup; copy
and restore it separately from each workspace-local `.team` snapshot.

1. 拒绝或排空新的模型、工具、Git delivery、Provider delivery 与 Bundle 导出任务，
   并记录所有已进入 `manual_recovery` 的操作。
2. 停止服务。虽然多个存储采用原子写入，但不存在跨存储快照事务；在线复制可能
   得到内部不一致的状态。
3. 复制完整工作区，以及外部的 `USERS_CONFIG`、`APP_SETTINGS_CONFIG` 和
   `CREWFORGE_ADMIN_POLICY` 所在目录。
4. 保留所有权、权限、时间戳、符号链接和 Git 元数据。
5. 加密备份、限制访问，并记录校验和与版本号。
6. 在一次性目录中恢复并执行下文验证。没有实际恢复过的备份不视为已验证。

显式的旧版 app-settings v0→v1 helper 会先创建精确的同目录备份
`app-settings.json.migration-v0-<timestamp>.bak`，再替换源文件；两者权限都会强制
设为 `0600`。普通启动只兼容读取 v0；当 `GET /api/migrations` 返回
`appSettings.state` 为 `legacy_compatible` 时，管理员可通过
`POST /api/migrations/app-settings/run` 显式调用该 helper。同目录备份可能包含模型、MCP 或 Provider 密钥，因此必须纳入加密保留策略、不得放宽
权限，也不能把它视为完整配置备份。若要撤销迁移，应先停止服务、移开 v1 文件、以
`0600` 权限把精确备份恢复到配置路径，再启动匹配的旧版本。进程全局团队索引
`TEAM_STORE_ROOT/.team/teams.json` 没有自动迁移备份，必须与每个工作区本地的
`.team` 快照分开复制和恢复。

### Restore verification / 恢复验证

- Start with provider delivery disabled and without approving any Git mutation.
- Confirm login and allowed workspace roots.
- List conversation and run history; open at least one run and its context
  manifest.
- Call checkpoint verification before attempting a restore. A failed blob or
  manifest verification is an incident, not a reason to run “repair” blindly.
- List task/team, trace, review, bundle and delivery status.
- Run `git fsck --full` and inspect `git status --porcelain=v1` for each restored
  repository.
- Verify configured provider capability using a read-only probe only after
  credentials and network policy are approved.

- 初始启动时禁用 Provider delivery，且不要批准任何 Git 修改。
- 验证登录与允许的工作区根路径。
- 列出会话和运行历史，打开至少一个运行及其 context manifest。
- 恢复 checkpoint 前先执行完整性验证。Blob/manifest 验证失败属于事故，不能
  直接用“repair”掩盖。
- 检查 task/team、trace、review、bundle 与 delivery 状态。
- 对每个恢复后的仓库执行 `git fsck --full` 并检查
  `git status --porcelain=v1`。
- 只有在密钥与网络策略获批后，才使用只读 probe 验证 Provider 能力。

## Retention / 保留策略

- Conversations: newest 30; older conversation files are deleted automatically
  (`HIST-01`).
- Runs: newest 100; each run keeps at most 250 events and 250 tool executions
  (`RUN-01`).
- Checkpoints: default 12, configurable from 4 to 100. Preview retention before
  applying it. The newest run checkpoint for up to four distinct runs is
  protected when possible (`CHK-02`).
- Traces: default hot limit 10,000; configurable hot/archive count and age.
  Preview pruning before applying it (`TRACE-01`).
- Mutation journals, delivery/review state, bundles and migration backups have
  their own bounds or no operator-configurable retention. Monitor them as part
  of workspace storage; do not invent a deletion policy.

- 会话：自动保留最近 30 个（`HIST-01`）。
- 运行：自动保留最近 100 个；每个运行最多保存 250 条事件和 250 个工具执行记录
  （`RUN-01`）。
- Checkpoint：默认 12 个，可配置 4–100 个；应用前先 dry-run。系统会尽可能保护
  最近四个不同运行的 run checkpoint（`CHK-02`）。
- Trace：热数据默认最多 10,000 条，可配置热区/归档条数与时间；应用前先预览
  （`TRACE-01`）。
- Mutation、delivery/review、bundle 与迁移备份各有自己的上限或尚无可配置保留
  策略。应监控空间使用，不能自行假设删除规则。

## Process and sandbox profiles / 进程与沙箱

| Surface | Enforced behavior | Platform limits |
| --- | --- | --- |
| Approved agent shell | Structured argv, minimal environment, blocked loader variables, wall timeout and bounded output; network mode is deny | Network deny requires `/usr/bin/sandbox-exec` on macOS or `bubblewrap` plus usable user namespaces on Linux. Unsupported hosts fail the agent shell closed (`PROC-01`). |
| Resource limits | POSIX wrapper can enforce CPU/open-file limits; address-space limit is Linux-only | Windows lacks the POSIX hard-limit path. macOS address-space hard limits are not exposed through this wrapper (`PROC-01`). |
| Filesystem | Tool policy, safe-path checks, workspace scope and managed worktrees constrain CrownForge operations | The process wrapper is **not** a complete filesystem sandbox. macOS Seatbelt and Linux bubblewrap are currently used for network denial, not a fully isolated filesystem (`PROC-01`). |
| Debug target and user terminal | Minimal launcher environment and process supervision | These are not the agent network-deny sandbox; do not use them for untrusted code (`DBG-01`). |
| Docker service | Non-root UID/GID 10001, read-only root, dropped capabilities, no-new-privileges, writable workspace/config mounts | Verified by `scripts/docker-smoke.sh` only on a host with Docker and compatible user namespaces (`CONT-01`). |

`sandbox`, `worktree`, and `workspace` in an agent profile describe the requested
execution boundary. Effective permission is the intersection of profile,
server policy, team role, plan/approval and extension policy; a profile cannot
expand a denied permission (`PROF-01`, `EXT-01`).

Agent profile 中的 `sandbox`、`worktree` 与 `workspace` 表示请求的执行边界。
最终权限是 profile、服务端策略、团队角色、计划/审批与扩展策略的交集；profile
不能放大已被拒绝的权限（`PROF-01`、`EXT-01`）。

## Git and provider integrations / Git 与 Provider 集成

### Local Git delivery

- Supports preparing approved branch creation, fast-forward, immutable reviewed
  ChangeSet commits, rebase, cherry-pick and exact-ref push operations.
- High-risk operations require approval bound to the exact preflight digest.
  CAS and `--force-with-lease` checks reject stale local or remote state.
- Rebase/cherry-pick run in a temporary worktree; conflicts leave the live
  delivery ref unchanged. Parent staged, dirty and untracked files are preserved
  by immutable ChangeSet delivery (`GIT-01`).
- Restart reconciliation may mark an operation completed, queued, failed or
  `manual_recovery`. Never repeat a `manual_recovery` push until the exact remote
  ref is inspected (`GIT-01`).

### GitHub, GitLab and Gitea provider delivery

- Provider adapters cover capability probe, proposal creation, checks/status,
  review feedback and signed webhook verification using mock HTTP evidence
  (`DEL-01`). No real hosted provider is contacted by the test suite.
- Tokens are named by environment-variable reference in delivery settings.
  Webhook secrets must also be supplied through an environment variable.
- Create/update operations are idempotent and bound to server-owned approval and
  immutable revision evidence. Ambiguous write results remain ambiguous until a
  read-only reconciliation finds the owned remote (`DEL-01`, `DEL-02`).

### 本地 Git delivery

- 支持经审批的分支创建、fast-forward、基于不可变审阅 ChangeSet 的提交、rebase、
  cherry-pick 与精确 ref push。
- 高风险操作的审批与精确 preflight digest 绑定；CAS 与
  `--force-with-lease` 会拒绝陈旧的本地或远端状态。
- Rebase/cherry-pick 在临时 worktree 中执行；冲突不会移动线上 delivery ref。
  ChangeSet delivery 会保留父工作区的 staged、dirty 与 untracked 文件（`GIT-01`）。
- 重启协调可能把操作标为 completed、queued、failed 或 `manual_recovery`。检查精确
  远端 ref 前，不得重放 `manual_recovery` push（`GIT-01`）。

### GitHub、GitLab 与 Gitea Provider delivery

- Adapter 覆盖能力探测、Proposal 创建、Checks/Status、Review feedback 与签名
  Webhook 校验，证据来自 Mock HTTP（`DEL-01`），测试不会调用真实托管平台。
- Delivery 设置只保存 Token 的环境变量名；Webhook Secret 同样应通过环境变量提供。
- 创建/更新具有幂等性，并绑定服务端审批与不可变修订证据。写入结果不明确时会保留
  ambiguous 状态，直到只读协调确认自有远端对象（`DEL-01`、`DEL-02`）。

## Secrets / 密钥

- Treat `users.json` as a credential database. Passwords are currently stored in
  its configured JSON representation; protect the file at rest and limit it to
  the service account.
- `app-settings.json` can contain the LLM API key and inline MCP headers. Prefer
  environment-variable-backed OAuth/token settings where supported. Do not
  commit either config file.
- Provider delivery stores environment-variable **names**, not token values.
- Process launchers start from a minimal environment and block common loader
  injection variables. Redaction is defense in depth, not a substitute for
  access control (`SEC-01`, `SEC-02`).
- Evidence bundle export refuses recognizable secrets in immutable patch bytes,
  but no detector proves that arbitrary source is secret-free (`AIR-01`). Review
  bundle contents before transfer.

- `users.json` 是凭证数据库。目前密码保存在其配置 JSON 中，应进行静态加密并把
  文件权限限制给服务账户。
- `app-settings.json` 可能包含 LLM API key 与内联 MCP Header。支持时优先使用基于
  环境变量的 OAuth/Token 配置，不要提交这两个配置文件。
- Provider delivery 只持久化环境变量名，不保存 Token 值。
- 进程启动器使用最小环境并屏蔽常见 loader 注入变量。脱敏只是纵深防御，不能替代
  访问控制（`SEC-01`、`SEC-02`）。
- Evidence bundle 会拒绝 Patch 中可识别的密钥，但任何检测器都无法证明任意源码绝对
  无密钥（`AIR-01`）。传输前仍须人工审阅 Bundle 内容。

## Incident recovery / 事故恢复

| Symptom | Safe response |
| --- | --- |
| `GET /api/migrations` returns `statusError`, `failed`, or `future_version` | Stop writes and preserve the complete `.codex/migrations/` directory with the workspace. For `statusError`, do not run migration/rollback and do not hand-edit `status.json`; restore the matching complete snapshot and migration control metadata. A future version requires the matching/newer server. |
| `POST /api/migrations/run` returns `409` with a skipped reason `active_lock` | Treat it as a rollout blocker. Quiesce writes, confirm the owning process released the orchestration-store lock, and rerun. A `superseded` skip for legacy `.team/config.json` is benign and nonblocking when canonical `.team/state/team-config.json` is present. |
| Checkpoint verify reports missing/corrupt data | Do not restore it. Preserve `.checkpoints/` for analysis. `/repair` only previews/removes unreferenced blobs; it does not reconstruct corrupt referenced data (`CHK-01`). |
| Mutation rollback reports conflicts/unavailable | No write occurs in the default refusal path. Inspect human edits, hashes and symlink state; choose a narrower mutation/hunk or restore an external backup (`MUT-01`). |
| Orphaned model/tool run | Run history marks unfinished tools interrupted during recovery; inspect current workspace before resuming (`RUN-01`). |
| Local Git operation is `manual_recovery` | Inspect exact local ref, intended SHA, remote ref and approval digest. Do not approve a duplicate operation (`GIT-01`). |
| Provider publication is ambiguous | Use read-only reconciliation. Do not issue a second create/update until the owned remote is found or an operator resolves the ambiguity (`DEL-01`). |
| Trace store is busy | Do not remove a live lock. Dead owners are reclaimed only after process-death confirmation; preserve evidence if contention persists (`TRACE-01`). |
| Suspected secret exposure | Stop affected provider/MCP delivery, rotate the upstream secret, preserve redacted trace/audit evidence, replace config, and invalidate exported bundles that may contain the old value. |

Authenticated users can read migration inventory/status at `GET /api/migrations`.
Only admins can execute `POST /api/migrations/run` or
`POST /api/migrations/rollback`. Rollback requires a canonical,
rollback-capable ID such as `{"formatId":"tasks"}`; missing, blank, unknown,
compatibility-only, rebuildable, and append-only IDs return `400`. A valid
request restores the exact pre-migration bytes for that format (including a
multi-step migration) and refuses if the post-migration file hash changed
(`MIG-01`). Admin-only `POST /api/migrations/app-settings/run` separately
migrates legacy-compatible app settings. Stop writes before any mutation.

已认证用户可通过 `GET /api/migrations` 读取迁移清单与状态；只有管理员可执行
`POST /api/migrations/run` 和 `POST /api/migrations/rollback`。回滚接口必须接收
可回滚格式的规范 ID，例如 `{"formatId":"tasks"}`；缺失、空白、未知、仅兼容读取、
可重建或仅追加的 ID 会返回 `400`。有效请求会恢复该格式迁移前精确字节（包括跨多个
版本的迁移），并会在迁移后文件哈希发生变化时拒绝执行（`MIG-01`）。管理员还可通过
`POST /api/migrations/app-settings/run` 单独迁移兼容旧版的 app settings。执行任何
迁移写入前都必须停止业务写入。

## Air-gapped transfer and application update / 隔离网传输与应用更新

### Change/evidence bundles

`.cfbundle` export is deterministic and integrity/binding verified. It can prove
whether the embedded patch applies to the inspected base without modifying the
workspace. Bundles are unsigned unless an external signature is present; the
current repository exposes verification but **does not expose an automatic
bundle-apply endpoint** (`AIR-01`). Transfer and verify the bundle, then use the
normal reviewed ChangeSet/Git process to apply an approved change.

`.cfbundle` 导出具有确定性，并校验完整性与绑定关系。它可以在不修改工作区的情况
下判断 Patch 是否适用于被检查的 Base。除非另有外部签名，否则 Bundle 是 unsigned；
当前仓库提供验证，但**没有自动 Bundle Apply 接口**（`AIR-01`）。应先传输并验证，
再通过正常的审阅 ChangeSet/Git 流程应用获批变更。

### CrownForge application update

The repository does not contain a tested offline updater. For an air-gapped
deployment, build and verify the exact image in a connected staging environment,
record its immutable digest and verification output, export/import it with the
container runtime, then follow the storage upgrade sequence on a disposable
copy before production. Image transfer commands are runtime-specific and are an
operator procedure, not a verified CrownForge feature (`OPS-01`).

仓库没有经过测试的离线应用更新器。隔离网部署应在联网的 Staging 环境构建并验证
精确镜像，记录不可变 Digest 与验证输出，通过容器运行时导出/导入，再按存储升级
步骤先验证一次性副本。镜像传输命令取决于容器运行时，属于运维流程，不是已验证的
CrownForge 功能（`OPS-01`）。

## Downgrade / 降级

1. Stop the newer release and preserve its data separately.
2. Restore the complete pre-upgrade workspace and config snapshot; do not mix
   generations across `.history`, `.checkpoints`, `.team`, `.codex` and `.git`.
3. Start the older release with provider delivery disabled and no approved Git
   mutations.
4. Run restore verification, then reopen external integrations deliberately.

1. 停止新版本并把其数据完整保存到旁路位置。
2. 恢复完整的升级前工作区与配置快照；不要混用不同代的 `.history`、
   `.checkpoints`、`.team`、`.codex` 与 `.git`。
3. 启动旧版本时禁用 Provider delivery，也不要预先批准 Git 修改。
4. 完成恢复验证后，再逐项开启外部集成。
