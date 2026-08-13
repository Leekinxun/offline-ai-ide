# Storage migrations / 存储迁移

This document is the operator-facing contract for CrownForge persisted data. It
distinguishes a real forward migration from a compatibility reader, a rebuild,
and a manual restore. The matrix identifies the unified workspace migrator and
the separately tested app-settings helper; inventory membership alone never
means that startup rewrites a file.

本文是 CrownForge 持久化数据的运维契约。它明确区分真正的前向迁移、兼容读取、
重新构建与手工恢复。矩阵会区分统一工作区迁移器与单独测试的 app-settings helper；
仅仅列入清单绝不代表启动时会重写文件。

## Rules / 规则

- Stop CrownForge writes and take an external backup before an application
  upgrade or downgrade. Per-file migration backups are a last-resort rollback
  aid; they are not a complete workspace backup.
- A versioned JSON migration writes the original file to
  `.codex/migrations/backups/<migration-id>/...`, writes the replacement
  atomically, and appends status to `.codex/migrations/status.json`.
- A persisted version newer than the running server fails closed. Do not edit a
  schema number by hand.
- If `GET /api/migrations` returns `statusError`, stop writes and preserve the complete `.codex/migrations/`
  directory. Do not run migration or rollback and
  do not hand-edit `status.json`; restore the matching complete workspace
  snapshot together with its migration control metadata.
- Admin rollback through `POST /api/migrations/rollback` requires a canonical,
  rollback-capable `formatId` such as `{"formatId":"tasks"}`. Missing, blank,
  or unknown IDs are rejected. The endpoint restores the exact pre-migration
  bytes for that format, including a multi-step migration, and refuses to
  overwrite a file whose post-migration hash changed. Use a quiesced external
  backup for a complete production downgrade.
- “Compatibility read” means the current server can normalize an older record
  in memory. It does not imply that the source file was backed up or rewritten.

- 升级或降级前必须停止 CrownForge 写入并制作外部备份。单文件迁移备份只是最后
  的回退辅助，不等同于完整工作区备份。
- 版本化 JSON 迁移会先把原文件复制到
  `.codex/migrations/backups/<migration-id>/...`，再原子写入新文件，并把状态追加
  到 `.codex/migrations/status.json`。
- 当持久化版本高于当前服务支持版本时，系统会 fail closed。不要手工修改版本号。
- 若 `GET /api/migrations` 返回 `statusError`，应停止写入并完整保留
  `.codex/migrations/`。不要执行迁移或回滚，也不要手工编辑 `status.json`；必须将
  匹配的完整工作区快照与其迁移控制元数据一起恢复。
- 管理员调用 `POST /api/migrations/rollback` 时必须提供可回滚格式的规范
  `formatId`，例如 `{"formatId":"tasks"}`；缺失、空白或未知 ID 会返回错误。接口会
  恢复该格式迁移前的精确字节，包括跨多个 schema 步骤的迁移；文件在迁移后发生
  变化时会拒绝覆盖。完整生产降级仍应恢复停写状态下制作的外部备份。
- “兼容读取”只表示当前服务可在内存中规范化旧记录，并不表示旧文件已自动备份或重写。

## Material format matrix / 关键格式矩阵

