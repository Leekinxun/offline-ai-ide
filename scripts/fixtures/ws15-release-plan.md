# WS-15 release verification and cleanup plan

## Scope

- Own only release-verification scripts, their fixtures/reports, and narrow browserless/release tests.
- Treat the current backend, security, migration, UI-contract, and benchmark tests as behavior locks; do not change product code or weaken their assertions.
- Never delete or rewrite workspace/user data. Temporary clean snapshots are copied to an OS temporary directory and only that validated temporary directory is removed.

## Verification flow

1. Prove snapshot completeness against `git ls-files`: record the tracked HEAD baseline, tracked patch digest, deleted tracked files and intended untracked/non-ignored files, then require an exact match with the copied manifest. Reject omitted files and Git-ignored files outside explicit snapshot exclusions.
2. Reuse already-installed backend/frontend dependencies through host symlinks without package installation. These dependency trees are outside the clean-source digest; record that limitation explicitly. Enable an inherited Node guard for external TCP, HTTP, HTTPS and fetch while permitting loopback fixtures. The report must state that DNS, UDP, native binaries, raw sockets and other non-Node egress are not covered.
3. Recursively discover every `backend/src/**/*.test.ts` file and run the full backend test set serially, including root-level config and nested collaboration/utils/WebSocket tests, then run backend/frontend builds.
4. Run mandatory security and migration/recovery gates separately and reject any failed or skipped mandatory test. Cover forward migration, downgrade, exact backup restore, corrupt-journal recovery, checkpoints, and hash/symlink/adversarial refusal paths.
5. Run browserless JSON/tree/modal/UI contracts as the E2E-like interaction gate, then run `ws15-critical-loop.sh` for exactly 100 zero-skip repetitions before WS-14/WS-15 static release contracts.
6. Run context and retrieval performance gates, plus 100 isolated trace ingestion repetitions. Then prefill trace retention to 10,000 events and measure repeated overflow append/archive/prune behavior with independent p95/max bounds.
7. After the frontend production build, enforce the HTML main-shell and general JavaScript byte budgets. Record explicit exceptions only for isolated Monaco workers and the separated Monaco core chunk.
8. Run a bounded 100-iteration critical-path soak over modal arbitration, visible-tree navigation, secret redaction, and exact migration backup/rollback/corrupt recovery. Persist JSON evidence and fail when any iteration fails (`<1%` means 0 failures out of 100).
9. Run whitespace validation and emit a machine-readable release report with commands, durations, outcomes, snapshot/source-inventory digests, scoped Node guard evidence, bundle sizes, and limitations.

## Cleanup and stop conditions

- Generated reports live under `.artifacts/ws15/` and are excluded from clean snapshots.
- The temporary snapshot is removed only after its resolved path is proven to be inside the OS temporary directory; source/runtime/user files are never cleanup targets.
- Release verification passes only if every mandatory gate runs and passes, the snapshot exactly matches the Git tracked/intended-untracked inventory, guarded external Node TCP/HTTP/HTTPS/fetch self-tests are rejected, the critical loop reports 100 zero-skip repetitions, bundle budgets pass, both trace gates pass, and the soak reports 100/100 passes.
- Platform-conditional tests may skip only in the full general suite. Security, migration/recovery, Node guard, browserless, critical-loop, bundle, performance, and soak gates are mandatory and cannot skip.
