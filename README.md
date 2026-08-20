# skfiy-next

Local-first macOS desktop pet that fronts a Background Agent, with Computer Use as a permissioned tool layer.

This is the distilled rewrite of [skfiy](../skfiy): the proven core (agent, computer-use, orchestrators, pet renderer) ported with its tests, the process bloat (dogfood program, dashboard, CLI sprawl, agentframe scaffolding) left behind. See `RESCUE-PLAN.md` in the old repo for the diagnosis that motivated this.

## MVP scope

- Floating desktop companion with active and quiet modes.
- Manifest-driven pixel pet skins (bundled `skfiy-black-cat`, local `luoxiaohei-local` override).
- App-agnostic macOS helper primitives: app listing, activation, screenshots/OCR, clicks, drags, scrolls, text input, hotkeys.
- Target-specific adapters: Ghostty terminal, Chrome page observation/actions, Finder file operations, tmux supervision.
- App policy and action risk gates before execution; explicit approval for risky or state-mutating actions.
- Local-only execution. The helper sends nothing remote by itself.

## Architecture

```
src/renderer/       Pet UI (React). Talks to main via the preload-injected DesktopApi.
src/main/           Electron main process.
  assistant-agent.ts      Background Agent (codex-only CLI provider; claude-code/hermes collapsed)
  computer-use/           Permissioned tool layer: helper client, policies, executor, replay
  orchestrator/           Task runners: ghostty, chrome, finder, tmux
  main-*.ts               Wiring modules (IPC payloads, window controls, routing)
  main.ts                 Shell: window creation + IPC registration
src/shared/         Cross-surface contracts (route-outcome, risk-policy, types)
chrome-extension/   MV3 extension (browser context bridge)
macos-helper/       Swift helper (app control primitives)
scripts/            Build + smoke harness
```

The pet renderer is intentionally independent from the backend: main emits task status (`idle` / `executing` / `waiting` / `failed`), the renderer maps states to the selected skin manifest.

## Develop

```bash
nvm use            # Node 22
npm install
npm test           # vitest, ~1560 tests, ~45s
npm run typecheck  # tsc --noEmit, strict, zero any
npm run dev        # vite dev server (renderer)
npm run dev:electron  # electron pointing at the dev server
npm run build      # vite build + tsc electron + swift helper
```

## Status

- [x] Core ported: renderer, agent, computer-use, orchestrators, shared contracts — ~1560 tests green, typecheck green
- [x] Electron shell ported and slimmed (personalization sprawl + tmux-replay wiring cut)
- [x] App builds and packages: `npm run build` + `package:mac` produce `dist/skfiy.app`
- [x] **smoke:ui passes end-to-end** — app launches, pet renders, agent turn, approval + stop flows work
- [x] **smoke:cli passes** — 5 dist-module contract collectors green
- [x] smoke:chrome adapted (native-host/installed-extension lanes cut, CDP lanes kept)
- [x] CI green on GitHub Actions (macOS: typecheck + vitest + build)
- [x] **M1 features shipped** — first-run readiness, conversation continuity (session store + history wiring), task control (start/stop store + wiring)
- [x] Task recovery dispatch (`task-recovery-dispatch` + registry + stage runtime)
- [x] Chrome submit confirmation and recovery (form-fill submit gates on approval; bound selector actions recover)
- [x] Finder file operations: copy, rename, organize selected
- [x] Bounded Computer Use agent loop ported (step-budgeted plan/act/verify loop in `computer-use/agent-loop.ts`)
- [x] Pet skin legacy WebP fallback (`origin-visible.webp` frame candidates)
- [x] Automation monitor notifications (tmux-session monitor → attention/completed/failure notices)
- [x] Electron 39 → 43 upgrade (43.4.1, with explicit postinstall binary download)
- [x] **M2 features shipped** — Memory Control Center, Browser Context Source Control, Provider Discovery
  - Memory: pending write approval, journal, settings, dashboard panel (entries/usage/pending/journal)
  - Browser Context: tab targeting, freshness, pause/disconnect, blocker categories, renderer panel
  - Provider Discovery: registry, bounded test request, fallback, readiness badge, offline banner, discovery panel
- [x] **M3 features shipped** — Automation Definitions, Adapter Contract, Workspace Profiles
  - Automation: trigger modes (manual/scheduled/local-state), timeout enforcement, preview-before-save, duplicate/pause/resume/delete, control center panel
  - Adapter Contract: unified 11-dimension contract, 4 thin adapters (ghostty/chrome/finder/tmux), registry, task-routing wired through registry
  - Profiles: per-profile provider/planner/memory/app-policy, explicit switching, policy broadening guard, export/import, memory isolation, profile panel + indicator
- [x] **M4 features shipped** — Finder Partial Results, Browser Multi-Step Recovery, Automation Run Lifecycle
  - Finder: structured result model, collision policies (cancel/skip/rename/replace), partial success, destination + name verification
  - Browser: page-state classifiers (navigation/reload/auth-wall/download/new-tab), DOM-first verification, value-free workflow templates, multi-step runner with per-step recovery
  - Automation Run: 8-state machine, single-flight concurrency, retry/backoff, TTL sweep, restart reconciliation, run panel with timeline
- [x] **M5 features shipped** — Supervision Recovery, Unified Diagnostics, Data Export/Recovery
  - Supervision: tmux recovery actions (send_input/restart_step/collect_summary) with two-gate approval, budgets, stalled/waiting/completed attention signals
  - Diagnostics: 31 typed blockers from 7 state machines, 6 component versions, redaction before serialization, export preview
  - Data Export: 5 domains (profiles/memory/sessions/automation/runtime), per-domain reset, storage health, migration with backup, retention controls, two-phase restore

## Cut from the old repo (intentionally)

Dashboard (22k LOC), dogfood program (26k LOC of theater), 18.8k-LOC CLI, MCP server, Codex plugin, money-run supervision, the old automation-monitor sprawl (a tmux-session monitor with user notifications was rebuilt in the core instead — see Status), personalization learning loop, `.agentframe/` scaffolding, signed-release tooling (unsigned-alpha path only).

## Known gaps

See [docs/known-gaps.md](docs/known-gaps.md) — the salvaged architectural debt list.
