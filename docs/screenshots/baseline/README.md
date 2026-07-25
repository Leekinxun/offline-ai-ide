# CrownForge visual regression baseline

Last verified: 2026-07-25

These images are the Phase 5 visual contract for the live React workbench. Capture them against the local Vite frontend at `http://127.0.0.1:5173` with the backend at `http://127.0.0.1:3000`, the repository `workspace/` directory selected, browser zoom at 100%, and reduced motion disabled.

| File | Viewport | Theme | Reproducible state |
| --- | --- | --- | --- |
| `login-light-1280x720.jpg` | 1280 × 720 | Light | Open `/login` after invalidating the local auth session. |
| `workbench-empty-light-1280x720.jpg` | 1280 × 720 | Light | Sign in, close all editor tabs, keep Explorer and Task Dock open. |
| `workbench-editing-light-1280x720.jpg` | 1280 × 720 | Light | Open `DESIGN.md` from Explorer. |
| `workbench-review-light-1280x720.jpg` | 1280 × 720 | Light | Open the Changes activity while the repository has uncommitted changes. |
| `workbench-diff-light-1280x720.jpg` | 1280 × 720 | Light | Select the `DESIGN.md` change to open the side-by-side Diff dialog. |
| `workbench-settings-dark-1280x720.jpg` | 1280 × 720 | Dark | Switch to dark theme and open Settings from the activity rail. |
| `workbench-team-light-1024x800.jpg` | 1024 × 800 | Light | Open Team at the medium responsive breakpoint; retained from the accepted Phase 4 responsive run. |
| `workbench-terminal-light-768x800.jpg` | 768 × 800 | Light | Open Terminal as the narrow-screen drawer; retained from the accepted Phase 4 responsive run. |
| `ai-running-dark-1280x720.jpg` | 1280 × 720 | Dark | Deterministic QA fixture: send an Ask-mode prompt to the local delayed OpenAI-compatible stub and capture while the run status is `running`. No model content is treated as a stable pixel boundary. |

Dynamic boundaries:

- Workspace path, branch name, file counts, cursor position, timestamps, run duration, model telemetry, and streamed model text may vary. The shell geometry, state badges, action placement, drawer behavior, typography, focus treatment, and semantic colors must remain stable.
- The Review image is meaningful only in a dirty Git worktree. If the workspace is clean, create a disposable uncommitted text edit, capture, then restore only that fixture edit.
- The AI running image uses a disposable local streaming stub so the loading and stop controls remain deterministic; it must not depend on an external model endpoint.

Acceptance:

- Compare new captures with these files using the `visual-verdict` workflow; a score of 90 or higher is required before replacing a baseline.
- Check 1280 px, 1024 px, and 768 px widths for horizontal overflow, unreachable close controls, clipped dialogs, and focus-return regressions. The 1024 px and 768 px images were promoted from the immediately preceding accepted responsive run because Phase 5 only consolidates equivalent computed theme values at those breakpoints.
- Baseline replacement is an explicit design decision. Functional changes alone do not justify silently updating screenshots.
