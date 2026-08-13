# Release claim-to-verification matrix / 发布声明验证矩阵

Only claims listed as **Verified** may be stated as current behavior without a
qualification. **Conditional** claims require the platform condition in the
same sentence. **Procedure** means an operator recommendation, not an automated
CrownForge feature. **Gap** means the repository does not currently prove the
claim.

只有标为 **Verified** 的声明才能无条件描述为当前行为。**Conditional** 必须在同一
句话中写明平台条件；**Procedure** 表示运维建议，并非 CrownForge 自动功能；
**Gap** 表示当前仓库无法证明该声明。

| ID | Material claim | Automated evidence | Status / limits |
| --- | --- | --- | --- |
| `MIG-01` | Versioned orchestration JSON performs forward migration, creates a pre-write backup, journals hashes/status, rejects future versions, exposes corrupt/unsupported journal `statusError`, and provides admin-only, hash-fenced exact-backup rollback, including multi-step migrations | `backend/src/persistence/migrations.test.ts`; `backend/src/security/g007StorageMigrationContract.test.ts`; `backend/src/agent/orchestrationStore.ts`; `backend/src/routes/migrations.ts` | **Verified for the formats registered by `migrateWorkspacePersistence` and versioned OrchestrationStore readers.** Rollback requires a canonical rollback-capable ID such as `{"formatId":"tasks"}` and rejects missing, blank, unknown, compatibility-only, append-only, or rebuildable IDs. `statusError` blocks rollout and requires preservation/restoration of the complete `.codex/migrations/` control state; do not run migration/rollback or hand-edit it. A skipped reason `active_lock` returns `409` and blocks rollout until writes are quiesced and migration reruns; `superseded` legacy team-config is benign/nonblocking when canonical team-config exists. The inventory contains formats that are not rewritten. |
| `CFG-01` | User/session configuration loads from configured paths; app-settings startup compatibility-reads unversioned v0 without mutation, while explicit migration writes v1 with an exact private sibling backup | `backend/src/auth/sessionManager.test.ts`; `backend/src/config.ts`; `backend/src/routes/migrations.ts`; `backend/src/security/g007StorageMigrationContract.test.ts`; `scripts/docker-smoke.sh` | **Verified file and routing behavior:** the app-settings test proves non-mutating compatibility read, exact bytes, and mode `0600` on backup and replacement; admin-only `POST /api/migrations/app-settings/run` invokes `migrateAppSettingsFile`. `POST /api/migrations/run` remains limited to registered workspace migrations. |
| `HIST-01` | Conversations persist per workspace, preserve legacy message fields, support fork/delete, and retain 30 newest files | `backend/src/chat/history.test.ts`; constants and pruning in `backend/src/chat/history.ts` | **Verified.** Deletion/pruning is irreversible without external backup. |
| `RUN-01` | Run schema v3 normalizes legacy records, rejects future schemas, persists metrics/context/evidence/lineage, bounds records and recovers orphaned tool state | `backend/src/agent/runHistory.test.ts` | **Verified.** Compatibility read is not a universal file migration. |
| `CTX-01` | Model-visible payload metadata is redacted, manifested, preference-CAS controlled and route-queryable | `backend/src/agent/contextManifest.test.ts`; `backend/src/chat/contextManifestRoutes.test.ts`; `backend/src/security/retrievalContextRegression.test.ts` | **Verified.** No general downgrade migration is evidenced. |
| `CHK-01` | Checkpoints use bounded/deduplicated blobs, verify integrity, reject unsafe/corrupt snapshots, read legacy/v2/v3 data and create a pre-restore checkpoint | `backend/src/chat/checkpoints.test.ts` | **Verified.** Control directories are excluded; checkpoint is not a full backup. |
| `CHK-02` | Checkpoint retention defaults to 12, accepts 4–100, supports dry-run, storage stats and unreferenced-blob pruning | `backend/src/chat/checkpoints.test.ts`; `backend/src/chat/checkpointRoutes.test.ts` | **Verified.** Repair cannot reconstruct corrupt referenced blobs. |
| `MUT-01` | File/hunk rollback refuses drift, unsafe symlinks and partial default writes | `backend/src/files/mutationRegistry.test.ts`; `backend/src/agent/loop.mutation.test.ts`; `backend/src/security/g002Adversarial.test.ts` | **Verified.** Binary/oversized rollback may be unavailable. |
| `TASK-01` | Tasks are durable and lease/CAS controlled | `backend/src/agent/taskManager.test.ts`; `backend/src/agent/tools.orchestration.test.ts` | **Verified.** Migration behavior is separately qualified by `MIG-01`. |
| `MSG-01` | Message delivery survives restart, lease, acknowledgment and reclaim | `backend/src/agent/messageBus.test.ts`; `backend/src/agent/teamTransport.test.ts` | **Verified.** Migration behavior is separately qualified by `MIG-01`. |
| `TEAM-01` | Teammate state/budgets reconcile stale workers and persist execution state; the process-global `TEAM_STORE_ROOT/.team/teams.json` compatibility-normalizes legacy team index fields | `backend/src/agent/teammateManager.test.ts`; `backend/src/agent/subagent.test.ts`; `backend/src/team/teamManager.ts`; `backend/src/team/sessionBridge.ts` | **Verified runtime-agent behavior.** `team-index` is distinct from workspace runtime `team-config`; it has compatibility read/write normalization but no registered forward migration, automatic migration backup, or built-in rollback. |
| `COL-01` | Collaboration claims/comments/buffers/merge decisions use CAS and fail closed on stale, unsaved-human, corrupt, unreadable, or future-schema state | `backend/src/collaboration/collaborationStore.test.ts`; `backend/src/collaboration/collaborationRoutes.test.ts`; `backend/src/collaboration/collaborationWs.test.ts` | **Verified.** A missing store is compatible empty state. An existing invalid store is preserved and blocks reads/integration until restored from a trusted external backup; it is never silently replaced with empty state. |
| `TRACE-01` | Trace data is redacted, bounded, retention-configurable, lock-fenced and preserves concurrent appends | `backend/src/chat/traceStore.test.ts`; `backend/src/chat/traceStore.bench.ts`; `scripts/traceOverflowBenchmark.ts` | **Verified when functional tests and both performance gates pass.** The ordinary benchmark covers 10,000-event ingestion; the overflow benchmark prefills the retention ceiling and measures repeated append/archive/prune steady state with bounded p95/max. Lock and performance results remain platform/filesystem sensitive; trace is append-only, not rollback data. |
| `IDX-01` | Repository index is offline, partitioned by worktree, incrementally repaired and excludes protected/secret/generated/symlink content | `backend/src/files/repositoryIndex.test.ts`; `backend/src/security/retrievalPolicy.test.ts`; `scripts/verify-retrieval.sh` | **Verified.** Index is rebuildable, not authoritative backup data. |
| `MOD-01` | Model capability checks, bounded retry/fallback/cancel/overflow states and durable multi-scope budgets fail closed before egress | `backend/src/agent/providerGovernance.test.ts`; `backend/src/agent/modelGovernanceRoutes.test.ts`; `backend/src/agent/modelProcessor.test.ts` | **Verified with mock adapters.** No real provider API is exercised. |
| `PROF-01` | Agent profile/model/budget/tool policy can narrow permissions and child/read-only defaults are narrower | `backend/src/agent/agentProfiles.test.ts`; `backend/src/agent/modeCapabilities.test.ts`; `backend/src/agent/permissionService.test.ts` | **Verified.** A profile label does not create a complete OS sandbox. |
| `PROC-01` | Agent processes use structured argv, minimal environment, supervision, hard-limit gates and fail-closed network deny | `backend/src/agent/processSandbox.test.ts`; `backend/src/agent/shell.test.ts` | **Conditional:** network deny requires working macOS `sandbox-exec` or Linux bubblewrap/user namespaces. POSIX limits are unavailable on Windows; address-space limit is Linux-only. |
| `DBG-01` | Debug and terminal launchers exclude ambient secrets/injection variables and supervise processes | `backend/src/debug/service.test.ts`; `backend/src/ws/terminal.test.ts` | **Verified**, but these surfaces are not the full agent network-deny sandbox. |
| `CONT-01` | Production Docker defaults are non-root/read-only/capability-dropped and the agent subprocess has a separate network namespace | `scripts/docker-smoke.sh`; `Dockerfile`; `docker-compose.yml` | **Conditional:** requires Docker and compatible Linux user namespaces; not exercised by ordinary `npm test`. |
| `GIT-01` | Local Git delivery is approval/CAS/idempotency bound, preserves parent dirty state, conflict-isolates ref mutations, uses exact-ref lease push and reconciles restart state | `backend/src/files/gitDelivery.test.ts` | **Verified with local repositories/bare remotes.** No hosted remote is contacted. |
| `DEL-01` | GitHub/GitLab/Gitea adapters conform for probe/create/check/review and verify webhook bytes | `backend/src/chat/deliveryProvider.test.ts` | **Verified with mock HTTP.** Hosted provider compatibility remains deployment-specific. |
| `DEL-02` | Provider publication/feedback is idempotent, revision-bound, stale-aware and approval-gated | `backend/src/chat/deliveryProvider.test.ts`; `backend/src/chat/feedbackStore.test.ts`; `backend/src/security/g005DeliveryAdversarial.test.ts` | **Verified with mocks/adversarial fixtures.** Polling/webhook credentials are operator-managed. |
| `REV-01` | Immutable ChangeSets, independent review, findings, SARIF and evidence binding fail closed on stale/tampered data | `backend/src/chat/changeSets.test.ts`; `backend/src/chat/changeSetReviewRun.test.ts`; `backend/src/chat/reviewArtifact.test.ts`; `backend/src/chat/reviewFindingStore.test.ts`; `backend/src/chat/checkpointRoutes.test.ts` | **Verified.** Legacy change blobs may be rejected rather than migrated. |
| `AIR-01` | Evidence bundles are deterministic, bounded, integrity/binding verified, secret-scanned and read-only applicability checked | `backend/src/chat/evidenceBundle.test.ts`; `scripts/delivery-ui-contract.mjs` | **Verified.** Bundles are unsigned unless externally signed; there is no automatic apply endpoint. |
| `EXT-01` | Signed extension policy intersects admin/plugin/hook/workspace grants, gates completion and exposes server-resolved explanations | `backend/src/security/g006ExtensionPolicy.test.ts`; `g006RuntimeIntegration.test.ts`; `scripts/extensions-collaboration-ui-contract.mjs` | **Verified with local fixtures.** External HTTP/MCP behavior is still subject to configured network/runtime. |
| `SEC-01` | Secret redaction, protected paths, minimal process environments and audit boundaries are exercised adversarially | `backend/src/agent/secretRedaction.test.ts`; `contextPolicy.test.ts`; `policyAudit.test.ts`; `backend/src/security/g002Adversarial.test.ts` | **Verified for tested patterns.** Redaction cannot prove arbitrary content contains no secret. |
| `SEC-02` | Config and credential backups must be access-controlled/encrypted | No automated repository test can prove operator backup handling | **Procedure.** Never market this as an automatic CrownForge guarantee. |
| `PLUG-01` | Plugin manifests/permissions and skill enable/disable behavior are validated | `backend/src/plugins/permissions.test.ts`; `backend/src/agent/skills.test.ts`; `docs/plugins/README.md` | **Verified for repository fixtures.** Revalidate restored third-party plugins. |
| `MEM-01` | User/workspace memory is durable under `.codex` and invalid scope/content is rejected | `backend/src/agent/memory.test.ts` | **Verified.** Memory is sensitive and outside checkpoints. |
| `OPS-01` | Full backup/restore, offline application image transfer and complete downgrade are operator procedures | This runbook plus a deployment-specific restore drill | **Procedure / Gap:** there is no tested universal backup agent or offline application updater in this repository. |
| `WS14-A11Y` | Required AI collaboration controls expose the static accessible-name, dialog, status and focus-contract tokens enumerated by the release fixture | `scripts/ws14-release-contract.mjs`; `scripts/fixtures/ws14-release-contract.json`; `scripts/ui-contract.sh` | **Conditional static contract.** Claim only after both scripts pass. This is not browser, keyboard-only, screen-reader or native-dialog certification; specific runtime behavior still needs the corresponding interaction test. |
| `WS14-I18N` | English and Chinese locale resources have key, duplicate-key, placeholder and statically discoverable `t()` call parity | `scripts/ws14-release-contract.mjs`; `scripts/fixtures/ws14-release-contract.json`; `scripts/ui-contract.sh` | **Conditional static contract.** A pass proves fixture parity, not translation quality, dynamic-key coverage or locale-specific browser layout. |
| `WS14-MIGRATION` | Every ID in `MATERIAL_PERSISTENCE_INVENTORY` is mapped in the migration guide; registered workspace migrations and the separately routed app-settings migration have executable behavior tests | `backend/src/persistence/migrations.test.ts`; `backend/src/security/g007StorageMigrationContract.test.ts`; `scripts/ws14-release-contract.mjs` | **Verified only when the two backend tests and release contract pass.** `team-index` and other compatibility-only, append-only, or rebuildable entries are not automatic migrations. App settings use admin-only `POST /api/migrations/app-settings/run`, not the workspace migration endpoint. |
| `WS14-RESPONSIVE` | The release fixture validates required responsive implementation tokens and exact dimensions of the committed 1280, 1024 and 768 baseline images | `scripts/ws14-release-contract.mjs`; `scripts/fixtures/ws14-release-contract.json`; `docs/screenshots/baseline/` | **Conditional static/recorded evidence.** It does not prove a live browser pixel match, every viewport, zoom mode or assistive technology layout. |
| `WS14-OFFLINE` | Evidence bundles can be produced and verified without applying them, and the release contract checks the documented offline/status surfaces | `backend/src/chat/evidenceBundle.test.ts`; `scripts/delivery-ui-contract.mjs`; `scripts/ws14-release-contract.mjs` | **Conditional.** Bundle generation/verification is tested; a fully air-gapped deployment still requires local models/dependencies and disabled external integrations. There is no tested offline application updater. |
| `WS15-SNAPSHOT` | Release verification snapshots contain every existing Git-tracked file plus every intended untracked, non-ignored file after explicit runtime/build exclusions | `scripts/release-methodology.mjs`; `scripts/release-methodology.test.mjs`; `scripts/verify-clean-snapshot.mjs`; `scripts/ws15-release-contract.mjs` | **Verified when the contract and clean-snapshot gate pass.** The manifest records HEAD, tracked patch digest, deleted tracked paths, intended untracked paths, exact included-file inventory and content hashes. Git-ignored source outside explicit exclusions is rejected as inventory-unknown rather than silently accepted. Preinstalled dependency host symlinks remain outside the source digest. |
| `WS15-NETWORK` | Release verification audits guarded external Node TCP/HTTP/HTTPS/fetch attempts while allowing loopback fixtures | `scripts/offline-network-guard.mjs`; `scripts/offline-network-guard-self-test.mjs`; `scripts/verify-clean-snapshot.mjs` | **Conditional scoped evidence.** It does not prove DNS, UDP, raw-socket, native-binary, child-process or other non-Node egress isolation. npm offline mode and proxy variables are additional controls, not an OS network namespace. |
| `WS15-BUNDLE` | The frontend HTML main shell and non-exempt JavaScript chunks remain under explicit byte budgets | `scripts/frontend-bundle-budget.mjs`; `scripts/release-methodology.test.mjs`; `scripts/fixtures/ws15-release-contract.json` | **Verified after a production build and budget gate pass.** Only explicit Monaco editor/language workers and the separated Monaco core vendor chunk are exceptions; their sizes are still recorded in machine evidence. |