| Format | Canonical location | Current format | Forward behavior | Compatibility read | Backup and downgrade | Verification |
| --- | --- | --- | --- | --- | --- | --- |
| Workspace source and Git data | workspace files and `.git/` | Owned by the project/Git | Not migrated by CrownForge | Git decides repository compatibility | External quiesced backup; use Git refs/commits for source rollback | `GIT-01`, `OPS-01` |
| Users configuration | `USERS_CONFIG`; Docker default `/app/config/users.json` | Unversioned JSON | No automatic schema migration | Invalid users are discarded during normalization | External config backup only; contains credentials | `CFG-01`, `SEC-02` |
| Application, LLM, MCP, agent and delivery settings | `APP_SETTINGS_CONFIG`; Docker default `/app/config/app-settings.json` | Schema v1; missing `schemaVersion` is legacy v0 | Startup performs a read-only compatibility load and reports `legacy_compatible`; admin-only `POST /api/migrations/app-settings/run` invokes the separate `migrateAppSettingsFile` helper to write v1 explicitly | Legacy v0 sections remain readable without a startup rewrite; unsupported future versions fail closed | Explicit migration creates an exact sibling `app-settings.json.migration-v0-<timestamp>.bak`; backup and replacement are mode `0600`. Rollback is a stopped-service manual restore; retain an external encrypted config backup | `CFG-01`, `SEC-02`, `WS14-MIGRATION` |
| Conversations | `.history/*.jsonl` | Line-oriented messages and metadata; 30-conversation retention | No automatic schema rewrite | Legacy message fields are preserved while structured parts are derived | External backup; deletion/pruning is not reversible by CrownForge | `HIST-01` |
| Agent runs and embedded completion evidence | `.history/runs/*.json` | Run schema v3; completion evidence v1 | No general file migration hook | Legacy run records normalize to v3; future versions are rejected | External backup; only the newest 100 runs are retained | `RUN-01` |
| Context manifests and preferences | `.history/context-manifests/*.json`, `.history/context-preferences/*.json` | Versioned manifest/preference records | No automatic schema migration | Invalid/future records fail safe according to their readers | External backup; do not copy manifests without the conversations/runs they reference | `CTX-01` |
| Checkpoint index, manifests and blobs | `.checkpoints/index.json`, `.checkpoints/manifests/`, `.checkpoints/blobs/` | Legacy snapshots plus v2/v3 manifests; retention settings v1 | New checkpoints use incremental v3; old snapshots are read, not bulk-rewritten | Legacy, v2 and v3 restore paths are tested | External backup; restore creates a “Before restore” checkpoint; default retention is 12, configurable 4–100 | `CHK-01`, `CHK-02` |
| Mutation journal | `.checkpoints/mutations.json` and referenced blobs | Journal schema v1 | Admin migration run upgrades legacy schema 0 and creates a backup | Missing/corrupt journals yield no trusted rollback entries | One-version admin rollback if unchanged; mutation rollback separately refuses drift and unsafe symlink targets | `MIG-01`, `MUT-01` |
| Tasks | `.team/state/tasks.json` | Schema v1 | **Automatic on read** from legacy schema 0; original is backed up before rewrite | Seed merge supplies missing v1 fields | One-version library rollback only if unchanged; otherwise external backup | `MIG-01`, `TASK-01` |
| Agent/team message bus | `.team/state/messages.json` | Schema v1 | **Automatic on read** from legacy schema 0; original is backed up before rewrite | Seed merge supplies missing v1 fields | Same restriction as tasks | `MIG-01`, `MSG-01` |
| Provider delivery state | `.team/state/provider-delivery.json` | Schema v2 | **Automatic on read** through each missing version, or through the admin migration run; original is backed up before rewrite | Step seed merge supplies missing current fields | Admin rollback restores exact pre-migration bytes if unchanged, including schema 0→2; complete release downgrade still requires an external backup | `MIG-01`, `DEL-01` |
| Local Git delivery state | `.team/state/git-delivery.json` | Schema v1 | **Automatic on read** from legacy schema 0; original is backed up before rewrite | Seed merge supplies missing v1 fields | One-version library rollback if unchanged; otherwise external backup | `MIG-01`, `GIT-01` |
| Model budgets | `.team/state/model-budgets.json` | Schema v1 | **Automatic on read** from legacy schema 0; original is backed up before rewrite | Seed merge supplies missing v1 fields | One-version library rollback if unchanged; otherwise external backup | `MIG-01`, `MOD-01` |
| Team membership/runtime configuration | `.team/config.json` | Team schema v1 | Admin migration run upgrades legacy schema 0 in place and creates a backup | Legacy content is read and missing schema is supplied in memory | One-version admin rollback if unchanged; startup separately reconciles stale runtime leases | `MIG-01`, `TEAM-01` |
| Collaboration state | `.team/collaboration-v1.json` | Schema v1 | Admin migration run upgrades legacy schema 0 and creates a backup | A missing store is compatible empty state; an existing corrupt, unreadable, or future-schema store is preserved and fails closed | One-version admin rollback if unchanged; otherwise restore the complete file from a trusted external backup rather than deleting it or substituting empty state | `MIG-01`, `COL-01` |
| Trace events and retention | `.history/traces/events.jsonl`, `archive.jsonl`, `retention.json` | Append-only event schema v1 | Not rewritten; append-only | Invalid lines are ignored; legacy count metadata is derived | Export before pruning; trace rollback is not applicable | `TRACE-01` |
| Repository index | `.history/repository-index/v1/` | Rebuildable v1 cache | No data migration; rebuild instead | Not a source of truth | Exclude from backups if rebuild time is acceptable | `IDX-01` |
| Change sets, review runs/findings and evidence bundles | `.history/change-sets/`, `.history/change-set-review-runs.json`, `.history/review-findings.json`, `.history/evidence-bundle-exports.json`, `.history/evidence-bundles/` | Individually versioned records and immutable blobs | No unified migration hook | Only explicitly supported record versions are accepted; corrupt immutable blobs fail closed | Back up together with runs, traces and Git data; never restore only metadata without its blobs | `REV-01`, `AIR-01` |
| Delivery feedback | `.history/delivery-feedback.json` | Schema v1 | Admin migration run upgrades legacy schema 0 and creates a backup | Versioned reader only | One-version admin rollback if unchanged; keep paired with provider-delivery state | `MIG-01`, `DEL-02` |
| Extension policies and audit | `$CREWFORGE_ADMIN_POLICY`, `.codex/policy-override.json`, `.codex/audit/`, `.crewforge/policy-audit.jsonl` | Versioned policy records plus append-only audit | Admin migration run covers only the workspace override; admin policy and audits are not rewritten | Unsupported policy records fail closed or normalize through their reader | One-version admin rollback for workspace override if unchanged; externally back up admin policy and append-only audit | `MIG-01`, `EXT-01`, `SEC-01` |
| Workspace memory, skills and plugin overrides | `.codex/`, plugin directories, and app settings | Markdown, manifests and JSON | No unified migration hook | Plugin/skill readers validate supported manifests | External backup; never restore untrusted plugins without revalidation | `PLUG-01`, `MEM-01` |

