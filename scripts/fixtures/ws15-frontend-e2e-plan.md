# WS-15 Browserless Frontend E2E Plan

## Scope

This lane verifies deterministic frontend state transitions and recorded visual contracts without launching a browser or adding dependencies. It may add pure TypeScript models, fixtures, Node tests, and verification scripts. It does not change product behavior, network APIs, backend implementation, or CSS solely to satisfy tests.

## Critical flows

| Flow | Initial state | Transition under test | Required terminal evidence |
| --- | --- | --- | --- |
| Plan approval and amendment | Plan awaiting approval | approve plan; request/approve or reject amendment | code handoff only after approval; pending amendment blocks completion |
| Isolated agent and ChangeSet review | child worktree running | finish child; review exact revision; apply or request revision | parent remains unchanged until reviewed ChangeSet integration |
| Validation failure | implementation completed, required check failing | record failed verification; retry or amend | completion remains blocked; failing command and evidence remain visible |
| Rollback and conflict | mutation ledger contains manual divergence | request selective rollback | conflict refuses overwrite; resolved retry records rollback evidence |
| PR and patch export | reviewed ChangeSet plus verified commit | prepare/approve publish or create offline bundle | immutable revision/digest binding; stale binding rejected |
| Nested modal and compact drawer keyboard | parent drawer/modal open | open child; press Tab/Escape, including busy child | focus stays topmost; one Escape never closes the parent; focus returns |
| File tree keyboard | collapsed tree with nested active path | Tab, arrows, Home/End, collapse | exactly one visible tab stop; hidden descendants never remove entry point |

## Locale and responsive matrix

- Locales: `en`, `zh-CN`; every static key used by covered flows must exist in both dictionaries with matching placeholders.
- Recorded viewports: 1280×720 desktop, 1024×800 compact drawer, 768×800 narrow drawer.
- Baselines are verified by deterministic file size/dimensions plus component/CSS state tokens; this lane does not regenerate approved images.

## Repetition and stop conditions

- Run the browserless critical-flow suite 100 consecutive times; allowed failures: 0 (stronger than the WS-15 <1% flaky-rate threshold for this deterministic lane).
- Run modal/tree executable contracts 100 consecutive times.
- Run frontend production build, complete UI contract, WS-14 release contract, and `git diff --check` once after the repeated loop.
- Stop when all commands pass with identical scenario counts/digests across repetitions. Report browser-only gaps explicitly; do not infer visual pixel equality beyond recorded baseline verification.