## Release verification commands / 发布验证命令

Run from the repository root. Platform-conditional checks must be recorded as
skipped when their prerequisites are unavailable; they must not be reported as
passed.

在仓库根目录执行。平台条件不满足时必须记录为 skipped，不能写成 passed。

```bash
./scripts/verify.sh
./scripts/verify-retrieval.sh
node scripts/ws14-release-contract.mjs
./scripts/ui-contract.sh
(cd backend && node --import tsx --test src/persistence/migrations.test.ts src/security/g007StorageMigrationContract.test.ts)
```

Docker-capable Linux host only / 仅支持 Docker 的 Linux 宿主机：

```bash
./scripts/docker-smoke.sh
```

Expected evidence / 预期证据：

- backend tests and TypeScript build pass;
- frontend production build and repository UI contracts pass;
- context/retrieval benchmarks meet their asserted bounds;
- trace ingestion and steady-state overflow benchmarks meet p95/max bounds;
- the frontend main shell passes its byte budget, with only documented Monaco
  core/worker exceptions;
- `git diff --check` reports no whitespace errors;
- migration tests prove backup, status, future-version refusal and hash-fenced
  restoration of exact pre-migration bytes, including a multi-step migration;
- Docker smoke proves the documented container boundary on that host.

## Claims intentionally not made / 明确不作出的声明

- CrownForge is not claimed to require zero network in every configuration.
  Public provider delivery and hosted model/MCP endpoints require network;
  air-gapped use requires local dependencies and disabled external integrations.
- The WS-15 verification preload is not claimed to isolate DNS, UDP, native
  binaries, raw sockets, child processes that do not inherit the preload, or
  any other non-Node networking surface.
- Process supervision/network denial is not claimed to be a complete filesystem
  or hostile-kernel sandbox.
- Mock provider tests are not claimed as live GitHub/GitLab/Gitea/OpenAI
  certification.
- An unsigned bundle is not claimed to establish publisher authenticity.
- Checkpoints are not claimed to replace full backups.
- Compatibility readers are not claimed to create migration backups.
- Native-dialog, focus-return and ARIA behavior is not claimed here unless a
  repository UI contract or browser test explicitly covers that behavior.