## Machine-readable inventory crosswalk / 机器可读清单交叉表

The identifiers below exactly match `MATERIAL_PERSISTENCE_INVENTORY` in
`backend/src/persistence/migrations.ts`. This table is exhaustive for that
inventory, but “listed” does not mean “automatically rewritten”. The behavior
column is the authoritative distinction.

下列标识与 `backend/src/persistence/migrations.ts` 中的
`MATERIAL_PERSISTENCE_INVENTORY` 完全一致。表格覆盖该清单的全部项目，但“已列出”
不代表“会自动重写”；应以行为列为准。

| Inventory ID | Forward and compatibility behavior | Backup, rollback, or downgrade | Verification |
| --- | --- | --- | --- |
| `chat-history` | Append-only conversation records; compatibility reader, no migration rewrite | External backup; deleted/pruned records require restore | `HIST-01` |
| `agent-runs` | Legacy run records normalize in memory to v3; no bulk rewrite | External backup; future versions fail closed | `RUN-01` |
| `completion-evidence` | Versioned v1 evidence embedded in run records; no separate migration target | Restore with the matching run-history snapshot | `RUN-01` |
| `execution-plans` | Legacy plans are compatibility-read into current v2; no unified migration target | External backup with runs and conversations | `RUN-01` |
| `context-manifests` | Versioned reader; no unified migration target | External backup with referenced runs/conversations | `CTX-01` |
| `change-sets` | Current records use schema v3 from the shared runtime contract; legacy/current supported versions are reader-controlled and there is no unified rewrite. Integration WAL records have an independent schema-v3 contract | External backup with review and Git evidence; the workspace migration runner does not create or roll back ChangeSet backups | `REV-01` |
| `managed-worktrees` | Versioned metadata reader; worktrees themselves remain Git/workspace data | Back up Git refs and workspace data together | `GIT-01`, `OPS-01` |
| `review-artifacts` | Derived review/SARIF output; regenerate from authoritative inputs when possible | No in-place rollback; restore inputs or rebuild | `REV-01` |
| `evidence-bundle-exports` | Versioned export index plus immutable bundles; no unified rewrite | Restore index and bundle blobs from the same snapshot | `AIR-01` |
| `checkpoints` | Legacy/v2/v3 compatibility readers; new writes use v3, no bulk rewrite | Restore the full checkpoint index/manifests/blobs set | `CHK-01`, `CHK-02` |
| `mutation-journal` | Admin migration upgrades schema 0 to v1 | Automatic per-file backup; hash-fenced exact-backup rollback if unchanged | `MIG-01`, `MUT-01` |
| `tasks` | OrchestrationStore migrates schema 0 to v1 on read; admin migration can do the same eagerly | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `TASK-01` |
| `messages` | OrchestrationStore migrates schema 0 to v1 on read; admin migration can do the same eagerly | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `MSG-01` |
| `team-config` | Admin migration covers legacy `.team/config.json` and current `.team/state/team-config.json`; compatible readers normalize missing fields | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `TEAM-01` |
| `team-index` | The process-global team index at `TEAM_STORE_ROOT/.team/teams.json` has an unversioned compatibility reader that normalizes team/member/invite/claim/presence/activity fields in memory; it is distinct from workspace runtime `team-config` and is not registered with the migration runner | Stop writes and externally back up/restore the complete `TEAM_STORE_ROOT/.team/teams.json`; there is no automatic migration backup or built-in rollback | `TEAM-01`, `OPS-01` |
| `traces` | Append-only events; invalid lines are ignored, no migration rewrite | Export before pruning; in-place rollback is not applicable | `TRACE-01` |
| `repository-index` | Rebuildable cache; no data migration | Rebuild instead of restoring when acceptable | `IDX-01` |
| `provider-delivery` | OrchestrationStore/admin migration applies schema 0→1→2 steps | Automatic per-file backup; rollback restores exact schema-0 bytes if unchanged | `MIG-01`, `DEL-01` |
| `git-delivery` | OrchestrationStore/admin migration upgrades schema 0 to v1 | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `GIT-01` |
| `delivery-feedback` | Admin migration upgrades schema 0 to v1 | Automatic per-file backup; restore with provider-delivery state | `MIG-01`, `DEL-02` |
| `review-findings` | Versioned reader; not registered with the admin migration runner | External backup with review/change-set data | `REV-01` |
| `extension-admin-policy` | Versioned external policy; not registered with the workspace migration runner | Back up the configured external policy path separately | `EXT-01`, `SEC-02` |
| `extension-workspace-policy` | Admin migration upgrades schema 0 to v1 | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `EXT-01` |
| `plugin-manifests` | Legacy-aware manifest validation; no unified migration target | External backup and revalidation before restore | `PLUG-01` |
| `collaboration` | Admin migration upgrades schema 0 to v1 | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `COL-01` |
| `model-budgets` | OrchestrationStore/admin migration upgrades schema 0 to v1 | Automatic per-file backup; exact-backup rollback if unchanged | `MIG-01`, `MOD-01` |
| `app-settings` | Startup compatibility-reads unversioned v0 without writing; admin-only `POST /api/migrations/app-settings/run` invokes `migrateAppSettingsFile` to write schema v1 independently from the workspace migration runner | Exact sibling v0 bytes and migrated file are mode `0600`; manually restore the sibling while stopped or restore the external encrypted config backup | `CFG-01`, `SEC-02`, `WS14-MIGRATION` |

