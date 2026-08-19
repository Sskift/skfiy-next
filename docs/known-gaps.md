# Known Gaps

> Salvaged from the old repo's `.agentframe/knowledge-gaps.json` (2026-07-15), re-verified against skfiy-next on 2026-08-20.
> These are the known architectural debts of the distilled core. Each gap states what triggers it so changes don't re-learn it the hard way.

## High

### 1. Computer Use Turn lifecycle facts are scattered
**Status: partially mitigated.** CU turn lifecycle and outcome facts are split across `main.ts` wiring, `assistant-computer-use-executor.ts` state, `main-pending-approval.ts`, `TaskEvent`, `turn-transcript.ts`, and `turn-replay-store.ts`. The task-control store (`task-control-store.ts` plus `main-task-control.ts` wiring, contract in `shared/task-control.ts`) now centralizes task start/stop/state ownership, removing one class of scattered lifecycle fact; the remaining sites still own outcome and transcript semantics.
**Trigger:** any change that adds a state, retry, multi-tool behavior, or changes terminal outcome semantics requires model expansion across the remaining sites.

### 2. The Supported App Adapter interface is not one executable contract
**Status: still open.** The adapter interface is normative in the roadmap but the four orchestrators (`ghostty-task`, `chrome-task`, `finder-task`, `tmux-supervision-task`) each define their own client interfaces.
**Trigger:** adding an app, changing routing, or moving app-private approval data requires upgraded review.

### 3. Evidence semantics do not bind Claim/Oracle
**Status: still open.** Runtime Evidence is summary plus artifacts; it does not bind Claim, Oracle, Applicability, Discriminatory Power, or Residual Uncertainty.
**Trigger:** a change may cite current events as Observations, but cannot claim high-confidence user-goal verification without an explicit Oracle.

### 4. Release provenance is label-based
**Status: still open.** `scripts/package-macos-app.mjs` can label a pre-existing app with current HEAD without proving the package was built from that source revision.
**Trigger:** release acceptance requires provenance hardening rather than relying on filename or manifest labels.

## Medium

### 5. Cross-surface contract overlap
**Status: partially mitigated.** Main, preload, and renderer still maintain overlapping lifecycle/outcome types. The dashboard surface (one of the five original overlappers) was dropped in the distillation, `shared/route-outcome.ts` is the single contract for route outcomes, and `shared/task-control.ts` now anchors the task-control contract shared by main, preload, and renderer — but the broader lifecycle-type duplication remains.
**Trigger:** a status or public event change expands impact to every consuming surface until a single contract authority exists.

## Fixed by the distillation

### ~~Baseline full-gate failure~~ (was high)
The old repo failed typecheck on `@heroui/react` (dashboard dependency). **Fixed in skfiy-next**: the dashboard and heroui were dropped; `tsc --noEmit` is green as of 2026-08-19.

### ~~No CI enforcement~~ (was medium)
The verification sequence (typecheck + vitest + build) was documented but not enforced on push/PR. **Fixed in skfiy-next**: `.github/workflows/ci.yml` runs typecheck + vitest + build on macOS for every push and PR, green as of 2026-08-20.
