# 0001: Distillation rewrite — skfiy-next

Date: 2026-08-19
Status: Accepted

## Context

skfiy stalled for 5.5 weeks. An 8-dimension diagnosis found the product core was healthy (strict TS, 1580 tests green, real E2E smokes) but buried under process bloat: a 26k-LOC dogfood program with zero real runs, a 22k-LOC dashboard, an 18.8k-LOC CLI, 21 branches (one a 72-commit crown jewel with no remote backup), and zero CI. The last 60 commits were 3 features to 32 churn commits.

Two options were on the table: amputate in place (P1–P4 of RESCUE-PLAN.md) or distill into a fresh repo. The maintainer chose the fresh repo.

## Decision

Create skfiy-next as a distilled rewrite:

- **Port, don't rewrite, the proven core**: renderer, assistant-agent, computer-use, orchestrators, shared contracts — with their tests. These encode the bug history (43 route-outcome fixes) and the safety model.
- **Port and slim the Electron shell**: main.ts + preload came over and had the personalization sprawl and tmux-replay wiring cut (1249 → 1201 lines). The shell compiles and smoke:ui passes end-to-end.
- **Drop the bloat**: dashboard, dogfood program, big CLI, MCP server, Codex plugin, money-run, .agentframe scaffolding, signed-release tooling.
- **Keep the smoke harness as the acceptance gate**: smoke-ui (passes), smoke-cli and smoke-chrome (surgically adapted to the cut surfaces).
- **Registry-agnostic lockfile**: regenerated against npmjs so the public GitHub repo and CI work off-network; bnpm still works via user npmrc.

## Consequences

- src: 129k → 43k LOC (−67%). Scripts: 32k → 8.3k (−74%). 475 unit tests + smoke:ui green on day one.
- The old repo (skfiy) remains the archive: the 72-commit computer-use-loop branch, the dashboard, and the dogfood history are there if ever needed.
- Known gaps carried over: see docs/known-gaps.md.
- Deferred decisions: dashboard as internal tool vs product; single agent provider collapse; Electron 39 → 43.