## Upgrade sequence / 升级步骤

1. Run the release verification command recorded in
   [`../verification/release-evidence.md`](../verification/release-evidence.md).
2. Stop new runs, provider delivery polling, and Git delivery operations; then
   stop the CrownForge service.
3. Back up the entire workspace (including `.git`, `.history`, `.checkpoints`,
   `.team`, `.codex`, and `.crewforge`) and the external config directory.
4. Start the new release against a disposable copy first. Exercise login,
   history listing, run details, checkpoint verification, task/team listing, and
   Git/provider delivery read-only status.
5. Read `GET /api/migrations`, then run `POST /api/migrations/run` as an admin on
   the disposable copy. If `appSettings.state` is `legacy_compatible`, also run
   admin-only `POST /api/migrations/app-settings/run`. Inspect
   `.codex/migrations/status.json`; `statusError` or any `failed` or
   `future_version` record blocks the rollout. A migration result skipped with
   reason `active_lock` also blocks rollout and returns `409`; quiesce writes,
   verify the owning process has released the store lock, and rerun. A
   `superseded` skip for legacy `.team/config.json` is benign and nonblocking
   when the canonical `.team/state/team-config.json` is present.
6. Start the production copy, run the same admin migration endpoint, and retain the pre-upgrade backup until the agreed
   rollback window closes.

1. 执行 [`../verification/release-evidence.md`](../verification/release-evidence.md)
   中记录的发布验证命令。
2. 停止创建新运行、Provider delivery 轮询和 Git delivery 操作，然后停止服务。
3. 备份完整工作区（包括 `.git`、`.history`、`.checkpoints`、`.team`、`.codex`
   与 `.crewforge`）以及外部配置目录。
4. 先在一次性副本上启动新版本，检查登录、历史列表、运行详情、checkpoint 验证、
   task/team 列表以及 Git/provider delivery 的只读状态。
5. 先读取 `GET /api/migrations`，再以管理员身份在一次性副本调用
   `POST /api/migrations/run`。若 `appSettings.state` 为 `legacy_compatible`，还要调用
   管理员接口 `POST /api/migrations/app-settings/run`。检查
   `.codex/migrations/status.json`；出现 `statusError`、`failed` 或
   `future_version` 时阻止上线。若迁移结果因 `active_lock` 被跳过，也会返回 `409` 并
   阻止上线；应停止写入、确认持有进程已释放存储锁后重新执行。旧版
   `.team/config.json` 因 `superseded` 被跳过是良性且不阻塞的，前提是规范路径
   `.team/state/team-config.json` 已存在。
6. 启动生产副本后执行同一管理员迁移接口，并在回滚窗口结束前保留升级前备份。

## Downgrade and rollback / 降级与回滚

- Preferred: stop the new release, move its workspace/config aside, restore the
  complete pre-upgrade snapshot, and then start the old release. Never run an
  older binary directly against data already written by a newer release.
- `POST /api/migrations/rollback` is admin-only and requires a canonical,
  rollback-capable ID in the body, for example `{"formatId":"tasks"}`. Missing,
  blank, unknown, compatibility-only, rebuildable, and append-only IDs are
  rejected. A valid request restores the exact pre-migration bytes for that
  format, even when the forward migration crossed multiple versions. It is
  hash-fenced: use it only while writes are stopped and do not bypass its checks.
- Rebuildable indexes may be removed and rebuilt, but authoritative history,
  checkpoints, delivery idempotency, reviews, and audit data must be restored
  from the same snapshot generation.

- 推荐做法：停止新版本，把其工作区和配置移到旁路位置，恢复完整的升级前快照，
  然后再启动旧版本。不要让旧二进制直接读取已被新版本写入的数据。
- 管理员调用 `POST /api/migrations/rollback` 时必须传入可回滚格式的规范 ID，例如
  `{"formatId":"tasks"}`。缺失、空白、未知、仅兼容读取、可重建或仅追加的 ID 都会
  被拒绝。有效请求会恢复该格式迁移前的精确字节，即使前向迁移跨越多个版本；接口带
  哈希保护，必须在停止写入后使用，且不得手工绕过检查。
- 仓库索引等缓存可删除重建，但历史、checkpoint、delivery 幂等状态、审阅与审计
  数据必须从同一代快照一起恢复。
